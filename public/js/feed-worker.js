let userId = null;
let syncInterval = null;

async function fetchFeedItems(feedUrl) {
    try {
        const response = await fetch(feedUrl);
        if (!response.ok) {
            return [];
        }
        const text = await response.text();
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'application/xml');
        
        const items = [];
        
        const rssItems = xml.querySelectorAll('item');
        if (rssItems.length > 0) {
            for (const item of rssItems) {
                const link = item.querySelector('link')?.textContent || '';
                const pubDate = item.querySelector('pubDate')?.textContent || null;
                const enclosure = item.querySelector('enclosure')?.getAttribute('url') || null;
                
                if (link) {
                    items.push({
                        link,
                        pubDate,
                        enclosure,
                        unread: true,
                        addedDate: new Date().toISOString()
                    });
                }
            }
            return items;
        }
        
        const atomEntries = xml.querySelectorAll('entry');
        for (const entry of atomEntries) {
            const linkEl = entry.querySelector('link[rel="alternate"]') || entry.querySelector('link');
            const link = linkEl?.getAttribute('href') || '';
            const pubDate = entry.querySelector('published')?.textContent || 
                           entry.querySelector('updated')?.textContent || null;
            const enclosure = entry.querySelector('enclosure')?.getAttribute('url') || null;
            
            if (link) {
                items.push({
                    link,
                    pubDate,
                    enclosure,
                    unread: true,
                    addedDate: new Date().toISOString()
                });
            }
        }
        
        return items;
    } catch (e) {
        return [];
    }
}

function getFeedsFromStore() {
    self.postMessage({ type: 'getFeeds' });
}

async function updateFeed(feedUrl) {
    const items = await fetchFeedItems(feedUrl);
    if (items.length > 0) {
        self.postMessage({ type: 'updateFeed', payload: { feedUrl, items } });
    }
}

async function scanAllFeeds() {
    self.postMessage({ type: 'getFeeds' });
}

function startSync() {
    if (syncInterval) return;
    syncInterval = setInterval(() => {
        scanAllFeeds();
    }, 60 * 60 * 1000);
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

        case 'feeds':
            for (const feed of payload.feeds) {
                await updateFeed(feed.url);
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
