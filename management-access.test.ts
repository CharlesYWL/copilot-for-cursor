import { describe, expect, test } from 'bun:test';
import { isTrustedManagementRequest } from './management-access';

describe('management API access', () => {
    test('allows direct loopback requests', () => {
        expect(isTrustedManagementRequest(new Request('http://localhost:4142/api/settings'))).toBe(true);
        expect(isTrustedManagementRequest(new Request('http://127.0.0.1:4142/api/settings'))).toBe(true);
        expect(isTrustedManagementRequest(new Request('http://[::1]:4142/api/settings'))).toBe(true);
    });

    test('allows same-machine dashboard requests', () => {
        const request = new Request('http://localhost:4142/api/settings', {
            headers: { Origin: 'http://localhost:4142' },
        });
        expect(isTrustedManagementRequest(request)).toBe(true);
    });

    test('rejects management requests through a public tunnel', () => {
        const request = new Request('https://proxy.example.com/api/settings');
        expect(isTrustedManagementRequest(request)).toBe(false);
    });

    test('rejects cross-origin browser requests to loopback', () => {
        const request = new Request('http://localhost:4142/api/settings', {
            headers: { Origin: 'https://attacker.example' },
        });
        expect(isTrustedManagementRequest(request)).toBe(false);
    });
});
