/* ACCENT RAMP — the one place a picked accent hex turns into a primary ramp.

   Two documents need this: editor.html (accent.js, which owns the picker UI)
   and the toolbar popup, which has no picker but must not sit at the kit's
   default blue while the rest of the app is re-toned. They share the stored
   hex, the tint/shade fractions and the generated :root text from here, so a
   second hand-maintained copy of the ramp can't quietly go stale — the same
   reason tokens.css EXTRAS is the only place the app-shell aliases resolve.

   Load this before accent.js / popup.js; it only defines window.SnapKit.accent. */
(() => {
  window.SnapKit = window.SnapKit || {};
  const hasExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;

  /* Mirrors --color-primary-500 in tokens.css's foundations layer: the value the
     ramp falls back to when nothing is picked, i.e. "no override at all". */
  const DEFAULT_500 = '#1350DE';
  const PRESETS = ['#7C2CFB', '#6AE5FF', '#390376', '#06063F', '#282828'];
  const KEY = 'snapstudio.accentColor';

  const hexToRgbArr = (hex) => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgbArrToHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mixHex = (hex, target, amount) => {
    const a = hexToRgbArr(hex), b = hexToRgbArr(target);
    return rgbArrToHex(a.map((c, i) => c + (b[i] - c) * amount));
  };
  /* Tint/shade fractions reverse-engineered off the kit's own #1350de ramp in
   * foundations.css (50 through 900): mixing an arbitrary base hex toward white/black
   * by these exact amounts reproduces that reference ramp closely — exact at 500 and 800,
   * within a couple of units at the shades, and no worse than ~12/255 at the widest tint
   * (300) — so a hand-picked accent gets the same "shape" of scale the kit ships with,
   * not just a single overridden dot. */
  const TINT = { 50: .94, 100: .87, 200: .72, 300: .54, 400: .28 };
  const SHADE = { 600: .16, 700: .34, 800: .52, 900: .70 };

  function ramp(hex500) {
    const out = { 500: hex500 };
    Object.entries(TINT).forEach(([k, amt]) => { out[k] = mixHex(hex500, '#ffffff', amt); });
    Object.entries(SHADE).forEach(([k, amt]) => { out[k] = mixHex(hex500, '#000000', amt); });
    const rgb = (hex) => hexToRgbArr(hex).join(', ');
    out['500-rgb'] = rgb(hex500);
    out['400-rgb'] = rgb(out[400]);
    out['700-rgb'] = rgb(out[700]);
    return out;
  }

  /* The stylesheet text for an <style> tag sitting after tokens.css. Empty string
     for a null hex — no override, the kit's own :root wins again. */
  const css = (hex) => hex
    ? ':root {\n' + Object.entries(ramp(hex)).map(([k, v]) => `  --color-primary-${k}: ${v};`).join('\n') + '\n}'
    : '';

  async function load() {
    if (hasExt) { try { return (await chrome.storage.local.get('accentColor')).accentColor || null; } catch (e) { return null; } }
    try { return localStorage.getItem(KEY) || null; } catch (e) { return null; }
  }
  function save(hex) {
    if (hasExt) chrome.storage.local.set({ accentColor: hex || null }).catch(() => {});
    else { try { hex ? localStorage.setItem(KEY, hex) : localStorage.removeItem(KEY); } catch (e) {} }
  }
  /* Fires when the accent is changed in another document — an editor tab re-toning
     the kit while the popup happens to be open, most obviously. */
  function onChange(fn) {
    if (hasExt) {
      if (!chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.accentColor) fn(changes.accentColor.newValue || null);
      });
    } else {
      window.addEventListener('storage', (e) => { if (e.key === KEY) fn(e.newValue || null); });
    }
  }

  window.SnapKit.accent = { DEFAULT_500, PRESETS, KEY, ramp, css, load, save, onChange };
})();
