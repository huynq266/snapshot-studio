/* =====================================================================
   SNAP LIBRARY — the "Library" tab. V2 roadmap item: "snapping a new
   capture used to destroy the old one — export/copy first or lose it."

   Decisions this file bakes in (see ROADMAP.md "V2" / "Quyet dinh con
   treo" #2):
   - No server. History lives in IndexedDB, scoped to this browser
     profile only — nobody else can see it, there is no share link.
   - Retention is not optional: screenshots are support tickets, which
     routinely carry customer data. Saved snaps auto-expire (default 14
     days, adjustable 7/14/30/never) rather than accumulating forever.

   Storage shape: one IndexedDB store, one record per saved snap —
   { id, savedAt, capturedAt, url, w, h, imgDataUrl, els, thumbDataUrl }.
   `els` is `capture.els` round-tripped through JSON — every component's
   defaults() returns plain data (positions, text, flags), never a
   function or a back-reference to `capture` itself, so this is a safe,
   lossless snapshot of the annotations. A separate small `thumbDataUrl`
   (long edge capped, JPEG) is what the grid actually paints, so opening
   the Library tab does not have to decode every full-resolution PNG at once.

   Dedup: re-opening a saved snap and closing it again without touching
   it would otherwise re-save an identical duplicate the moment something
   else replaces it. A WeakMap remembers the `els` JSON a given `capture`
   object was last saved/loaded as; autosave skips the write when nothing
   changed. Keyed on the object, not stashed as a field on `capture`,
   so this bookkeeping never leaks into what editor.js/export.js see.

   Wired up once editor.js has built its own state/DOM refs — see init()
   below and the call to it at the bottom of editor.js. */
