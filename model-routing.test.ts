import { describe, expect, test } from 'bun:test';
import {
    needsResponsesAPI,
    resolveAdvertisedModelId,
    resolveUpstreamModelId,
} from './model-routing';

describe('model routing', () => {
    test('routes newer GPT models through the Responses API', () => {
        expect(needsResponsesAPI('gpt-5.6-sol')).toBe(true);
        expect(needsResponsesAPI('claude-opus-4.8')).toBe(false);
    });

    test('converts Cursor-safe Claude aliases to upstream dotted IDs', () => {
        expect(resolveUpstreamModelId('claude-opus-4-8')).toBe('claude-opus-4.8');
        expect(resolveUpstreamModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4.6');
        expect(resolveUpstreamModelId('claude-haiku-4-5')).toBe('claude-haiku-4.5');
    });

    test('leaves models without a minor Claude version unchanged', () => {
        expect(resolveUpstreamModelId('claude-sonnet-5')).toBe('claude-sonnet-5');
        expect(resolveUpstreamModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol');
        expect(resolveUpstreamModelId('claude-opus-4-20250514')).toBe('claude-opus-4-20250514');
    });

    test('maps dotted Claude IDs back to model-list aliases', () => {
        expect(resolveAdvertisedModelId('claude-opus-4.8')).toBe('claude-opus-4-8');
    });
});
