# copilot-auth：cursor-byok 的 GitHub Copilot 订阅插件 — 实现规格

> 交给实现方（本地 agent）的完整说明。目标仓库是 **leookun/cursor-byok 的 fork**，不是本仓库。
> 资料核对日期：2026-10-09。上游 SDK 与 Copilot 接口都会变，开工前先按「0. 开工前核对」过一遍。

---

## 0. 开工前核对（5 分钟）

在 cursor-byok fork 的 `main` 上确认以下文件仍与本文描述一致，不一致以源码为准：

| 文件 | 核对点 |
|---|---|
| `server/src/plugin/sdk/{plugin,provider,model,resource}.ts` | 类型签名（本文第 4 节引用） |
| `server/src/plugin/sdk/protocol/openai_{chat,responses}.ts` | `streamOpenAiChat` / `streamOpenAiResponses` / `HttpError` 导出 |
| `server/src/plugin/worker.rs` 约 259–276 行 | Deno 启动参数：`--no-npm --no-remote`、无 `--allow-net` |
| `server/src/plugin/manifest.rs` | `plugin.json` 字段（`deny_unknown_fields`）、网络主机校验 |
| `server/plugins/build-in/grok-auth/` | 最接近的模板（设备码登录 + Chat 协议） |

---

## 1. 目标 / 非目标

**目标（v1）**
- 用户在 cursor-byok 里点「使用 GitHub 登录」→ 设备码授权 → 自动出现一个 Copilot 账号资源。
- 自动同步该账号可用的 Copilot 模型列表。
- Cursor 里选这些模型即可对话 / Agent / 工具调用，流式输出、思考、图片输入都正常。
- 计费正确：Agent 循环中的工具回合标记 `x-initiator: agent`，不重复消耗 premium request。
- 账号卡片显示 premium request 剩余百分比与重置时间。

**非目标（v1 不做）**
- GitHub Enterprise Server / ghe.com 数据驻留域名。
- Anthropic `/v1/messages` 原生协议（v2 做，见第 9 节）。
- WebSocket Responses 传输。
- 自动启用被策略禁用的模型（v2 可选，见第 9 节）。

---

## 2. 合规前提（必须读）

- 本规格使用 **VS Code Copilot Chat 的 OAuth Client ID `Iv1.b507a08c87ecfe98`** 并伪装 VS Code 请求头。这与 `copilot-api`（本仓库当前依赖）的默认行为相同，属于**非官方用法**，可能违反 GitHub 条款，存在账号风险。
- 实现时把 Client ID 与所有「伪装身份」常量集中放在 `constants.ts`，便于以后换成自有 OAuth App（需申请 GitHub Copilot Partner Program）。
- 不要使用 OpenCode 的 Client ID（`Ov23li8tweQw6odWQebz`）——那是冒充另一个已获官方合作的产品。
- 插件 README 必须写明上述风险声明。

---

## 3. 运行环境约束（cursor-byok 插件沙箱）

| 约束 | 影响 |
|---|---|
| Deno 启动参数 `--no-npm --no-remote --no-config --no-lock`，`--allow-read` 仅限插件目录，**无 `--allow-net`** | 不能 import npm/jsr/URL 包，不能用全局 `fetch`。只能 import 本地相对路径文件与 `cursor-byok:*` 别名 |
| 网络只能走 `context.network.fetch(url, {method, headers, body: string})`（缓冲，返回 `{status, headers, body: string}`）和 `context.network.stream(...)`（返回 `{status, headers, lines: AsyncIterable<string>}`） | 所有 HTTP 都要经它；body 只能是字符串 |
| 仅 HTTPS；主机必须**逐个精确**列在 `plugin.json` 的 `permissions.network`（不支持通配符、不能带端口/路径） | 见第 5 节主机清单 |
| 宿主禁用重定向；`fetch` 超时 60 s；单次调用总超时 10 min；响应体有大小上限 | 不依赖 3xx；模型列表等响应正常大小即可 |
| 插件**无持久状态**；资源（账号）由宿主存储，每次调用通过参数传入 `ResourceSnapshot` | Copilot token 缓存必须放进资源 `privateData`，通过 `ProviderResult.patch` 写回 |
| `ResourceSupport.refresh` **只在用户手动点刷新时调用** | Copilot token（约 30 min 过期）的自动续期必须在 `invoke` 内完成 |
| 可用 Web 标准 API：`crypto.randomUUID()`、`crypto.subtle`、`TextEncoder`、`URLSearchParams`、`btoa` | 生成设备 ID / 请求 ID 无需额外依赖 |

