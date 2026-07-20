const { getStore } = require('@netlify/blobs');

const READLATER_PREFIX = 'readlater:';
const READLATER_MAX_ITEMS = 1000;

// Project items to the minimal sync schema. Descriptions, enclosures, and other
// content fields are cached client-side; the blob doesn't need them. Exception:
// read-later items are manually saved, so their description is not re-fetchable
// from any source feed and must be persisted (also required to publish it in the
// outbound RSS feed).
const projectItem = (item, keepDescription) => {
    const out = { link: item.link };
    if (item.guid != null) out.guid = item.guid;
    if (item.title != null) out.title = item.title;
    if (item.pubDate != null) out.pubDate = item.pubDate;
    if (item.unread != null) out.unread = item.unread;
    if (keepDescription && item.description != null) out.description = item.description;
    return out;
};

const projectFeeds = (feeds) => {
    if (!Array.isArray(feeds)) return feeds;
    for (const feed of feeds) {
        const keepDescription = typeof feed.url === 'string' && feed.url.startsWith(READLATER_PREFIX);
        if (Array.isArray(feed.items)) feed.items = feed.items.map(i => projectItem(i, keepDescription));
    }
    return feeds;
};

// Read-later lists (readlater:* URLs) accumulate manually-saved items indefinitely,
// unlike RSS feeds which are naturally bounded by their source. Cap each such list
// to its newest MAX items, dropping the oldest by pubDate (set to the save time for
// these items). Regular feeds are left untouched.

const newShareToken = () =>
    (require('crypto').randomBytes(16).toString('hex'));

const trimReadLaterFeeds = (feeds) => {
    if (!Array.isArray(feeds)) return feeds;
    for (const feed of feeds) {
        if (!feed || typeof feed.url !== 'string' || !feed.url.startsWith(READLATER_PREFIX)) continue;
        if (!Array.isArray(feed.items) || feed.items.length <= READLATER_MAX_ITEMS) continue;
        // Sort newest-first by pubDate; unparseable dates sort last (treated as oldest).
        feed.items.sort((a, b) => {
            const ta = Date.parse(a.pubDate); const tb = Date.parse(b.pubDate);
            const va = Number.isFinite(ta) ? ta : -Infinity;
            const vb = Number.isFinite(tb) ? tb : -Infinity;
            return vb - va;
        });
        feed.items = feed.items.slice(0, READLATER_MAX_ITEMS);
    }
    return feeds;
};

