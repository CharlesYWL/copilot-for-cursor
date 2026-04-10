const PORT = 4142;
const TARGET_URL = "http://localhost:4141";
const PREFIX = "cus-";

console.log(`🚀 Proxy Router running on http://localhost:${PORT}`);
console.log(`🔗 Forwarding to ${TARGET_URL}`);
console.log(`🏷️  Prefix: "${PREFIX}"`);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 0. Serve Dashboard
    if (url.pathname === "/" || url.pathname === "/dashboard.html") {
      try {
        const dashboardContent = await Bun.file("dashboard.html").text();
        return new Response(dashboardContent, { headers: { "Content-Type": "text/html" } });
      } catch (e) {
        return new Response("Dashboard not found.", { status: 404 });
      }
    }

    const targetUrl = new URL(url.pathname + url.search, TARGET_URL);

    // Handle CORS
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    try {
      // 1. Handle Chat Completions (Modify Request Body)
      if (req.method === "POST" && url.pathname.includes("/chat/completions")) {
        let json = await req.json();
        const originalModel = json.model;
        let targetModel = json.model;

        if (json.model && json.model.startsWith(PREFIX)) {
          targetModel = json.model.slice(PREFIX.length);
          json.model = targetModel;
          console.log(`🔄 Rewriting model: ${originalModel} -> ${json.model}`);
        }

        const isClaude = targetModel.toLowerCase().includes('claude');

        // --- HELPER: Recursively clean schema object ---
        const cleanSchema = (schema: any) => {
            if (!schema || typeof schema !== 'object') return schema;
            if (schema.additionalProperties !== undefined) delete schema.additionalProperties;
            if (schema.$schema !== undefined) delete schema.$schema;
            if (schema.title !== undefined) delete schema.title;
            if (schema.properties) {
                for (const key in schema.properties) cleanSchema(schema.properties[key]);
            }
            if (schema.items) cleanSchema(schema.items);
            return schema;
        };

        // --- TRANSFORM TOOLS (Anthropic -> OpenAI) ---
        if (json.tools && Array.isArray(json.tools)) {
            json.tools = json.tools.map((tool: any) => {
                let parameters = tool.input_schema || tool.parameters || {};
                parameters = cleanSchema(parameters);
                if (tool.type === 'function' && tool.function) {
                    tool.function.parameters = cleanSchema(tool.function.parameters);
                    return tool;
                }
                return {
                    type: "function",
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: parameters 
                    }
                };
            });
        }

        // --- FIX TOOL_CHOICE ---
        if (json.tool_choice && typeof json.tool_choice === 'object') {
            if (json.tool_choice.type === 'auto') json.tool_choice = "auto";
            else if (json.tool_choice.type === 'none') json.tool_choice = "none";
            else if (json.tool_choice.type === 'required') json.tool_choice = "required";
        }

        // --- HELPER: Sanitize a content part for OpenAI (text/image_url only) ---
        const sanitizeContentPart = (part: any): any | null => {
            if (part.cache_control) delete part.cache_control;

            // Strip images for Claude
            if (isClaude && (part.type === 'image' || (part.source?.type === 'base64'))) {
                return { type: 'text', text: '[Image Omitted]' };
            }
            // Transform base64 images to image_url
            if (part.type === 'image' && part.source?.type === 'base64') {
                return { type: 'image_url', image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } };
            }
            if (part.type === 'image') { part.type = 'image_url'; return part; }

            // Only keep text and image_url
            if (part.type === 'text' || part.type === 'image_url') return part;

            // Drop everything else (thinking, tool_use, tool_result handled separately)
            return null;
        };

        // --- PROCESS MESSAGES: Full Anthropic → OpenAI conversion ---
        if (json.messages && Array.isArray(json.messages)) {
            const newMessages: any[] = [];

            for (const msg of json.messages) {

                // --- ASSISTANT messages: convert tool_use blocks → OpenAI tool_calls ---
                if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                    const textParts: string[] = [];
                    const toolCalls: any[] = [];

                    for (const part of msg.content) {
                        if (part.type === 'tool_use') {
                            toolCalls.push({
                                id: part.id,
                                type: 'function',
                                function: {
                                    name: part.name,
                                    arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {})
                                }
                            });
                        } else if (part.type === 'text') {
                            textParts.push(part.text);
                        }
                        // Skip thinking, etc.
                    }

                    const assistantMsg: any = { role: 'assistant' };
                    assistantMsg.content = textParts.join('\n') || null;
                    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
                    newMessages.push(assistantMsg);
                    continue;
                }

                // --- USER messages: convert tool_result blocks → OpenAI tool role messages ---
                if (msg.role === 'user' && Array.isArray(msg.content)) {
                    const toolResults = msg.content.filter((c: any) => c.type === 'tool_result');
                    const otherParts = msg.content.filter((c: any) => c.type !== 'tool_result' && c.type !== 'tool_use');

                    // Emit tool messages first
                    for (const tr of toolResults) {
                        let resultContent = tr.content;
                        if (typeof resultContent !== 'string') {
                            if (Array.isArray(resultContent)) {
                                resultContent = resultContent.map((p: any) => p.text || JSON.stringify(p)).join('\n');
                            } else {
                                resultContent = JSON.stringify(resultContent);
                            }
                        }
                        newMessages.push({
                            role: 'tool',
                            tool_call_id: tr.tool_use_id,
                            content: resultContent || ''
                        });
                    }

                    // Emit remaining user content (sanitized)
                    if (otherParts.length > 0) {
                        const cleaned = otherParts.map(sanitizeContentPart).filter(Boolean);
                        if (cleaned.length > 0) {
                            newMessages.push({ role: 'user', content: cleaned });
                        }
                    }
                    continue;
                }

                // --- All other messages: sanitize content parts ---
                if (Array.isArray(msg.content)) {
                    const cleaned = msg.content.map(sanitizeContentPart).filter(Boolean);
                    msg.content = cleaned.length > 0 ? cleaned : ' ';
                }
                newMessages.push(msg);
            }

            json.messages = newMessages;
        }

        const body = JSON.stringify(json);
        const headers = new Headers(req.headers);
        headers.set("host", targetUrl.host);
        headers.set("content-length", String(new TextEncoder().encode(body).length));

        // --- VISION HEADER (Only if NOT Claude) ---
        const hasVisionContent = (messages: any[]) => messages.some(msg => 
            Array.isArray(msg.content) && msg.content.some((p: any) => p.type === 'image_url')
        );

        if (!isClaude && hasVisionContent(json.messages)) {
             headers.set("Copilot-Vision-Request", "true");
        }

        const response = await fetch(targetUrl.toString(), {
          method: "POST",
          headers: headers,
          body: body,
        });

        // Return response with CORS
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        
        // If error, log the response body from upstream
        if (!response.ok) {
            const errText = await response.text();
            console.error(`❌ Upstream Error (${response.status}):`, errText);
            return new Response(errText, { status: response.status, headers: responseHeaders });
        }

        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        });
      }

      // 2. Handle Models List
      if (req.method === "GET" && url.pathname.includes("/models")) {
        const headers = new Headers(req.headers);
        headers.set("host", targetUrl.host);
        const response = await fetch(targetUrl.toString(), { method: "GET", headers: headers });
        const data = await response.json();
        
        if (data.data && Array.isArray(data.data)) {
          data.data = data.data.map((model: any) => ({
            ...model,
            id: PREFIX + model.id,
            display_name: PREFIX + (model.display_name || model.id)
          }));
        }
        return new Response(JSON.stringify(data), {
            status: response.status,
            headers: { ...Object.fromEntries(response.headers), "Access-Control-Allow-Origin": "*" }
        });
      }

      // 3. Fallback
      const headers = new Headers(req.headers);
      headers.set("host", targetUrl.host);
      const response = await fetch(targetUrl.toString(), {
        method: req.method,
        headers: headers,
        body: req.body,
      });
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, { status: response.status, headers: responseHeaders });

    } catch (error) {
      console.error("Proxy Error:", error);
      return new Response(JSON.stringify({ error: "Proxy Error", details: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
});
