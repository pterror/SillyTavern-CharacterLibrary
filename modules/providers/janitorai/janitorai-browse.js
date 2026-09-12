
import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { janitoraiSessionStatus } from '../janitor-session.js';
import { IMG_PLACEHOLDER, formatNumber, BROWSE_PURIFY_CONFIG, skeletonLines, deferRender, deferCall, isMobileMode, finishBrowseImport, renderBrowseError, buildProviderNotice } from '../provider-utils.js';
import {
    HAMPTER_PAGE_SIZE,
    HAMPTER_SORTS,
    fetchJanitoraiCharacters,
    fetchJanitoraiCharacter,
    fetchJanitoraiTags,
    fetchJanitoraiFollowing,
    setJanitoraiFollow,
    searchJanitoraiCreators,
    resolveJanitoraiTagIds,
    resolveJanitoraiAvatarUrl,
    janitoraiCharacterUrl,
    hasHiddenDefinition,
    isLockedNoProxy,
    hydrateJanitoraiScripts,
    extractCharacterBookFromScripts,
    hasBrowserEndpoint,
    getBrowserMode,
    getBrowserEndpoint,
    extractViaBrowser,
    recoverViaBrowser,
    recoverPhaseLabel,
    recoverProgressText,
    stripHtml,
    decodeHtmlEntities,
    tagKey,
    pingHampterQueue,
} from './janitorai-api.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    debugLog,
    getSetting,
    setSetting,
    checkCharacterForDuplicatesAsync,
    showPreImportDuplicateWarning,
    deleteCharacter,
    getCharacterGalleryId,
    formatRichText,
    safePurify,
    renderCreatorNotesSecure,
    renderCardHtmlSecure,
    cleanupCreatorNotesContainer,
    debounce,
    getProviderExcludeTags,
    renderSkeletonGrid,
} = CoreAPI;

// ========================================
// STATE
// ========================================

let jaCharacters = [];
let jaCurrentPage = 1;
let jaTotalPages = 0;
let jaHasMore = true;
let jaIsLoading = false;
let jaLoadToken = 0;
// The token check discards a late response; only this stops the request itself.
let jaFetchController = null;
let jaCurrentSearch = '';
let jaNsfwEnabled = false;
let jaSortMode = 'popular';
let jaSelectedChar = null;
let jaGridRenderedCount = 0;
let jaMode = 'browse';

let jaFilterHideOwned = false;
// Listing rows carry a believable is_proxy_enabled, unlike showdefinition, which always reads
// false there. So this hides no-proxy rows, and only the preview can confirm a locked definition.
let jaFilterHideNoProxy = false;
let jaFilterHidePossible = false;
/** @type {Set<number>} */
let jaIncludeTags = new Set();
/** @type {Set<number>} */
let jaExcludeTags = new Set();
/** @type {{id: string, name: string}|null} */
let jaCreatorFilter = null;
// Set when a creator is opened from the Following manager, so clearing lands back there.
let _returnToFollowing = false;
let jaFollowingCurrentCreator = false;
/** @type {Array<{id:string,name:string,avatar:string}>} */
let jaFollowed = [];
let jaFollowedLoaded = false;
/** @type {Array<{id:number,name:string,slug:string}>} */
let jaTagCatalogue = [];

let view;

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharInLocalLibrary(hit) {
    const id = hit?.character_id || hit?.id;
    if (id && view._lookup.byProviderId.has(String(id))) return true;

    const name = (hit?.name || '').toLowerCase().trim();
    const creator = (hit?.creator_name || '').toLowerCase().trim();
    if (name && creator && view._lookup.byNameAndCreator.has(`${name}|${creator}`)) return true;

    return false;
}

function isCharPossibleMatchObj(hit) {
    if (isCharInLocalLibrary(hit)) return false;
    return view.isCharPossibleMatch(hit?.name || '', hit?.creator_name || '');
}

// ========================================
// CARD RENDERING
// ========================================

function createCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.description) || '';
    // Cards render small, so request a sized avatar variant, not the full-size original.
    const avatarUrl = resolveJanitoraiAvatarUrl(hit, { width: 300 }) || '/img/ai4.png';
    const tags = (hit.tags || []).slice(0, 3).map(t => t.name).filter(Boolean);
    const charId = hit.character_id || '';
    const creatorName = hit.creator_name || '';
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleTier = inLibrary ? null : view.getPossibleMatchTier(name, creatorName);
    const possibleMatch = !!possibleTier?.show;

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    } else if (possibleMatch) {
        badges.push(`<span class="browse-feature-badge possible-library pl-${possibleTier.tier}" title="${possibleTier.tooltip}"><i class="fa-solid fa-check"></i></span>`);
    }

    const createdDate = hit.created_at ? new Date(hit.created_at).toLocaleDateString() : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';
    const cardClass = inLibrary ? 'browse-card in-library' : possibleMatch ? 'browse-card possible-library' : 'browse-card';

    return `
        <div class="${cardClass}" data-janitorai-id="${escapeHtml(String(charId))}" ${desc ? `title="${escapeHtml(desc.slice(0, 300))}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${badges.length ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
                ${hit.is_nsfw ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creatorName ? `<span class="browse-card-creator-link" data-creator-id="${escapeHtml(hit.creator_id || '')}" data-creator-name="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" style="cursor: pointer;" title="Click to filter by &quot;${escapeHtml(t)}&quot;">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Chats"><i class="fa-solid fa-comments"></i> ${formatNumber(hit.chat_count || 0)}</span>
                <span class="browse-card-stat" title="Messages"><i class="fa-solid fa-envelope"></i> ${formatNumber(hit.message_count || 0)}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById(activeGridId());
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        jaGridRenderedCount = 0;
    }

    const startIdx = jaGridRenderedCount;
    grid.insertAdjacentHTML('beforeend', characters.slice(startIdx).map(createCard).join(''));
    jaGridRenderedCount = characters.length;

    view.observeImages(grid);
    updateLoadMore();
}

function updateLoadMore() {
    view.updateLoadMoreVisibility(activeLoadMoreId(), jaHasMore, jaCharacters.length > 0);
}

// ========================================
// LOAD
// ========================================

// Exclude tags with no numeric id are filtered client-side.
let jaUnresolvedExcludes = [];

async function resolvePersistentExcludes() {
    const names = getProviderExcludeTags('janitorai') || [];
    if (!names.length) {
        jaUnresolvedExcludes = [];
        return [];
    }
    const { ids, unresolved } = await resolveJanitoraiTagIds(names);
    jaUnresolvedExcludes = unresolved.map(n => tagKey(n));
    return ids;
}

function passesClientFilters(hit) {
    if (jaFilterHideOwned && isCharInLocalLibrary(hit)) return false;
    if (jaFilterHidePossible && isCharPossibleMatchObj(hit)) return false;
    if (jaFilterHideNoProxy && hit?.is_proxy_enabled === false) return false;
    if (jaUnresolvedExcludes.length) {
        // tagKey on both sides: hampter catalogue names carry an emoji prefix ("👨 Male")
        const names = (hit.tags || []).map(t => tagKey(t.name));
        if (jaUnresolvedExcludes.some(ex => names.includes(ex))) return false;
    }
    return true;
}

// CF Waiting Room holds the queue spot in a cookie that dies after 2 minutes of silence, so the
// watch re-polls at the page's own 20s cadence through the same transport (same cookie jar).
let jaQueueWatchTimer = null;
let jaQueueWatchUntil = 0;
let jaQueueWatchSince = 0;

function renderQueueBanner(grid, err, waitMinutes, { expired = false } = {}) {
    if (!grid) return;
    const elapsedMin = jaQueueWatchSince ? Math.floor((Date.now() - jaQueueWatchSince) / 60_000) : 0;
    const waited = elapsedMin >= 1 ? ` Waiting ${elapsedMin} minute${elapsedMin === 1 ? '' : 's'} so far.` : '';
    // Verified live: during maintenance holds the estimate sits still and nobody is admitted.
    const stalled = !expired && Number.isFinite(waitMinutes) && elapsedMin >= waitMinutes + 3
        ? ' Their estimate has not held, so this looks like full maintenance; the watch stays on and gets you in the moment they reopen.'
        : '';
    const est = !expired && Number.isFinite(waitMinutes)
        ? ` JanitorAI currently estimates about ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}.`
        : '';
    renderBrowseError(grid, {
        provider: 'janitorai',
        error: err,
        title: 'JanitorAI queue is active',
        message: expired
            ? `JanitorAI's waiting room is still up after ${elapsedMin} minutes, so automatic checking stopped. Press Retry to check again (it re-enters the queue).`
            : `JanitorAI put visitors in a waiting room (high load or maintenance). Character Library is holding your place in the queue and checks every 20 seconds; the grid loads by itself the moment you are through.${est}${waited}${stalled}`,
        view: jaMode,
        flags: { nsfw: jaNsfwEnabled, following: jaMode === 'following', managedBrowser: getBrowserMode() === 'managed', hasEndpoint: !!getBrowserEndpoint() },
        retry: () => loadCharacters(false),
    });
}

function startQueueWatch() {
    if (jaQueueWatchTimer) return;
    jaQueueWatchUntil = Date.now() + 30 * 60_000;
    if (!jaQueueWatchSince) jaQueueWatchSince = Date.now();
    const tick = async () => {
        jaQueueWatchTimer = null;
        if (!delegatesInitialized) return;
        if (Date.now() > jaQueueWatchUntil) {
            const grid = document.getElementById(activeGridId());
            if (!jaIsLoading && grid?.querySelector('.browse-error-banner')) {
                renderQueueBanner(grid, new Error('JanitorAI waiting room still active when the watch cap expired'), null, { expired: true });
            }
            return;
        }
        const res = await pingHampterQueue();
        if (!delegatesInitialized) return;
        if (res.through) { jaQueueWatchSince = 0; loadCharacters(false); return; }
        // Refresh the on-banner estimate while still queued (skip if a load replaced the banner).
        const grid = document.getElementById(activeGridId());
        if (!jaIsLoading && grid?.querySelector('.browse-error-banner')) {
            renderQueueBanner(grid, res.error, res.waitMinutes);
        }
        jaQueueWatchTimer = setTimeout(tick, 20_000);
    };
    jaQueueWatchTimer = setTimeout(tick, 20_000);
}

function stopQueueWatch() {
    if (jaQueueWatchTimer) { clearTimeout(jaQueueWatchTimer); jaQueueWatchTimer = null; }
}

