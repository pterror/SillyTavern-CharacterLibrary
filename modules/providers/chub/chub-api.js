// Shared ChubAI API utilities - used by chub-provider.js and chub-browse.js
//
// Contains constants, auth headers, metadata/lorebook/gallery fetch,
// the V2 card builder, and the metadata cache. Initialized once via
// initChubApi() which receives getSetting + debugLog from CoreAPI.

// ========================================
// CONSTANTS
// ========================================

// Default upstream hosts. ChubAI splits across three of them:
//   api.chub.ai           - REST API
//   gateway.chub.ai       - GraphQL gateway / favorites / gallery
//   avatars.charhub.io    - public CDN for avatars and card PNGs
const CHUB_DEFAULT_API     = 'https://api.chub.ai';
const CHUB_DEFAULT_GATEWAY = 'https://gateway.chub.ai';
const CHUB_DEFAULT_AVATAR  = 'https://avatars.charhub.io/avatars/';

// When the user runs ChubAI through their own gateway, only one base URL
// is usually needed. The convention below mirrors the gateway used by
// this extension upstream (`/v1/chub`, `/v1/chub-gw`, `/v1/chub-av`); a
// reverse proxy that uses these paths gets the simple single-field setup.
// Per-host overrides are still available for non-standard topologies.
const CHUB_GATEWAY_PATHS = {
    api:    '/v1/chub',
    gw:     '/v1/chub-gw',
    avatar: '/v1/chub-av/avatars/',
};

function _trimSlash(s) {
    return s.replace(/\/+$/, '');
}

function _resolveChubBase(overrideKey, defaultBase, gatewayPath) {
    const override = _trimSlash((_getSetting?.(overrideKey) || '').trim());
    if (override) return override;
    const base = _trimSlash((_getSetting?.('chubGatewayBaseUrl') || '').trim());
    if (base) return base + gatewayPath;
    return defaultBase;
}

export function getChubApiBase() {
    return _resolveChubBase('chubGatewayApiUrl', CHUB_DEFAULT_API, CHUB_GATEWAY_PATHS.api);
}

export function getChubGatewayBase() {
    return _resolveChubBase('chubGatewayGatewayUrl', CHUB_DEFAULT_GATEWAY, CHUB_GATEWAY_PATHS.gw);
}

export function getChubAvatarBase() {
    const base = _resolveChubBase('chubGatewayAvatarUrl', CHUB_DEFAULT_AVATAR, CHUB_GATEWAY_PATHS.avatar);
    return base.endsWith('/') ? base : base + '/';
}

// ========================================
// INITIALIZATION
// ========================================

let _getSetting = null;
let _debugLog = null;

/**
 * Must be called once before any other export is used.
 * Typically called from ChubProvider.init(coreAPI).
 * @param {{ getSetting: Function, debugLog: Function }} deps
 */
export function initChubApi(deps) {
    _getSetting = deps.getSetting;
    _debugLog = deps.debugLog;
}

function debugLog(...args) {
    _debugLog?.(...args);
}

// ========================================
// NETWORK
// ========================================

/**
 * Build Chub API headers with optional Bearer token.
 * @param {boolean} includeAuth
 * @returns {Object}
 */
export function getChubHeaders(includeAuth = true) {
    const headers = { 'Accept': 'application/json' };
    const gwKey = _getSetting?.('chubGatewayKey');
    const token = _getSetting?.('chubToken');
    if (gwKey) {
        // Going through a self-hosted gateway: gateway key authenticates to the gateway itself,
        // real chub token forwarded separately so the gateway can re-attach it upstream however
        // that gateway expects (its contract, not chub.ai's).
        headers['Authorization'] = `Bearer ${gwKey}`;
        if (includeAuth && token) headers['X-Chub-Token'] = token;
        return headers;
    }
    if (includeAuth && token) {
        // Talking to chub.ai directly: its gateway accepts the same credential under any of
        // samwise/CH-API-KEY/Authorization depending on endpoint (confirmed empirically against
        // /search) - send all three so auth-gated content (e.g. NSFL) isn't silently dropped just
        // because one endpoint prefers a different header name.
        headers['Authorization'] = `Bearer ${token}`;
        headers['samwise'] = token;
        headers['CH-API-KEY'] = token;
    }
    return headers;
}

export { fetchWithProxy } from '../provider-utils.js';
import { proxyEncode } from '../provider-utils.js';

// ========================================
// RESPONSE HELPERS
// ========================================

/**
 * Extract nodes from various Chub API response envelope formats.
 */
export function extractNodes(data) {
    if (data.nodes) return data.nodes;
    if (data.data?.nodes) return data.data.nodes;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data)) return data;
    return [];
}

// ========================================
// METADATA CACHE
// ========================================

