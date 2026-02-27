const loginPage = document.getElementById('login-page');
const userPage = document.getElementById('user-page');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const tokenDisplay = document.getElementById('token-display');

function updateUI() {
    const user = netlifyIdentity.currentUser();
    if (user) {
        loginPage.style.display = 'none';
        userPage.style.display = 'block';
        const userData = {
            token: user.token,
            identity: user.identity,
            user_metadata: user.user_metadata,
            app_metadata: user.app_metadata
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