async function loadCharacters(append = false) {
    if (append && jaIsLoading) return;
    stopQueueWatch();
    const thisToken = ++jaLoadToken;
    jaIsLoading = true;
    try { jaFetchController?.abort(); } catch { /* already settled */ }
    jaFetchController = new AbortController();
    const signal = jaFetchController.signal;

    const grid = document.getElementById(activeGridId());
    const loadMoreBtn = document.getElementById(jaMode === 'following' ? 'janitoraiFollowingLoadMoreBtn' : 'janitoraiLoadMoreBtn');

    if (!append) {
        jaCurrentPage = 1;
        // Reset here so the previous query cannot repaint under a new filter.
        jaCharacters = [];
        jaGridRenderedCount = 0;
        if (grid) renderSkeletonGrid(grid);
    }
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const following = jaMode === 'following';
        const creatorIds = (!following && jaCreatorFilter) ? [jaCreatorFilter.id] : [];

        // The following feed takes no tag params, so excludes apply client-side by name.
        const excludeTagIds = following ? [] : await resolvePersistentExcludes();
        if (following) jaUnresolvedExcludes = (getProviderExcludeTags('janitorai') || []).map(n => tagKey(n));
        if (thisToken !== jaLoadToken) return;

        const data = await fetchJanitoraiCharacters({
            signal,
            following,
            sort: jaSortMode,
            page: jaCurrentPage,
            search: jaCurrentSearch,
            mode: jaNsfwEnabled ? 'all' : 'sfw',
            tagIds: [...jaIncludeTags],
            excludeTagIds: [...new Set([...jaExcludeTags, ...excludeTagIds])],
            creatorIds,
        });

        if (thisToken !== jaLoadToken || !delegatesInitialized) return;

        // Nobody followed reads as an empty feed; say so instead of "no characters found".
        if (following && !data.total && !append) {
            jaCharacters = [];
            jaHasMore = false;
            renderEmptyFollowing(grid);
            return;
        }

        let hits = data.characters.filter(passesClientFilters);
        jaTotalPages = data.total > 0 ? Math.ceil(data.total / (data.pageSize || HAMPTER_PAGE_SIZE)) : 0;

        // Client filters can empty a page, so pull a few more while pages remain.
        let autoFetches = 0;
        while (hits.length < 12 && jaCurrentPage < jaTotalPages && autoFetches < 3 && delegatesInitialized) {
            autoFetches++;
            jaCurrentPage++;
            const more = await fetchJanitoraiCharacters({
                signal,
                following,
                sort: jaSortMode,
                page: jaCurrentPage,
                search: jaCurrentSearch,
                mode: jaNsfwEnabled ? 'all' : 'sfw',
                tagIds: [...jaIncludeTags],
                excludeTagIds: [...new Set([...jaExcludeTags, ...excludeTagIds])],
                creatorIds,
            });
            if (thisToken !== jaLoadToken || !delegatesInitialized) return;
            hits = hits.concat(more.characters.filter(passesClientFilters));
        }

        if (append) {
            const seen = new Set(jaCharacters.map(c => c.character_id));
            jaCharacters = jaCharacters.concat(hits.filter(h => !h.character_id || !seen.has(h.character_id)));
        } else {
            jaCharacters = hits;
        }
        jaHasMore = jaCurrentPage < jaTotalPages;
        jaQueueWatchSince = 0;

        renderGrid(jaCharacters, append);

        if (!append && jaCharacters.length === 0 && grid) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-ghost" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px; font-weight: 600;">No characters found</p>
                    <p style="margin-top: 8px; font-size: 0.9em;">Try a different search term or relax your tag filters.</p>
                </div>
            `;
        }

        debugLog('[JanitoraiBrowse] Loaded', hits.length, 'characters, page', jaCurrentPage, '/', jaTotalPages);
    } catch (err) {
        if (thisToken !== jaLoadToken) return;
        // A cancellation is not a failure, so do not show an error banner.
        if (err?.name === 'AbortError') return;
        console.error('[JanitoraiBrowse] Load error:', err);
        handleLoadError(err, append, grid);
    } finally {
        if (thisToken === jaLoadToken) {
            jaIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

function handleLoadError(err, append, grid) {
    const code = err?.code;
    // Before the code branches: waiting-room errors carry HAMPTER_BLOCKED and would hit the
    // Cloudflare copy below.
    if (/waiting room/i.test(err?.message || '')) {
        startQueueWatch();
        if (append) {
            jaCurrentPage = Math.max(1, jaCurrentPage - 1);
            showToast('JanitorAI queue is active. Holding your place; the grid refreshes once you are through.', 'info', 8000);
            return;
        }
        renderQueueBanner(grid, err, err?.queueWaitMinutes);
        return;
    }
    const gated = code === 'HAMPTER_LOGIN_REQUIRED' || code === 'HAMPTER_TOKEN_EXPIRED';

    if (gated && append) {
        // Anonymous access stops after page 1; end pagination cleanly rather than erroring.
        jaCurrentPage = Math.max(1, jaCurrentPage - 1);
        jaTotalPages = jaCurrentPage;
        jaHasMore = false;
        updateLoadMore();
        showToast(code === 'HAMPTER_TOKEN_EXPIRED'
            ? 'Your JanitorAI session expired. Re-paste your token in Settings to keep browsing.'
            : 'JanitorAI serves only the first page without a login. Add your JanitorAI session in Settings for more.', 'info', 7000);
        return;
    }
    if (code === 'HAMPTER_RATE_LIMITED' && append) {
        jaCurrentPage = Math.max(1, jaCurrentPage - 1);
        showToast('JanitorAI is rate limiting. Give it a moment, then load more.', 'warning', 6000);
        return;
    }
    if (code === 'HAMPTER_BLOCKED' && append) {
        jaCurrentPage = Math.max(1, jaCurrentPage - 1);
        showToast(err?.browserError
            ? 'The browser endpoint did not answer, so this page could not load. Check it under Settings > Online > JanitorAI and press Test.'
            : 'Cloudflare blocked this page load. Check the browser under Settings > Online > JanitorAI: press Test there to see what is failing.', 'warning', 6000);
        return;
    }

    if (code === 'HAMPTER_RATE_LIMITED') {
        showToast('JanitorAI is rate limiting. Wait a moment and try again.', 'warning', 7000);
        if (!append && grid) grid.innerHTML = '';
        return;
    }

    if (!append && grid) {
        if (gated) {
            const expired = code === 'HAMPTER_TOKEN_EXPIRED';
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted); max-width: 560px; margin: 0 auto;">
                    <i class="fa-solid fa-user-lock" style="font-size: 2rem; color: #f5a623;"></i>
                    <p style="margin-top: 12px; color: var(--text-primary);"><strong>${expired ? 'Your JanitorAI session expired' : 'JanitorAI requires an account for this request'}</strong></p>
                    <p style="margin-top: 8px; font-size: 0.9em;">Add your JanitorAI session in Settings &gt; Online &gt; JanitorAI to browse past the first page.</p>
                </div>
            `;
            return;
        }
        // Surface the browser-endpoint failure, not the direct-leg fallback's Cloudflare 403.
        const endpointDown = !!err?.browserError;
        const noBrowser = code === 'HAMPTER_BLOCKED' && !hasBrowserEndpoint();
        renderBrowseError(grid, {
            provider: 'janitorai',
            error: err,
            title: endpointDown ? 'Could not reach the browser' : (noBrowser ? 'JanitorAI needs a browser' : undefined),
            message: endpointDown
                ? `The browser endpoint in Settings did not answer (${err.browserError}), so this fell back to a direct request, which Cloudflare refused. Start the built-in browser or fix the endpoint, then press Test.`
                : noBrowser
                    ? 'Cloudflare refuses every request that is not a real browser. Start the built-in browser under Settings > Online > JanitorAI, or point Character Library at one you run yourself.'
                    : `Load failed: ${err.message}`,
            view: jaMode,
            flags: { nsfw: jaNsfwEnabled, following: jaMode === 'following', managedBrowser: getBrowserMode() === 'managed', hasEndpoint: !!getBrowserEndpoint() },
            help: (endpointDown || noBrowser)
                ? { label: 'How the JanitorAI browser works', section: 'providers', anchor: 'helpJanitorai' }
                : undefined,
            retry: () => loadCharacters(false),
        });
        return;
    }
    showToast(`JanitorAI load failed: ${err.message}`, 'error');
}

