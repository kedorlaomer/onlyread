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

    const MAX_RETRIES = 3;
    const limit = 50;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            let allFeeds = [];
            let offset = 0;
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
                    self.postMessage({ type: 'syncProgress', payload: { phase: 'downloading', current: allFeeds.length, total: data.total ?? null } });
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
            return;
        } catch (e) {
            console.log(`[blob-worker] syncFromBlob error (attempt ${attempt}/${MAX_RETRIES}):`, e);
            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 1000 * attempt));
            } else {
                self.postMessage({ type: 'syncFromBlobError', payload: { error: e.message } });
            }
        }
    }
}

const BATCH_SIZE_BYTES = 1024 * 1024;

// Sends a batch of feeds, retrying once on 409 with the server's updatedAt.
// Returns true on success, false if conflict could not be resolved (caller must abort).
async function sendBatch(feeds) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`/.netlify/functions/store/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ feeds, lastSync })
        });

        console.log('[blob-worker] Batch response:', response.status, `(attempt ${attempt + 1})`);

        if (response.status === 409) {
            const conflictData = await response.json();
            console.log('[blob-worker] 409 received:', conflictData);
            if (attempt === 0) {
                // Update lastSync to server's value and retry once — the 409 is likely
                // from a concurrent mark action, not a genuine data conflict.
                lastSync = conflictData.updatedAt;
                continue;
            }
            // Second 409: genuine conflict from another source; escalate.
            self.postMessage({ type: 'conflict', payload: { updatedAt: conflictData.updatedAt } });
            return false;
        }

        const result = await response.json();
        if (result.updatedAt) lastSync = result.updatedAt;
        return true;
    }
}

async function syncToBlob(data) {
    if (!userId || !blobAvailable) return;

    console.log('[blob-worker] syncToBlob called, keys:', Object.keys(data), 'lastSync:', lastSync);

    const keys = Object.keys(data);

    for (const key of keys) {
        const value = data[key];

        if (key === 'feeds' && Array.isArray(value)) {
            let currentBatch = [];
            let currentBatchSize = 0;
            const totalFeeds = value.length;
            let feedsSent = 0;
            self.postMessage({ type: 'syncProgress', payload: { phase: 'uploading', current: 0, total: totalFeeds } });

            for (const feed of value) {
                const feedSize = JSON.stringify(feed).length;

                if (currentBatchSize + feedSize > BATCH_SIZE_BYTES && currentBatch.length > 0) {
                    console.log('[blob-worker] Sending batch to server, size:', currentBatch.length);
                    if (!await sendBatch(currentBatch)) return;
                    feedsSent += currentBatch.length;
                    self.postMessage({ type: 'syncProgress', payload: { phase: 'uploading', current: feedsSent, total: totalFeeds } });
                    currentBatch = [];
                    currentBatchSize = 0;
                }

                currentBatch.push(feed);
                currentBatchSize += feedSize;
            }

            if (currentBatch.length > 0) {
                console.log('[blob-worker] Sending final batch to server, size:', currentBatch.length);
                if (!await sendBatch(currentBatch)) return;
                feedsSent += currentBatch.length;
                self.postMessage({ type: 'syncProgress', payload: { phase: 'uploading', current: feedsSent, total: totalFeeds } });
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
    self.postMessage({ type: 'synced', updatedAt: lastSync });
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
                if (!lastSync || new Date(payload.lastSync) > new Date(lastSync)) {
                    lastSync = payload.lastSync;
                }
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

        case 'deleteFeed':
            if (!userId || !blobAvailable) return;
            try {
                const response = await fetch(`/.netlify/functions/store/${userId}?feedUrl=${encodeURIComponent(payload.feedUrl)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'deleteFeed' })
                });
                if (response.ok) {
                    const result = await response.json();
                    if (result.updatedAt) lastSync = result.updatedAt;
                }
            } catch (e) {
            }
            break;

        case 'markAllRead':
            if (!userId || !blobAvailable) {
                return;
            }
            try {
                const response = await fetch(`/.netlify/functions/store/${userId}?feedUrl=${encodeURIComponent(payload.feedUrl)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'markAllRead' })
                });
                if (response.ok) {
                    const result = await response.json();
                    if (result.updatedAt) lastSync = result.updatedAt;
                }
            } catch (e) {
            }
            break;

        case 'markItemRead':
        case 'markItemUnread':
            if (!userId || !blobAvailable) return;
            try {
                const isRead = type === 'markItemRead';
                const response = await fetch(`/.netlify/functions/store/${userId}?feedUrl=${encodeURIComponent(payload.feedUrl)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: isRead ? 'markItemRead' : 'markItemUnread', itemLink: payload.itemLink, itemGuid: payload.itemGuid ?? null })
                });
                if (response.ok) {
                    const result = await response.json();
                    if (result.updatedAt) lastSync = result.updatedAt;
                }
            } catch (e) {
            }
            break;

        case 'compact':
            // Empty-feeds PUT — server reads, projects all items to strip descriptions,
            // and writes back. No data semantics change.
            if (!userId || !blobAvailable) return;
            try {
                const response = await fetch(`/.netlify/functions/store/${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ feeds: [], lastSync })
                });
                if (response.ok) {
                    const result = await response.json();
                    if (result.updatedAt) lastSync = result.updatedAt;
                    self.postMessage({ type: 'compacted', updatedAt: lastSync });
                }
            } catch (e) {
            }
            break;

        case 'stop':
            stopSync();
            self.postMessage({ type: 'stopped' });
            break;
    }
};