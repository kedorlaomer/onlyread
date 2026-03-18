import { createBlobStore } from './blob-store.js';
import { subscribeToFeed, getFeeds, removeFeed, importFeeds, exportFeedsAsOpml, exportFeedsAsText, addItemsToFeed, updateFeedMeta } from './rss.js';

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

const DEBUG = false;
function log(...args) {
    if (DEBUG) console.log('[Auth]', ...args);
}

function showPage(pageName) {
    navRead.classList.remove('active');
    navManage.classList.remove('active');
    pageRead.classList.add('hidden');
    pageManage.classList.add('hidden');
    
    if (pageName === 'read') {
        navRead.classList.add('active');
        pageRead.classList.remove('hidden');
        renderItems();
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
    renderItems();
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
            displayHtml = `<a href="${feed.link}" target="_blank">${feed.title}</a> <span style="margin-left: 8px; opacity: 0.6;">(<a href="${feed.url}" target="_blank">RSS</a>)</span>`;
        } else if (feed.title) {
            displayHtml = `${feed.title} <span style="margin-left: 8px; opacity: 0.6;">(<a href="${feed.url}" target="_blank">RSS</a>)</span>`;
        } else {
            displayHtml = `<a href="${feed.url}" target="_blank">${feed.url}</a>`;
        }
        return `
        <div class="feed-item">
            <span>${displayHtml}</span>
            <button class="pure-button pure-button-small" onclick="removeFeed('${feed.url}')">Remove</button>
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

window.removeFeed = function(url) {
    removeFeed(url, blobStore);
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
                break;
            }
        }
    }
    blobStore.set('feeds', feeds);
}

function renderItems() {
    if (!blobStore) return;
    const feeds = getFeeds(blobStore);
    
    let allItems = [];
    for (const feed of feeds) {
        if (!feed.items) continue;
        for (const item of feed.items) {
            allItems.push({
                ...item,
                feedTitle: feed.title || feed.url,
                feedLink: feed.link
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
    
    if (hideRead) {
        allItems = allItems.filter(item => item.unread !== false);
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
        const feedTitle = item.feedTitle;
        const dateStr = formatDate(item.pubDate);
        let titleHtml = '';
        let contentHtml = '';
        
        if (item.description) {
            const cleanText = stripHtml(item.description);
            const words = cleanText.split(/\s+/);
            
            if (item.title) {
                // Has title: show title, then content
                titleHtml = item.title;
                if (words.length > 0) {
                    contentHtml = words.slice(0, 100).join(' ');
                    if (words.length > 100) contentHtml += '...';
                }
            } else {
                // No title: show first words as title, then rest as content
                titleHtml = words.slice(0, 15).join(' ') + '...';
                if (words.length > 15) {
                    contentHtml = '...' + words.slice(15, 100).join(' ');
                    if (words.length > 100) contentHtml += '...';
                }
            }
        } else {
            titleHtml = feedTitle;
        }
        
        return `
            <div class="item${item.unread === false ? ' read' : ''}">
                <div class="item-meta">
                    <span class="item-date">${dateStr}</span>
                    <span class="item-feed">(${feedTitle})</span>
                </div>
                <div class="item-title">
                    <a href="${item.link}" target="_blank" name="${getItemId(item)}" id="${getItemId(item)}" data-item-link="${item.link}">${titleHtml}</a>
                </div>
                ${contentHtml ? `<div class="item-content">${contentHtml}</div>` : ''}
            </div>
        `;
    }).join('') + '</div>';
}

function unescapeXml(text) {
    if (!text) return null;
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

function parseFeedItems(text) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'application/xml');
    
    const items = [];
    
    // Get feed metadata
    const channel = xml.querySelector('channel');
    const feedTitle = channel?.querySelector('title')?.textContent || null;
    const feedLinkEl = channel?.querySelector('link');
    const feedLink = feedLinkEl?.textContent || feedLinkEl?.getAttribute('href') || null;
    
    const rssItems = xml.querySelectorAll('item');
    if (rssItems.length > 0) {
        for (const item of rssItems) {
            const link = item.querySelector('link')?.textContent || '';
            const title = item.querySelector('title')?.textContent || null;
            const pubDate = item.querySelector('pubDate')?.textContent || null;
            const enclosure = item.querySelector('enclosure')?.getAttribute('url') || null;
            const descriptionEl = item.querySelector('description');
            const description = descriptionEl ? unescapeXml(descriptionEl.textContent) : null;
            
            if (link) {
                items.push({
                    link,
                    title,
                    pubDate,
                    enclosure,
                    description,
                    unread: true,
                    addedDate: new Date().toISOString()
                });
            }
        }
        return { items, title: feedTitle, link: feedLink };
    }
    
    // Atom format
    const atomFeed = xml.querySelector('feed');
    const atomTitle = atomFeed?.querySelector('title')?.textContent || feedTitle;
    const atomLinkEl = atomFeed?.querySelector('link[rel="alternate"]') || atomFeed?.querySelector('link');
    const atomLink = atomLinkEl?.getAttribute('href') || feedLink;
    
    const atomEntries = xml.querySelectorAll('entry');
    for (const entry of atomEntries) {
        const linkEl = entry.querySelector('link[rel="alternate"]') || entry.querySelector('link');
        const link = linkEl?.getAttribute('href') || '';
        const pubDate = entry.querySelector('published')?.textContent || 
                       entry.querySelector('updated')?.textContent || null;
        const title = entry.querySelector('title')?.textContent || null;
        const enclosure = entry.querySelector('enclosure')?.getAttribute('url') || null;
        const descriptionEl = entry.querySelector('content') || entry.querySelector('summary');
        const description = descriptionEl ? unescapeXml(descriptionEl.textContent) : null;
        
        if (link) {
            items.push({
                link,
                title,
                pubDate,
                enclosure,
                description,
                unread: true,
                addedDate: new Date().toISOString()
            });
        }
    }
    
    return { items, title: atomTitle, link: atomLink };
}

function initFeedWorker(userId) {
    if (feedWorker) {
        feedWorker.terminate();
    }
    
    console.log('[Auth] Initializing feed worker...');
    feedWorker = new Worker('js/feed-worker.js', { type: 'module' });
    
    feedWorker.onmessage = (e) => {
        const { type, payload } = e.data;
        
        switch (type) {
            case 'getFeeds':
                const feeds = blobStore.getAll().feeds || [];
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
                    renderItems();
                }
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

function triggerFeedScan() {
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
        initFeedWorker(jwtPayload.sub);
    }
    updateUI();
});

netlifyIdentity.on('logout', () => {
    stopFeedWorker();
    if (blobStore) {
        blobStore.destroy();
        blobStore = null;
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
                    blobStore.set('feeds', feeds);
                    blobStore.scheduleSync();
                    break;
                }
            }
        }
    }
});

updateUI();
