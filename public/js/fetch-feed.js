const DEBUG = false;
function log(...args) {
    if (DEBUG) console.log('[FetchFeed]', ...args);
}

export async function fetchFeedBatch(urls) {
    if (!Array.isArray(urls)) urls = [urls];
    if (urls.length === 0) return [];

    try {
        const proxyUrl = `/.netlify/functions/fetch-feed?urls=${encodeURIComponent(JSON.stringify(urls))}`;
        const response = await fetch(proxyUrl);

        const responseText = await response.text();
        log('Response status:', response.status, 'length:', responseText.length);

        // Check for size error first
        if (responseText.includes('ResponseSizeTooLarge') && urls.length > 1) {
            log('Response too large, retrying one by one');
            const results = [];
            for (const url of urls) {
                const singleResult = await fetchFeedBatch([url]);
                results.push(...singleResult);
            }
            return results;
        }

        if (!response.ok) {
            return [];
        }

        const data = JSON.parse(responseText);

        if (data.results) {
            return data.results.filter(r => r.text).map(r => ({ feedUrl: r.url, text: r.text }));
        }
        if (data.url && data.text) {
            return [{ feedUrl: data.url, text: data.text }];
        }
        return [];
    } catch (e) {
        log('Batch fetch error:', e);
        return [];
    }
}
