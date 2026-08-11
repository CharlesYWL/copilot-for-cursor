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
});
