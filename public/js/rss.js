const DEBUG = false;
function log(...args) {
    if (DEBUG) console.log('[RSS]', ...args);
}

const BATCH_DELAY_MS = 500;
let fetchQueue = [];
let fetchTimeout = null;
const fetchResolvers = new Map();

async function fetchQueuedFeeds() {
    if (fetchQueue.length === 0) return;
    
    const urls = [...fetchQueue];
    const resolvers = urls.map(url => fetchResolvers.get(url)).filter(Boolean);
    fetchQueue = [];
    fetchResolvers.clear();
    
    try {
        const proxyUrl = `/.netlify/functions/fetch-feed?urls=${encodeURIComponent(JSON.stringify(urls))}`;
        const response = await fetch(proxyUrl);
        
        if (!response.ok) {
            resolvers.forEach(r => r({}));
            return;
        }
        
        const data = await response.json();
        
        if (data.results) {
            const resultMap = new Map(data.results.map(r => [r.url, r]));
            resolvers.forEach((resolve, i) => {
                const result = resultMap.get(urls[i]);
                resolve(result || null);
            });
        } else if (data.url) {
            resolvers[0]?.(data);
        }
    } catch (e) {
        log('Batch fetch error:', e);
        resolvers.forEach(r => r(null));
    }
}

function queueFeedFetch(url) {
    return new Promise((resolve) => {
        fetchQueue.push(url);
        fetchResolvers.set(url, resolve);
        
        if (fetchTimeout) clearTimeout(fetchTimeout);
        fetchTimeout = setTimeout(fetchQueuedFeeds, BATCH_DELAY_MS);
    });
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

    const validation = await validateFeed(url);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }

    const feeds = store.get('feeds');
    const currentFeeds = Array.isArray(feeds) ? feeds : [];

    if (currentFeeds.some(f => f.url === url)) {
        return { success: false, error: 'Feed already subscribed' };
    }

    currentFeeds.push({ url });
    store.set('feeds', currentFeeds);

    return { success: true };
}

async function validateFeed(url) {
    try {
        const data = await queueFeedFetch(url);
        if (!data || !data.text) {
            return { valid: false, error: 'Failed to fetch feed' };
        }
        
        const contentType = data.contentType || '';
        const text = data.text;

        const isRss = contentType.includes('xml') || 
                      contentType.includes('rss') || 
                      contentType.includes('atom') ||
                      text.trim().startsWith('<?xml') ||
                      text.trim().startsWith('<rss') ||
                      text.trim().startsWith('<feed');

        if (!isRss) {
            return { valid: false, error: 'Not an RSS feed' };
        }

        return { valid: true };
    } catch (error) {
        return { valid: false, error: error.message };
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

export async function importFeeds(file, store, validate = true) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const text = e.target.result;
            let urls = [];

            if (file.name.toLowerCase().endsWith('.opml') || 
                file.name.toLowerCase().endsWith('.xml') ||
                text.includes('<opml') ||
                text.includes('<outline')) {
                urls = extractUrlsFromOpml(text);
            } else {
                urls = extractUrlsFromText(text);
            }

            if (urls.length === 0) {
                resolve({ success: false, error: 'No valid URLs found' });
                return;
            }

            const feeds = store.get('feeds');
            const currentFeeds = Array.isArray(feeds) ? feeds : [];
            let added = 0;
            let skipped = 0;
            let invalid = 0;

            for (const url of urls) {
                if (currentFeeds.some(f => f.url === url)) {
                    skipped++;
                } else if (validate) {
                    const validation = await validateFeed(url);
                    if (validation.valid) {
                        currentFeeds.push({ url });
                        added++;
                    } else {
                        invalid++;
                    }
                } else {
                    currentFeeds.push({ url });
                    added++;
                }
            }

            store.set('feeds', currentFeeds);
            resolve({ success: true, added, skipped, invalid });
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

function escapeXml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function exportFeedsAsOpml(store) {
    const feeds = getFeeds(store);
    const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
<head>
    <title>OnlyRead Feeds</title>
</head>
<body>
${feeds.map(f => `    <outline type="rss" xmlUrl="${escapeXml(f.url)}"/>`).join('\n')}
</body>
</opml>`;
    return opml;
}

export function exportFeedsAsText(store) {
    const feeds = getFeeds(store);
    return feeds.map(f => f.url).join('\n');
}

export async function fetchFeedItems(feedUrl) {
    try {
        const data = await queueFeedFetch(feedUrl);
        if (!data || !data.text) {
            return [];
        }
        const text = data.text;
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'application/xml');
        
        const items = [];
        
        // Try RSS 2.0 format
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
        
        // Try Atom format
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

export function addItemsToFeed(feedUrl, newItems, store) {
    const feeds = store.get('feeds');
    if (!Array.isArray(feeds)) return;
    
    const feedIndex = feeds.findIndex(f => f.url === feedUrl);
    if (feedIndex === -1) return;
    
    if (!feeds[feedIndex].items) {
        feeds[feedIndex].items = [];
    }
    
    const existingLinks = new Set(feeds[feedIndex].items.map(i => i.link));
    
    for (const item of newItems) {
        if (!existingLinks.has(item.link)) {
            feeds[feedIndex].items.push(item);
        }
    }
    
    store.set('feeds', feeds);
}

export function updateFeedMeta(feedUrl, title, link, store) {
    const feeds = store.get('feeds');
    if (!Array.isArray(feeds)) return;
    
    const feedIndex = feeds.findIndex(f => f.url === feedUrl);
    if (feedIndex === -1) return;
    
    if (title) feeds[feedIndex].title = title;
    if (link) feeds[feedIndex].link = link;
    
    store.set('feeds', feeds);
}
