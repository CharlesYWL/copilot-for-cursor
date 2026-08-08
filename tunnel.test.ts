import { describe, expect, test } from 'bun:test';
import { getBoreTargetTriple, getCloudflaredAssetName, selectBoreAsset } from './tunnel';

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

describe('bore release asset', () => {
    // Names taken from the real bore v0.6.0 release listing.
    const assets = [
        'bore-v0.6.0-aarch64-apple-darwin.tar.gz',
        'bore-v0.6.0-x86_64-apple-darwin.tar.gz',
        'bore-v0.6.0-x86_64-unknown-linux-musl.tar.gz',
        'bore-v0.6.0-aarch64-unknown-linux-musl.tar.gz',
        'bore-v0.6.0-x86_64-pc-windows-msvc.zip',
        'bore-v0.6.0-i686-pc-windows-msvc.zip',
    ];

    test('maps each platform to its target triple', () => {
        expect(getBoreTargetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
        expect(getBoreTargetTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
        expect(getBoreTargetTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-musl');
        expect(getBoreTargetTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
        expect(getBoreTargetTriple('freebsd', 'x64')).toBeNull();
    });

    test('selects the archive matching a target triple regardless of version', () => {
        expect(selectBoreAsset(assets, 'aarch64-apple-darwin'))
            .toBe('bore-v0.6.0-aarch64-apple-darwin.tar.gz');
        expect(selectBoreAsset(assets, 'x86_64-pc-windows-msvc'))
            .toBe('bore-v0.6.0-x86_64-pc-windows-msvc.zip');
    });

    test('does not confuse triples that share a suffix', () => {
        expect(selectBoreAsset(assets, 'x86_64-apple-darwin'))
            .toBe('bore-v0.6.0-x86_64-apple-darwin.tar.gz');
        expect(selectBoreAsset(assets, 'i686-pc-windows-msvc'))
            .toBe('bore-v0.6.0-i686-pc-windows-msvc.zip');
    });

    test('returns null when no asset matches', () => {
        expect(selectBoreAsset(assets, 'arm-unknown-linux-musleabi')).toBeNull();
        expect(selectBoreAsset([], 'aarch64-apple-darwin')).toBeNull();
    });
});
