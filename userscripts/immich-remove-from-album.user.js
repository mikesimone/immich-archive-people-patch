// ==UserScript==
// @name         Immich: remove from album in "Appears in"
// @namespace    https://github.com/mikesimone/immich-remove-from-album
// @version      1.0.1
// @description  Adds a remove button to each album in the asset detail panel's "Appears in" list, so a misfiled photo can be pulled out of one album without opening that album. Undo included.
// @author       mikesimone
// @license      MIT
// @homepageURL  https://github.com/mikesimone/immich-archive-people-patch/tree/main/userscripts
// @supportURL   https://github.com/mikesimone/immich-archive-people-patch/issues
// @downloadURL  https://raw.githubusercontent.com/mikesimone/immich-archive-people-patch/main/userscripts/immich-remove-from-album.user.js
// @updateURL    https://raw.githubusercontent.com/mikesimone/immich-archive-people-patch/main/userscripts/immich-remove-from-album.user.js
// @match        http://localhost:2283/*
// @match        http://127.0.0.1:2283/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Add your own Immich address in your userscript manager's settings
// (Tampermonkey/Violentmonkey: script settings -> "User matches" / "@match"),
// e.g. https://photos.example.com/*  -- that survives script updates.
//
// How it works: the script only reads the page to find the "Appears in" list
// (links to /albums/<id> inside the asset viewer) and uses Immich's public API
// with your existing browser session:
//   GET    /api/users/me             who you are
//   GET    /api/albums?assetId=<id>  which of those albums you may edit
//   DELETE /api/albums/<id>/assets   remove   (body {"ids":[assetId]})
//   PUT    /api/albums/<id>/assets   undo     (body {"ids":[assetId]})
// Removing from an album never deletes or trashes the photo.

