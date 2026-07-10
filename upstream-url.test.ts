import { describe, expect, test } from 'bun:test';
import { buildUpstreamUrl } from './upstream-url';

describe('upstream URL construction', () => {
    test('preserves the configured upstream origin', () => {
        const target = buildUpstreamUrl(
            new URL('https://public.example/v1/models?limit=10'),
            'http://localhost:4141',
        );

        expect(target.toString()).toBe('http://localhost:4141/v1/models?limit=10');
    });

    test('keeps scheme-relative request paths on the configured upstream', () => {
        const target = buildUpstreamUrl(
            new URL('https://public.example//attacker.example/steal'),
            'http://localhost:4141',
        );

        expect(target.origin).toBe('http://localhost:4141');
        expect(target.pathname).toBe('//attacker.example/steal');
    });
});
