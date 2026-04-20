#!/usr/bin/env bun
/**
 * One-command startup: launches copilot-api (port 4141) + proxy-router (port 4142)
 * Usage: bun run start.ts
 */

import { spawn, sleep } from 'bun';
import { existsSync } from 'fs';
import { getUpstreamAuthHeader } from './upstream-auth';
import { enableMaxMode, isMaxMode, fetchAndCacheModelLimits } from './max-mode';
import { stopTunnel } from './tunnel';

// ── Parse CLI flags ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--max')) {
    enableMaxMode();
}

const COPILOT_API_PORT = 4141;
const PROXY_PORT = 4142;

// Colors for distinguishing output
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

async function isPortInUse(port: number): Promise<boolean> {
    try {
        await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2000) });
        return true;
    } catch {
        return false;
    }
}

async function waitForPort(
    port: number,
    opts: { timeoutMs?: number; isAuthPending?: () => boolean } = {},
): Promise<boolean> {
    const { timeoutMs = 30000, isAuthPending } = opts;
    // If the copilot-api prints a device-code prompt, it can take a while for
    // the user to complete GitHub auth. Once that happens, stay on the extended
    // deadline for the remainder of startup — even after the login line appears
    // the server still needs a moment to bind the port.
    const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
    const start = Date.now();
    let useExtendedDeadline = false;
    while (true) {
        if (isAuthPending?.()) useExtendedDeadline = true;
        const deadline = useExtendedDeadline ? AUTH_TIMEOUT_MS : timeoutMs;
        if (Date.now() - start >= deadline) return false;
        try {
            const resp = await fetch(`http://localhost:${port}/v1/models`, {
                headers: { 'Authorization': getUpstreamAuthHeader() },
            });
            if (resp.ok) return true;
        } catch {}
        await sleep(500);
    }
}

const openInBrowser = (url: string): void => {
    try {
        const platform = process.platform;
        if (platform === 'win32') {
            spawn(['cmd', '/c', 'start', '""', url], { stdout: 'ignore', stderr: 'ignore' });
        } else if (platform === 'darwin') {
            spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' });
        } else {
            spawn(['xdg-open', url], { stdout: 'ignore', stderr: 'ignore' });
        }
    } catch {
        // Best-effort; user can open URL manually if this fails.
    }
};

