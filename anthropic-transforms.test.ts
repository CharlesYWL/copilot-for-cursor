import { describe, it, expect } from 'bun:test';
import { normalizeRequest } from './anthropic-transforms';

const FAKE_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAABAAAAAIwCAYAAAAYtxkUAAIUY0lEQVR4AezBeZCmB2Hf'.repeat(2000);

describe('normalizeRequest — tool_result image stripping', () => {
    it('replaces base64 image parts inside tool_result with [Image Omitted]', () => {
        const json = {
            model: 'claude-opus-4.7',
            messages: [
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'taking a screenshot' },
                        {
                            type: 'tool_use',
                            id: 'toolu_001',
                            name: 'browser_take_screenshot',
                            input: { fullPage: false },
                        },
                    ],
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_001',
                            content: [
                                { type: 'text', text: 'Screenshot captured' },
                                {
                                    type: 'image',
                                    source: {
                                        type: 'base64',
                                        media_type: 'image/png',
                                        data: FAKE_BASE64,
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        };

        normalizeRequest(json, true);

        const toolMsg = json.messages.find((m: any) => m.role === 'tool');
        expect(toolMsg).toBeDefined();
        expect(typeof toolMsg!.content).toBe('string');
        expect(toolMsg!.content).toContain('Screenshot captured');
        expect(toolMsg!.content).toContain('[Image Omitted]');
        expect(toolMsg!.content).not.toContain(FAKE_BASE64.slice(0, 200));
        expect(toolMsg!.content.length).toBeLessThan(1000);
    });

    it('preserves plain-text tool_result content unchanged', () => {
        const json = {
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_002',
                            content: 'exit code 0\nok',
                        },
                    ],
                },
            ],
        };

        normalizeRequest(json, true);

        const toolMsg = json.messages.find((m: any) => m.role === 'tool');
        expect(toolMsg!.content).toBe('exit code 0\nok');
    });

    it('handles tool_result with array of text parts', () => {
        const json = {
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_003',
                            content: [
                                { type: 'text', text: 'line 1' },
                                { type: 'text', text: 'line 2' },
                            ],
                        },
                    ],
                },
            ],
        };

        normalizeRequest(json, true);

        const toolMsg = json.messages.find((m: any) => m.role === 'tool');
        expect(toolMsg!.content).toBe('line 1\nline 2');
    });

    it('strips base64 image even when isClaude=false', () => {
        const json = {
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_004',
                            content: [
                                {
                                    type: 'image',
                                    source: {
                                        type: 'base64',
                                        media_type: 'image/png',
                                        data: FAKE_BASE64,
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        };

        normalizeRequest(json, false);

        const toolMsg = json.messages.find((m: any) => m.role === 'tool');
        expect(toolMsg!.content).toContain('[Image Omitted]');
        expect(toolMsg!.content).not.toContain(FAKE_BASE64.slice(0, 200));
    });

    it('keeps total request size small after stripping (regression for 222k token bug)', () => {
        const json = {
            messages: Array.from({ length: 5 }, (_, i) => ({
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: `toolu_${i}`,
                        content: [
                            { type: 'text', text: `Screenshot ${i}` },
                            {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: 'image/png',
                                    data: FAKE_BASE64,
                                },
                            },
                        ],
                    },
                ],
            })),
        };

        const originalSize = JSON.stringify(json).length;
        normalizeRequest(json, true);
        const transformedSize = JSON.stringify(json).length;

        expect(originalSize).toBeGreaterThan(500_000);
        expect(transformedSize).toBeLessThan(2_000);
    });
});

describe('normalizeRequest — tool call IDs', () => {
    it('sanitizes Claude-incompatible IDs while preserving tool result pairing', () => {
        const invalidId = 'toolu:cursor/read.file#1';
        const json = {
            messages: [
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: invalidId,
                            name: 'Read',
                            input: { path: 'README.md' },
                        },
                    ],
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: invalidId,
                            content: 'file contents',
                        },
                    ],
                },
            ],
        };

        normalizeRequest(json, true);

        const toolCallId = json.messages[0].tool_calls[0].id;
        expect(toolCallId).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(toolCallId.length).toBeLessThanOrEqual(64);
        expect(toolCallId).not.toBe(invalidId);
        expect(json.messages[1].tool_call_id).toBe(toolCallId);
    });

    it('sanitizes IDs in existing OpenAI-format tool messages', () => {
        const invalidId = 'call.with.invalid:characters';
        const json = {
            messages: [
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: invalidId,
                        type: 'function',
                        function: { name: 'Read', arguments: '{}' },
                    }],
                },
                {
                    role: 'tool',
                    tool_call_id: invalidId,
                    content: 'done',
                },
            ],
        };

        normalizeRequest(json, true);

        expect(json.messages[0].tool_calls[0].id).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(json.messages[1].tool_call_id).toBe(json.messages[0].tool_calls[0].id);
    });

    it('forwards messages whose tool call id is missing instead of throwing', () => {
        const json = {
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'tool', content: 'orphaned result' },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{ type: 'function', function: { name: 'Read', arguments: '{}' } }],
                },
            ],
        };

        expect(() => normalizeRequest(json, true)).not.toThrow();

        const toolMsg = json.messages.find((m: any) => m.role === 'tool');
        expect(toolMsg!.tool_call_id).toBeUndefined();
        expect(toolMsg!.content).toBe('orphaned result');
    });
});
