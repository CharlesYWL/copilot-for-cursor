export function buildUpstreamUrl(requestUrl: URL, targetBaseUrl: string): URL {
    const targetUrl = new URL(targetBaseUrl);
    targetUrl.pathname = requestUrl.pathname;
    targetUrl.search = requestUrl.search;
    return targetUrl;
}
