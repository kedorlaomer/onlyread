const DEBUG = true;
function log(...args) {
    if (DEBUG) console.log('[BlobWorker]', ...args);
}

let blobClient = null;
let userId = null;
let syncInterval = null;

function validateUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

async function syncFromBlob() {
    if (!blobClient || !userId) return;

    try {
        const data = await blobClient.getJSON(userId);
        if (data) {
            self.postMessage({ type: 'syncFromBlob', data });
            log('Synced from blob:', Object.keys(data));
        }
    } catch (e) {
        log('Error syncing from blob:', e);
    }
}

async function syncToBlob(data) {
    if (!blobClient || !userId) return;

    try {
        await blobClient.setJSON(userId, data);
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
            const { Blob } = await import('@netlify/blobs');
            blobClient = new Blob('user-data', { siteId: payload.siteId });
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
