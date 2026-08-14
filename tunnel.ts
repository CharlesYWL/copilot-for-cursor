import { spawn, type Subprocess } from 'bun';
import { existsSync, mkdirSync, chmodSync, createWriteStream, renameSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { isFixedUrlConfig } from './settings-config';

export type TunnelProvider = 'cloudflared' | 'ngrok' | 'bore' | 'tailscale';
export type TunnelStatus = 'idle' | 'starting' | 'running' | 'error' | 'stopped';

export interface TunnelOptions {
    /** 'quick' = throwaway *.trycloudflare.com, 'named' = your own stable hostname. */
    cloudflaredMode?: 'quick' | 'named';
    /** Remote-managed named tunnel token, copied from the Zero Trust dashboard. */
    cloudflaredToken?: string;
    /** Locally-managed named tunnel, created via `cloudflared tunnel create <name>`. */
    cloudflaredName?: string;
    /** Public hostname the named tunnel is routed to — cloudflared never prints it. */
    cloudflaredHostname?: string;

    /** ngrok authtoken. Optional when already set via `ngrok config add-authtoken`. */
    authtoken?: string;
    /** Reserved static domain, e.g. `foo-bar.ngrok-free.dev`. The free plan includes one. */
    ngrokDomain?: string;

    /** Requested remote port on bore.pub. Best effort — fails if already taken. */
    borePort?: number;

    /** Tailscale Funnel public port. Only 443, 8443 and 10000 are allowed. */
    tailscalePort?: number;
}

export interface TunnelState {
    provider: TunnelProvider | null;
    status: TunnelStatus;
    url: string | null;
    error: string | null;
    startedAt: number | null;
    /** True when this URL survives restarts (named tunnel / static domain / funnel). */
    fixed: boolean;
    /** How many times auto-reconnect has relaunched the provider. */
    restarts: number;
}

const PROXY_PORT = 4142;
const BIN_DIR = join(homedir(), '.copilot-proxy', 'bin');
const MAX_BACKOFF_MS = 30_000;

let state: TunnelState = {
    provider: null,
    status: 'idle',
    url: null,
    error: null,
    startedAt: null,
    fixed: false,
    restarts: 0,
};

let currentProc: Subprocess | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let activeProvider: TunnelProvider | null = null;
let activeOptions: TunnelOptions = {};
let autoReconnect = true;
let restartAttempt = 0;
/** Bumped on every launch and stop so stale process callbacks can be ignored. */
let runId = 0;
let recentLines: string[] = [];

const subscribers = new Set<(s: TunnelState) => void>();

const notify = () => {
    const snapshot = { ...state };
    for (const cb of subscribers) {
        try {
            cb(snapshot);
        } catch {}
    }
};

const setState = (patch: Partial<TunnelState>) => {
    state = { ...state, ...patch };
    notify();
};

export const getTunnelState = (): TunnelState => ({ ...state });

export const subscribeTunnel = (cb: (s: TunnelState) => void): (() => void) => {
    subscribers.add(cb);
    cb({ ...state });
    return () => {
        subscribers.delete(cb);
    };
};

export const getCloudflaredAssetName = (
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): string | null => {
    if (platform === 'win32') {
        // Cloudflare does not publish a native Windows ARM64 build; the amd64
        // binary runs fine under Windows-on-ARM x64 emulation.
        if (arch === 'ia32') return 'cloudflared-windows-386.exe';
        return 'cloudflared-windows-amd64.exe';
    }
    if (platform === 'linux') {
        const archMap: Record<string, string> = {
            x64: 'amd64',
            arm64: 'arm64',
            arm: 'arm',
            ia32: '386',
        };
        return `cloudflared-linux-${archMap[arch] ?? 'amd64'}`;
    }
    if (platform === 'darwin') {
        return `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
    }
    return null;
};

// GitHub's CDN occasionally returns 404 when no User-Agent header is present,
// and multi-hop redirects through the `/latest/download/...` URL can fail on
// some networks. Sending a UA and having an API-based fallback makes the
// download far more reliable.
const DOWNLOAD_HEADERS: Record<string, string> = {
    'User-Agent': 'copilot-for-cursor/1.0 (+https://github.com/jeffrey-cao/copilot-for-cursor)',
    Accept: 'application/octet-stream',
};

const downloadToFile = async (url: string, destPath: string): Promise<void> => {
    const resp = await fetch(url, { redirect: 'follow', headers: DOWNLOAD_HEADERS });
    if (!resp.ok || !resp.body) {
        const bodySnippet = await resp.text().catch(() => '').then(t => t.slice(0, 200));
        throw new Error(
            `HTTP ${resp.status} ${resp.statusText} from ${url}${bodySnippet ? ` — ${bodySnippet}` : ''}`
        );
    }
    const fileStream = createWriteStream(destPath);
    await pipeline(resp.body as unknown as NodeJS.ReadableStream, fileStream);
};

const resolveAssetUrlViaApi = async (assetName: string): Promise<string> => {
    const apiUrl = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
    const resp = await fetch(apiUrl, {
        redirect: 'follow',
        headers: {
            ...DOWNLOAD_HEADERS,
            Accept: 'application/vnd.github+json',
        },
    });
    if (!resp.ok) {
        throw new Error(`GitHub API returned ${resp.status} ${resp.statusText} for ${apiUrl}`);
    }
    const release = (await resp.json()) as { assets?: Array<{ name: string; browser_download_url: string }> };
    const asset = release.assets?.find(a => a.name === assetName);
    if (!asset) {
        throw new Error(`Asset ${assetName} not found in latest cloudflared release`);
    }
    return asset.browser_download_url;
};

const extractArchive = async (
    archivePath: string,
    destPath: string,
    binaryName: string,
    assetName: string,
): Promise<void> => {
    const extractDir = `${destPath}.extracting`;
    try {
        rmSync(extractDir, { recursive: true, force: true });
        mkdirSync(extractDir, { recursive: true });

        const command = assetName.endsWith('.zip')
            ? ['unzip', '-q', '-o', archivePath, '-d', extractDir]
            : ['tar', '-xzf', archivePath, '-C', extractDir];
        const extractProc = spawn(command, { stdout: 'ignore', stderr: 'pipe' });
        const stderrPromise = new Response(extractProc.stderr).text();
        const exitCode = await extractProc.exited;
        const stderr = (await stderrPromise).trim();
        if (exitCode !== 0) {
            throw new Error(`${command[0]} exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`);
        }

        const extractedBinary = join(extractDir, binaryName);
        if (!existsSync(extractedBinary)) {
            throw new Error(`Archive ${assetName} did not contain ${binaryName}`);
        }
        renameSync(extractedBinary, destPath);
    } catch (err: any) {
        throw new Error(`Failed to extract ${assetName}: ${err?.message ?? err}`);
    } finally {
        rmSync(archivePath, { force: true });
        rmSync(extractDir, { recursive: true, force: true });
    }
};

const ensureCloudflaredBinary = async (): Promise<string> => {
    if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });

    const filename = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const localPath = join(BIN_DIR, filename);
    if (existsSync(localPath)) return localPath;

    const assetName = getCloudflaredAssetName();
    if (!assetName) {
        throw new Error(
            `Automatic download not supported on ${process.platform}. Install cloudflared manually (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and ensure it's on PATH.`
        );
    }

    const tmpPath = `${localPath}.downloading`;
    if (existsSync(tmpPath)) {
        try { rmSync(tmpPath); } catch {}
    }

    const primaryUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`;
    const errors: string[] = [];

    try {
        await downloadToFile(primaryUrl, tmpPath);
    } catch (err: any) {
        errors.push(`direct: ${err?.message ?? err}`);
        // Fallback: resolve the exact versioned asset URL via the API and retry.
        try {
            const apiUrl = await resolveAssetUrlViaApi(assetName);
            await downloadToFile(apiUrl, tmpPath);
        } catch (err2: any) {
            errors.push(`api: ${err2?.message ?? err2}`);
            try { rmSync(tmpPath); } catch {}
            throw new Error(
                `Failed to download cloudflared after 2 attempts. ${errors.join(' | ')}. ` +
                `You can install cloudflared manually from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ ` +
                `and place the binary at ${localPath}.`
            );
        }
    }

    if (assetName.endsWith('.tgz')) {
        await extractArchive(tmpPath, localPath, filename, assetName);
    } else {
        renameSync(tmpPath, localPath);
    }

    if (process.platform !== 'win32') {
        try {
            chmodSync(localPath, 0o755);
        } catch {}
    }
    return localPath;
};

const killProc = async (proc: Subprocess): Promise<void> => {
    try {
        proc.kill();
    } catch {}
    try {
        await Promise.race([proc.exited, new Promise(r => setTimeout(r, 3000))]);
    } catch {}
};

const streamLines = async (
    readable: ReadableStream<Uint8Array> | null,
    onLine: (line: string) => void
): Promise<void> => {
    if (!readable) return;
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split(/\r?\n/);
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim()) onLine(line);
            }
        }
        if (buf.trim()) onLine(buf);
    } catch {}
};

/** Runs a short-lived command and returns stdout, or null if it fails. */
const runCapture = async (cmd: string[]): Promise<string | null> => {
    try {
        const proc = spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
        const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
        const code = await proc.exited;
        return code === 0 ? out : null;
    } catch {
        return null;
    }
};

/** Wires a provider's stdout/stderr into a line handler, keeping the tail for error reporting. */
const attachStreams = (proc: Subprocess, onLine: (line: string) => void) => {
    const handler = (line: string) => {
        recentLines.push(line);
        if (recentLines.length > 5) recentLines.shift();
        onLine(line);
    };
    streamLines(proc.stdout as ReadableStream<Uint8Array>, handler);
    streamLines(proc.stderr as ReadableStream<Uint8Array>, handler);
};

const normalizeHttpsUrl = (value: string): string => {
    const trimmed = value.trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

// bore publishes per-target archives whose names embed the release version,
// so the asset has to be resolved from the release listing rather than built
// from a fixed `latest/download/...` URL.
export const getBoreTargetTriple = (
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): string | null => {
    if (platform === 'darwin') {
        return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    }
    if (platform === 'linux') {
        const tripleMap: Record<string, string> = {
            x64: 'x86_64-unknown-linux-musl',
            arm64: 'aarch64-unknown-linux-musl',
            arm: 'arm-unknown-linux-musleabi',
            ia32: 'i686-unknown-linux-musl',
        };
        return tripleMap[arch] ?? 'x86_64-unknown-linux-musl';
    }
    if (platform === 'win32') {
        return arch === 'ia32' ? 'i686-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    }
    return null;
};

// Picks the archive matching this platform's target triple out of a release's
// asset list, tolerating the version segment that varies between releases.
export const selectBoreAsset = (
    assetNames: string[],
    targetTriple: string,
): string | null => {
    const suffix = targetTriple.includes('windows') ? '.zip' : '.tar.gz';
    return assetNames.find(name => name.endsWith(`-${targetTriple}${suffix}`)) ?? null;
};

const startCloudflared = async (options: TunnelOptions): Promise<Subprocess> => {
    const bin = await ensureCloudflaredBinary();

    if (options.cloudflaredMode !== 'named') {
        const proc = spawn([bin, 'tunnel', '--url', `http://localhost:${PROXY_PORT}`, '--no-autoupdate'], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
        attachStreams(proc, line => {
            if (state.status === 'running') return;
            const m = line.match(urlRegex);
            if (m) setState({ status: 'running', url: m[0] });
        });
        return proc;
    }

    const hostname = options.cloudflaredHostname?.trim();
    if (!hostname) {
        throw new Error(
            'A public hostname is required for a named Cloudflare tunnel. Use the hostname you routed with ' +
            '`cloudflared tunnel route dns <tunnel> <hostname>`, or the one configured in the Zero Trust dashboard.'
        );
    }

    const token = options.cloudflaredToken?.trim();
    const name = options.cloudflaredName?.trim();
    if (!token && !name) {
        throw new Error(
            'A named Cloudflare tunnel needs either a tunnel token (remote-managed, from the Zero Trust dashboard) ' +
            'or a tunnel name created locally with `cloudflared tunnel create <name>`.'
        );
    }

    const args = token
        ? [bin, 'tunnel', '--no-autoupdate', 'run', '--token', token]
        : [bin, 'tunnel', '--no-autoupdate', '--url', `http://localhost:${PROXY_PORT}`, 'run', name!];

    const proc = spawn(args, { stdout: 'pipe', stderr: 'pipe' });

    // Named tunnels never print their public hostname, so treat a registered
    // edge connection as "up" and report the hostname the user configured.
    const readyRegex = /Registered tunnel connection|Connection [0-9a-f-]+ registered|Updated to new configuration/i;
    attachStreams(proc, line => {
        if (state.status === 'running') return;
        if (readyRegex.test(line)) setState({ status: 'running', url: normalizeHttpsUrl(hostname) });
    });
    return proc;
};

