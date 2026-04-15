import { getUpstreamAuthHeader } from './upstream-auth';

// ── Global config ─────────────────────────────────────────────────────────────
let maxModeEnabled = false;

export function enableMaxMode(): void {
    maxModeEnabled = true;
}

export function isMaxMode(): boolean {
    return maxModeEnabled;
}

// ── Model token limits cache ──────────────────────────────────────────────────
interface ModelLimits {
    maxInputTokens: number;
    maxOutputTokens: number;
}

const modelLimitsCache = new Map<string, ModelLimits>();

const DEFAULT_LIMITS: Record<string, ModelLimits> = {
    'claude': { maxInputTokens: 200000, maxOutputTokens: 8192 },
    'gpt-4': { maxInputTokens: 128000, maxOutputTokens: 16384 },
    'gpt-5': { maxInputTokens: 128000, maxOutputTokens: 16384 },
    'o1': { maxInputTokens: 200000, maxOutputTokens: 100000 },
    'o3': { maxInputTokens: 200000, maxOutputTokens: 100000 },
    'default': { maxInputTokens: 128000, maxOutputTokens: 8192 },
};

function getDefaultLimits(model: string): ModelLimits {
    const lower = model.toLowerCase();
    for (const [prefix, limits] of Object.entries(DEFAULT_LIMITS)) {
        if (prefix !== 'default' && lower.includes(prefix)) return limits;
    }
    return DEFAULT_LIMITS['default'];
}

export async function fetchAndCacheModelLimits(targetUrl: string): Promise<void> {
    try {
        const resp = await fetch(new URL('/v1/models', targetUrl).toString(), {
            headers: { 'Authorization': getUpstreamAuthHeader() },
            signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) return;
        const data = await resp.json() as any;
        if (!data.data || !Array.isArray(data.data)) return;

        for (const model of data.data) {
            const limits = model.capabilities?.limits;
            if (limits) {
                modelLimitsCache.set(model.id, {
                    maxInputTokens: limits.max_prompt_tokens || limits.max_input_tokens || getDefaultLimits(model.id).maxInputTokens,
                    maxOutputTokens: limits.max_output_tokens || getDefaultLimits(model.id).maxOutputTokens,
                });
            }
        }
        console.log(`📋 Max mode: cached token limits for ${modelLimitsCache.size} models`);
    } catch (e: any) {
        console.warn(`⚠️ Max mode: failed to fetch model limits: ${e?.message || e}`);
    }
}

export function getModelLimits(model: string): ModelLimits {
    return modelLimitsCache.get(model) || getDefaultLimits(model);
}

// ── Token estimation ──────────────────────────────────────────────────────────
// Simple char/4 heuristic — fast, zero-dependency, ~80% accurate for English.
// For mixed CJK content each character ≈ 1-2 tokens, so we use a blended ratio.

function estimateTokens(text: string): number {
    if (!text) return 0;
    // rough estimate: ascii chars / 4, non-ascii chars / 1.5
    let ascii = 0, nonAscii = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) < 128) ascii++;
        else nonAscii++;
    }
    return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

function estimateMessagesTokens(messages: any[]): number {
    let total = 0;
    for (const msg of messages) {
        // role overhead
        total += 4;
        if (typeof msg.content === 'string') {
            total += estimateTokens(msg.content);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text') total += estimateTokens(part.text || '');
                else total += estimateTokens(JSON.stringify(part));
            }
        }
        // tool calls overhead
        if (msg.tool_calls) {
            total += estimateTokens(JSON.stringify(msg.tool_calls));
        }
    }
    return total;
}

// ── Summarization prompt ──────────────────────────────────────────────────────
// Inspired by claude-code/opencode compaction prompts, adapted for proxy use.
const SUMMARIZATION_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and the assistant's previous actions.

Analyze each message chronologically and identify:
- The user's primary goals and requests
- Key technical concepts and decisions
- Files and code sections discussed or modified
- Problems encountered and solutions applied
- The current state of work in progress

Your summary MUST:
1. Preserve all file paths, function names, variable names, and code snippets mentioned
2. Retain exact error messages and their resolutions
3. Capture the user's original intent and any refinements
4. Note what has been completed vs what remains to be done
5. Include enough technical detail to continue the conversation seamlessly

