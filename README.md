# 🚀 Copilot Proxy for Cursor

> Forked from [jacksonkasi1/copilot-for-cursor](https://github.com/jacksonkasi1/copilot-for-cursor) with full Anthropic → OpenAI conversion + Responses API bridge.

**Unlock the full power of GitHub Copilot in Cursor IDE.**

Use **all** Copilot models (GPT-5.4, Claude Opus 4.6, Gemini 3.1, etc.) in Cursor — including Plan mode, Agent mode, and tool calls.

---

## ⚡ Quick Start

### One Command (npm)

```bash
npx copilot-cursor-proxy
```

> Requires [Bun](https://bun.sh/) installed. First run will prompt GitHub authentication.

This starts both `copilot-api` (port 4141) and the proxy (port 4142) in a single terminal.

### Or from source

```bash
git clone https://github.com/CharlesYWL/copilot-for-cursor.git
cd copilot-for-cursor
bun run start.ts
```

### Then start an HTTPS tunnel

Cursor requires HTTPS. In a second terminal:

```bash
# Cloudflare (free, no signup)
cloudflared tunnel --url http://localhost:4142

# Or ngrok
ngrok http 4142
```

Copy the HTTPS URL (e.g., `https://xxxxx.trycloudflare.com`).

---

## 🏗 Architecture

```
Cursor → (HTTPS tunnel) → proxy-router (:4142) → copilot-api (:4141) → GitHub Copilot
```

*   **Port 4141 (`copilot-api`):** Authenticates with GitHub and provides the OpenAI-compatible API.
    *   *Powered by [copilot-api](https://www.npmjs.com/package/copilot-api) (installed via `npx`).*
*   **Port 4142 (`proxy-router`):** Converts Anthropic-format messages to OpenAI format, bridges Responses API for GPT-5.x models, handles the `cus-` prefix, and serves the dashboard.
*   **HTTPS tunnel:** Cursor requires HTTPS — a tunnel exposes the local proxy.

### Proxy Router Modules

| File | Responsibility |
|---|---|
| `proxy-router.ts` | Entrypoint — Bun.serve, routing, CORS, dashboard, model list |
| `anthropic-transforms.ts` | Anthropic → OpenAI normalization (fields, tools, messages) |
| `responses-bridge.ts` | Chat Completions → Responses API bridge for GPT-5.x / goldeneye |
| `responses-converters.ts` | Responses API → Chat Completions format (sync & streaming SSE) |
| `stream-proxy.ts` | Streaming passthrough with chunk logging and error detection |
| `debug-logger.ts` | Request/response debug logging helpers |
| `start.ts` | One-command launcher for copilot-api + proxy-router |

---

## ⚙️ Cursor Configuration

1.  Go to **Settings** (Gear Icon) → **Models**.
2.  Add a new **OpenAI Compatible** model:
    *   **Base URL:** `https://your-tunnel-url.trycloudflare.com/v1`
    *   **API Key:** `dummy` (any value works)
    *   **Model Name:** Use a **prefixed name** — e.g., `cus-gpt-5.4`, `cus-claude-opus-4.6`

> **⚠️ Important:** You **must** use the `cus-` prefix. Without it, Cursor routes the request to its own backend.

> **💡 Tip:** Visit the [Dashboard](http://localhost:4142) to see all available models and copy their IDs.

### Tested Models (20/21 passing)

| Cursor Model Name | Actual Model | API Route |
|---|---|---|
| `cus-gpt-4o` | GPT-4o | Chat Completions |
| `cus-gpt-4.1` | GPT-4.1 | Chat Completions |
| `cus-gpt-5-mini` | GPT-5 Mini | Chat Completions |
| `cus-gpt-5.1` | GPT-5.1 | Chat Completions |
| `cus-gpt-5.2` | GPT-5.2 | Responses API ✨ |
| `cus-gpt-5.2-codex` | GPT-5.2 Codex | Responses API ✨ |
| `cus-gpt-5.3-codex` | GPT-5.3 Codex | Responses API ✨ |
| `cus-gpt-5.4` | GPT-5.4 | Responses API ✨ |
| `cus-gpt-5.4-mini` | GPT-5.4 Mini | Responses API ✨ |
| `cus-claude-haiku-4.5` | Claude Haiku 4.5 | Chat Completions |
| `cus-claude-sonnet-4` | Claude Sonnet 4 | Chat Completions |
| `cus-claude-sonnet-4.5` | Claude Sonnet 4.5 | Chat Completions |
| `cus-claude-sonnet-4.6` | Claude Sonnet 4.6 | Chat Completions |
| `cus-claude-opus-4.5` | Claude Opus 4.5 | Chat Completions |
| `cus-claude-opus-4.6` | Claude Opus 4.6 | Chat Completions |
| `cus-claude-opus-4.6-1m` | Claude Opus 4.6 (1M) | Chat Completions |
| `cus-gemini-2.5-pro` | Gemini 2.5 Pro | Chat Completions |
| `cus-gemini-3-flash-preview` | Gemini 3 Flash | Chat Completions |
| `cus-gemini-3.1-pro-preview` | Gemini 3.1 Pro | Chat Completions |
| `cus-goldeneye` | Goldeneye | Responses API ✨ |

![Cursor Settings Configuration](./cursor-settings.png)

---

## ✨ Features

### What the proxy handles

| Cursor sends (Anthropic format) | Proxy converts to (OpenAI format) |
|---|---|
| `system` as top-level field | System message |
| `tool_use` blocks in assistant messages | `tool_calls` array |
| `tool_result` blocks in user messages | `tool` role messages |
| `input_schema` on tools | `parameters` (cleaned) |
| `tool_choice` objects (`auto`/`any`/`tool`) | OpenAI format (`auto`/`required`/function) |
| `stop_sequences` | `stop` |
| `thinking` / `cache_control` blocks | Stripped |
| `metadata` / `anthropic_version` | Stripped |
| Images in Claude requests | `[Image Omitted]` placeholder |
| GPT-5.x Chat Completions requests | **Bridged to Responses API** ✨ |
| Responses API streaming SSE | **Converted to Chat Completions SSE** ✨ |

### Supported Workflows

*   **💬 Chat & Reasoning:** Full conversation context with all models
*   **📋 Plan Mode:** Works with tool calls and multi-turn conversations
*   **🤖 Agent Mode:** File editing, terminal, search, MCP tools
*   **📂 File System:** `Read`, `Write`, `StrReplace`, `Delete`
*   **💻 Terminal:** `Shell` (run commands)
*   **🔍 Search:** `Grep`, `Glob`, `SemanticSearch`
*   **🔌 MCP Tools:** External tools (Neon, Playwright, etc.)

---

## 🔒 Security: API Key Protection

If you're using a tunnel (exposing to the public internet), set an API key:

**Config location:**
- Linux/macOS: `~/.local/share/copilot-api/config.json`
- Windows: `%USERPROFILE%\.local\share\copilot-api\config.json`

```json
{
  "auth": {
    "apiKeys": ["your-secret-key-here"]
  }
}
```

Then use the same key as the **API Key** in Cursor settings.

---

## ⚠️ Known Limitations

| Feature | Status |
|---|---|
| Basic chat & tool calling | ✅ Works |
| Streaming | ✅ Works |
| Plan mode | ✅ Works |
| Agent mode | ✅ Works |
| GPT-5.x models | ✅ Works (via Responses API bridge) |
| Extended thinking (chain-of-thought) | ❌ Stripped |
| Prompt caching (`cache_control`) | ❌ Stripped |
| Claude Vision | ❌ Not supported via Copilot |
| Tunnel URL changes on restart | ⚠️ Use paid plan for fixed subdomain |

---

## 📝 Troubleshooting

**"Model name is not valid" in Cursor:**
Make sure you're using the `cus-` prefix (e.g., `cus-gpt-5.4`, not `gpt-5.4`).

**Plan mode response cuts off:**
Ensure `idleTimeout: 255` is set in `proxy-router.ts` (already configured). Slow models like Opus need longer timeouts.

**GPT-5.x returns "use /v1/responses":**
The proxy auto-routes these. Make sure you're running the latest version.

**"connection refused":**
Ensure services are running: `bun run start.ts` or check `http://localhost:4142`.

---

> ⚠️ **DISCLAIMER:** This project is **unofficial** and for **educational purposes only**. It interacts with undocumented internal APIs of GitHub Copilot and Cursor. Use at your own risk. The authors are not affiliated with GitHub, Microsoft, or Anysphere (Cursor). Please use your API credits responsibly and in accordance with the provider's Terms of Service.