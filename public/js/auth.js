import { createBlobStore } from './blob-store.js';
import { subscribeToFeed, getFeeds, importFeeds, exportFeedsAsOpml, exportFeedsAsText, addItemsToFeed, updateFeedMeta, parseFeedItems } from './rss.js';

const loginPage = document.getElementById('login-page');
const userPage = document.getElementById('user-page');
const loginBtn = document.getElementById('login-btn');
const userNameDisplay = document.getElementById('user-name');
const subscribeForm = document.getElementById('subscribe-form');
const feedUrlInput = document.getElementById('feed-url');
const feedMessage = document.getElementById('feed-message');
const feedsContainer = document.getElementById('feeds-container');
const importForm = document.getElementById('import-form');
const importFileInput = document.getElementById('import-file');
const importMessage = document.getElementById('import-message');
const exportOpmlBtn = document.getElementById('export-opml-btn');
const exportTextBtn = document.getElementById('export-text-btn');
const itemsContainer = document.getElementById('items-container');

const navRead = document.getElementById('nav-read');
const navManage = document.getElementById('nav-manage');
const navLogout = document.getElementById('nav-logout');
const pageRead = document.getElementById('page-read');
const pageManage = document.getElementById('page-manage');

let blobStore = null;
let feedWorker = null;
let hideRead = false;
let filteredFeedTitle = null;
let renderItemsTimeout = null;
const RENDER_DEBOUNCE_MS = 150;

function debouncedRenderItems() {
    if (renderItemsTimeout) {
        clearTimeout(renderItemsTimeout);
    }
    renderItemsTimeout = setTimeout(() => {
        renderItemsTimeout = null;
        renderItems();
    }, RENDER_DEBOUNCE_MS);
}

function showPage(pageName) {
    navRead.classList.remove('active');
    navManage.classList.remove('active');
    pageRead.classList.add('hidden');
    pageManage.classList.add('hidden');
    
    if (pageName === 'read') {
        navRead.classList.add('active');
        pageRead.classList.remove('hidden');
        debouncedRenderItems();
    } else if (pageName === 'manage') {
        navManage.classList.add('active');
        pageManage.classList.remove('hidden');
        renderFeeds();
    }
}

navRead.addEventListener('click', () => showPage('read'));
navManage.addEventListener('click', () => showPage('manage'));
navLogout.addEventListener('click', () => {
    stopFeedWorker();
    netlifyIdentity.logout();
    loginPage.classList.remove('hidden');
    userPage.classList.add('hidden');
});

const toggleReadBtn = document.getElementById('toggle-read-btn');
toggleReadBtn.addEventListener('click', () => {
    hideRead = !hideRead;
    toggleReadBtn.textContent = hideRead ? 'Show Read' : 'Hide Read';
    debouncedRenderItems();
});

function updateToggleFilterText() {
    if (filteredFeedTitle) {
        toggleReadBtn.title = `Showing items from: ${filteredFeedTitle}. Click feed title to clear filter.`;
    } else {
        toggleReadBtn.title = '';
    }
}

const syncBtn = document.getElementById('sync-btn');
syncBtn.addEventListener('click', () => {
    blobStore.syncNow();
    debouncedRenderItems();
});

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
    feedsContainer.innerHTML = feeds.map(feed => {
        let displayHtml = '';
        if (feed.title && feed.link) {
            displayHtml = `<a href="${escapeHtml(feed.link)}" target="_blank">${escapeHtml(feed.title)}</a> <span style="margin-left: 8px; opacity: 0.6;">(<a href="${escapeHtml(feed.url)}" target="_blank">RSS</a>)</span>`;
        } else if (feed.title) {
            displayHtml = `${escapeHtml(feed.title)} <span style="margin-left: 8px; opacity: 0.6;">(<a href="${escapeHtml(feed.url)}" target="_blank">RSS</a>)</span>`;
        } else {
            displayHtml = `<a href="${escapeHtml(feed.url)}" target="_blank">${escapeHtml(feed.url)}</a>`;
        }
        return `
        <div class="feed-item">
            <span>${displayHtml}</span>
            <button class="pure-button pure-button-small" onclick="removeFeed('${escapeHtml(feed.url)}')">Remove</button>
        </div>
    `}).join('');
}

function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}

window.removeFeed = async function(url) {
    await blobStore.deleteFeed(url);
    renderFeeds();
};

function parseRfc822Date(dateStr) {
    if (!dateStr) return null;
    try {
        return new Date(dateStr);
    } catch {
        return null;
    }
}

