const DEBUG = true;
function log(...args) {
    if (DEBUG) console.log('[BlobStore]', ...args);
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

export function get(userId, key) {
    const storageKey = getStorageKey(userId, key);
    const stored = localStorage.getItem(storageKey);
    if (stored) {
        try {
            return JSON.parse(stored);
        } catch (e) {
            log('Error parsing stored JSON:', e);
            return null;
        }
    }
    return null;
}

export function set(userId, key, value) {
    const storageKey = getStorageKey(userId, key);
    const jsonValue = JSON.stringify(value);
    localStorage.setItem(storageKey, jsonValue);
    return { userId, key, value };
}

function getAllData(userId) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(`blob_${userId}_`)) {
            keys.push(key);
        }
    }

    const data = {};
    for (const key of keys) {
        const value = localStorage.getItem(key);
        const shortKey = key.replace(`blob_${userId}_`, '');
        data[shortKey] = JSON.parse(value);
    }
    return data;
}

export function createBlobStore() {
    const siteId = window.NETLIFY_IDENTITY ? window.NETLIFY_IDENTITY.site : null;
    let worker = null;
    let currentUserId = null;
    let ready = false;
    const pendingCallbacks = [];

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

            worker = new Worker('blob-worker.js', { type: 'module' });

            worker.onmessage = (e) => {
                const { type, data } = e.data;

                switch (type) {
                    case 'ready':
                        ready = true;
                        processPendingCallbacks();
                        break;

                    case 'syncFromBlob':
                        for (const [key, value] of Object.entries(data)) {
                            const storageKey = getStorageKey(userId, key);
                            localStorage.setItem(storageKey, JSON.stringify(value));
                        }
                        log('Initialized from blob:', Object.keys(data));
                        break;

                    case 'requestData':
                        const allData = getAllData(userId);
                        worker.postMessage({ type: 'sync', payload: { data: allData } });
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
            return get(currentUserId, key);
        },

        set(key, value) {
            if (!currentUserId) throw new Error('Store not initialized');
            const result = set(currentUserId, key, value);
            const allData = getAllData(currentUserId);
            worker.postMessage({ type: 'sync', payload: { data: allData } });
            return result;
        },

        async syncNow() {
            if (!currentUserId || !worker) return;
            const allData = getAllData(currentUserId);
            worker.postMessage({ type: 'sync', payload: { data: allData } });
        },

        destroy() {
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
