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

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

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

    const url = event.queryStringParameters?.url;
    if (!url) {
        return send(400, { error: 'Missing url parameter' });
    }

    const cacheKey = makeCacheKey(url);

    // Check cache first
    if (cacheStore) {
        try {
            const cached = await cacheStore.get(cacheKey);
            if (cached) {
                const parsed = JSON.parse(cached);
                const age = Date.now() - parsed.fetchedAt;
                if (age < CACHE_TTL_MS) {
                    return send(200, { ...parsed.data, cached: true, age });
                }
            }
        } catch (e) {
            // Cache miss or error, proceed to fetch
        }
    }

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'OnlyRead/1.0'
            }
        });

        const text = await response.text();
        const contentType = response.headers.get('content-type') || '';

        const result = { text, contentType };

        // Store in cache
        if (cacheStore) {
            try {
                const cacheData = JSON.stringify({
                    fetchedAt: Date.now(),
                    data: result
                });
                await cacheStore.set(cacheKey, cacheData);
            } catch (e) {
                // Ignore cache write errors
            }
        }

        return send(200, result);
    } catch (error) {
        return send(500, { error: error.message });
    }
};
