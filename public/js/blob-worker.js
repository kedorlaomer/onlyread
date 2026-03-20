import pako from 'pako';

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
        blobAvailable = response.ok;
    } catch (e) {
        blobAvailable = false;
    }
}

async function syncFromBlob() {
    if (!userId || !blobAvailable) return;

    try {
        const response = await fetch(`/.netlify/functions/store/${userId}`);
        if (response.status === 404) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data && Object.keys(data).length > 0) {
            self.postMessage({ type: 'syncFromBlob', data });
        }
    } catch (e) {}
}

async function syncToBlob(data) {
    if (!userId || !blobAvailable) return;

    const dataString = JSON.stringify(data);
    const dataSize = dataString.length;
    log('syncToBlob called, data size:', dataSize);
    log('syncToBlob data keys:', Object.keys(data));
    
    // Netlify Blobs has ~4.5MB limit - compress if over 4MB
    if (dataSize > 4 * 1024 * 1024) {
        log('syncToBlob: data too large for blobs, compressing...');
        try {
            const compressed = pako.deflate(dataString);
            const base64 = btoa(String.fromCharCode.apply(null, compressed));
            const compressedSize = base64.length;
            log('syncToBlob: compressed from', dataSize, 'to', compressedSize);
            
            const response = await fetch(`/.netlify/functions/store/${userId}`, {
                method: 'PUT',
                headers: { 
                    'Content-Type': 'application/json',
                    'Content-Length': compressedSize.toString(),
                    'X-Compressed': 'gzip'
                },
                body: JSON.stringify({ compressed: true, data: base64 })
            });
            
            if (!response.ok) {
                const text = await response.text();
                log('syncToBlob compression error:', text);
                throw new Error(`HTTP ${response.status}`);
            }
            self.postMessage({ type: 'synced' });
            return;
        } catch (e) {
            log('syncToBlob compression failed:', e.message);
        }
    }
    
    try {
        log('syncToBlob: creating request...');
        const response = await fetch(`/.netlify/functions/store/${userId}`, {
            method: 'PUT',
            headers: { 
                'Content-Type': 'application/json',
                'Content-Length': dataSize.toString()
            },
            body: dataString
        });
        log('syncToBlob response:', response.status, response.statusText);
        if (!response.ok) {
            const text = await response.text();
            log('syncToBlob error body:', text);
            throw new Error(`HTTP ${response.status}: ${text}`);
        }
        self.postMessage({ type: 'synced' });
    } catch (e) {
        log('syncToBlob failed:', e.message);
    }
}

function startSync() {
    if (syncInterval) return;
    syncInterval = setInterval(() => {
        self.postMessage({ type: 'requestData' });
    }, 60000);
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
