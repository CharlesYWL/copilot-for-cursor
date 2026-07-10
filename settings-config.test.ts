import { describe, expect, test } from 'bun:test';
import { normalizeProxySettings } from './settings-config';
import { parseStartupOptions } from './startup-options';

const settings = normalizeProxySettings({
    maxMode: true,
    subagents: { enabled: false },
    tunnel: { autoStart: true, provider: 'bore' },
});

describe('proxy settings', () => {
    test('normalizes invalid persisted values to safe defaults', () => {
        expect(normalizeProxySettings({
            maxMode: 'yes',
            tunnel: { autoStart: 1, provider: 'unknown' },
        })).toEqual({
            maxMode: false,
            subagents: { enabled: true },
            tunnel: { autoStart: false, provider: 'cloudflared' },
        });
    });

    test('uses persisted settings when no CLI override is provided', () => {
        expect(parseStartupOptions([], settings)).toEqual({
            maxMode: true,
            subagentsEnabled: false,
            subagentsAction: null,
            tunnelProvider: 'bore',
            tunnelAction: null,
        });
    });

    test('parses tunnel start and stop CLI overrides', () => {
        expect(parseStartupOptions(['--tunnel=ngrok', '--no-max'], settings)).toEqual({
            maxMode: false,
            subagentsEnabled: false,
            subagentsAction: null,
            tunnelProvider: 'ngrok',
            tunnelAction: { enabled: true, provider: 'ngrok' },
        });
        expect(parseStartupOptions(['--no-tunnel'], settings)).toEqual({
            maxMode: true,
            subagentsEnabled: false,
            subagentsAction: null,
            tunnelProvider: null,
            tunnelAction: { enabled: false },
        });
    });

    test('defaults bare --tunnel to cloudflared', () => {
        expect(parseStartupOptions(['--tunnel'], normalizeProxySettings({})).tunnelAction)
            .toEqual({ enabled: true, provider: 'cloudflared' });
    });

    test('supports subagent CLI overrides', () => {
        expect(parseStartupOptions(['--subagents'], settings).subagentsEnabled).toBe(true);
        expect(parseStartupOptions(['--no-subagents'], normalizeProxySettings({})).subagentsEnabled).toBe(false);
        expect(() => parseStartupOptions(['--subagents', '--no-subagents'], settings)).toThrow();
    });

    test('rejects conflicting or invalid tunnel flags', () => {
        expect(() => parseStartupOptions(['--tunnel=bore', '--no-tunnel'], settings)).toThrow();
        expect(() => parseStartupOptions(['--tunnel=invalid'], settings)).toThrow();
    });
});