const startNgrok = async (options: TunnelOptions): Promise<Subprocess> => {
    const cmd = process.platform === 'win32' ? 'ngrok.exe' : 'ngrok';
    const args = ['http', String(PROXY_PORT), '--log=stdout', '--log-format=json'];
    // A reserved static domain is what makes the ngrok URL survive restarts.
    if (options.ngrokDomain?.trim()) args.push('--url', normalizeHttpsUrl(options.ngrokDomain));
    if (options.authtoken?.trim()) args.push('--authtoken', options.authtoken.trim());

    let proc: Subprocess;
    try {
        proc = spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' });
    } catch (e: any) {
        throw new Error(
            `ngrok not found on PATH. Install it from https://ngrok.com/download and ensure 'ngrok' is runnable.`
        );
    }

    attachStreams(proc, line => {
        try {
            const obj = JSON.parse(line);
            if (obj.lvl === 'eror' || obj.lvl === 'crit') {
                setState({ error: obj.err || obj.msg || 'ngrok error' });
                return;
            }
            if (state.status === 'running') return;
            const urlField = obj.url || obj.public_url;
            if (typeof urlField === 'string' && urlField.startsWith('http')) {
                setState({ status: 'running', url: urlField, error: null });
            }
        } catch {}
    });
    return proc;
};