可 import 的 SDK 别名：`cursor-byok:plugin`、`cursor-byok:provider`、`cursor-byok:model`、`cursor-byok:resource`、`cursor-byok:protocol/openai-chat`、`cursor-byok:protocol/openai-responses`。**没有 Anthropic 协议帮助库。**

---

## 4. SDK 契约速查（摘自 `server/src/plugin/sdk/*.ts`）

```text
defineProviderPlugin({ providers: ProviderSupport[], resources?: ResourceSupport[] })   // 入口只能调用一次

ResourceSupport {
  type, displayName,
  add?: [OAuth2AddMethod{ type:"oauth2.0", id, displayName, begin(ctx)→OAuth2Begin, poll(session, ctx)→OAuth2Poll }],
  import?, present(resource)→ResourceView (同步), actions?,
  refresh?(resource, ctx)→ResourcePatch,  remove?
}
OAuth2Begin  { session: JsonValue, userCode, verificationUrl, verificationUrlComplete?, expiresAtMs, pollIntervalMs }
OAuth2Poll   = pending | slow-down | {completed, resources: ResourceDraft[]} | {denied, message?} | {failed, message}
             （宿主负责轮询循环、间隔、slow-down 退避、超时）
ResourceDraft    { key (去重键), privateData, state? }
ResourceSnapshot { id, type, key, privateData, state }
ResourceState    = ready | {cooling, retryAtMs?, message?} | {invalid, message?}
ResourcePatch    { privateData?, state? }
ResourceView     { displayName, description?, metrics?: [{id, label, unit:"percent"|"count", value, resetAtMs?}] }

ModelSupport.list({ resource }, ctx) → ModelDefinition[]   // 返回值整体替换模型目录
ModelDefinition { id, displayName, description?, maxOutputTokens?, capabilities?: {images?}, privateData? }

ProviderSupport { id, displayName, description?, providerType, resourceType?, models?, invoke(input, output, ctx) }
ProviderInvokeInput { model: ModelSnapshot(含 privateData), resource: ResourceSnapshot|null, request: LlmRequest }
LlmRequest { instructions, messages: LlmMessage[], tools, reasoning:{enabled, effort|null},
             latency:"fast"|"standard", maxOutputTokens|null, cacheKey|null }
LlmMessage = {role:"system"|"user", content: parts[]} | {role:"assistant", text, thinking, replayState, toolCalls}
           | {role:"tool", callId, name, content, isError, parts}
ProviderResult = {completed, patch?} | {resource-error, message, patch} | {request-error, message, patch?}

streamOpenAiChat({url, model, request, headers?, extraBody?}, output, ctx)
streamOpenAiResponses({url, model, request, headers?, extraBody?}, output, ctx)
  - 非 2xx：在发出任何事件之前抛 HttpError(status, body) → 此时重试是安全的
  - 流内错误：抛普通 Error（可能已发出部分事件 → 不可重试）
  - extraBody 最后浅合并进请求体
```

---

## 5. 目录结构与 plugin.json

开发位置：fork 内 `server/plugins/build-in/copilot-auth/`（debug 构建会直接扫描该源码目录，热改生效）。

```text
server/plugins/build-in/copilot-auth/
├── plugin.json          # 清单：id / 版本 / 入口 / 网络主机白名单
├── deno.json            # 仅供本地 deno check/test：把 cursor-byok:* 映射到 ../../../src/plugin/sdk/*（照抄 grok-auth/deno.json，加上 openai-responses）
├── main.ts              # defineProviderPlugin 组装                                   ≈20 行
├── constants.ts         # Client ID、URL、伪装版本号、请求头构造                         ≈80 行
├── oauth.ts             # 设备码 begin / poll                                          ≈110 行
├── token.ts             # GitHub token → Copilot token 交换与过期判断                  ≈80 行
├── resources.ts         # privateData 类型/校验、present、refresh（额度）               ≈150 行
├── models.ts            # GET /models → ModelDefinition[]（含路由信息）                 ≈120 行
├── provider.ts          # invoke：续期、选端点、请求头、x-initiator、重试、错误归类       ≈200 行
├── copilot_test.ts      # deno 单元测试（假 PluginContext，参照 grok_test.ts）
├── README.md            # 用法 + 风险声明
└── assets/copilot.svg   # 图标（manifest 必填，路径须存在）
```