function renderEmptyFollowing(grid) {
    if (!grid) return;
    grid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
            <i class="fa-solid fa-user-group" style="font-size: 2rem; opacity: 0.5;"></i>
            <p style="margin-top: 12px; font-weight: 600;">You are not following anyone</p>
            <p style="margin-top: 8px; font-size: 0.9em;">Follow creators on janitorai.com, or use the manager below to add them.</p>
        </div>
    `;
    updateLoadMore();
}

async function loadFollowedCreators() {
    try {
        jaFollowed = await fetchJanitoraiFollowing();
        jaFollowedLoaded = true;
    } catch (e) {
        jaFollowed = [];
        jaFollowedLoaded = false;
        debugLog('[JanitoraiBrowse] following fetch failed:', e.message);
        throw e;
    }
}

// ========================================
// PREVIEW MODAL
// ========================================

let jaDetailToken = 0;
let jaDetailPromise = null;
// What the notes pane currently shows, so the detail only re-renders when it has more.
let jaPaintedNotes = '';

const MODAL_TEXT_IDS = [
    'janitoraiCharDescription',
    'janitoraiCharScenario',
    'janitoraiCharFirstMsg',
    'janitoraiCharExamples',
    'janitoraiCharAltGreetings',
    'janitoraiCharTags',
];

function openPreviewModal(hit) {
    jaSelectedChar = hit;

    const modal = document.getElementById('janitoraiCharModal');
    if (!modal) return;
    CoreAPI.resetBrowseSectionCollapseState(modal);

    const name = hit.name || 'Unknown';
    const charId = hit.character_id || hit.id || '';
    const avatarUrl = resolveJanitoraiAvatarUrl(hit) || '/img/ai4.png';
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleMatch = !inLibrary && view.isCharPossibleMatch(name, hit.creator_name || '');

    const avatarImg = document.getElementById('janitoraiCharAvatar');
    avatarImg.src = avatarUrl;
    avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
    BrowseView.adjustPortraitPosition(avatarImg);
    document.getElementById('janitoraiCharName').textContent = name;
    const creatorEl = document.getElementById('janitoraiCharCreator');
    creatorEl.textContent = hit.creator_name || 'Unknown';
    creatorEl.dataset.creatorId = hit.creator_id || '';
    document.getElementById('janitoraiOpenInBrowserBtn').href = janitoraiCharacterUrl(charId, name);

    document.getElementById('janitoraiCharChats').textContent = formatNumber(hit.chat_count || 0);
    document.getElementById('janitoraiCharMessages').textContent = formatNumber(hit.message_count || 0);
    document.getElementById('janitoraiCharDate').textContent = hit.created_at
        ? new Date(hit.created_at).toLocaleDateString()
        : 'Unknown';
    setTokenStat(hit.total_tokens || 0);
    setHiddenNotice(null);

    const tagsEl = document.getElementById('janitoraiCharTags');
    tagsEl.innerHTML = (hit.tags || []).map(t => `<span class="browse-tag" style="cursor: pointer;" title="Click to filter by this tag">${escapeHtml(t.name || '')}</span>`).join('');
    // After paint: the clamp measures offsetTop, which is meaningless until layout has run.
    requestAnimationFrame(() => applyJanitoraiTagsClamp(tagsEl));

    // Paint from the listing row so the section is not empty while the detail loads.
    const rawDescription = hit.description || '';
    jaPaintedNotes = rawDescription;
    const notesSection = document.getElementById('janitoraiCharCreatorNotesSection');
    const notesEl = document.getElementById('janitoraiCharCreatorNotes');
    if (rawDescription.trim()) {
        notesSection.style.display = 'block';
        if (notesEl && !notesEl.querySelector('iframe')) notesEl.innerHTML = skeletonLines(3);
        deferCall(notesEl, () => renderCreatorNotesSecure(rawDescription, name, notesEl));
    } else {
        notesSection.style.display = 'none';
        if (notesEl) notesEl.innerHTML = '';
    }

    for (const [sectionId, elId, lines] of [
        ['janitoraiCharDescriptionSection', 'janitoraiCharDescription', 3],
        ['janitoraiCharScenarioSection', 'janitoraiCharScenario', 2],
        ['janitoraiCharFirstMsgSection', 'janitoraiCharFirstMsg', 4],
        ['janitoraiCharExamplesSection', 'janitoraiCharExamples', 3],
    ]) {
        const section = document.getElementById(sectionId);
        const el = document.getElementById(elId);
        if (section && el) { section.style.display = 'block'; el.innerHTML = skeletonLines(lines); }
    }
    const altSection = document.getElementById('janitoraiCharAltGreetingsSection');
    if (altSection) altSection.style.display = 'none';
    // Reset or a card whose detail fetch fails shows the previous card's lorebook.
    const loreSection = document.getElementById('janitoraiCharLorebookSection');
    if (loreSection) loreSection.style.display = 'none';
    // Reset the detail-driven stat chips too, or a failed fetch keeps the previous counts.
    for (const id of ['janitoraiCharGreetingsStat', 'janitoraiCharLorebookStat']) {
        const chip = document.getElementById(id);
        if (chip) chip.style.display = 'none';
    }

    setImportButtonState(inLibrary, possibleMatch, 'pending');

    modal.classList.remove('hidden');
    const body = modal.querySelector('.browse-char-body');
    if (body) body.scrollTop = 0;

    const token = ++jaDetailToken;
    jaDetailPromise = fetchAndPopulateDetails(hit, token);
}

function setImportButtonState(inLibrary, possibleMatch, state = 'ready') {
    const importBtn = document.getElementById('janitoraiImportBtn');
    if (!importBtn) return;
    importBtn.title = '';
    if (inLibrary) {
        importBtn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
        importBtn.classList.add('secondary');
        importBtn.classList.remove('primary', 'warning');
        importBtn.disabled = false;
        return;
    }
    // Whether an import runs the fast path or a full recovery is decided by the DETAIL
    // (the listing's showdefinition lies), so the button stays off until that truth lands.
    if (state === 'pending' || state === 'unavailable') {
        importBtn.innerHTML = state === 'pending'
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Import'
            : '<i class="fa-solid fa-download"></i> Import';
        importBtn.classList.add('primary');
        importBtn.classList.remove('secondary', 'warning');
        importBtn.disabled = true;
        importBtn.title = state === 'pending'
            ? 'Waiting for character details'
            : 'Character details could not be loaded; importing needs the same request';
        return;
    }
    if (possibleMatch) {
        importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import (Possible Match)';
        importBtn.classList.add('warning');
        importBtn.classList.remove('primary', 'secondary');
    } else {
        importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        importBtn.classList.add('primary');
        importBtn.classList.remove('secondary', 'warning');
    }
    importBtn.disabled = false;
}

function setTokenStat(total) {
    const el = document.getElementById('janitoraiCharTokens');
    const stat = document.getElementById('janitoraiCharTokensStat');
    if (el) el.textContent = formatNumber(total || 0);
    if (stat) stat.style.display = total ? 'flex' : 'none';
}

// tokens: the API's reported size for the withheld definition.
function setHiddenNotice(tokens, noProxy = false) {
    const el = document.getElementById('janitoraiHiddenNotice');
    if (!el) return;
    if (tokens === null || tokens === undefined) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    const size = tokens ? ` (~${formatNumber(tokens)} tokens)` : '';
    const configured = hasBrowserEndpoint();
    el.style.display = '';
    // No proxy means the prompt capture has nothing to read: asking the site's own model to repeat
    // its context is all that is left (model output), so it reads as an error rather than the amber
    // "this will just take longer" case.
    if (noProxy) {
        el.innerHTML = buildProviderNotice({
            kind: 'error',
            title: `Locked definition, no proxy${size}.`,
            message: configured
                ? 'The creator turned off proxy access, so it cannot be extracted normally. Character Library can ask the JanitorAI model to repeat it, which usually works but is not guaranteed to be exact.'
                : 'The creator turned off proxy access. Set up a browser in Settings to try recovering it anyway.',
            actions: configured ? [{ key: 'tryanyway', label: 'Try anyway', icon: 'fa-solid fa-wand-magic-sparkles' }] : [],
        });
        return;
    }
    // No browser means no definition and no greetings, so say so plainly.
    el.innerHTML = buildProviderNotice({
        kind: 'hidden',
        title: `Hidden definition${size}.`,
        message: configured
            ? 'Importing extracts it first, so it takes longer than usual. Or use the button to preview it now.'
            : 'Set up a browser in Settings to extract it. Importing now gets you no definition and no greetings.',
        actions: configured ? [{ key: 'recover', label: 'Extract now', icon: 'fa-solid fa-unlock' }] : [],
    });
}

// ONE owner per recovery run. Two runs both painting the single progress banner made its text
// alternate between them, and closing the card left the first driving the account for minutes.
let jaRecoverRun = null;
let jaRecoverSeq = 0;

function startRecoverRun(charId, kind) {
    cancelRecoverRun();
    jaRecoverRun = { id: ++jaRecoverSeq, charId, kind, controller: new AbortController() };
    return jaRecoverRun;
}

function cancelRecoverRun() {
    if (!jaRecoverRun) return;
    CoreAPI.debugLog?.(`[JanitoraiBrowse] cancelling ${jaRecoverRun.kind} recovery for ${jaRecoverRun.charId}`);
    jaRecoverRun.controller.abort();
    jaRecoverRun = null;
    clearRecoverProgress();
}

/** A superseded or cancelled run must not paint, toast, or write to the preview. */
function isRecoverRunLive(run) {
    return !!run && !!jaRecoverRun && jaRecoverRun.id === run.id;
}

function endRecoverRun(run) {
    if (isRecoverRunLive(run)) jaRecoverRun = null;
}

// Built once, text-only updates, so the spinner doesnt restart on every poll tick.
function setRecoverProgress(text) {
    const host = document.getElementById('janitoraiHiddenNotice');
    if (!host) return;
    const line = text || 'Starting...';
    let bar = document.getElementById('janitoraiRecoverProgress');
    if (!bar) {
        // Swap, dont stack: two banners about one card read as conflicting states.
        for (const n of host.querySelectorAll('.browse-notice')) n.classList.add('cl-hidden');
        const tmp = document.createElement('div');
        // Never seed '': buildProviderNotice drops the <p> entirely, leaving nothing to update.
        tmp.innerHTML = buildProviderNotice({
            kind: 'info',
            icon: 'fa-solid fa-spinner fa-spin',
            title: 'Extracting, this can take a few minutes',
            message: line,
        });
        bar = tmp.firstElementChild;
        if (!bar) return;
        bar.id = 'janitoraiRecoverProgress';
        host.insertBefore(bar, host.firstChild);
        return;
    }
    let msg = bar.querySelector('.browse-notice-message');
    if (!msg) {
        msg = document.createElement('p');
        msg.className = 'browse-notice-message';
        (bar.querySelector('.browse-notice-body') || bar).appendChild(msg);
    }
    msg.textContent = line;
}

function clearRecoverProgress() {
    const bar = document.getElementById('janitoraiRecoverProgress');
    if (!bar) return;
    bar.remove();
    // Restore the notice so a failed run still shows its retry action.
    const host = document.getElementById('janitoraiHiddenNotice');
    if (host) for (const n of host.querySelectorAll('.browse-notice')) n.classList.remove('cl-hidden');
}

async function recoverDefinitionIntoPreview() {
    const hit = jaSelectedChar;
    const charId = hit?.character_id || hit?.id;
    if (!charId) return;
    const btn = document.querySelector('#janitoraiHiddenNotice [data-notice-action="recover"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Extracting...'; }
    // No phases here, so it stays static; otherwise a multi-minute wait signals only a spinner.
    setRecoverProgress('Reading the assembled prompt from JanitorAI.');

    const run = startRecoverRun(charId, 'preview');
    try {
        const rec = await extractViaBrowser(String(charId), undefined, { signal: run.controller.signal });
        // The user can have moved on to another card during the round trip.
        if (!isRecoverRunLive(run)) return;
        endRecoverRun(run);
        clearRecoverProgress();
        if (!rec?.definition) throw new Error('Nothing came back');
        if (jaSelectedChar && (jaSelectedChar.character_id || jaSelectedChar.id) === charId) {
            jaSelectedChar._recoveredDefinition = rec.definition;
            jaSelectedChar._recoveredFirstMessage = rec.firstMessage || '';
        }
        const name = hit.name || 'Unknown';
        populateSectionSecure('janitoraiCharDescriptionSection', 'janitoraiCharDescription', rec.definition, name);
        // The opening line is withheld alongside the definition, so it only appears now.
        if (rec.firstMessage) {
            populateSection('janitoraiCharFirstMsgSection', 'janitoraiCharFirstMsg', rec.firstMessage, name,
                (el, text) => { el.dataset.fullContent = text; });
        }
        setHiddenNotice(null);
        showToast('Definition and greeting recovered', 'success');
    } catch (err) {
        if (err?.cancelled || !isRecoverRunLive(run)) return;
        endRecoverRun(run);
        clearRecoverProgress();
        showToast(`Could not extract this character: ${err.message}`, 'error', 8000);
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-unlock"></i> Extract now'; }
    }
}

// The no-proxy sibling of recoverDefinitionIntoPreview. What comes back is model output, so the
// copy says so and the card carries the same warning into the library.
async function recoverLockedIntoPreview() {
    const hit = jaSelectedChar;
    const charId = hit?.character_id || hit?.id;
    if (!charId) return;
    const btn = document.querySelector('#janitoraiHiddenNotice [data-notice-action="tryanyway"]');
    const setBtn = (label) => { if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`; };
    if (btn) btn.disabled = true;
    setBtn(recoverPhaseLabel('setup'));
    setRecoverProgress(recoverProgressText('setup'));

    const run = startRecoverRun(charId, 'preview');
    try {
        const rec = await recoverViaBrowser(String(charId), undefined, (phase, detail) => {
            if (!isRecoverRunLive(run)) return;
            setBtn(recoverPhaseLabel(phase));
            setRecoverProgress(recoverProgressText(phase, detail));
        }, { signal: run.controller.signal });
        if (!isRecoverRunLive(run)) return;
        endRecoverRun(run);
        clearRecoverProgress();
        if (!rec?.personality) throw new Error('Nothing came back');
        if (jaSelectedChar && (jaSelectedChar.character_id || jaSelectedChar.id) === charId) {
            jaSelectedChar._recoveredNoProxy = rec;
        }
        const name = hit.name || 'Unknown';
        populateSectionSecure('janitoraiCharDescriptionSection', 'janitoraiCharDescription', rec.personality, name);
        if (rec.scenario) populateSection('janitoraiCharScenarioSection', 'janitoraiCharScenario', rec.scenario, name);
        if (rec.exampleDialogs) populateSection('janitoraiCharExamplesSection', 'janitoraiCharExamples', rec.exampleDialogs, name);
        if (rec.firstMessage) {
            populateSection('janitoraiCharFirstMsgSection', 'janitoraiCharFirstMsg', rec.firstMessage, name,
                (el, text) => { el.dataset.fullContent = text; });
        }
        setHiddenNotice(null);
        showToast('Recovered from the model. Check it before relying on it: this is not the creator file.', 'warning', 9000);
    } catch (err) {
        // A cancel is the reader closing the card, which needs no error about it.
        if (err?.cancelled || !isRecoverRunLive(run)) return;
        endRecoverRun(run);
        clearRecoverProgress();
        showToast(`Could not recover this character: ${err.message}`, 'error', 8000);
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Try anyway'; }
    }
}

