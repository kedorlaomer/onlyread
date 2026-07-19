const { getStore } = require('@netlify/blobs');

let cacheStore = null;
try {
    cacheStore = getStore({
        name: 'feed-cache',
        siteID: process.env.SITE_ID,
        token: process.env.BLOB_TOKEN
    });
} catch (err) {
    cacheStore = null;
}

// Identify the fetcher with contact links so publishers can see who we are and
// reach us, rather than a bare token that stricter feeds tend to block.
const USER_AGENT = 'OnlyRead/1.0 (+https://onlyread.netlify.app; +https://github.com/kedorlaomer/onlyread)';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // freshness when the origin sends no hint
const MIN_TTL_MS = 5 * 60 * 1000;       // floor: don't hammer origins that ask for tiny max-age
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // ceiling: don't trust very long max-age blindly
const MAX_TEXT_SIZE = 4 * 1024 * 1024; // 4MB limit to leave room for overhead

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Parse Cache-Control into the bits we act on (RFC 9111 §5.2.2).
function parseCacheControl(value) {
    const out = { noStore: false, noCache: false, maxAge: null };
    if (!value) return out;
    for (const part of value.split(',')) {
        const [rawName, rawVal] = part.split('=');
        const name = rawName.trim().toLowerCase();
        if (name === 'no-store') out.noStore = true;
        else if (name === 'no-cache') out.noCache = true;
        else if (name === 'max-age') {
            const n = parseInt(rawVal, 10);
            if (Number.isFinite(n)) out.maxAge = n;
        }
    }
    return out;
}

// Derive the freshness lifetime (ms) from response headers: Cache-Control max-age
// first, then Expires, else the default — clamped to a sane window.
function freshnessMs(cc, response) {
    let ms = DEFAULT_TTL_MS;
    if (cc.maxAge != null) {
        ms = cc.maxAge * 1000;
    } else {
        const expires = response.headers.get('expires');
        if (expires) {
            const t = Date.parse(expires);
            if (Number.isFinite(t)) ms = t - Date.now();
        }
    }
    return clamp(ms, MIN_TTL_MS, MAX_TTL_MS);
}

function makeCacheKey(url) {
    // Simple hash: URL-encoded, with special chars replaced
    return url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 100);
}

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    const send = (code, data) => ({ statusCode: code, headers, body: JSON.stringify(data) });

    if (event.httpMethod === 'OPTIONS') return send(200, {});

    const urlParam = event.queryStringParameters?.url;
    const urlsParam = event.queryStringParameters?.urls;
    
    let urls = [];
    if (urlsParam) {
        try {
            urls = JSON.parse(urlsParam);
        } catch {
            urls = urlsParam.split(',').map(u => decodeURIComponent(u.trim()));
        }
    } else if (urlParam) {
        urls = [urlParam];
    }
    
    if (urls.length === 0) {
        return send(400, { error: 'Missing url or urls parameter' });
    }

    async function fetchOneUrl(url) {
        const cacheKey = makeCacheKey(url);

        // Load any cached entry. A fresh one (age < its stored TTL) is served without
        // touching the network, unless it was stored no-cache, which must revalidate.
        let entry = null;
        if (cacheStore) {
            try {
                const cached = await cacheStore.get(cacheKey);
                if (cached) {
                    entry = JSON.parse(cached);
                    const age = Date.now() - entry.fetchedAt;
                    if (!entry.data.noCache && age < entry.ttlMs) {
                        return { url, text: entry.data.text, contentType: entry.data.contentType, cached: true, age };
                    }
                }
            } catch (e) {
                entry = null; // corrupt/missing — treat as no cache
            }
        }

        try {
            // Stale (or no-cache): revalidate with conditional headers when we hold
            // validators, so an unchanged feed answers 304 with no body transfer.
            const reqHeaders = { 'User-Agent': USER_AGENT };
            if (entry?.data?.etag) reqHeaders['If-None-Match'] = entry.data.etag;
            if (entry?.data?.lastModified) reqHeaders['If-Modified-Since'] = entry.data.lastModified;

            const response = await fetch(url, { headers: reqHeaders });

            // Not Modified: refresh freshness window, serve the cached body.
            if (response.status === 304 && entry) {
                const cc = parseCacheControl(response.headers.get('cache-control'));
                const ttlMs = freshnessMs(cc, response);
                if (cacheStore && !cc.noStore) {
                    try {
                        entry.data.noCache = cc.noCache;
                        await cacheStore.set(cacheKey, JSON.stringify({
                            fetchedAt: Date.now(), ttlMs, data: entry.data
                        }));
                    } catch (e) { /* ignore cache write errors */ }
                }
                return { url, text: entry.data.text, contentType: entry.data.contentType, cached: true, revalidated: true };
            }

            if (!response.ok) {
                return { url, error: `HTTP ${response.status}` };
            }

            const text = await response.text();
            const contentType = response.headers.get('content-type') || '';

            // Truncate if too large
            let truncatedText = text;
            if (text.length > MAX_TEXT_SIZE) {
                truncatedText = text.substring(0, MAX_TEXT_SIZE) + '\n\n[...truncated due to size]';
            }

            const cc = parseCacheControl(response.headers.get('cache-control'));
            const result = {
                text: truncatedText,
                contentType,
                etag: response.headers.get('etag') || null,
                lastModified: response.headers.get('last-modified') || null,
                noCache: cc.noCache
            };

            // Store unless the origin forbids it (RFC 9111 no-store).
            if (cacheStore && !cc.noStore) {
                try {
                    await cacheStore.set(cacheKey, JSON.stringify({
                        fetchedAt: Date.now(),
                        ttlMs: freshnessMs(cc, response),
                        data: result
                    }));
                } catch (e) {
                    // Ignore cache write errors
                }
            }

            return { url, text: result.text, contentType };
        } catch (error) {
            return { url, error: error.message };
        }
    }

    if (urls.length === 1) {
        const result = await fetchOneUrl(urls[0]);
        return send(200, result);
    }

    const results = await Promise.all(urls.map(url => fetchOneUrl(url)));
    return send(200, { results });
};