const ensureBoreBinary = async (): Promise<string> => {
    const filename = process.platform === 'win32' ? 'bore.exe' : 'bore';

    // A user-installed bore (Homebrew, cargo, manual) takes precedence.
    if (Bun.which(filename)) return filename;

    if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });
    const localPath = join(BIN_DIR, filename);
    if (existsSync(localPath)) return localPath;

    const targetTriple = getBoreTargetTriple();
    if (!targetTriple) {
        throw new Error(
            `Automatic download not supported on ${process.platform}. Install bore manually (https://github.com/ekzhang/bore/releases) and ensure 'bore' is on PATH.`
        );
    }

    let assetName: string;
    let assetUrl: string;
    try {
        const resp = await fetch('https://api.github.com/repos/ekzhang/bore/releases/latest', {
            redirect: 'follow',
            headers: { ...DOWNLOAD_HEADERS, Accept: 'application/vnd.github+json' },
        });
        if (!resp.ok) {
            throw new Error(`GitHub API returned ${resp.status} ${resp.statusText}`);
        }
        const release = (await resp.json()) as {
            assets?: Array<{ name: string; browser_download_url: string }>;
        };
        const assets = release.assets ?? [];
        const selected = selectBoreAsset(assets.map(a => a.name), targetTriple);
        if (!selected) {
            throw new Error(`No bore asset found for ${targetTriple}`);
        }
        assetName = selected;
        assetUrl = assets.find(a => a.name === selected)!.browser_download_url;
    } catch (err: any) {
        throw new Error(
            `Failed to resolve a bore download for ${targetTriple}: ${err?.message ?? err}. ` +
            `You can install bore manually from https://github.com/ekzhang/bore/releases ` +
            `and place the binary at ${localPath}.`
        );
    }

    const tmpPath = `${localPath}.downloading`;
    rmSync(tmpPath, { force: true });

    try {
        await downloadToFile(assetUrl, tmpPath);
    } catch (err: any) {
        rmSync(tmpPath, { force: true });
        throw new Error(
            `Failed to download bore (${assetName}): ${err?.message ?? err}. ` +
            `You can install bore manually from https://github.com/ekzhang/bore/releases ` +
            `and place the binary at ${localPath}.`
        );
    }

    await extractArchive(tmpPath, localPath, filename, assetName);

    if (process.platform !== 'win32') {
        try {
            chmodSync(localPath, 0o755);
        } catch {}
    }
    return localPath;
};