`plugin.json`（`deny_unknown_fields`，不要加多余字段）：

```json
{
  "apiVersion": 1,
  "id": "dev.cursorbyok.community.copilot-auth",
  "name": "GitHub Copilot",
  "version": "0.1.0",
  "author": "@CharlesYWL",
  "minAppVersion": "0.1.0",
  "icon": "assets/copilot.svg",
  "entry": "main.ts",
  "permissions": {
    "network": [
      "github.com",
      "api.github.com",
      "api.githubcopilot.com",
      "api.individual.githubcopilot.com",
      "api.business.githubcopilot.com",
      "api.enterprise.githubcopilot.com"
    ]
  }
}
```

---

## 6. 常量（`constants.ts`）

值取自 `caozhiyuan/copilot-api` master 的 `src/lib/api-config.ts`（MIT），本仓库当前即依赖该项目。**集中定义，便于随上游更新。**

| 常量 | 值 |
|---|---|
| `CLIENT_ID` | `Iv1.b507a08c87ecfe98` |
| `SCOPE` | `read:user` |
| `DEVICE_CODE_URL` | `https://github.com/login/device/code` |
| `ACCESS_TOKEN_URL` | `https://github.com/login/oauth/access_token` |
| `COPILOT_TOKEN_URL` | `https://api.github.com/copilot_internal/v2/token` |
| `COPILOT_USER_URL` | `https://api.github.com/copilot_internal/user` |
| `DEFAULT_COPILOT_BASE` | `https://api.githubcopilot.com` |
| `COPILOT_CHAT_VERSION` | `0.68.0` |
| `VSCODE_VERSION` | `1.140.0` |
| `COPILOT_API_VERSION` | `2026-08-01`（`x-github-api-version`，Copilot API 用） |
| `GITHUB_API_VERSION` | `2025-04-01`（`x-github-api-version`，api.github.com 用） |

### 请求头三套

**A. GitHub OAuth（device code / access token）**

| 头 | 值 |
|---|---|
| `accept` | `application/json` |
| `content-type` | `application/json` |

**B. api.github.com（token 交换、额度查询）**

| 头 | 值 |
|---|---|
| `authorization` | 字符串 `token` + 空格 + GitHub token（注意前缀是 `token`，不是 `Bearer`） |
| `accept` | `application/json` |
| `user-agent` | `GitHubCopilotChat/{COPILOT_CHAT_VERSION}` |
| `x-github-api-version` | `{GITHUB_API_VERSION}` |
| `x-vscode-user-agent-library-version` | `electron-fetch` |

**C. Copilot API（/models、/chat/completions、/responses）**

| 头 | 值 | 备注 |
|---|---|---|
| `authorization` | 字符串 `Bearer` + 空格 + Copilot token | |
| `content-type` | `application/json` | /models 不带 |
| `copilot-integration-id` | `vscode-chat` | |
| `editor-version` | `vscode/{VSCODE_VERSION}` | |
| `editor-plugin-version` | `copilot-chat/{COPILOT_CHAT_VERSION}` | |
| `user-agent` | `GitHubCopilotChat/{COPILOT_CHAT_VERSION}` | |
| `editor-device-id` | `privateData.deviceId` | 登录时生成并持久化，同账号固定 |
| `x-github-api-version` | `{COPILOT_API_VERSION}` | |
| `x-vscode-user-agent-library-version` | `electron-fetch` | |
| `x-request-id` | 每次请求新的 `crypto.randomUUID()` | |
| `x-agent-task-id` | 同 `x-request-id` | |
| `openai-intent` | `conversation-agent` | /models 用 `model-access` |
| `x-interaction-type` | `conversation-agent` | /models 用 `model-access` |
| `x-interaction-id` | `request.cacheKey` | 有才带；/models 不带 |
| `x-initiator` | `user` 或 `agent` | 见 8.3；/models 不带 |
| `copilot-vision-request` | `true` | 请求含图片时才带 |

