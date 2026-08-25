/* =====================================================================
   COMPONENT LAB — the "Components" tab.

   Two jobs, one view: look at the kit, and author something new.

   Previews sit on a real ground (.lab-ground--light / --dark, this editor's own,
   built from kit tokens) with a mock page under them, because backdrop-filter has
   nothing to bend on a flat fill — a glass component previewed over an empty
   stage renders as a grey card and lies to you about how it will look on a
   screenshot. Light AND dark are both one click away for the same reason the
   roadmap makes it a merge gate: .on-dark is explicit, never inferred, so the
   only way to know a component works on dark UI is to look at it there.

   Components authored here are real: their CSS goes into <style id="labCss">
   in editor.html, so they render on the stage and survive the body.render
   export screenshot exactly like the kit components (see components/custom.js
   for how an instance of one renders on the canvas). They live in
   chrome.storage for this browser profile only — "Copy CSS" is the door out,
   into src/tokens.css. Note that pasting there FORKS this repo's vendored
   copy of the design kit rather than syncing it; see
   .claude/skills/editorial-glass/SKILL.md, "Adding a component".

   Wired up once editor.js has built its own state/DOM refs — see init() below
   and the call to it at the bottom of editor.js. customDef() is the one piece
   other files need before that (editor.js's newElement(), components/custom.js's
   ctx) — it's safe to call any time, `customs` just starts out empty until
   loadCustoms() resolves. */
