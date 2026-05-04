const DB_NAME = 'onlyread';
const DB_VERSION = 1;
const STORE_NAME = 'data';

let db = null;
const memoryCache = {};

function openDB() {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => {
            reject(request.error);
        };
        
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME);
            }
        };
    });
}

function dbGet(key) {
    return new Promise(async (resolve, reject) => {
        const database = await openDB();
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(key);
        
        request.onsuccess = () => {
            resolve(request.result ?? null);
        };
        
        request.onerror = () => {
            reject(request.error);
        };
    });
}

function dbSet(key, value) {
    return new Promise(async (resolve, reject) => {
        const database = await openDB();
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(value, key);
        
        request.onsuccess = () => {
            resolve();
        };
        
        request.onerror = () => {
            reject(request.error);
        };
    });
}

function dbGetAllForUser(userId) {
    return new Promise(async (resolve, reject) => {
        const database = await openDB();
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        
        const result = {};
        let pending = 1;
        
        function done() {
            pending--;
            if (pending === 0) {
                resolve(result);
            }
        }
        
        const keyRequest = store.getAllKeys();
        keyRequest.onsuccess = () => {
            const prefix = `blob_${userId}_`;
            const keysToFetch = keyRequest.result.filter(k => typeof k === 'string' && k.startsWith(prefix));
            pending = keysToFetch.length;
            
            if (pending === 0) {
                resolve(result);
                return;
            }
            
            for (const key of keysToFetch) {
                const valueRequest = store.get(key);
                valueRequest.onsuccess = () => {
                    const shortKey = key.replace(prefix, '');
                    result[shortKey] = valueRequest.result;
                    done();
                };
                valueRequest.onerror = () => done();
            }
        };
        keyRequest.onerror = () => reject(keyRequest.error);
    });
}

function validateUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

function getStorageKey(userId, key) {
    if (!validateUUID(userId)) {
        throw new Error(`Invalid UUID: ${userId}`);
    }
    return `blob_${userId}_${key}`;
}

