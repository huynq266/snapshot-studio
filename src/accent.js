/* ACCENT — re-tone the whole kit from one hex.

   Every component and every piece of editor chrome reads --color-primary-*
   (via the --accent* aliases in tokens.css EXTRAS) rather than a literal hex,
   so overriding just the primary ramp on :root re-tones the entire app with
   no re-render: CSS custom properties are late-bound, so elements already
   sitting on the canvas pick up the change the instant the stylesheet does.

   #accentVars is an empty <style> tag placed right after the tokens.css
   <link> in editor.html specifically so it always wins that cascade, however
   tokens.css itself gets re-vendored later — same trick #labCss uses to sit
   after editor.css. */
(() => {
  window.SnapKit = window.SnapKit || {};
  const hasExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  const $ = (s) => document.querySelector(s);

  const ACCENT_KEY = 'snapstudio.accentColor';
  const ACCENT_PRESETS = ['#7C2CFB', '#6AE5FF', '#390376', '#06063F', '#282828'];
  const KIT_DEFAULT_PRIMARY_500 = '#1350DE';
  const accentVarsEl = $('#accentVars'), accentPicker = $('#accentPicker');
  const accentHexLabel = $('#accentHexLabel'), accentReset = $('#accentReset');
  const accentCustomInput = $('#accentCustomInput'), accentCustomSwatch = $('#accentCustomSwatch');

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
   * by these exact amounts reproduces that reference ramp to within a few RGB units at
   * every step, so a hand-picked accent gets the same "shape" of scale the kit ships
   * with, not just a single overridden dot. */
  const ACCENT_TINT = { 50: .94, 100: .87, 200: .72, 300: .54, 400: .28 };
  const ACCENT_SHADE = { 600: .16, 700: .34, 800: .52, 900: .70 };
  function accentRamp(hex500) {
    const ramp = { 500: hex500 };
    Object.entries(ACCENT_TINT).forEach(([k, amt]) => { ramp[k] = mixHex(hex500, '#ffffff', amt); });
    Object.entries(ACCENT_SHADE).forEach(([k, amt]) => { ramp[k] = mixHex(hex500, '#000000', amt); });
    const rgb = (hex) => hexToRgbArr(hex).join(', ');
    ramp['500-rgb'] = rgb(hex500);
    ramp['400-rgb'] = rgb(ramp[400]);
    ramp['700-rgb'] = rgb(ramp[700]);
    return ramp;
  }

  function applyAccent(hex) {
    accentVarsEl.textContent = hex
      ? ':root {\n' + Object.entries(accentRamp(hex)).map(([k, v]) => `  --color-primary-${k}: ${v};`).join('\n') + '\n}'
      : '';
    const active = (hex || KIT_DEFAULT_PRIMARY_500).toUpperCase();
    accentHexLabel.textContent = active;
    const isPreset = !!hex && ACCENT_PRESETS.some((p) => p.toUpperCase() === active);
    accentPicker.querySelectorAll('.swatch[data-hex]').forEach((b) => b.classList.toggle('on', isPreset && b.dataset.hex.toUpperCase() === active));
    accentCustomSwatch.classList.toggle('on', !!hex && !isPreset);
    accentCustomInput.value = hex && !isPreset ? hex : KIT_DEFAULT_PRIMARY_500;
    accentReset.disabled = !hex;
  }
  let accentSaveTimer = null;
  function persistAccent(hex) {
    clearTimeout(accentSaveTimer);
    accentSaveTimer = setTimeout(() => {
      if (hasExt) chrome.storage.local.set({ accentColor: hex || null }).catch(() => {});
      else { try { hex ? localStorage.setItem(ACCENT_KEY, hex) : localStorage.removeItem(ACCENT_KEY); } catch (e) {} }
    }, 200);
  }
  async function loadAccent() {
    let hex = null;
    if (hasExt) { try { const r = await chrome.storage.local.get('accentColor'); hex = r.accentColor || null; } catch (e) {} }
    else { try { hex = localStorage.getItem(ACCENT_KEY) || null; } catch (e) {} }
    applyAccent(hex);
  }
  const pickAccent = (hex) => { applyAccent(hex); persistAccent(hex); };
  accentPicker.querySelectorAll('.swatch[data-hex]').forEach((b) => b.addEventListener('click', () => pickAccent(b.dataset.hex)));
  accentCustomInput.addEventListener('input', () => pickAccent(accentCustomInput.value));
  accentReset.addEventListener('click', () => pickAccent(null));
  loadAccent();
})();
