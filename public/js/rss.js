import { fetchFeedBatch } from './fetch-feed.js';

function unescapeXml(text) {
    if (!text) return null;
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

export function parseFeedItems(text) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'application/xml');
    
    const items = [];
    
    const channel = xml.querySelector('channel');
    const feedTitle = channel?.querySelector('title')?.textContent || null;
    const feedLinkEl = channel?.querySelector('link');
    const feedLink = feedLinkEl?.textContent || feedLinkEl?.getAttribute('href') || null;
    
    const rssItems = xml.querySelectorAll('item');
    if (rssItems.length > 0) {
        for (const item of rssItems) {
            const link = item.querySelector('link')?.textContent || '';
            const guid = item.querySelector('guid')?.textContent || null;
            const title = item.querySelector('title')?.textContent || null;
            const pubDate = item.querySelector('pubDate')?.textContent || null;
            const enclosure = item.querySelector('enclosure')?.getAttribute('url') || null;
            const descriptionEl = item.querySelector('description');
            const description = descriptionEl ? unescapeXml(descriptionEl.textContent) : null;
            
            if (link) {
                items.push({
                    link,
                    guid,
                    title,
                    pubDate,
                    enclosure,
                    description,
                    unread: true,
                    addedDate: new Date().toISOString()
                });
            }
        }
        return { items, title: feedTitle, link: feedLink };
    }
    
    const atomFeed = xml.querySelector('feed');
    const atomTitle = atomFeed?.querySelector('title')?.textContent || feedTitle;
    const atomLinkEl = atomFeed?.querySelector('link[rel="alternate"]') || atomFeed?.querySelector('link');
    const atomLink = atomLinkEl?.getAttribute('href') || feedLink;
    
    const atomEntries = xml.querySelectorAll('entry');
    for (const entry of atomEntries) {
        const linkEl = entry.querySelector('link[rel="alternate"]') || entry.querySelector('link');
        const link = linkEl?.getAttribute('href') || '';
        const guid = entry.querySelector('id')?.textContent || null;
        const pubDate = entry.querySelector('published')?.textContent || 
                       entry.querySelector('updated')?.textContent || null;
        const title = entry.querySelector('title')?.textContent || null;
        const enclosure = entry.querySelector('enclosure')?.getAttribute('url') || null;
        const descriptionEl = entry.querySelector('content') || entry.querySelector('summary');
        // Fall back to media:description (e.g. YouTube feeds have neither content nor
        // summary). The namespace prefix rules out a CSS selector, so match the
        // qualified tag name. media:description is plain text, not escaped HTML.
        const mediaDescEl = entry.getElementsByTagName('media:description')[0];
        const description = descriptionEl
            ? unescapeXml(descriptionEl.textContent)
            : (mediaDescEl ? mediaDescEl.textContent || null : null);
        
        if (link) {
            items.push({
                link,
                guid,
                title,
                pubDate,
                enclosure,
                description,
                unread: true,
                addedDate: new Date().toISOString()
            });
        }
    }
    
    return { items, title: atomTitle, link: atomLink };
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
        const { results, errors } = await fetchFeedBatch([url]);
        if (errors.length > 0) {
            return { valid: false, error: errors[0].error };
        }
        const data = results[0];
        
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

const BATCH_FETCH_SIZE = 10;

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

            // Filter out already-subscribed URLs
            const newUrls = urls.filter(url => !currentFeeds.some(f => f.url === url));
            skipped = urls.length - newUrls.length;

            if (validate && newUrls.length > 0) {
                // Batch fetch new URLs in chunks
                const validUrls = new Set();
                const invalidUrls = new Map();
                
                for (let i = 0; i < newUrls.length; i += BATCH_FETCH_SIZE) {
                    const chunk = newUrls.slice(i, i + BATCH_FETCH_SIZE);
                    const { results, errors } = await fetchFeedBatch(chunk);
                    
                    for (const result of results) {
                        if (result && result.text) {
                            const contentType = result.contentType || '';
                            const isRss = contentType.includes('xml') || 
                                          contentType.includes('rss') || 
                                          contentType.includes('atom') ||
                                          result.text.trim().startsWith('<?xml') ||
                                          result.text.trim().startsWith('<rss') ||
                                          result.text.trim().startsWith('<feed');
                            if (isRss) {
                                validUrls.add(result.feedUrl);
                            } else {
                                invalidUrls.set(result.feedUrl, 'Not an RSS feed');
                            }
                        }
                    }
                    for (const error of errors) {
                        invalidUrls.set(error.url, error.error);
                    }
                }

                for (const url of newUrls) {
                    if (validUrls.has(url)) {
                        currentFeeds.push({ url });
                        added++;
                    } else {
                        invalid++;
                    }
                }
            } else if (!validate) {
                for (const url of newUrls) {
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

export function addItemsToFeed(feedUrl, newItems, store) {
    const feeds = store.get('feeds');
    if (!Array.isArray(feeds)) return;
    
    const feedIndex = feeds.findIndex(f => f.url === feedUrl);
    if (feedIndex === -1) return;
    
    if (!feeds[feedIndex].items) {
        feeds[feedIndex].items = [];
    }
    
    // Canonical identity is guid||link so an item whose URL changed under a stable
    // guid updates the existing record instead of appearing as a new unread item.
    const idOf = (i) => i.guid || i.link;
    const existingById = new Map(feeds[feedIndex].items.map(i => [idOf(i), i]));
    
    let changed = false;
    
    for (const item of newItems) {
        const existingItem = existingById.get(idOf(item));
        if (!existingItem) {
            const added = { ...item, unread: item.unread };
            feeds[feedIndex].items.push(added);
            existingById.set(idOf(added), added);
            changed = true;
        } else {
            // Item already exists locally: preserve local read state, but fill in any
            // content fields that are missing (e.g. description on an item that arrived
            // from the server blob without one).
            for (const field of ['description', 'title', 'pubDate', 'enclosure', 'guid']) {
                if (existingItem[field] == null && item[field] != null) {
                    existingItem[field] = item[field];
                    changed = true;
                }
            }
            // Refresh the link when the publisher moved the item to a new URL.
            if (item.link && existingItem.link !== item.link) {
                existingItem.link = item.link;
                changed = true;
            }
        }
    }
    
    if (changed) {
        store.set('feeds', feeds);
    }
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
