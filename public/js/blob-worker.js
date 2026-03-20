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

const FEEDS_PER_BATCH = 50;

async function syncToBlob(data) {
    if (!userId || !blobAvailable) return;

    const dataString = JSON.stringify(data);
    const dataSize = dataString.length;
    log('syncToBlob called, data size:', dataSize, 'keys:', Object.keys(data));
    
    const keys = Object.keys(data);
    let currentBatch = {};
    let currentBatchSize = 0;
    let batchCount = 0;
    
    for (const key of keys) {
        const value = data[key];
        
        // For feeds array, batch by items
        if (key === 'feeds' && Array.isArray(value)) {
            const feedBatches = [];
            for (let i = 0; i < value.length; i += FEEDS_PER_BATCH) {
                feedBatches.push(value.slice(i, i + FEEDS_PER_BATCH));
            }
            
            log('syncToBlob: splitting feeds into', feedBatches.length, 'batches of ~', FEEDS_PER_BATCH);
            
            for (const feedBatch of feedBatches) {
                batchCount++;
                const batchData = { ...currentBatch, [key]: feedBatch };
                
                log('syncToBlob: sending batch', batchCount, 'with', feedBatch.length, 'feeds, size:', JSON.stringify(batchData).length);
                
                try {
                    const response = await fetch(`/.netlify/functions/store/${userId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ partial: true, data: batchData })
                    });
                    
                    if (!response.ok) {
                        const text = await response.text();
                        log('syncToBlob batch error:', text);
                    }
                } catch (e) {
                    log('syncToBlob batch failed:', e.message);
                }
            }
        } else {
            // Non-feeds data: use size-based batching
            const itemSize = JSON.stringify(value).length;
            
            if (currentBatchSize + itemSize > BATCH_SIZE_BYTES && Object.keys(currentBatch).length > 0) {
                batchCount++;
                log('syncToBlob: sending batch', batchCount, 'size:', JSON.stringify(currentBatch).length);
                
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
            
            currentBatch[key] = value;
            currentBatchSize += itemSize;
        }
    }
    
    // Send remaining non-feeds batch
    if (Object.keys(currentBatch).length > 0) {
        batchCount++;
        log('syncToBlob: sending final batch', batchCount, 'size:', JSON.stringify(currentBatch).length);
        
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
    
    log('syncToBlob: complete,', batchCount, 'batches sent');
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
