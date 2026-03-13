let userId = null;
let syncInterval = null;

const DEBUG = false;
function log(...args) {
    if (DEBUG) console.log('[FeedWorker]', ...args);
}

async function fetchFeedText(feedUrl) {
    log('Fetching feed:', feedUrl);
    try {
        const proxyUrl = `/.netlify/functions/fetch-feed?url=${encodeURIComponent(feedUrl)}`;
        const response = await fetch(proxyUrl);
        log('Fetch response:', response.status);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        return { feedUrl, text: data.text };
    } catch (e) {
        log('Fetch error:', e);
        return null;
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
            for (const feed of payload.feeds) {
                const result = await fetchFeedText(feed.url);
                if (result) {
                    self.postMessage({ type: 'parseFeed', payload: result });
                }
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
