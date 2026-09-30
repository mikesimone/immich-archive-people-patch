# immich-archive-people-patch

Fixes a real limitation in [Immich](https://github.com/immich-app/immich)'s People feature:
**anyone whose only tagged photos are archived is silently hidden from the People page, the
face-tagging name-suggestion list, their own "X photos" count, and even their own person-detail
page** — even though the tag itself works perfectly (it's fully saved, searchable, and
functional).

Not affiliated with Immich. Tested against Immich v3.1.0 and v3.2.4.

## The bugs

Tag a face in an archived album and the name works everywhere it's *used* — search by
person, direct lookup by ID, everything. But the parts of the UI meant for *browsing* by
person quietly drop archived content, in two independent places:

**1. The People page, tagging suggestions, and photo counts** (backend). Found by reading
Immich's compiled server source directly (`dist/repositories/person.repository.js`): three
queries — the main listing (`getAllForUser`), a person's photo count (`getStatistics`), and
the total/hidden counts returned by `GET /api/people` (`getNumberOfPeople`) — all `INNER JOIN`
`asset_face` to `asset` with a hardcoded

```ts
.on('asset.visibility', '=', AssetVisibility.Timeline)
```

A person whose *only* tagged faces sit on `archive`-visibility assets produces zero matching
rows in that join and is excluded outright — not deprioritized, not hidden-but-findable, just
absent from the result set, with no API parameter to ask for anything else.

**2. The person's own page** (`/people/{id}`, frontend). Even once a person shows up in the
People list, clicking into them can still show zero photos. This one isn't a backend
restriction at all — the backend's timeline-bucket endpoint (`GET /api/timeline/buckets`)
happily returns archived assets when no `visibility` filter is sent. The person page's own
Svelte component just always sends one anyway: its asset-fetch options are hardcoded as
`{ visibility: AssetVisibility.Timeline, personId: ... }`. Found by grepping the *built*
frontend bundle (`/build/www/_app/immutable/nodes/*.js` inside the container) for the compiled
form of that object literal, since this is compiled/minified Svelte output, not readable
TypeScript source.

## The fix

Three **runtime patches applied to the already-running container** — not a fork, not a custom
Docker image, no Node/pnpm build toolchain required — plus a watcher that keeps both applied
across restarts and upgrades.

- **`patch_immich_archive_partners.py`** (backend, needed on Immich 3.2.x) — in 3.2.x the
  person page asks for `{personId, withPartners: true}` with no `visibility`, and the server's
  `timeBucketChecks()` rejects `withPartners` unless visibility is Timeline, so archived-only
  people show a count over an empty grid. This patch allows that combination and changes the
  owner filter to *your assets (timeline + archive) OR partners' assets (timeline only)*, so
  partner sharing keeps working and a partner's archive is never exposed. Same rules as the
  others: exact-match text replacement, idempotent marker, fails loudly if upstream changed.

- **`patch_immich_archive_people.py`** (backend) — copies `person.repository.js` out of the
  `immich_server` container, removes the three `visibility = Timeline` clauses via precise
  string replacement, copies it back, and restarts the container to load it. Idempotent
  (checks for a marker comment before touching anything) and **fails loudly** — if a future
  Immich release changes the exact query text this targets, the script reports exactly which
  pattern it couldn't find and leaves the file untouched, rather than silently corrupting it
  or no-op'ing without telling you.

- **`patch_immich_archive_people_frontend.py`** (frontend) — finds the built chunk containing
  the person page's hardcoded visibility filter (by content, not by its hash-named filename,
  since that hash changes on every build) and removes the `visibility:` key from that object
  literal. `/_app/immutable/` is served `Cache-Control: public,max-age=31536000,immutable` —
  a year, with no revalidation even on a normal reload — so editing the file's *content* while
  keeping its *name* would fix the server but leave every client that already loaded that exact
  URL stuck on a stale cached copy indefinitely, no ordinary refresh able to fix it. Instead
  this script actually **renames** the patched file (a new URL is a guaranteed cache miss) and
  cascades that rename upward through whatever references it — one hop at a time — until it
  reaches a file that *isn't* immutably cached. In practice that's exactly two hops: the node
  chunk is imported by one entry chunk, which is referenced only by `index.html`, and
  `index.html` is served `Cache-Control: no-store`. Once its content points at the new entry
  filename, every client picks up the whole fixed chain on their next *normal* page load — no
  hard refresh, no cache clearing, no user action. It also regenerates precompressed `.br`/`.gz`
  siblings at each renamed file (no `brotli` CLI in the image, so this uses Node's built-in
  `zlib`) and cleans up the orphaned pre-rename files once the cascade succeeds, so a later run
  doesn't find them still matching and try to redo the cascade from a stale starting point.
  `index.html`'s edit needs one container restart to take effect (unlike the plain chunk files,
  which are read from disk per request, Immich serves `index.html` from an in-memory copy read
  once at startup) — the script issues that restart itself. Idempotent (checks whether the
  chunk `index.html` *currently* references still has the bug) and fails loudly at every step
  (wrong number of referencing files, chain doesn't resolve within a few hops, etc. all abort
  cleanly without touching anything further) rather than guessing.

