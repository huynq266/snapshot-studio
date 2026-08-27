/* ACCENT — re-tone the whole kit from one hex.

   Every component and every piece of editor chrome reads --color-primary-*
   (via the --accent* aliases in tokens.css EXTRAS) rather than a literal hex,
   so overriding just the primary ramp on :root re-tones the entire app with
   no re-render: CSS custom properties are late-bound, so elements already
   sitting on the canvas pick up the change the instant the stylesheet does.

   #accentVars is an empty <style> tag placed right after the tokens.css
   <link> in editor.html specifically so it always wins that cascade, however
   tokens.css itself gets re-vendored later — same trick #labCss uses to sit
   after editor.css. The popup does the same thing with the same ramp; the
   maths and the stored hex both live in accent-ramp.js so the two agree.

   This file is the picker UI on top of that: swatches, custom colour input,
   reset, and the debounce in front of storage. */
(() => {
  window.SnapKit = window.SnapKit || {};
  const $ = (s) => document.querySelector(s);
  const accent = window.SnapKit.accent;

  const accentVarsEl = $('#accentVars'), accentPicker = $('#accentPicker');
  const accentHexLabel = $('#accentHexLabel'), accentReset = $('#accentReset');
  const accentCustomInput = $('#accentCustomInput'), accentCustomSwatch = $('#accentCustomSwatch');

  function applyAccent(hex) {
    accentVarsEl.textContent = accent.css(hex);
    const active = (hex || accent.DEFAULT_500).toUpperCase();
    accentHexLabel.textContent = active;
    const isPreset = !!hex && accent.PRESETS.some((p) => p.toUpperCase() === active);
    accentPicker.querySelectorAll('.swatch[data-hex]').forEach((b) => b.classList.toggle('on', isPreset && b.dataset.hex.toUpperCase() === active));
    accentCustomSwatch.classList.toggle('on', !!hex && !isPreset);
    accentCustomInput.value = hex && !isPreset ? hex : accent.DEFAULT_500;
    accentReset.disabled = !hex;
  }
  let accentSaveTimer = null;
  function persistAccent(hex) {
    clearTimeout(accentSaveTimer);
    accentSaveTimer = setTimeout(() => accent.save(hex), 200);
  }
  const pickAccent = (hex) => { applyAccent(hex); persistAccent(hex); };
  accentPicker.querySelectorAll('.swatch[data-hex]').forEach((b) => b.addEventListener('click', () => pickAccent(b.dataset.hex)));
  accentCustomInput.addEventListener('input', () => pickAccent(accentCustomInput.value));
  accentReset.addEventListener('click', () => pickAccent(null));
  accent.load().then(applyAccent);
})();
