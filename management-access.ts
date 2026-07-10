function isLocalHostname(hostname: string): boolean {
    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') {
        return true;
    }

    const octets = hostname.split('.');
    return octets.length === 4
        && octets[0] === '127'
        && octets.every(octet => {
            const value = Number(octet);
            return /^\d{1,3}$/.test(octet) && value >= 0 && value <= 255;
        });
}

function isLocalUrl(value: string): boolean {
    try {
        return isLocalHostname(new URL(value).hostname.toLowerCase());
    } catch {
        return false;
    }
}

export function isTrustedManagementRequest(request: Request): boolean {
    if (!isLocalUrl(request.url)) return false;

    const origin = request.headers.get('origin');
    return origin === null || isLocalUrl(origin);
}