(() => {
  'use strict';

  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const ASSET_IN_PATH = new RegExp(`/photos/(${UUID})(?:[/?#]|$)`, 'i');
  const ALBUM_HREF = new RegExp(`^/albums/(${UUID})/?$`, 'i');
  const MARK = 'irfa';
  const CONFIRM_MS = 4000;

  // Detect Immich so a broad @match can't make this run on other sites.
  const looksLikeImmich = () =>
    !!document.querySelector('script[src*="/_app/immutable/"], link[href*="/_app/immutable/"]') ||
    /immich/i.test(document.title);

  let me = null; // { id }
  const editable = new Map(); // assetId -> Promise<Set<albumId>>
  const removed = new Set(); // `${assetId}:${albumId}` removed during this page session
  const refetched = new Set(); // `${assetId}:${albumId}` we already refetched for once

  const api = async (method, path, body) => {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        const j = await res.json();
        msg += j && j.message ? ` ${Array.isArray(j.message) ? j.message.join(', ') : j.message}` : '';
      } catch {}
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  };

  const getMe = async () => (me ??= await api('GET', '/api/users/me'));

  // Albums containing the asset that the current user may change (owner or editor).
  const editableAlbums = (assetId) => {
    if (!editable.has(assetId)) {
      const p = (async () => {
        const [user, albums] = await Promise.all([getMe(), api('GET', `/api/albums?assetId=${assetId}`)]);
        const ok = new Set();
        const all = new Set(albums.map((a) => a.id));
        for (const a of albums) {
          const owner = a.ownerId === user.id || (a.owner && a.owner.id === user.id);
          const editor = (a.albumUsers || []).some(
            (u) => u.user && u.user.id === user.id && (u.role === 'owner' || u.role === 'editor'),
          );
          if (owner || editor) ok.add(a.id);
        }
        return { all, ok };
      })();
      p.catch(() => editable.delete(assetId)); // retry next time on failure
      editable.set(assetId, p);
    }
    return editable.get(assetId);
  };

  const style = document.createElement('style');
  style.textContent = `
    .${MARK}-btn {
      margin-left: auto; flex: none; align-self: center;
      display: inline-flex; align-items: center; justify-content: center; gap: .25rem;
      min-width: 2rem; height: 2rem; padding: 0 .5rem; border-radius: 9999px;
      border: 1px solid transparent; background: transparent; color: inherit;
      font: inherit; font-size: .75rem; line-height: 1; cursor: pointer; opacity: .55;
      transition: opacity .15s, background-color .15s, color .15s, border-color .15s;
    }
    .${MARK}-btn:hover, .${MARK}-btn:focus-visible { opacity: 1; background: rgba(127,127,127,.18); outline: none; }
    .${MARK}-btn svg { width: 1.15rem; height: 1.15rem; fill: currentColor; }
    .${MARK}-btn[data-state="confirm"] { opacity: 1; color: #fff; background: #dc2626; border-color: #dc2626; }
    .${MARK}-btn[data-state="busy"] { opacity: .6; cursor: progress; }
    .${MARK}-btn[data-state="removed"] { opacity: 1; border-color: currentColor; }
    .${MARK}-btn[data-state="error"] { opacity: 1; color: #fff; background: #b45309; }
    .${MARK}-row > div:first-child { flex: none; }
    .${MARK}-row > .my-auto { min-width: 0; }
    .${MARK}-gone img, .${MARK}-gone p, .${MARK}-gone .text-sm { opacity: .4; }
    .${MARK}-gone p { text-decoration: line-through; }
    @media (hover: none) { .${MARK}-btn { opacity: .8; } }
  `;

  const ICON_REMOVE =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 13H5v-2h14v2Z"/><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z"/></svg>';

  const setState = (btn, state, label, title) => {
    btn.dataset.state = state;
    btn.title = title || label || '';
    btn.setAttribute('aria-label', title || label || '');
    btn.innerHTML = state === 'idle' ? ICON_REMOVE : `<span>${label}</span>`;
  };

  const albumName = (anchor) => (anchor.querySelector('p') || anchor).textContent.trim();

  const decorate = (anchor, assetId, albumId) => {
    const row = anchor.firstElementChild || anchor;
    let btn = row.querySelector(`:scope > .${MARK}-btn`);
    const key = `${assetId}:${albumId}`;

    if (btn && btn.dataset.asset === assetId) {
      return;
    }
    if (btn) btn.remove(); // row reused for a different asset

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${MARK}-btn`;
    btn.dataset.asset = assetId;
    btn.dataset.album = albumId;
    const name = albumName(anchor);
    let timer = 0;

    const idle = () => {
      clearTimeout(timer);
      anchor.classList.remove(`${MARK}-gone`);
      setState(btn, 'idle', '', `Remove from "${name}"`);
    };
    const showRemoved = () => {
      anchor.classList.add(`${MARK}-gone`);
      setState(btn, 'removed', 'Undo', `Removed from "${name}". Click to add it back.`);
    };

    if (removed.has(key)) showRemoved();
    else idle();

    // Keep the click from reaching the album link / SvelteKit's router.
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && btn.dataset.state === 'confirm') {
        swallow(e);
        idle();
      }
    });
    btn.addEventListener('click', async (e) => {
      swallow(e);
      const state = btn.dataset.state;
      if (state === 'busy') return;
      if (state === 'idle' || state === 'error') {
        setState(btn, 'confirm', 'Remove?', `Click again to remove from "${name}"`);
        clearTimeout(timer);
        timer = setTimeout(() => btn.dataset.state === 'confirm' && idle(), CONFIRM_MS);
        return;
      }
      clearTimeout(timer);
      const undo = state === 'removed';
      setState(btn, 'busy', '…');
      try {
        const result = await api(undo ? 'PUT' : 'DELETE', `/api/albums/${albumId}/assets`, { ids: [assetId] });
        const r = Array.isArray(result) ? result.find((x) => x.id === assetId) : null;
        // "not_found" on remove / "duplicate" on undo mean it's already in the state we want.
        if (r && !r.success && r.error !== (undo ? 'duplicate' : 'not_found')) throw new Error(r.error || 'failed');
        if (undo) {
          removed.delete(key);
          idle();
        } else {
          removed.add(key);
          showRemoved();
        }
      } catch (err) {
        console.warn('[immich-remove-from-album]', err);
        setState(btn, 'error', 'Failed', `Couldn't ${undo ? 'add back to' : 'remove from'} "${name}": ${err.message}`);
        if (undo) anchor.classList.add(`${MARK}-gone`);
        timer = setTimeout(() => (undo ? showRemoved() : idle()), CONFIRM_MS);
      }
    });

    row.classList.add(`${MARK}-row`);
    row.appendChild(btn);
  };

  let scheduled = false;
  const scan = async () => {
    scheduled = false;
    const m = location.pathname.match(ASSET_IN_PATH);
    if (!m) return;
    const assetId = m[1].toLowerCase();

    const anchors = [...document.querySelectorAll('section a[href^="/albums/"]')]
      .map((a) => ({ a, m: (a.getAttribute('href') || '').match(ALBUM_HREF) }))
      .filter((x) => x.m && x.a.querySelector('img'));
    if (!anchors.length) return;

    let ok;
    try {
      let info = await editableAlbums(assetId);
      // Album list changed since we asked (e.g. just added to another album): ask again once.
      const unknown = ({ m: am }) => {
        const id = am[1].toLowerCase();
        return !info.all.has(id) && !removed.has(`${assetId}:${id}`) && !refetched.has(`${assetId}:${id}`);
      };
      if (anchors.some(unknown)) {
        anchors.filter(unknown).forEach(({ m: am }) => refetched.add(`${assetId}:${am[1].toLowerCase()}`));
        editable.delete(assetId);
        info = await editableAlbums(assetId);
      }
      ok = info.ok;
    } catch (err) {
      console.warn('[immich-remove-from-album] could not load albums', err);
      return;
    }
    // The URL may have moved on while we waited.
    if (!location.pathname.toLowerCase().includes(assetId)) return schedule();

    for (const { a, m: am } of anchors) {
      const albumId = am[1].toLowerCase();
      if (ok.has(albumId) || removed.has(`${assetId}:${albumId}`)) decorate(a, assetId, albumId);
      else (a.firstElementChild || a).querySelector(`:scope > .${MARK}-btn`)?.remove();
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => setTimeout(scan, 50));
  };

  const start = () => {
    if (!looksLikeImmich()) return;
    document.head.appendChild(style);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  };

  if (document.body) start();
  else addEventListener('DOMContentLoaded', start, { once: true });
})();
