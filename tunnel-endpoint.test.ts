import { describe, expect, test } from 'bun:test';
import { buildTunnelApiUrl, getClipboardCommands } from './tunnel-endpoint';

describe('tunnel endpoint', () => {
    test('appends the OpenAI-compatible API path', () => {
        expect(buildTunnelApiUrl('https://example.trycloudflare.com')).toBe(
            'https://example.trycloudflare.com/v1'
        );
        expect(buildTunnelApiUrl('https://example.trycloudflare.com/')).toBe(
            'https://example.trycloudflare.com/v1'
        );
    });

    test('selects native clipboard commands for each platform', () => {
        expect(getClipboardCommands('win32')).toEqual([['clip.exe']]);
        expect(getClipboardCommands('darwin')).toEqual([['pbcopy']]);
        expect(getClipboardCommands('linux')).toEqual([
            ['wl-copy'],
            ['xclip', '-selection', 'clipboard'],
            ['xsel', '--clipboard', '--input'],
        ]);
    });
});
