const loginPage = document.getElementById('login-page');
const userPage = document.getElementById('user-page');
const logoutBtn = document.getElementById('logout-btn');
const tokenDisplay = document.getElementById('token-display');

const providers = ['github', 'gitlab', 'google', 'bitbucket'];
const providerButtons = providers.map(p => document.getElementById(`${p}-btn`));
const netlifyBtn = document.getElementById('netlify-btn');

function updateUI() {
    const user = netlifyIdentity.currentUser();
    if (user) {
        loginPage.style.display = 'none';
        userPage.style.display = 'block';
        const token = user.token;
        const userData = {
            token: token,
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

function loginWithProvider(provider) {
    netlifyIdentity.loginExternal(provider);
}

providerButtons.forEach((btn, index) => {
    btn.addEventListener('click', () => {
        loginWithProvider(providers[index]);
    });
});

netlifyBtn.addEventListener('click', () => {
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

netlifyIdentity.init({
    APIUrl: 'https://identity.netlify.com/v1',
    locale: 'en'
});

updateUI();
