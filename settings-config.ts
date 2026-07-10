import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { TunnelProvider } from './tunnel';

export const TUNNEL_PROVIDERS = ['cloudflared', 'ngrok', 'bore'] as const;

export interface ProxySettings {
    maxMode: boolean;
    subagents: {
        enabled: boolean;
    };
    tunnel: {
        autoStart: boolean;
        provider: TunnelProvider;
    };
}

const CONFIG_DIR = join(homedir(), '.copilot-proxy');
const CONFIG_PATH = join(CONFIG_DIR, 'settings.json');
const DEFAULT_SETTINGS: ProxySettings = {
    maxMode: false,
    subagents: {
        enabled: true,
    },
    tunnel: {
        autoStart: false,
        provider: 'cloudflared',
    },
};

let cachedSettings: ProxySettings | null = null;

export function isTunnelProvider(value: unknown): value is TunnelProvider {
    return typeof value === 'string' && TUNNEL_PROVIDERS.includes(value as TunnelProvider);
}

export function normalizeProxySettings(value: unknown): ProxySettings {
    const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const tunnel = typeof input.tunnel === 'object' && input.tunnel !== null
        ? input.tunnel as Record<string, unknown>
        : {};
    const subagents = typeof input.subagents === 'object' && input.subagents !== null
        ? input.subagents as Record<string, unknown>
        : {};

    return {
        maxMode: typeof input.maxMode === 'boolean' ? input.maxMode : DEFAULT_SETTINGS.maxMode,
        subagents: {
            enabled: typeof subagents.enabled === 'boolean'
                ? subagents.enabled
                : DEFAULT_SETTINGS.subagents.enabled,
        },
        tunnel: {
            autoStart: typeof tunnel.autoStart === 'boolean'
                ? tunnel.autoStart
                : DEFAULT_SETTINGS.tunnel.autoStart,
            provider: isTunnelProvider(tunnel.provider)
                ? tunnel.provider
                : DEFAULT_SETTINGS.tunnel.provider,
        },
    };
}

function cloneSettings(settings: ProxySettings): ProxySettings {
    return {
        maxMode: settings.maxMode,
        subagents: { ...settings.subagents },
        tunnel: { ...settings.tunnel },
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
