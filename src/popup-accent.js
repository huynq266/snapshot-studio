/* Paint the popup with the accent the editor's picker last stored.

   Separate file rather than an inline <script> in popup.html: MV3's default
   extension-page CSP is script-src 'self', so an inline block silently never runs.

   Loaded from the head, not the end of body: the stored hex arrives asynchronously
   and the popup paints the moment it can, so starting the read during head parsing
   is the difference between opening on the right accent and opening kit-blue, then
   flipping. #accentVars is declared just above the tag that loads this. */
(() => {
  const accent = window.SnapKit.accent;
  const el = document.getElementById('accentVars');
  const paint = (hex) => { el.textContent = accent.css(hex); };
  accent.load().then(paint);
  accent.onChange(paint);   // an editor tab re-toning while the popup is open
})();
