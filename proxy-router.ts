import { normalizeRequest } from './anthropic-transforms';
import { handleResponsesAPIBridge } from './responses-bridge';
import { createStreamProxy } from './stream-proxy';
import { logIncomingRequest, logTransformedRequest } from './debug-logger';

const PORT = 4142;
const TARGET_URL = "http://localhost:4141";
const PREFIX = "cus-";
let responseCounter = 0;

console.log(`🚀 Proxy Router running on http://localhost:${PORT}`);
console.log(`🔗 Forwarding to ${TARGET_URL}`);
console.log(`🏷️  Prefix: "${PREFIX}"`);

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/dashboard.html") {
      try {
        const dashboardPath = import.meta.dir + "/dashboard.html";
        const dashboardContent = await Bun.file(dashboardPath).text();
        return new Response(dashboardContent, { headers: { "Content-Type": "text/html" } });
      } catch (e) {
        return new Response("Dashboard not found.", { status: 404 });
      }
    }

    const targetUrl = new URL(url.pathname + url.search, TARGET_URL);

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
      if (req.method === "POST" && url.pathname.includes("/chat/completions")) {
        let json = await req.json();

        logIncomingRequest(json);

        const originalModel = json.model;
        let targetModel = json.model;

        if (json.model && json.model.startsWith(PREFIX)) {
          targetModel = json.model.slice(PREFIX.length);
          json.model = targetModel;
          console.log(`🔄 Rewriting model: ${originalModel} -> ${json.model}`);
        }

        const isClaude = targetModel.toLowerCase().includes('claude');

        normalizeRequest(json, isClaude);

        logTransformedRequest(json);

        const body = JSON.stringify(json);
        const headers = new Headers(req.headers);
        headers.set("host", targetUrl.host);
        headers.set("content-length", String(new TextEncoder().encode(body).length));

        const needsResponsesAPI = targetModel.match(/^gpt-5\.[2-9]|^gpt-5\.\d+-codex|^o[1-9]|^goldeneye/i);
        
        // For models that need max_completion_tokens instead of max_tokens
        const needsMaxCompletionTokens = targetModel.match(/^gpt-5\.[2-9]|^gpt-5\.\d+-codex|^goldeneye/i);
        if (needsMaxCompletionTokens && json.max_tokens) {
            json.max_completion_tokens = json.max_tokens;
            delete json.max_tokens;
            console.log(`🔧 Converted max_tokens → max_completion_tokens`);
        }

        // Try Responses API first for models that may need it; fall back to chat completions
        if (needsResponsesAPI) {
            console.log(`🔀 Model ${targetModel} — trying Responses API bridge`);
            const chatId = `chatcmpl-proxy-${++responseCounter}`;
            try {
                const result = await handleResponsesAPIBridge(json, req, chatId, TARGET_URL);
                if (result.status !== 404) return result;
                console.log(`⚠️ Responses API returned 404 — falling back to chat/completions`);
            } catch (e) {
                console.log(`⚠️ Responses API failed — falling back to chat/completions`);
            }
        }

        const hasVisionContent = (messages: any[]) => messages?.some(msg => 
            Array.isArray(msg.content) && msg.content.some((p: any) => p.type === 'image_url')
        );

        if (!isClaude && json.messages && hasVisionContent(json.messages)) {
             headers.set("Copilot-Vision-Request", "true");
        }

        const response = await fetch(targetUrl.toString(), {
          method: "POST",
          headers: headers,
          body: body,
        });

        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        console.log(`📡 Upstream response: ${response.status} | content-type: ${response.headers.get('content-type')}`);
        
        if (!response.ok) {
            const errText = await response.text();
            console.error(`❌ Upstream Error (${response.status}):`, errText);
            return new Response(errText, { status: response.status, headers: responseHeaders });
        }

        if (json.stream && response.body) {
            return createStreamProxy(response.body, responseHeaders);
        }

        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        });
      }

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
