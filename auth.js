const loginPage = document.getElementById('login-page');
const userPage = document.getElementById('user-page');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const tokenDisplay = document.getElementById('token-display');
const userNameDisplay = document.getElementById('user-name');

const DEBUG = true;
function log(...args) {
    if (DEBUG) console.log('[Auth]', ...args);
}

function decodeJWT(token) {
    if (typeof token !== 'string') {
        log('Token is not a string, type:', typeof token, 'value:', token);
        return null;
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

netlifyIdentity.on('login', (user) => {
    log('Login event fired, user:', user);
    updateUI();
});

netlifyIdentity.on('logout', () => {
    log('Logout event fired');
    updateUI();
});

netlifyIdentity.on('error', (err) => {
    log('Netlify Identity error:', err);
});

log('Script initialized');
updateUI();
