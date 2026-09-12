// cr-repo Provider — browse/import characters from user-configured cr-repo bundles.
// See modules/providers/crrepo/crrepo-api.js for the bundle fetch/parse logic and the
// v1-scope rationale (cr-bundle + cr-record + cr-uri-address only).

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { importFromPng, slugify } from '../provider-utils.js';
import { fetchCrRepoBundles, fetchCrRepoCardBytes } from './crrepo-api.js';

let api = null; // CoreAPI reference
const SETTINGS_KEY = 'crrepoBundleUrls';
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function getBundleUrls() {
    const raw = api?.getSetting?.(SETTINGS_KEY);
    return Array.isArray(raw) ? raw : [];
}

function setBundleUrls(urls) {
    api?.setSetting?.(SETTINGS_KEY, urls);
}

function isPng(buffer) {
    const bytes = new Uint8Array(buffer.slice(0, 4));
    return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

class CrRepoProvider extends ProviderBase {
    get id() { return 'crrepo'; }
    get name() { return 'Custom Repos'; }
    get icon() { return 'fa-solid fa-diagram-project'; }
    get beta() { return true; }
    get hasView() { return true; }

    async init(coreAPI) {
        await super.init(coreAPI);
        api = coreAPI;
    }

    renderView() {
        return `
            <div class="crrepo-view">
                <div class="crrepo-add-row">
                    <input type="text" id="crrepoAddUrlInput" class="text_pole" placeholder="cr-repo bundle URL (https://...)">
                    <button id="crrepoAddUrlBtn" class="menu_button"><i class="fa-solid fa-plus"></i> Add</button>
                </div>
                <div id="crrepoBundleList" class="crrepo-bundle-list"></div>
                <div id="crrepoCharGrid" class="crrepo-char-grid"></div>
            </div>
        `;
    }

    async activate(container) {
        const addBtn = container.querySelector('#crrepoAddUrlBtn');
        const addInput = container.querySelector('#crrepoAddUrlInput');
        addBtn?.addEventListener('click', async () => {
            const url = addInput.value.trim();
            if (!url) return;
            const urls = getBundleUrls();
            if (urls.includes(url)) {
                api.showToast?.('That bundle is already added', 'info');
                return;
            }
            setBundleUrls([...urls, url]);
            addInput.value = '';
            await this._refresh(container);
        });
        addInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addBtn?.click();
        });

        await this._refresh(container);
    }

    async _refresh(container) {
        const listEl = container.querySelector('#crrepoBundleList');
        const gridEl = container.querySelector('#crrepoCharGrid');
        const urls = getBundleUrls();

        if (urls.length === 0) {
            listEl.innerHTML = `<div class="crrepo-empty">No custom repositories added yet. Paste a cr-repo bundle URL above.</div>`;
            gridEl.innerHTML = '';
            return;
        }

        listEl.innerHTML = `<div class="crrepo-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading ${urls.length} repositor${urls.length === 1 ? 'y' : 'ies'}...</div>`;
        gridEl.innerHTML = '';

        const bundles = await fetchCrRepoBundles(urls);

        listEl.innerHTML = bundles.map(b => `
            <div class="crrepo-bundle-card" data-url="${CoreAPI.escapeHtml(b.url)}">
                ${b.icon ? `<img class="crrepo-bundle-icon" src="${CoreAPI.escapeHtml(b.icon)}" alt="">` : `<i class="fa-solid fa-book crrepo-bundle-icon-fallback"></i>`}
                <div class="crrepo-bundle-info">
                    <div class="crrepo-bundle-title">${CoreAPI.escapeHtml(b.title)}</div>
                    ${b.description ? `<div class="crrepo-bundle-desc">${CoreAPI.escapeHtml(b.description)}</div>` : ''}
                    ${b.error ? `<div class="crrepo-bundle-error"><i class="fa-solid fa-triangle-exclamation"></i> ${CoreAPI.escapeHtml(b.error)}</div>` : `<div class="crrepo-bundle-count">${b.characters.length} character(s)</div>`}
                </div>
                <i class="fa-solid fa-xmark crrepo-bundle-remove" title="Remove"></i>
            </div>
        `).join('');

        listEl.querySelectorAll('.crrepo-bundle-remove').forEach(el => {
            el.addEventListener('click', async (e) => {
                const url = e.target.closest('.crrepo-bundle-card')?.dataset.url;
                if (!url) return;
                setBundleUrls(getBundleUrls().filter(u => u !== url));
                await this._refresh(container);
            });
        });

        const allChars = bundles.flatMap(b => b.characters);
        if (allChars.length === 0) {
            gridEl.innerHTML = `<div class="crrepo-empty">No character-card records found in the configured repositories.</div>`;
            return;
        }

        gridEl.innerHTML = allChars.map((c, i) => `
            <div class="crrepo-char-card" data-index="${i}">
                <div class="crrepo-char-title">${CoreAPI.escapeHtml(c.title)}</div>
                ${c.description ? `<div class="crrepo-char-desc">${CoreAPI.escapeHtml(c.description)}</div>` : ''}
                <button class="menu_button crrepo-import-btn"><i class="fa-solid fa-download"></i> Import</button>
            </div>
        `).join('');

        gridEl.querySelectorAll('.crrepo-import-btn').forEach((btn, i) => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Importing...`;
                const result = await this.importCharacter(null, allChars[i]);
                if (result.success) {
                    api.showToast?.(`Imported "${result.characterName}"`, 'success');
                    btn.innerHTML = `<i class="fa-solid fa-check"></i> Imported`;
                } else {
                    api.showToast?.(`Import failed: ${result.error}`, 'error');
                    btn.disabled = false;
                    btn.innerHTML = `<i class="fa-solid fa-download"></i> Import`;
                }
            });
        });
    }

    get supportsImport() { return true; }

    /**
     * @param {string|null} _identifier - unused; cr-repo entries are identified by the hit object itself
     * @param {import('./crrepo-api.js').CrRepoCharacterEntry} hitData
     */
    async importCharacter(_identifier, hitData) {
        try {
            if (!hitData?.uri) throw new Error('No source URI for this entry');

            const bytes = await fetchCrRepoCardBytes(hitData);
            if (!bytes) throw new Error('Failed to download card');

            let characterCard;
            let imageBuffer = null;

            if (isPng(bytes)) {
                imageBuffer = bytes;
                characterCard = api.extractCharacterDataFromPng(bytes);
                if (!characterCard) throw new Error('PNG has no embedded character data');
            } else {
                const text = new TextDecoder('utf-8').decode(bytes);
                const parsed = JSON.parse(text);
                // Accept either a bare V2/V3 data object or an already-wrapped { spec, data } card.
                characterCard = parsed?.data ? parsed : { spec: 'chara_card_v2', spec_version: '2.0', data: parsed };
            }

            if (!characterCard?.data?.name) throw new Error('Card has no name');

            const characterName = characterCard.data.name;
            characterCard.data.extensions = {
                ...(characterCard.data.extensions || {}),
                crrepo: {
                    bundleUrl: hitData.bundleUrl,
                    uri: hitData.uri,
                    id: hitData.id || null,
                    linkedAt: new Date().toISOString(),
                },
            };

            return await importFromPng({
                characterCard,
                imageBuffer,
                fileName: `crrepo_${slugify(characterName)}.png`,
                characterName,
                hasGallery: false,
                providerCharId: hitData.id || hitData.uri,
                fullPath: hitData.uri,
                avatarUrl: null,
                api,
            });
        } catch (error) {
            console.error('[CrRepoProvider] importCharacter failed:', error);
            return { success: false, error: error.message };
        }
    }

    getLinkInfo(char) {
        const ext = char?.data?.extensions?.crrepo;
        if (!ext) return null;
        return { providerId: this.id, id: ext.id || ext.uri, fullPath: ext.uri, linkedAt: ext.linkedAt };
    }

    getCharacterUrl(linkInfo) { return linkInfo?.fullPath || null; }

    getSettings() { return []; }
}

const crrepoProvider = new CrRepoProvider();
export default crrepoProvider;
