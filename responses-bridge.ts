import { convertResponsesSyncToChatCompletions, convertResponsesStreamToChatCompletions } from './responses-converters';

export async function handleResponsesAPIBridge(json: any, req: Request, chatId: string, targetUrl: string) {
    const corsHeaders = { "Access-Control-Allow-Origin": "*" };

    const responsesReq: any = {
        model: json.model,
        stream: json.stream ?? false,
    };

    const systemMsgs = (json.messages || []).filter((m: any) => m.role === 'system');
    const nonSystemMsgs = (json.messages || []).filter((m: any) => m.role !== 'system');
    if (systemMsgs.length > 0) {
        responsesReq.instructions = systemMsgs.map((m: any) => 
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        ).join('\n');
    }

    if (json.input !== undefined) {
        responsesReq.input = json.input;
    } else if (nonSystemMsgs.length > 0) {
        responsesReq.input = nonSystemMsgs.map((m: any) => {
            const content = typeof m.content === 'string' ? m.content
                : Array.isArray(m.content) ? m.content.map((p: any) => {
                    if (p.type === 'text') return { type: 'input_text', text: p.text };
                    if (p.type === 'image_url') return { type: 'input_image', image_url: p.image_url.url };
                    return { type: 'input_text', text: JSON.stringify(p) };
                })
                : String(m.content);

            if (m.role === 'tool') {
                return {
                    type: 'function_call_output',
                    call_id: m.tool_call_id,
                    output: typeof content === 'string' ? content : JSON.stringify(content),
                };
            }

            if (m.role === 'assistant' && m.tool_calls) {
                const items: any[] = [];
                if (typeof content === 'string' && content) {
                    items.push({ role: 'assistant', type: 'message', content: [{ type: 'output_text', text: content }] });
                }
                for (const tc of m.tool_calls) {
                    items.push({
                        type: 'function_call',
                        id: tc.id,
                        call_id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    });
                }
                return items;
            }

            return {
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: typeof content === 'string' ? content : content,
            };
        }).flat();
    } else {
        responsesReq.input = "";
    }

    if (json.tools && Array.isArray(json.tools)) {
        responsesReq.tools = json.tools.map((t: any) => {
            if (t.type === 'function' && t.function) {
                return {
                    type: 'function',
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters,
                };
            }
            return t;
        });
    }

    if (json.max_tokens) responsesReq.max_output_tokens = Math.max(json.max_tokens, 16);
    if (json.temperature !== undefined) responsesReq.temperature = json.temperature;
    if (json.top_p !== undefined) responsesReq.top_p = json.top_p;

    if (json.tool_choice) {
        if (typeof json.tool_choice === 'string') {
            responsesReq.tool_choice = json.tool_choice;
        } else if (json.tool_choice.type === 'function' && json.tool_choice.function) {
            responsesReq.tool_choice = { type: 'function', name: json.tool_choice.function.name };
        }
    }

    const responsesBody = JSON.stringify(responsesReq);
    console.log('📤 Responses API request:', responsesBody.slice(0, 500));

    const responsesUrl = new URL('/v1/responses', targetUrl);
    const headers = new Headers(req.headers);
    headers.set("host", responsesUrl.host);
    headers.set("content-type", "application/json");
    headers.set("content-length", String(new TextEncoder().encode(responsesBody).length));

    const response = await fetch(responsesUrl.toString(), {
        method: "POST",
        headers: headers,
        body: responsesBody,
    });

    console.log(`📡 Responses API upstream: ${response.status} | ${response.headers.get('content-type')}`);

    if (!response.ok) {
        const errText = await response.text();
        console.error(`❌ Responses API Error (${response.status}):`, errText);
        return new Response(errText, { status: response.status, headers: corsHeaders });
    }

    if (json.stream && response.body) {
        return convertResponsesStreamToChatCompletions(response, json.model, chatId, corsHeaders);
    } else {
        return convertResponsesSyncToChatCompletions(response, json.model, chatId, corsHeaders);
    }
}
