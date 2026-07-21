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

// Pick the richest description for an item/entry. Feeds vary in where the real
// content lives: RSS uses description or the namespaced content:encoded; Atom uses
// content, summary, or media:description. Some also carry a placeholder in one
// field (e.g. Substack's description is literally "..." while content:encoded holds
// the full post; YouTube's media:content is an empty pointer). Choosing the longest
// non-blank candidate sidesteps all of these without per-feed special-casing.
function pickDescription(el, tagNames) {
    let best = null;
    let bestLen = 0;
    for (const tag of tagNames) {
        const candidates = tag.includes(':')
            ? el.getElementsByTagName(tag)
            : el.querySelectorAll(tag);
        for (const node of candidates) {
            const text = node.textContent;
            const len = text ? text.trim().length : 0;
            if (len > bestLen) { bestLen = len; best = text; }
        }
    }
    return best ? unescapeXml(best) : null;
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
            const description = pickDescription(item, ['description', 'content:encoded']);
            
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
        // querySelector('content') also matches media:content (an empty media pointer)
        // in YouTube feeds, so pickDescription's longest-non-blank rule is what lets
        // the real description win over such placeholders.
        const description = pickDescription(entry, ['content', 'summary', 'media:description']);
        
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

// Reserved pseudo-feeds holding manually-saved "read later" items. Their sentinel
// URLs share the readlater: scheme (non-http(s)), so they never collide with real
// feeds and are skipped anywhere we only act on fetchable feeds (the fetch worker,
// OPML/text export). The default list is readlater:local; more can be created.
export const READLATER_URL = 'readlater:local';
export const READLATER_TITLE = 'Read Later';
export const READLATER_PREFIX = 'readlater:';

function hashLink(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash = hash & hash;
    }
    return 'readlater:' + Math.abs(hash).toString(36);
}

// Derive a sentinel URL for a new named list from its title.
export function readLaterUrlForName(name) {
    const slug = name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug ? READLATER_PREFIX + slug : null;
}

// All read-later lists currently in the store, as { url, title }. Always includes
// the default list even before anything is saved to it.
export function getReadLaterLists(store) {
    const feeds = store.get('feeds');
    const lists = (Array.isArray(feeds) ? feeds : [])
        .filter(f => typeof f.url === 'string' && f.url.startsWith(READLATER_PREFIX))
        .map(f => ({ url: f.url, title: f.title || f.url }));
    if (!lists.some(l => l.url === READLATER_URL)) {
        lists.unshift({ url: READLATER_URL, title: READLATER_TITLE });
    }
    return lists;
}