function truncateWords(text, wordCount) {
    if (!text) return '';
    const words = text.split(/\s+/);
    if (words.length <= wordCount) return text;
    return words.slice(0, wordCount).join(' ') + '...';
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtml(html) {
    if (!html) return '';
    
    // Keep only b, i, u, a, em, strong tags and their content
    let result = html;
    
    // Replace <br> and </p> with newlines
    result = result.replace(/<br\s*\/?>/gi, '\n');
    result = result.replace(/<\/p>/gi, '\n\n');
    
    // Remove all tags except b, i, u, a, em, strong
    result = result.replace(/<\/?(?!(b|i|u|a|em|strong)\b)[a-z][a-z0-9]*[^>]*>/gi, '');
    
    // Decode common HTML entities
    result = result.replace(/&nbsp;/gi, ' ');
    result = result.replace(/&amp;/gi, '&');
    result = result.replace(/&lt;/gi, '<');
    result = result.replace(/&gt;/gi, '>');
    result = result.replace(/&quot;/gi, '"');
    
    // Clean up whitespace
    result = result.replace(/\n\s*\n/g, '\n\n');
    result = result.replace(/[ \t]+/g, ' ');
    result = result.trim();
    
    return result;
}

function getItemId(item) {
    return simpleHash(item.link);
}

function markItemAsRead(item, blobStore) {
    const feeds = getFeeds(blobStore);
    for (const feed of feeds) {
        if (!feed.items) continue;
        for (const fItem of feed.items) {
            if (fItem.link === item.link) {
                fItem.unread = false;
                blobStore.markItemReadState(feed.url, item.link, true);
                break;
            }
        }
    }
}

function renderItems() {
    if (!blobStore) return;
    try {
    const feeds = getFeeds(blobStore);
    
    let allItems = [];
    for (const feed of feeds) {
        if (!feed.items) continue;
        for (const item of feed.items) {
            allItems.push({
                ...item,
                feedTitle: feed.title || feed.url,
                feedUrl: feed.url
            });
        }
    }
    
    // Sort by pubDate descending
    allItems.sort((a, b) => {
        const dateA = parseRfc822Date(a.pubDate);
        const dateB = parseRfc822Date(b.pubDate);
        if (!dateA && !dateB) return 0;
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB - dateA;
    });
    
    if (filteredFeedTitle) {
        allItems = allItems.filter(item => item.feedTitle === filteredFeedTitle);
    }
    
    if (allItems.length === 0) {
        itemsContainer.innerHTML = '<p>No items yet.</p>';
        return;
    }
    
    function formatDate(dateStr) {
        const date = parseRfc822Date(dateStr);
        if (!date) return '';
        return date.toLocaleString();
    }
    
    itemsContainer.innerHTML = '<div class="item-list">' + allItems.map(item => {
        if (hideRead && item.unread === false) {
            return `<span id="${getItemId(item)}"></span>`;
        }
        const feedTitle = item.feedTitle;
        const dateStr = formatDate(item.pubDate);
        let titleHtml = '';
let contentHtml = '';
         
         if (item.description) {
            const cleanText = stripHtml(item.description);
            const words = cleanText.split(/\s+/);
            
            if (item.title) {
                titleHtml = item.title;
                if (words.length > 0) {
                    contentHtml = words.slice(0, 100).join(' ');
                    if (words.length > 100) contentHtml += '...';
                }
            } else {
                titleHtml = words.slice(0, 15).join(' ') + '...';
                if (words.length > 15) {
                    contentHtml = '...' + words.slice(15, 100).join(' ');
                    if (words.length > 100) contentHtml += '...';
                }
            }
        } else {
            titleHtml = feedTitle;
        }
        
const markUnreadLink = item.unread === false ? `<span class="item-action"> | <a class="mark-unread-link" href="#" data-item-link="${item.link}" title="Mark this item as unread">Mark as unread</a></span>` : '';

const itemClass = item.unread === false ? 'item read' : 'item';
        const feedUrl = item.feedUrl || '';
        
        return `
            <div class="${itemClass}">
                <div class="item-meta">
                    <span class="item-date">${dateStr}</span>
                    <span class="item-feed">(<a class="filter-feed-link" href="#" data-feed-title="${escapeHtml(feedTitle)}" data-feed-url="${escapeHtml(feedUrl)}" title="Show only items from this feed">${feedTitle}</a> | <a class="mark-all-read-link" href="#" data-feed-title="${escapeHtml(feedTitle)}" data-feed-url="${escapeHtml(feedUrl)}" title="Mark all items from this feed as read">Mark all as read</a>${markUnreadLink})</span>
                </div>
                <div class="item-title">
                    <a href="${escapeHtml(item.link)}" target="_blank" name="${getItemId(item)}" id="${getItemId(item)}" data-item-link="${escapeHtml(item.link)}">${titleHtml}</a>
                </div>
                ${contentHtml ? `<div class="item-content">${contentHtml}</div>` : ''}
            </div>
        `;
    }).join('') + '</div>';
    } catch (e) {
    }
}

function initFeedWorker(userId) {
    if (feedWorker) {
        feedWorker.terminate();
    }
    
    feedWorker = new Worker('js/feed-worker.js', { type: 'module' });
    
        feedWorker.onmessage = (e) => {
            const { type, payload } = e.data;
            
            switch (type) {
                case 'ready':
                    break;
                case 'getFeeds':
                    const feeds = blobStore.get('feeds') || [];
                    feedWorker.postMessage({ type: 'feeds', payload: { feeds } });
                    break;
                    
                case 'parseFeed':
                    const result = parseFeedItems(payload.text);
                    if (result.items.length > 0) {
                        addItemsToFeed(payload.feedUrl, result.items, blobStore);
                        if (result.title || result.link) {
                            updateFeedMeta(payload.feedUrl, result.title, result.link, blobStore);
                        }
                        renderFeeds();
                        debouncedRenderItems();
                    }
                    break;
                    
                case 'feedErrors':
                    displayFeedErrors(payload.errors);
                    break;
        }
    };
    
    feedWorker.postMessage({
        type: 'init',
        payload: { userId }
    });
}

function stopFeedWorker() {
    if (feedWorker) {
        feedWorker.postMessage({ type: 'stop' });
        feedWorker.terminate();
        feedWorker = null;
    }
}

let feedErrors = [];

function displayFeedErrors(errors) {
    if (!errors || errors.length === 0) return;
    
    // Add new errors to the list
    for (const error of errors) {
        if (!feedErrors.some(e => e.url === error.url)) {
            feedErrors.push(error);
        }
    }
    
    // Find the feeds container in the manage page
    const feedsContainer = document.getElementById('feeds-container');
    if (!feedsContainer) return;
    
    // Create or update error display
    let errorContainer = document.getElementById('feed-errors');
    if (!errorContainer) {
        errorContainer = document.createElement('div');
        errorContainer.id = 'feed-errors';
        errorContainer.style.cssText = 'margin: 1rem 0; padding: 0.5rem; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; text-align: left;';
        feedsContainer.parentNode.prepend(errorContainer);
    }
    
    const errorList = feedErrors.map(e => `<li><strong>${escapeHtml(e.url)}</strong>: ${escapeHtml(e.error)}</li>`).join('');
    errorContainer.innerHTML = `
        <strong style="color: #856404;">Invalid Feeds (${feedErrors.length})</strong>
        <ul style="margin: 0.5rem 0 0 1rem; padding-left: 1rem;">${errorList}</ul>
    `;
}

function triggerFeedScan() {
    // Clear old errors before new scan
    feedErrors = [];
    const errorContainer = document.getElementById('feed-errors');
    if (errorContainer) errorContainer.remove();
    
    if (feedWorker) {
        feedWorker.postMessage({ type: 'scan' });
    }
}

function updateUI() {
    const user = netlifyIdentity.currentUser();
    if (user) {
        loginPage.classList.add('hidden');
        userPage.classList.remove('hidden');
        userNameDisplay.textContent = getUserName(user);
        showPage('read');
    } else {
        loginPage.classList.remove('hidden');
        userPage.classList.add('hidden');
    }
}

loginBtn.addEventListener('click', () => {
    netlifyIdentity.open();
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
        triggerFeedScan();
    } else {
        feedMessage.textContent = result.error;
        feedMessage.className = 'error';
    }
});

importForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = importFileInput.files[0];
    if (!file) {
        importMessage.textContent = 'Please select a file';
        importMessage.className = 'error';
        return;
    }
    importMessage.textContent = 'Importing...';
    importMessage.className = '';
    
    const result = await importFeeds(file, blobStore, true);
    
    if (result.success) {
        let msg = `Imported ${result.added} feeds`;
        if (result.skipped > 0) msg += `, skipped ${result.skipped}`;
        if (result.invalid > 0) msg += `, invalid ${result.invalid}`;
        importMessage.textContent = msg;
        importMessage.className = 'success';
        importFileInput.value = '';
        renderFeeds();
        triggerFeedScan();
    } else {
        importMessage.textContent = result.error;
        importMessage.className = 'error';
    }
});

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

exportOpmlBtn.addEventListener('click', () => {
    const opml = exportFeedsAsOpml(blobStore);
    downloadFile(opml, 'feeds.opml', 'application/xml');
});

exportTextBtn.addEventListener('click', () => {
    const text = exportFeedsAsText(blobStore);
    downloadFile(text, 'feeds.txt', 'text/plain');
});

netlifyIdentity.on('login', async (user) => {
    const jwtPayload = decodeJWT(user.token);
    if (jwtPayload?.sub) {
        blobStore = createBlobStore();
        await blobStore.init(jwtPayload.sub);
        renderItems();
        renderFeeds();
        initFeedWorker(jwtPayload.sub);
    }
    updateUI();
});

