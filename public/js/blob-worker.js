let userId = null;
let syncInterval = null;
let blobAvailable = false;
let isSyncing = false;
let lastSync = null;

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
        let serverUpdatedAt = null;

        while (hasMore) {
            console.log('[blob-worker] Fetching from blob offset:', offset);
            const response = await fetch(`/.netlify/functions/store/${userId}?offset=${offset}&limit=${limit}`);
            if (response.status === 404) { console.log('[blob-worker] No data found (404)'); return; }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            serverUpdatedAt = data.updatedAt || null;
            console.log('[blob-worker] Received response, hasMore:', data.hasMore, 'updatedAt:', serverUpdatedAt);

            if (data.feeds && Array.isArray(data.feeds)) {
                allFeeds = allFeeds.concat(data.feeds);
                hasMore = data.hasMore;
                offset += limit;
            } else {
                hasMore = false;
            }
        }

        console.log('[blob-worker] syncFromBlob complete, feeds:', allFeeds.length, 'updatedAt:', serverUpdatedAt);
        if (allFeeds.length > 0) {
            self.postMessage({ type: 'syncFromBlob', data: { feeds: allFeeds, updatedAt: serverUpdatedAt } });
        } else if (serverUpdatedAt) {
            self.postMessage({ type: 'syncFromBlob', data: { feeds: [], updatedAt: serverUpdatedAt } });
        }
    } catch (e) {
        console.log('[blob-worker] syncFromBlob error:', e);
    }
}

const BATCH_SIZE_BYTES = 1024 * 1024;

async function syncToBlob(data) {
    if (!userId || !blobAvailable) return;

    console.log('[blob-worker] syncToBlob called, keys:', Object.keys(data), 'lastSync:', lastSync);

    const keys = Object.keys(data);

    for (const key of keys) {
        const value = data[key];

        if (key === 'feeds' && Array.isArray(value)) {
            let currentBatch = [];
            let currentBatchSize = 0;

            for (const feed of value) {
                const feedSize = JSON.stringify(feed).length;

                if (currentBatchSize + feedSize > BATCH_SIZE_BYTES && currentBatch.length > 0) {
                    console.log('[blob-worker] Sending batch to server, size:', currentBatch.length);
                    const response = await fetch(`/.netlify/functions/store/${userId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ feeds: currentBatch, lastSync })
                    });

                    console.log('[blob-worker] Server response:', response.status);
                    if (response.status === 409) {
                        const conflictData = await response.json();
                        console.log('[blob-worker] 409 Conflict received:', conflictData);
                        self.postMessage({ type: 'conflict', payload: { updatedAt: conflictData.updatedAt } });
                        return;
                    }

                    currentBatch = [];
                    currentBatchSize = 0;
                }

                currentBatch.push(feed);
                currentBatchSize += feedSize;
            }

            if (currentBatch.length > 0) {
                console.log('[blob-worker] Sending final batch to server, size:', currentBatch.length);
                const response = await fetch(`/.netlify/functions/store/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ feeds: currentBatch, lastSync })
                });

                console.log('[blob-worker] Final batch response:', response.status);
                if (response.status === 409) {
                    const conflictData = await response.json();
                    console.log('[blob-worker] 409 Conflict on final batch:', conflictData);
                    self.postMessage({ type: 'conflict', payload: { updatedAt: conflictData.updatedAt } });
                    return;
                }
            }
        } else {
            await fetch(`/.netlify/functions/store/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: value, lastSync })
            });
        }
    }

    console.log('[blob-worker] syncToBlob complete');
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
            if (payload?.lastSync) {
                lastSync = payload.lastSync;
            }
            isSyncing = true;
            try {
                await syncToBlob(payload.data);
            } finally {
                isSyncing = false;
            }
            break;

        case 'syncFromBlob':
            await syncFromBlob();
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