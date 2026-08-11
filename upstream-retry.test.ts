import { describe, expect, test } from 'bun:test';
import { fetchUpstreamWithRetry, isTransientUpstreamFailure } from './upstream-retry';

describe('transient upstream detection', () => {
    test('treats the contentless Copilot edge rejection as transient', () => {
        expect(isTransientUpstreamFailure(403, 'forbidden\n')).toBe(true);
        expect(isTransientUpstreamFailure(403, '{"error":{"message":"forbidden\\n","type":"error"}}')).toBe(true);
        expect(isTransientUpstreamFailure(403, '')).toBe(true);
    });

    test('keeps real permission failures fatal', () => {
        expect(isTransientUpstreamFailure(403, '{"error":{"message":"Model policy not accepted"}}')).toBe(false);
        expect(isTransientUpstreamFailure(403, 'Access to this model is not enabled for your org')).toBe(false);
        expect(isTransientUpstreamFailure(400, 'forbidden')).toBe(false);
        expect(isTransientUpstreamFailure(401, '')).toBe(false);
    });

    test('retries rate limits and gateway errors', () => {
        for (const status of [408, 425, 429, 500, 502, 503, 504]) {
            expect(isTransientUpstreamFailure(status, 'whatever')).toBe(true);
        }
        expect(isTransientUpstreamFailure(404, '')).toBe(false);
    });

    test('covers the whole 5xx range, including Cloudflare 52x codes', () => {
        for (const status of [505, 520, 521, 522, 524, 599]) {
            expect(isTransientUpstreamFailure(status, '')).toBe(true);
        }
        expect(isTransientUpstreamFailure(600, '')).toBe(false);
        expect(isTransientUpstreamFailure(499, '')).toBe(false);
    });
});

function stubResponses(statuses: Array<{ status: number; body: string }>) {
    let call = 0;
    const urls: string[] = [];
    const fetchImpl = (async (url: any) => {
        urls.push(String(url));
        const next = statuses[Math.min(call, statuses.length - 1)]!;
        call++;
        return new Response(next.body, { status: next.status });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls, calls: () => call };
}

describe('fetchUpstreamWithRetry', () => {
    const noSleep = async () => {};

    test('recovers from a transient edge rejection', async () => {
        const stub = stubResponses([
            { status: 403, body: 'forbidden\n' },
            { status: 200, body: '{"ok":true}' },
        ]);
        const result = await fetchUpstreamWithRetry('http://x/v1/chat/completions', { method: 'POST' }, {
            label: 'test', fetchImpl: stub.fetchImpl, sleep: noSleep, onRetry: () => {},
        });
        expect(result.response.status).toBe(200);
        expect(result.errorText).toBeNull();
        expect(result.attempts).toBe(2);
    });

    test('gives up after the attempt budget and preserves the error body', async () => {
        const stub = stubResponses([{ status: 429, body: 'slow down' }]);
        const result = await fetchUpstreamWithRetry('http://x', { method: 'POST' }, {
            label: 'test', fetchImpl: stub.fetchImpl, sleep: noSleep, maxAttempts: 3, onRetry: () => {},
        });
        expect(result.response.status).toBe(429);
        expect(result.errorText).toBe('slow down');
        expect(result.attempts).toBe(3);
        expect(stub.calls()).toBe(3);
    });

    test('does not retry fatal errors', async () => {
        const stub = stubResponses([{ status: 400, body: '{"error":{"message":"bad request"}}' }]);
        const result = await fetchUpstreamWithRetry('http://x', { method: 'POST' }, {
            label: 'test', fetchImpl: stub.fetchImpl, sleep: noSleep, onRetry: () => {},
        });
        expect(result.attempts).toBe(1);
        expect(stub.calls()).toBe(1);
        expect(result.errorText).toContain('bad request');
    });

    test('backs off exponentially between attempts', async () => {
        const stub = stubResponses([{ status: 503, body: '' }]);
        const delays: number[] = [];
        await fetchUpstreamWithRetry('http://x', { method: 'POST' }, {
            label: 'test',
            fetchImpl: stub.fetchImpl,
            sleep: async (ms) => { delays.push(ms); },
            baseDelayMs: 500,
            maxAttempts: 3,
            onRetry: () => {},
        });
        expect(delays).toEqual([500, 1000]);
    });

    test('retries a dropped connection and reports it as a transport failure', async () => {
        let call = 0;
        const seen: Array<{ status: number; body: string }> = [];
        const fetchImpl = (async () => {
            call++;
            if (call === 1) throw new Error('fetch failed: ECONNRESET');
            return new Response('{"ok":true}', { status: 200 });
        }) as unknown as typeof fetch;

        const result = await fetchUpstreamWithRetry('http://x', { method: 'POST' }, {
            label: 'test',
            fetchImpl,
            sleep: noSleep,
            onRetry: ({ status, body }) => seen.push({ status, body }),
        });

        expect(result.response.status).toBe(200);
        expect(result.attempts).toBe(2);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.status).toBe(0);
        expect(seen[0]!.body).toContain('ECONNRESET');
    });

    test('rethrows the transport error once the budget is exhausted', async () => {
        let call = 0;
        const fetchImpl = (async () => {
            call++;
            throw new Error('socket hang up');
        }) as unknown as typeof fetch;

        let caught: Error | null = null;
        try {
            await fetchUpstreamWithRetry('http://x', { method: 'POST' }, {
                label: 'test', fetchImpl, sleep: noSleep, maxAttempts: 3, onRetry: () => {},
            });
        } catch (error: any) {
            caught = error;
        }

        expect(caught).not.toBeNull();
        expect(caught!.message).toBe('socket hang up');
        expect(call).toBe(3);
    });
});