- **`reapply-archive-people-patch-on-restart.sh`** — a small watcher (meant to run as a
  systemd service) that reacts to `immich_server` **starting** and re-applies both patches.
  This is the part that matters for real use: both patches live in the container's writable
  layer, not the image, so they're lost on every restart and every upgrade (which recreates
  the container from a fresh, unpatched image). The watcher makes them durable across both,
  including unattended auto-upgrade setups — verified end-to-end by simulating a fresh
  unpatched restart of both and confirming they self-heal without manual intervention. Either
  patch's own restart re-triggers the watcher, but each converges (finds its target already
  applied and stops) within a few passes rather than looping.

## Install

```
git clone https://github.com/<you>/immich-archive-people-patch.git
cd immich-archive-people-patch
python3 patch_immich_archive_people.py            # applies the backend fix right now
python3 patch_immich_archive_people_frontend.py    # applies the frontend fix right now
python3 patch_immich_archive_partners.py           # Immich 3.2.x: person page + partner sharing
```

Then install the watcher so both survive restarts/upgrades:

```
sudo cp systemd/immich-archive-people-patch-watcher.service /etc/systemd/system/
# edit the ExecStart path in that file to point at wherever you cloned this repo
sudo systemctl daemon-reload
sudo systemctl enable --now immich-archive-people-patch-watcher.service
```

If your `immich_server` container has a non-default name, pass `--container <name>` to the
script and set `IMMICH_CONTAINER=<name>` as an environment override for the watcher (see the
top of `reapply-archive-people-patch-on-restart.sh`).

## Verifying it worked

Backend fix — People totals should match the database:

```
curl -s -H "x-api-key: $IMMICH_API_KEY" "$IMMICH_URL/api/people?withHidden=true" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('total:', d['total'])"
```

Compare that `total` against a direct database count of named people
(`SELECT count(*) FROM person WHERE name != ''`) — before the patch these will disagree if
you have anyone tagged only in archived content; after, they should match.

Frontend fix — a person tagged only in archived photos should get a nonzero bucket count with
no `visibility` param (this is exactly the request the patched person page now makes):

```
curl -s -H "x-api-key: $IMMICH_API_KEY" "$IMMICH_URL/api/timeline/buckets?personId=<their-id>" \
  | python3 -c "import json,sys; print(sum(b['count'] for b in json.load(sys.stdin)))"
```

Then just load their `/people/{id}` page in the browser — no hard refresh needed, per the
cache-busting cascade described above — and confirm their photos actually render.

## Caveats

- Both patches edit compiled/built output, not source — they're patches, not a proper fix. If
  you want the real fix (an `includeArchived`-style option in the backend query, mirroring the
  existing `withHidden` toggle, and the frontend actually exposing it), that belongs in a PR to
  Immich itself. Note that Immich's own
  [contribution guidelines](https://github.com/immich-app/immich/blob/main/CONTRIBUTING.md)
  explicitly ask contributors not to submit LLM-generated PRs, so if you want to pursue that,
  it needs to be your own patch, reviewed and understood by you, not just this repo's
  generated diff.
- Scoped deliberately narrow: only the three People-listing queries and the one person-page
  fetch are touched. Neither patch changes how the automatic facial-recognition job
  prioritizes archived vs. timeline faces for clustering, general asset search visibility
  defaults, or anything else.
- If Immich changes the targeted code in a future release, both scripts will tell you clearly
  that they failed to find their target pattern rather than doing something wrong silently. If
  that happens, open an issue here (or send a PR) with the new code and it's a small fix.

## License

MIT.
