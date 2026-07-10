const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLocalUrl(value: string): boolean {
    try {
        return LOCAL_HOSTNAMES.has(new URL(value).hostname.toLowerCase());
    } catch {
        return false;
    }
}

export function isTrustedManagementRequest(request: Request): boolean {
    if (!isLocalUrl(request.url)) return false;

    const origin = request.headers.get('origin');
    return origin === null || isLocalUrl(origin);
}