---

## 7. 账号资源

### 7.1 `privateData` 结构（`resources.ts` 负责解析与校验）

```ts
type AccountData = {
  githubToken: string;          // 设备码换来的 GitHub OAuth token（长期有效）
  deviceId: string;             // crypto.randomUUID()，登录时生成
  login: string;                // GitHub 用户名
  plan: string | null;          // copilot_plan，如 "individual" / "business"
  copilotToken: string | null;  // 短期 Copilot token 缓存
  copilotTokenExpiresAtMs: number | null;
  apiBase: string | null;       // token 交换返回的 endpoints.api，如 https://api.individual.githubcopilot.com
  quota: { percentRemaining: number; unlimited: boolean; resetAtMs: number | null } | null; // premium_interactions
};
```

- 资源类型 `RESOURCE_TYPE = "github-copilot-account"`；去重键 `key = login.toLowerCase()`。
- `accountData(resource)` 校验失败 → 由调用方返回 `invalid` 状态。

### 7.2 登录（`oauth.ts`）

**begin**
1. `POST DEVICE_CODE_URL`，头 A，body `JSON.stringify({ client_id, scope })`。
2. 非 2xx → 抛错（含状态码与响应体）。
3. 响应 `{ device_code, user_code, verification_uri, expires_in, interval }` →
   `{ session: { deviceCode }, userCode, verificationUrl: verification_uri, expiresAtMs: now + expires_in*1000, pollIntervalMs: (interval || 5) * 1000 }`。

**poll**
1. `POST ACCESS_TOKEN_URL`，头 A，body `JSON.stringify({ client_id, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })`。
2. ⚠️ **GitHub 在「待授权」时也返回 HTTP 200**，错误在 body 的 `error` 字段，所以先看 body 再看状态码：
   - `access_token` 存在 → 继续第 3 步
   - `error === "authorization_pending"` → `{ status: "pending" }`
   - `error === "slow_down"` → `{ status: "slow-down" }`
   - `error === "expired_token"` → `{ status: "failed", message: "设备码已过期，请重新登录" }`
   - `error === "access_denied"` → `{ status: "denied" }`
   - 其他 `error` → `{ status: "failed", message: error_description ?? error }`
   - 非 2xx 且 body 无法解析 → `{ status: "pending" }`（瞬时故障，交给宿主继续轮询，同 copilot-api 行为）
3. 拿到 `githubToken` 后立即：
   - `GET COPILOT_USER_URL`（头 B）→ 取 `login`、`copilot_plan`、`quota_snapshots.premium_interactions`。401/403/404 → `{ status: "failed", message: "该 GitHub 账号没有可用的 Copilot 订阅" }`。
   - 调一次 token 交换（7.3）验证可用，并把结果一起写入 `privateData`。
   - 返回 `{ status: "completed", resources: [{ key, privateData }] }`。

### 7.3 Copilot token 交换（`token.ts`）

- `GET COPILOT_TOKEN_URL`，头 B。
- 响应 `{ token, expires_at /* Unix 秒 */, refresh_in /* 秒 */, endpoints?: { api?, proxy?, telemetry? } }`。
- `apiBase = endpoints.api ?? DEFAULT_COPILOT_BASE`；**校验其主机在 plugin.json 白名单内**，不在则抛出带主机名的明确错误（提示需要更新插件白名单）。
- `isFresh(data) = copilotToken && copilotTokenExpiresAtMs - 5*60*1000 > Date.now()`。
- 错误：401 → GitHub token 失效（资源 `invalid`，提示重新登录）；403/404 → 无 Copilot 权限（`invalid`，带上游 message）；其他 → 普通错误。

### 7.4 present / refresh（`resources.ts`）

- `present(resource)`（同步，只读 privateData）：
  - `displayName = login`
  - `description = plan ? "Copilot " + plan : "GitHub Copilot"`
  - `metrics`：`quota` 存在且非 unlimited 时给一条 `{ id: "premium", label: {"zh-CN":"Premium 请求剩余","en-US":"Premium requests left"}, unit: "percent", value: percentRemaining, resetAtMs }`。
