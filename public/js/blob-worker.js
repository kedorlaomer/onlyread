let userId = null;
let syncInterval = null;
let blobAvailable = false;
let isSyncing = false;

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
        let allFeeds = [];
        let offset = 0;
        const limit = 50;
        let hasMore = true;
        
        while (hasMore) {
            const response = await fetch(`/.netlify/functions/store/${userId}?offset=${offset}&limit=${limit}`);
            if (response.status === 404) return;
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            
            if (data.feeds && Array.isArray(data.feeds)) {
                allFeeds = allFeeds.concat(data.feeds);
                hasMore = data.hasMore;
                offset += limit;
            } else {
                hasMore = false;
            }
        }
        
        if (allFeeds.length > 0) {
            self.postMessage({ type: 'syncFromBlob', data: { feeds: allFeeds } });
        }
    } catch (e) {
    }
}

const BATCH_SIZE_BYTES = 1024 * 1024;

async function syncToBlob(data) {
    if (!userId || !blobAvailable) return;

    const keys = Object.keys(data);
    
    for (const key of keys) {
        const value = data[key];
        
        if (key === 'feeds' && Array.isArray(value)) {
            let currentBatch = [];
            let currentBatchSize = 0;
            
            for (const feed of value) {
                const feedSize = JSON.stringify(feed).length;
                
                if (currentBatchSize + feedSize > BATCH_SIZE_BYTES && currentBatch.length > 0) {
                    await fetch(`/.netlify/functions/store/${userId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ feeds: currentBatch })
                    });
                    
                    currentBatch = [];
                    currentBatchSize = 0;
                }
                
                currentBatch.push(feed);
                currentBatchSize += feedSize;
            }
            
            if (currentBatch.length > 0) {
                await fetch(`/.netlify/functions/store/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ feeds: currentBatch })
                });
            }
        } else {
            await fetch(`/.netlify/functions/store/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: value })
            });
        }
    }
    
    self.postMessage({ type: 'synced' });
}

function startSync() {
    if (syncInterval) return;
    syncInterval = setInterval(() => {
        self.postMessage({ type: 'requestData' });
    }, 3600000);
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
            await checkBlobAvailability();
            self.postMessage({ type: 'ready', blobAvailable });
            await syncFromBlob();
            startSync();
            break;

        case 'sync':
            if (isSyncing) {
                return;
            }
            isSyncing = true;
            try {
                await syncToBlob(payload.data);
            } finally {
                isSyncing = false;
            }
            break;

        case 'markAllRead':
            if (!userId || !blobAvailable) {
                return;
            }
            try {
                await fetch(`/.netlify/functions/store/${userId}?feedUrl=${encodeURIComponent(payload.feedUrl)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'markAllRead' })
                });
            } catch (e) {
            }
            break;

        case 'markItemRead':
        case 'markItemUnread':
            if (!userId || !blobAvailable) return;
            try {
                const isRead = type === 'markItemRead';
                await fetch(`/.netlify/functions/store/${userId}?feedUrl=${encodeURIComponent(payload.feedUrl)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: isRead ? 'markItemRead' : 'markItemUnread', itemLink: payload.itemLink })
                });
            } catch (e) {
            }
            break;

        case 'stop':
            stopSync();
            self.postMessage({ type: 'stopped' });
            break;
    }
};