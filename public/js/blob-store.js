const DEBUG = true;
function log(...args) {
    if (DEBUG) console.log('[BlobStore]', ...args);
}

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
            log('IndexedDB open error:', request.error);
            reject(request.error);
        };
        
        request.onsuccess = () => {
            db = request.result;
            log('IndexedDB opened');
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
        
        // Get all keys
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
    const siteId = window.NETLIFY_IDENTITY ? window.NETLIFY_IDENTITY.site : null;
    let worker = null;
    let currentUserId = null;
    let ready = false;
    let blobAvailable = false;
    const pendingCallbacks = [];
    let syncTimeout = null;
    const SYNC_DEBOUNCE_MS = 30000;

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
            log('init() called with userId:', userId);
            if (!validateUUID(userId)) {
                throw new Error(`Invalid UUID: ${userId}`);
            }
            currentUserId = userId;

            try {
                await openDB();
                log('IndexedDB opened, loading data...');
                // Load existing data from IndexedDB into memoryCache
                const allData = await dbGetAllForUser(userId);
                log('Loaded from IndexedDB:', Object.keys(allData));
                for (const [key, value] of Object.entries(allData)) {
                    const storageKey = getStorageKey(userId, key);
                    memoryCache[storageKey] = value;
                }
                blobAvailable = true;
            } catch (e) {
                log('IndexedDB not available:', e);
                blobAvailable = false;
            }

            worker = new Worker('js/blob-worker.js', { type: 'module' });

            worker.onmessage = (e) => {
                const { type, data } = e.data;

                switch (type) {
                    case 'ready':
                        blobAvailable = e.data.blobAvailable;
                        ready = true;
                        log('Store ready, blob available:', blobAvailable);
                        processPendingCallbacks();
                        break;

                    case 'syncFromBlob':
                        (async () => {
                            for (const [key, value] of Object.entries(data)) {
                                const storageKey = getStorageKey(userId, key);
                                memoryCache[storageKey] = value;
                                await dbSet(storageKey, value);
                            }
                            log('Initialized from blob:', Object.keys(data));
                        })();
                        break;

                    case 'requestData':
                        (async () => {
                            const allData = {};
                            for (const key of Object.keys(memoryCache)) {
                                if (key.startsWith(`blob_${userId}_`)) {
                                    const shortKey = key.replace(`blob_${userId}_`, '');
                                    allData[shortKey] = memoryCache[key];
                                }
                            }
                            worker.postMessage({ type: 'sync', payload: { data: allData } });
                        })();
                        break;

                    case 'synced':
                        log('Sync complete');
                        break;
                }
            };

            worker.postMessage({
                type: 'init',
                payload: { userId, siteId }
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
            log('set() called for key:', key, 'cache size:', JSON.stringify(memoryCache).length);
            
            // Debounce sync
            if (syncTimeout) clearTimeout(syncTimeout);
            syncTimeout = setTimeout(() => {
                const keysToSync = Object.keys(memoryCache)
                    .filter(k => k.startsWith(`blob_${currentUserId}_`))
                    .map(k => k.replace(`blob_${currentUserId}_`, ''));
                
                const dataToSync = {};
                for (const k of keysToSync) {
                    dataToSync[k] = memoryCache[getStorageKey(currentUserId, k)];
                }
                
                log('Scheduling sync for', keysToSync.length, 'keys, total size:', JSON.stringify(dataToSync).length);
                if (worker) {
                    worker.postMessage({ type: 'sync', payload: { data: dataToSync } });
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
            
            worker.postMessage({ type: 'sync', payload: { data: dataToSync } });
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
        }
    };
}
