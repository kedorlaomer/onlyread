const { getStore } = require('@netlify/blobs');
const zlib = require('zlib');

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
        'Access-Control-Allow-Headers': 'Content-Type, X-Compressed',
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
            let body = event.body || '{}';
            
            // Handle compressed data
            if (event.headers['x-compressed'] === 'gzip') {
                try {
                    const parsed = JSON.parse(body);
                    if (parsed.compressed && parsed.data) {
                        body = zlib.inflateSync(Buffer.from(parsed.data, 'base64')).toString();
                    }
                } catch (e) {
                    return send(400, { error: 'Failed to decompress: ' + e.message });
                }
            }
            
            let data;
            try {
                data = JSON.parse(body);
            } catch (e) {
                return send(400, { error: 'Invalid JSON', bodyLength: body?.length });
            }
            try {
                await store.setJSON(userId, data);
                return send(200, { success: true, size: JSON.stringify(data).length });
            } catch (e) {
                return send(500, { error: e.message, stack: e.stack });
            }
        }

        return send(405, { error: 'Method not allowed' });
    } catch (error) {
        return send(500, { error: error.message });
    }
};
