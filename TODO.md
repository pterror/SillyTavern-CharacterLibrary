# TODO

Remaining items from the issue-tracker audit that need real design/scope
work before implementation - not quick fixes.

## Folders / landing page (#45)

Feature request: a folder-based landing view instead of the flat character
grid, for users with large libraries.

Scoping notes (see prior session):
- Reuse the existing Playlists data model (`modules/playlists.js`) - a flat
  map `{uid: {name, description, icon, color, characters: [avatars]}}` +
  an `order` array, persisted via the Files API. Already carries a name,
  icon, and color, which maps close to "folder + label."
- `getAllPlaylists()`, `getPlaylistCharacters(uid)`, `getPlaylistAvatarSet`
  already give everything needed to enumerate folders and their contents.
  `setPlaylistFilter(uid)` already exists for click-through into the
  filtered grid.
- Playlists are currently used only as a single-select filter (a dropdown
  narrowing the existing flat grid) - no grouped/row-based rendering
  exists anywhere today. That part is net-new.
- Open design questions before starting: a new view mode (folder tiles?
  Netflix-style rows?), how a character in zero or multiple playlists is
  handled (an "Uncategorized" bucket? shown in every row it belongs to?),
  where the new view's entry point lives relative to the existing grid/list
  toggle.

## i18n / Chinese language support (#1)

Feature request, endorsed by multiple commenters, for Chinese (and by
extension any non-English) UI support.

Scoping notes (see prior session):
- Zero existing i18n scaffolding: no `data-i18n` attributes, no `t()`
  function, no locale JSON files anywhere in `app/` or `modules/`.
- Every user-facing string is a hardcoded English literal - ~294
  `showToast()` calls alone across `app/library.js` + `modules/*.js`,
  before counting inline HTML template literals, modal headers/labels,
  tooltips, and placeholders. Order of magnitude: low thousands of
  distinct strings, not hundreds.
- The extension's UI runs in its own `<iframe>` (`charlib-embedded-iframe`
  in `index.js`), a separate document from the SillyTavern host page.
  Host ST's `data-i18n` + locale-JSON i18n mechanism operates on the host
  DOM/window and isn't automatically reachable inside that iframe -
  bridging it (via the existing `SillyTavern.getContext()` call already
  used for other things) is plausible but would itself be new plumbing,
  not a drop-in reuse.
- Groundwork needed before any translation work is useful: convert
  literals to keys, build a lookup/loading mechanism (bridged to core ST
  or standalone), then translations become a comparatively easy last step
  for a volunteer translator to fill in.
