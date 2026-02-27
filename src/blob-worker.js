const DEBUG = true;
function log(...args) {
    if (DEBUG) console.log('[BlobWorker]', ...args);
}

let userId = null;
let siteId = null;
let syncInterval = null;

function validateUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

function getBlobURL(key) {
    return `/.netlify/blobs/user-data/${key}.json`;
}

async function fetchBlob(key, options = {}) {
    const url = getBlobURL(key);
    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        }
    });
    if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Blob fetch failed: ${response.status}`);
    }
    return response.json();
}

async function syncFromBlob() {
    if (!userId) return;

    try {
        const data = await fetchBlob(userId);
        if (data) {
            self.postMessage({ type: 'syncFromBlob', data });
            log('Synced from blob:', Object.keys(data));
        }
    } catch (e) {
        log('Error syncing from blob:', e);
    }
}

async function syncToBlob(data) {
    if (!userId) return;

    try {
        await fetchBlob(userId, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
        log('Synced to blob:', Object.keys(data));
        self.postMessage({ type: 'synced' });
    } catch (e) {
        log('Error syncing to blob:', e);
    }
}

function startSync() {
    if (syncInterval) return;
    syncInterval = setInterval(async () => {
        self.postMessage({ type: 'requestData' });
    }, 60000);
    log('Started sync interval');
}

function stopSync() {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
}

self.onmessage = async function(e) {
    const { type, payload } = e.data;

    switch (type) {
        case 'init':
            userId = payload.userId;
            siteId = payload.siteId;
            log('Worker initialized with userId:', userId);
            await syncFromBlob();
            startSync();
            self.postMessage({ type: 'ready' });
            break;

        case 'sync':
            await syncToBlob(payload.data);
            break;

        case 'stop':
            stopSync();
            self.postMessage({ type: 'stopped' });
            break;
    }
};
