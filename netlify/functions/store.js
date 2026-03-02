const { getStore } = require('@netlify/blobs');

let store = null;
try {
    store = getStore({
        name: 'user-data',
        siteID: process.env.SITE_ID,
        token: process.env.BLOB_TOKEN
    });
    console.log('Store init OK, SITE_ID:', process.env.SITE_ID);
} catch (err) {
    console.log('Store init failed:', err.message);
}

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    const sendResponse = (statusCode, data) => {
        return {
            statusCode,
            headers,
            body: JSON.stringify(data)
        };
    };

    if (event.httpMethod === 'OPTIONS') {
        return sendResponse(200, {});
    }

    const pathParts = event.path.split('/').filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1];

    // Health check
    if (lastPart === 'store' || lastPart === 'index') {
        return sendResponse(200, { status: 'ok' });
    }

    const userId = pathParts[pathParts.length - 1];
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (!userId || !uuidRegex.test(userId)) {
        return sendResponse(400, { error: 'Invalid user ID' });
    }

    if (!store) {
        return sendResponse(500, { error: 'Blobs not configured' });
    }

    try {
        if (event.httpMethod === 'GET') {
            let data = {};
            try {
                const result = await store.get(userId, { type: 'json' });
                data = (result !== undefined && result !== null) ? result : {};
                console.log('Got data:', JSON.stringify(data));
            } catch (e) {
                console.log('Get error:', e.message);
                if (e.message.includes('not exist') || e.message.includes('404')) {
                    data = {};
                } else {
                    return sendResponse(500, { error: 'Get failed: ' + e.message });
                }
            }
            return sendResponse(200, data);
        }

        if (event.httpMethod === 'PUT' || event.httpMethod === 'POST') {
            let data;
            try {
                data = JSON.parse(event.body);
            } catch (e) {
                return sendResponse(400, { error: 'Invalid JSON' });
            }
            await store.set(userId, data);
            return sendResponse(200, { success: true });
        }

        return sendResponse(405, { error: 'Method not allowed' });
    } catch (error) {
        console.log('Handler error:', error.message);
        return sendResponse(500, { error: error.message });
    }
};
