# Userscripts

## immich-remove-from-album.user.js

Adds a remove button (two-click confirm, with undo) to every album in the asset detail panel's
"Appears in" list, so a misfiled photo can leave one album without opening that album. Uses only the
public album API with your browser session; never deletes or trashes anything.

Status: stopgap. The same feature is written as a change to Immich's web app on
`mikesimone/immich` (branch `claude/project-thread-urh7ds`) for an upstream PR. Once Immich ships
it natively, drop this script.

**Server-side (how Mike runs it):** `patch_immich_remove_from_album.py` in the repo root serves this script from
Immich's own index.html, so every browser gets it with nothing installed. The watcher re-applies it after every
restart or upgrade.

Or install it per browser in Violentmonkey/Tampermonkey, then add your Immich address (e.g. `https://pics.example.com/*`)
as a user `@match` in the script's settings. Tested live against Immich v3.4.2 on 2026-11-23.
