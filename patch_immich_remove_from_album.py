#!/usr/bin/env python3
"""Runtime patch for immich_server's BUILT FRONTEND: serves the remove-from-album add-on
(userscripts/immich-remove-from-album.user.js) from Immich itself, so every browser that opens
Immich gets a remove button next to each album in the asset viewer's "Appears in" list, with
nothing installed per browser. Stopgap until upstream Immich ships the same feature natively
(change prepared on mikesimone/immich, branch claude/project-thread-urh7ds).

What it does, inside the running container:
  1. copies the script to /build/www/custom/immich-remove-from-album-<sha8>.js (content hash
     in the filename, so a changed script is a new URL and no browser can serve a stale copy)
     and writes its .br/.gz siblings like the rest of the build;
  2. adds one <script defer> tag for it to /build/www/index.html, just before </head>,
     marked with an HTML comment so re-runs are idempotent, and regenerates index.html.br/.gz;
  3. removes any older custom/immich-remove-from-album-*.js left by a previous version;
  4. restarts the container, because Immich serves index.html from an in-memory copy read at
     startup (same reason patch_immich_archive_people_frontend.py restarts).

The script itself only reads the page and calls Immich's public album API with the logged-in
user's own session; it never deletes or trashes assets. If a future Immich changes the
"Appears in" markup, the buttons simply stop appearing; nothing else breaks.

Idempotent: if index.html already references the current script hash, it does nothing.
Fails loudly (exit 1, nothing half-written to index.html) if index.html has no </head>.

    python3 patch_immich_remove_from_album.py [--container immich_server] [--dry-run]
"""
import argparse
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import time

WWW_ROOT = "/build/www"
INDEX_HTML = f"{WWW_ROOT}/index.html"
CUSTOM_DIR = f"{WWW_ROOT}/custom"
NAME = "immich-remove-from-album"
MARK_RE = re.compile(r"<!-- " + NAME + r" -->.*?<!-- /" + NAME + r" -->\n?", re.S)
SCRIPT_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "userscripts", f"{NAME}.user.js")


def log(msg: str) -> None:
    print(f"[patch-rfa] {msg}", flush=True)


def sh(cmd: list, **kwargs):
    return subprocess.run(cmd, check=True, **kwargs)


def read_file(container: str, path: str, tmpdir: str) -> str:
    local = os.path.join(tmpdir, os.path.basename(path) + f".{time.time_ns()}")
    sh(["docker", "cp", f"{container}:{path}", local])
    with open(local, encoding="utf-8") as f:
        return f.read()


def write_file(container: str, path: str, content: str, tmpdir: str) -> None:
    local = os.path.join(tmpdir, os.path.basename(path) + f".{time.time_ns()}")
    with open(local, "w", encoding="utf-8") as f:
        f.write(content)
    sh(["docker", "cp", local, f"{container}:{path}"])


def recompress(container: str, path: str) -> None:
    script = (
        "const fs=require('fs'),zlib=require('zlib');"
        f"const p={path!r};"
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
    container = args.container

    with open(SCRIPT_SRC, encoding="utf-8") as f:
        script = f.read()
    sha8 = hashlib.sha256(script.encode()).hexdigest()[:8]
    filename = f"{NAME}-{sha8}.js"
    url = f"/custom/{filename}"
    tag = f'<!-- {NAME} --><script src="{url}" defer></script><!-- /{NAME} -->\n'

    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            index = read_file(container, INDEX_HTML, tmpdir)
        except subprocess.CalledProcessError as e:
            log(f"FAIL: couldn't read {INDEX_HTML} from {container}: {e}")
            return 1

        if url in index:
            log(f"already applied ({filename}); nothing to do")
            return 0

        stripped = MARK_RE.sub("", index)
        if "</head>" not in stripped:
            log(f"FAIL: {INDEX_HTML} has no </head>; this Immich build differs from what this script expects. Nothing changed.")
            return 1
        new_index = stripped.replace("</head>", tag + "</head>", 1)

        if args.dry_run:
            log(f"[dry-run] would install {url} and add its <script> tag to index.html, then restart {container}")
            return 0

        sh(["docker", "exec", container, "mkdir", "-p", CUSTOM_DIR])
        sh(["docker", "exec", container, "sh", "-c", f"rm -f {CUSTOM_DIR}/{NAME}-*.js {CUSTOM_DIR}/{NAME}-*.js.br {CUSTOM_DIR}/{NAME}-*.js.gz"])
        write_file(container, f"{CUSTOM_DIR}/{filename}", script, tmpdir)
        recompress(container, f"{CUSTOM_DIR}/{filename}")
        log(f"installed {CUSTOM_DIR}/{filename}")

        write_file(container, INDEX_HTML, new_index, tmpdir)
        recompress(container, INDEX_HTML)
        log(f"added <script src=\"{url}\"> to {INDEX_HTML}")

    log(f"restarting {container}: index.html is served from an in-memory copy read at startup")
    sh(["docker", "restart", container])
    log("done; every browser gets the button on its next page load")
    return 0


if __name__ == "__main__":
    sys.exit(main())
