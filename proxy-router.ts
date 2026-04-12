import { normalizeRequest } from './anthropic-transforms';
import { handleResponsesAPIBridge } from './responses-bridge';
import { createStreamProxy } from './stream-proxy';
import { logIncomingRequest, logTransformedRequest } from './debug-logger';

// ── Request tracking ──────────────────────────────────────────────────────────
interface RequestLog {
    id: number;
    timestamp: number;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    status: number;
    duration: number;
    stream: boolean;
}

const requestLogs: RequestLog[] = [];
const MAX_LOGS = 1000;
let requestIdCounter = 0;

function addRequestLog(log: RequestLog) {
    requestLogs.push(log);
    if (requestLogs.length > MAX_LOGS) requestLogs.shift();
}

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

console.log(`🚀 Proxy Router running on http://localhost:${PORT}`);
console.log(`🔗 Forwarding to ${TARGET_URL}`);
console.log(`🏷️  Prefix: "${PREFIX}"`);

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    // ── Dashboard ─────────────────────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/dashboard.html") {
      try {
        const dashboardPath = import.meta.dir + "/dashboard.html";
        const dashboardContent = await Bun.file(dashboardPath).text();
        return new Response(dashboardContent, { headers: { "Content-Type": "text/html" } });
      } catch (e) {
        return new Response("Dashboard not found.", { status: 404 });
      }
    }

    // ── Dashboard API: usage stats ────────────────────────────────────────
    if (url.pathname === "/api/usage") {
        const stats = {
            totalRequests: requestLogs.length,
            totalPromptTokens: requestLogs.reduce((s, r) => s + r.promptTokens, 0),
            totalCompletionTokens: requestLogs.reduce((s, r) => s + r.completionTokens, 0),
            totalTokens: requestLogs.reduce((s, r) => s + r.totalTokens, 0),
            byModel: Object.entries(
                requestLogs.reduce((acc, r) => {
                    if (!acc[r.model]) acc[r.model] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, errors: 0, avgDuration: 0, totalDuration: 0 };
                    acc[r.model].requests++;
                    acc[r.model].promptTokens += r.promptTokens;
                    acc[r.model].completionTokens += r.completionTokens;
                    acc[r.model].totalTokens += r.totalTokens;
                    if (r.status >= 400) acc[r.model].errors++;
                    acc[r.model].totalDuration += r.duration;
                    acc[r.model].avgDuration = Math.round(acc[r.model].totalDuration / acc[r.model].requests);
                    return acc;
                }, {} as Record<string, any>),
            ).map(([model, data]) => ({ model, ...data })),
            recentRequests: requestLogs.slice(-50).reverse(),
        };
        return new Response(JSON.stringify(stats), {
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

    try {
      if (req.method === "POST" && url.pathname.includes("/chat/completions")) {
        const startTime = Date.now();
        let json = await req.json();

        logIncomingRequest(json);

        const originalModel = json.model;
        let targetModel = json.model;

        if (json.model && json.model.startsWith(PREFIX)) {
          targetModel = json.model.slice(PREFIX.length);
          json.model = targetModel;
          console.log(`🔄 Rewriting model: ${originalModel} -> ${json.model}`);
        }

        const isClaude = targetModel.toLowerCase().includes('claude');

        normalizeRequest(json, isClaude);

        logTransformedRequest(json);

        const body = JSON.stringify(json);
        const headers = new Headers(req.headers);
        headers.set("host", targetUrl.host);
        headers.set("content-length", String(new TextEncoder().encode(body).length));

        const needsResponsesAPI = targetModel.match(/^gpt-5\.[2-9]|^gpt-5\.\d+-codex|^o[1-9]|^goldeneye/i);
        
        // For models that need max_completion_tokens instead of max_tokens
        const needsMaxCompletionTokens = targetModel.match(/^gpt-5\.[2-9]|^gpt-5\.\d+-codex|^goldeneye/i);
        if (needsMaxCompletionTokens && json.max_tokens) {
            json.max_completion_tokens = json.max_tokens;
            delete json.max_tokens;
            console.log(`🔧 Converted max_tokens → max_completion_tokens`);
        }

        // Try Responses API first for models that may need it; fall back to chat completions
        if (needsResponsesAPI) {
            console.log(`🔀 Model ${targetModel} — trying Responses API bridge`);
            const chatId = `chatcmpl-proxy-${++responseCounter}`;
            try {
                const result = await handleResponsesAPIBridge(json, req, chatId, TARGET_URL);
                if (result.status !== 404) {
                    addRequestLog({
                        id: ++requestIdCounter, timestamp: startTime, model: targetModel,
                        promptTokens: 0, completionTokens: 0, totalTokens: 0,
                        status: result.status, duration: Date.now() - startTime, stream: !!json.stream,
                    });
                    return result;
                }
                console.log(`⚠️ Responses API returned 404 — falling back to chat/completions`);
            } catch (e) {
                console.log(`⚠️ Responses API failed — falling back to chat/completions`);
            }
        }

        const hasVisionContent = (messages: any[]) => messages?.some(msg => 
            Array.isArray(msg.content) && msg.content.some((p: any) => p.type === 'image_url')
        );

        if (!isClaude && json.messages && hasVisionContent(json.messages)) {
             headers.set("Copilot-Vision-Request", "true");
        }

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
                id: ++requestIdCounter, timestamp: startTime, model: targetModel,
                promptTokens: 0, completionTokens: 0, totalTokens: 0,
                status: response.status, duration: Date.now() - startTime, stream: !!json.stream,
            });
            return new Response(errText, { status: response.status, headers: responseHeaders });
        }

        if (json.stream && response.body) {
            return createStreamProxy(response.body, responseHeaders, (usage) => {
                addRequestLog({
                    id: ++requestIdCounter, timestamp: startTime, model: targetModel,
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
            id: ++requestIdCounter, timestamp: startTime, model: targetModel,
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
