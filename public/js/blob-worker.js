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
let syncVersion = 0;

async function syncToBlob(data) {
    if (!userId || !blobAvailable) return;

    syncVersion++;
    const currentVersion = syncVersion;
    
    const dataString = JSON.stringify(data);
    const dataSize = dataString.length;
    log('syncToBlob called, data size:', dataSize, 'keys:', Object.keys(data), 'version:', currentVersion);
    
    const keys = Object.keys(data);
    let batchCount = 0;
    
    for (const key of keys) {
        const value = data[key];
        
        if (key === 'feeds' && Array.isArray(value)) {
            // Split feeds array into ~1MB chunks
            let currentBatch = [];
            let currentBatchSize = 0;
            
            for (const feed of value) {
                const feedSize = JSON.stringify(feed).length;
                
                if (currentBatchSize + feedSize > BATCH_SIZE_BYTES && currentBatch.length > 0) {
                    batchCount++;
                    log('syncToBlob: sending batch', batchCount, 'with', currentBatch.length, 'feeds, size:', JSON.stringify(currentBatch).length, 'version:', currentVersion);
                    
                    try {
                        const response = await fetch(`/.netlify/functions/store/${userId}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ partial: true, version: currentVersion, data: { feeds: currentBatch } })
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
                
                currentBatch.push(feed);
                currentBatchSize += feedSize;
            }
            
            // Send remaining feeds
            if (currentBatch.length > 0) {
                batchCount++;
                log('syncToBlob: sending final batch', batchCount, 'with', currentBatch.length, 'feeds, size:', JSON.stringify(currentBatch).length, 'version:', currentVersion);
                
                try {
                    const response = await fetch(`/.netlify/functions/store/${userId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ partial: true, version: currentVersion, data: { feeds: currentBatch } })
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
            // Non-feeds data: send as-is (usually small)
            batchCount++;
            log('syncToBlob: sending', key, 'size:', JSON.stringify(value).length, 'version:', currentVersion);
            
            try {
                const response = await fetch(`/.netlify/functions/store/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ partial: true, version: currentVersion, data: { [key]: value } })
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
    
    log('syncToBlob: complete,', batchCount, 'batches sent, version:', currentVersion);
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