async function fetchAndPopulateDetails(hit, token) {
    const charId = hit.character_id || hit.id || '';
    const name = hit.name || 'Unknown';

    try {
        let detail = null;
        let failCode = '';
        let failBrowserError = '';
        let failClassified = '';
        try {
            detail = await fetchJanitoraiCharacter(charId);
        } catch (e) {
            failCode = e?.code || '';
            failBrowserError = e?.browserError || '';
            // Cloudflare keeps the bespoke press-Test copy below; other classifications (waiting
            // room, proxy disabled) surface verbatim.
            failClassified = (e?.classified && !/^Cloudflare/.test(e.message || '')) ? (e.message || '') : '';
            debugLog('[JanitoraiBrowse] Detail fetch failed:', e.message);
        }
        if (token !== jaDetailToken) return;

        if (!detail) {
            const descSection = document.getElementById('janitoraiCharDescriptionSection');
            const descEl = document.getElementById('janitoraiCharDescription');
            if (descSection && descEl) {
                descSection.style.display = 'block';
                // Login gating (401) is a separate wall from Cloudflare, not fixed by the browser.
                const gated = failCode === 'HAMPTER_LOGIN_REQUIRED' || failCode === 'HAMPTER_TOKEN_EXPIRED';
                const limited = failCode === 'HAMPTER_RATE_LIMITED';
                const msg = gated
                    ? (failCode === 'HAMPTER_TOKEN_EXPIRED'
                        ? 'Your JanitorAI session expired, so this character\'s details could not be loaded. Sign in again in Settings.'
                        : 'JanitorAI hides this character\'s details from signed-out visitors. Sign in under Settings &gt; Online &gt; JanitorAI to see them.')
                    : limited
                        ? 'JanitorAI is rate limiting. Wait a moment, then reopen this character.'
                        : failClassified
                            ? `${escapeHtml(failClassified)}.`
                            : failBrowserError
                                ? 'The browser endpoint did not answer, so the definition could not be fetched. Check it under Settings > Online > JanitorAI and press Test.'
                                : 'Cloudflare blocked the definition fetch. Check the browser under Settings > Online > JanitorAI: press Test there to see what is failing.';
                descEl.innerHTML = `<em style="color: var(--text-secondary, #888)">${msg}${limited ? '' : ' Importing uses the same request, so it will not work until this does.'}</em>`;
            }
            hideSections(['janitoraiCharScenarioSection', 'janitoraiCharFirstMsgSection', 'janitoraiCharExamplesSection', 'janitoraiCharLorebookSection']);
            setImportButtonState(isCharInLocalLibrary(hit), false, 'unavailable');
            return;
        }

        if (jaSelectedChar && (jaSelectedChar.character_id || jaSelectedChar.id) === charId) {
            jaSelectedChar._detail = detail;
        }

        setTokenStat(detail.token_counts?.total_tokens || hit.total_tokens || 0);
        setHiddenNotice(hasHiddenDefinition(detail)
            ? (detail.token_counts?.personality_tokens || 0)
            : null, isLockedNoProxy(detail, hit));
        // The import path branches on the detail (public vs recovery), and it just arrived.
        const inLib = isCharInLocalLibrary(hit);
        setImportButtonState(inLib, !inLib && view.isCharPossibleMatch(name, detail.creator_name || hit.creator_name || ''));

        // The listing truncates description, so replace it with the detail's full copy.
        const fullNotes = decodeHtmlEntities(detail.description || '');
        if (fullNotes && fullNotes !== jaPaintedNotes) {
            const notesSection = document.getElementById('janitoraiCharCreatorNotesSection');
            const notesEl = document.getElementById('janitoraiCharCreatorNotes');
            if (notesSection && notesEl) {
                jaPaintedNotes = fullNotes;
                notesSection.style.display = 'block';
                deferCall(notesEl, () => renderCreatorNotesSecure(fullNotes, name, notesEl));
            }
        }

        // Detail tags are richer than the listing row's, so re-render them.
        const tagsEl = document.getElementById('janitoraiCharTags');
        if (tagsEl) {
            const allTags = [
                ...(detail.tags || []).map(t => t?.name || ''),
                ...(detail.custom_tags || []).map(t => (typeof t === 'string' ? t : t?.name || '')),
            ].filter(Boolean);
            tagsEl.innerHTML = allTags.map(t => `<span class="browse-tag" style="cursor: pointer;" title="Click to filter by this tag">${escapeHtml(decodeHtmlEntities(t))}</span>`).join('');
            requestAnimationFrame(() => applyJanitoraiTagsClamp(tagsEl));
        }

        populateSectionSecure('janitoraiCharDescriptionSection', 'janitoraiCharDescription', detail.personality, name);
        populateSection('janitoraiCharScenarioSection', 'janitoraiCharScenario', detail.scenario, name);
        populateSection('janitoraiCharFirstMsgSection', 'janitoraiCharFirstMsg', detail.first_message, name, (el, text) => {
            el.dataset.fullContent = text;
        });
        populateSection('janitoraiCharExamplesSection', 'janitoraiCharExamples', detail.example_dialogs, name);
        renderAltGreetings(detail.first_messages, name);

        // Lorebook content sits behind per-script fetches; hydrate AFTER the paint so the hidden
        // notice and sections never wait on those extra round-trips, while Import still finds it
        // pre-paid (its own hydrate call no-ops on the already-mutated scripts).
        await hydrateJanitoraiScripts(detail);
        if (token !== jaDetailToken) return;
        renderLorebookSummary(detail);
    } catch (err) {
        debugLog('[JanitoraiBrowse] Detail error:', err);
        if (token === jaDetailToken) {
            const descEl = document.getElementById('janitoraiCharDescription');
            if (descEl) descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load the character definition. Importing uses the same request, so it will not work until this does.</em>';
            setImportButtonState(isCharInLocalLibrary(hit), false, 'unavailable');
        }
    }
}

function hideSections(ids) {
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }
}

function populateSection(sectionId, elId, text, charName, after) {
    const section = document.getElementById(sectionId);
    const el = document.getElementById(elId);
    if (!section) return;
    if (text && String(text).trim()) {
        section.style.display = 'block';
        if (el) {
            deferRender(el, () => safePurify(formatRichText(text, charName, true), BROWSE_PURIFY_CONFIG));
            after?.(el, text);
        }
    } else {
        section.style.display = 'none';
        if (el) el.innerHTML = '';
    }
}

// Definition body renders in the sandboxed iframe so authored card CSS cant restyle the app
function populateSectionSecure(sectionId, elId, text, charName) {
    const section = document.getElementById(sectionId);
    const el = document.getElementById(elId);
    if (!section) return;
    if (text && String(text).trim()) {
        section.style.display = 'block';
        if (el) {
            if (!el.querySelector('iframe')) el.innerHTML = skeletonLines(3);
            deferCall(el, () => renderCardHtmlSecure(text, charName, el));
        }
    } else {
        section.style.display = 'none';
        if (el) {
            cleanupCreatorNotesContainer(el);
            el.innerHTML = '';
        }
    }
}

function renderAltGreetings(greetings, charName) {
    const section = document.getElementById('janitoraiCharAltGreetingsSection');
    const listEl = document.getElementById('janitoraiCharAltGreetings');
    const countEl = document.getElementById('janitoraiCharAltGreetingsCount');
    if (!section || !listEl) return;

    // The API pads this with nulls and invisible-char placeholders, so require a letter or digit.
    const clean = (Array.isArray(greetings) ? greetings : [])
        .map(g => (typeof g === 'string' ? g : g?.first_message || g?.message || ''))
        .filter(g => g && /[\p{L}\p{N}]/u.test(g));

    const greetStat = document.getElementById('janitoraiCharGreetingsStat');
    const greetStatCount = document.getElementById('janitoraiCharGreetingsCount');

    if (!clean.length) {
        section.style.display = 'none';
        listEl.innerHTML = '';
        if (countEl) countEl.textContent = '';
        if (greetStat) greetStat.style.display = 'none';
        CoreAPI.setBrowseAltGreetings([]);
        return;
    }

    if (greetStat && greetStatCount) {
        greetStatCount.textContent = String(clean.length);
        greetStat.style.display = 'flex';
    }

    const buildPreview = (text) => {
        const cleaned = (text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'No content';
        return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
    };

    section.style.display = 'block';
    listEl.innerHTML = clean.map((greeting, idx) => `
            <details class="browse-alt-greeting" data-greeting-idx="${idx}">
                <summary>
                    <span class="browse-alt-greeting-index">#${idx + 1}</span>
                    <span class="browse-alt-greeting-preview">${escapeHtml(buildPreview(greeting))}</span>
                    <span class="browse-alt-greeting-chevron"><i class="fa-solid fa-chevron-down"></i></span>
                </summary>
                <div class="browse-alt-greeting-body"></div>
            </details>
        `).join('');

    listEl.querySelectorAll('details.browse-alt-greeting').forEach(details => {
        details.addEventListener('toggle', function onToggle() {
            if (!details.open) return;
            const body = details.querySelector('.browse-alt-greeting-body');
            if (body && !body.dataset.rendered) {
                const idx = parseInt(details.dataset.greetingIdx, 10);
                if (clean[idx] != null) {
                    deferRender(body, () => safePurify(formatRichText(clean[idx], charName, true), BROWSE_PURIFY_CONFIG));
                }
                body.dataset.rendered = '1';
            }
        }, { once: true });
    });

    if (countEl) countEl.textContent = `(${clean.length})`;
    CoreAPI.setBrowseAltGreetings(clean);
}

// Measures offsetTop, not tag count, because the wrap point depends on tag width.
function applyJanitoraiTagsClamp(tagsEl) {
    if (!tagsEl) return;

    tagsEl.querySelector('.browse-tags-more')?.remove();
    tagsEl.querySelectorAll('.browse-tag-hidden').forEach(tag => tag.classList.remove('browse-tag-hidden'));
    tagsEl.classList.remove('browse-tags-collapsed', 'browse-tags-expanded');

    const tags = Array.from(tagsEl.querySelectorAll('.browse-tag'));
    if (!tags.length) return;

    tagsEl.classList.add('browse-tags-collapsed');

    const maxHeightValue = getComputedStyle(tagsEl).getPropertyValue('--browse-tags-max-height').trim();
    const maxHeight = parseFloat(maxHeightValue) || tagsEl.clientHeight || 64;

    let overflowIndex = -1;
    for (let i = 0; i < tags.length; i++) {
        if (tags[i].offsetTop + tags[i].offsetHeight > maxHeight + 2) { overflowIndex = i; break; }
    }
    if (overflowIndex === -1) {
        tagsEl.classList.remove('browse-tags-collapsed');
        return;
    }

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'browse-tag browse-tags-more';
    toggle.textContent = '...';
    toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (tagsEl.classList.contains('browse-tags-collapsed')) {
            tagsEl.classList.remove('browse-tags-collapsed');
            tagsEl.classList.add('browse-tags-expanded');
            tagsEl.querySelectorAll('.browse-tag-hidden').forEach(tag => tag.classList.remove('browse-tag-hidden'));
            tagsEl.appendChild(toggle);
        } else {
            applyJanitoraiTagsClamp(tagsEl);
        }
    });

    const insertIndex = Math.max(overflowIndex - 1, 0);
    tagsEl.insertBefore(toggle, tags[insertIndex]);
    for (let i = insertIndex; i < tags.length; i++) tags[i].classList.add('browse-tag-hidden');
}

