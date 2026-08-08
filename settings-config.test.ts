import { describe, expect, test } from 'bun:test';
import { normalizeModelAliases, normalizeProxySettings } from './settings-config';
import { parseStartupOptions } from './startup-options';

const settings = normalizeProxySettings({
    maxMode: true,
    tunnel: { autoStart: true, provider: 'bore' },
});

describe('proxy settings', () => {
    test('normalizes invalid persisted values to safe defaults', () => {
        expect(normalizeProxySettings({
            maxMode: 'yes',
            tunnel: { autoStart: 1, provider: 'unknown' },
        })).toEqual({
            maxMode: false,
            tunnel: { autoStart: false, provider: 'cloudflared' },
            modelAliases: {},
        });
    });

    test('uses persisted settings when no CLI override is provided', () => {
        expect(parseStartupOptions([], settings)).toEqual({
            maxMode: true,
            tunnelProvider: 'bore',
            tunnelAction: null,
        });
    });

    test('parses tunnel start and stop CLI overrides', () => {
        expect(parseStartupOptions(['--tunnel=ngrok', '--no-max'], settings)).toEqual({
            maxMode: false,
            tunnelProvider: 'ngrok',
            tunnelAction: { enabled: true, provider: 'ngrok' },
        });
        expect(parseStartupOptions(['--no-tunnel'], settings)).toEqual({
            maxMode: true,
            tunnelProvider: null,
            tunnelAction: { enabled: false },
        });
    });

    test('defaults bare --tunnel to cloudflared', () => {
        expect(parseStartupOptions(['--tunnel'], normalizeProxySettings({})).tunnelAction)
            .toEqual({ enabled: true, provider: 'cloudflared' });
    });

    test('rejects conflicting or invalid tunnel flags', () => {
        expect(() => parseStartupOptions(['--tunnel=bore', '--no-tunnel'], settings)).toThrow();
        expect(() => parseStartupOptions(['--tunnel=invalid'], settings)).toThrow();
    });
});

describe('model aliases', () => {
    test('keeps well-formed alias mappings', () => {
        expect(normalizeModelAliases({
            'opus5x': 'claude-opus-5',
            'longctx': 'gemini-3.1-pro-preview',
        })).toEqual({
            'opus5x': 'claude-opus-5',
            'longctx': 'gemini-3.1-pro-preview',
        });
    });

    test('drops malformed, self-referential, and non-object entries', () => {
        expect(normalizeModelAliases({
            'has space': 'claude-opus-5',
            'bad/target': 'claude-opus-5',
            'arrow': 'claude opus 5',
            'claude-opus-5': 'claude-opus-5',
            'numeric': 42,
            'good': 'claude-opus-5',
        })).toEqual({ good: 'claude-opus-5' });

        expect(normalizeModelAliases(null)).toEqual({});
        expect(normalizeModelAliases(['opus5x'])).toEqual({});
        expect(normalizeModelAliases('opus5x')).toEqual({});
    });

    test('persists aliases through settings normalization', () => {
        expect(normalizeProxySettings({ modelAliases: { opus5x: 'claude-opus-5' } }).modelAliases)
            .toEqual({ opus5x: 'claude-opus-5' });
    });
});