async function main() {
    console.log(`${CYAN}🚀 Starting Copilot Proxy Stack...${RESET}\n`);

    // 1. Check if copilot-api is already running
    const copilotAlreadyRunning = await isPortInUse(COPILOT_API_PORT);
    let copilotProc: ReturnType<typeof spawn> | null = null;

    if (copilotAlreadyRunning) {
        console.log(`${GREEN}✅ copilot-api already running on port ${COPILOT_API_PORT}${RESET}`);
    } else {
        console.log(`${YELLOW}⏳ Starting copilot-api on port ${COPILOT_API_PORT}...${RESET}`);

        // Detect npx path
        const isWindows = process.platform === 'win32';
        const npxCmd = isWindows ? 'npx.cmd' : 'npx';

        copilotProc = spawn([npxCmd, '@jeffreycao/copilot-api@latest', 'start'], {
            stdout: 'pipe',
            stderr: 'pipe',
        });

        // Track whether copilot-api is waiting on GitHub device-code auth; while
        // true, we extend the startup timeout so the user has time to complete it.
        let awaitingDeviceAuth = false;
        let browserOpened = false;
        const DEVICE_CODE_REGEX = /enter the code\s+"?([A-Z0-9-]+)"?\s+in\s+(https?:\/\/\S+)/i;

        const handleCopilotLine = (line: string): void => {
            console.log(`${RED}[copilot-api]${RESET} ${line}`);
            const match = line.match(DEVICE_CODE_REGEX);
            if (match) {
                awaitingDeviceAuth = true;
                const [, code, url] = match;
                console.log(
                    `\n${YELLOW}🔐 First-time GitHub auth required.${RESET}\n` +
                    `${YELLOW}   Opening ${url} — paste code: ${GREEN}${code}${RESET}\n` +
                    `${YELLOW}   (waiting up to 10 minutes for you to finish)${RESET}\n`
                );
                if (!browserOpened) {
                    browserOpened = true;
                    openInBrowser(url);
                }
            }
        };

        const pipeStream = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                for (const line of text.split('\n').filter(Boolean)) {
                    handleCopilotLine(line);
                }
            }
        };

        void pipeStream(copilotProc!.stdout as ReadableStream<Uint8Array>);
        void pipeStream(copilotProc!.stderr as ReadableStream<Uint8Array>);

        // Wait for copilot-api to be ready
        console.log(`${YELLOW}⏳ Waiting for copilot-api to be ready...${RESET}`);
        const ready = await waitForPort(COPILOT_API_PORT, {
            timeoutMs: 30000,
            isAuthPending: () => awaitingDeviceAuth,
        });
        if (!ready) {
            console.error(
                `${RED}❌ copilot-api failed to start.${RESET}\n` +
                `${YELLOW}   If this is your first run, try authenticating separately:${RESET}\n` +
                `${YELLOW}     npx @jeffreycao/copilot-api@latest auth${RESET}\n` +
                `${YELLOW}   Then re-run this command.${RESET}`
            );
            copilotProc.kill();
            process.exit(1);
        }
        console.log(`${GREEN}✅ copilot-api is ready on port ${COPILOT_API_PORT}${RESET}`);
    }

    // 1.5 Pre-fetch and cache model token limits (used by both --max soft compaction
    // and the always-on hard-threshold safety net).
    if (isMaxMode()) {
        console.log(`${CYAN}🔥 Max mode enabled — will auto-compact long conversations at 80%${RESET}`);
    } else {
        console.log(`${CYAN}🛡️  Safety-net compaction enabled (auto-compact at 95% of model limit)${RESET}`);
    }
    await fetchAndCacheModelLimits(`http://localhost:${COPILOT_API_PORT}`);

    // 2. Check if proxy is already running
    const proxyAlreadyRunning = await isPortInUse(PROXY_PORT);
    if (proxyAlreadyRunning) {
        console.log(`${GREEN}✅ proxy-router already running on port ${PROXY_PORT}${RESET}`);
        console.log(`\n${CYAN}🎉 Everything is running! Configure Cursor to use: http://localhost:${PROXY_PORT}/v1${RESET}`);
        // Keep alive if we started copilot-api
        if (copilotProc) await copilotProc.exited;
        return;
    }

    // 3. Start proxy-router in the same process
    console.log(`${YELLOW}⏳ Starting proxy-router on port ${PROXY_PORT}...${RESET}`);
    await import('./proxy-router');

    console.log(`\n${CYAN}🎉 All services running!${RESET}`);
    console.log(`${CYAN}   copilot-api:   http://localhost:${COPILOT_API_PORT}${RESET}`);
    console.log(`${CYAN}   proxy-router:  http://localhost:${PROXY_PORT}${RESET}`);
    console.log(`${CYAN}   dashboard:     http://localhost:${PROXY_PORT}/${RESET}`);
    console.log(`${CYAN}   Cursor config: http://localhost:${PROXY_PORT}/v1${RESET}`);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log(`\n${YELLOW}🛑 Shutting down...${RESET}`);
        try { await stopTunnel(); } catch {}
        if (copilotProc) copilotProc.kill();
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        try { await stopTunnel(); } catch {}
        if (copilotProc) copilotProc.kill();
        process.exit(0);
    });

    // Keep alive
    if (copilotProc) await copilotProc.exited;
}

main().catch(err => {
    console.error(`${RED}❌ Fatal error:${RESET}`, err);
    process.exit(1);
});