- `refresh(resource, ctx)`：重新 `GET COPILOT_USER_URL` 更新 `login/plan/quota`，并重新做一次 token 交换；成功返回 `{ privateData, state: { status: "ready" } }`；GitHub token 401 → `{ state: { status: "invalid", message: "GitHub 授权已失效，请重新登录" } }`。
- 额度字段：`quota_snapshots.premium_interactions.{ percent_remaining, unlimited }`，`quota_reset_date`（ISO 日期字符串 → `Date.parse`）。

---

## 8. 模型与调用

### 8.1 模型列表（`models.ts`）

1. 无 resource → 抛错「请先添加 GitHub Copilot 账号」。
2. 取 token：`isFresh` 则用缓存，否则现场交换（`list` 无法写回 patch，交换结果仅本次使用）。
3. `GET {apiBase}/models`，头 C（`openai-intent` 与 `x-interaction-type` 都是 `model-access`；不带 content-type、x-interaction-id、x-initiator）。
4. 响应 `{ data: Model[] }`，每项关键字段：
   ```
   id, name, vendor, preview, model_picker_enabled,
   policy?: { state },                        // "enabled" | "disabled" | "unconfigured"
   supported_endpoints?: string[],            // "/chat/completions" | "/responses" | "/v1/messages" ...
   capabilities: { type, family,
     limits: { max_context_window_tokens?, max_output_tokens?, max_prompt_tokens? },
     supports: { vision?, tool_calls?, streaming?, reasoning_effort?: string[] } }
   ```
5. 过滤：`capabilities.type === "chat"` 且 `model_picker_enabled === true` 且（`policy` 不存在或 `policy.state === "enabled"`）；按 `id` 去重。
6. 路由（存进 `privateData.route`）：
   - `supported_endpoints` 缺失 → `"chat"`（旧模型）
   - 含 `/responses` 且 vendor 不是 Anthropic → `"responses"`（GPT-5 系列，含仅支持 responses 的 codex 模型）
   - 否则含 `/chat/completions` → `"chat"`（v1 中 Claude / Gemini 走这里）
   - 否则（仅 `/v1/messages`）→ v1 跳过该模型，v2 改为 `"messages"`
7. 映射为 `ModelDefinition`：
   ```
   id, displayName: name,
   maxOutputTokens: limits.max_output_tokens,
   capabilities: { images: supports.vision === true },
   privateData: { route, vendor, reasoningEfforts: supports.reasoning_effort ?? [], contextWindow: limits.max_context_window_tokens ?? null }
   ```
8. 模型列表为空 → 抛错（不要返回空数组覆盖目录）。

### 8.2 invoke 主流程（`provider.ts`）

```text
invoke(input, output, ctx)
  ├─ 无 resource → request-error「请先添加账号」
  ├─ data = accountData(resource)       失败 → resource-error + invalid
  ├─ ensureToken(data)                  未过期用缓存；过期则交换，标记 dirty=true
  │     交换 401/403 → resource-error + invalid
  ├─ route = model.privateData.route
  ├─ attempt = 1..3:
  │     headers = 头C + x-initiator + vision
  │     route=="responses" → streamOpenAiResponses({url: apiBase+"/responses", ...})
  │     route=="chat"      → streamOpenAiChat({url: apiBase+"/chat/completions", ...})
  │     成功 → return { completed, patch: dirty ? { privateData: data } : undefined }
  │     HttpError（尚未发出事件，可安全重试）:
  │        401 且本轮未重新交换过 → 强制交换 token, dirty=true, continue
  │        可重试（见 8.5）且 attempt<3 → 等待 500ms*2^(attempt-1), continue
  │        其他 → 按 8.5 归类返回
  │     普通 Error（流内，可能已有输出）→ 不重试，按 8.5 归类返回
  └─ 所有返回分支都要带上 dirty 时的 { privateData: data } patch，避免下次重复交换
```

### 8.3 `x-initiator`（计费关键，务必有单测）