const startBore = async (options: TunnelOptions): Promise<Subprocess> => {
    const cmd = await ensureBoreBinary();
    const args = ['local', String(PROXY_PORT), '--to', 'bore.pub'];
    // bore.pub grants a requested port only if it is free, so this is best effort.
    if (options.borePort) args.push('--port', String(options.borePort));

    let proc: Subprocess;
    try {
        proc = spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' });
    } catch (e: any) {
        throw new Error(
            `Failed to start bore (${cmd}): ${e?.message ?? e}`
        );
    }

    const urlRegex = /listening at (bore\.pub:\d+)/i;
    attachStreams(proc, line => {
        if (state.status === 'running') return;
        const m = line.match(urlRegex);
        if (m) setState({ status: 'running', url: `http://${m[1]}` });
    });
    return proc;
};

/** Tailscale ships outside PATH on Windows and macOS more often than not. */
export const getTailscaleCandidates = (platform: NodeJS.Platform = process.platform): string[] => {
    if (platform === 'win32') {
        return ['tailscale.exe', 'C:\\Program Files\\Tailscale\\tailscale.exe'];
    }
    if (platform === 'darwin') {
        return [
            'tailscale',
            '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
            '/usr/local/bin/tailscale',
        ];
    }
    return ['tailscale', '/usr/bin/tailscale'];
};

