const CURSOR_SUBAGENT_TOOLS = new Set(['subagent', 'task']);

export function sanitizeCursorSubagentArguments(toolName: unknown, argumentsJson: unknown): unknown {
    if (
        typeof toolName !== 'string'
        || !CURSOR_SUBAGENT_TOOLS.has(toolName.toLowerCase())
        || typeof argumentsJson !== 'string'
    ) {
        return argumentsJson;
    }

    try {
        const args = JSON.parse(argumentsJson);
        if (
            typeof args === 'object'
            && args !== null
            && !Array.isArray(args)
            && args.environment !== 'cloud'
            && Object.prototype.hasOwnProperty.call(args, 'cloud_base_branch')
        ) {
            delete args.cloud_base_branch;
            console.log(`🧹 Removed cloud_base_branch from local ${toolName} call`);
            return JSON.stringify(args);
        }
    } catch {
        return argumentsJson;
    }

    return argumentsJson;
}

export function convertResponsesSyncToChatCompletions(data: any, model: string, chatId: string, corsHeaders: any) {
    const result: any = {
        id: chatId,
        object: 'chat.completion',
        created: data.created_at || Math.floor(Date.now() / 1000),
        model: model,
        choices: [],
        usage: data.usage ? {
            prompt_tokens: data.usage.input_tokens,
            completion_tokens: data.usage.output_tokens,
            total_tokens: data.usage.total_tokens,
        } : undefined,
    };

    let textContent = '';
    const toolCalls: any[] = [];

    for (const item of (data.output || [])) {
        if (item.type === 'message' && item.content) {
            for (const part of item.content) {
                if (part.type === 'output_text') textContent += part.text;
            }
        }
        if (item.type === 'function_call') {
            toolCalls.push({
                id: item.call_id || item.id,
                type: 'function',
                function: {
                    name: item.name,
                    arguments: sanitizeCursorSubagentArguments(item.name, item.arguments),
                },
            });
        }
    }

    const choice: any = {
        index: 0,
        message: {
            role: 'assistant',
            content: textContent || null,
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
    if (toolCalls.length > 0) choice.message.tool_calls = toolCalls;
    result.choices.push(choice);

    return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

export function convertResponsesStreamToChatCompletions(response: Response, model: string, chatId: string, corsHeaders: any) {
    if (!response.body) {
        return new Response(JSON.stringify({ error: 'No response body' }), {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let toolCallIndex = 0;
    let sentRole = false;
    let chunkCount = 0;
    const toolCallsByOutputIndex = new Map<number, {
        chatIndex: number;
        name: string;
        arguments: string;
        argumentsEmitted: boolean;
    }>();

    const makeChatChunk = (delta: any, finishReason: string | null = null) => {
        const chunk: any = {
            id: chatId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
        };
        return `data: ${JSON.stringify(chunk)}\n\n`;
    };

    function emitToolArguments(
        outputIndex: number,
        controller: ReadableStreamDefaultController,
        completeArguments?: unknown,
    ) {
        const state = toolCallsByOutputIndex.get(outputIndex);
        if (!state || state.argumentsEmitted) return;

        const argumentsJson = typeof completeArguments === 'string'
            ? completeArguments
            : state.arguments;
        controller.enqueue(encoder.encode(makeChatChunk({
            tool_calls: [{
                index: state.chatIndex,
                function: {
                    arguments: sanitizeCursorSubagentArguments(state.name, argumentsJson),
                },
            }]
        })));
        state.argumentsEmitted = true;
        chunkCount++;
    }

    function processLines(lines: string[], controller: ReadableStreamDefaultController) {
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            let event: any;
            try { event = JSON.parse(jsonStr); } catch { continue; }

            const eventType = event.type;

            if (eventType === 'response.output_text.delta') {
                const delta: any = { content: event.delta };
                if (!sentRole) { delta.role = 'assistant'; sentRole = true; }
                controller.enqueue(encoder.encode(makeChatChunk(delta)));
                chunkCount++;
            }

            else if (eventType === 'response.output_item.added' && event.item?.type === 'function_call') {
                const outputIndex = typeof event.output_index === 'number'
                    ? event.output_index
                    : toolCallIndex;
                const chatIndex = toolCallIndex++;
                toolCallsByOutputIndex.set(outputIndex, {
                    chatIndex,
                    name: event.item.name,
                    arguments: '',
                    argumentsEmitted: false,
                });
                const delta: any = {
                    tool_calls: [{
                        index: chatIndex,
                        id: event.item.call_id || event.item.id,
                        type: 'function',
                        function: { name: event.item.name, arguments: '' },
                    }]
                };
                if (!sentRole) { delta.role = 'assistant'; sentRole = true; }
                controller.enqueue(encoder.encode(makeChatChunk(delta)));
                chunkCount++;
            }

            else if (eventType === 'response.function_call_arguments.delta') {
                const outputIndex = typeof event.output_index === 'number'
                    ? event.output_index
                    : toolCallIndex - 1;
                const state = toolCallsByOutputIndex.get(outputIndex);
                if (state && typeof event.delta === 'string') {
                    state.arguments += event.delta;
                }
            }

            else if (eventType === 'response.function_call_arguments.done') {
                const outputIndex = typeof event.output_index === 'number'
                    ? event.output_index
                    : toolCallIndex - 1;
                emitToolArguments(outputIndex, controller, event.arguments);
            }

            else if (eventType === 'response.output_item.done' && event.item?.type === 'function_call') {
                const outputIndex = typeof event.output_index === 'number'
                    ? event.output_index
                    : toolCallIndex - 1;
                emitToolArguments(outputIndex, controller, event.item.arguments);
            }

            else if (eventType === 'response.completed') {
                for (const outputIndex of toolCallsByOutputIndex.keys()) {
                    emitToolArguments(outputIndex, controller);
                }
                const hasToolCalls = (event.response?.output || []).some((o: any) => o.type === 'function_call');
                const finishReason = hasToolCalls ? 'tool_calls' : 'stop';
                controller.enqueue(encoder.encode(makeChatChunk({}, finishReason)));
                if (event.response?.usage) {
                    const usageChunk: any = {
                        id: chatId, object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000), model,
                        choices: [],
                        usage: {
                            prompt_tokens: event.response.usage.input_tokens,
                            completion_tokens: event.response.usage.output_tokens,
                            total_tokens: event.response.usage.total_tokens,
                        },
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
                }
                chunkCount++;
            }
        }
    }

    const stream = new ReadableStream({
        async start(controller) {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        if (buffer.trim()) {
                            processLines(buffer.split('\n'), controller);
                        }
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                        console.log(`✅ Responses→Chat stream complete: ${chunkCount} events processed`);
                        controller.close();
                        return;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    processLines(lines, controller);
                }
            } catch (err: any) {
                console.error('❌ Responses stream conversion error:', err);
                try { controller.close(); } catch {}
            }
        }
    });

    return new Response(stream, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
}
