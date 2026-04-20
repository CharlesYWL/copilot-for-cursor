import { spawn, type Subprocess } from 'bun';
import { existsSync, mkdirSync, chmodSync, createWriteStream, renameSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';

export type TunnelProvider = 'cloudflared' | 'ngrok' | 'bore';
export type TunnelStatus = 'idle' | 'starting' | 'running' | 'error' | 'stopped';

export interface TunnelState {
    provider: TunnelProvider | null;
    status: TunnelStatus;
    url: string | null;
    error: string | null;
    startedAt: number | null;
}

const PROXY_PORT = 4142;
const BIN_DIR = join(homedir(), '.copilot-proxy', 'bin');

let state: TunnelState = {
    provider: null,
    status: 'idle',
    url: null,
    error: null,
    startedAt: null,
};

let currentProc: Subprocess | null = null;
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

const getCloudflaredAssetName = (): string | null => {
    const platform = process.platform;
    const arch = process.arch;
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
    // macOS ships as .tgz — skip automatic download for now.
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

    renameSync(tmpPath, localPath);

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

const startCloudflared = async (): Promise<void> => {
    const bin = await ensureCloudflaredBinary();
    const proc = spawn([bin, 'tunnel', '--url', `http://localhost:${PROXY_PORT}`, '--no-autoupdate'], {
        stdout: 'pipe',
        stderr: 'pipe',
    });
    currentProc = proc;

    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    const onLine = (line: string) => {
        if (state.status === 'running') return;
        const m = line.match(urlRegex);
        if (m) {
            setState({ status: 'running', url: m[0] });
        }
    };

    streamLines(proc.stdout as ReadableStream<Uint8Array>, onLine);
    streamLines(proc.stderr as ReadableStream<Uint8Array>, onLine);

    proc.exited.then(code => {
        if (currentProc === proc) {
            currentProc = null;
            if (state.status !== 'stopped') {
                setState({
                    status: 'error',
                    error: `cloudflared exited unexpectedly (code ${code})`,
                });
            }
        }
    });
};

const startNgrok = async (authtoken?: string): Promise<void> => {
    const cmd = process.platform === 'win32' ? 'ngrok.exe' : 'ngrok';
    const args = ['http', String(PROXY_PORT), '--log=stdout', '--log-format=json'];
    if (authtoken) args.push('--authtoken', authtoken);

    let proc: Subprocess;
    try {
        proc = spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' });
    } catch (e: any) {
        throw new Error(
            `ngrok not found on PATH. Install it from https://ngrok.com/download and ensure 'ngrok' is runnable.`
        );
    }
    currentProc = proc;

    const onLine = (line: string) => {
        if (state.status === 'running') return;
        try {
            const obj = JSON.parse(line);
            if (obj.url && typeof obj.url === 'string' && obj.url.startsWith('http')) {
                setState({ status: 'running', url: obj.url });
                return;
            }
            if (obj.msg === 'started tunnel' && obj.addr) {
                const urlField = obj.url || obj.public_url;
                if (urlField) setState({ status: 'running', url: urlField });
            }
            if (obj.lvl === 'eror' || obj.lvl === 'crit') {
                setState({ status: 'error', error: obj.err || obj.msg || 'ngrok error' });
            }
        } catch {}
    };

    streamLines(proc.stdout as ReadableStream<Uint8Array>, onLine);
    streamLines(proc.stderr as ReadableStream<Uint8Array>, onLine);

    proc.exited.then(code => {
        if (currentProc === proc) {
            currentProc = null;
            if (state.status !== 'stopped') {
                setState({
                    status: 'error',
                    error: state.error ?? `ngrok exited unexpectedly (code ${code})`,
                });
            }
        }
    });
};

const startBore = async (): Promise<void> => {
    const cmd = process.platform === 'win32' ? 'bore.exe' : 'bore';
    let proc: Subprocess;
    try {
        proc = spawn([cmd, 'local', String(PROXY_PORT), '--to', 'bore.pub'], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
    } catch {
        throw new Error(
            `bore not found on PATH. Install from https://github.com/ekzhang/bore/releases and ensure 'bore' is runnable.`
        );
    }
    currentProc = proc;

    const urlRegex = /listening at (bore\.pub:\d+)/i;
    const onLine = (line: string) => {
        if (state.status === 'running') return;
        const m = line.match(urlRegex);
        if (m) {
            setState({ status: 'running', url: `http://${m[1]}` });
        }
    };

    streamLines(proc.stdout as ReadableStream<Uint8Array>, onLine);
    streamLines(proc.stderr as ReadableStream<Uint8Array>, onLine);

    proc.exited.then(code => {
        if (currentProc === proc) {
            currentProc = null;
            if (state.status !== 'stopped') {
                setState({
                    status: 'error',
                    error: `bore exited unexpectedly (code ${code})`,
                });
            }
        }
    });
};

export const startTunnel = async (
    provider: TunnelProvider,
    opts: { authtoken?: string } = {}
): Promise<void> => {
    await stopTunnel();

    setState({
        provider,
        status: 'starting',
        url: null,
        error: null,
        startedAt: Date.now(),
    });

    try {
        if (provider === 'cloudflared') {
            await startCloudflared();
        } else if (provider === 'ngrok') {
            await startNgrok(opts.authtoken);
        } else if (provider === 'bore') {
            await startBore();
        } else {
            throw new Error(`Unknown provider: ${provider}`);
        }
    } catch (err: any) {
        setState({
            status: 'error',
            error: err?.message ?? String(err),
        });
        if (currentProc) {
            await killProc(currentProc);
            currentProc = null;
        }
        throw err;
    }
};

export const stopTunnel = async (): Promise<void> => {
    const proc = currentProc;
    currentProc = null;
    if (proc) {
        await killProc(proc);
    }
    setState({
        status: 'stopped',
        url: null,
        error: null,
    });
};
