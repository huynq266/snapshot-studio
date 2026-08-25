/* Export / copy / clipboard. Turns the current capture + annotations into a
   PNG (via the background service worker's real compositor screenshot —
   backdrop-filter glass does not rasterize through a canvas re-draw, only a
   real screenshot, see the header comment in editor.js), and owns both ends
   of the clipboard workflow: Ctrl+C copies the annotated shot, Ctrl+V (the
   `paste` event) drops a clipboard image on the stage as its own layer.

   Wired up once editor.js has built its own state/DOM refs — see init()
   below and the call to it at the bottom of editor.js. */
(() => {
  window.SnapKit = window.SnapKit || {};
  const $ = (s) => document.querySelector(s);
  const isTyping = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  };

  function init(deps) {
    const { getCapture, getView, stage, toast, hasExt, cropDataUrl, loadImage, loadCapture, select, setView } = deps;

    function dataUrlToBlob(dataUrl) {
      const [head, b64] = dataUrl.split(',');
      const mime = head.match(/data:(.*?);base64/)[1];
      const bin = atob(b64); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    }

    // body.render (below) swaps the whole layout to a chrome-less, un-zoomed, natural-size
    // stage — the only way to get a pixel-accurate compositor screenshot — which is a hard
    // visual cut if it lands on an unveiled screen. The veil fades in first and eats that
    // cut, then fades back out once the normal layout has repainted behind it.
    async function renderToPngDataUrl() {
      const veil = $('#renderVeil');
      veil.classList.add('show');
      await new Promise((r) => setTimeout(r, 130));   // let the veil's own fade-in finish
      document.body.classList.add('render');
      // two rAFs: one to flush the class toggle, one more so backdrop-filter has
      // actually painted before the compositor screenshot fires
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
      let res;
      try { res = hasExt ? await chrome.runtime.sendMessage({ type: 'capture-for-export' }) : { error: 'not running as an extension' }; }
      finally {
        document.body.classList.remove('render');
        // one more frame so the restored layout is painted behind the veil before it lifts
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        veil.classList.remove('show');
      }
      if (!res || res.error) throw new Error((res && res.error) || 'capture failed');
      const dpr = window.devicePixelRatio || 1;
      // Measure the stage rather than the image: with the screenshot-canvas on, the
      // export is image + padding, and the frame is part of the deliverable.
      const box = stage.getBoundingClientRect();
      const wantW = Math.round(box.width * dpr), wantH = Math.round(box.height * dpr);
      const availW = Math.round(document.documentElement.clientWidth * dpr), availH = Math.round(document.documentElement.clientHeight * dpr);
      if (wantW > availW || wantH > availH) {
        toast(`Browser window is smaller than the export (${Math.round(box.width)}×${Math.round(box.height)}px) — the image gets cropped. Enlarge the window, then export again for the full frame.`, 5000);
      }
      return cropDataUrl(res.dataUrl, 0, 0, Math.min(wantW, availW), Math.min(wantH, availH));
    }

    function fileSlug() {
      const capture = getCapture();
      const t = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const host = (() => { try { return new URL(capture.url).host.replace(/[^a-z0-9]+/gi, '-'); } catch (e) { return 'capture'; } })();
      return `snap-${host}-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`;
    }

    $('#downloadPng').addEventListener('click', async () => {
      if (!getCapture()) return toast('Nothing to export yet.');
      try {
        const dataUrl = await renderToPngDataUrl();
        const a = document.createElement('a'); a.href = dataUrl; a.download = fileSlug() + '.png'; a.click();
        toast('PNG exported.');
      } catch (e) { toast('Export failed: ' + e.message); }
    });

    // One copy in flight at a time. renderToPngDataUrl() strips the editor chrome
    // off <body> for the compositor screenshot and restores it in a finally; two
    // overlapping runs race on that class and the loser's screenshot catches the
    // toolbar. Easy to hit now that a held Ctrl+C can fire this.
    let copying = false;
    async function copyImage() {
      if (!getCapture()) return toast('Nothing to copy yet.');
      if (copying) return;
      copying = true;
      try {
        const dataUrl = await renderToPngDataUrl();
        const blob = dataUrlToBlob(dataUrl);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('Image copied to the clipboard — paste it straight into the ticket.');
      } catch (e) { toast('Copy failed: ' + e.message); }
      finally { copying = false; }
    }
    $('#copyImg').addEventListener('click', copyImage);

    // Ctrl/⌘+C copies the annotated shot. Stands down whenever the keystroke
    // plausibly belongs to something else: a focused text field, or a live text
    // selection. Swallowing Ctrl+C while someone is selecting the CSS in the
    // Components tab would be a real bug, and it costs one check to avoid.
    document.addEventListener('keydown', (e) => {
      if (e.repeat || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey || e.key.toLowerCase() !== 'c') return;   // Ctrl+Shift+C is DevTools', un-preventable from here
      if (getView() !== 'snap' || isTyping()) return;
      if (String(window.getSelection() || '').trim()) return;
      e.preventDefault();
      copyImage();
    });

    // The `paste` event, not a Ctrl+V keydown: it is the only path that hands us
    // the clipboard's image bits without the clipboardRead permission, and it
    // covers right-click → Paste and ⌘V on macOS for free.
    function readAsDataUrl(file) {
      return new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
      });
    }

    /** First image on an empty stage becomes the capture — it has to, something must set
     *  the export frame. Every image after that is ADDED as a layer, not swapped in:
     *  a paste that silently threw away the shot and its annotations was one keystroke
     *  away from destroying work, and stacking two shots in one frame (before/after,
     *  a zoomed detail beside the whole page) is the thing people actually wanted. */
    async function pasteImageFile(file) {
      const dataUrl = await readAsDataUrl(file);
      const capture = getCapture();
      if (!capture) {
        await loadCapture({ id: 'paste_' + Math.random().toString(36).slice(2, 8), dataUrl, url: '', rect: null, note: 'Pasted the image from the clipboard.' });
        return;
      }
      const img = await loadImage(dataUrl);
      const el = window.SnapKit.components.image.newImageElement(capture, dataUrl, img.naturalWidth, img.naturalHeight);
      // images live at the front of els = the bottom of the paint order, so a new one
      // never buries callouts and arrows that are already placed
      const last = capture.els.map((x) => x.type).lastIndexOf('image');
      capture.els.splice(last + 1, 0, el);
      select(el.id);
      toast(`Pasted as a new image layer (${img.naturalWidth}×${img.naturalHeight}).`);
    }

    document.addEventListener('paste', (e) => {
      if (isTyping()) return;                       // pasting CSS into the Components tab must still work
      const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
      const files = items
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (!files.length) return;                    // plain text on the clipboard — not ours to swallow
      e.preventDefault();
      setView('snap');                              // pasting is a Snap action even from the Components tab
      // Sequential, not Promise.all: a multi-file copy out of Explorer should stack in
      // the order it was copied, and the cascade offset counts layers as it goes.
      (async () => {
        for (const f of files) {
          try { await pasteImageFile(f); }
          catch (err) { toast('Could not read the image on the clipboard.'); break; }
        }
      })();
    });
  }

  window.SnapKit.export = { init };
})();
