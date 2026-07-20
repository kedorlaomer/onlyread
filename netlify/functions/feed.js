const { getStore } = require('@netlify/blobs');

let store = null;
let shareIndex = null;
try {
    store = getStore({ name: 'user-data', siteID: process.env.SITE_ID, token: process.env.BLOB_TOKEN });
    shareIndex = getStore({ name: 'share-index', siteID: process.env.SITE_ID, token: process.env.BLOB_TOKEN });
} catch (err) {
    store = null;
    shareIndex = null;
}

const escapeXml = (str) => String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// CDATA-wrap free-form HTML, guarding against a literal ]]> terminator.
const cdata = (str) => `<![CDATA[${String(str == null ? '' : str).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

exports.handler = async (event) => {
    const notFound = { statusCode: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not found' };

    // Token may arrive as a query param (direct call) or in the path (pretty
    // /feed/<token> rewrite); accept either.
    const pathToken = (event.path || '').split('/').filter(Boolean).pop();
    const token = event.queryStringParameters?.token || pathToken;
    if (!token || !/^[0-9a-f]{8,}$/i.test(token)) return notFound;
    if (!store || !shareIndex) return { statusCode: 500, body: 'Not configured' };

    let entry;
    try {
        const raw = await shareIndex.get(token);
        if (!raw) return notFound;
        entry = JSON.parse(raw);
    } catch (e) {
        return notFound;
    }

    let feed;
    try {
        const raw = await store.get(entry.userId);
        if (!raw) return notFound;
        const data = JSON.parse(raw);
        feed = (data.feeds || []).find(f => f.url === entry.listUrl);
    } catch (e) {
        return notFound;
    }

    // Only serve a list that still exists and is still marked public with this token.
    if (!feed || !feed.public || feed.shareToken !== token) return notFound;

    const self = `https://${event.headers?.host || 'onlyread.netlify.app'}/feed/${token}`;
    const items = Array.isArray(feed.items) ? feed.items : [];

    const itemsXml = items.map(item => {
        const parts = ['<item>'];
        if (item.title != null) parts.push(`<title>${escapeXml(item.title)}</title>`);
        if (item.link != null) parts.push(`<link>${escapeXml(item.link)}</link>`);
        const guid = item.guid || item.link;
        if (guid != null) parts.push(`<guid isPermaLink="false">${escapeXml(guid)}</guid>`);
        if (item.pubDate != null) parts.push(`<pubDate>${escapeXml(item.pubDate)}</pubDate>`);
        if (item.description != null) parts.push(`<description>${cdata(item.description)}</description>`);
        parts.push('</item>');
        return parts.join('');
    }).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${escapeXml(feed.title || 'Read Later')}</title>
<link>${escapeXml(self)}</link>
<description>${escapeXml('Shared read-later list from OnlyRead')}</description>
${itemsXml}
</channel>
</rss>`;

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/rss+xml; charset=utf-8',
            // Let clients cache briefly, but keep the CDN copy revalidated so a
            // rotate/unpublish takes effect promptly rather than lingering 15 min.
            'Cache-Control': 'public, max-age=300',
            'Netlify-CDN-Cache-Control': 'public, max-age=0, must-revalidate',
            'Access-Control-Allow-Origin': '*'
        },
        body: xml
    };
};
