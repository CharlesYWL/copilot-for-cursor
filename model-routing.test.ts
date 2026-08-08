import { describe, expect, test } from 'bun:test';
import {
    buildAliasModelEntries,
    needsResponsesAPI,
    resolveAdvertisedModelId,
    resolveModelAlias,
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

    test('resolves configured model aliases to their upstream target', () => {
        const aliases = { opus5x: 'claude-opus-5' };
        expect(resolveModelAlias('opus5x', aliases)).toBe('claude-opus-5');
        expect(resolveModelAlias('claude-opus-5', aliases)).toBe('claude-opus-5');
        expect(resolveModelAlias('gpt-5.6-sol', aliases)).toBe('gpt-5.6-sol');
        expect(resolveModelAlias('opus5x', {})).toBe('opus5x');
    });

    test('composes aliases with Claude minor-version resolution', () => {
        const aliases = { bigopus: 'claude-opus-4-8' };
        expect(resolveUpstreamModelId(resolveModelAlias('bigopus', aliases))).toBe('claude-opus-4.8');
    });
});

describe('alias model listings', () => {
    const models = [
        { id: 'claude-opus-5', capabilities: { limits: { max_context_window_tokens: 1000000 } } },
        { id: 'claude-opus-4-8', capabilities: { limits: { max_context_window_tokens: 1000000 } } },
    ];

    test('copies the target model capabilities onto the alias entry', () => {
        const entries = buildAliasModelEntries(models, { opus5x: 'claude-opus-5' });
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('opus5x');
        expect(entries[0].display_name).toBe('opus5x');
        expect(entries[0].capabilities.limits.max_context_window_tokens).toBe(1000000);
    });

    test('matches targets written with either Claude minor-version spelling', () => {
        expect(buildAliasModelEntries(models, { bigopus: 'claude-opus-4.8' })[0].id).toBe('bigopus');
    });

    test('skips aliases whose target is not advertised upstream', () => {
        expect(buildAliasModelEntries(models, { ghost: 'no-such-model' })).toEqual([]);
    });
});
