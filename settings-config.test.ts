import { describe, expect, test } from 'bun:test';
import {
    isFixedUrlConfig,
    mergeTunnelOptions,
    normalizeModelAliases,
    normalizeProxySettings,
    normalizeTunnelOptions,
    redactTunnelOptions,
    SECRET_PLACEHOLDER,
} from './settings-config';
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
            tunnel: { autoStart: false, autoReconnect: true, provider: 'cloudflared', options: {} },
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

    test('accepts tailscale as a tunnel provider', () => {
        expect(parseStartupOptions(['--tunnel=tailscale'], settings).tunnelAction)
            .toEqual({ enabled: true, provider: 'tailscale' });
    });
});

describe('tunnel options', () => {
    test('keeps well-formed per-provider values', () => {
        expect(normalizeTunnelOptions({
            cloudflaredMode: 'named',
            cloudflaredHostname: '  copilot.example.com  ',
            ngrokDomain: 'demo.ngrok-free.dev',
            borePort: 41420,
            tailscalePort: 8443,
        })).toEqual({
            cloudflaredMode: 'named',
            cloudflaredHostname: 'copilot.example.com',
            ngrokDomain: 'demo.ngrok-free.dev',
            borePort: 41420,
            tailscalePort: 8443,
        });
    });

    test('drops invalid ports, blank strings, and unknown modes', () => {
        expect(normalizeTunnelOptions({
            cloudflaredMode: 'sideways',
            cloudflaredHostname: '   ',
            borePort: 99999,
            // Funnel only exposes 443, 8443 and 10000.
            tailscalePort: 8080,
        })).toEqual({});
        expect(normalizeTunnelOptions(null)).toEqual({});
        expect(normalizeTunnelOptions('nope')).toEqual({});
    });

    test('redacts secrets but leaves other fields intact', () => {
        expect(redactTunnelOptions({
            authtoken: 'real-token',
            cloudflaredToken: 'cf-token',
            ngrokDomain: 'demo.ngrok-free.dev',
        })).toEqual({
            authtoken: SECRET_PLACEHOLDER,
            cloudflaredToken: SECRET_PLACEHOLDER,
            ngrokDomain: 'demo.ngrok-free.dev',
        });
    });

    test('keeps a stored secret when the placeholder is sent back', () => {
        const merged = mergeTunnelOptions(
            { authtoken: 'real-token', ngrokDomain: 'old.ngrok-free.dev' },
            { authtoken: SECRET_PLACEHOLDER, ngrokDomain: 'new.ngrok-free.dev' },
        );
        expect(merged).toEqual({ authtoken: 'real-token', ngrokDomain: 'new.ngrok-free.dev' });
    });

    test('clears a field when an empty string is sent', () => {
        expect(mergeTunnelOptions({ authtoken: 'real-token' }, { authtoken: '' })).toEqual({});
        expect(mergeTunnelOptions({ ngrokDomain: 'demo.ngrok-free.dev' }, { ngrokDomain: '' })).toEqual({});
    });

    test('identifies which provider and option pairs yield a fixed URL', () => {
        expect(isFixedUrlConfig('cloudflared', { cloudflaredMode: 'named' })).toBe(true);
        expect(isFixedUrlConfig('cloudflared', { cloudflaredMode: 'quick' })).toBe(false);
        expect(isFixedUrlConfig('ngrok', { ngrokDomain: 'demo.ngrok-free.dev' })).toBe(true);
        expect(isFixedUrlConfig('ngrok', {})).toBe(false);
        expect(isFixedUrlConfig('tailscale', {})).toBe(true);
        expect(isFixedUrlConfig('bore', { borePort: 41420 })).toBe(true);
        expect(isFixedUrlConfig('bore', {})).toBe(false);
        expect(isFixedUrlConfig(null, {})).toBe(false);
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
