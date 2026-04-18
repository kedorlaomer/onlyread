import { fetchFeedBatch } from './fetch-feed.js';

let userId = null;
let syncInterval = null;
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 2000;

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
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
            const feedUrls = payload.feeds.map(f => f.url);
            const batches = chunkArray(feedUrls, BATCH_SIZE);
            
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                const { results, errors } = await fetchFeedBatch(batch);
                for (const result of results) {
                    self.postMessage({ type: 'parseFeed', payload: { feedUrl: result.feedUrl, text: result.text } });
                }
                if (errors.length > 0) {
                    self.postMessage({ type: 'feedErrors', payload: { errors } });
                }
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