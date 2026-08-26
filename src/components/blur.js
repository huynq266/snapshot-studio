/* Privacy Blur — .cmp-privacy-blur. Redacts sensitive data before a
   screenshot is published — now via true pixelation/mosaic of the underlying
   pixels (Monosnap-style), not a backdrop-filter blur. See kit-catalog.js's
   "privacy-blur" entry for the kit's own spec/gotchas, and the DEVIATION note
   above .cmp-privacy-blur in tokens.css for why this no longer matches the
   vendored spec's "Gaussian blur" description at all — this is a fork, not
   the upstream component, on direct instruction. No demo controls here, same
   as upstream (no variants on this component). */
(() => {
  window.SnapKit = window.SnapKit || {};
  window.SnapKit.components = window.SnapKit.components || {};

  // Mosaic cell size, in source-screenshot px. Chunky enough to read as
  // deliberate pixelation rather than a compression artifact; small enough
  // that a whole-field-row box (180x32, this component's own default below)
  // still gets several cells across each axis.
  const BLOCK = 12;

  /** Two-pass resample, not one: shrink the source region down to one pixel
   *  per mosaic cell first (the browser's own image smoothing averages every
   *  cell's source pixels into that one output pixel), THEN blow that back up
   *  to full size with smoothing switched off — nearest-neighbour repeats
   *  each averaged pixel into a solid square. Skipping the shrink step and
   *  just drawing straight to a low-res canvas at full size would alias
   *  instead of average, which reads as noisy rather than as flat tiles.
   *  Returns a data URL (not a live canvas) so it drops straight into
   *  inner()'s string-based background-image — same trick zoom-magnify's own
   *  content() uses for its screenshot crop, just resampled instead of 1:1. */
  function mosaicDataUrl(imgEl, sx, sy, sw, sh) {
    sw = Math.max(1, Math.round(sw)); sh = Math.max(1, Math.round(sh));
    const smallW = Math.max(1, Math.round(sw / BLOCK)), smallH = Math.max(1, Math.round(sh / BLOCK));
    const small = document.createElement('canvas');
    small.width = smallW; small.height = smallH;
    small.getContext('2d').drawImage(imgEl, sx, sy, sw, sh, 0, 0, smallW, smallH);
    const full = document.createElement('canvas');
    full.width = sw; full.height = sh;
    const fctx = full.getContext('2d');
    fctx.imageSmoothingEnabled = false;
    fctx.drawImage(small, 0, 0, smallW, smallH, 0, 0, sw, sh);
    return full.toDataURL('image/png');
  }

  /** Crops against the real screenshot the box is sitting over — same
   *  backdrop-only scope zoom-magnify's own content() has, so a pasted image
   *  layer or another annotation stacked under the box is NOT picked up, only
   *  capture.img. Clamped into the image bounds so a box dragged near an edge
   *  or corner still samples real pixels instead of running off the source
   *  (same clamp idea as zoom-magnify's bx/by). Falls back to a flat
   *  neutral-300 patch if the source image isn't decoded yet — capture.img.el
   *  is always a fully-loaded Image by construction (see editor.js's
   *  loadCapture()/library.js's restoreFromLibrary()), so this is a guard
   *  against a missing capture, not a real race. */
  function content(el, capture) {
    const img = capture && capture.img;
    if (!img || !img.el) return 'background:var(--color-neutral-300)';
    const iw = img.w, ih = img.h;
    const sw = Math.min(el.w, iw), sh = Math.min(el.h, ih);
    const sx = Math.max(0, Math.min(el.x, iw - sw));
    const sy = Math.max(0, Math.min(el.y, ih - sh));
    const url = mosaicDataUrl(img.el, sx, sy, sw, sh);
    return `background-image:url(${url});background-size:100% 100%`;
  }

  window.SnapKit.components.blur = {
    type: 'blur',
    catalogId: 'privacy-blur',
    glyph: '▒',
    addable: true,
    isBox: true,

    defaults(c) {
      // 180x32 is a whole field row on purpose — see propsHtml's note below for why.
      return { x: c.x - 90, y: c.y - 16, w: 180, h: 32 };
    },

    inner(el, ctx) {
      return `<div class="cmp-privacy-blur" style="inset:0;${content(el, ctx.capture)}"></div>`;
    },

    style(el) {
      return `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
    },

    propsHtml(el, ctx) {
      return ctx.note("Cover the whole data-field row, not just the text's cap height: the mosaic resamples straight from the screenshot underneath, and a box cropped tight to the text still leaks its shape as a handful of blocks. Drag the bottom-right corner to resize — the mosaic redraws live as you drag.");
    },

    bindProps() {},

    demo: {},

    labSpecimen(v, ctx) {
      const capture = ctx.capture;
      const region = capture ? { x: Math.max(0, Math.round(capture.img.w / 2) - 150), y: Math.max(0, Math.round(capture.img.h / 2) - 20), w: 300, h: 40 } : null;
      const inner = region ? content(region, capture) : 'background:var(--color-neutral-300)';
      return `<div style="position:relative;width:300px;height:40px"><div class="cmp-privacy-blur" style="inset:0;${inner}"></div></div>`;
    },
  };
})();
