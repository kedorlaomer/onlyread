const DEBUG = false;
function log(...args) {
    if (DEBUG) console.log('[FetchFeed]', ...args);
}

export async function fetchFeedBatch(urls) {
    if (!Array.isArray(urls)) urls = [urls];
    if (urls.length === 0) return { results: [], errors: [] };

    try {
        const proxyUrl = `/.netlify/functions/fetch-feed?urls=${encodeURIComponent(JSON.stringify(urls))}`;
        const response = await fetch(proxyUrl);

        const responseText = await response.text();
        log('Response status:', response.status, 'length:', responseText.length);

        // Check for size error first
        if (responseText.includes('ResponseSizeTooLarge') && urls.length > 1) {
            log('Response too large, retrying one by one');
            let results = [];
            let errors = [];
            for (const url of urls) {
                const singleResult = await fetchFeedBatch([url]);
                results.push(...singleResult.results);
                errors.push(...singleResult.errors);
            }
            return { results, errors };
        }

        if (!response.ok) {
            return { results: [], errors: urls.map(url => ({ url, error: `HTTP ${response.status}` })) };
        }

        const data = JSON.parse(responseText);

        if (data.results) {
            let results = [];
            let errors = [];
            for (const r of data.results) {
                if (r.text) {
                    results.push({ feedUrl: r.url, text: r.text });
                } else if (r.error) {
                    errors.push({ url: r.url, error: r.error });
                }
            }
            return { results, errors };
        }
        if (data.url && data.text) {
            return { results: [{ feedUrl: data.url, text: data.text }], errors: [] };
        }
        return { results: [], errors: [] };
    } catch (e) {
        log('Batch fetch error:', e);
        return { results: [], errors: urls.map(url => ({ url, error: e.message })) };
    }
}
