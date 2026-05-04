const { getStore } = require('@netlify/blobs');

let store = null;
try {
    store = getStore({
        name: 'user-data',
        siteID: process.env.SITE_ID,
        token: process.env.BLOB_TOKEN
    });
} catch (err) {
    store = null;
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

                // Handle pagination for feeds
                const offset = parseInt(event.queryStringParameters?.offset) || 0;
                const limit = parseInt(event.queryStringParameters?.limit) || 50;

                if (data.feeds && Array.isArray(data.feeds)) {
                    const total = data.feeds.length;
                    const paginatedFeeds = data.feeds.slice(offset, offset + limit);
                    return send(200, {
                        feeds: paginatedFeeds,
                        total,
                        offset,
                        limit,
                        hasMore: offset + limit < total,
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

            // If client provides lastSync, only proceed if server has newer data
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
                clientLastSync,
                serverUpdatedAt,
                serverUpdatedAtRaw: serverData.updatedAt,
                serverHasData,
                feedsCount: serverData.feeds?.length || 0
            });

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
            
            console.log('[store] Proceeding with write');

            const feedUrl = event.queryStringParameters?.feedUrl;

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

if (data.action === 'markAllRead') {
                         if (existingFeeds[feedIndex].items) {
                             for (const item of existingFeeds[feedIndex].items) {
                                 item.unread = false;
                             }
                         }
                         const updatedAt = new Date().toISOString();
                         await store.setJSON(userId, { feeds: existingFeeds, updatedAt });
                         return send(200, { success: true, updatedAt });
                     }

                     if (data.action === 'markItemRead' || data.action === 'markItemUnread') {
                         const isRead = data.action === 'markItemRead';
                         if (existingFeeds[feedIndex].items && data.itemLink) {
                             for (const item of existingFeeds[feedIndex].items) {
                                 if (item.link === data.itemLink) {
                                     item.unread = !isRead;
                                     break;
                                 }
                             }
                         }
                         const updatedAt = new Date().toISOString();
                         await store.setJSON(userId, { feeds: existingFeeds, updatedAt });
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
                            
                            // Create set of existing item IDs (prefer guid, fall back to link)
                            const existingIds = new Set(
                                existingFeed.items.map(item => item.guid || item.link)
                            );
                            
                            // Add only new items
                            for (const item of incomingFeed.items) {
                                const itemId = item.guid || item.link;
                                if (itemId && !existingIds.has(itemId)) {
                                    existingFeed.items.push(item);
                                    existingIds.add(itemId);
                                }
                            }
                        }
                    }
                }
                
// Save merged feeds with timestamp
                 const updatedAt = serverData.updatedAt || new Date().toISOString();
                 await store.setJSON(userId, { feeds: existingFeeds, updatedAt });
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