itemsContainer.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-item-link]');
    if (link) {
        const itemLink = link.getAttribute('data-item-link');
        const itemId = link.id;
        if (itemId) {
            history.replaceState(null, '', `#${itemId}`);
        }
        const feeds = getFeeds(blobStore);
        for (const feed of feeds) {
            if (!feed.items) continue;
            for (const item of feed.items) {
                if (item.link === itemLink && item.unread) {
                    item.unread = false;
                    blobStore.markItemReadState(feed.url, itemLink, true);
                    break;
                }
            }
        }
        debouncedRenderItems();
    }
});

netlifyIdentity.on('logout', () => {
    stopFeedWorker();
    if (blobStore) {
        blobStore.destroy();
        blobStore = null;
    }
    updateUI();
});

itemsContainer.addEventListener('click', async (e) => {
    const filterLink = e.target.closest('a.filter-feed-link');
    if (filterLink) {
        e.preventDefault();
        const clickedFeedUrl = filterLink.getAttribute('data-feed-url');
        const feeds = getFeeds(blobStore);
        const feed = feeds.find(f => f.url === clickedFeedUrl);
        const clickedFeedTitle = feed?.title || clickedFeedUrl;
        
        if (filteredFeedTitle === clickedFeedTitle) {
            filteredFeedTitle = null;
        } else {
            filteredFeedTitle = clickedFeedTitle;
        }
        updateToggleFilterText();
        renderItems();
        return;
    }

    const markAllLink = e.target.closest('a.mark-all-read-link');
    if (markAllLink) {
        e.preventDefault();
        const clickedFeedUrl = markAllLink.getAttribute('data-feed-url');
        if (!clickedFeedUrl) {
            return;
        }
        const feeds = getFeeds(blobStore);
        const feed = feeds.find(f => f.url === clickedFeedUrl);
        if (!feed) {
            return;
        }
        if (!confirm(`Mark all items in "${feed.title || clickedFeedUrl}" as read?`)) {
            return;
        }
        await blobStore.markFeedAsRead(feed.url);
        await new Promise(r => setTimeout(r, 100));
        renderItems();
    }

    const markUnreadLink = e.target.closest('a.mark-unread-link');
    if (markUnreadLink) {
        e.preventDefault();
        const clickedItemLink = markUnreadLink.getAttribute('data-item-link');
        const feeds = getFeeds(blobStore);
        for (const feed of feeds) {
            if (!feed.items) continue;
            for (const item of feed.items) {
                if (item.link === clickedItemLink) {
                    item.unread = true;
                    blobStore.markItemReadState(feed.url, clickedItemLink, false);
                    break;
                }
            }
        }
        debouncedRenderItems();
    }
});

updateUI();

window.addEventListener('onlyread:dataUpdated', () => {
    debouncedRenderItems();
    renderFeeds();
});

const syncStatus = document.getElementById('sync-status');
let syncStatusTimer = null;

window.addEventListener('onlyread:syncStatus', (e) => {
    const { phase, current, total } = e.detail;
    if (syncStatusTimer) { clearTimeout(syncStatusTimer); syncStatusTimer = null; }
    syncStatus.classList.remove('fade');

    if (phase === 'downloading') {
        syncStatus.textContent = total != null ? `Downloading feeds (${current}/${total})` : 'Downloading feeds...';
    } else if (phase === 'uploading') {
        syncStatus.textContent = `Uploading feeds (${current}/${total})`;
    } else if (phase === 'synced') {
        syncStatus.textContent = 'Synced';
        syncStatusTimer = setTimeout(() => {
            syncStatus.classList.add('fade');
            syncStatusTimer = setTimeout(() => { syncStatus.textContent = ''; }, 500);
        }, 2000);
    }
});