let store = null;
let shareIndex = null;
try {
    store = getStore({
        name: 'user-data',
        siteID: process.env.SITE_ID,
        token: process.env.BLOB_TOKEN
    });
    // Maps a public share token -> { userId, listUrl } for outbound read-later feeds.
    shareIndex = getStore({
        name: 'share-index',
        siteID: process.env.SITE_ID,
        token: process.env.BLOB_TOKEN
    });
} catch (err) {
    store = null;
    shareIndex = null;
}

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    const send = (code, data) => ({ statusCode: code, headers, body: JSON.stringify(data) });

    if (event.httpMethod === 'OPTIONS') return send(200, {});

    const parts = event.path.split('/').filter(Boolean);
    const last = parts[parts.length - 1];

    if (last === 'store' || last === 'index') return send(200, { status: 'ok' });

    const userId = last;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
        return send(400, { error: 'Invalid user ID' });
    }

    if (!store) return send(500, { error: 'Blobs not configured' });

    try {
        if (event.httpMethod === 'GET') {
            try {
                const raw = await store.get(userId);
                let data = {};
                if (raw) {
                    try {
                        data = JSON.parse(raw);
                    } catch {
                        data = { _raw: raw };
                    }
                }

                // Handle pagination for feeds — paginate by byte size to stay under the
                // 6 MB Lambda response limit, regardless of the client's requested limit.
                const offset = parseInt(event.queryStringParameters?.offset) || 0;
                const MAX_PAGE_BYTES = 4 * 1024 * 1024; // 4 MB, safely under 6 MB limit

                if (data.feeds && Array.isArray(data.feeds)) {
                    const total = data.feeds.length;
                    const paginatedFeeds = [];
                    let pageBytes = 0;

                    for (let i = offset; i < data.feeds.length; i++) {
                        const sourceFeed = data.feeds[i];
                        const projectedFeed = {
                            ...sourceFeed,
                            items: Array.isArray(sourceFeed.items) ? sourceFeed.items.map(projectItem) : []
                        };
                        const feedJson = JSON.stringify(projectedFeed);
                        if (pageBytes + feedJson.length > MAX_PAGE_BYTES && paginatedFeeds.length > 0) break;
                        paginatedFeeds.push(projectedFeed);
                        pageBytes += feedJson.length;
                    }

                    return send(200, {
                        feeds: paginatedFeeds,
                        total,
                        offset,
                        hasMore: offset + paginatedFeeds.length < total,
                        updatedAt: data.updatedAt || null
                    });
                }

                return send(200, { ...data, updatedAt: data.updatedAt || null });
            } catch (e) {
                if (e.message.includes('not exist') || e.message.includes('404')) {
                    return send(200, { feeds: [], total: 0, offset: 0, limit: 50, hasMore: false, updatedAt: null });
                }
                return send(500, { error: e.message });
            }
        }

        if (event.httpMethod === 'PUT' || event.httpMethod === 'POST') {
            let data;
            try {
                data = JSON.parse(event.body);
            } catch (e) {
                return send(400, { error: 'Invalid JSON' });
            }

            const feedUrl = event.queryStringParameters?.feedUrl;

            // If client provides lastSync, only proceed if server has newer data
            // Note: Action requests (markItemUnread, markAllRead, etc.) bypass this check
            // because they are targeted updates, not full data sync
            const isActionRequest = !!(feedUrl && data.action);

            const clientLastSync = data.lastSync ? new Date(data.lastSync).getTime() : 0;

            let serverData = {};
            try {
                const raw = await store.get(userId);
                if (raw) {
                    serverData = JSON.parse(raw);
                }
            } catch (e) {
                // No existing data - safe to proceed
            }

            const serverUpdatedAt = serverData.updatedAt ? new Date(serverData.updatedAt).getTime() : 0;
            const serverHasData = serverData.feeds && serverData.feeds.length > 0;

            // DEBUG logging for conflict detection
            console.log('[store] Conflict check:', {
                isActionRequest,
                clientLastSync,
                serverUpdatedAt,
                serverUpdatedAtRaw: serverData.updatedAt,
                serverHasData,
                feedsCount: serverData.feeds?.length || 0
            });

            // Skip conflict check for action requests - they are targeted updates
            if (!isActionRequest) {
                // If client has NO lastSync (null/0), it means this is a fresh session that hasn't
                // confirmed server state yet. If server has any data, reject to force sync-from-blob first.
                // If client's lastSync is OLDER than server, the client has stale data
                // and should receive a 409 Conflict to trigger a sync-from-blob
                const shouldReject = (clientLastSync === 0 && serverHasData) || 
                    (clientLastSync > 0 && serverUpdatedAt > clientLastSync);
                
                console.log('[store] shouldReject:', shouldReject);
                
                if (shouldReject) {
                    // Generate a timestamp for the 409 response so client can track server state
                    const serverTimestamp = serverData.updatedAt || new Date().toISOString();
                    console.log('[store] Returning 409 Conflict - server has newer data, returning updatedAt:', serverTimestamp);
                    return send(409, { error: 'Server has newer data', updatedAt: serverTimestamp });
                }
            }
            
            if (!isActionRequest) {
                console.log('[store] Proceeding with write');
            }

            if (feedUrl && data.action) {
                try {
                    let existingFeeds = [];
                    try {
                        const raw = await store.get(userId);
                        if (raw) {
                            const parsed = JSON.parse(raw);
                            existingFeeds = parsed.feeds || [];
                        }
                    } catch (e) {
                        return send(404, { error: 'No existing data found' });
                    }

                    const feedIndex = existingFeeds.findIndex(f => f.url === feedUrl);
                    if (feedIndex === -1) {
                        return send(404, { error: 'Feed not found' });
                    }

if (data.action === 'deleteFeed') {
                         const removed = existingFeeds[feedIndex];
                         existingFeeds.splice(feedIndex, 1);
                         // Tear down any public share for this list.
                         if (shareIndex && removed && removed.shareToken) {
                             try { await shareIndex.delete(removed.shareToken); } catch (e) { /* ignore */ }
                         }
                         const updatedAt = new Date().toISOString();
                         await store.setJSON(userId, { feeds: projectFeeds(existingFeeds), updatedAt });
                         return send(200, { success: true, updatedAt });
                     }

                     if (data.action === 'publishList' || data.action === 'rotateListToken' || data.action === 'unpublishList') {
                         if (!feedUrl.startsWith(READLATER_PREFIX)) {
                             return send(400, { error: 'Only read-later lists can be shared' });
                         }
                         if (!shareIndex) {
                             return send(500, { error: 'Share index not configured' });
                         }
                         const feed = existingFeeds[feedIndex];
                         const oldToken = feed.shareToken || null;

                         if (data.action === 'unpublishList') {
                             feed.public = false;
                             delete feed.shareToken;
                             if (oldToken) { try { await shareIndex.delete(oldToken); } catch (e) { /* ignore */ } }
                         } else {
                             // publishList reuses an existing token; rotateListToken always mints a new one.
                             if (data.action === 'rotateListToken' && oldToken) {
                                 try { await shareIndex.delete(oldToken); } catch (e) { /* ignore */ }
                             }
                             if (data.action === 'rotateListToken' || !feed.shareToken) {
                                 feed.shareToken = newShareToken();
                             }
                             feed.public = true;
                             await shareIndex.setJSON(feed.shareToken, { userId, listUrl: feedUrl });
                         }

                         const updatedAt = new Date().toISOString();
                         await store.setJSON(userId, { feeds: projectFeeds(existingFeeds), updatedAt });
                         return send(200, {
                             success: true,
                             updatedAt,
                             public: !!feed.public,
                             shareToken: feed.shareToken || null
                         });
                     }

                     if (data.action === 'markAllRead') {
                         if (existingFeeds[feedIndex].items) {
                             for (const item of existingFeeds[feedIndex].items) {
                                 item.unread = false;
                             }
                         }
                         const updatedAt = new Date().toISOString();
                         await store.setJSON(userId, { feeds: projectFeeds(existingFeeds), updatedAt });
                         return send(200, { success: true, updatedAt });
                     }

                     if (data.action === 'markItemRead' || data.action === 'markItemUnread') {
                         const isRead = data.action === 'markItemRead';
                         if (!data.itemLink && !data.itemGuid) {
                             return send(400, { error: 'itemLink or itemGuid is required' });
                         }
                         const wantGuid = data.itemGuid ?? null;
                         let matched = false;
                         if (existingFeeds[feedIndex].items) {
                             for (const item of existingFeeds[feedIndex].items) {
                                 // Canonical identity is guid||link: match on guid when the
                                 // client sends one, else fall back to link. When a guid is
                                 // given, match guid ONLY — link is not unique (some feeds carry
                                 // several items sharing a link via distinct guids), so a link
                                 // fallback could hit the wrong colliding-link item first.
                                 const hit = wantGuid != null
                                     ? item.guid === wantGuid
                                     : (data.itemLink != null && item.link === data.itemLink);
                                 if (hit) {
                                     item.unread = !isRead;
                                     matched = true;
                                     break;
                                 }
                             }
                         }
                         if (!matched) {
                             return send(404, { error: 'Item not found' });
                         }
                         const updatedAt = new Date().toISOString();
                         await store.setJSON(userId, { feeds: projectFeeds(existingFeeds), updatedAt });
                         return send(200, { success: true, updatedAt });
                     }

                    return send(400, { error: 'Unknown action' });
                } catch (e) {
                    return send(500, { error: e.message });
                }
            }

            try {
                // Get existing feeds
                let existingFeeds = [];
                try {
                    const raw = await store.get(userId);
                    if (raw) {
                        const parsed = JSON.parse(raw);
                        existingFeeds = parsed.feeds || [];
                    }
                } catch (e) {
                    // No existing data
                }
                
                // Build a map of existing feeds by URL for quick lookup
                const existingFeedMap = new Map();
                for (const feed of existingFeeds) {
                    if (feed.url) {
                        existingFeedMap.set(feed.url, feed);
                    }
                }
                
                // Process incoming feeds
                if (data.feeds && Array.isArray(data.feeds)) {
                    for (const incomingFeed of data.feeds) {
                        if (!incomingFeed.url) continue;
                        
                        const existingFeed = existingFeedMap.get(incomingFeed.url);
                        
                        if (!existingFeed) {
                            // Feed doesn't exist - add it
                            existingFeeds.push(incomingFeed);
                            existingFeedMap.set(incomingFeed.url, incomingFeed);
                        } else {
                            // Feed exists - merge items
                            if (!existingFeed.items) {
                                existingFeed.items = [];
                            }
                            if (!incomingFeed.items) {
                                incomingFeed.items = [];
                            }
                            
                            // Map existing items by canonical id (prefer guid, fall back to link)
                            const existingById = new Map();
                            for (const item of existingFeed.items) {
                                const id = item.guid || item.link;
                                if (id) existingById.set(id, item);
                            }
                            
                            // Add new items; for items that already exist by guid, refresh the
                            // stored link when the publisher moved the item to a new URL so the
                            // blob and client converge on the current link.
                            for (const item of incomingFeed.items) {
                                const itemId = item.guid || item.link;
                                if (!itemId) continue;
                                const existing = existingById.get(itemId);
                                if (!existing) {
                                    existingFeed.items.push(item);
                                    existingById.set(itemId, item);
                                } else if (item.link && existing.link !== item.link) {
                                    existing.link = item.link;
                                }
                            }
                        }
                    }
                }
                
// Save merged feeds with timestamp
                 const updatedAt = new Date().toISOString();
                 await store.setJSON(userId, { feeds: projectFeeds(trimReadLaterFeeds(existingFeeds)), updatedAt });
                 return send(200, { success: true, feedCount: existingFeeds.length, updatedAt });
            } catch (e) {
                return send(500, { error: e.message });
            }
        }

        return send(405, { error: 'Method not allowed' });
    } catch (error) {
        return send(500, { error: error.message });
    }
};
