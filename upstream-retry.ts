// GitHub's Copilot edge occasionally sheds load with a bare `403 forbidden`
// (plain text, no model error) alongside the usual 429/5xx gateway hiccups.
// Forwarding those verbatim kills an entire Cursor turn, so upstream model
// calls retry them a couple of times with exponential backoff instead.

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const BARE_FORBIDDEN = /^forbidden[.!]?$/i;

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 500;

function extractErrorMessage(body: string): string {
    const trimmed = body.trim();
    if (!trimmed) return '';
    try {
        const parsed = JSON.parse(trimmed);
        const message = parsed?.error?.message ?? parsed?.message;
        if (typeof message === 'string') return message.trim();
    } catch { /* upstream returned plain text */ }
    return trimmed;
}

export function isTransientUpstreamFailure(status: number, body: string): boolean {
    if (RETRYABLE_STATUSES.has(status)) return true;
    // Real permission problems (disabled model policy, unentitled seat, blocked
    // org) always carry a descriptive message, so only the contentless edge
    // rejection is treated as retryable.
    if (status === 403) {
        const message = extractErrorMessage(body);
        return message === '' || BARE_FORBIDDEN.test(message);
    }
    return false;
}

export interface UpstreamResult {
    response: Response;
    /** Body text of a failed response; null when the response succeeded. */
    errorText: string | null;
    attempts: number;
}

export interface RetryOptions {
    label: string;
    maxAttempts?: number;
    baseDelayMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: { status: number; attempt: number; delayMs: number; body: string }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function fetchUpstreamWithRetry(
    url: string,
    init: RequestInit,
    options: RetryOptions,
): Promise<UpstreamResult> {
    const {
        label,
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        baseDelayMs = DEFAULT_BASE_DELAY_MS,
        fetchImpl = fetch,
        sleep = defaultSleep,
        onRetry,
    } = options;

    for (let attempt = 1; ; attempt++) {
        const response = await fetchImpl(url, init);
        if (response.ok) return { response, errorText: null, attempts: attempt };

        const errorText = await response.text();
        if (attempt >= maxAttempts || !isTransientUpstreamFailure(response.status, errorText)) {
            return { response, errorText, attempts: attempt };
        }

        const delayMs = baseDelayMs * 2 ** (attempt - 1);
        const notify = onRetry ?? (({ status, attempt: n, delayMs: ms }) => {
            console.warn(`♻️  ${label}: transient upstream ${status}, retrying in ${ms}ms (attempt ${n + 1}/${maxAttempts})`);
        });
        notify({ status: response.status, attempt, delayMs, body: errorText });
        await sleep(delayMs);
    }
}
