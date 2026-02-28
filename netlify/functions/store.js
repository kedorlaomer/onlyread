const { getStore } = require('@netlify/blobs');

const store = getStore({
    name: 'user-data',
    siteID: process.env.SITE_ID,
    token: process.env.BLOB_TOKEN
});

console.log('Store initialized, SITE_ID:', process.env.SITE_ID, 'has token:', !!process.env.NETLIFY_BLOBS_TOKEN);

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
    console.log('Full path:', event.path, 'Parts:', pathParts);

    // Health check endpoint - no userId required
    if (pathParts.length === 1 && pathParts[0] === 'store') {
        console.log('Health check hit');
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok' }) };
    }

    if (pathParts.length === 2 && pathParts[0] === 'store') {
        console.log('Health check hit (2 parts)');
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok' }) };
    }

    const userId = pathParts[pathParts.length - 1];

    if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid or missing user ID' }) };
    }

    try {
        if (event.httpMethod === 'GET') {
            const data = await store.get(userId, { type: 'json' });
            return { statusCode: 200, headers, body: JSON.stringify(data || {}) };
        }

        if (event.httpMethod === 'PUT' || event.httpMethod === 'POST') {
            const data = JSON.parse(event.body);
            await store.set(userId, data);
            return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