Format as a structured summary, not a conversation replay. Be concise but do NOT omit any technical details that would be needed to continue the work.`;

// ── Compaction logic ──────────────────────────────────────────────────────────
// Threshold: compact when estimated input tokens exceed this fraction of model max
const COMPACT_THRESHOLD = 0.80;
// Keep the most recent N messages untouched to preserve immediate context
const KEEP_RECENT_MESSAGES = 10;
// Never compact if total messages are below this count
const MIN_MESSAGES_FOR_COMPACTION = 15;
// Max characters per individual message when building the summarization input
const MAX_MESSAGE_CHARS_FOR_SUMMARY = 8000;
// Acknowledgment message inserted after the summary to maintain conversation flow
const SUMMARY_ACKNOWLEDGMENT = 'Understood. I have the full context from the conversation summary. Let me continue.';

export async function compactIfNeeded(
    json: any,
    targetModel: string,
    targetUrl: string,
): Promise<any> {
    if (!maxModeEnabled) return json;
    if (!json.messages || !Array.isArray(json.messages) || json.messages.length < MIN_MESSAGES_FOR_COMPACTION) {
        return json;
    }

    const limits = getModelLimits(targetModel);
    const estimated = estimateMessagesTokens(json.messages);
    const threshold = Math.floor(limits.maxInputTokens * COMPACT_THRESHOLD);

    if (estimated <= threshold) {
        return json;
    }

    console.log(`🗜️ Max mode: estimated ${estimated} tokens exceeds ${COMPACT_THRESHOLD * 100}% of ${limits.maxInputTokens} — compacting`);

    // Split: system messages + old messages to summarize + recent messages to keep
    const systemMsgs = json.messages.filter((m: any) => m.role === 'system');
    const nonSystemMsgs = json.messages.filter((m: any) => m.role !== 'system');
    const keepCount = Math.min(KEEP_RECENT_MESSAGES, Math.floor(nonSystemMsgs.length / 2));
    const recentMsgs = nonSystemMsgs.slice(-keepCount);
    const oldMsgs = nonSystemMsgs.slice(0, -keepCount);

    if (oldMsgs.length < 3) return json; // nothing meaningful to compact

    try {
        const summary = await callSummarize(targetModel, oldMsgs, targetUrl);
        if (!summary) return json; // summarization failed, pass through

        console.log(`🗜️ Max mode: compacted ${oldMsgs.length} messages → 1 summary (${estimateTokens(summary)} est. tokens)`);

        // Rebuild messages: system + summary-as-user-message + recent
        json.messages = [
            ...systemMsgs,
            { role: 'user', content: `[Conversation Summary]\n${summary}` },
            { role: 'assistant', content: SUMMARY_ACKNOWLEDGMENT },
            ...recentMsgs,
        ];

        return json;
    } catch (e: any) {
        console.error(`❌ Max mode: compaction failed, passing through original:`, e?.message || e);
        return json;
    }
}

async function callSummarize(model: string, messages: any[], targetUrl: string): Promise<string | null> {
    // Build a summarization request to the same upstream using the same model
    const summarizeMessages = [
        { role: 'system', content: SUMMARIZATION_PROMPT },
        {
            role: 'user',
            content: 'Please summarize the following conversation:\n\n' +
                messages.map(m => {
                    const content = typeof m.content === 'string'
                        ? m.content
                        : Array.isArray(m.content)
                            ? m.content.map((p: any) => p.text || JSON.stringify(p)).join('\n')
                            : JSON.stringify(m.content);
                    const role = m.role || 'unknown';
                    const truncated = content.length > MAX_MESSAGE_CHARS_FOR_SUMMARY ? content.slice(0, MAX_MESSAGE_CHARS_FOR_SUMMARY) + '\n... [truncated]' : content;
                    return `[${role}]: ${truncated}`;
                }).join('\n\n'),
        },
    ];

    const body = JSON.stringify({
        model,
        messages: summarizeMessages,
        max_tokens: 4096,
        temperature: 0.2,
        stream: false,
    });

    const chatUrl = new URL('/v1/chat/completions', targetUrl);
    console.log(`🗜️ Max mode: sending summarization request (${messages.length} messages → ${model})`);

    const resp = await fetch(chatUrl.toString(), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': getUpstreamAuthHeader(),
        },
        body,
    });

    if (!resp.ok) {
        const errText = await resp.text();
        console.error(`❌ Max mode summarization failed (${resp.status}):`, errText.slice(0, 500));
        return null;
    }

    const data = await resp.json() as any;
    const content = data.choices?.[0]?.message?.content;

    if (content) {
        console.log(`🗜️ Max mode: summarization complete (${estimateTokens(content)} est. tokens)`);
    }

    return content || null;
}