export function createBlobStore() {
    let worker = null;
    let currentUserId = null;
    let ready = false;
    let blobAvailable = false;
    const pendingCallbacks = [];
    let syncTimeout = null;
    const SYNC_DEBOUNCE_MS = 500;
    let lastSync = null;
    let initialSyncComplete = false;

    function ensureReady() {
        return new Promise((resolve) => {
            if (ready) {
                resolve();
            } else {
                pendingCallbacks.push(resolve);
            }
        });
    }

    function processPendingCallbacks() {
        while (pendingCallbacks.length > 0) {
            const callback = pendingCallbacks.shift();
            callback();
        }
    }

    return {
        async init(userId) {
            if (!validateUUID(userId)) {
                throw new Error(`Invalid UUID: ${userId}`);
            }
            currentUserId = userId;

            try {
                await openDB();
                const allData = await dbGetAllForUser(userId);
                for (const [key, value] of Object.entries(allData)) {
                    const storageKey = getStorageKey(userId, key);
                    memoryCache[storageKey] = value;
                }
                blobAvailable = true;
            } catch (e) {
                blobAvailable = false;
            }

            worker = new Worker('js/blob-worker.js', { type: 'module' });

            worker.onmessage = (e) => {
                const { type, data, payload } = e.data;

                switch (type) {
                    case 'ready':
                        blobAvailable = e.data.blobAvailable;
                        ready = true;
                        processPendingCallbacks();
                        break;

                    case 'syncFromBlob':
                        (async () => {
                            console.log('[blob-store] syncFromBlob received:', { dataKeys: Object.keys(data), updatedAt: data.updatedAt });
                            for (const [key, value] of Object.entries(data)) {
                                const storageKey = getStorageKey(userId, key);
                                memoryCache[storageKey] = value;
                                await dbSet(storageKey, value);
                            }
                            if (data.updatedAt) {
                                lastSync = data.updatedAt;
                                console.log('[blob-store] Updated lastSync to:', lastSync);
                            } else {
                                // Server has no updatedAt - set lastSync to now so we can proceed
                                lastSync = new Date().toISOString();
                                console.log('[blob-store] No updatedAt in syncFromBlob response, set lastSync to now:', lastSync);
                            }
                            initialSyncComplete = true;
                            console.log('[blob-store] Initial sync complete');
                            window.dispatchEvent(new CustomEvent('onlyread:dataUpdated'));
                        })();
                        break;

                    case 'requestData':
                        (async () => {
                            console.log('[blob-store] requestData - sending lastSync:', lastSync, 'initialSyncComplete:', initialSyncComplete);
                            // Don't respond to requestData until initial sync is complete
                            if (!initialSyncComplete) {
                                console.log('[blob-store] Ignoring requestData - initial sync not complete');
                                return;
                            }
                            const allData = {};
                            for (const key of Object.keys(memoryCache)) {
                                if (key.startsWith(`blob_${userId}_`)) {
                                    const shortKey = key.replace(`blob_${userId}_`, '');
                                    allData[shortKey] = memoryCache[key];
                                }
                            }
                            worker.postMessage({ type: 'sync', payload: { data: allData, lastSync } });
                        })();
                        break;

                    case 'conflict':
                        console.log('[blob-store] Received conflict from worker:', payload);
                        // Always sync from blob on conflict, regardless of updatedAt
                        lastSync = null;
                        console.log('[blob-store] Cleared lastSync due to conflict, triggering syncFromBlob');
                        worker.postMessage({ type: 'syncFromBlob' });
                        break;
                }
            };

            worker.postMessage({
                type: 'init',
                payload: { userId }
            });

            await ensureReady();
        },

        get(key) {
            if (!currentUserId) throw new Error('Store not initialized');
            const storageKey = getStorageKey(currentUserId, key);
            return memoryCache[storageKey] ?? null;
        },

        set(key, value) {
            if (!currentUserId) throw new Error('Store not initialized');
            const storageKey = getStorageKey(currentUserId, key);
            memoryCache[storageKey] = value;

            // Don't sync until initial sync from blob is complete
            if (!initialSyncComplete) {
                console.log('[blob-store] set() called but initialSyncComplete is false, skipping sync');
                return;
            }

            if (syncTimeout) clearTimeout(syncTimeout);
            syncTimeout = setTimeout(() => {
                const keysToSync = Object.keys(memoryCache)
                    .filter(k => k.startsWith(`blob_${currentUserId}_`))
                    .map(k => k.replace(`blob_${currentUserId}_`, ''));

                const dataToSync = {};
                for (const k of keysToSync) {
                    dataToSync[k] = memoryCache[getStorageKey(currentUserId, k)];
                }

                if (worker) {
                    worker.postMessage({ type: 'sync', payload: { data: dataToSync, lastSync } });
                }
            }, SYNC_DEBOUNCE_MS);
        },

        getAll() {
            if (!currentUserId) return {};
            const prefix = `blob_${currentUserId}_`;
            const result = {};
            for (const key of Object.keys(memoryCache)) {
                if (key.startsWith(prefix)) {
                    const shortKey = key.replace(prefix, '');
                    result[shortKey] = memoryCache[key];
                }
            }
            return result;
        },

        syncNow() {
            if (!currentUserId || !worker) return;
            const keysToSync = Object.keys(memoryCache)
                .filter(k => k.startsWith(`blob_${currentUserId}_`))
                .map(k => k.replace(`blob_${currentUserId}_`, ''));

            const dataToSync = {};
            for (const k of keysToSync) {
                dataToSync[k] = memoryCache[getStorageKey(currentUserId, k)];
            }

            worker.postMessage({ type: 'sync', payload: { data: dataToSync, lastSync } });
        },

        destroy() {
            if (syncTimeout) {
                clearTimeout(syncTimeout);
                syncTimeout = null;
            }
            if (worker) {
                worker.postMessage({ type: 'stop' });
                worker.terminate();
                worker = null;
            }
            ready = false;
            currentUserId = null;
        },

        async markFeedAsRead(feedUrl) {
            if (!currentUserId) return;
            const prefix = `blob_${currentUserId}_`;
            const feedsKey = `${prefix}feeds`;
            const feeds = memoryCache[feedsKey];
            if (!feeds || !Array.isArray(feeds)) return;

            const feedIndex = feeds.findIndex(f => f.url === feedUrl);
            if (feedIndex === -1) return;

            if (feeds[feedIndex].items) {
                for (const item of feeds[feedIndex].items) {
                    item.unread = false;
                }
            }
            
            memoryCache[feedsKey] = feeds;
            await dbSet(feedsKey, feeds);
            if (worker) {
                worker.postMessage({
                    type: 'markAllRead',
                    payload: { feedUrl }
                });
            }
        },

        async markItemReadState(feedUrl, itemLink, isRead) {
            if (!currentUserId) return;
            const prefix = `blob_${currentUserId}_`;
            const feedsKey = `${prefix}feeds`;
            const feeds = memoryCache[feedsKey];
            if (!feeds || !Array.isArray(feeds)) return;

            const feedIndex = feeds.findIndex(f => f.url === feedUrl);
            if (feedIndex === -1) return;

            if (feeds[feedIndex].items) {
                for (const item of feeds[feedIndex].items) {
                    if (item.link === itemLink) {
                        item.unread = !isRead;
                        break;
                    }
                }
            }
            
            memoryCache[feedsKey] = feeds;
            await dbSet(feedsKey, feeds);
            if (worker) {
                worker.postMessage({
                    type: isRead ? 'markItemRead' : 'markItemUnread',
                    payload: { feedUrl, itemLink }
                });
            }
        }
    };
}
