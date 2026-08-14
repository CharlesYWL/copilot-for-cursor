import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { TunnelOptions, TunnelProvider } from './tunnel';

export const TUNNEL_PROVIDERS = ['cloudflared', 'ngrok', 'bore', 'tailscale'] as const;

/** Option fields holding credentials — never returned to the dashboard in cleartext. */
export const TUNNEL_SECRET_FIELDS = ['cloudflaredToken', 'authtoken'] as const;
/** Stand-in the dashboard sends back when a saved secret should be kept as-is. */
export const SECRET_PLACEHOLDER = '__saved__';

/** Tailscale Funnel only accepts these public ports. */
const TAILSCALE_PORTS = [443, 8443, 10000];

export interface ProxySettings {
    maxMode: boolean;
    tunnel: {
        autoStart: boolean;
        /** Relaunch the tunnel process automatically if it dies. */
        autoReconnect: boolean;
        provider: TunnelProvider;
        /** Per-provider settings, including the ones that pin a fixed URL. */
        options: TunnelOptions;
    };
    // Maps a Cursor-facing alias to the real upstream model id. Cursor derives a
    // model's context window from its own catalog rather than from
    // `/v1/models`, so an alias that doesn't resemble a known model name is the
    // only way to escape a catalog entry's smaller advertised window.
    modelAliases: Record<string, string>;
}

const ALIAS_PATTERN = /^[a-zA-Z0-9._-]+$/;

const CONFIG_DIR = join(homedir(), '.copilot-proxy');
const CONFIG_PATH = join(CONFIG_DIR, 'settings.json');
const DEFAULT_SETTINGS: ProxySettings = {
    maxMode: false,
    tunnel: {
        autoStart: false,
        autoReconnect: true,
        provider: 'cloudflared',
        options: {},
    },
    modelAliases: {},
};

let cachedSettings: ProxySettings | null = null;

export function isTunnelProvider(value: unknown): value is TunnelProvider {
    return typeof value === 'string' && TUNNEL_PROVIDERS.includes(value as TunnelProvider);
}

const trimmedString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
};

export function normalizeTunnelOptions(value: unknown): TunnelOptions {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const input = value as Record<string, unknown>;
    const options: TunnelOptions = {};

    if (input.cloudflaredMode === 'named' || input.cloudflaredMode === 'quick') {
        options.cloudflaredMode = input.cloudflaredMode;
    }
    const cloudflaredToken = trimmedString(input.cloudflaredToken);
    if (cloudflaredToken) options.cloudflaredToken = cloudflaredToken;
    const cloudflaredName = trimmedString(input.cloudflaredName);
    if (cloudflaredName) options.cloudflaredName = cloudflaredName;
    const cloudflaredHostname = trimmedString(input.cloudflaredHostname);
    if (cloudflaredHostname) options.cloudflaredHostname = cloudflaredHostname;

    const ngrokDomain = trimmedString(input.ngrokDomain);
    if (ngrokDomain) options.ngrokDomain = ngrokDomain;
    const authtoken = trimmedString(input.authtoken);
    if (authtoken) options.authtoken = authtoken;

    const borePort = Number(input.borePort);
    if (Number.isInteger(borePort) && borePort > 0 && borePort <= 65535) {
        options.borePort = borePort;
    }

    const tailscalePort = Number(input.tailscalePort);
    if (TAILSCALE_PORTS.includes(tailscalePort)) options.tailscalePort = tailscalePort;

    return options;
}

/**
 * Merges an incoming options patch over what is stored. A field set to the
 * placeholder keeps the saved secret, so the dashboard can save settings it was
 * never shown; an explicitly empty string clears the field.
 */
export function mergeTunnelOptions(existing: TunnelOptions, incoming: unknown): TunnelOptions {
    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
        return { ...existing };
    }
    const patch = incoming as Record<string, unknown>;
    const merged: TunnelOptions = { ...existing, ...normalizeTunnelOptions(patch) };

    for (const field of TUNNEL_SECRET_FIELDS) {
        if (patch[field] === SECRET_PLACEHOLDER) {
            if (existing[field]) merged[field] = existing[field];
            else delete merged[field];
        } else if (patch[field] === '') {
            delete merged[field];
        }
    }
    // A caller can clear non-secret fields the same way.
    for (const field of ['cloudflaredName', 'cloudflaredHostname', 'ngrokDomain'] as const) {
        if (patch[field] === '') delete merged[field];
    }
    if (patch.borePort === null || patch.borePort === '') delete merged.borePort;

    return merged;
}

