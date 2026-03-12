let userId = null;
let syncInterval = null;

const DEBUG = true;
function log(...args) {
    if (DEBUG) console.log('[FeedWorker]', ...args);
}

async function fetchFeedText(feedUrl) {
    try {
        const proxyUrl = `/.netlify/functions/fetch-feed?url=${encodeURIComponent(feedUrl)}`;
        const response = await fetch(proxyUrl);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        return { feedUrl, text: data.text };
    } catch (e) {
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