const resolveTailscaleBin = (): string => {
    const candidates = getTailscaleCandidates();
    if (Bun.which(candidates[0]!)) return candidates[0]!;
    for (const candidate of candidates.slice(1)) {
        if (existsSync(candidate)) return candidate;
    }
    return candidates[0]!;
};

/** Reads this node's MagicDNS name, which is the Funnel hostname. */
const resolveTailscaleUrl = async (bin: string): Promise<string | null> => {
    const out = await runCapture([bin, 'status', '--json']);
    if (!out) return null;
    try {
        const parsed = JSON.parse(out) as { Self?: { DNSName?: string } };
        const dns = parsed.Self?.DNSName?.replace(/\.$/, '');
        return dns ? `https://${dns}` : null;
    } catch {
        return null;
    }
};

const startTailscale = async (options: TunnelOptions): Promise<Subprocess> => {
    const bin = resolveTailscaleBin();
    const args = ['funnel'];
    if (options.tailscalePort && options.tailscalePort !== 443) {
        args.push(`--https=${options.tailscalePort}`);
    }
    args.push(String(PROXY_PORT));

    let proc: Subprocess;
    try {
        proc = spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe' });
    } catch (e: any) {
        throw new Error(
            `tailscale not found. Install it from https://tailscale.com/download, run 'tailscale up', then enable ` +
            `MagicDNS + HTTPS certificates and the 'funnel' node attribute in the admin console.`
        );
    }

    const urlRegex = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net(?::\d+)?/i;
    attachStreams(proc, line => {
        if (state.status === 'running') return;
        const m = line.match(urlRegex);
        if (m) setState({ status: 'running', url: m[0].replace(/\/$/, '') });
    });

    // Funnel does not always echo the URL, so fall back to the node's MagicDNS
    // name after a short grace period.
    const myRun = runId;
    setTimeout(async () => {
        if (runId !== myRun || state.url) return;
        const base = await resolveTailscaleUrl(bin);
        if (runId !== myRun || state.url || !base) return;
        const port = options.tailscalePort && options.tailscalePort !== 443 ? `:${options.tailscalePort}` : '';
        setState({ status: 'running', url: `${base}${port}` });
    }, 4000);

    return proc;
};

