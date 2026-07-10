import { spawn } from 'child_process';

export function buildTunnelApiUrl(publicUrl: string): string {
    return `${publicUrl.replace(/\/+$/, '')}/v1`;
}

export function getClipboardCommands(platform = process.platform): string[][] {
    if (platform === 'win32') return [['clip.exe']];
    if (platform === 'darwin') return [['pbcopy']];
    return [
        ['wl-copy'],
        ['xclip', '-selection', 'clipboard'],
        ['xsel', '--clipboard', '--input'],
    ];
}

async function runClipboardCommand(command: string[], text: string): Promise<boolean> {
    return await new Promise(resolve => {
        const child = spawn(command[0], command.slice(1), {
            stdio: ['pipe', 'ignore', 'ignore'],
            windowsHide: true,
        });
        let settled = false;
        const finish = (success: boolean) => {
            if (settled) return;
            settled = true;
            resolve(success);
        };
        child.once('error', () => finish(false));
        child.once('exit', code => finish(code === 0));
        child.stdin.on('error', () => finish(false));
        child.stdin.end(text);
    });
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
    for (const command of getClipboardCommands()) {
        if (await runClipboardCommand(command, text)) return true;
    }
    return false;
}
