import { describe, expect, test } from 'bun:test';
import { getCloudflaredAssetName } from './tunnel';

describe('cloudflared release asset', () => {
    test('selects the native macOS archive', () => {
        expect(getCloudflaredAssetName('darwin', 'arm64')).toBe('cloudflared-darwin-arm64.tgz');
        expect(getCloudflaredAssetName('darwin', 'x64')).toBe('cloudflared-darwin-amd64.tgz');
    });

    test('preserves Linux and Windows asset selection', () => {
        expect(getCloudflaredAssetName('linux', 'arm64')).toBe('cloudflared-linux-arm64');
        expect(getCloudflaredAssetName('win32', 'ia32')).toBe('cloudflared-windows-386.exe');
        expect(getCloudflaredAssetName('win32', 'arm64')).toBe('cloudflared-windows-amd64.exe');
    });

    test('rejects unsupported platforms', () => {
        expect(getCloudflaredAssetName('freebsd', 'x64')).toBeNull();
    });
});
