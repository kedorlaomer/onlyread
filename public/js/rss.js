export function validateUrl(string) {
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

export async function subscribeToFeed(url, store) {
    if (!validateUrl(url)) {
        return { success: false, error: 'Invalid URL' };
    }

    try {
        const response = await fetch(url);
        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }

        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();

        const isRss = contentType.includes('xml') || 
                      contentType.includes('rss') || 
                      contentType.includes('atom') ||
                      text.trim().startsWith('<?xml') ||
                      text.trim().startsWith('<rss') ||
                      text.trim().startsWith('<feed');

        if (!isRss) {
            return { success: false, error: 'Not an RSS feed' };
        }

        const feeds = store.get('feeds') || [];

        if (feeds.some(f => f.url === url)) {
            return { success: false, error: 'Feed already subscribed' };
        }

        feeds.push({ url });
        store.set('feeds', feeds);

        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export function getFeeds(store) {
    return store.get('feeds') || [];
}

export function removeFeed(url, store) {
    const feeds = store.get('feeds') || [];
    const filtered = feeds.filter(f => f.url !== url);
    store.set('feeds', filtered);
}
