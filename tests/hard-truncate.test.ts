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

    test('shrinks oversized assistant tool_calls arguments to fit the budget', () => {
        // Regression: previously the shrink loop only touched the last message's
        // `content`, so an assistant/tool pair whose weight lived in
        // `tool_calls[0].function.arguments` could remain far over budget.
        const hugeArgs = JSON.stringify({ query: 'x'.repeat(20000) });
        const msgs = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'search', arguments: hugeArgs } },
                ],
            },
            { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        ];

        const target = 500;
        const out = hardTruncateMessages(msgs, target);

        // Final request must fit the budget.
        // estimateMessagesTokens is internal; re-implement the same char-based
        // estimate here so the assertion stays self-contained.
        const estTokens = (s: string) => {
            let a = 0, n = 0;
            for (let i = 0; i < s.length; i++) (s.charCodeAt(i) < 128 ? a++ : n++);
            return Math.ceil(a / 4 + n / 1.5);
        };
        let total = 0;
        for (const m of out) {
            total += 4;
            if (typeof m.content === 'string') total += estTokens(m.content);
            else if (Array.isArray(m.content))
                for (const p of m.content)
                    total += p.type === 'text' ? estTokens(p.text || '') : estTokens(JSON.stringify(p));
            if (m.tool_calls) total += estTokens(JSON.stringify(m.tool_calls));
        }
        expect(total).toBeLessThanOrEqual(target);

        // Assistant/tool pair preserved and args shrunk (not deleted).
        const assistant = out.find((m: any) => m.role === 'assistant');
        expect(assistant).toBeDefined();
        expect(Array.isArray(assistant.tool_calls)).toBe(true);
        expect(assistant.tool_calls.length).toBeGreaterThan(0);
        expect(assistant.tool_calls[0].function.arguments.length).toBeLessThan(hugeArgs.length);
    });
});
