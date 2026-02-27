const loginPage = document.getElementById('login-page');
const userPage = document.getElementById('user-page');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const tokenDisplay = document.getElementById('token-display');
const userNameDisplay = document.getElementById('user-name');

function decodeJWT(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = parts[1];
        const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
        return JSON.parse(decoded);
    } catch (e) {
        return null;
    }
}

function getUserName(user) {
    const metadata = user.user_metadata || {};
    const emailFromIdentity = user.identity?.email;
    const jwtPayload = decodeJWT(user.token);
    const emailFromJWT = jwtPayload?.email;
    return metadata.full_name || metadata.name || emailFromIdentity || emailFromJWT || 'User';
}

function updateUI() {
    const user = netlifyIdentity.currentUser();
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
        tokenDisplay.textContent = JSON.stringify(userData, null, 2);
    } else {
        loginPage.style.display = 'block';
        userPage.style.display = 'none';
    }
}

loginBtn.addEventListener('click', () => {
    netlifyIdentity.open();
});

logoutBtn.addEventListener('click', () => {
    netlifyIdentity.logout();
    updateUI();
});

netlifyIdentity.on('login', () => {
    updateUI();
});

netlifyIdentity.on('logout', () => {
    updateUI();
});

updateUI();