export const chubMetadataCache = new Map();
const CHUB_METADATA_CACHE_MAX = 3;
const CHUB_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ========================================
// METADATA FETCH
// ========================================

/**
 * Fetch character metadata from the Chub REST API (with LRU cache).
 * Returns a stripped-down node object containing only fields used by
 * the import pipeline, card builder, and browse view.
 * @param {string} fullPath - e.g. "creator/slug"
 * @returns {Promise<Object|null>}
 */
export async function fetchChubMetadata(fullPath) {
    const cached = chubMetadataCache.get(fullPath);
    if (cached && Date.now() - cached.time < CHUB_CACHE_TTL) {
        debugLog('[Chub] Using cached metadata for:', fullPath);
        return cached.value;
    }

    try {
        const url = `${getChubApiBase()}/api/characters/${fullPath}?full=true`;
        debugLog('[Chub] Fetching metadata from:', url);

        let response;
        try {
            response = await fetch(url, { headers: getChubHeaders(true) });
        } catch (directError) {
            debugLog('[Chub] Direct fetch failed, trying proxy:', directError.message);
            const proxyUrl = `/proxy/${proxyEncode(url)}`;
            response = await fetch(proxyUrl, { headers: getChubHeaders(true) });
        }

        if (!response.ok) {
            if (response.status === 404) {
                const text = await response.text();
                if (text.includes('CORS proxy is disabled')) {
                    console.error('[Chub] CORS blocked and proxy is disabled');
                    return null;
                }
            }
            return null;
        }

        const data = await response.json();
        const result = data.node || null;

        if (result) {
            const def = result.definition || {};
            const strippedResult = {
                id: result.id,
                name: result.name,
                fullPath: result.fullPath,
                topics: result.topics,
                tagline: result.tagline,
                avatar_url: result.avatar_url,
                max_res_url: result.max_res_url,
                hasGallery: result.hasGallery,
                creator: result.creator,
                definition: {
                    name: def.name,
                    personality: def.personality,
                    tavern_personality: def.tavern_personality,
                    first_message: def.first_message,
                    example_dialogs: def.example_dialogs,
                    description: def.description,
                    scenario: def.scenario,
                    system_prompt: def.system_prompt,
                    post_history_instructions: def.post_history_instructions,
                    alternate_greetings: def.alternate_greetings,
                    extensions: def.extensions,
                    character_version: def.character_version,
                    tagline: def.tagline,
                    embedded_lorebook: def.embedded_lorebook,
                },
                related_lorebooks: result.related_lorebooks || [],
                lastActivityAt: result.lastActivityAt || result.last_activity_at || null,
                createdAt: result.createdAt || result.created_at || null,
                starCount: result.starCount || result.star_count || 0,
                rating: result.rating || 0,
                nTokens: result.nTokens || result.n_tokens || 0,
            };

            while (chubMetadataCache.size >= CHUB_METADATA_CACHE_MAX) {
                const firstKey = chubMetadataCache.keys().next().value;
                chubMetadataCache.delete(firstKey);
            }
            chubMetadataCache.set(fullPath, { value: strippedResult, time: Date.now() });
            return strippedResult;
        }

        return result;
    } catch (error) {
        return null;
    }
}

// ========================================
// LOREBOOK FETCH
// ========================================

/**
 * Fetch a linked (non-embedded) lorebook via the V4 Git API.
 * Chub characters can have lorebooks in separate projects that are
 * only resolved in the exported card.json.
 * @param {number} projectId - Chub project/character numeric ID
 * @returns {Promise<Object|null>} character_book object or null
 */
export async function fetchChubLinkedLorebook(projectId) {
    if (!projectId) return null;
    const headers = getChubHeaders(true);
    // Proxy only when fetch itself rejects (CORS/network); an HTTP error is a valid answer, not a proxy trigger.
    const tryFetch = async (url) => {
        try { return await fetch(url, { headers }); }
        catch (e) {
            if (e.name === 'AbortError') throw e;
            return await fetch(`/proxy/${proxyEncode(url)}`, { headers });
        }
    };
    try {
        const commitsResp = await tryFetch(`${getChubApiBase()}/api/v4/projects/${projectId}/repository/commits`);
        if (!commitsResp.ok) return null;
        const commits = await commitsResp.json();
        const ref = Array.isArray(commits) && commits[0]?.id;
        if (!ref) return null;

        const cardResp = await tryFetch(`${getChubApiBase()}/api/v4/projects/${projectId}/repository/files/raw%252Fcard.json/raw?ref=${ref}`);
        if (!cardResp.ok) return null;
        const card = await cardResp.json();
        const book = card?.data?.character_book || card?.character_book || null;
        if (book) {
            debugLog('[Chub] Resolved linked lorebook from V4 Git API for project', projectId, `— ${book.entries?.length ?? 0} entries`);
        }
        return book;
    } catch (e) {
        console.error('[Chub] fetchChubLinkedLorebook failed for project', projectId, e);
        return null;
    }
}

