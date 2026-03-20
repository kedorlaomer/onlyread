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

const BATCH_SIZE_BYTES = 1024 * 1024; // 1MB

async function syncToBlob(data) {
    if (!userId || !blobAvailable) return;

    const dataString = JSON.stringify(data);
    const dataSize = dataString.length;
    log('syncToBlob called, data size:', dataSize);
    log('syncToBlob data keys:', Object.keys(data));
    
    // Send data in batches of ~1MB to avoid size limits
    const keys = Object.keys(data);
    let currentBatch = {};
    let currentBatchSize = 0;
    
    for (const key of keys) {
        const itemSize = JSON.stringify(data[key]).length;
        
        // If adding this item would exceed 1MB and we have items, send current batch
        if (currentBatchSize + itemSize > BATCH_SIZE_BYTES && Object.keys(currentBatch).length > 0) {
            log('syncToBlob: sending batch, size:', JSON.stringify(currentBatch).length, 'keys:', Object.keys(currentBatch).length);
            
            try {
                const response = await fetch(`/.netlify/functions/store/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ partial: true, data: currentBatch })
                });
                
                if (!response.ok) {
                    const text = await response.text();
                    log('syncToBlob batch error:', text);
                }
            } catch (e) {
                log('syncToBlob batch failed:', e.message);
            }
            
            currentBatch = {};
            currentBatchSize = 0;
        }
        
        // Add item to current batch
        currentBatch[key] = data[key];
        currentBatchSize += itemSize;
    }
    
    // Send remaining batch
    if (Object.keys(currentBatch).length > 0) {
        log('syncToBlob: sending final batch, size:', JSON.stringify(currentBatch).length, 'keys:', Object.keys(currentBatch).length);
        
        try {
            const response = await fetch(`/.netlify/functions/store/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ partial: true, data: currentBatch })
            });
            
            if (!response.ok) {
                const text = await response.text();
                log('syncToBlob batch error:', text);
            }
        } catch (e) {
            log('syncToBlob batch failed:', e.message);
        }
    }
    
    self.postMessage({ type: 'synced' });
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