// Save a manually-entered item into a read-later list. link is required; title and
// description are optional. listUrl/listTitle select the target list (defaulting to
// the standard Read Later list), creating it if absent. Deduped by a hash of the
// link so saving the same URL twice into the same list is a no-op. The item flows
// into the normal Read stream via sync.
export function addReadLaterItem(link, title, description, store, listUrl = READLATER_URL, listTitle = READLATER_TITLE) {
    if (!validateUrl(link)) {
        return { success: false, error: 'Invalid URL' };
    }
    if (typeof listUrl !== 'string' || !listUrl.startsWith(READLATER_PREFIX)) {
        return { success: false, error: 'Invalid list' };
    }
    const feeds = store.get('feeds');
    const currentFeeds = Array.isArray(feeds) ? feeds : [];

    let feed = currentFeeds.find(f => f.url === listUrl);
    if (!feed) {
        feed = { url: listUrl, title: listTitle || listUrl, items: [] };
        currentFeeds.push(feed);
    }
    if (!Array.isArray(feed.items)) feed.items = [];

    const guid = hashLink(link);
    if (feed.items.some(i => i.guid === guid)) {
        return { success: false, error: 'Already saved' };
    }

    feed.items.push({
        link,
        guid,
        title: title || null,
        description: description || null,
        pubDate: new Date().toUTCString(),
        unread: true,
        addedDate: new Date().toISOString()
    });
    store.set('feeds', currentFeeds);
    return { success: true };
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

// Cheap heuristic: does this look like a feed rather than an HTML page? Used to
// decide whether an entered URL is a feed or a site to run discovery on.
function looksLikeFeed(text, contentType = '') {
    const t = (text || '').trim().slice(0, 512).toLowerCase();
    return contentType.includes('xml') ||
           contentType.includes('rss') ||
           contentType.includes('atom') ||
           t.startsWith('<?xml') ||
           t.startsWith('<rss') ||
           t.startsWith('<feed');
}

// Confirm a URL actually parses as a feed with at least a recognizable structure,
// so we never offer a broken "feed" to the user. Returns the parsed feed title when
// available. Relies on the server-side fetch (fetch-feed) — remote content is never
// executed, only parsed.
async function probeFeed(url) {
    try {
        const { results, errors } = await fetchFeedBatch([url]);
        if (errors.length > 0) return { valid: false, error: errors[0].error };
        const data = results[0];
        if (!data || !data.text) return { valid: false, error: 'Failed to fetch feed' };
        if (!looksLikeFeed(data.text, data.contentType)) return { valid: false, error: 'Not an RSS feed' };
        // Actually parse it; a feed that yields no channel/entry structure is broken.
        const parsed = parseFeedItems(data.text);
        const hasFeedShape = /<rss[\s>]|<feed[\s>]/i.test(data.text) || parsed.items.length > 0;
        if (!hasFeedShape) return { valid: false, error: 'Not a valid feed' };
        return { valid: true, title: parsed.title || null };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

async function validateFeed(url) {
    const r = await probeFeed(url);
    return r.valid ? { valid: true } : { valid: false, error: r.error };
}

// Given a website (or feed) URL, discover subscribable feeds. Every candidate
// — declared <link rel=alternate> feeds and well-known fallback paths — is fetched
// and parsed server-side before being offered, so broken feeds are dropped.
// Returns { feeds: [{url, title}], direct } or { error }.
export async function discoverFeeds(url) {
    if (!validateUrl(url)) return { error: 'Invalid URL' };

    const { results, errors } = await fetchFeedBatch([url]);
    if (errors.length > 0) return { error: errors[0].error };
    const data = results[0];
    if (!data || !data.text) return { error: 'Failed to fetch page' };

    // Already a feed URL — confirm it parses, then offer directly.
    if (looksLikeFeed(data.text, data.contentType)) {
        const probe = await probeFeed(url);
        return probe.valid ? { feeds: [{ url, title: probe.title }], direct: true }
                           : { error: probe.error };
    }

    // Parse the HTML for advertised feeds: <link rel="alternate" type="...rss|atom...">
    const candidates = new Map(); // url -> declared title
    try {
        const doc = new DOMParser().parseFromString(data.text, 'text/html');
        for (const link of doc.querySelectorAll('link[rel~="alternate"]')) {
            const type = (link.getAttribute('type') || '').toLowerCase();
            if (!/rss|atom|xml/.test(type)) continue;
            const href = link.getAttribute('href');
            if (!href) continue;
            try {
                const abs = new URL(href, url).href;
                if (!candidates.has(abs)) candidates.set(abs, link.getAttribute('title') || null);
            } catch { /* skip malformed href */ }
        }
    } catch { /* HTML parse failure -> fall through to fallbacks */ }

    // Fallback: probe well-known paths when nothing was advertised.
    if (candidates.size === 0) {
        try {
            const origin = new URL(url);
            for (const path of ['/feed', '/rss.xml', '/feed.xml', '/atom.xml', '/rss', '/index.xml']) {
                candidates.set(new URL(path, origin.origin).href, null);
            }
        } catch { /* ignore */ }
    }

    // Validate every candidate; keep only those that actually parse as a feed.
    const feeds = [];
    for (const [candUrl, declaredTitle] of candidates) {
        const probe = await probeFeed(candUrl);
        if (probe.valid) feeds.push({ url: candUrl, title: declaredTitle || probe.title || null });
    }

    if (feeds.length === 0) return { feeds: [], error: 'No RSS feed found on this page' };
    return { feeds, direct: false };
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
${feeds.filter(f => /^https?:\/\//i.test(f.url)).map(f => `    <outline type="rss" xmlUrl="${escapeXml(f.url)}"/>`).join('\n')}
</body>
</opml>`;
    return opml;
}

export function exportFeedsAsText(store) {
    const feeds = getFeeds(store);
    return feeds.filter(f => /^https?:\/\//i.test(f.url)).map(f => f.url).join('\n');
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
