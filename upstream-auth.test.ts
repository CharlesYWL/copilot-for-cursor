import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getGitHubTokenPath, hasGitHubToken } from './upstream-auth';

describe('GitHub token discovery', () => {
    test('matches copilot-api path conventions', () => {
        const homeDir = join('test', 'home');

        expect(getGitHubTokenPath({}, homeDir)).toBe(
            join(homeDir, '.local', 'share', 'copilot-api', 'github_token'),
        );
        expect(getGitHubTokenPath({
            COPILOT_API_HOME: join('custom', 'data'),
            COPILOT_API_OAUTH_APP: 'enterprise-app',
            COPILOT_API_ENTERPRISE_URL: 'https://github.example.com',
        }, homeDir)).toBe(
            join('custom', 'data', 'enterprise-app', 'ent_github_token'),
        );
    });

    test('requires a non-empty readable token', () => {
        const dir = join(tmpdir(), `copilot-for-cursor-${crypto.randomUUID()}`);
        const tokenPath = join(dir, 'github_token');
        mkdirSync(dir, { recursive: true });

        try {
            expect(hasGitHubToken(tokenPath)).toBe(false);
            writeFileSync(tokenPath, ' \n');
            expect(hasGitHubToken(tokenPath)).toBe(false);
            writeFileSync(tokenPath, 'github-token\n');
            expect(hasGitHubToken(tokenPath)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
