// GitHub's Copilot edge occasionally sheds load with a bare `403 forbidden`
// (plain text, no model error) alongside the usual 429/5xx gateway hiccups and
// outright dropped connections. Forwarding those verbatim kills an entire
// Cursor turn, so upstream model calls retry them a couple of times with
// exponential backoff instead.

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

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
    // Any server-side failure is worth another attempt, including the
    // Cloudflare-specific 52x codes a tunnelled setup can surface.
    if (status >= 500 && status < 600) return true;
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
    /** `status` is 0 when the attempt failed at the transport layer. */
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

    const notify = onRetry ?? (({ status, attempt, delayMs }) => {
        const reason = status === 0 ? 'transport failure' : `upstream ${status}`;
        console.warn(`♻️  ${label}: transient ${reason}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
    });
    const backoffFor = (attempt: number) => baseDelayMs * 2 ** (attempt - 1);

    for (let attempt = 1; ; attempt++) {
        let response: Response;
        try {
            response = await fetchImpl(url, init);
        } catch (error: any) {
            // Connection resets, DNS blips and socket timeouts reject instead of
            // resolving, and are exactly the kind of drop a retry should absorb.
            if (attempt >= maxAttempts) throw error;
            const delayMs = backoffFor(attempt);
            notify({ status: 0, attempt, delayMs, body: String(error?.message ?? error) });
            await sleep(delayMs);
            continue;
        }

        if (response.ok) return { response, errorText: null, attempts: attempt };

        const errorText = await response.text();
        if (attempt >= maxAttempts || !isTransientUpstreamFailure(response.status, errorText)) {
            return { response, errorText, attempts: attempt };
        }

        const delayMs = backoffFor(attempt);
        notify({ status: response.status, attempt, delayMs, body: errorText });
        await sleep(delayMs);
    }
}
