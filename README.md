# immich-archive-people-patch

Fixes a real limitation in [Immich](https://github.com/immich-app/immich)'s People feature:
**anyone whose only tagged photos are archived is silently hidden from the People page, the
face-tagging name-suggestion list, and their own "X photos" count** — even though the tag
itself works perfectly (it's fully saved, searchable, and functional).

Not affiliated with Immich. Tested against Immich v3.1.0.

## The bug

Tag a face in an archived album and the name works everywhere it's *used* — search by
person, direct lookup by ID, everything. But open the People page, or start typing a name
into the tagging dropdown while working in a different album, and that person is just... not
there. It looks like the tag got lost. It didn't.

The actual cause, found by reading Immich's compiled server source directly
(`dist/repositories/person.repository.js`): three queries that back the People feature —
the main listing (`getAllForUser`), a person's photo count (`getStatistics`), and the
total/hidden counts returned by `GET /api/people` (`getNumberOfPeople`) — all `INNER JOIN`
`asset_face` to `asset` with a hardcoded

```ts
.on('asset.visibility', '=', AssetVisibility.Timeline)
```

A person whose *only* tagged faces sit on `archive`-visibility assets produces zero matching
rows in that join and is excluded outright — not deprioritized, not hidden-but-findable,
just absent from the result set, with no API parameter to ask for anything else.

## The fix

This is a **runtime patch applied to the already-running container's compiled JavaScript** —
not a fork, not a custom Docker image, no Node/pnpm build toolchain required. Two pieces:

- **`patch_immich_archive_people.py`** — copies `person.repository.js` out of the
  `immich_server` container, removes the three `visibility = Timeline` clauses via precise
  string replacement, copies it back, and restarts the container to load it. Idempotent
  (checks for a marker comment before touching anything) and **fails loudly** — if a future
  Immich release changes the exact query text this targets, the script reports exactly which
  pattern it couldn't find and leaves the file untouched, rather than silently corrupting it
  or no-op'ing without telling you.

- **`reapply-archive-people-patch-on-restart.sh`** — a small watcher (meant to run as a
  systemd service) that reacts to `immich_server` **starting** and re-applies the patch. This
  is the part that matters for real use: the patch lives in the container's writable layer,
  not the image, so it's lost on every restart and every upgrade (which recreates the
  container from a fresh, unpatched image). The watcher makes it durable across both,
  including unattended auto-upgrade setups — verified end-to-end by simulating a fresh
  unpatched restart and confirming it self-heals without manual intervention, with no restart
  loop (the patch's own restart re-triggers the watcher, which finds the marker already
  present on the second pass and stops).

## Install

```
git clone https://github.com/<you>/immich-archive-people-patch.git
cd immich-archive-people-patch
python3 patch_immich_archive_people.py   # applies it right now
```

Then install the watcher so it survives restarts/upgrades:

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

```
curl -s -H "x-api-key: $IMMICH_API_KEY" "$IMMICH_URL/api/people?withHidden=true" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('total:', d['total'])"
```

Compare that `total` against a direct database count of named people
(`SELECT count(*) FROM person WHERE name != ''`) — before the patch these will disagree if
you have anyone tagged only in archived content; after, they should match.

## Caveats

- This edits compiled output, not source — it's a patch, not a proper fix. If you want the
  real fix (an `includeArchived`-style option in the actual query, mirroring the existing
  `withHidden` toggle), that belongs in a PR to Immich itself. Note that Immich's own
  [contribution guidelines](https://github.com/immich-app/immich/blob/main/CONTRIBUTING.md)
  explicitly ask contributors not to submit LLM-generated PRs, so if you want to pursue that,
  it needs to be your own patch, reviewed and understood by you, not just this repo's
  generated diff.
- Scoped deliberately narrow: only the three People-listing queries are touched. It doesn't
  touch how the automatic facial-recognition job prioritizes archived vs. timeline faces for
  clustering, general asset search visibility defaults, or anything else.
- If Immich changes this query in a future release, the patch script will tell you clearly
  that it failed to find its target pattern rather than doing something wrong silently. If
  that happens, open an issue here (or send a PR) with the new query text and it's a small fix.

## License

MIT.
