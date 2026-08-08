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

const startBore = async (): Promise<void> => {
    const cmd = await ensureBoreBinary();
    let proc: Subprocess;
    try {
        proc = spawn([cmd, 'local', String(PROXY_PORT), '--to', 'bore.pub'], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
    } catch (e: any) {
        throw new Error(
            `Failed to start bore (${cmd}): ${e?.message ?? e}`
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
