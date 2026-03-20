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

function uint8ArrayToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function compressData(dataString) {
    const encoder = new CompressionStream('gzip');
    const writer = encoder.writable.getWriter();
    writer.write(new TextEncoder().encode(dataString));
    writer.close();
    const reader = encoder.readable.getReader();
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return uint8ArrayToBase64(result);
}

async function syncToBlob(data) {
    if (!userId || !blobAvailable) return;

    const dataString = JSON.stringify(data);
    const dataSize = dataString.length;
    log('syncToBlob called, data size:', dataSize);
    log('syncToBlob data keys:', Object.keys(data));
    
    try {
        let body = dataString;
        let headers = { 
            'Content-Type': 'application/json',
            'Content-Length': dataSize.toString()
        };
        
        // Compress if data is too large
        if (dataSize > 4 * 1024 * 1024) {
            log('syncToBlob: compressing large data...');
            const base64 = await compressData(dataString);
            body = JSON.stringify({ compressed: true, data: base64 });
            headers['Content-Length'] = body.length.toString();
            headers['X-Compressed'] = 'gzip';
            log('syncToBlob: compressed from', dataSize, 'to', body.length);
        }
        
        log('syncToBlob: creating request...');
        const response = await fetch(`/.netlify/functions/store/${userId}`, {
            method: 'PUT',
            headers,
            body
        });
        log('syncToBlob response:', response.status, response.statusText);
        if (!response.ok) {
            const text = await response.text();
            log('syncToBlob error body:', text);
            throw new Error(`HTTP ${response.status}: ${text}`);
        }
        self.postMessage({ type: 'synced' });
    } catch (e) {
        log('syncToBlob failed:', e.message);
    }
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
