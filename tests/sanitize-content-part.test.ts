import { describe, expect, test } from 'bun:test';
import { sanitizeContentPart } from '../anthropic-transforms';

describe('sanitizeContentPart', () => {
    test('passes through text parts', () => {
        const out = sanitizeContentPart({ type: 'text', text: 'hello' }, false);
        expect(out).toEqual({ type: 'text', text: 'hello' });
    });

    test('replaces images with placeholder on Claude', () => {
        const out = sanitizeContentPart(
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
            true,
        );
        expect(out).toEqual({ type: 'text', text: '[Image Omitted]' });
    });

    test('converts base64 image to image_url on non-Claude', () => {
        const out = sanitizeContentPart(
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
            false,
        );
        expect(out).toEqual({
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAA' },
        });
    });

    test('preserves non-image unknown part types as lossy text (regression)', () => {
        // Regression: non-image base64 sources (e.g. document/PDF) were first
        // misclassified as images and replaced with `[Image Omitted]`, then
        // after that narrowing fix were silently dropped by returning null.
        // They must now survive normalization as a text fallback with the
        // base64 blob stripped to avoid token bloat.
        const pdfPart = {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'AQIDBAUG' },
        };
        const out: any = sanitizeContentPart(pdfPart, false);
        expect(out).not.toBeNull();
        expect(out.type).toBe('text');
        expect(typeof out.text).toBe('string');
        expect(out.text).not.toContain('AQIDBAUG');
        expect(out.text).toContain('document');
        expect(out.text).toContain('application/pdf');
    });

    test('preserves unknown part types with no source', () => {
        const out: any = sanitizeContentPart({ type: 'future_thing', foo: 'bar' }, false);
        expect(out).not.toBeNull();
        expect(out.type).toBe('text');
        expect(out.text).toContain('future_thing');
        expect(out.text).toContain('bar');
    });
});