// ── Lifecycle ────────────────────────────────────────────────────────────────

const clearReconnectTimer = () => {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
};

const scheduleReconnect = (reason: string) => {
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** restartAttempt);
    restartAttempt += 1;
    setState({
        status: 'starting',
        error: `${reason} — reconnecting in ${Math.round(delay / 1000)}s (attempt ${restartAttempt})`,
        // A fixed URL comes back unchanged, so keep showing it while we retry.
        url: state.fixed ? state.url : null,
    });
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void launch().catch(() => {});
    }, delay);
};

const launch = async (): Promise<void> => {
    const provider = activeProvider;
    if (!provider) return;

    const myRun = ++runId;
    recentLines = [];
    const fixed = isFixedUrlConfig(provider, activeOptions);
    setState({
        provider,
        status: 'starting',
        url: fixed ? state.url : null,
        error: null,
        fixed,
    });

    let proc: Subprocess;
    try {
        if (provider === 'cloudflared') proc = await startCloudflared(activeOptions);
        else if (provider === 'ngrok') proc = await startNgrok(activeOptions);
        else if (provider === 'bore') proc = await startBore(activeOptions);
        else if (provider === 'tailscale') proc = await startTailscale(activeOptions);
        else throw new Error(`Unknown provider: ${provider}`);
    } catch (err: any) {
        if (runId !== myRun) return;
        setState({ status: 'error', error: err?.message ?? String(err), url: null });
        throw err;
    }

    if (runId !== myRun) {
        // A stop or restart landed while the provider was still booting.
        await killProc(proc);
        return;
    }
    currentProc = proc;

    void proc.exited.then(code => {
        if (runId !== myRun) return;
        currentProc = null;
        const detail = recentLines.at(-1);
        const reason = `${provider} exited unexpectedly (code ${code})${detail ? `: ${detail}` : ''}`;
        if (autoReconnect) {
            setState({ restarts: state.restarts + 1 });
            scheduleReconnect(reason);
        } else {
            setState({ status: 'error', error: reason, url: null });
        }
    });
};

export const startTunnel = async (
    provider: TunnelProvider,
    options: TunnelOptions = {},
    opts: { autoReconnect?: boolean } = {}
): Promise<void> => {
    await stopTunnel();

    activeProvider = provider;
    activeOptions = { ...options };
    autoReconnect = opts.autoReconnect ?? true;
    restartAttempt = 0;

    setState({ startedAt: Date.now(), restarts: 0 });
    await launch();
};

export const stopTunnel = async (): Promise<void> => {
    runId += 1; // Invalidate in-flight launches and pending exit handlers.
    clearReconnectTimer();
    restartAttempt = 0;

    const proc = currentProc;
    currentProc = null;
    if (proc) await killProc(proc);

    setState({
        status: 'stopped',
        url: null,
        error: null,
        fixed: false,
        restarts: 0,
    });
};
