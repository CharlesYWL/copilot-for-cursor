import { describe, expect, test } from 'bun:test';
import {
    convertResponsesStreamToChatCompletions,
    convertResponsesSyncToChatCompletions,
    sanitizeCursorSubagentArguments,
} from './responses-converters';

describe('Cursor subagent argument sanitization', () => {
    test('removes cloud_base_branch from local subagent calls', () => {
        expect(sanitizeCursorSubagentArguments(
            'Subagent',
            JSON.stringify({
                description: 'Inspect repository',
                environment: 'local',
                cloud_base_branch: '',
            }),
        )).toBe(JSON.stringify({
            description: 'Inspect repository',
            environment: 'local',
        }));
    });

    test('preserves cloud subagent branches and unrelated tools', () => {
        const cloudArgs = JSON.stringify({
            environment: 'cloud',
            cloud_base_branch: 'main',
        });
        expect(sanitizeCursorSubagentArguments('Subagent', cloudArgs)).toBe(cloudArgs);
        expect(sanitizeCursorSubagentArguments('Read', cloudArgs)).toBe(cloudArgs);
    });

    test('sanitizes synchronous Responses tool calls', async () => {
        const response = convertResponsesSyncToChatCompletions({
            output: [{
                type: 'function_call',
                call_id: 'call_1',
                name: 'Subagent',
                arguments: JSON.stringify({
                    description: 'Inspect repository',
                    environment: 'local',
                    cloud_base_branch: '',
                }),
            }],
        }, 'gpt-5.6-sol', 'chat-1', {});

        const body = await response.json() as any;
        expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({
            description: 'Inspect repository',
            environment: 'local',
        });
    });

    test('buffers and sanitizes streaming Responses tool arguments', async () => {
        const args = JSON.stringify({
            description: 'Inspect repository',
            environment: 'local',
            cloud_base_branch: '',
        });
        const events = [
            {
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'call_1',
                    name: 'Subagent',
                    arguments: '',
                },
            },
            {
                type: 'response.function_call_arguments.delta',
                output_index: 0,
                delta: args,
            },
            {
                type: 'response.function_call_arguments.done',
                output_index: 0,
                arguments: args,
            },
            {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'call_1',
                    name: 'Subagent',
                    arguments: args,
                },
            },
            {
                type: 'response.completed',
                response: {
                    output: [{ type: 'function_call' }],
                },
            },
        ];
        const upstream = new Response(
            events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
        );

        const response = convertResponsesStreamToChatCompletions(
            upstream,
            'gpt-5.6-sol',
            'chat-2',
            {},
        );
        const text = await response.text();
        const chunks = text
            .split('\n')
            .filter(line => line.startsWith('data: {'))
            .map(line => JSON.parse(line.slice(6)));
        const argumentsChunks = chunks
            .flatMap(chunk => chunk.choices || [])
            .flatMap((choice: any) => choice.delta?.tool_calls || [])
            .map((toolCall: any) => toolCall.function?.arguments)
            .filter((value: unknown) => typeof value === 'string' && value.length > 0);

        expect(argumentsChunks).toHaveLength(1);
        expect(JSON.parse(argumentsChunks[0])).toEqual({
            description: 'Inspect repository',
            environment: 'local',
        });
        expect(text).not.toContain('cloud_base_branch');
    });
});
