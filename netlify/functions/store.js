const { getStore } = require('@netlify/blobs');

let store;
try {
    store = getStore({
        name: 'user-data',
        siteID: process.env.SITE_ID,
        token: process.env.BLOB_TOKEN
    });
    console.log('Store init OK, SITE_ID:', process.env.SITE_ID);
} catch (err) {
    console.log('Store init failed:', err.message);
    store = null;
}

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    const pathParts = event.path.split('/').filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1];
    const secondLastPart = pathParts[pathParts.length - 2];

    // Health check
    if (lastPart === 'store' || (lastPart === 'index' && secondLastPart === 'store')) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok' }) };
    }

    const userId = pathParts[pathParts.length - 1];
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (!userId || !uuidRegex.test(userId)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid user ID' }) };
    }

    if (!store) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Blobs not configured' }) };
    }

    try {
        if (event.httpMethod === 'GET') {
            let data = null;
            try {
                data = await store.get(userId, { type: 'json' });
            } catch (e) {
                console.log('Get error:', e.message);
                if (!e.message.includes('not exist') && !e.message.includes('404')) {
                    throw e;
                }
            }
            return { statusCode: 200, headers, body: JSON.stringify(data || {}) };
        }

        if (event.httpMethod === 'PUT' || event.httpMethod === 'POST') {
            const data = JSON.parse(event.body);
            await store.set(userId, data);
            return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    } catch (error) {
        console.log('Handler error:', error.message, error.stack);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
