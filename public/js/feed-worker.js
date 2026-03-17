let userId = null;
let syncInterval = null;
const BATCH_SIZE = 15;
const BATCH_DELAY_MS = 2000;

const DEBUG = true;
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
        const response = await fetch(proxyUrl);
        log('Fetch response:', response.status);
        if (!response.ok) {
            return [];
        }
        const data = await response.json();
        if (data.results) {
            return data.results
                .filter(r => r.text)
                .map(r => ({ feedUrl: r.url, text: r.text }));
        }
        if (data.text) {
            return [{ feedUrl: data.url, text: data.text }];
        }
        return [];
    } catch (e) {
        log('Fetch error:', e);
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
