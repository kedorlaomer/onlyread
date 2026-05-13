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
    let resolvingConflict = false;
    let serverKnownItems = new Map(); // feedUrl -> Set<guid||link> confirmed on server
    let pendingUploadItems = null;    // Map<feedUrl, Set<id>> for items currently being uploaded

    // Returns { feeds, uploading } with only items the server doesn't have yet,
    // or null if there is nothing new to upload.
    function buildSyncPayload() {
        const feeds = memoryCache[getStorageKey(currentUserId, 'feeds')];
        if (!feeds || !Array.isArray(feeds)) return null;

        const filteredFeeds = [];
        const uploading = new Map();

        for (const feed of feeds) {
            if (!feed.url) continue;
            const knownIds = serverKnownItems.get(feed.url);
            const allItems = feed.items || [];

            if (!knownIds) {
                // Feed not yet on server — upload everything
                filteredFeeds.push(feed);
                uploading.set(feed.url, new Set(allItems.map(i => i.guid || i.link).filter(Boolean)));
            } else {
                const newItems = allItems.filter(item => {
                    const id = item.guid || item.link;
                    return id && !knownIds.has(id);
                });
                if (newItems.length > 0) {
                    filteredFeeds.push({ ...feed, items: newItems });
                    uploading.set(feed.url, new Set(newItems.map(i => i.guid || i.link).filter(Boolean)));
                }
            }
        }

        if (filteredFeeds.length === 0) return null;
        return { feeds: filteredFeeds, uploading };
    }

    function sendSync() {
        if (!worker || !initialSyncComplete || resolvingConflict) return;
        const result = buildSyncPayload();
        if (!result) return;
        pendingUploadItems = result.uploading;
        worker.postMessage({ type: 'sync', payload: { data: { feeds: result.feeds }, lastSync } });
    }

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
                            resolvingConflict = false;
                            console.log('[blob-store] syncFromBlob received:', { dataKeys: Object.keys(data), updatedAt: data.updatedAt });
                            if (data.feeds && Array.isArray(data.feeds)) {
                                serverKnownItems = new Map();
                                for (const feed of data.feeds) {
                                    if (!feed.url) continue;
                                    const ids = new Set();
                                    for (const item of (feed.items || [])) {
                                        const id = item.guid || item.link;
                                        if (id) ids.add(id);
                                    }
                                    serverKnownItems.set(feed.url, ids);
                                }
                            }
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
                            window.dispatchEvent(new CustomEvent('onlyread:syncStatus', { detail: { phase: 'synced' } }));
                        })();
                        break;

                    case 'requestData':
                        if (!initialSyncComplete) break;
                        sendSync();
                        break;

                    case 'conflict':
                        console.log('[blob-store] Received conflict from worker:', payload);
                        lastSync = null;
                        resolvingConflict = true;
                        if (syncTimeout) { clearTimeout(syncTimeout); syncTimeout = null; }
                        console.log('[blob-store] Cleared lastSync due to conflict, triggering syncFromBlob');
                        worker.postMessage({ type: 'syncFromBlob' });
                        break;

                    case 'synced':
                        if (e.data.updatedAt) {
                            lastSync = e.data.updatedAt;
                            console.log('[blob-store] Updated lastSync after sync:', lastSync);
                        }
                        if (pendingUploadItems) {
                            for (const [feedUrl, ids] of pendingUploadItems) {
                                const existing = serverKnownItems.get(feedUrl);
                                if (existing) {
                                    for (const id of ids) existing.add(id);
                                } else {
                                    serverKnownItems.set(feedUrl, new Set(ids));
                                }
                            }
                            pendingUploadItems = null;
                        }
                        window.dispatchEvent(new CustomEvent('onlyread:syncStatus', { detail: { phase: 'synced' } }));
                        break;

                    case 'syncProgress':
                        window.dispatchEvent(new CustomEvent('onlyread:syncStatus', { detail: payload }));
                        break;

                    case 'syncFromBlobError':
                        console.log('[blob-store] syncFromBlob failed:', payload?.error, '— retrying in 30s');
                        setTimeout(() => {
                            if (worker) worker.postMessage({ type: 'syncFromBlob' });
                        }, 30000);
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

            if (!initialSyncComplete || resolvingConflict) return;

            if (syncTimeout) clearTimeout(syncTimeout);
            syncTimeout = setTimeout(sendSync, SYNC_DEBOUNCE_MS);
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
            sendSync();
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