- `request.messages` 最后一条 `role === "user"` → `"user"`（消耗 premium request）
- 最后一条是 `"tool"` 或 `"assistant"` → `"agent"`（Agent 自动续跑回合，不额外计费）
- `messages` 为空 → `"user"`
- 来源：copilot-api `create-chat-completions.ts` / `create-messages.ts` 的同名逻辑（本仓库当前经由 copilot-api 获得同样的行为）。

### 8.4 请求体调整

调 SDK 帮助函数前对 `request` 做浅拷贝修改：

| 字段 | Chat 路由 | Responses 路由 | 原因 |
|---|---|---|---|
| `latency` | 强制 `"standard"` | 强制 `"standard"` | 否则帮助库会发 `service_tier`，Copilot 不支持（copilot-api 会删除该字段） |
| `reasoning.effort` | 仅当在 `privateData.reasoningEfforts` 里时保留，否则 `null` | 同左 | 不支持的模型会 400 |
| `maxOutputTokens` | 置 `null`，改用 `extraBody: { max_tokens: n }` | 原样（帮助库发 `max_output_tokens`） | Copilot chat 路径沿用 `max_tokens`（本仓库 `proxy-router.ts` 只在 Responses 路径转换为 `max_completion_tokens`）；**需实测确认** |
| `cacheKey` | 先置 `null`（不发 `prompt_cache_key`） | 原样 | Copilot chat 是否接受 `prompt_cache_key` 未验证；实测通过后再放开 |

- 图片检测：任一 user/system 消息 `content`，或 tool 消息 `parts` 中有 `type === "image"` → 加 `copilot-vision-request: true`。

### 8.5 错误归类与重试

| 情况 | 处理 |
|---|---|
| HttpError 408 / 425 / 429 / 5xx | 可重试（最多 3 次，指数退避 500ms 起） |
| HttpError 403 且 body 为空或仅 `forbidden`（不区分大小写，可带句号/感叹号） | 可重试 —— Copilot 边缘节点限流时会返回裸 403（见本仓库 `upstream-retry.ts`） |
| HttpError 403 且 body 有具体 message（模型策略未启用、无权限） | `request-error`，原样带上 message；**不要**把资源标为 invalid |
| HttpError 401（重新交换后仍 401） | `resource-error` + `invalid`「GitHub 授权已失效，请重新登录」 |
| 重试耗尽后仍为 429，且 body 含 `quota` / `premium` / `exceeded` | `resource-error` + `cooling`，`retryAtMs` = `quota.resetAtMs` ?? now+1h |
| 其他 HttpError | `request-error` |
| 流内 Error | `request-error`（不重试） |

---

## 9. v2 路线（v1 稳定后再做）

1. **Anthropic `/v1/messages` 原生协议**（Claude 的 extended thinking、prompt caching）：新增 `protocol/anthropic_messages.ts`，自行把 `LlmRequest` 转 Anthropic 请求体并解析 SSE（`message_start` / `content_block_start|delta|stop` / `message_delta` / `message_stop`）→ `ModelEvent`。URL `{apiBase}/v1/messages`，额外头 `anthropic-version: 2023-06-01`。x-initiator 规则：最后一条 user 消息里只有 `tool_result` 块时算 `agent`。参考 `earendil-works/pi` 的 `packages/ai/src/api/anthropic-messages.ts`（MIT）以及本仓库 `anthropic-transforms.ts`。
2. **自动启用模型策略**：对 `policy.state !== "enabled"` 的模型调用 `POST {apiBase}/models/{id}/policy`，body `{"state":"enabled"}`（参考 pi-ai `github-copilot.ts`）。需要用户确认，作为 `ResourceAction` 提供。
3. **从 copilot-api 导入现有 token**：`import` 支持读取 `~/.local/share/copilot-api/github_token`（纯文本），老用户免重新授权。
4. **GitHub Enterprise**：需要额外主机白名单，且 Enterprise 走 `copilot-api.<domain>`。

---

## 10. 测试

### 10.1 单元测试（`copilot_test.ts`，照 `grok-auth/grok_test.ts` 的假 `PluginContext` 写法）

