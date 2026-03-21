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
                return send(200, data);
            } catch (e) {
                if (e.message.includes('not exist') || e.message.includes('404')) {
                    return send(200, {});
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
                let existingData = { feeds: [] };
                let existingVersion = 0;
                
                try {
                    const raw = await store.get(userId);
                    if (raw) {
                        const parsed = JSON.parse(raw);
                        existingData = { feeds: parsed.feeds || [] };
                        existingVersion = parsed._version || 0;
                    }
                } catch (e) {
                    // No existing data
                }
                
                // Check version - if incoming version <= stored version, skip
                if (data.version && data.version <= existingVersion) {
                    log('Skipping stale update: incoming version', data.version, '<= stored version', existingVersion);
                    return send(200, { success: true, skipped: true });
                }
                
                let merged = { feeds: existingData.feeds || [] };
                
                if (data.partial && data.data) {
                    for (const [key, value] of Object.entries(data.data)) {
                        if (key === 'feeds' && Array.isArray(value)) {
                            merged.feeds = [...merged.feeds, ...value];
                        } else {
                            merged[key] = value;
                        }
                    }
                }
                
                // Store with version
                merged._version = data.version || 1;
                
                await store.setJSON(userId, merged);
                return send(200, { success: true, version: merged._version });
            } catch (e) {
                return send(500, { error: e.message });
            }
        }

        return send(405, { error: 'Method not allowed' });
    } catch (error) {
        return send(500, { error: error.message });
    }
};
