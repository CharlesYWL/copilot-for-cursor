import { describe, it, expect } from 'bun:test';
import { hardTruncateMessages, estimateMessagesTokens } from './max-mode';

// Helper: generates a string of approximately `tokens` estimated tokens (ASCII, ~4 chars/token)
function makeText(tokens: number): string {
    return 'x'.repeat(tokens * 4);
}

describe('hardTruncateMessages', () => {
    it('returns messages unchanged when already under budget', () => {
        const msgs = [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' },
        ];
        const result = hardTruncateMessages(msgs, 10000);
        expect(result).toHaveLength(3);
        expect(result[0].content).toBe('You are helpful.');
    });

    it('drops oldest messages to fit under budget', () => {
        const msgs = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: makeText(1000) },
            { role: 'assistant', content: makeText(1000) },
            { role: 'user', content: makeText(1000) },
            { role: 'assistant', content: 'last reply' },
        ];
        const budget = 1200; // only room for system + ~1 message
        const result = hardTruncateMessages(msgs, budget);
        expect(estimateMessagesTokens(result)).toBeLessThanOrEqual(budget);
        // Last message should still be there
        expect(result[result.length - 1].content).toBe('last reply');
    });

    it('guarantees output is within budget even when only 2 huge messages remain', () => {
        const msgs = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: makeText(50000) },
            { role: 'assistant', content: makeText(50000) },
        ];
        const budget = 5000;
        const result = hardTruncateMessages(msgs, budget);
        const finalTokens = estimateMessagesTokens(result);
        expect(finalTokens).toBeLessThanOrEqual(budget);
        // Content should be truncated, not empty
        expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('truncates system messages as last resort', () => {
        const msgs = [
            { role: 'system', content: makeText(50000) },
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello' },
        ];
        const budget = 2000;
        const result = hardTruncateMessages(msgs, budget);
        const finalTokens = estimateMessagesTokens(result);
        expect(finalTokens).toBeLessThanOrEqual(budget);
        expect(result[0].role).toBe('system');
        expect(result[0].content).toContain('[truncated]');
    });

    it('removes orphaned tool messages when their assistant is dropped', () => {
        const msgs = [
            { role: 'system', content: 'sys' },
            {
                role: 'assistant',
                content: 'calling tool',
                tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'foo', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'tc_1', content: makeText(5000) },
            { role: 'user', content: 'thanks' },
            { role: 'assistant', content: 'done' },
        ];
        const budget = 500;
        const result = hardTruncateMessages(msgs, budget);
        // No orphaned tool messages should remain
        for (const msg of result) {
            if (msg.role === 'tool') {
                // If a tool message remains, its assistant+tool_calls must also be present
                const hasMatchingAssistant = result.some(
                    (m: any) =>
                        m.role === 'assistant' &&
                        m.tool_calls?.some((tc: any) => tc.id === msg.tool_call_id),
                );
                expect(hasMatchingAssistant).toBe(true);
            }
        }
        expect(estimateMessagesTokens(result)).toBeLessThanOrEqual(budget);
    });

    it('cleans up orphaned tool messages at the front of the message list', () => {
        const msgs = [
            { role: 'system', content: 'sys' },
            // These tool messages are orphaned (no preceding assistant with matching tool_calls)
            { role: 'tool', tool_call_id: 'tc_orphan1', content: 'result 1' },
            { role: 'tool', tool_call_id: 'tc_orphan2', content: 'result 2' },
            { role: 'user', content: makeText(2000) },
            { role: 'assistant', content: makeText(2000) },
            { role: 'user', content: 'latest question' },
            { role: 'assistant', content: 'latest reply' },
        ];
        const budget = 500;
        const result = hardTruncateMessages(msgs, budget);
        // Orphaned tool messages should be dropped
        const toolMsgs = result.filter((m: any) => m.role === 'tool');
        expect(toolMsgs).toHaveLength(0);
    });

    it('preserves conversation validity with tool-call/tool-result pairs', () => {
        const msgs = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: makeText(3000) },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'tc_old', type: 'function', function: { name: 'old_tool', arguments: makeText(3000) } },
                ],
            },
            { role: 'tool', tool_call_id: 'tc_old', content: makeText(3000) },
            { role: 'user', content: 'next question' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'tc_new', type: 'function', function: { name: 'new_tool', arguments: '{}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'tc_new', content: 'tool result' },
        ];
        const budget = 500;
        const result = hardTruncateMessages(msgs, budget);
        expect(estimateMessagesTokens(result)).toBeLessThanOrEqual(budget);
    });
});