必须覆盖：
- poll：200 + `authorization_pending` → pending；`slow_down` → slow-down；`access_denied` → denied；成功 → completed 且 privateData 字段齐全、key 为小写 login。
- token：`isFresh` 边界（剩 4 分钟视为过期）；`endpoints.api` 不在白名单 → 抛明确错误。
- models：过滤 picker/policy/type；路由判定（仅 responses、chat+responses 的 GPT、chat+messages 的 Claude、仅 messages 被跳过、缺 supported_endpoints）；空列表抛错。
- x-initiator：最后一条 user / tool / assistant / 空数组。
- 请求头：/models 不带 x-initiator 与 content-type；chat 带 `copilot-vision-request` 当且仅当有图片。
- invoke：token 过期 → 先交换并在 `completed` 的 patch 里写回；HttpError 401 → 重新交换后重试一次；裸 403 → 重试；带 message 的 403 → request-error 且资源不被标 invalid；`latency`/`service_tier` 不出现在请求体。

### 10.2 本地命令（在插件目录）

```bash
deno check main.ts
deno test --allow-read
deno fmt --check && deno lint
```

### 10.3 端到端手测清单

1. debug 构建运行 cursor-byok（源码目录插件热加载）→ 插件列表出现「GitHub Copilot」。
2. 添加账号 → 设备码页面授权 → 账号出现，显示 login、plan、premium 剩余百分比。
3. 同步模型 → 出现 GPT / Claude / Gemini 等，数量与 VS Code Copilot 模型选择器大致一致。
4. Cursor 里分别用一个 GPT-5 系列（responses 路由）和一个 Claude（chat 路由）模型：普通对话、带图片提问、Agent 多轮工具调用。
5. 在 github.com/settings/copilot 的用量页核对：一次 Agent 任务（多轮工具调用）只增加 1 次 premium request（乘以模型倍率）。
6. 等 30 分钟以上再发请求 → 正常（自动续期生效）。
7. 在 GitHub 设置里撤销授权 → 下一次请求账号变为 invalid，提示重新登录。

### 10.4 发布安装（非 debug 构建）

release 构建只扫描 `~/.cursor-byok-v3/plugins/installed/`。把整个 `copilot-auth/` 目录（不含测试与 deno.json 也可）拷贝进去后重启 cursor-byok。

---

## 11. 验收标准

- [ ] `deno check` / `deno test` / `deno fmt --check` / `deno lint` 全部通过
- [ ] 10.3 的 1–7 全部通过
- [ ] 插件不 import 任何 `cursor-byok:*` 以外的非本地模块，不使用全局 `fetch`
- [ ] 日志与 `present()` 输出中不出现 githubToken / copilotToken
- [ ] README 含风险声明与 Client ID 说明

---

## 12. 参考来源（均为 MIT，照抄代码时保留版权声明）

| 来源 | 用途 |
|---|---|
| `leookun/cursor-byok` `server/plugins/build-in/grok-auth/*` | 插件骨架、设备码登录、Chat 协议调用、测试写法 |
| `leookun/cursor-byok` `server/plugins/build-in/codex-auth/provider.ts` | Responses 协议调用、错误归类写法 |
| `caozhiyuan/copilot-api` `src/lib/api-config.ts`、`src/services/github/*`、`src/services/copilot/create-*.ts` | 常量、请求头、token 交换、x-initiator |
| `anomalyco/opencode` `packages/opencode/src/plugin/github-copilot/models.ts` | `/models` 解析与 `supported_endpoints` 路由 |
| `earendil-works/pi` `packages/ai/src/auth/oauth/github-copilot.ts` | token 交换 + 提前 5 分钟续期、策略启用 |
| 本仓库 `upstream-retry.ts` | 可重试错误判定（裸 403） |

---

## 13. 待实测确认的点

1. Copilot `/chat/completions` 对 `max_completion_tokens`、`prompt_cache_key` 的接受情况（决定 8.4 能否放宽）。
2. Copilot `/responses` 是否需要 `store: false`；`include: ["reasoning.encrypted_content"]` 是否被接受（SDK 帮助库默认发送）。
3. token 交换返回的 `endpoints.api` 在 Business / Enterprise 账号下的实际主机名是否都在白名单内。
4. cursor-byok 宿主是否会在 Cursor 的子代理 / 摘要请求中追加 user 消息（会导致 x-initiator 误判为 user，多耗额度）。