/** Swaps stored secrets for a placeholder so they never reach the browser. */
export function redactTunnelOptions(options: TunnelOptions): TunnelOptions {
    const redacted: TunnelOptions = { ...options };
    for (const field of TUNNEL_SECRET_FIELDS) {
        if (redacted[field]) redacted[field] = SECRET_PLACEHOLDER;
    }
    return redacted;
}

/**
 * Whether a provider + options pair produces a URL that survives restarts.
 * Drives the dashboard's "fixed" badge and the auto-start hint.
 */
export function isFixedUrlConfig(provider: TunnelProvider | null, options: TunnelOptions): boolean {
    switch (provider) {
        case 'cloudflared':
            return options.cloudflaredMode === 'named';
        case 'ngrok':
            return !!options.ngrokDomain;
        case 'tailscale':
            return true; // Derived from the machine's MagicDNS name.
        case 'bore':
            return !!options.borePort; // Best effort — bore.pub may hand the port to someone else.
        default:
            return false;
    }
}

export function normalizeModelAliases(value: unknown): Record<string, string> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

    const aliases: Record<string, string> = {};
    for (const [alias, target] of Object.entries(value as Record<string, unknown>)) {
        if (typeof target !== 'string') continue;
        const trimmedAlias = alias.trim();
        const trimmedTarget = target.trim();
        if (!ALIAS_PATTERN.test(trimmedAlias) || !ALIAS_PATTERN.test(trimmedTarget)) continue;
        // A self-referential alias would shadow the real model and recurse.
        if (trimmedAlias === trimmedTarget) continue;
        aliases[trimmedAlias] = trimmedTarget;
    }
    return aliases;
}

export function normalizeProxySettings(value: unknown): ProxySettings {
    const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const tunnel = typeof input.tunnel === 'object' && input.tunnel !== null
        ? input.tunnel as Record<string, unknown>
        : {};

    return {
        maxMode: typeof input.maxMode === 'boolean' ? input.maxMode : DEFAULT_SETTINGS.maxMode,
        tunnel: {
            autoStart: typeof tunnel.autoStart === 'boolean'
                ? tunnel.autoStart
                : DEFAULT_SETTINGS.tunnel.autoStart,
            autoReconnect: typeof tunnel.autoReconnect === 'boolean'
                ? tunnel.autoReconnect
                : DEFAULT_SETTINGS.tunnel.autoReconnect,
            provider: isTunnelProvider(tunnel.provider)
                ? tunnel.provider
                : DEFAULT_SETTINGS.tunnel.provider,
            options: normalizeTunnelOptions(tunnel.options),
        },
        modelAliases: normalizeModelAliases(input.modelAliases),
    };
}

function cloneSettings(settings: ProxySettings): ProxySettings {
    return {
        maxMode: settings.maxMode,
        tunnel: { ...settings.tunnel, options: { ...settings.tunnel.options } },
        modelAliases: { ...settings.modelAliases },
    };
}

export function loadProxySettings(): ProxySettings {
    if (cachedSettings) return cloneSettings(cachedSettings);

    try {
        if (existsSync(CONFIG_PATH)) {
            cachedSettings = normalizeProxySettings(JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')));
        } else {
            cachedSettings = cloneSettings(DEFAULT_SETTINGS);
        }
    } catch {
        cachedSettings = cloneSettings(DEFAULT_SETTINGS);
    }

    return cloneSettings(cachedSettings);
}

export function saveProxySettings(settings: ProxySettings): void {
    const normalized = normalizeProxySettings(settings);
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf-8');
    // Tunnel options can hold provider tokens — keep the file owner-only where supported.
    if (process.platform !== 'win32') {
        try { chmodSync(CONFIG_PATH, 0o600); } catch {}
    }
    cachedSettings = normalized;
}
