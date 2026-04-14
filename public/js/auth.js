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
let filteredFeedTitle = null;

const DEBUG = true;
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
    log('renderItems: feeds count:', feeds.length);
    
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
    log('renderItems: total items before filter:', allItems.length);
    log('renderItems: sample items:', allItems.slice(0, 3).map(i => ({ link: i.link?.substring(0, 30), unread: i.unread, unreadType: typeof i.unread })));
    
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
        log('renderItems: hideRead is true, filtering');
        allItems = allItems.filter(item => item.unread !== false);
    }
    
    if (filteredFeedTitle) {
        allItems = allItems.filter(item => item.feedTitle === filteredFeedTitle);
    }
    
    log('renderItems: total items after filter:', allItems.length);
    log('renderItems: filteredFeedTitle:', filteredFeedTitle);
    log('renderItems: hideRead:', hideRead);
    log('renderItems: All feed titles:', feeds.map(f => f.title || f.url));
    
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
        
        // Special logging for Jan-Lukas feed
        if (feedTitle && feedTitle.includes('Jan-Lukas')) {
            console.log('[Auth] renderItems: Jan-Lukas item:', { link: item.link, unread: item.unread, type: typeof item.unread });
        }
        
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
        
        const markUnreadLink = item.unread === false ? `<span class="item-action"> | <a class="mark-unread-link" href="#" data-item-link="${item.link}" title="Mark this item as unread">Mark as unread</a></span>` : '';
        
        const itemClass = item.unread === false ? 'item read' : 'item';
        console.log('[Auth] renderItems: item class:', itemClass, 'for link:', item.link?.substring(0, 30), 'unread:', item.unread, 'type:', typeof item.unread);
        
        return `
            <div class="${itemClass}">
                <div class="item-meta">
                    <span class="item-date">${dateStr}</span>
                    <span class="item-feed">(<a class="filter-feed-link" href="#" data-feed-title="${escapeHtml(feedTitle)}" title="Show only items from this feed">${feedTitle}</a> | <a class="mark-all-read-link" href="#" data-feed-title="${escapeHtml(feedTitle)}" title="Mark all items from this feed as read">Mark all as read</a>${markUnreadLink})</span>
                </div>
                <div class="item-title">
                    <a href="${escapeHtml(item.link)}" target="_blank" name="${getItemId(item)}" id="${getItemId(item)}" data-item-link="${escapeHtml(item.link)}">${titleHtml}</a>
                </div>
                ${contentHtml ? `<div class="item-content">${contentHtml}</div>` : ''}
            </div>
        `;
    }).join('') + '</div>';
    log('renderItems: finished successfully');
    } catch (e) {
        console.error('[Auth] renderItems: ERROR:', e);
    }
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
                case 'ready':
                    console.log('[Auth] Feed worker ready');
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
                        renderItems();
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
    console.log('[Auth] Feed worker initialized, waiting for ready...');
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
    console.log('[Auth] Login event fired, user:', user?.email);
    const jwtPayload = decodeJWT(user.token);
    console.log('[Auth] JWT payload:', jwtPayload);
    if (jwtPayload?.sub) {
        console.log('[Auth] Creating blob store for user:', jwtPayload.sub);
        blobStore = createBlobStore();
        await blobStore.init(jwtPayload.sub);
        console.log('[Auth] Blob store initialized, displaying cached data immediately');
        renderItems();
        renderFeeds();
        initFeedWorker(jwtPayload.sub);
    }
    console.log('[Auth] Calling updateUI');
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
                    blobStore.markItemReadState(feed.url, itemLink, true);
                    break;
                }
            }
        }
        renderItems();
    }
});

itemsContainer.addEventListener('click', async (e) => {
    const filterLink = e.target.closest('a.filter-feed-link');
    if (filterLink) {
        e.preventDefault();
        const clickedFeedTitle = filterLink.getAttribute('data-feed-title');
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
        const clickedFeedTitle = markAllLink.getAttribute('data-feed-title');
        log('Mark all as read clicked for:', clickedFeedTitle);
        if (!confirm(`Mark all items in "${clickedFeedTitle}" as read?`)) {
            return;
        }
        const feeds = getFeeds(blobStore);
        log('All feeds titles:', feeds.map(f => ({ title: f.title, url: f.url })));
        // Try matching by title OR by URL
        const feed = feeds.find(f => f.title === clickedFeedTitle || f.url === clickedFeedTitle);
        log('Found feed:', feed);
        console.log('[Auth] Feed items count:', feed.items?.length);
        if (feed.items?.length > 0) {
            console.log('[Auth] Feed items:', feed.items.map(i => ({ link: i.link.substring(0, 50), unread: i.unread === undefined ? 'undefined' : i.unread })));
        }
        if (feed) {
            console.log('[Auth] Before markFeedAsRead, items:', feed.items?.map(i => ({ link: i.link, unread: i.unread === undefined ? 'undefined' : i.unread })));
            console.log('[Auth] Calling markFeedAsRead with url:', feed.url);
            blobStore.markFeedAsRead(feed.url);
            // Check data immediately after
            const feedsCheck1 = getFeeds(blobStore);
            const feedCheck1 = feedsCheck1.find(f => f.url === feed.url);
            console.log('[Auth] Immediate after markFeedAsRead:', feedCheck1?.items?.map(i => ({ link: i.link, unread: i.unread })));
            
            // Force sync to IndexedDB first
            await new Promise(r => setTimeout(r, 100));
            const feedsAfter = getFeeds(blobStore);
            const feedAfter = feedsAfter.find(f => f.url === feed.url);
            console.log('[Auth] After markFeedAsRead (100ms later), items:', feedAfter?.items?.map(i => ({ link: i.link, unread: i.unread === undefined ? 'undefined' : i.unread })));
            
            log('renderItems: about to render');
            renderItems();
            log('renderItems: finished');
        } else {
            console.log('[Auth] ERROR: Feed not found!');
        }
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
        renderItems();
    }
});

updateUI();

window.addEventListener('onlyread:dataUpdated', () => {
    console.log('[Auth] Data updated from blob, re-rendering UI');
    renderItems();
    renderFeeds();
});
