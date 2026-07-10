import { beforeEach, describe, expect, test } from 'bun:test';
import {
    applySubagentPolicy,
    isSubagentsEnabled,
    setSubagentsEnabled,
} from './subagent-policy';

describe('subagent policy', () => {
    beforeEach(() => setSubagentsEnabled(true));

    test('leaves tools unchanged when subagents are enabled', () => {
        const json = { tools: [{ name: 'Subagent' }, { name: 'Read' }] };
        expect(applySubagentPolicy(json)).toEqual([]);
        expect(json.tools).toHaveLength(2);
        expect(isSubagentsEnabled()).toBe(true);
    });

    test('removes Anthropic and OpenAI subagent tool schemas when disabled', () => {
        setSubagentsEnabled(false);
        const json = {
            tools: [
                { name: 'Subagent' },
                { type: 'function', function: { name: 'Task' } },
                { name: 'Read' },
            ],
        };

        expect(applySubagentPolicy(json)).toEqual(['Subagent', 'Task']);
        expect(json.tools).toEqual([{ name: 'Read' }]);
    });

    test('clears a forced blocked tool choice', () => {
        setSubagentsEnabled(false);
        const json = {
            tools: [{ name: 'Subagent' }, { name: 'Read' }],
            tool_choice: { type: 'tool', name: 'Subagent' },
        };

        applySubagentPolicy(json);
        expect(json.tool_choice).toBe('auto');
    });

    test('disables required tool choice when every tool is removed', () => {
        setSubagentsEnabled(false);
        const json = {
            tools: [{ name: 'Task' }],
            tool_choice: { type: 'any' },
        };

        applySubagentPolicy(json);
        expect(json.tools).toEqual([]);
        expect(json.tool_choice).toBe('none');
    });
});