function renderLorebookSummary(detail) {
    const section = document.getElementById('janitoraiCharLorebookSection');
    const el = document.getElementById('janitoraiCharLorebook');
    if (!section || !el) return;

    const stat = document.getElementById('janitoraiCharLorebookStat');
    const statCount = document.getElementById('janitoraiCharLorebookCount');

    const book = extractCharacterBookFromScripts(detail);
    const listed = (detail.scripts || []).filter(s => s?.type === 'lorebook' && s.is_public);
    if (!book && !listed.length) {
        section.style.display = 'none';
        el.innerHTML = '';
        if (stat) stat.style.display = 'none';
        return;
    }

    // Counts lorebooks, not entries; the entry count shows in the section body.
    const bookCount = Math.max(listed.length, book ? 1 : 0);
    if (stat && statCount) {
        statCount.textContent = String(bookCount);
        stat.innerHTML = `<i class="fa-solid fa-book"></i> <span id="janitoraiCharLorebookCount">${bookCount}</span> lorebook${bookCount === 1 ? '' : 's'}`;
        stat.style.display = 'flex';
    }

    section.style.display = 'block';
    if (!book) {
        el.innerHTML = `<em style="color: var(--text-secondary, #888)">${listed.length} lorebook${listed.length === 1 ? '' : 's'} listed, but the creator kept the contents private.</em>`;
        return;
    }
    // Deferred: a large book is a lot of markup and the section is usually collapsed.
    const header = `<div class="janitorai-lorebook-head">${escapeHtml(book.name)} &middot; ${book.entries.length} ${book.entries.length === 1 ? 'entry' : 'entries'}</div>`;
    deferRender(el, () => header + CoreAPI.renderLorebookEntriesHtml(book.entries));
}

