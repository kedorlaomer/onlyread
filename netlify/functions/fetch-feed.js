exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    const send = (code, data) => ({ statusCode: code, headers, body: JSON.stringify(data) });

    if (event.httpMethod === 'OPTIONS') return send(200, {});

    const url = event.queryStringParameters?.url;
    if (!url) {
        return send(400, { error: 'Missing url parameter' });
    }

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'OnlyRead/1.0'
            }
        });

        const text = await response.text();
        const contentType = response.headers.get('content-type') || '';

        return send(200, {
            text,
            contentType
        });
    } catch (error) {
        return send(500, { error: error.message });
    }
};
