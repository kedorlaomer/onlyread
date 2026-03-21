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
                
                // Handle pagination
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
                        hasMore: offset + limit < total
                    });
                }
                
                return send(200, data);
            } catch (e) {
                if (e.message.includes('not exist') || e.message.includes('404')) {
                    return send(200, { feeds: [], total: 0, offset: 0, limit: 50, hasMore: false });
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
                
                // Save merged feeds
                await store.setJSON(userId, { feeds: existingFeeds });
                return send(200, { success: true, feedCount: existingFeeds.length });
            } catch (e) {
                return send(500, { error: e.message });
            }
        }

        return send(405, { error: 'Method not allowed' });
    } catch (error) {
        return send(500, { error: error.message });
    }
};
