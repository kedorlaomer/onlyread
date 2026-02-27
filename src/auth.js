import { createBlobStore } from './blob-store.js';

const loginPage = document.getElementById('login-page');
const userPage = document.getElementById('user-page');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const tokenDisplay = document.getElementById('token-display');

let blobStore = null;

const userNameDisplay = document.getElementById('user-name');
const storageKeyInput = document.getElementById('storage-key');
const storageValueInput = document.getElementById('storage-value');
const storageResult = document.getElementById('storage-result');
const storageSetBtn = document.getElementById('storage-set-btn');
const storageGetBtn = document.getElementById('storage-get-btn');
const storageSyncBtn = document.getElementById('storage-sync-btn');

const DEBUG = true;
function log(...args) {
    if (DEBUG) console.log('[Auth]', ...args);
}

function decodeJWT(token) {
    if (typeof token !== 'string') {
        if (token && token.access_token) {
            log('Token is object, extracting access_token');
            token = token.access_token;
        } else {
            log('Token is not a string, type:', typeof token);
            return null;
        }
    }
    try {
        const parts = token.split('.');
        if (parts.length !== 3) {
            log('Invalid JWT format, parts:', parts.length);
            return null;
        }
        const payload = parts[1];
        const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
        const parsed = JSON.parse(decoded);
        log('Decoded JWT payload:', parsed);
        return parsed;
    } catch (e) {
        log('JWT decode error:', e);
        return null;
    }
}

function getUserName(user) {
    log('getUserName called with user:', user);
    const metadata = user.user_metadata || {};
    log('metadata:', metadata);
    const emailFromIdentity = user.identity?.email;
    log('emailFromIdentity:', emailFromIdentity);
    const jwtPayload = decodeJWT(user.token);
    const emailFromJWT = jwtPayload?.email;
    log('emailFromJWT:', emailFromJWT);
    const name = metadata.full_name || metadata.name || emailFromIdentity || emailFromJWT || 'User';
    log('Resolved name:', name);
    return name;
}

function updateUI() {
    log('updateUI called');
    const user = netlifyIdentity.currentUser();
    log('currentUser:', user);
    if (user) {
        loginPage.style.display = 'none';
        userPage.style.display = 'block';
        userNameDisplay.textContent = getUserName(user);
        const userData = {
            token: user.token,
            identity: user.identity || {},
            user_metadata: user.user_metadata || {},
            app_metadata: user.app_metadata || {}
        };
        log('Displaying userData:', userData);
        tokenDisplay.textContent = JSON.stringify(userData, null, 2);
    } else {
        loginPage.style.display = 'block';
        userPage.style.display = 'none';
    }
}

loginBtn.addEventListener('click', () => {
    log('Login button clicked');
    netlifyIdentity.open();
});

logoutBtn.addEventListener('click', () => {
    log('Logout button clicked');
    netlifyIdentity.logout();
    updateUI();
});

netlifyIdentity.on('login', async (user) => {
    log('Login event fired, user:', user);
    const jwtPayload = decodeJWT(user.token);
    if (jwtPayload?.sub) {
        blobStore = createBlobStore();
        await blobStore.init(jwtPayload.sub);
        log('Blob store initialized for user:', jwtPayload.sub);
    }
    updateUI();
});

netlifyIdentity.on('logout', () => {
    log('Logout event fired');
    if (blobStore) {
        blobStore.destroy();
        blobStore = null;
    }
    updateUI();
});

netlifyIdentity.on('error', (err) => {
    log('Netlify Identity error:', err);
});

storageSetBtn.addEventListener('click', () => {
    const key = storageKeyInput.value;
    const valueStr = storageValueInput.value;
    if (!key) {
        storageResult.textContent = 'Please enter a key';
        return;
    }
    let value;
    try {
        value = valueStr ? JSON.parse(valueStr) : null;
    } catch (e) {
        value = valueStr;
    }
    blobStore.set(key, value);
    storageResult.textContent = `Set: ${key} = ${JSON.stringify(value)}`;
});

storageGetBtn.addEventListener('click', () => {
    const key = storageKeyInput.value;
    if (!key) {
        storageResult.textContent = 'Please enter a key';
        return;
    }
    const value = blobStore.get(key);
    storageResult.textContent = `Get: ${key} = ${JSON.stringify(value)}`;
});

storageSyncBtn.addEventListener('click', async () => {
    storageResult.textContent = 'Syncing...';
    await blobStore.syncNow();
    storageResult.textContent = 'Synced!';
});

log('Script initialized');
updateUI();