function cleanupCharModal() {
    BrowseView.closeAvatarViewer();
    CoreAPI.setBrowseAltGreetings(null);
    for (const id of MODAL_TEXT_IDS) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const lore = document.getElementById('janitoraiCharLorebook');
    if (lore) lore.innerHTML = '';
    setHiddenNotice(null);
    jaPaintedNotes = '';
    const notesEl = document.getElementById('janitoraiCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    jaDetailToken++;
    jaDetailPromise = null;
    // Closing the card STOPS its recovery rather than orphaning it: the run drives the real
    // account, and the server deletes the throwaway chat and persona as it unwinds. Imports
    // included; a successful one releases ownership before it closes this modal.
    cancelRecoverRun();
    cleanupCharModal();
    const modal = document.getElementById('janitoraiCharModal');
    if (modal) modal.classList.add('hidden');
    jaSelectedChar = null;
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(hit) {
    const charId = hit?.character_id || hit?.id;
    if (!charId) return;

    const importBtn = document.getElementById('janitoraiImportBtn');
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let inheritedGalleryId = null;

    try {
        const provider = CoreAPI.getProvider('janitorai');
        if (!provider?.importCharacter) throw new Error('JanitorAI provider not available');

        // The preview's detail fetch also hydrates the lorebook; wait so import reuses it.
        if (jaDetailPromise) {
            try { await jaDetailPromise; } catch { /* ignore */ }
        }

        const detail = hit._detail || null;
        const charName = detail?.chat_name || detail?.name || hit.name || '';
        const charCreator = detail?.creator_name || hit.creator_name || '';

        const duplicateMatches = await checkCharacterForDuplicatesAsync({
            name: charName,
            creator: charCreator,
            fullPath: String(charId),
            description: detail?.personality || '',
            first_mes: detail?.first_message || '',
            scenario: detail?.scenario || '',
        });

        if (duplicateMatches && duplicateMatches.length > 0) {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';

            const result = await showPreImportDuplicateWarning({
                name: charName,
                creator: charCreator,
                fullPath: String(charId),
                avatarUrl: resolveJanitoraiAvatarUrl(detail || hit) || '/img/ai4.png',
            }, duplicateMatches);

            if (result.choice === 'skip') {
                showToast('Import cancelled', 'info');
                if (importBtn) {
                    importBtn.disabled = false;
                    importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
                }
                return;
            }
            if (result.choice === 'replace') {
                const toReplace = duplicateMatches[0].char;
                inheritedGalleryId = getCharacterGalleryId(toReplace);
                if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                const ok = await deleteCharacter(toReplace, false);
                if (!ok) console.warn('[JanitoraiBrowse] Could not delete existing character, importing anyway');
            }
        }

        // Import will recover via the model here (a couple of minutes), so step the label through
        // the phases rather than a bare "Importing".
        const willRecover = !hit._recoveredNoProxy && isLockedNoProxy(detail, hit);
        const setBtn = (html) => { if (importBtn) importBtn.innerHTML = html; };
        setBtn(willRecover
            ? `<i class="fa-solid fa-spinner fa-spin"></i> ${recoverPhaseLabel('setup')}`
            : '<i class="fa-solid fa-spinner fa-spin"></i> Importing...');
        if (willRecover) setRecoverProgress(recoverProgressText('setup'));
        // Owns the banner so a stale run cannot paint over this one, and carries the signal that
        // lets closing the card reach the server.
        const run = willRecover ? startRecoverRun(charId, 'import') : null;

        const result = await provider.importCharacter(String(charId), { _detail: detail }, {
            onProgress: willRecover
                ? (label, extra) => {
                    if (run && !isRecoverRunLive(run)) return;
                    setBtn(`<i class="fa-solid fa-spinner fa-spin"></i> ${label}`);
                    if (extra?.phase) setRecoverProgress(recoverProgressText(extra.phase, extra.detail));
                }
                : undefined,
            signal: run?.controller?.signal,
            inheritedGalleryId,
            // Already extracted in the preview: reuse it rather than paying for a second run.
            definition: hit._recoveredDefinition || '',
            firstMessage: hit._recoveredFirstMessage || '',
            // Model output from the no-proxy path; the builder stamps it so the card says so.
            recovered: hit._recoveredNoProxy || null,
        });
        if (run) endRecoverRun(run);
        clearRecoverProgress();
        if (!result.success) throw new Error(result.error || 'Import failed');

        const mediaUrls = result.embeddedMediaUrls || [];
        const galleryPageUrls = result.galleryPageUrls || [];
        const showSummary = (mediaUrls.length > 0 || galleryPageUrls.length > 0)
            && getSetting('importMediaAction') !== 'none';

        await finishBrowseImport({
            view,
            summaryArgs: {
                mediaCharacters: [{
                    characterName: result.characterName,
                    name: result.characterName,
                    fileName: result.fileName,
                    avatar: result.fileName,
                    galleryId: result.galleryId,
                    mediaUrls,
                    galleryPageUrls,
                    cardData: result.cardData,
                }],
            },
            showSummary,
            closePreview: closePreviewModal,
            importBtn,
            characterName: result.characterName,
            avatarFileName: result.fileName,
            markImported: () => markCardAsImported(charId),
        });
    } catch (err) {
        clearRecoverProgress();
        console.error('[JanitoraiBrowse] Import failed:', err);
        showToast(`Import failed: ${err.message}`, 'error');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        }
    }
}

function markCardAsImported(charId) {
    // Mark in both grids: a character can render in Browse and Following at once.
    for (const gridId of ['janitoraiGrid', 'janitoraiFollowingGrid']) {
        const grid = document.getElementById(gridId);
        if (!grid) continue;
        const card = grid.querySelector(`[data-janitorai-id="${CSS.escape(String(charId))}"]`);
        if (!card) continue;

        card.classList.add('in-library');
        card.classList.remove('possible-library');
        let badgesEl = card.querySelector('.browse-feature-badges');
        if (!badgesEl) {
            const imgWrap = card.querySelector('.browse-card-image');
            if (imgWrap) {
                imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
                badgesEl = imgWrap.querySelector('.browse-feature-badges');
            }
        }
        if (badgesEl) {
            badgesEl.querySelector('.possible-library')?.remove();
            if (!badgesEl.querySelector('.in-library')) {
                badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
            }
        }
    }
}

// ========================================
// TAGS
// ========================================

async function ensureTagCatalogue() {
    if (jaTagCatalogue.length) return jaTagCatalogue;
    const cat = await fetchJanitoraiTags();
    jaTagCatalogue = [...cat].sort((a, b) => a.name.localeCompare(b.name));
    return jaTagCatalogue;
}

function renderTagsList(filter = '') {
    const container = document.getElementById('janitoraiTagsList');
    if (!container) return;

    if (!jaTagCatalogue.length) {
        container.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
        return;
    }

    const needle = filter.toLowerCase();
    const filtered = needle
        ? jaTagCatalogue.filter(t => t.name.toLowerCase().includes(needle) || t.slug.toLowerCase().includes(needle))
        : jaTagCatalogue;

    if (!filtered.length) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(tag => {
        const included = jaIncludeTags.has(tag.id);
        const excluded = jaExcludeTags.has(tag.id);
        const stateClass = included ? 'state-include' : excluded ? 'state-exclude' : 'state-neutral';
        const stateIcon = included ? '<i class="fa-solid fa-plus"></i>' : excluded ? '<i class="fa-solid fa-minus"></i>' : '';
        const stateTitle = included ? 'Included (click to exclude)' : excluded ? 'Excluded (click to clear)' : 'Click to include';
        return `
            <div class="browse-tag-filter-item" data-tag-id="${tag.id}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(tag.name)}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagId = Number(item.dataset.tagId);
        item.addEventListener('click', () => {
            // neutral -> include -> exclude -> neutral
            if (jaIncludeTags.has(tagId)) {
                jaIncludeTags.delete(tagId);
                jaExcludeTags.add(tagId);
            } else if (jaExcludeTags.has(tagId)) {
                jaExcludeTags.delete(tagId);
            } else {
                jaIncludeTags.add(tagId);
            }
            renderTagsList(document.getElementById('janitoraiTagsSearchInput')?.value || '');
            updateTagsButton();
            loadCharacters(false);
        });
    });
}

function updateTagsButton() {
    const btn = document.getElementById('janitoraiTagsBtn');
    const label = document.getElementById('janitoraiTagsBtnLabel');
    if (!btn) return;
    const count = jaIncludeTags.size + jaExcludeTags.size;
    btn.classList.toggle('has-filters', count > 0);
    if (label) label.innerHTML = count > 0 ? `Tags <span class="tag-count">(${count})</span>` : 'Tags';
}

function updateFiltersButton() {
    const btn = document.getElementById('janitoraiFiltersBtn');
    if (!btn) return;
    const count = [jaFilterHideOwned, jaFilterHidePossible, jaFilterHideNoProxy].filter(Boolean).length;
    btn.classList.toggle('has-filters', count > 0);
    const span = btn.querySelector('span');
    if (span) span.textContent = count > 0 ? `Features (${count})` : 'Features';
}

function updateNsfwToggle() {
    const btn = document.getElementById('janitoraiNsfwToggle');
    if (!btn) return;
    if (jaNsfwEnabled) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled - click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only - click to include NSFW';
    }
}

// ========================================
// MODE / CREATOR FILTER
// ========================================

// Per-mode result cache; stash/restore keeps the live vars pointing at the active mode.
const jaModeCache = { browse: null, following: null };

// A cache entry taken under a different query signature is stale and discarded on restore.
function jaQuerySignature() {
    return JSON.stringify([jaSortMode, jaNsfwEnabled, jaCurrentSearch, jaCreatorFilter?.id || null, [...jaIncludeTags].sort(), [...jaExcludeTags].sort()]);
}

function stashModeState(mode) {
    jaModeCache[mode] = {
        sig: jaQuerySignature(),
        chars: jaCharacters,
        page: jaCurrentPage,
        totalPages: jaTotalPages,
        hasMore: jaHasMore,
        rendered: jaGridRenderedCount,
    };
}

// true when usable cached results were restored.
function restoreModeState(mode) {
    const s = jaModeCache[mode]?.sig === jaQuerySignature() ? jaModeCache[mode] : null;
    jaCharacters = s?.chars || [];
    jaCurrentPage = s?.page || 1;
    jaTotalPages = s?.totalPages || 0;
    jaHasMore = s ? s.hasMore : true;
    jaGridRenderedCount = s?.rendered || 0;
    return !!s?.chars?.length;
}

function setMode(mode) {
    if (jaMode === mode) return;
    stashModeState(jaMode);
    jaMode = mode;

    // Wipe per-mode inputs BEFORE the restore, so the cache signature is compared against the
    // state the restored grid would actually paginate under. The search box is hidden in
    // Following, so the term never carries over.
    clearCreatorFilter(false);
    jaCurrentSearch = '';
    const searchInput = document.getElementById('janitoraiSearchInput');
    if (searchInput) searchInput.value = '';
    document.getElementById('janitoraiClearSearchBtn')?.classList.add('hidden');

    const restored = restoreModeState(mode);
    syncModeChrome();

    // Only refetch an empty mode; reloading a populated one discards fetched pages.
    const grid = document.getElementById(activeGridId());
    if (!restored) {
        loadCharacters(false);
    } else if (!grid?.querySelector('.browse-card')) {
        jaGridRenderedCount = 0;
        renderGrid(jaCharacters, false);
    } else {
        updateLoadMore();
    }
}

// Single writer for all mode-dependent chrome, derived from jaMode.
function syncModeChrome() {
    document.querySelectorAll('.chub-view-btn[data-janitorai-view]').forEach(b => {
        b.classList.toggle('active', b.dataset.janitoraiView === jaMode);
    });
    document.getElementById('janitoraiBrowseSection')?.classList.toggle('hidden', jaMode !== 'browse');
    document.getElementById('janitoraiFollowingSection')?.classList.toggle('hidden', jaMode !== 'following');

    // The following feed takes no sort or tag params, so hide both controls.
    const following = jaMode === 'following';
    const sortEl = document.getElementById('janitoraiSortSelect');
    const sortBox = sortEl?._customSelect?.container || sortEl?.closest('.browse-sort-container') || sortEl;
    sortBox?.classList.toggle('browse-filter-hidden', following);
    document.getElementById('janitoraiTagsBtn')?.closest('.browse-tags-dropdown-container')
        ?.classList.toggle('browse-filter-hidden', following);
    if (following) document.getElementById('janitoraiTagsDropdown')?.classList.add('hidden');
}

function activeGridId() {
    return jaMode === 'following' ? 'janitoraiFollowingGrid' : 'janitoraiGrid';
}

function activeLoadMoreId() {
    return jaMode === 'following' ? 'janitoraiFollowingLoadMore' : 'janitoraiLoadMore';
}

function syncCreatorFollowBtn() {
    const btn = document.getElementById('janitoraiFollowCreatorBtn');
    if (!btn) return;
    // Hide when signed out rather than offer a follow button that can only fail.
    const signedIn = !!janitoraiSessionStatus()?.loggedIn;
    btn.style.display = (jaCreatorFilter && signedIn) ? '' : 'none';
    btn.disabled = false;
    btn.classList.toggle('following', jaFollowingCurrentCreator);
    btn.innerHTML = jaFollowingCurrentCreator
        ? '<i class="fa-solid fa-heart"></i> <span>Following</span>'
        : '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
    btn.title = jaFollowingCurrentCreator ? 'Unfollow this creator on JanitorAI' : 'Follow this creator on JanitorAI';
}

function syncBannerFollowState(creatorId, following) {
    if (!jaCreatorFilter || jaCreatorFilter.id !== creatorId) return;
    jaFollowingCurrentCreator = following;
    syncCreatorFollowBtn();
}

async function refreshCreatorFollowState() {
    jaFollowingCurrentCreator = false;
    syncCreatorFollowBtn();
    if (!jaCreatorFilter?.id || !janitoraiSessionStatus()?.loggedIn) return;

    const opened = jaCreatorFilter.id;
    if (!jaFollowedLoaded) {
        try { await loadFollowedCreators(); } catch { return; }
    }
    // The user can leave or switch creators while the list is in flight.
    if (jaCreatorFilter?.id !== opened) return;
    jaFollowingCurrentCreator = jaFollowed.some(c => c.id === opened);
    syncCreatorFollowBtn();
}

async function toggleCreatorFollow() {
    if (!jaCreatorFilter?.id) return;
    const btn = document.getElementById('janitoraiFollowCreatorBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
    const next = !jaFollowingCurrentCreator;
    try {
        await setJanitoraiFollow(jaCreatorFilter.id, next);
        jaFollowingCurrentCreator = next;
        jaFollowedLoaded = false;   // the manager list is now stale
        showToast(next ? `Now following ${jaCreatorFilter.name}` : `Unfollowed ${jaCreatorFilter.name}`, next ? 'success' : 'info');
    } catch (e) {
        const code = e?.code;
        if (code === 'HAMPTER_TOKEN_EXPIRED') {
            showToast('Your JanitorAI session expired. Re-paste your token in Settings to follow creators.', 'warning', 7000);
        } else if (code === 'HAMPTER_LOGIN_REQUIRED') {
            showToast('Add your JanitorAI session in Settings to follow creators.', 'warning', 7000);
        } else if (code === 'HAMPTER_BLOCKED' && !hasBrowserEndpoint()) {
            // Without a browser the write hits the Cloudflare-blocked direct leg; name the fix.
            showToast('Following needs the browser under Settings > Online > JanitorAI. Start it there, or follow on janitorai.com.', 'warning', 9000);
        } else {
            showToast(`Could not update follow: ${e.message}`, 'error', 7000);
        }
    } finally {
        syncCreatorFollowBtn();
    }
}

/**
 * Filter the browse view by a tag name clicked directly on a card/preview, mirroring
 * filterByCreator's click-to-filter pattern. Only works for official (catalogued) tags, which
 * carry a stable numeric id the search API accepts - community "#"-prefixed tags have no id and
 * can't be filtered server-side (see fetchJanitoraiTags/resolveJanitoraiTagIds).
 * @param {string} tagName
 */
async function filterByTagName(tagName) {
    await ensureTagCatalogue();
    const tag = jaTagCatalogue.find(t => t.name === tagName);
    if (!tag) {
        showToast(`"${tagName}" is a community tag and can't be filtered directly - JanitorAI doesn't expose a search-by-text API for it.`, 'info', 6000);
        return;
    }
    jaIncludeTags.add(tag.id);
    renderTagsList(document.getElementById('janitoraiTagsSearchInput')?.value || '');
    updateTagsButton();
    loadCharacters(false);
}

function filterByCreator(creatorId, creatorName) {
    if (!creatorId) {
        showToast('That card did not carry a creator id', 'warning');
        return;
    }
    jaCreatorFilter = { id: creatorId, name: creatorName || 'Creator' };
    view._cdRef = { name: creatorName || '', creatorId };
    jaCurrentSearch = '';
    jaMode = 'browse';
    syncModeChrome();

    const searchInput = document.getElementById('janitoraiSearchInput');
    if (searchInput) searchInput.value = '';
    document.getElementById('janitoraiClearSearchBtn')?.classList.add('hidden');

    // Entering a creator resets sort to newest instead of inheriting the global sort.
    jaSortMode = 'latest';
    const creatorSort = document.getElementById('janitoraiCreatorSortSelect');
    if (creatorSort) { creatorSort.value = 'latest'; creatorSort._customSelect?.update?.(); }

    const banner = document.getElementById('janitoraiCreatorBanner');
    const bannerName = document.getElementById('janitoraiCreatorBannerName');
    if (banner && bannerName) {
        bannerName.textContent = creatorName || 'Creator';
        banner.classList.remove('hidden');
        refreshCreatorFollowState();
        window.pushOverlayGuard?.();
    }

    loadCharacters(false);
}

// Resolve a creator uuid from a URL/uuid (no network) or a name via /profiles/search; toasts on miss, returns null.
async function resolveCreatorInput(raw) {
    const query = (raw || '').trim();
    if (!query) return null;

    const uuidMatch = query.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) {
        const id = uuidMatch[0];
        const known = jaCharacters.find(c => c.creator_id === id) || jaFollowed.find(c => c.id === id);
        return { id, name: known?.creator_name || known?.name || 'Creator' };
    }

    let results;
    try {
        results = await searchJanitoraiCreators(query);
    } catch (e) {
        const msg = e?.code === 'HAMPTER_LOGIN_REQUIRED' ? 'Sign in to JanitorAI to search creators.'
            : e?.code === 'HAMPTER_RATE_LIMITED' ? 'JanitorAI is rate limiting; try the search again in a moment.'
            : (e?.message || 'Creator search failed.');
        showToast(msg, 'error', 8000);
        return null;
    }
    if (!results.length) {
        showToast(`No JanitorAI creator found matching "${query}".`, 'warning', 6000);
        return null;
    }
    const lower = query.toLowerCase();
    const pick = results.find(r => (r.name || '').toLowerCase() === lower) || results[0];
    return { id: pick.id, name: pick.name || 'Creator' };
}

async function doCreatorSearch() {
    const input = document.getElementById('janitoraiCreatorSearchInput');
    const raw = (input?.value || '').trim();
    if (!raw) return;

    const resolved = await resolveCreatorInput(raw);
    if (!resolved) return;
    if (input) input.value = '';
    filterByCreator(resolved.id, resolved.name);
}

function clearCreatorFilter(reload = true) {
    jaCreatorFilter = null;
    jaFollowingCurrentCreator = false;
    document.getElementById('janitoraiCreatorBanner')?.classList.add('hidden');
    syncCreatorFollowBtn();
    if (reload && _returnToFollowing) {
        _returnToFollowing = false;
        // Drop creator-scoped results so setMode does not stash them as the Browse cache.
        jaCharacters = [];
        jaModeCache.browse = null;
        setMode('following');
        return;
    }
    _returnToFollowing = false;
    // Resync jaSortMode to the main sort select, which creator entry left untouched.
    const mainSort = document.getElementById('janitoraiSortSelect');
    if (mainSort && HAMPTER_SORTS.includes(mainSort.value)) jaSortMode = mainSort.value;
    if (reload) {
        jaCharacters = [];
        loadCharacters(false);
    }
}

function doSearch() {
    const input = document.getElementById('janitoraiSearchInput');
    const clearBtn = document.getElementById('janitoraiClearSearchBtn');
    const val = (input?.value || '').trim();

    // A typed keyword no longer drops an active creator filter - loadCharacters() already
    // sends `search` and `creatorIds` (user_id[]) as independent, combinable request params,
    // so there was never a server-side reason to reset one when the other changes.
    jaCurrentSearch = val;
    if (clearBtn) clearBtn.classList.toggle('hidden', !val);

    // The ranked sorts score over a recency window, so pairing one with a query narrows the
    // results to whatever matches AND happens to be ranking right now. A query always wants
    // relevance; the sort select stays live, so a deliberate ordering is still one click away.
    const sortSelect = document.getElementById('janitoraiSortSelect');
    if (val && sortSelect && jaSortMode !== 'relevance') {
        jaSortMode = 'relevance';
        sortSelect.value = 'relevance';
        sortSelect._customSelect?.update?.();
    }

    loadCharacters(false);
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;

function initView() {
    jaNsfwEnabled = getSetting('janitoraiNsfw') === true;

    // Seed checkboxes from state every init: the flags survive a provider switch but the markup is rebuilt.
    for (const [id, value] of [
        ['janitoraiFilterHideOwned', jaFilterHideOwned],
        ['janitoraiFilterHidePossible', jaFilterHidePossible],
        ['janitoraiFilterHideNoProxy', jaFilterHideNoProxy],
    ]) {
        const el = document.getElementById(id);
        if (el) el.checked = value;
    }
    updateFiltersButton();
    // Tag filters survive a provider switch the same way; reseed their button too
    updateTagsButton();

    if (delegatesInitialized) return;
    delegatesInitialized = true;

    const sortEl = document.getElementById('janitoraiSortSelect');
    if (sortEl) CoreAPI.initCustomSelect?.(sortEl);
    const creatorSortEl = document.getElementById('janitoraiCreatorSortSelect');
    if (creatorSortEl) CoreAPI.initCustomSelect?.(creatorSortEl);

    // Both grids get the delegate; Following renders into its own grid.
    for (const gridId of ['janitoraiGrid', 'janitoraiFollowingGrid']) {
        const grid = document.getElementById(gridId);
        if (!grid) continue;
        grid.addEventListener('click', (e) => {
            const creatorLink = e.target.closest('.browse-card-creator-link');
            if (creatorLink) {
                e.stopPropagation();
                filterByCreator(creatorLink.dataset.creatorId, creatorLink.dataset.creatorName);
                return;
            }
            const tagChip = e.target.closest('.browse-card-tag');
            if (tagChip) {
                e.stopPropagation();
                filterByTagName(tagChip.textContent);
                return;
            }
            const card = e.target.closest('.browse-card');
            if (!card) return;
            const charId = card.dataset.janitoraiId;
            if (!charId) return;
            const hit = jaCharacters.find(c => String(c.character_id) === charId);
            if (hit) openPreviewModal(hit);
        });
    }

    on('janitoraiSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
    });
    on('janitoraiSearchInput', 'input', (e) => {
        document.getElementById('janitoraiClearSearchBtn')?.classList.toggle('hidden', !e.target.value.trim());
    });
    on('janitoraiSearchBtn', 'click', () => doSearch());
    on('janitoraiClearSearchBtn', 'click', () => {
        const input = document.getElementById('janitoraiSearchInput');
        if (input) input.value = '';
        document.getElementById('janitoraiClearSearchBtn')?.classList.add('hidden');
        jaCurrentSearch = '';
        clearCreatorFilter(false);
        loadCharacters(false);
    });

    on('janitoraiLoadMoreBtn', 'click', () => {
        jaCurrentPage++;
        loadCharacters(true);
    });

    on('janitoraiFollowingLoadMoreBtn', 'click', () => {
        jaCurrentPage++;
        loadCharacters(true);
    });

    on('janitoraiNsfwToggle', 'click', () => {
        jaNsfwEnabled = !jaNsfwEnabled;
        setSetting('janitoraiNsfw', jaNsfwEnabled);
        updateNsfwToggle();
        loadCharacters(false);
    });
    updateNsfwToggle();

    on('janitoraiSortSelect', 'change', () => {
        const el = document.getElementById('janitoraiSortSelect');
        if (el && HAMPTER_SORTS.includes(el.value)) jaSortMode = el.value;
        const input = document.getElementById('janitoraiSearchInput');
        if (input) jaCurrentSearch = input.value.trim();
        loadCharacters(false);
    });

    on('janitoraiCreatorSearchBtn', 'click', doCreatorSearch);
    on('janitoraiCreatorSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doCreatorSearch(); }
    });

    // sort and user_id[] ride one request; guard against HAMPTER_SORTS (unknown = 400).
    on('janitoraiCreatorSortSelect', 'change', () => {
        const el = document.getElementById('janitoraiCreatorSortSelect');
        if (!el || !HAMPTER_SORTS.includes(el.value)) return;
        jaSortMode = el.value;
        jaCharacters = [];
        jaGridRenderedCount = 0;
        jaCurrentPage = 1;
        jaHasMore = true;
        loadCharacters(false);
    });

    on('janitoraiRefreshBtn', 'click', () => {
        jaFollowedLoaded = false;
        loadCharacters(false);
    });

    on('janitoraiFollowCreatorBtn', 'click', toggleCreatorFollow);
    on('janitoraiClearCreatorBtn', 'click', () => clearCreatorFilter());

    document.querySelectorAll('.chub-view-btn[data-janitorai-view]').forEach(btn => {
        btn.addEventListener('click', () => setMode(btn.dataset.janitoraiView));
    });

    // ── Tags dropdown ──
    const tagsDropdown = document.getElementById('janitoraiTagsDropdown');
    const filtersDropdown = document.getElementById('janitoraiFiltersDropdown');

    on('janitoraiTagsBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        filtersDropdown?.classList.add('hidden');
        tagsDropdown?.classList.toggle('hidden');
        // Key the first-open fill off the DOM, not the catalogue: the list dies with the
        // container on provider switches while the fetched catalogue survives.
        const list = document.getElementById('janitoraiTagsList');
        if (list && !list.querySelector('.browse-tag-filter-item')) {
            ensureTagCatalogue()
                .then(() => renderTagsList(document.getElementById('janitoraiTagsSearchInput')?.value || ''))
                .catch(() => { /* list keeps its loading message */ });
        }
    });
    tagsDropdown?.addEventListener('click', (e) => e.stopPropagation());

    const tagSearchInput = document.getElementById('janitoraiTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }

    on('janitoraiTagsClearBtn', 'click', () => {
        jaIncludeTags.clear();
        jaExcludeTags.clear();
        renderTagsList(document.getElementById('janitoraiTagsSearchInput')?.value || '');
        updateTagsButton();
        loadCharacters(false);
    });

    // ── Features dropdown ──
    on('janitoraiFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        tagsDropdown?.classList.add('hidden');
        filtersDropdown?.classList.toggle('hidden');
    });
    filtersDropdown?.addEventListener('click', (e) => e.stopPropagation());

    on('janitoraiFilterHideOwned', 'change', (e) => {
        jaFilterHideOwned = e.target.checked;
        updateFiltersButton();
        loadCharacters(false);
    });
    on('janitoraiFilterHidePossible', 'change', (e) => {
        jaFilterHidePossible = e.target.checked;
        updateFiltersButton();
        loadCharacters(false);
    });
    on('janitoraiFilterHideNoProxy', 'change', (e) => {
        jaFilterHideNoProxy = e.target.checked;
        updateFiltersButton();
        loadCharacters(false);
    });

    view._registerDropdownDismiss([
        { dropdownId: 'janitoraiTagsDropdown', buttonId: 'janitoraiTagsBtn' },
        { dropdownId: 'janitoraiFiltersDropdown', buttonId: 'janitoraiFiltersBtn' },
    ]);

    // ── Preview modal ──
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        const overlay = document.getElementById('janitoraiCharModal');
        BrowseView.wireTitleScroll(document.getElementById('janitoraiCharName'), overlay, overlay?.querySelector('.browse-char-modal'));

        on('janitoraiCharClose', 'click', () => closePreviewModal());

        const creatorLink = document.getElementById('janitoraiCharCreator');
        if (creatorLink) {
            creatorLink.addEventListener('click', (e) => {
                e.preventDefault();
                const id = creatorLink.dataset.creatorId;
                const name = creatorLink.textContent.trim();
                if (id) {
                    closePreviewModal();
                    filterByCreator(id, name);
                }
            });
        }

        const charTagsEl = document.getElementById('janitoraiCharTags');
        if (charTagsEl) {
            charTagsEl.addEventListener('click', (e) => {
                const tagChip = e.target.closest('.browse-tag');
                if (!tagChip) return;
                closePreviewModal();
                filterByTagName(tagChip.textContent);
            });
        }

        // Decide desktop at event time; on mobile bail before stopPropagation so the tap delegate runs.
        const avatar = document.getElementById('janitoraiCharAvatar');
        if (avatar) {
            avatar.addEventListener('click', (e) => {
                if (isMobileMode()) return;
                e.stopPropagation();
                if (!avatar.src || avatar.src.endsWith('/img/ai4.png')) return;
                BrowseView.openAvatarViewer(avatar.src);
            });
        }

        on('janitoraiImportBtn', 'click', () => {
            if (jaSelectedChar) importCharacter(jaSelectedChar);
        });

        // The notice buttons are rebuilt each preview open, so delegate off the container.
        document.getElementById('janitoraiHiddenNotice')?.addEventListener('click', (e) => {
            if (e.target.closest('[data-notice-action="recover"]')) recoverDefinitionIntoPreview();
            if (e.target.closest('[data-notice-action="tryanyway"]')) recoverLockedIntoPreview();
        });

        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closePreviewModal();
            });
        }

        window.registerOverlay?.({ id: 'janitoraiCharModal', tier: 7, close: () => closePreviewModal() });
        window.registerOverlay?.({ id: 'janitoraiCreatorBanner', tier: 9, close: () => clearCreatorFilter() });
    }
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class JanitoraiBrowseView extends BrowseView {
    constructor(provider) {
        super(provider);
        view = this;
    }

    _extractProviderIds(char, idSet) {
        const ext = char.data?.extensions?.janitorai;
        if (ext?.id) idSet.add(String(ext.id));
    }

    get previewModalId() { return 'janitoraiCharModal'; }

    get hasModeToggle() { return true; }

    closePreview() {
        closePreviewModal();
    }

    get mobileFilterIds() {
        return {
            sort: 'janitoraiSortSelect',
            // No timelineSort: the following feed takes no sort, so the sheet hides Sort By there.
            tags: 'janitoraiTagsBtn',
            filters: 'janitoraiFiltersBtn',
            nsfw: 'janitoraiNsfwToggle',
            refresh: 'janitoraiRefreshBtn',
            modeBrowseSelector: '.chub-view-btn[data-janitorai-view="browse"]',
            modeFollowSelector: '.chub-view-btn[data-janitorai-view="following"]',
            modeBtnClass: 'chub-view-btn',
        };
    }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'popular', label: 'Popular' },
                { value: 'trending', label: 'Trending' },
                { value: 'trending24', label: 'Trending (24h)' },
                { value: 'latest', label: 'Latest' },
                { value: 'relevance', label: 'Relevance' },
            ],
            // Empty: the following feed accepts no sort.
            followingSortOptions: [],
            // Populated so the "Default view" select appears; library.js gates it on viewModes.length.
            viewModes: [
                { value: 'browse', label: 'Browse' },
                { value: 'following', label: 'Following' },
            ],
        };
    }

    // ── Following Manager ───────────────────────────────────

    get supportsFollowingManager() { return true; }

    async getFollowedCreators() {
        const list = await fetchJanitoraiFollowing();
        jaFollowed = list;
        jaFollowedLoaded = true;
        return list.map(c => ({
            id: c.id,
            name: c.name || c.id,
            username: c.name || '',
            // Use the resolver, not string concat: it handles absolute urls, the safety check, and sizing.
            avatar: resolveJanitoraiAvatarUrl(c, { width: 96 }) || '',
        }));
    }

    // Follow by name, URL, or uuid via the shared creator resolver (toasts on miss itself).
    async followCreator(query) {
        const resolved = await resolveCreatorInput(query);
        if (!resolved) return null;
        await setJanitoraiFollow(resolved.id, true);
        jaFollowedLoaded = false;
        syncBannerFollowState(resolved.id, true);
        return { id: resolved.id, name: resolved.name };
    }

    async unfollowCreator(id) {
        if (!id) return false;
        await setJanitoraiFollow(id, false);
        jaFollowedLoaded = false;
        syncBannerFollowState(id, false);
        return true;
    }

    browseCreatorFromManager(creator) {
        // No toggleFollowingManager(): filterByCreator hides the header with its only close button.
        _returnToFollowing = true;
        filterByCreator(creator.id, creator.name);
    }

    getFollowingManagerSortOptions() {
        // Values must match the base's vocabulary; _sortCreators silently disables sorting on unknowns.
        return [
            { value: 'name_asc', label: 'Name A-Z' },
            { value: 'name_desc', label: 'Name Z-A' },
        ];
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        const sortOpt = (value, label) =>
            `<option value="${value}" ${jaSortMode === value ? 'selected' : ''}>${label}</option>`;
        return `
            <!-- Mode toggle sits in the filter bar, outside both sections, so switching mode cannot hide it. -->
            <div class="chub-view-toggle">
                <button class="chub-view-btn active" data-janitorai-view="browse" title="Browse all characters">
                    <i class="fa-solid fa-compass"></i> <span>Browse</span>
                </button>
                <button class="chub-view-btn" data-janitorai-view="following" title="New from creators you follow (requires login)">
                    <i class="fa-solid fa-users"></i> <span>Following</span>
                </button>
            </div>

            <div class="browse-sort-container">
                <select id="janitoraiSortSelect" class="glass-select" title="Sort order">
                    <optgroup label="Popularity">
                        ${sortOpt('popular', '👑 Popular')}
                        ${sortOpt('trending', '🔥 Trending')}
                        ${sortOpt('trending24', '🔥 Trending (24h)')}
                    </optgroup>
                    <optgroup label="Date">
                        ${sortOpt('latest', '🆕 Latest')}
                    </optgroup>
                    <optgroup label="Search">
                        ${sortOpt('relevance', '🔍 Relevance')}
                    </optgroup>
                </select>
            </div>

            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="janitoraiTagsBtn" class="glass-btn" title="Tag filters">
                    <i class="fa-solid fa-tags"></i> <span id="janitoraiTagsBtnLabel">Tags</span>
                </button>
                <div id="janitoraiTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="janitoraiTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="janitoraiTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="janitoraiTagsList"></div>
                </div>
            </div>

            <div class="browse-more-filters" style="position: relative;">
                <button id="janitoraiFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="janitoraiFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 260px;">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="janitoraiFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="janitoraiFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                    <div class="dropdown-section-title">Definitions:</div>
                    <label class="filter-checkbox" title="Creators who turn off proxy access make a locked definition unrecoverable by the normal extraction."><input type="checkbox" id="janitoraiFilterHideNoProxy"> <i class="fa-solid fa-lock"></i> Hide No-Proxy Characters</label>
                </div>
            </div>

            <button id="janitoraiNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <button id="janitoraiRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="janitoraiBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="janitoraiSearchInput" placeholder="Search JanitorAI characters..." autocomplete="one-time-code">
                        <button id="janitoraiClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="janitoraiSearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user-pen"></i>
                            <input type="search" id="janitoraiCreatorSearchInput" placeholder="Creator name or profile URL..." autocomplete="one-time-code">
                            <button id="janitoraiCreatorSearchBtn" class="browse-search-submit" title="Browse a creator's characters">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <div id="janitoraiCreatorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-user-pen"></i>
                        <span>Characters by <strong id="janitoraiCreatorBannerName">Creator</strong></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <select id="janitoraiCreatorSortSelect" class="glass-select" title="Sort this creator's characters">
                            <option value="latest">Newest</option>
                            <option value="popular">Popular</option>
                            <option value="trending">Trending</option>
                            <option value="trending24">Trending (24h)</option>
                        </select>
                        <button id="janitoraiFollowCreatorBtn" class="glass-btn browse-author-follow-btn" title="Follow this creator on JanitorAI" style="display: none;">
                            <i class="fa-solid fa-heart"></i> <span>Follow</span>
                        </button>
                        <button id="janitoraiClearCreatorBtn" class="glass-btn icon-only" title="Clear creator filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <div id="janitoraiGrid" class="browse-grid"></div>

                <div class="browse-load-more" id="janitoraiLoadMore" style="display: none;">
                    <button id="janitoraiLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <div id="janitoraiFollowingSection" class="browse-section hidden">
                <div class="chub-timeline-header">
                    <div class="chub-timeline-header-left">
                        <h3><i class="fa-solid fa-user-group"></i> Following</h3>
                        <p>Characters from creators you follow</p>
                    </div>
                    <div class="chub-timeline-header-right">
                        <button class="follow-mgr-toggle-btn glass-btn" id="janitoraiFollowMgrToggle" title="Manage followed creators">
                            <i class="fa-solid fa-users-gear"></i> Manage
                        </button>
                    </div>
                </div>
                ${this.renderFollowingManagerPanel()}

                <div id="janitoraiFollowingGrid" class="browse-grid"></div>

                <div class="browse-load-more" id="janitoraiFollowingLoadMore" style="display: none;">
                    <button id="janitoraiFollowingLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // ── Modals ──────────────────────────────────────────────

    renderModals() {
        return `
    <div id="janitoraiCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="janitoraiCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="janitoraiCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="janitoraiCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to see all characters by this creator">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="janitoraiOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on JanitorAI">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="janitoraiImportBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="janitoraiCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-comments"></i>
                            <span id="janitoraiCharChats">0</span> chats
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-envelope"></i>
                            <span id="janitoraiCharMessages">0</span> messages
                        </div>
                        <div class="browse-stat" id="janitoraiCharTokensStat" style="display: none;">
                            <i class="fa-solid fa-font"></i>
                            <span id="janitoraiCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat" id="janitoraiCharGreetingsStat" style="display: none;">
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="janitoraiCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat" id="janitoraiCharLorebookStat" style="display: none;">
                            <i class="fa-solid fa-book"></i>
                            <span id="janitoraiCharLorebookCount">0</span> lorebook
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="janitoraiCharDate">Unknown</span>
                        </div>
                    </div>
                    <div class="browse-char-tags" id="janitoraiCharTags"></div>
                </div>

                <div id="janitoraiHiddenNotice" style="display: none;"></div>

                <div class="browse-char-section" id="janitoraiCharCreatorNotesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="janitoraiCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="janitoraiCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <div class="browse-char-section" id="janitoraiCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="janitoraiCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="janitoraiCharDescription" class="scrolling-text"></div>
                </div>

                <div class="browse-char-section" id="janitoraiCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="janitoraiCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="janitoraiCharScenario" class="scrolling-text"></div>
                </div>

                <div class="browse-char-section browse-section-collapsed" id="janitoraiCharExamplesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="janitoraiCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="janitoraiCharExamples" class="scrolling-text"></div>
                </div>

                <div class="browse-char-section" id="janitoraiCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="janitoraiCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="janitoraiCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <div class="browse-char-section" id="janitoraiCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="janitoraiCharAltGreetingsCount"></span>
                    </h3>
                    <div id="janitoraiCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <div class="browse-char-section" id="janitoraiCharLorebookSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="janitoraiCharLorebook" data-label="Lorebook" data-icon="fa-solid fa-book" title="Click to expand">
                        <i class="fa-solid fa-book"></i> Lorebook
                    </h3>
                    <div id="janitoraiCharLorebook" class="scrolling-text"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    _getImageGridIds() { return ['janitoraiGrid', 'janitoraiFollowingGrid']; }

    canLoadMore() { return jaHasMore && !jaIsLoading; }

    loadMore() {
        jaCurrentPage++;
        loadCharacters(true);
    }

    // 'creator' also gives mobile its Creator tab; the search overlay builds tabs from getSearchModes().
    getSearchModes() { return ['character', 'creator']; }

    getSearchInputId(mode) {
        if (mode === 'character') return 'janitoraiSearchInput';
        if (mode === 'creator') return 'janitoraiCreatorSearchInput';
        return null;
    }

    getSearchPlaceholder(mode) {
        return mode === 'creator' ? 'Creator name or profile URL...' : 'Search JanitorAI characters...';
    }

    applyDefaults(defaults) {
        // Sets jaMode rather than calling setMode, which would fire a second initial request.
        if (defaults.view === 'browse' || defaults.view === 'following') {
            jaMode = defaults.view;
        }
        syncModeChrome();
        if (defaults.sort && HAMPTER_SORTS.includes(defaults.sort)) {
            jaSortMode = defaults.sort;
            const el = document.getElementById('janitoraiSortSelect');
            if (el) { el.value = defaults.sort; el._customSelect?.update?.(); }
        }
        if (defaults.hideOwned) {
            jaFilterHideOwned = true;
            const el = document.getElementById('janitoraiFilterHideOwned');
            if (el) el.checked = true;
        }
        if (defaults.hidePossible) {
            jaFilterHidePossible = true;
            const el = document.getElementById('janitoraiFilterHidePossible');
            if (el) el.checked = true;
        }
        if (defaults.hideOwned || defaults.hidePossible) updateFiltersButton();
    }

    init() {
        super.init();
        this.buildLocalLibraryLookup();
        initView();
        for (const gridId of this._getImageGridIds()) {
            const g = document.getElementById(gridId);
            if (g) this.observeImages(g);
        }
        // No initial load here: init() runs before applyDefaults(), so activate() issues it.
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            jaCurrentSearch = '';
            jaCreatorFilter = null;
            jaCharacters = [];
            jaCurrentPage = 1;
            jaTotalPages = 0;
            jaHasMore = true;
            jaIsLoading = false;
            jaGridRenderedCount = 0;
            jaMode = 'browse';
            _returnToFollowing = false;
            // The grids are gone with the old DOM, so cached results have nothing to repaint into.
            jaModeCache.browse = null;
            jaModeCache.following = null;
        }
        const wasInitialized = this._initialized;
        super.activate(container, options);

        if (wasInitialized && this._initialized && !options.domRecreated) {
            delegatesInitialized = true;
            this.buildLocalLibraryLookup();
            this.reconnectImageObserver();
        }

        // applyDefaults only runs on DOM rebuild, so sync chrome here for plain tab re-entry too.
        syncModeChrome();

        // Test for real cards, not child nodes: an aborted load leaves skeletons.
        const grid = document.getElementById(activeGridId());
        const painted = !!grid?.querySelector('.browse-card');
        if (jaCharacters.length === 0) {
            loadCharacters(false);
        } else if (!painted) {
            jaGridRenderedCount = 0;
            renderGrid(jaCharacters, false);
        }

    }

    // ── Library Lookup (BrowseView contract) ────────────────

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const id = card.dataset.janitoraiId;
            const name = card.querySelector('.browse-card-name')?.textContent || '';
            const creator_name = card.querySelector('.browse-card-creator-link')?.textContent || '';
            return isCharInLocalLibrary({ character_id: id, name, creator_name });
        });
    }

    deactivate() {
        stopQueueWatch();
        jaQueueWatchSince = 0;
        // Bump both tokens so an in-flight listing or detail response is discarded.
        jaDetailToken++;
        jaLoadToken++;
        // Reset or an in-flight load leaves the guard set and the next entry can never page.
        jaIsLoading = false;
        // Actually abort: the token check discards the response but the fetch keeps running.
        if (jaFetchController) {
            try { jaFetchController.abort(); } catch { /* already settled */ }
            jaFetchController = null;
        }
        delegatesInitialized = false;
        super.deactivate();
        this.disconnectImageObserver();
    }
}

const janitoraiBrowseView = new JanitoraiBrowseView(null);

// Called by library.js's viewOnProvider for a linked character's preview.
window.openJanitoraiCharPreview = function (hit) {
    openPreviewModal(hit);
};

export default janitoraiBrowseView;
