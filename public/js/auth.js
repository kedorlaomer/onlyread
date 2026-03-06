import { createBlobStore } from './blob-store.js';
import { subscribeToFeed, getFeeds, removeFeed } from './rss.js';

const loginPage = document.getElementById('login-page');
const userPage = document.getElementById('user-page');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const userNameDisplay = document.getElementById('user-name');
const subscribeForm = document.getElementById('subscribe-form');
const feedUrlInput = document.getElementById('feed-url');
const feedMessage = document.getElementById('feed-message');
const feedsContainer = document.getElementById('feeds-container');

let blobStore = null;

function decodeJWT(token) {
    if (typeof token !== 'string') {
        if (token && token.access_token) {
            token = token.access_token;
        } else {
            return null;
        }
    }
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

function renderFeeds() {
    if (!blobStore) return;
    const feeds = getFeeds(blobStore);
    if (feeds.length === 0) {
        feedsContainer.innerHTML = '<p>No feeds subscribed yet.</p>';
        return;
    }
    feedsContainer.innerHTML = feeds.map(feed => `
        <div class="feed-item">
            <a href="${feed.url}" target="_blank">${feed.url}</a>
            <button class="pure-button pure-button-small" onclick="removeFeed('${feed.url}')">Remove</button>
        </div>
    `).join('');
}

window.removeFeed = function(url) {
    removeFeed(url, blobStore);
    renderFeeds();
};

function updateUI() {
    const user = netlifyIdentity.currentUser();
    if (user) {
        loginPage.classList.add('hidden');
        userPage.classList.remove('hidden');
        userNameDisplay.textContent = getUserName(user);
        if (blobStore) {
            renderFeeds();
        }
    } else {
        loginPage.classList.remove('hidden');
        userPage.classList.add('hidden');
    }
}

loginBtn.addEventListener('click', () => {
    netlifyIdentity.open();
});

logoutBtn.addEventListener('click', () => {
    netlifyIdentity.logout();
    updateUI();
});

subscribeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = feedUrlInput.value.trim();
    feedMessage.textContent = 'Subscribing...';
    feedMessage.className = '';
    
    const result = await subscribeToFeed(url, blobStore);
    
    if (result.success) {
        feedMessage.textContent = 'Subscribed successfully!';
        feedMessage.className = 'success';
        feedUrlInput.value = '';
        renderFeeds();
    } else {
        feedMessage.textContent = result.error;
        feedMessage.className = 'error';
    }
});

netlifyIdentity.on('login', async (user) => {
    const jwtPayload = decodeJWT(user.token);
    if (jwtPayload?.sub) {
        blobStore = createBlobStore();
        await blobStore.init(jwtPayload.sub);
    }
    updateUI();
});

netlifyIdentity.on('logout', () => {
    if (blobStore) {
        blobStore.destroy();
        blobStore = null;
    }
    updateUI();
});

updateUI();
