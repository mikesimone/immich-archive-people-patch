#!/usr/bin/env python3
"""Runtime patch for immich_server's BUILT FRONTEND: removes the hardcoded
"visibility: Timeline" filter the person-detail page (/people/{id}) applies to its own asset
query, so a person's page actually shows every photo they're tagged in -- archived included --
instead of silently dropping anyone whose tagged photos are all archived. Without this, the
backend fix in patch_immich_archive_people.py only gets you halfway: the person now shows up
in the People list, but clicking into them can still show zero photos.

Root cause (found by grepping the built SvelteKit output, since this is compiled/minified
frontend, not the NestJS backend patched by patch_immich_archive_people.py): the person page's
route module (.../people/[personId]/.../+page.svelte, compiled into a hashed file under
/build/www/_app/immutable/nodes/) computes its asset-search options as roughly

    { visibility: AssetVisibility.Timeline, personId: <this person's id> }

and sends that straight to GET /api/timeline/buckets. That endpoint's `visibility` param is
optional and, when omitted, returns assets of every visibility (verified empirically: the same
request with the visibility param entirely removed returns archived assets that vanish the
moment "timeline" is sent) -- so the fix is to stop sending it, not to find some other value
that means "everything".

This edits the compiled chunk in place (find via pattern match, since the file's hash-named
filename and internal minified variable names both change on every Immich release) and
regenerates its precompressed .br/.gz siblings, which the static file server prefers over the
plain .js when present -- skipping that step would leave the patch invisible to browsers even
though the file on disk is correct. No restart needed: static assets are read from disk per
request. Unlike the backend patch, there is no reliable "already patched" marker to check
(the matched file is discovered by pattern, not a fixed path) -- idempotency instead comes
from the search pattern itself no longer matching anything once patched, so a second run is a
harmless no-op.

Browser caching caveat: this directory is served with long-lived "immutable" cache headers by
design (the hash in the filename is what's supposed to signal a new version). A browser that
already loaded the old chunk keeps using its cached copy until a hard refresh, even though the
patch is live server-side immediately.

Run directly (one-shot, idempotent):

    python3 scripts/patch_immich_archive_people_frontend.py [--container immich_server]

Exits 0 if patched (or nothing needed patching), 1 on any real failure.
"""
import argparse
import re
import subprocess
import sys
import tempfile
import os

NODES_DIR_IN_CONTAINER = "/build/www/_app/immutable/nodes"

# Matches the compiled `{visibility: <enum>.Timeline, personId: ...}` object literal
# regardless of the minified identifier used for the AssetVisibility enum (verified against a
# real build as `ae.Timeline`, but that name is not stable across builds).
TARGET_RE = re.compile(r"visibility:[A-Za-z_$][A-Za-z0-9_$]*\.Timeline,personId:")
REPLACEMENT = "personId:"


def log(msg: str) -> None:
    print(f"[patch-fe] {msg}", flush=True)


def sh(cmd: list, **kwargs):
    return subprocess.run(cmd, check=True, **kwargs)


def find_matching_files(container: str) -> list:
    result = subprocess.run(
        ["docker", "exec", container, "sh", "-c",
         f"grep -lE '{TARGET_RE.pattern}' {NODES_DIR_IN_CONTAINER}/*.js 2>/dev/null || true"],
        check=True, capture_output=True, text=True,
    )
    return [line for line in result.stdout.splitlines() if line.strip()]


def recompress_in_container(container: str, container_path: str) -> None:
    # No `brotli` CLI in the image; Node's built-in zlib has both algorithms, and Node is
    # guaranteed present (it's what's running the server).
    script = (
        "const fs=require('fs'),zlib=require('zlib');"
        f"const p={container_path!r};"
        "const buf=fs.readFileSync(p);"
        "fs.writeFileSync(p+'.br', zlib.brotliCompressSync(buf));"
        "fs.writeFileSync(p+'.gz', zlib.gzipSync(buf));"
    )
    sh(["docker", "exec", container, "node", "-e", script])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--container", default="immich_server")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        matches = find_matching_files(args.container)
    except subprocess.CalledProcessError as e:
        log(f"FAIL: couldn't search {NODES_DIR_IN_CONTAINER} in {args.container}: {e}")
        return 1

    if not matches:
        log("no matching chunk found -- already patched, or this Immich build changed the code (nothing to do either way)")
        return 0

    total_patched = 0
    with tempfile.TemporaryDirectory() as tmpdir:
        for container_path in matches:
            local_path = os.path.join(tmpdir, os.path.basename(container_path))
            try:
                sh(["docker", "cp", f"{args.container}:{container_path}", local_path])
            except subprocess.CalledProcessError as e:
                log(f"FAIL: couldn't copy {container_path} out of {args.container}: {e}")
                return 1

            with open(local_path, "r", encoding="utf-8") as f:
                content = f.read()

            new_content, count = TARGET_RE.subn(REPLACEMENT, content)
            if count == 0:
                log(f"  {container_path}: matched by grep but not by the precise regex -- skipping, needs a human look")
                continue

            log(f"  {container_path}: {count} occurrence(s)")

            if args.dry_run:
                total_patched += count
                continue

            with open(local_path, "w", encoding="utf-8") as f:
                f.write(new_content)

            try:
                sh(["docker", "cp", local_path, f"{args.container}:{container_path}"])
                recompress_in_container(args.container, container_path)
            except subprocess.CalledProcessError as e:
                log(f"FAIL: couldn't write back/recompress {container_path}: {e}")
                return 1

            total_patched += count

    if args.dry_run:
        log(f"[dry-run] would patch {total_patched} occurrence(s) across {len(matches)} file(s)")
    else:
        log(f"patched {total_patched} occurrence(s) across {len(matches)} file(s); no restart needed (static files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
