import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { TunnelProvider } from './tunnel';

export const TUNNEL_PROVIDERS = ['cloudflared', 'ngrok', 'bore'] as const;

export interface ProxySettings {
    maxMode: boolean;
    tunnel: {
        autoStart: boolean;
        provider: TunnelProvider;
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
        provider: 'cloudflared',
    },
    modelAliases: {},
};

let cachedSettings: ProxySettings | null = null;

export function isTunnelProvider(value: unknown): value is TunnelProvider {
    return typeof value === 'string' && TUNNEL_PROVIDERS.includes(value as TunnelProvider);
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
            provider: isTunnelProvider(tunnel.provider)
                ? tunnel.provider
                : DEFAULT_SETTINGS.tunnel.provider,
        },
        modelAliases: normalizeModelAliases(input.modelAliases),
    };
}

function cloneSettings(settings: ProxySettings): ProxySettings {
    return {
        maxMode: settings.maxMode,
        tunnel: { ...settings.tunnel },
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
    cachedSettings = normalized;
}