/**
 * Fetch a linked (non-embedded) lorebook by its own "lorebooks/creator/project-name" path -
 * definition.extensions.chub.related_lorebooks[].path, NOT the character's own id/path. Resolves
 * the project id from that path first (metadata lookup), then reads its sillytavern_raw.json via
 * the V4 Git API - the same native { entries: {...} } shape ST's own /worldinfo/import expects,
 * so the result can be handed to window.importWorldInfoData() with no format conversion.
 *
 * Path-based (not id-based) on purpose: a bare numeric id is not confirmed to resolve unlisted
 * content the same way a path does.
 *
 * @param {string} path - e.g. "lorebooks/creator/project-name"
 * @returns {Promise<Object|null>} native World Info data ({ entries: {...} }), or null if unresolvable
 */
export async function fetchChubLorebookRawByPath(path) {
    if (!path) return null;
    const headers = getChubHeaders(true);
    const tryFetch = async (url) => {
        try { return await fetch(url, { headers }); }
        catch (e) {
            if (e.name === 'AbortError') throw e;
            return await fetch(`/proxy/${proxyEncode(url)}`, { headers });
        }
    };
    try {
        const metaResp = await tryFetch(`${getChubApiBase()}/api/${path}`);
        if (!metaResp.ok) return null;
        const metaData = await metaResp.json();
        const projectId = metaData?.node?.id;
        if (!projectId) return null;

        const commitsResp = await tryFetch(`${getChubApiBase()}/api/v4/projects/${projectId}/repository/commits`);
        if (!commitsResp.ok) return null;
        const commits = await commitsResp.json();
        const ref = Array.isArray(commits) && commits[0]?.id;
        if (!ref) return null;

        const rawResp = await tryFetch(`${getChubApiBase()}/api/v4/projects/${projectId}/repository/files/raw%252Fsillytavern_raw.json/raw?ref=${ref}`);
        if (!rawResp.ok) return null;
        const worldData = await rawResp.json();
        if (worldData?.entries && typeof worldData.entries === 'object') {
            debugLog('[Chub] Resolved linked lorebook from V4 Git API for path', path);
            return worldData;
        }
        return null;
    } catch (e) {
        console.error('[Chub] fetchChubLorebookRawByPath failed for', path, e);
        return null;
    }
}

// ========================================
// GALLERY FETCH
// ========================================

// ========================================
// V2 CARD BUILDER
// ========================================

/**
 * Build a V2 character card from Chub API metadata.
 *
 * The Chub API uses its OWN field names that differ from the V2 spec.
 * This mapping matches SillyTavern's downloadChubCharacter() in
 * src/endpoints/content-manager.js:
 *
 *   definition.personality           → data.description
 *   definition.tavern_personality    → data.personality
 *   definition.first_message         → data.first_mes
 *   definition.example_dialogs       → data.mes_example
 *   definition.description           → data.creator_notes
 *   definition.embedded_lorebook     → data.character_book
 *   metadata.topics                  → data.tags
 *
 * Does NOT resolve linked (non-embedded) lorebooks - definition.extensions.chub.related_lorebooks
 * is a separate Chub project, not a variant of this card's own embedded_lorebook, and importing
 * one should never silently overwrite the other. The caller (ChubProvider.importCharacter)
 * resolves and imports linked lorebooks separately, as their own additional World Info files.
 *
 * @param {Object} apiData - Metadata object from fetchChubMetadata()
 * @returns {Object} V2-spec character card { spec, spec_version, data }
 */
export function buildCharacterCardFromChub(apiData) {
    const def = apiData.definition || {};
    const characterBook = def.embedded_lorebook || undefined;

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: def.name || apiData.name || 'Unknown',
            description: def.personality || '',
            personality: def.tavern_personality || '',
            scenario: def.scenario || '',
            first_mes: def.first_message || '',
            mes_example: def.example_dialogs || '',
            creator_notes: def.description || '',
            system_prompt: def.system_prompt || '',
            post_history_instructions: def.post_history_instructions || '',
            alternate_greetings: def.alternate_greetings || [],
            tags: apiData.topics || [],
            creator: apiData.fullPath?.split('/')[0] || '',
            character_version: def.character_version || '',
            extensions: {
                ...(def.extensions || {}),
                chub: {
                    ...(def.extensions?.chub || {}),
                    tagline: apiData.tagline || def.tagline || ''
                }
            },
            character_book: characterBook,
        }
    };
}