(() => {
  window.SnapKit = window.SnapKit || {};
  const $ = (s) => document.querySelector(s);
  const hasExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  const escapeHtml = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const rowText = (id, label, val, rows) => `<div class="prop-row"><label>${label}</label><textarea id="${id}" rows="${rows}">${escapeHtml(val || '')}</textarea></div>`;
  const rowInput = (id, label, val) => `<div class="prop-row"><label>${label}</label><input type="text" id="${id}" value="${escapeHtml(val || '')}"></div>`;
  const rowCheck = (id, label, on) => `<div class="prop-row"><label class="check-row"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label></div>`;
  const rowSeg = (id, label, items, cur) => `<div class="prop-row"><label>${label}</label><div class="seg" id="${id}">`
    + items.map(([v, t]) => `<button data-v="${v}" class="${cur === v ? 'on' : ''}">${t}</button>`).join('') + '</div></div>';

  const CUSTOM_KEY = 'snapstudio.customComponents';
  const labCssEl = $('#labCss'), labStage = $('#labStage'), labGround = $('#labGround'), labShot = $('#labShot');
  const labMock = $('#labMock'), labSpecimenEl = $('#labSpecimen'), labTitle = $('#labTitle'), labProps = $('#labProps');
  const kitList = $('#kitList'), customList = $('#customList'), customPalette = $('#customPalette');
  const mockToggle = $('#mockToggle'), groundNote = $('#groundNote');

  let customs = [];
  const customDef = (id) => customs.find((c) => c.id === id) || null;

  let ground = 'light';
  let labSel = { kind: 'kit', id: 'text-box' };
  // Preview-only, mirrors the original demo.customDark: not persisted, just what the
  // custom-component specimen is showing right now, reset whenever the selection changes.
  let customDark = false;

  /** The rail's kit list, in catalog order, joined to the per-component registrations'
   *  own UI facts (components/*.js). Nothing is retyped from the catalog here — name,
   *  summary, use_when and variants are all read straight off the vendored
   *  mirror, so the Components tab documents whatever the kit actually says today. */
  const CAT = (window.KIT_CATALOG && window.KIT_CATALOG.components) || [];
  const compByCatalogId = (id) => Object.values(window.SnapKit.components || {}).find((c) => c.catalogId === id) || null;
  const KIT = CAT.map((c) => {
    const comp = compByCatalogId(c.id);
    return { ...c, ui: { type: comp ? comp.type : null, glyph: comp ? comp.glyph : '•', addable: !!(comp && comp.addable) } };
  });

  /* ---- "new component" prompt -------------------------------------------
     No in-browser template picker or blank-CSS starting point any more — the
     only way to author a new component is to hand this prompt to the user's
     own Claude (any surface: claude.ai, Claude Code, the app) along with a
     description of what they want, then upload whatever .md Claude hands
     back (see parseComponentMd() below for the exact contract this prompt
     commits to). The token vocabulary below is transcribed from tokens.css
     by hand — keep it in sync if that file's EXTRAS-adjacent scales change. */
  const COMPONENT_PROMPT = [
    "You're creating a new annotation component for Snap Studio — a screenshot",
    'capture & annotation tool whose entire look comes from one shared set of',
    'CSS custom-property design tokens. Read the rules and token list below',
    'carefully, then reply EXACTLY in the format at the end — no preamble, no',
    'explanation, because your answer gets saved as-is into a .md file and',
    'uploaded straight into Snap Studio.',
    '',
    '## Component I want',
    '',
    '- Purpose (what it points out / conveys):',
    '- Appearance (shape, layout, any icon or accent — as detailed as you can):',
    '- Text (does it show any, and what should it say by default):',
    '- Sizing (hugs its content, or a fixed box the user can resize):',
    '- Needs a different look on a dark background:',
    '',
    '## Required rules',
    '',
    '1. EVERY colour, spacing, radius, shadow, font size, font weight and font',
    '   must come from the tokens below — never a hardcoded value, unless it',
    "   genuinely doesn't match any step in the scales below (e.g. a",
    "   component's own one-off min-width/max-width is fine).",
    '2. Colour: only var(--color-*) or rgba(var(--color-*-rgb), alpha) — never',
    "   a hardcoded hex or rgb(). Pure #fff and #000 are exempt since they don't",
    '   hide a brand colour.',
    '3. Never rotateX/Y/Z, translateZ, translate3d, perspective, or matrix3d —',
    '   near a backdrop-filter, Chrome silently drops the glass effect with no',
    '   error.',
    '4. Any backdrop-filter must ship with a matching -webkit-backdrop-filter.',
    "5. Don't write the .cmp-x-... selector or the outer { } — just the",
    "   declaration lines; Snap Studio wraps them in its own class on import.",
    '6. If the component needs to look different on a dark background, add a',
    '   "## CSS (on-dark)" block — only what actually changes from the',
    '   default, not the whole CSS again.',
    '',
    '## Available tokens',
    '',
    'Neutral colour: --color-neutral-0 (white) 50 100 200 300 400 500 600 700',
    '  800 900 (near-black). -rgb variants (for rgba()) exist for:',
    '  --color-neutral-0-rgb, --color-neutral-300-rgb, --color-neutral-900-rgb.',
    'Brand colour: --color-primary-50...900 (500 is the base). -rgb variants',
    '  exist for: --color-primary-400-rgb, --color-primary-500-rgb,',
    '  --color-primary-700-rgb.',
    'Semantic colour (keeps its meaning across any rebrand — never use it for',
    '  plain decoration): --color-success-50/500/600/700,',
    '  --color-warning-50/500/600/700, --color-error-50/500/600/700,',
    '  --color-info-50/500/600/700.',
    'Type: --font-sans (body text), --mono (monospace).',
    '  Weight: --weight-regular(400) --weight-medium(500) --weight-semibold(600)',
    '  --weight-bold(700).',
    '  Size: --text-xs(12px) --text-sm(13px) --text-base(14px) --text-md(16px)',
    '  --text-lg(18px) --text-xl(20px) --text-2xl(24px) --text-3xl(30px).',
    'Spacing (padding/margin/gap): --space-0(0) --space-1(4px) --space-2(8px)',
    '  --space-3(12px) --space-4(16px) --space-5(20px) --space-6(24px)',
    '  --space-8(32px) --space-10(40px) --space-12(48px) --space-16(64px)',
    '  --space-20(80px) --space-24(96px).',
    'Radius: --radius-none(0) --radius-sm(4px) --radius-md(6px) --radius-lg(8px)',
    '  --radius-xl(12px) --radius-2xl(16px) --radius-full(9999px — for pill',
    '  shapes) --radius-zoom(22px).',
    'Shadow: --shadow-xs, --shadow-sm, --shadow-md, --shadow-lg, --shadow-xl.',
    '',
    '## Reply format (required, nothing else)',
    '',
    '---',
    'name: <component name, short>',
    'sizing: auto or box',
    'width: <px — only needed when sizing is box>',
    'height: <px — only needed when sizing is box>',
    'text: <sample text for preview, leave blank if it has no text>',
    '---',
    '',
    '## CSS',
    '',
    '```css',
    '<main CSS declarations>',
    '```',
    '',
    '## CSS (on-dark)',
    '',
    '```css',
    "<only what changes on a dark background — drop this whole block if it's not needed>",
    '```',
  ].join('\n');

  /** Reads the .md a user's own Claude session produced from COMPONENT_PROMPT above.
   *  Forgiving on purpose: strips an outer ```markdown fence if Claude added one, finds
   *  the frontmatter block anywhere (not just at position 0), and reads CSS by POSITION
   *  — first ```css fence is the light CSS, a second one (if any) is the on-dark CSS —
   *  rather than depending on the heading text above each fence matching exactly. */
  function parseComponentMd(raw) {
    let md = (raw || '').trim();
    const outerFence = md.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
    if (outerFence) md = outerFence[1].trim();

    const fm = md.match(/---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
    if (!fm) throw new Error('No frontmatter block (--- ... ---) in the file.');
    const fields = {};
    fm[1].split(/\r?\n/).forEach((line) => {
      const m = line.match(/^([a-zA-Z]+)\s*:\s*(.*)$/);
      if (m) fields[m[1].trim().toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
    });

    const blocks = [...md.slice(fm.index + fm[0].length).matchAll(/```css\b[^\n]*\r?\n([\s\S]*?)```/g)]
      .map((m) => m[1].replace(/\s+$/, ''));
    if (!blocks.length) throw new Error('No ```css block in the file.');

    return {
      name: (fields.name || 'New component').slice(0, 60),
      sizing: fields.sizing === 'box' ? 'box' : 'auto',
      w: Math.max(20, parseInt(fields.width, 10) || 200),
      h: Math.max(20, parseInt(fields.height, 10) || 110),
      text: fields.text || '',
      css: blocks[0],
      darkCss: blocks[1] || '',
    };
  }

  // ---- storage ---------------------------------------------------------
  function slugify(name) {
    const s = (name || '').toLowerCase().replace(/[đ]/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s || 'component';
  }
  function uniqueSlug(base, skipId) {
    let s = base, n = 2;
    while (customs.some((c) => c.slug === s && c.id !== skipId)) s = base + '-' + n++;
    return s;
  }
  function buildCustomCss() {
    return customs.map((c) => {
      let out = `/* ${c.name} */\n.cmp-x-${c.slug} {\n${c.css.replace(/\s+$/, '')}\n}`;
      if (c.darkCss.trim()) out += `\n.cmp-x-${c.slug}.on-dark {\n${c.darkCss.replace(/\s+$/, '')}\n}`;
      return out;
    }).join('\n\n');
  }
  function applyCustomCss() { labCssEl.textContent = buildCustomCss(); }

  // px→token scales, mirrored from tokens.css. lintCss runs on every keystroke in the Lab
  // CSS box, so these live as plain lookups rather than being parsed back out of the
  // stylesheet itself.
  const LINT_SPACE_PX = { 4: '--space-1', 8: '--space-2', 12: '--space-3', 16: '--space-4', 20: '--space-5',
    24: '--space-6', 32: '--space-8', 40: '--space-10', 48: '--space-12', 64: '--space-16', 80: '--space-20', 96: '--space-24' };
  const LINT_RADIUS_PX = { 4: '--radius-sm', 6: '--radius-md', 8: '--radius-lg', 12: '--radius-xl', 16: '--radius-2xl', 22: '--radius-zoom' };
  const LINT_TEXT_PX = { 12: '--text-xs', 13: '--text-sm', 14: '--text-base', 16: '--text-md', 18: '--text-lg', 20: '--text-xl', 24: '--text-2xl', 30: '--text-3xl' };
  const LINT_WEIGHT = { 400: '--weight-regular', 500: '--weight-medium', 600: '--weight-semibold', 700: '--weight-bold' };

  /** Pulls `prop: value;` pairs out of a (possibly multi-rule) CSS block, comments stripped.
      Not a real parser — good enough for the small, flat rules the Lab CSS box holds. */
  function lintDecls(css) {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    const re = /([a-zA-Z-]+)\s*:\s*([^;{}]+);/g;
    let m;
    while ((m = re.exec(stripped))) out.push([m[1].trim().toLowerCase(), m[2].trim()]);
    return out;
  }

  /** House rules a CSS box can actually enforce, plus what it can only warn about — see the
      "No hardcoded values in CSS" rule in CLAUDE.md. The scale checks below only fire when a
      literal exactly matches a step in tokens.css's own scale; a number that matches nothing
      is a legitimate one-off layout value and is intentionally left alone. */
  function lintCss(css) {
    const out = [];
    if (/\b(rotate[XYZ]|rotate3d|translateZ|translate3d|perspective|matrix3d)\s*\(/i.test(css)) {
      out.push({ lvl: 'bad', msg: 'A 3D transform makes Chrome silently drop backdrop-filter — the glass turns into a flat card, with no error anywhere. Remove rotateX/Y/Z, translateZ, perspective.' });
    }

    const hex = [...new Set((css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((h) => !/^#(fff|ffffff|000|000000)$/i.test(h)))];
    if (hex.length) {
      out.push({ lvl: 'warn', msg: `Hardcoded hex colour: ${hex.join(', ')}. Use var(--color-*) / var(--accent*) or rgba(var(--color-*-rgb), α) so the next rebrand does not miss this spot.` });
    }
    const rgbLiteral = [...new Set((css.match(/rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/g) || []))]
      .filter((s) => !/\((255,255,255|0,0,0)$/.test(s.replace(/\s+/g, '')));
    if (rgbLiteral.length) {
      out.push({ lvl: 'warn', msg: `rgb()/rgba() with raw numbers instead of a token: ${rgbLiteral.join(', ')}… Same problem as the hex colours above, only written differently — use rgba(var(--color-*-rgb), α) or rgba(var(--accent-rgb), α).` });
    }

    if (/[^-]backdrop-filter/.test('\n' + css) && !/-webkit-backdrop-filter/.test(css)) {
      out.push({ lvl: 'warn', msg: 'backdrop-filter is here but the -webkit-backdrop-filter alongside it is missing.' });
    }

    const spaceHits = new Map(), radiusHits = new Map(), textHits = new Map(), weightHits = new Set();
    let fontFamilyLiteral = false;
    for (const [prop, value] of lintDecls(css)) {
      if (/var\(/.test(value)) continue; // already tokenised (even if only partly) — nothing to flag
      if (/^(padding|margin|gap|row-gap|column-gap)(-\w+)?$/.test(prop)) {
        for (const m of value.matchAll(/(\d+(?:\.\d+)?)px/g)) {
          const t = LINT_SPACE_PX[Number(m[1])];
          if (t) spaceHits.set(Number(m[1]), t);
        }
      } else if (prop === 'border-radius') {
        for (const m of value.matchAll(/(\d+(?:\.\d+)?)px/g)) {
          const t = LINT_RADIUS_PX[Number(m[1])];
          if (t) radiusHits.set(Number(m[1]), t);
        }
      } else if (prop === 'font-size') {
        const m = value.match(/^(\d+(?:\.\d+)?)px$/);
        const t = m && LINT_TEXT_PX[Number(m[1])];
        if (t) textHits.set(Number(m[1]), t);
      } else if (prop === 'font-weight') {
        const t = LINT_WEIGHT[Number(value)];
        if (t) weightHits.add(t);
      } else if (prop === 'font-family') {
        fontFamilyLiteral = true;
      }
    }
    if (spaceHits.size) {
      out.push({ lvl: 'warn', msg: `Hardcoded spacing matching an existing scale step: ${[...spaceHits].map(([n, t]) => `${n}px→var(${t})`).join(', ')}.` });
    }
    if (radiusHits.size) {
      out.push({ lvl: 'warn', msg: `Hardcoded radius matching an existing scale step: ${[...radiusHits].map(([n, t]) => `${n}px→var(${t})`).join(', ')}.` });
    }
    if (textHits.size) {
      out.push({ lvl: 'warn', msg: `Hardcoded font-size matching an existing scale step: ${[...textHits].map(([n, t]) => `${n}px→var(${t})`).join(', ')}.` });
    }
    if (weightHits.size) {
      out.push({ lvl: 'warn', msg: `Numeric font-weight matching an existing token: ${[...weightHits].join(', ')}.` });
    }
    if (fontFamilyLiteral) {
      out.push({ lvl: 'warn', msg: 'Hand-typed font-family instead of var(--font-sans) / var(--mono) — a later system-font change will not follow along.' });
    }
    return out;
  }

  function customSpecimen(def) {
    const dark = customDark && def.darkCss.trim() ? ' on-dark' : '';
    const box = def.sizing === 'box' ? `width:${def.w}px;height:${def.h}px` : '';
    return `<div class="cmp-x-${def.slug}${dark}" style="${box}">${escapeHtml(def.text || '')}</div>`;
  }

  function init(deps) {
    const { getCapture, getSelId, setSelId, render, renderLayers, getView, setView, newElement, toast } = deps;

    let saveTimer = null;
    function persistCustoms() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (hasExt) chrome.storage.local.set({ customComponents: customs }).catch(() => {});
        else { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(customs)); } catch (e) {} }
      }, 300);
    }
    async function loadCustoms() {
      let raw = [];
      if (hasExt) { try { const r = await chrome.storage.local.get('customComponents'); raw = r.customComponents || []; } catch (e) {} }
      else { try { raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); } catch (e) {} }
      customs = (Array.isArray(raw) ? raw : []).filter((c) => c && c.id && c.slug).map((c) => ({
        ...c, css: c.css || '', darkCss: c.darkCss || '', text: c.text || '',
        sizing: c.sizing === 'box' ? 'box' : 'auto', w: c.w || 200, h: c.h || 110,
      }));
      applyCustomCss(); renderCustomPalette();
      if (getView() === 'lab') renderLab();
    }

    async function createCustomFromMd(file) {
      let text;
      try { text = await file.text(); }
      catch (e) { toast('Could not read the file.'); return; }
      let parsed;
      try { parsed = parseComponentMd(text); }
      catch (e) { toast('That .md file is not in the expected format: ' + e.message, 5000); return; }
      const def = { id: 'c_' + Math.random().toString(36).slice(2, 8), name: parsed.name,
        slug: uniqueSlug(slugify(parsed.name)), sizing: parsed.sizing, w: parsed.w, h: parsed.h,
        text: parsed.text, css: parsed.css, darkCss: parsed.darkCss };
      customs.push(def);
      labSel = { kind: 'custom', id: def.id };
      customDark = false;
      applyCustomCss(); persistCustoms(); renderCustomPalette(); renderLab();
      toast(`Imported "${def.name}" from the .md file.`);
    }
    function deleteCustom(id) {
      const def = customDef(id); if (!def) return;
      const capture = getCapture();
      const used = capture ? capture.els.filter((e) => e.type === 'custom' && e.cid === id).length : 0;
      const msg = used ? `Delete "${def.name}"? ${used} instance(s) already on a shot will be removed too.` : `Delete "${def.name}"?`;
      if (!window.confirm(msg)) return;
      customs = customs.filter((c) => c.id !== id);
      if (capture) {
        capture.els = capture.els.filter((e) => !(e.type === 'custom' && e.cid === id));
        if (!capture.els.some((e) => e.id === getSelId())) setSelId(null);
        render();
      }
      labSel = { kind: 'kit', id: 'text-box' };
      applyCustomCss(); persistCustoms(); renderCustomPalette(); renderLab();
    }

    // ---- lab render --------------------------------------------------------
    function renderLab() { renderKitList(); renderCustomList(); renderGround(); renderSpecimen(); renderLabProps(); }

    function cmpRow(on, glyph, name, tag) {
      return `<div class="cmp-row${on ? ' on' : ''}"><span class="cglyph">${glyph}</span><span class="cname">${escapeHtml(name)}</span>${tag ? `<span class="ctag">${tag}</span>` : ''}</div>`;
    }
    function renderKitList() {
      $('#kitCount').textContent = KIT.length;
      kitList.innerHTML = KIT.map((k) => cmpRow(labSel.kind === 'kit' && labSel.id === k.id, k.ui.glyph, k.name,
        k.ui.addable ? '' : 'frame')).join('');
      [...kitList.children].forEach((row, i) => row.addEventListener('click', () => {
        labSel = { kind: 'kit', id: KIT[i].id }; renderLab();
      }));
    }
    function renderCustomList() {
      $('#customCount').textContent = customs.length || '';
      customList.innerHTML = customs.length
        ? customs.map((c) => cmpRow(labSel.kind === 'custom' && labSel.id === c.id, '✦', c.name)).join('')
        : '<p class="empty-hint" style="margin:0">No components of your own yet.</p>';
      if (!customs.length) return;
      [...customList.children].forEach((row, i) => row.addEventListener('click', () => {
        labSel = { kind: 'custom', id: customs[i].id }; customDark = false; renderLab();
      }));
    }
    function renderCustomPalette() {
      $('#customPalCount').textContent = customs.length || '';
      customPalette.innerHTML = customs.length
        ? customs.map((c) => `<button class="pal-btn" data-add="custom:${c.id}"><span class="ico">✦</span>${escapeHtml(c.name)}</button>`).join('')
        : '<p class="empty-hint" style="margin:0">None yet. Open the <b>Components</b> tab to make one.</p>';
    }
    function renderGround() {
      const capture = getCapture();
      const onShot = ground === 'shot' && !!capture;
      labShot.hidden = !onShot;
      if (onShot && labShot.src !== capture.img.dataUrl) labShot.src = capture.img.dataUrl;
      labGround.className = 'lab-ground lab-ground--' + (ground === 'dark' ? 'dark' : 'light');
      labGround.style.display = onShot ? 'none' : '';
      labStage.classList.toggle('on-dark', ground === 'dark');
      labMock.style.display = mockToggle.checked && !onShot ? '' : 'none';
      groundNote.textContent = ground === 'shot' && !capture
        ? 'No capture yet — go to the Snap tab and snap or upload an image first.'
        : (ground === 'dark' ? 'Every component has to be seen on both light and dark ground before it ships.' : '');
    }
    function renderSpecimen() {
      if (labSel.kind === 'new') {
        labSpecimenEl.innerHTML = '<p class="empty-hint" style="max-width:300px;text-align:center">Upload a .md file in the panel on the right — the preview shows up here.</p>';
        return;
      }
      if (labSel.kind === 'kit') {
        const comp = compByCatalogId(labSel.id);
        labSpecimenEl.innerHTML = comp && comp.labSpecimen ? comp.labSpecimen(comp.demo || {}, { escapeHtml, capture: getCapture() }) : '';
        return;
      }
      const def = customDef(labSel.id);
      labSpecimenEl.innerHTML = def ? customSpecimen(def) : '';
    }

    function renderLabProps() {
      if (labSel.kind === 'new') return renderNewComponentPanel();
      if (labSel.kind === 'kit') return renderKitProps();
      return renderCustomProps();
    }
    /** No in-browser template picker any more — the only way to author a new
     *  component is via the user's own Claude: copy COMPONENT_PROMPT, paste it into
     *  a Claude session with a description of what's wanted, then upload whatever
     *  .md comes back (parseComponentMd() above reads it). */
    function renderNewComponentPanel() {
      labTitle.textContent = 'New component';
      labProps.innerHTML = `<p class="lab-blurb">Built with your own Claude: copy the prompt below, paste it into Claude along with a description of the component you want — Claude answers in exactly the format Snap Studio reads. Save that answer as a <code>.md</code> file, then upload it here.</p>
        <button class="btn block" id="newCopyPrompt">⧉ Copy the prompt for Claude</button>
        <button class="btn primary block" id="newUploadMd">⇧ Upload a .md file</button>
        <p class="empty-hint">The .md file needs a <code>---</code> block at the top (name, size, sample text) and at least one <code>\`\`\`css</code> block — the prompt above already asks Claude for exactly that format.</p>`;
      $('#newCopyPrompt').addEventListener('click', () => copyText(COMPONENT_PROMPT, 'Prompt copied — paste it into your Claude.'));
      $('#newUploadMd').addEventListener('click', () => $('#mdInput').click());
    }

    /** Fresh per render, same convention as editor.js's renderProps(): field/flag/seg
     *  close over whichever demo-state object `v` they were built for. */
    function makeLabCtx(v) {
      const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };
      const field = (sel, key) => on(sel, 'input', (e) => { v[key] = e.target.value; renderSpecimen(); });
      const flag = (sel, key) => on(sel, 'change', (e) => { v[key] = e.target.checked; renderSpecimen(); });
      const seg = (sel, key, rerender) => {
        const box = $(sel); if (!box) return;
        box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
          v[key] = b.dataset.v;
          box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          renderSpecimen();
          if (rerender) renderLabProps();
        }));
      };
      return { $, on, field, flag, seg, escapeHtml, capture: getCapture(),
        rowText, rowInput, rowCheck, rowSeg, renderSpecimen, renderLabProps };
    }

    function renderKitProps() {
      const k = KIT.find((x) => x.id === labSel.id);
      if (!k) { labSel = { kind: 'kit', id: KIT[0].id }; return renderLab(); }
      labTitle.textContent = k.name;
      const comp = compByCatalogId(k.id);
      const v = (comp && comp.demo) || {};
      const ctx = makeLabCtx(v);

      let html = `<p class="lab-blurb">${escapeHtml(k.what)}</p>`;

      if (comp && comp.labPropsHtml) html += comp.labPropsHtml(v, ctx);

      html += k.ui.addable
        ? `<button class="btn primary block" id="kAdd">Add to the shot →</button>`
        : `<p class="empty-hint">Not an annotation you drop on the shot — this is the background + frame around the whole export. Switch it on and off with the <b>Image frame</b> toggle in the topbar.</p>`;

      // The kit's own words, not a paraphrase: use_when comes straight off
      // the vendored catalog, so this panel says whatever the kit says today.
      html += `<details class="kit-doc"><summary>When to use it</summary><p>${escapeHtml(k.use_when)}</p></details>`;
      labProps.innerHTML = html;

      $('#kAdd') && $('#kAdd').addEventListener('click', addFromLab);
      if (comp && comp.labBindProps) comp.labBindProps(v, ctx);
    }

    function drawLint(def) {
      const host = $('#cLint'); if (!host) return;
      host.innerHTML = lintCss(def.css + '\n' + def.darkCss)
        .map((l) => `<div class="lint ${l.lvl}"><b>${l.lvl === 'bad' ? '✕' : '!'}</b><span>${escapeHtml(l.msg)}</span></div>`).join('');
    }

    function renderCustomProps() {
      const def = customDef(labSel.id);
      if (!def) { labSel = { kind: 'kit', id: 'text-box' }; return renderLab(); }
      labTitle.textContent = def.name;
      const hasDark = !!def.darkCss.trim();
      labProps.innerHTML = `
        <div class="prop-row"><label>Name</label><input type="text" id="cName" value="${escapeHtml(def.name)}"></div>
        <div class="prop-row"><label>Size on the shot</label><div class="seg" id="cSizing">
          <button data-v="auto" class="${def.sizing === 'auto' ? 'on' : ''}">Hug content</button>
          <button data-v="box" class="${def.sizing === 'box' ? 'on' : ''}">Draggable box</button></div></div>
        ${def.sizing === 'box' ? `<div class="prop-row"><label>Default size (W × H)</label>
          <div style="display:flex;gap:8px"><input type="text" id="cW" value="${def.w}"><input type="text" id="cH" value="${def.h}"></div></div>` : ''}
        <div class="prop-row"><label>Sample content</label><input type="text" id="cText" value="${escapeHtml(def.text)}"></div>
        <div id="cLint"></div>
        <div class="prop-row"><label>CSS</label><textarea class="css-edit" id="cCss" spellcheck="false">${escapeHtml(def.css)}</textarea></div>
        <div class="prop-row"><label class="check-row"><input type="checkbox" id="cDarkOn" ${hasDark ? 'checked' : ''}> Has a Dark mode variant</label></div>
        ${hasDark ? `<div class="prop-row"><label>CSS on dark ground</label><textarea class="css-edit" id="cDarkCss" spellcheck="false">${escapeHtml(def.darkCss)}</textarea></div>
          <div class="prop-row"><label class="check-row"><input type="checkbox" id="cPrevDark" ${customDark ? 'checked' : ''}> Preview the Dark mode variant</label></div>` : ''}
        <button class="btn primary block" id="cAdd">Add to the shot →</button>
        <button class="btn block" id="cCopy">⧉ Copy this component's CSS</button>
        <div class="del-row"><button class="btn" id="cDel"><span class="gly">✕</span>Delete from the library</button></div>`;
      drawLint(def);

      // Live edits patch the <style> tag and the specimen only — never re-render this
      // panel, or the textarea loses focus mid-keystroke.
      const live = () => { applyCustomCss(); renderSpecimen(); persistCustoms(); };
      const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };
      on('#cName', 'input', (e) => {
        def.name = e.target.value;
        def.slug = uniqueSlug(slugify(def.name), def.id);
        labTitle.textContent = def.name || 'Component';
        live(); renderCustomList(); renderCustomPalette(); if (getCapture()) renderLayers();
      });
      on('#cText', 'input', (e) => { def.text = e.target.value; live(); });
      on('#cCss', 'input', (e) => { def.css = e.target.value; drawLint(def); live(); });
      on('#cDarkCss', 'input', (e) => { def.darkCss = e.target.value; drawLint(def); live(); });
      on('#cW', 'input', (e) => { def.w = Math.max(20, parseInt(e.target.value, 10) || def.w); live(); });
      on('#cH', 'input', (e) => { def.h = Math.max(20, parseInt(e.target.value, 10) || def.h); live(); });
      on('#cPrevDark', 'change', (e) => { customDark = e.target.checked; renderSpecimen(); });
      on('#cDarkOn', 'change', (e) => {
        if (e.target.checked && !def.darkCss.trim()) {
          def.darkCss = '  color:#fff;\n  border-color:rgba(255,255,255,.22);';
        } else if (!e.target.checked) { def.darkCss = ''; customDark = false; }
        live(); renderLabProps();
      });
      on('#cAdd', 'click', addFromLab);
      on('#cCopy', 'click', () => copyText(buildOneCss(def), `Copied the CSS for "${def.name}".`));
      on('#cDel', 'click', () => deleteCustom(def.id));
      const box = $('#cSizing');
      box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        def.sizing = b.dataset.v; persistCustoms(); renderLab();
      }));
    }

    // ---- lab → stage --------------------------------------------------------
    function addFromLab() {
      const capture = getCapture();
      if (!capture) { toast('No capture yet — go to the Snap tab and snap or upload an image first.'); return; }
      let el;
      if (labSel.kind === 'custom') {
        el = newElement('custom:' + labSel.id);
      } else {
        const k = KIT.find((x) => x.id === labSel.id);
        if (!k || !k.ui.addable) return;
        el = newElement(k.ui.type);
        // every key in comp.demo is a real field on the element it previews, so the
        // variants you were just looking at are the ones that land on the shot
        const comp = compByCatalogId(k.id);
        if (comp && comp.demo) Object.assign(el, comp.demo);
      }
      if (!el) { toast('That component no longer exists.'); return; }
      capture.els.push(el);
      setSelId(el.id);
      setView('snap');
      render();
      toast('Dropped in the middle of the shot — drag it into place.');
    }

    function buildOneCss(def) {
      let out = `.cmp-x-${def.slug} {\n${def.css.replace(/\s+$/, '')}\n}`;
      if (def.darkCss.trim()) out += `\n\n.cmp-x-${def.slug}.on-dark {\n${def.darkCss.replace(/\s+$/, '')}\n}`;
      return out;
    }
    async function copyText(text, okMsg) {
      try { await navigator.clipboard.writeText(text + '\n'); toast(okMsg); }
      catch (e) { toast('Copy failed: ' + e.message); }
    }
    function copyAllCss() {
      if (!customs.length) { toast('No custom components to copy yet.'); return; }
      const header = [
        `/* Snap Studio — ${customs.length} custom component(s).`,
        '   Paste at the end of src/tokens.css to make them part of this design kit for good.',
        '   Note: tokens.css here is a vendored copy of Editorial Glass, and the repo has no',
        '   sync command left — pasting here is a FORK, not a sync. See',
        '   .claude/skills/editorial-glass/SKILL.md, section "Adding a component". */',
        '', '',
      ].join('\n');
      copyText(header + buildCustomCss(), 'Copied the CSS of every custom component.');
    }

    mockToggle.addEventListener('change', renderGround);
    $('#groundSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      $('#groundSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      ground = b.dataset.v; renderGround(); renderSpecimen();
    }));
    $('#labNew').addEventListener('click', () => { labSel = { kind: 'new' }; setView('lab'); renderLab(); });
    $('#labNewRail').addEventListener('click', () => { labSel = { kind: 'new' }; renderLab(); });
    $('#labCopyCss').addEventListener('click', copyAllCss);
    $('#mdInput').addEventListener('change', () => {
      const f = $('#mdInput').files[0];
      $('#mdInput').value = '';                    // clear so re-uploading the same file still fires 'change'
      if (f) createCustomFromMd(f);
    });

    loadCustoms();

    window.SnapKit.lab.renderLab = renderLab;
    window.SnapKit.lab.renderCustomPalette = renderCustomPalette;
  }

  window.SnapKit.lab = { customDef, init };
})();
