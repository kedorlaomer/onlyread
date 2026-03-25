let userId = null;
let syncInterval = null;
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 2000;

const DEBUG = false;
function log(...args) {
    if (DEBUG) console.log('[FeedWorker]', ...args);
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

async function fetchFeedBatch(feedUrls) {
    log('Fetching batch:', feedUrls.length, 'feeds');
    try {
        const proxyUrl = `/.netlify/functions/fetch-feed?urls=${encodeURIComponent(JSON.stringify(feedUrls))}`;
        
        let response;
        let data = null;
        let responseText = '';
        
        try {
            response = await fetch(proxyUrl);
            log('Fetch response status:', response.status);
            
            // Try to get text first (to detect size errors)
            responseText = await response.text();
            log('Response text length:', responseText.length);
            
            // Check if response text indicates size error
            if (responseText.includes('ResponseSizeTooLarge')) {
                log('Detected ResponseSizeTooLarge in response text');
                if (feedUrls.length > 1) {
                    log('Retrying one by one');
                    const results = [];
                    for (const url of feedUrls) {
                        const singleResult = await fetchFeedBatch([url]);
                        results.push(...singleResult);
                    }
                    return results;
                }
                return [];
            }
            
            // Try to parse as JSON
            try {
                data = JSON.parse(responseText);
            } catch (e) {
                log('Response is not JSON');
            }
            
        } catch (fetchError) {
            log('Fetch error:', fetchError.message);
            // Network error or response too large to parse
            if (feedUrls.length > 1) {
                log('Fetch failed, retrying one by one');
                const results = [];
                for (const url of feedUrls) {
                    const singleResult = await fetchFeedBatch([url]);
                    results.push(...singleResult);
                }
                return results;
            }
            return [];
        }
        
        // Check JSON for error
        const errorStr = data?.errorType || data?.errorMessage || '';
        if (errorStr.includes('ResponseSizeTooLarge') && feedUrls.length > 1) {
            log('Detected ResponseSizeTooLarge in JSON, retrying one by one');
            const results = [];
            for (const url of feedUrls) {
                const singleResult = await fetchFeedBatch([url]);
                results.push(...singleResult);
            }
            return results;
        }
        
        if (!response.ok) {
            return [];
        }
        
        if (data?.results) {
            return data.results
                .filter(r => r.text)
                .map(r => ({ feedUrl: r.url, text: r.text }));
        }
        if (data?.text) {
            return [{ feedUrl: data.url, text: data.text }];
        }
        return [];
    } catch (e) {
        log('Outer catch error:', e);
        return [];
    }
}

function startSync() {
    if (syncInterval) return;
    syncInterval = setInterval(() => {
        scanAllFeeds();
    }, 60 * 60 * 1000);
}

async function scanAllFeeds() {
    self.postMessage({ type: 'getFeeds' });
}

self.onmessage = async function(e) {
    const { type, payload } = e.data;
    log('Received message:', type);

    switch (type) {
        case 'init':
            userId = payload.userId;
            startSync();
            await scanAllFeeds();
            self.postMessage({ type: 'ready' });
            break;

        case 'scan':
            await scanAllFeeds();
            break;

        case 'feeds':
            log('Processing feeds:', payload.feeds.length);
            const feedUrls = payload.feeds.map(f => f.url);
            const batches = chunkArray(feedUrls, BATCH_SIZE);
            
            for (const batch of batches) {
                const results = await fetchFeedBatch(batch);
                for (const result of results) {
                    self.postMessage({ type: 'parseFeed', payload: result });
                }
                // Small delay between batches to avoid rate limiting
                await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
            }
            break;

        case 'stop':
            if (syncInterval) {
                clearInterval(syncInterval);
                syncInterval = null;
            }
            self.postMessage({ type: 'stopped' });
            break;
    }
};
