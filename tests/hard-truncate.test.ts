import { describe, expect, test } from 'bun:test';
import { hardTruncateMessages } from '../max-mode';

const bigUser = (label: string, size = 4000) => ({
    role: 'user',
    content: `${label}:` + 'x'.repeat(size),
});

describe('hardTruncateMessages', () => {
    test('never returns only system messages when dropping assistant/tool pairs under tight budget', () => {
        // Regression: previously, dropping the assistant then the now-orphan
        // tool could collapse `rest` to []. The look-ahead must bail out and
        // leave the pair intact.
        const msgs = [
            { role: 'system', content: 'sys' },
            bigUser('old-user', 8000),
            {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(8000) },
        ];

        const out = hardTruncateMessages(msgs, 50);

        const nonSystem = out.filter((m: any) => m.role !== 'system');
        expect(nonSystem.length).toBeGreaterThan(0);

        const hasOrphanTool = out.some((m: any, i: number) => {
            if (m.role !== 'tool') return false;
            const id = m.tool_call_id;
            return !out.slice(0, i).some(
                (prev: any) =>
                    prev.role === 'assistant' &&
                    Array.isArray(prev.tool_calls) &&
                    prev.tool_calls.some((tc: any) => tc.id === id),
            );
        });
        expect(hasOrphanTool).toBe(false);
    });

    test('drops oldest user messages first when over budget', () => {
        const msgs = [
            { role: 'system', content: 'sys' },
            bigUser('old', 8000),
            bigUser('mid', 8000),
            bigUser('recent', 4000),
        ];
        const out = hardTruncateMessages(msgs, 1500);
        const contents = out
            .filter((m: any) => m.role === 'user')
            .map((m: any) => (typeof m.content === 'string' ? m.content.slice(0, 10) : ''));
        expect(contents.some((c: string) => c.startsWith('recent:'))).toBe(true);
    });

    test('preserves system messages', () => {
        const msgs = [
            { role: 'system', content: 'sys1' },
            { role: 'system', content: 'sys2' },
            bigUser('a', 8000),
            bigUser('b', 8000),
        ];
        const out = hardTruncateMessages(msgs, 200);
        const systems = out.filter((m: any) => m.role === 'system').map((m: any) => m.content);
        expect(systems).toEqual(['sys1', 'sys2']);
    });
});
