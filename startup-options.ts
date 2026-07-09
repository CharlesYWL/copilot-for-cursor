import type { TunnelProvider } from './tunnel';
import { isTunnelProvider, type ProxySettings } from './settings-config';

export interface TunnelStartupAction {
    enabled: boolean;
    provider?: TunnelProvider;
}

export interface StartupOptions {
    maxMode: boolean;
    tunnelProvider: TunnelProvider | null;
    tunnelAction: TunnelStartupAction | null;
}

export function parseStartupOptions(args: string[], settings: ProxySettings): StartupOptions {
    const enableMax = args.includes('--max');
    const disableMax = args.includes('--no-max');
    if (enableMax && disableMax) {
        throw new Error('Use only one of --max or --no-max');
    }

    const tunnelArgs = args.filter(arg => arg === '--tunnel' || arg.startsWith('--tunnel='));
    const disableTunnel = args.includes('--no-tunnel');
    if (tunnelArgs.length > 1 || (tunnelArgs.length > 0 && disableTunnel)) {
        throw new Error('Use only one of --tunnel[=provider] or --no-tunnel');
    }

    let tunnelAction: TunnelStartupAction | null = null;
    let tunnelProvider: TunnelProvider | null;

    if (disableTunnel) {
        tunnelAction = { enabled: false };
        tunnelProvider = null;
    } else if (tunnelArgs.length === 1) {
        const requestedProvider = tunnelArgs[0] === '--tunnel'
            ? 'cloudflared'
            : tunnelArgs[0].slice('--tunnel='.length);
        if (!isTunnelProvider(requestedProvider)) {
            throw new Error(`Invalid tunnel provider "${requestedProvider}". Use cloudflared, ngrok, or bore`);
        }
        tunnelAction = { enabled: true, provider: requestedProvider };
        tunnelProvider = requestedProvider;
    } else {
        tunnelProvider = settings.tunnel.autoStart ? settings.tunnel.provider : null;
    }

    return {
        maxMode: enableMax ? true : disableMax ? false : settings.maxMode,
        tunnelProvider,
        tunnelAction,
    };
}
