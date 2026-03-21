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
    log('syncToBlob called, data size:', dataSize, 'keys:', Object.keys(data));
    
    const keys = Object.keys(data);
    let batchCount = 0;
    
    for (const key of keys) {
        const value = data[key];
        
        if (key === 'feeds' && Array.isArray(value)) {
            // Split feeds array into ~1MB chunks, sending each feed individually
            let currentBatch = [];
            let currentBatchSize = 0;
            
            for (const feed of value) {
                const feedSize = JSON.stringify(feed).length;
                
                // If adding this feed would exceed 1MB and we have items, send current batch
                if (currentBatchSize + feedSize > BATCH_SIZE_BYTES && currentBatch.length > 0) {
                    batchCount++;
                    log('syncToBlob: sending batch', batchCount, 'with', currentBatch.length, 'feeds, size:', JSON.stringify(currentBatch).length);
                    
                    try {
                        const response = await fetch(`/.netlify/functions/store/${userId}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ feeds: currentBatch })
                        });
                        
                        if (!response.ok) {
                            const text = await response.text();
                            log('syncToBlob batch error:', text);
                        }
                    } catch (e) {
                        log('syncToBlob batch failed:', e.message);
                    }
                    
                    currentBatch = [];
                    currentBatchSize = 0;
                }
                
                // Add feed to current batch
                currentBatch.push(feed);
                currentBatchSize += feedSize;
            }
            
            // Send remaining feeds
            if (currentBatch.length > 0) {
                batchCount++;
                log('syncToBlob: sending final batch', batchCount, 'with', currentBatch.length, 'feeds, size:', JSON.stringify(currentBatch).length);
                
                try {
                    const response = await fetch(`/.netlify/functions/store/${userId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ feeds: currentBatch })
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
            // Non-feeds data: send as-is
            log('syncToBlob: sending', key);
            
            try {
                const response = await fetch(`/.netlify/functions/store/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ [key]: value })
                });
                
                if (!response.ok) {
                    const text = await response.text();
                    log('syncToBlob error:', text);
                }
            } catch (e) {
                log('syncToBlob failed:', e.message);
            }
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
