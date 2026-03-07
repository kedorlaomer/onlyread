const DEBUG = true;
function log(...args) {
    if (DEBUG) console.log('[RSS]', ...args);
}

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

function extractUrlsFromOpml(text) {
    const urls = [];
    const regex = /https?:\/\/[^\s<>"']+/gi;
    const matches = text.match(regex);
    if (matches) {
        for (const url of matches) {
            const cleaned = url.replace(/[^\x20-\x7E]/g, '').trim();
            if (validateUrl(cleaned)) {
                urls.push(cleaned);
            }
        }
    }
    return urls;
}

function extractUrlsFromText(text) {
    const urls = [];
    const lines = text.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && validateUrl(trimmed)) {
            urls.push(trimmed);
        }
    }
    return urls;
}

export async function importFeeds(file, store) {
    log('Starting import, file:', file.name);
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            log('File read complete');
            const text = e.target.result;
            log('File content length:', text.length);
            let urls = [];

            if (file.name.toLowerCase().endsWith('.opml') || 
                file.name.toLowerCase().endsWith('.xml') ||
                text.includes('<opml') ||
                text.includes('<outline')) {
                log('Detected OPML file');
                urls = extractUrlsFromOpml(text);
            } else {
                log('Detected plain text file');
                urls = extractUrlsFromText(text);
            }

            log('Extracted URLs:', urls.length);

            if (urls.length === 0) {
                log('No valid URLs found');
                resolve({ success: false, error: 'No valid URLs found' });
                return;
            }

            const feeds = store.get('feeds');
            log('Current feeds:', feeds);
            if (!Array.isArray(feeds)) {
                log('Invalid feeds data, initializing empty array');
            }
            const currentFeeds = Array.isArray(feeds) ? feeds : [];
            let added = 0;
            let skipped = 0;

            for (const url of urls) {
                if (currentFeeds.some(f => f.url === url)) {
                    skipped++;
                } else {
                    currentFeeds.push({ url });
                    added++;
                }
            }

            log('Adding', added, 'feeds, skipping', skipped);
            store.set('feeds', currentFeeds);
            log('Feeds saved');
            resolve({ success: true, added, skipped });
        };
        reader.onerror = () => {
            resolve({ success: false, error: 'Failed to read file' });
        };
        reader.readAsText(file);
    });
}

export function getFeeds(store) {
    const data = store.get('feeds');
    if (Array.isArray(data)) {
        return data;
    }
    return [];
}

export function removeFeed(url, store) {
    const feeds = store.get('feeds');
    if (!Array.isArray(feeds)) {
        return;
    }
    const filtered = feeds.filter(f => f.url !== url);
    store.set('feeds', filtered);
}
