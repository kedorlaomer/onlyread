const DEBUG = true;
function log(...args) {
    if (DEBUG) console.log('[BlobWorker]', ...args);
}

let userId = null;
let siteId = null;
let syncInterval = null;
let blobAvailable = false;

function validateUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

async function checkBlobAvailability() {
    try {
        const response = await fetch('/.netlify/functions/store');
        blobAvailable = response.ok || response.status >= 400 && response.status < 500;
    } catch (e) {
        blobAvailable = false;
    }
    log('Blob available via function:', blobAvailable);
}

async function syncFromBlob() {
    if (!userId || !blobAvailable) return;

    try {
        const response = await fetch(`/.netlify/functions/store/${userId}`);
        if (response.status === 404) {
            log('No existing blob data (first time user)');
            return;
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        if (data && Object.keys(data).length > 0) {
            self.postMessage({ type: 'syncFromBlob', data });
            log('Synced from blob:', Object.keys(data));
        }
    } catch (e) {
        log('Blob sync from failed, using local only:', e.message);
    }
}

async function syncToBlob(data) {
    if (!userId || !blobAvailable) {
        log('Blob not available, local-only mode');
        return;
    }

    try {
        const response = await fetch(`/.netlify/functions/store/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        log('Synced to blob:', Object.keys(data));
        self.postMessage({ type: 'synced' });
    } catch (e) {
        log('Blob sync to failed, local-only mode:', e.message);
    }
}

function startSync() {
    if (syncInterval) return;
    syncInterval = setInterval(() => {
        self.postMessage({ type: 'requestData' });
    }, 60000);
    log('Started sync interval (local only if blob unavailable)');
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
            await checkBlobAvailability();
            log('Worker initialized with userId:', userId, 'blobAvailable:', blobAvailable);
            await syncFromBlob();
            startSync();
            self.postMessage({ type: 'ready', blobAvailable });
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
