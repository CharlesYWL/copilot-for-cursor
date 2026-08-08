import { createHash } from 'node:crypto';

const MAX_TOOL_CALL_ID_LENGTH = 64;
const INVALID_TOOL_CALL_ID_CHARS = /[^a-zA-Z0-9_-]/g;

export function normalizeToolCallId(value: unknown): string {
    if (typeof value !== 'string' || !value) {
        throw new Error('Tool call is missing a valid id');
    }

    const sanitized = value.replace(INVALID_TOOL_CALL_ID_CHARS, '_');
    if (sanitized === value && value.length <= MAX_TOOL_CALL_ID_LENGTH) {
        return value;
    }

    const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
    const prefixLength = MAX_TOOL_CALL_ID_LENGTH - digest.length - 1;
    return `${sanitized.slice(0, prefixLength)}_${digest}`;
}
