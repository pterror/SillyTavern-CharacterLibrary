// cr-repo API — fetches and parses cr-repo bundles (https://github.com/rhizone/crescent docs/cr-repo-*)
//
// v1 scope is deliberately narrow: cr-bundle + cr-record + cr-uri-address only. No cr-identity
// (signing), cr-content-address (hashing), cr-log, cr-mirrors, or cr-resolve - none of those are
// needed to browse and import character cards from a hand-written or generated bundle, and the
// protocol is explicitly modular so richer bundles still degrade gracefully to this subset.

import { fetchWithProxy } from '../provider-utils.js';

// Convention (not part of the cr-repo spec itself, which is domain-neutral): a record's
// metadata.types marks it as a SillyTavern character card by including one of these.
const CHARACTER_CARD_TYPE_MARKERS = ['character-card', 'character', 'chara-card-v2', 'chara-card-v3'];

/**
 * @typedef {Object} CrRepoCharacterEntry
 * @property {string} bundleUrl - the bundle this record came from
 * @property {string} uri - where to fetch the actual card bytes
 * @property {string} title
 * @property {string} [description]
 * @property {string} [id]
 */

/**
 * @typedef {Object} CrRepoBundleInfo
 * @property {string} url
 * @property {string} title
 * @property {string} [description]
 * @property {string} [icon]
 * @property {CrRepoCharacterEntry[]} characters
 * @property {string} [error]
 */

/**
 * Fetches and parses one cr-repo bundle. Never throws - a fetch/parse failure comes back as
 * { url, error } with empty characters, so one bad bundle doesn't break the others.
 * @param {string} bundleUrl
 * @returns {Promise<CrRepoBundleInfo>}
 */
export async function fetchCrRepoBundle(bundleUrl) {
    const fallback = { url: bundleUrl, title: bundleUrl, characters: [] };
    let json;
    try {
        const resp = await fetchWithProxy(bundleUrl, { headers: { 'Accept': 'application/json' } });
        json = await resp.json();
    } catch (e) {
        return { ...fallback, error: e?.message || 'Failed to fetch bundle' };
    }

    if (json?.['cr-type'] !== 'cr-bundle' || !Array.isArray(json.records)) {
        return { ...fallback, error: 'Not a cr-bundle (missing cr-type or records)' };
    }

    // Self-description: a record whose ref points at the bundle's own URL, or a ref:null
    // record with types including "collection" (per the intro doc's own example). Either
    // convention is accepted; the first match wins.
    const selfRecord = json.records.find(r =>
        (r?.ref?.kind === 'uri' && r.ref.uri === bundleUrl) ||
        (r?.ref === null && Array.isArray(r?.metadata?.types) && r.metadata.types.includes('collection')),
    );

    const characters = [];
    for (const record of json.records) {
        if (record === selfRecord) continue;
        const types = Array.isArray(record?.metadata?.types) ? record.metadata.types : [];
        if (!types.some(t => CHARACTER_CARD_TYPE_MARKERS.includes(t))) continue;
        if (record?.ref?.kind !== 'uri' || !record.ref.uri) continue; // v1: uri-addressed only

        characters.push({
            bundleUrl,
            uri: record.ref.uri,
            title: record.metadata?.title || record.metadata?.id || record.ref.uri,
            description: record.metadata?.description || '',
            id: record.metadata?.id || null,
        });
    }

    return {
        url: bundleUrl,
        title: selfRecord?.metadata?.title || bundleUrl,
        description: selfRecord?.metadata?.description || '',
        icon: selfRecord?.metadata?.icon || null,
        characters,
    };
}

/**
 * Fetches multiple bundles in parallel. Order of results matches order of input urls.
 * @param {string[]} bundleUrls
 * @returns {Promise<CrRepoBundleInfo[]>}
 */
export async function fetchCrRepoBundles(bundleUrls) {
    return Promise.all(bundleUrls.map(fetchCrRepoBundle));
}

/**
 * Fetches the raw bytes at a character entry's uri. Returns null on failure.
 * @param {CrRepoCharacterEntry} entry
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function fetchCrRepoCardBytes(entry) {
    try {
        const resp = await fetchWithProxy(entry.uri);
        return await resp.arrayBuffer();
    } catch (e) {
        console.warn('[CrRepo] Failed to fetch card bytes:', entry.uri, e);
        return null;
    }
}