(() => {
  window.SnapKit = window.SnapKit || {};
  const $ = (s) => document.querySelector(s);
  const hasExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  const escapeHtml = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- IndexedDB -----------------------------------------------------
  const DB_NAME = 'snapstudio-library', DB_VERSION = 1, STORE = 'snaps';
  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB is not available in this browser.')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('by_savedAt', 'savedAt');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function dbPut(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function dbGetAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbDelete(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function dbClear() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- retention settings (chrome.storage when the extension is running,
  // localStorage when this page is just opened by hand — same fallback
  // lab.js uses for custom components, so the Library tab is also
  // exercisable outside the extension). --------------------------------
  const SETTINGS_KEY = 'librarySettings';
  const SETTINGS_LS_KEY = 'snapstudio.librarySettings';
  const DEFAULT_RETENTION_DAYS = 14;
  async function getSettings() {
    let raw = null;
    if (hasExt) { try { const r = await chrome.storage.local.get(SETTINGS_KEY); raw = r[SETTINGS_KEY]; } catch (e) {} }
    else { try { raw = JSON.parse(localStorage.getItem(SETTINGS_LS_KEY) || 'null'); } catch (e) {} }
    const retentionDays = raw && Number.isFinite(raw.retentionDays) ? raw.retentionDays : DEFAULT_RETENTION_DAYS;
    return { retentionDays };
  }
  async function setRetentionDays(days) {
    const settings = { retentionDays: days };
    if (hasExt) { try { await chrome.storage.local.set({ [SETTINGS_KEY]: settings }); } catch (e) {} }
    else { try { localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(settings)); } catch (e) {} }
  }

  // ---- thumbnails ------------------------------------------------------
  function loadImageLocal(src) {
    return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
  }
  async function makeThumb(dataUrl, maxDim = 320) {
    const img = await loadImageLocal(dataUrl);
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.72);
  }

  // ---- save / dedup ------------------------------------------------------
  // Keyed on the live `capture` object, not a field on it — see file header.
  const savedSnapshotOf = new WeakMap();
  const snapshotJSON = (capture) => JSON.stringify(capture.els);
  function markClean(capture) { savedSnapshotOf.set(capture, snapshotJSON(capture)); }

  /** Writes one record. Returns false (no write) when `capture`'s annotations
   *  are byte-identical to whatever it was last saved/opened as, unless
   *  `force` — the explicit "Save to library" button always writes, since a
   *  silent no-op there would just look broken. */
  async function saveSnapshot(capture, { force = false } = {}) {
    if (!capture) return false;
    const json = snapshotJSON(capture);
    if (!force && savedSnapshotOf.get(capture) === json) return false;
    const thumbDataUrl = await makeThumb(capture.img.dataUrl);
    const record = {
      id: 'lib_' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      savedAt: Date.now(),
      capturedAt: capture.capturedAt instanceof Date ? capture.capturedAt.getTime() : Date.now(),
      url: capture.url || '',
      w: capture.img.w, h: capture.img.h,
      imgDataUrl: capture.img.dataUrl,
      els: JSON.parse(json),
      thumbDataUrl,
    };
    await dbPut(record);
    markClean(capture);
    return true;
  }

  /** The fix for "a new snap silently erases the old one": editor.js calls
   *  this with whatever capture is about to be replaced, right before it
   *  swaps in the new one. Fire-and-forget from the caller's point of view —
   *  a failure here must never block loading the new capture, only surface
   *  loudly so nothing vanishes quietly (same "degrade loudly" principle the
   *  predecessor toolkit used for its own optional integrations). */
  async function autoSaveOutgoing(capture) {
    if (!capture) return;
    try { await saveSnapshot(capture); }
    catch (e) { console.warn('[snap-studio] library autosave failed:', e); if (toastFn) toastFn('Could not save the previous capture to the library: ' + (e && e.message || e), 5000); }
    if (getViewFn && getViewFn() === 'library') renderGrid();
  }

  // ---- retention enforcement ---------------------------------------------
  async function purgeExpired() {
    const { retentionDays } = await getSettings();
    if (!retentionDays) return 0;   // 0 = "never" — nothing to purge
    const cutoff = Date.now() - retentionDays * 86400000;
    const all = await dbGetAll();
    const stale = all.filter((r) => r.savedAt < cutoff);
    for (const r of stale) await dbDelete(r.id);
    return stale.length;
  }
  async function listSnapshots() {
    await purgeExpired();
    const all = await dbGetAll();
    return all.sort((a, b) => b.savedAt - a.savedAt);
  }

  // ---- UI (job-board grid, one card per saved snap) -----------------------
  let toastFn = null, getViewFn = null;
  const grid = $('#libraryGrid'), emptyEl = $('#libraryEmpty'), retentionSel = $('#libRetention');
  const usageNote = $('#libStorageNote'), countNote = $('#libCountNote'), clearBtn = $('#libClearAll'), saveBtn = $('#libSaveCurrent');

  function cardHtml(r) {
    const host = (() => { try { return new URL(r.url).host; } catch (e) { return ''; } })();
    const when = new Date(r.savedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div class="snap-card" data-id="${r.id}">
      <div class="snap-card-thumb"><img src="${r.thumbDataUrl}" alt=""></div>
      <div class="snap-card-meta">
        <b class="snap-card-host">${escapeHtml(host || 'Untitled capture')}</b>
        <span class="snap-card-time">${when} · ${r.w}×${r.h}</span>
      </div>
      <button class="snap-card-del" type="button" title="Delete this saved snap" aria-label="Delete this saved snap">✕</button>
    </div>`;
  }

  async function updateUsageNote(count) {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { usage } = await navigator.storage.estimate();
        usageNote.textContent = `${count} saved snap${count === 1 ? '' : 's'} · about ${(usage / 1048576).toFixed(1)} MB used in this browser profile.`;
        return;
      }
    } catch (e) {}
    usageNote.textContent = `${count} saved snap${count === 1 ? '' : 's'} in this browser profile.`;
  }

  let deps = null;
  async function renderGrid() {
    const list = await listSnapshots();
    countNote.textContent = list.length ? `${list.length} saved` : '';
    emptyEl.style.display = list.length ? 'none' : '';
    grid.innerHTML = list.map(cardHtml).join('');
    [...grid.children].forEach((card, i) => {
      const rec = list[i];
      card.addEventListener('click', (e) => {
        if (e.target.closest('.snap-card-del')) { deleteOne(rec); return; }
        restoreFromLibrary(rec);
      });
    });
    updateUsageNote(list.length);
  }

  async function deleteOne(rec) {
    if (!window.confirm('Delete this saved snap? This cannot be undone.')) return;
    await dbDelete(rec.id);
    renderGrid();
  }

  async function restoreFromLibrary(record) {
    let img;
    try { img = await loadImageLocal(record.imgDataUrl); }
    catch (e) { deps.toast('Could not load that saved image.'); return; }
    const next = {
      id: record.id, url: record.url || '',
      capturedAt: new Date(record.capturedAt),
      // .el: see editor.js's loadCapture() for why the decoded Image rides along —
      // same deal here, never read by saveSnapshot() so it's safe against re-persisting.
      img: { dataUrl: record.imgDataUrl, w: img.naturalWidth, h: img.naturalHeight, el: img },
      // Round-tripped, not the stored array itself — the editor mutates
      // `capture.els` in place, and that must never reach back into the record.
      els: JSON.parse(JSON.stringify(record.els || [])),
    };
    markClean(next);   // opening it unmodified must not re-save a duplicate
    deps.setCaptureFromLibrary(next);
  }

  function init(passedDeps) {
    deps = passedDeps;
    toastFn = deps.toast;
    getViewFn = deps.getView;

    saveBtn.addEventListener('click', async () => {
      const capture = deps.getCapture();
      if (!capture) { deps.toast('Nothing to save yet — snap or upload an image first.'); return; }
      const saved = await saveSnapshot(capture, { force: true });
      deps.toast(saved ? 'Saved the current capture to the library.' : 'Already saved — nothing has changed since.');
      renderGrid();
    });

    clearBtn.addEventListener('click', async () => {
      const list = await dbGetAll();
      if (!list.length) { deps.toast('The library is already empty.'); return; }
      if (!window.confirm(`Delete all ${list.length} saved snap(s)? This cannot be undone.`)) return;
      await dbClear();
      renderGrid();
      deps.toast('Library cleared.');
    });

    retentionSel.addEventListener('change', async () => {
      await setRetentionDays(+retentionSel.value);
      renderGrid();   // enforces a tightened window immediately, not on next load
    });
    getSettings().then(({ retentionDays }) => { retentionSel.value = String(retentionDays); });
  }

  window.SnapKit.library = { init, autoSaveOutgoing, renderLibrary: renderGrid };
})();
