import { normalizeRequest } from './anthropic-transforms';
import { handleResponsesAPIBridge } from './responses-bridge';
import { createStreamProxy } from './stream-proxy';
import { logIncomingRequest, logTransformedRequest } from './debug-logger';
import { addRequestLog, getNextRequestId, getUsageStats, flushToDisk, type RequestLog } from './usage-db';
import { loadAuthConfig, saveAuthConfig, generateApiKey, validateApiKey } from './auth-config';
import { getUpstreamAuthHeader, getUpstreamApiKeys, createUpstreamApiKey, deleteUpstreamApiKey } from './upstream-auth';
import { compactIfNeeded, isMaxMode, setMaxModeEnabled } from './max-mode';
import { needsResponsesAPI, resolveUpstreamModelId } from './model-routing';
import { getTunnelState, startTunnel, stopTunnel, subscribeTunnel, type TunnelProvider } from './tunnel';
import { isTunnelProvider, loadProxySettings, saveProxySettings } from './settings-config';
import {
  applySubagentPolicy,
  initializeSubagentsEnabled,
  isSubagentsEnabled,
  setSubagentsEnabled,
} from './subagent-policy';
import { existsSync } from 'fs';
import { join } from 'path';

// ── Console capture for SSE streaming ─────────────────────────────────────────
interface ConsoleLine {
    timestamp: number;
    level: 'LOG' | 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
    message: string;
}

const consoleLines: ConsoleLine[] = [];
const MAX_CONSOLE_LINES = 500;
const logSubscribers = new Set<ReadableStreamDefaultController>();

const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

function addConsoleLine(level: ConsoleLine['level'], args: any[]) {
    const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const line: ConsoleLine = { timestamp: Date.now(), level, message };
    consoleLines.push(line);
    if (consoleLines.length > MAX_CONSOLE_LINES) consoleLines.shift();
    const data = `data: ${JSON.stringify({ type: 'line', ...line })}\n\n`;
    for (const ctrl of logSubscribers) {
        try { ctrl.enqueue(new TextEncoder().encode(data)); } catch { logSubscribers.delete(ctrl); }
    }
}

console.log = (...args: any[]) => { origLog(...args); addConsoleLine('LOG', args); };
console.error = (...args: any[]) => { origError(...args); addConsoleLine('ERROR', args); };
console.warn = (...args: any[]) => { origWarn(...args); addConsoleLine('WARN', args); };

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = 4142;
const TARGET_URL = "http://localhost:4141";
const PREFIX = "cus-";
let responseCounter = 0;
initializeSubagentsEnabled(loadProxySettings().subagents.enabled);

console.log(`🚀 Proxy Router running on http://localhost:${PORT}`);
console.log(`🔗 Forwarding to ${TARGET_URL}`);
console.log(`🏷️  Prefix: "${PREFIX}"`);

function getLiveSettings() {
  const settings = loadProxySettings();
  const auth = loadAuthConfig();
  const tunnelState = getTunnelState();
  return {
    maxMode: isMaxMode(),
    subagents: {
      enabled: isSubagentsEnabled(),
    },
    requireApiKey: auth.requireApiKey,
    tunnel: {
      ...tunnelState,
      enabled: tunnelState.status === 'starting' || tunnelState.status === 'running',
      activeProvider: tunnelState.provider,
      provider: settings.tunnel.provider,
      autoStart: settings.tunnel.autoStart,
    },
  };
}

let settingsMutationQueue: Promise<unknown> = Promise.resolve();

function queueSettingsMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = settingsMutationQueue.then(mutation, mutation);
  settingsMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    // ── Dashboard ─────────────────────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/dashboard.html") {
      const dashboardCandidates = [
        join(import.meta.dir, "dashboard.html"),
        join(import.meta.dir, "..", "dashboard.html"),
        join(process.cwd(), "dashboard.html"),
      ];
      const dashboardPath = dashboardCandidates.find(path => existsSync(path));
      if (!dashboardPath) {
        console.error(`❌ Dashboard not found. Checked: ${dashboardCandidates.join(", ")}`);
        return new Response("Dashboard not found.", { status: 404 });
      }
      try {
        const dashboardContent = await Bun.file(dashboardPath).text();
        return new Response(dashboardContent, { headers: { "Content-Type": "text/html" } });
      } catch (e) {
        console.error(`❌ Failed to read dashboard at ${dashboardPath}:`, e);
        return new Response("Dashboard not found.", { status: 404 });
      }
    }

    // ── Dashboard API: usage stats ────────────────────────────────────────
    if (url.pathname === "/api/usage") {
        return new Response(JSON.stringify(getUsageStats()), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }

    // ── Dashboard API: flush usage to disk ────────────────────────────────
    if (url.pathname === "/api/usage/flush" && req.method === "POST") {
        await flushToDisk();
        return new Response('{"ok":true}', {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }

    // ── Dashboard API: SSE console log stream ─────────────────────────────
    if (url.pathname === "/api/logs/stream") {
        const stream = new ReadableStream({
            start(controller) {
                const initData = `data: ${JSON.stringify({ type: 'init', lines: consoleLines })}\n\n`;
                controller.enqueue(new TextEncoder().encode(initData));
                logSubscribers.add(controller);
            },
            cancel() {
                // cleaned up on enqueue failure
            },
        });
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            },
        });
    }

    // ── Dashboard API: clear console logs ─────────────────────────────────
    if (url.pathname === "/api/logs/clear" && req.method === "POST") {
        consoleLines.length = 0;
        const data = `data: ${JSON.stringify({ type: 'clear' })}\n\n`;
        for (const ctrl of logSubscribers) {
            try { ctrl.enqueue(new TextEncoder().encode(data)); } catch { logSubscribers.delete(ctrl); }
        }
        return new Response('{"ok":true}', {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }

    // ── API Key management endpoints ──────────────────────────────────
    const corsHeaders = { "Access-Control-Allow-Origin": "*" };

    if (url.pathname === "/api/keys" && req.method === "GET") {
        const config = loadAuthConfig();
        const maskedKeys = config.keys.map(k => ({
            ...k,
            key: k.key.slice(0, 12) + '...'
        }));
        return Response.json({ requireApiKey: config.requireApiKey, keys: maskedKeys }, { headers: corsHeaders });
    }

    if (url.pathname === "/api/keys" && req.method === "POST") {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
        }
        if (typeof body !== 'object' || body === null) {
            return Response.json({ error: "Request body must be a JSON object" }, { status: 400, headers: corsHeaders });
        }
        const { name } = body as { name?: unknown };
        if (name !== undefined && typeof name !== 'string') {
            return Response.json({ error: "`name` must be a string if provided" }, { status: 400, headers: corsHeaders });
        }
        try {
            return await queueSettingsMutation(async () => {
                const config = loadAuthConfig();
                const newKey = generateApiKey(name || 'Untitled');
                config.keys.push(newKey);
                saveAuthConfig(config);
                return Response.json(newKey, { headers: corsHeaders });
            });
        } catch (e: any) {
            console.error('❌ Failed to create API key:', e);
            return Response.json({ error: e?.message || 'Failed to create API key' }, { status: 500, headers: corsHeaders });
        }
    }

    if (url.pathname.startsWith("/api/keys/") && req.method === "PUT") {
        const id = url.pathname.split('/').pop();
        let body: { active?: unknown };
        try {
            body = await req.json() as { active?: unknown };
        } catch {
            return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders });
        }
        if (typeof body.active !== 'boolean') {
            return Response.json({ error: '`active` must be a boolean' }, { status: 400, headers: corsHeaders });
        }
        try {
            return await queueSettingsMutation(async () => {
                const config = loadAuthConfig();
                const key = config.keys.find(k => k.id === id);
                if (!key) {
                    return Response.json({ error: 'Key not found' }, { status: 404, headers: corsHeaders });
                }
                key.active = body.active as boolean;
                saveAuthConfig(config);
                return Response.json({ ok: true }, { headers: corsHeaders });
            });
        } catch (e: any) {
            console.error('❌ Failed to update API key:', e);
            return Response.json({ error: e?.message || 'Failed to update API key' }, { status: 500, headers: corsHeaders });
        }
    }

    if (url.pathname.startsWith("/api/keys/") && req.method === "DELETE") {
        const id = url.pathname.split('/').pop();
        try {
            return await queueSettingsMutation(async () => {
                const config = loadAuthConfig();
                const keyIndex = config.keys.findIndex(k => k.id === id);
                if (keyIndex === -1) {
                    return Response.json({ error: 'Key not found' }, { status: 404, headers: corsHeaders });
                }
                config.keys.splice(keyIndex, 1);
                saveAuthConfig(config);
                return Response.json({ ok: true }, { headers: corsHeaders });
            });
        } catch (e: any) {
            console.error('❌ Failed to delete API key:', e);
            return Response.json({ error: e?.message || 'Failed to delete API key' }, { status: 500, headers: corsHeaders });
        }
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
        return Response.json(getLiveSettings(), { headers: corsHeaders });
    }

    if (url.pathname === "/api/settings" && req.method === "PATCH") {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders });
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            return Response.json({ error: 'Request body must be a JSON object' }, { status: 400, headers: corsHeaders });
        }
        const unknownSettingsFields = Object.keys(body).filter(
            key => !['maxMode', 'subagents', 'requireApiKey', 'tunnel'].includes(key),
        );
        if (unknownSettingsFields.length > 0) {
            return Response.json(
                { error: `Unknown settings field(s): ${unknownSettingsFields.join(', ')}` },
                { status: 400, headers: corsHeaders },
            );
        }

        try {
          return await queueSettingsMutation(async () => {
            const patch = body as {
                maxMode?: unknown;
                subagents?: unknown;
                requireApiKey?: unknown;
                tunnel?: unknown;
            };
            if (patch.maxMode !== undefined && typeof patch.maxMode !== 'boolean') {
                return Response.json({ error: '`maxMode` must be a boolean' }, { status: 400, headers: corsHeaders });
            }
            if (patch.requireApiKey !== undefined && typeof patch.requireApiKey !== 'boolean') {
                return Response.json({ error: '`requireApiKey` must be a boolean' }, { status: 400, headers: corsHeaders });
            }

            const settings = loadProxySettings();
            let nextSubagentsEnabled: boolean | undefined;
            let persistSubagents = true;

            if (patch.subagents !== undefined) {
                if (typeof patch.subagents !== 'object' || patch.subagents === null || Array.isArray(patch.subagents)) {
                    return Response.json({ error: '`subagents` must be an object' }, { status: 400, headers: corsHeaders });
                }
                const candidate = patch.subagents as Record<string, unknown>;
                const unknownSubagentFields = Object.keys(candidate).filter(
                    key => !['enabled', 'persist'].includes(key),
                );
                if (unknownSubagentFields.length > 0) {
                    return Response.json(
                        { error: `Unknown subagent field(s): ${unknownSubagentFields.join(', ')}` },
                        { status: 400, headers: corsHeaders },
                    );
                }
                if (typeof candidate.enabled !== 'boolean') {
                    return Response.json({ error: '`subagents.enabled` must be a boolean' }, { status: 400, headers: corsHeaders });
                }
                if (candidate.persist !== undefined && typeof candidate.persist !== 'boolean') {
                    return Response.json({ error: '`subagents.persist` must be a boolean' }, { status: 400, headers: corsHeaders });
                }
                nextSubagentsEnabled = candidate.enabled;
                persistSubagents = candidate.persist !== false;
            }

            if (patch.tunnel !== undefined) {
                if (typeof patch.tunnel !== 'object' || patch.tunnel === null || Array.isArray(patch.tunnel)) {
                    return Response.json({ error: '`tunnel` must be an object' }, { status: 400, headers: corsHeaders });
                }
                const candidate = patch.tunnel as Record<string, unknown>;
                const unknownTunnelFields = Object.keys(candidate).filter(
                    key => !['enabled', 'autoStart', 'provider', 'authtoken'].includes(key),
                );
                if (unknownTunnelFields.length > 0) {
                    return Response.json(
                        { error: `Unknown tunnel field(s): ${unknownTunnelFields.join(', ')}` },
                        { status: 400, headers: corsHeaders },
                    );
                }
                if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean') {
                    return Response.json({ error: '`tunnel.enabled` must be a boolean' }, { status: 400, headers: corsHeaders });
                }
                if (candidate.autoStart !== undefined && typeof candidate.autoStart !== 'boolean') {
                    return Response.json({ error: '`tunnel.autoStart` must be a boolean' }, { status: 400, headers: corsHeaders });
                }
                if (candidate.provider !== undefined && !isTunnelProvider(candidate.provider)) {
                    return Response.json({ error: '`tunnel.provider` must be cloudflared, ngrok, or bore' }, { status: 400, headers: corsHeaders });
                }
                if (candidate.authtoken !== undefined && typeof candidate.authtoken !== 'string') {
                    return Response.json({ error: '`tunnel.authtoken` must be a string' }, { status: 400, headers: corsHeaders });
                }

                const enabled = candidate.enabled as boolean | undefined;
                const autoStart = candidate.autoStart as boolean | undefined;
                const provider = candidate.provider as TunnelProvider | undefined;
                const authtoken = candidate.authtoken as string | undefined;
                const effectiveProvider = provider ?? settings.tunnel.provider;
                if (authtoken && effectiveProvider !== 'ngrok') {
                    return Response.json({ error: '`tunnel.authtoken` is only valid for ngrok' }, { status: 400, headers: corsHeaders });
                }

                if (enabled === true) {
                    try {
                        await startTunnel(effectiveProvider, { authtoken });
                    } catch (e: any) {
                        return Response.json(
                            { error: e?.message || 'Failed to start tunnel', settings: getLiveSettings() },
                            { status: 500, headers: corsHeaders },
                        );
                    }
                } else if (enabled === false) {
                    await stopTunnel();
                }

                if (provider) settings.tunnel.provider = provider;
                if (autoStart !== undefined) settings.tunnel.autoStart = autoStart;
            }

            if (patch.maxMode !== undefined) {
                settings.maxMode = patch.maxMode;
            }
            if (nextSubagentsEnabled !== undefined && persistSubagents) {
                settings.subagents.enabled = nextSubagentsEnabled;
            }
            if (patch.requireApiKey !== undefined) {
                const auth = loadAuthConfig();
                auth.requireApiKey = patch.requireApiKey;
                saveAuthConfig(auth);
            }
            saveProxySettings(settings);
            if (patch.maxMode !== undefined) {
                setMaxModeEnabled(patch.maxMode);
            }
            if (nextSubagentsEnabled !== undefined) {
                setSubagentsEnabled(nextSubagentsEnabled);
            }
            return Response.json(getLiveSettings(), { headers: corsHeaders });
          });
        } catch (e: any) {
            console.error('❌ Failed to update settings:', e);
            return Response.json({ error: e?.message || 'Failed to update settings' }, { status: 500, headers: corsHeaders });
        }
    }

    if (url.pathname === "/api/settings/auth" && req.method === "PUT") {
        let body: { requireApiKey?: unknown };
        try {
            body = await req.json() as { requireApiKey?: unknown };
        } catch {
            return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders });
        }
        if (typeof body.requireApiKey !== 'boolean') {
            return Response.json({ error: '`requireApiKey` must be a boolean' }, { status: 400, headers: corsHeaders });
        }
        try {
            return await queueSettingsMutation(async () => {
                const config = loadAuthConfig();
                config.requireApiKey = body.requireApiKey as boolean;
                saveAuthConfig(config);
                return Response.json({ ok: true }, { headers: corsHeaders });
            });
        } catch (e: any) {
            console.error('❌ Failed to update auth settings:', e);
            return Response.json({ error: e?.message || 'Failed to update auth settings' }, { status: 500, headers: corsHeaders });
        }
    }

    // ── Upstream (copilot-api) key management ────────────────────────
    if (url.pathname === "/api/upstream-keys" && req.method === "GET") {
        const keys = getUpstreamApiKeys();
        const masked = keys.map(k => k.slice(0, 14) + '...' + k.slice(-4));
        return Response.json({ keys: masked, count: keys.length }, { headers: corsHeaders });
    }

    if (url.pathname === "/api/upstream-keys" && req.method === "POST") {
        try {
            const newKey = createUpstreamApiKey();
            return Response.json({ key: newKey }, { headers: corsHeaders });
        } catch (e: any) {
            return Response.json({ error: e?.message || 'Failed to create key' }, { status: 500, headers: corsHeaders });
        }
    }

    if (url.pathname.startsWith("/api/upstream-keys/") && req.method === "DELETE") {
        const keyPrefix = decodeURIComponent(url.pathname.split('/').pop() || '');
        const keys = getUpstreamApiKeys();
        const match = keys.find(k => k.startsWith(keyPrefix) || k.endsWith(keyPrefix));
        if (match) {
            deleteUpstreamApiKey(match);
            return Response.json({ ok: true }, { headers: corsHeaders });
        }
        return Response.json({ error: 'Key not found' }, { status: 404, headers: corsHeaders });
    }

    // ── Dashboard API: tunnel management ──────────────────────────────
    if (url.pathname === "/api/tunnel" && req.method === "GET") {
        return Response.json(getTunnelState(), { headers: corsHeaders });
    }
    if (url.pathname === "/api/tunnel" && req.method === "POST") {
        try {
            const body = await req.json() as { provider?: TunnelProvider; authtoken?: string };
            if (!isTunnelProvider(body.provider)) {
                return Response.json({ error: 'Invalid provider' }, { status: 400, headers: corsHeaders });
            }
            if (body.authtoken && body.provider !== 'ngrok') {
                return Response.json({ error: 'authtoken is only valid for ngrok' }, { status: 400, headers: corsHeaders });
            }
            return await queueSettingsMutation(async () => {
                await startTunnel(body.provider as TunnelProvider, { authtoken: body.authtoken });
                return Response.json(getTunnelState(), { headers: corsHeaders });
            });
        } catch (e: any) {
            return Response.json({ error: e?.message || 'Failed to start tunnel' }, { status: 500, headers: corsHeaders });
        }
    }
    if (url.pathname === "/api/tunnel" && req.method === "DELETE") {
        try {
            return await queueSettingsMutation(async () => {
                await stopTunnel();
                return Response.json(getTunnelState(), { headers: corsHeaders });
            });
        } catch (e: any) {
            console.error('❌ Failed to stop tunnel:', e);
            return Response.json({ error: e?.message || 'Failed to stop tunnel' }, { status: 500, headers: corsHeaders });
        }
    }
    if (url.pathname === "/api/tunnel/stream") {
        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                const send = (s: ReturnType<typeof getTunnelState>) => {
                    try {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(s)}\n\n`));
                    } catch {}
                };
                const unsub = subscribeTunnel(send);
                (controller as any)._tunnelUnsub = unsub;
            },
            cancel(controller) {
                const unsub = (controller as any)?._tunnelUnsub;
                if (typeof unsub === 'function') unsub();
            },
        });
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            },
        });
    }

    // ── Dashboard API: model list (bypasses API key auth) ──────────────
    if (url.pathname === "/api/models" && req.method === "GET") {
        try {
            const modelsUrl = new URL('/v1/models', TARGET_URL);
            const response = await fetch(modelsUrl.toString(), {
                headers: { 'Authorization': getUpstreamAuthHeader() },
            });
            const data = await response.json();
            if (data.data && Array.isArray(data.data)) {
                data.data = data.data.map((model: any) => ({
                    ...model,
                    id: PREFIX + model.id,
                    display_name: PREFIX + (model.display_name || model.id)
                }));
            }
            return new Response(JSON.stringify(data), {
                status: response.status,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
            });
        } catch (e: any) {
            return Response.json({ error: e?.message || 'Failed to fetch models' }, { status: 502, headers: corsHeaders });
        }
    }

    // ── Proxy logic ───────────────────────────────────────────────────────
    const targetUrl = new URL(url.pathname + url.search, TARGET_URL);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // ── Enforce API key auth on all /v1/* routes ──────────────────────────
    if (url.pathname.startsWith("/v1/")) {
        const authConfig = loadAuthConfig();
        if (authConfig.requireApiKey) {
            const authHeader = req.headers.get('authorization');
            const providedKey = authHeader?.replace('Bearer ', '');
            if (!providedKey || !validateApiKey(providedKey)) {
                return Response.json(
                    { error: { message: "Invalid API key. Generate one from the dashboard.", type: "invalid_api_key" } },
                    { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
                );
            }
        }
    }

    try {
      // ── Native Responses API passthrough (for Codex CLI/app; codex 0.130+ requires wire_api="responses") ──
      // Codex sends Responses-format requests to /v1/responses and expects Responses-format back.
      // The chat/completions handler bridges responses→chat, which Codex can't consume — so we expose
      // a direct passthrough: strip the cus- prefix and forward straight to upstream copilot-api
      // /v1/responses, returning the body untouched (including SSE streams).
      if (req.method === "POST" && url.pathname.endsWith("/responses")) {
        let json = await req.json();
        const removedTools = applySubagentPolicy(json);
        if (removedTools.length > 0) {
          console.log(`🚫 Subagents disabled — filtered tools: ${removedTools.join(', ')}`);
        }
        const originalModel = json.model;
        if (json.model && typeof json.model === 'string' && json.model.startsWith(PREFIX)) {
          json.model = json.model.slice(PREFIX.length);
        }
        if (typeof json.model === 'string') {
          json.model = resolveUpstreamModelId(json.model);
        }
        if (originalModel !== json.model) {
          console.log(`\uD83D\uDD04 [/responses] Rewriting model: ${originalModel} -> ${json.model}`);
        }
        const respModel = json.model;
        const respBody = JSON.stringify(json);
        const respUrl = new URL('/v1/responses', TARGET_URL);
        const respHeaders = new Headers(req.headers);
        respHeaders.set("host", respUrl.host);
        respHeaders.set("content-type", "application/json");
        respHeaders.set("content-length", String(new TextEncoder().encode(respBody).length));
        respHeaders.set("authorization", getUpstreamAuthHeader());
        respHeaders.delete("accept-encoding");
        console.log(`\uD83D\uDD00 [/responses] passthrough \u2192 upstream for ${respModel} (stream=${!!json.stream})`);
        const upstream = await fetch(respUrl.toString(), { method: "POST", headers: respHeaders, body: respBody });
        console.log(`\uD83D\uDCE1 [/responses] upstream: ${upstream.status} | ${upstream.headers.get('content-type')}`);
        const outHeaders = new Headers(upstream.headers);
        outHeaders.set("Access-Control-Allow-Origin", "*");
        if (!upstream.ok) {
          const errText = await upstream.text();
          console.error(`\u274C [/responses] upstream error (${upstream.status}):`, errText.slice(0, 500));
          return new Response(errText, { status: upstream.status, headers: outHeaders });
        }
        // Stream passthrough (SSE) or buffered JSON, body returned verbatim in Responses format.
        return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
      }

      if (req.method === "POST" && url.pathname.includes("/chat/completions")) {
        const startTime = Date.now();
        let json = await req.json();

        logIncomingRequest(json);
        const removedTools = applySubagentPolicy(json);
        if (removedTools.length > 0) {
          console.log(`🚫 Subagents disabled — filtered tools: ${removedTools.join(', ')}`);
        }

        const originalModel = json.model;
        let targetModel = json.model;

        if (json.model && json.model.startsWith(PREFIX)) {
          targetModel = json.model.slice(PREFIX.length);
        }
        if (typeof targetModel === 'string') {
          targetModel = resolveUpstreamModelId(targetModel);
          json.model = targetModel;
        }
        if (originalModel !== targetModel) {
          console.log(`🔄 Rewriting model: ${originalModel} -> ${json.model}`);
        }

        const isClaude = targetModel.toLowerCase().includes('claude');

        normalizeRequest(json, isClaude);

        logTransformedRequest(json);

        // ── Context compaction ────────────────────────────────────────────
        // Always run: with --max this compacts aggressively at 80%; without --max
        // it acts as a safety net at 95% so long Cursor sessions don't overflow.
        json = await compactIfNeeded(json, targetModel, TARGET_URL);

        const headers = new Headers(req.headers);
        headers.set("host", targetUrl.host);
        headers.set("authorization", getUpstreamAuthHeader());

        const shouldUseResponsesAPI = needsResponsesAPI(targetModel);
        
        if (shouldUseResponsesAPI && json.max_tokens) {
            json.max_completion_tokens = json.max_tokens;
            delete json.max_tokens;
            console.log(`🔧 Converted max_tokens → max_completion_tokens`);
        }

        if (shouldUseResponsesAPI) {
            console.log(`🔀 Model ${targetModel} — using Responses API bridge`);
            const chatId = `chatcmpl-proxy-${++responseCounter}`;
            try {
                const bridgeResult = await handleResponsesAPIBridge(json, req, chatId, TARGET_URL);

                if (json.stream && bridgeResult.response.body) {
                    // For streaming, usage is embedded in the SSE stream (not available
                    // synchronously). Wrap with createStreamProxy so usage and duration
                    // are captured when the stream finishes, matching Chat Completions behaviour.
                    const streamHeaders = new Headers(bridgeResult.response.headers);
                    return createStreamProxy(bridgeResult.response.body, streamHeaders, (usage) => {
                        addRequestLog({
                            id: getNextRequestId(), timestamp: startTime, model: targetModel,
                            promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
                            totalTokens: usage.totalTokens,
                            status: bridgeResult.response.status, duration: Date.now() - startTime, stream: true,
                        });
                    });
                }

                // Non-streaming: usage is returned directly by the bridge
                addRequestLog({
                    id: getNextRequestId(), timestamp: startTime, model: targetModel,
                    promptTokens: bridgeResult.usage.promptTokens,
                    completionTokens: bridgeResult.usage.completionTokens,
                    totalTokens: bridgeResult.usage.totalTokens,
                    status: bridgeResult.response.status, duration: Date.now() - startTime, stream: false,
                });
                return bridgeResult.response;
            } catch (e: any) {
                console.error(`❌ Responses API bridge failed for ${targetModel}:`, e?.message || e);
                return new Response(
                    JSON.stringify({ error: { message: `Responses API bridge failed: ${e?.message || 'Unknown error'}`, type: "proxy_error" } }),
                    { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
                );
            }
        }

        const hasVisionContent = (messages: any[]) => messages?.some(msg => 
            Array.isArray(msg.content) && msg.content.some((p: any) => p.type === 'image_url')
        );

        if (!isClaude && json.messages && hasVisionContent(json.messages)) {
             headers.set("Copilot-Vision-Request", "true");
        }

        const body = JSON.stringify(json);
        headers.set("content-length", String(new TextEncoder().encode(body).length));

        const response = await fetch(targetUrl.toString(), {
          method: "POST",
          headers: headers,
          body: body,
        });

        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        console.log(`📡 Upstream response: ${response.status} | content-type: ${response.headers.get('content-type')}`);
        
        if (!response.ok) {
            const errText = await response.text();
            console.error(`❌ Upstream Error (${response.status}):`, errText);
            addRequestLog({
                id: getNextRequestId(), timestamp: startTime, model: targetModel,
                promptTokens: 0, completionTokens: 0, totalTokens: 0,
                status: response.status, duration: Date.now() - startTime, stream: !!json.stream,
            });
            return new Response(errText, { status: response.status, headers: responseHeaders });
        }

        if (json.stream && response.body) {
            return createStreamProxy(response.body, responseHeaders, (usage) => {
                addRequestLog({
                    id: getNextRequestId(), timestamp: startTime, model: targetModel,
                    promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
                    totalTokens: usage.totalTokens,
                    status: response.status, duration: Date.now() - startTime, stream: true,
                });
            });
        }

        // Non-streaming: clone and parse to extract usage
        const cloned = response.clone();
        let promptTokens = 0, completionTokens = 0, totalTokens = 0;
        try {
            const respJson = await cloned.json();
            if (respJson.usage) {
                promptTokens = respJson.usage.prompt_tokens || 0;
                completionTokens = respJson.usage.completion_tokens || 0;
                totalTokens = respJson.usage.total_tokens || promptTokens + completionTokens;
            }
        } catch { /* ignore parse errors */ }
        addRequestLog({
            id: getNextRequestId(), timestamp: startTime, model: targetModel,
            promptTokens, completionTokens, totalTokens,
            status: response.status, duration: Date.now() - startTime, stream: false,
        });

        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        });
      }

      if (req.method === "GET" && url.pathname.includes("/models")) {
        const headers = new Headers(req.headers);
        headers.set("host", targetUrl.host);
        headers.set("authorization", getUpstreamAuthHeader());
        const response = await fetch(targetUrl.toString(), { method: "GET", headers: headers });
        const data = await response.json();
        
        if (data.data && Array.isArray(data.data)) {
          data.data = data.data.map((model: any) => ({
            ...model,
            id: PREFIX + model.id,
            display_name: PREFIX + (model.display_name || model.id)
          }));
        }
        return new Response(JSON.stringify(data), {
            status: response.status,
            headers: { ...Object.fromEntries(response.headers), "Access-Control-Allow-Origin": "*" }
        });
      }

      const headers = new Headers(req.headers);
      headers.set("host", targetUrl.host);
      headers.set("authorization", getUpstreamAuthHeader());
      const response = await fetch(targetUrl.toString(), {
        method: req.method,
        headers: headers,
        body: req.body,
      });
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, { status: response.status, headers: responseHeaders });

    } catch (error) {
      console.error("Proxy Error:", error);
      return new Response(JSON.stringify({ error: "Proxy Error", details: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
});
