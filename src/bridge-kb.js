/* bridge-kb.js — KB tab side of topology B, now a small job board: a rail
   listing existing kb/ articles (kb_list) plus a pinned "+ New job" entry
   that opens the instruction/session-tabs form. Unlike bridge-editor.js
   (which only ever ANSWERS commands the bridge sends down), this file is
   the INITIATOR: it collects an instruction (+ an optional reference .md
   and a set of session tabs), asks the service worker to relay a
   kb_start/kb_cancel/kb_query/kb_list/kb_read over the existing /ext
   WebSocket (see src/bridge-worker.js's callBridge()), and renders the
   kb_progress lines the bridge pushes back as the spawned agent works. See
   KB-BRIDGE.md mục 7 for the full design and snap-bridge/kb-job.js /
   server.js for the other end of this.

   Session tabs (kb-session-cmd list/add/remove) are answered locally by
   bridge-worker.js — no round trip to snap-bridge — since it's pure
   chrome.tabs bookkeeping; only kb_start's snapshot of the list travels
   over the bridge. Selecting an article in the job board is read-only for
   now (kb_save_md exists server-side but has no UI yet — that's the split
   markdown|preview editor, the next slice of Phase 3).

   Same init(deps) wiring convention as lab.js / export.js / bridge-editor.js. */
(() => {
  window.SnapKit = window.SnapKit || {};
  const hasExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  const $ = (s) => document.querySelector(s);

  function init(deps) {
    if (!hasExt) return;
    const { toast, adoptIntoSnap } = deps;

    // Live surfaces read their base captures through the same bridge call the
    // preview's <img> hydration uses; kb-surface.js caches the decoded ones,
    // since a keystroke in the markdown editor rebuilds every surface.
    window.SnapKit.kbSurface.init({ toast, readImage: (relPath) => callBg('read_image', { relPath }) });

    const instructionInput = $('#kbInstructionInput');
    const uploadBtn = $('#kbUploadBtn');
    const mdInput = $('#kbMdInput');
    const filenameEl = $('#kbFilename');
    const sessionInList = $('#kbSessionInList');
    const sessionCandidateList = $('#kbSessionCandidateList');
    const sessionRefreshBtn = $('#kbSessionRefresh');
    const startBtn = $('#kbStartBtn');
    const stopBtn = $('#kbStopBtn');
    const statusNote = $('#kbStatusNote');
    const logEl = $('#kbLog');
    const banner = $('#kbBanner');
    const boardNewBtn = $('#kbJobBoardNew');
    const boardList = $('#kbJobBoard');
    const bridgeOffline = $('#kbBridgeOffline');
    const bridgeStartBtn = $('#kbBridgeStart');
    const bridgeHint = $('#kbBridgeHint');
    const newJobPanel = $('#kbNewJobPanel');
    const articlePanel = $('#kbArticlePanel');
    const articleTitle = $('#kbArticleTitle');
    const articleEditor = $('#kbArticleEditor');
    const articlePreview = $('#kbArticlePreview');
    const articleSaveBtn = $('#kbArticleSave');
    const articleSaveNote = $('#kbArticleSaveNote');
    const articleRefreshBtn = $('#kbArticleRefresh');
    const commentModeBtn = $('#kbCommentModeBtn');
    const historyBtn = $('#kbHistoryBtn');
    const historyPanel = $('#kbHistoryPanel');
    const articleDeleteBtn = $('#kbArticleDelete');
    const articlePrompt = $('#kbArticlePrompt');
    const articleSendBtn = $('#kbArticleSend');
    const articleNewSessionBtn = $('#kbArticleNewSession');
    const articleSessionBadge = $('#kbArticleSession');
    const articleLog = $('#kbArticleLog');
    const articleLogWrap = $('#kbArticleLogWrap');
    const articleLogResize = $('#kbArticleLogResize');
    const logWrap = $('#kbLogWrap');
    const logResize = $('#kbLogResize');
    const jobPreviewWrap = $('#kbJobPreviewWrap');
    const jobPreviewTitle = $('#kbJobPreviewTitle');
    const jobPreviewOpen = $('#kbJobPreviewOpen');
    const jobPreview = $('#kbJobPreview');
    const agentWrap = $('#kbAgentWrap');
    const agentTitle = $('#kbAgentTitle');
    const agentCanvasEl = $('#kbAgentCanvas');
    const agentToSnap = $('#kbAgentToSnap');

    // Where a KB job's agent draws. bridge-editor.js routes snap_open/snap_add/
    // get_els here instead of at the Snap tab's canvas, so the agent and the
    // user no longer share a workspace — see mountAgent()'s own note. Exposed on
    // SnapKit.kb because SnapKit.bridge.init() runs BEFORE SnapKit.kb.init()
    // (editor.js's tail), so bridge-editor.js has to resolve it lazily, at the
    // moment a command arrives, not at wiring time.
    const agentCanvas = window.SnapKit.kbSurface.mountAgent(agentCanvasEl, {
      onChange: () => describeAgentCanvas(),
    });
    window.SnapKit.kb.agent = () => agentCanvas;

    function describeAgentCanvas() {
      if (!agentCanvas.hasCapture()) {
        agentTitle.textContent = 'Waiting for the agent\u2019s first screenshot\u2026';
        agentToSnap.hidden = true;
        return;
      }
      const n = agentCanvas.count();
      const url = agentCanvas.url();
      agentTitle.textContent = `Agent canvas \u2014 ${n} component${n === 1 ? '' : 's'}${url ? ' \u00b7 ' + url : ''}`;
      agentToSnap.hidden = false;
    }
    function showAgentCanvas(on) { agentWrap.hidden = !on; syncJobPanes(); }
    function resetAgentCanvas() { agentCanvas.clear(); describeAgentCanvas(); }
    describeAgentCanvas();

    // The one way an agent capture reaches the Snap tab now, and only because
    // the user asked: it lands there as a new capture tab of their own, with the
    // annotations rebuilt against it, and switches the view because clicking
    // this button is a decision to go and work on it.
    agentToSnap.addEventListener('click', async () => {
      const shot = agentCanvas.snapshot();
      if (!shot) return;
      agentToSnap.disabled = true;
      try { await adoptIntoSnap(shot); }
      catch (e) { toast('Could not copy to the Snap tab: ' + e.message); }
      finally { agentToSnap.disabled = false; }
    });

    let markdown = null;
    let mdFilename = null;
    let sessionTabs = [];       // tabs already added — {id, title, url}
    let candidateTabs = [];     // other open tabs, not yet added
    let jobId = null;
    let jobStatus = 'idle';   // idle | running | done | error | cancelled
    let jobMode = 'author';   // 'author' (+ New job, drives a browser) | 'revise' (prompt box on an article)
    let jobSlug = null;       // the article a revise job is working on
    let articleHasSession = false;   // the selected article has a conversation the next prompt would continue
    let jobInstruction = null;
    let selectedSlug = null;   // null = "+ New job" panel; otherwise an existing article's slug
    let articleKind = null;    // 'file' | 'job' — from the last kb_read, needed for the delete prompt's wording
    let articleMdRel = '';     // kb/-relative path of the .md — what its image srcs are relative to
    let articleDirty = false;  // unsaved edits in the article editor
    let comments = [];         // the selected article's positioned comments
    let commentMode = false;
    let activePopover = null;
    let suppressPopoverAutoClose = false;
    const imageCache = new Map();   // resolved kb/-relative path -> dataUrl | null (null = failed)

    // A step image in the preview is no longer the exported PNG: it is the
    // step's BASE capture with its job.json els drawn live on top, editable in
    // place (src/kb-surface.js). These hold that half of the article.
    let articleJob = null;          // the selected article's job.json, when it has one
    const stepEls = new Map();      // step.out -> the els on screen right now, saved or not
    const stepSaved = new Map();    // step.out -> JSON of the els last written to disk
    const surfaces = new Map();     // step.out -> the mounted surface, while this preview stands
    let mdDirty = false;            // the markdown half of "unsaved" — the els half is stepEls vs stepSaved
    let previewGen = 0;             // renderPreview() runs per keystroke and mounting is async

    // The New job panel's own preview — the article a running authoring job is
    // building, read-only. Deliberately its own state rather than a second user
    // of the article panel's: the two show different articles at the same time
    // (start a job, then go read something else in the rail while it runs), and
    // an authoring job has no slug at all until the agent writes one.
    let jobPreviewSlug = null;
    let jobPreviewJob = null;
    let jobPreviewDir = '';
    let jobPreviewMd = null;       // what the preview was last built from — null = nothing yet
    let jobPreviewName = '';       // the article's title, for the "Open article" hand-off
    let jobPreviewGen = 0;
    const jobSurfaces = new Map();  // step.out -> mounted surface
    let jobPreviewBusy = false;     // one read in flight at a time; a push during it re-runs after
    let jobPreviewAgain = false;

    // ---- relay to the service worker, reqId-matched broadcast reply — same
    // reasoning as bridge-editor.js's own reply(): an MV3 sendMessage
    // callback is not a reliable channel across a service-worker wake cycle.
    const waiters = new Map();
    const sessionWaiters = new Map();
    const localWaiters = new Map();
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'kb-bridge-status') {
        // The socket came back (the user hit Start bridge, or the reconnect
        // timer finally found a process) — the rail is stale by definition, so
        // re-list rather than making the user click something to find out.
        setBridgeOffline(!msg.connected);
        if (msg.connected) { refreshJobBoard(); refreshSession(); }
        return;
      }
      if (msg.type === 'kb-article-changed') {
        // An agent wrote to kb/ — job.json, the markdown, or an exported PNG.
        // The rail's timestamps are stale either way; the open article is only
        // reloaded when it is the one that changed and nothing local is unsaved.
        refreshJobBoard();
        // The first push of an authoring job that names an article IS the answer
        // to "which article is this job writing" — nothing earlier knows it.
        if (jobMode === 'author' && jobStatus === 'running' && msg.slug) adoptJobPreview(msg.slug);
        if (jobPreviewSlug && (!msg.slug || msg.slug === jobPreviewSlug)) refreshJobPreview();
        if (selectedSlug && (!msg.slug || msg.slug === selectedSlug)) reloadFromDisk();
        return;
      }
      if (msg.type === 'kb-local-reply') {
        const w = localWaiters.get(msg.reqId);
        if (!w) return;
        localWaiters.delete(msg.reqId);
        if (msg.ok) w.resolve(msg.data); else w.reject(new Error(msg.error || 'the launcher reported an error with no message'));
        return;
      }
      if (msg.type === 'kb-bridge-reply') {
        const w = waiters.get(msg.reqId);
        if (!w) return;
        waiters.delete(msg.reqId);
        if (msg.ok) w.resolve(msg.data); else w.reject(new Error(msg.error || 'snap-bridge reported an error with no message'));
      } else if (msg.type === 'kb-session-reply') {
        const w = sessionWaiters.get(msg.reqId);
        if (!w) return;
        sessionWaiters.delete(msg.reqId);
        if (msg.ok) w.resolve(msg.data); else w.reject(new Error(msg.error || 'session command reported an error with no message'));
      } else if (msg.type === 'kb-progress') {
        appendLine(msg.line);
        // kb-job.js's own push() prefixes its terminal lines this way (see
        // its lineClass()-matching text below) — the only live signal this
        // UI gets that the job ended on its own, not via the Stop button.
        if (msg.line.startsWith('Job finished')) { setStatus('done'); refreshJobBoard(); afterReviseFinish(); refreshSessionBadge(); refreshJobPreview(); }
        else if (msg.line.startsWith('Job failed') || msg.line.startsWith('Job crashed')) { setStatus('error'); refreshSessionBadge(); refreshJobPreview(); }
      }
    });
    function callBg(cmd, args) {
      return new Promise((resolve, reject) => {
        const reqId = 'kbui_' + Math.random().toString(36).slice(2, 10);
        waiters.set(reqId, { resolve, reject });
        chrome.runtime.sendMessage({ type: 'kb-bridge-cmd', reqId, cmd, args }, () => void chrome.runtime.lastError);
      });
    }
    function callSession(cmd, args) {
      return new Promise((resolve, reject) => {
        const reqId = 'kbs_' + Math.random().toString(36).slice(2, 10);
        sessionWaiters.set(reqId, { resolve, reject });
        chrome.runtime.sendMessage({ type: 'kb-session-cmd', reqId, cmd, args }, () => void chrome.runtime.lastError);
      });
    }
    /** Deliberately NOT callBg: 'status' and 'launch' are the two things that
     *  have to work while the bridge is down, so they never touch its socket —
     *  the worker answers status itself and hands launch to the native host.
     *  See bridge-worker.js's kb-local-cmd listener. */
    function callLocal(cmd, args, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const reqId = 'kbl_' + Math.random().toString(36).slice(2, 10);
        // Unlike callBg/callSession, this one is on the path that RENDERS the
        // bridge-down panel, so a worker that never answers — running code from
        // before this message type existed, most likely, i.e. exactly the
        // "reload the extension" case — must not leave the rail blank and
        // silent forever. 30s clears the host's own 12s wait for the port.
        const timer = setTimeout(() => {
          localWaiters.delete(reqId);
          reject(new Error(`the extension's background worker didn't answer "${cmd}" — reload Snap Studio at chrome://extensions.`));
        }, timeoutMs);
        localWaiters.set(reqId, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        chrome.runtime.sendMessage({ type: 'kb-local-cmd', reqId, cmd, args }, () => void chrome.runtime.lastError);
      });
    }

    // ---- log rendering ------------------------------------------------------
    function lineClass(line) {
      if (line.startsWith('→ ')) return 'kb-log-line--tool';
      // An authoring job runs in three stages (capture -> write -> review, plus
      // fix rounds); the bridge banners each one, and picking them out of the
      // scroll is how "where is it up to" gets answered at a glance.
      if (line.startsWith('— ')) return 'kb-log-line--stage';
      if (line.startsWith('Denied ')) return 'kb-log-line--denied';
      if (line.startsWith('Job finished')) return 'kb-log-line--done';
      if (line.startsWith('Job failed') || line.startsWith('Job crashed')) return 'kb-log-line--error';
      return '';
    }
    // A revise job's progress belongs in the article panel it was started
    // from; an authoring job's in the New job panel. Same lines, same classes,
    // different destination — picked from the RUNNING JOB's mode, not from
    // whichever panel happens to be on screen, so switching panels mid-job
    // does not start dropping lines on the floor.
    function activeLog() { return jobMode === 'revise' ? articleLog : logEl; }
    function appendLine(line) {
      const el = activeLog();
      const p = document.createElement('p');
      p.className = 'kb-log-line ' + lineClass(line);
      p.textContent = line;
      el.appendChild(p);
      el.scrollTop = el.scrollHeight;
    }
    function renderLog(lines) {
      const el = activeLog();
      el.innerHTML = '';
      if (!lines || !lines.length) {
        if (el === logEl) el.innerHTML = '<p class="empty-hint">Write an instruction and add at least one session tab, then hit Start. Progress from the agent — what it navigates to, what it annotates, what it writes — appears here as it happens.</p>';
        return;
      }
      lines.forEach(appendLine);
    }

    // ---- session tabs ---------------------------------------------------------
    function sessionItem(tab, glyph, title, onClick) {
      const li = document.createElement('li');
      li.className = 'kb-session-item';
      const label = document.createElement('span');
      label.className = 'kb-session-item-label';
      label.textContent = tab.title || tab.url;
      label.title = tab.url;
      const btn = document.createElement('button');
      btn.className = 'kb-session-item-btn';
      btn.type = 'button';
      btn.textContent = glyph;
      btn.title = title;
      btn.disabled = jobStatus === 'running';
      btn.addEventListener('click', onClick);
      li.append(label, btn);
      return li;
    }
    function renderSessionLists() {
      sessionInList.innerHTML = '';
      if (!sessionTabs.length) {
        sessionInList.innerHTML = '<li class="empty-hint">None yet — add a tab below.</li>';
      } else {
        sessionTabs.forEach((t) => sessionInList.appendChild(
          sessionItem(t, '×', 'Remove from session', () => removeSessionTab(t.id))
        ));
      }
      sessionCandidateList.innerHTML = '';
      if (!candidateTabs.length) {
        sessionCandidateList.innerHTML = '<li class="empty-hint">No other open tabs — open one, then refresh.</li>';
      } else {
        candidateTabs.forEach((t) => sessionCandidateList.appendChild(
          sessionItem(t, '+', 'Add to session', () => addSessionTab(t.id))
        ));
      }
      updateControls();
    }
    async function refreshSession() {
      try {
        const { tabs } = await callSession('list', {});
        sessionTabs = tabs.filter((t) => t.inSession);
        candidateTabs = tabs.filter((t) => !t.inSession);
        renderSessionLists();
      } catch (e) {
        toast('Could not list open tabs: ' + e.message);
      }
    }
    async function addSessionTab(tabId) {
      try { await callSession('add', { tabId }); await refreshSession(); }
      catch (e) { toast('Could not add tab: ' + e.message); }
    }
    async function removeSessionTab(tabId) {
      try { await callSession('remove', { tabId }); await refreshSession(); }
      catch (e) { toast('Could not remove tab: ' + e.message); }
    }

    // ---- markdown -> HTML, hand-rolled (no library — same call the reference
    // repo's own guide-studio made). Escapes first, so this never trusts raw
    // HTML in an article. Images render as a real <img> (inside a
    // position:relative wrapper comment pins anchor to), but with no `src`
    // yet — hydrateImages() fills that in from a kb_read_image data: URL
    // once the preview is in the DOM, since a chrome-extension:// page has
    // no static file server of its own to resolve a plain relative path
    // against (only this WS/MCP channel can reach kb/'s bytes). ----------
    function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function inlineMd(s) {
      s = escapeHtml(s);
      s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
        const escSrc = escapeHtml(src);
        const escAlt = escapeHtml(alt);
        return `<figure class="kb-md-figure"><span class="kb-md-imgwrap" data-src="${escSrc}"><img class="kb-md-img" alt="${escAlt}"></span>`
          + `<figcaption>${escSrc}${alt ? ' — ' + escAlt : ''}</figcaption></figure>`;
      });
      s = s.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (m, text, href) => `<a href="#" class="kb-md-link" title="${escapeHtml(href)}">${text}</a>`);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
      return s;
    }
    function parseTableRow(line) {
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    }
    function md2html(md) {
      const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
      const out = [];
      let list = null;     // 'ul' | 'ol' | null
      let liBuf = null;    // text lines of the currently-open <li>, joined on flush
      let para = [];
      const flushLi = () => { if (liBuf !== null) { out.push(`<li>${inlineMd(liBuf.join(' '))}</li>`); liBuf = null; } };
      const closeList = () => { flushLi(); if (list) { out.push('</' + list + '>'); list = null; } };
      const flushPara = () => { if (para.length) { out.push('<p>' + para.join(' ') + '</p>'); para = []; } };
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        let m;
        // Fenced code block — consumed verbatim, no inline parsing inside (a
        // stray * or _ in a code sample must not turn into <em>/<strong>).
        if (/^```/.test(line)) {
          flushPara(); closeList();
          const code = [];
          i++;
          while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
          i++;
          out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
          continue;
        }
        // GFM table — header row + a |---|---| separator, then rows until a
        // non-table line. KB articles here lean on tables heavily (option
        // comparisons, mode tables) so this isn't optional.
        if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
          flushPara(); closeList();
          const header = parseTableRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { rows.push(parseTableRow(lines[i])); i++; }
          out.push('<table><thead><tr>' + header.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>'
            + rows.map((r) => '<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
          continue;
        }
        if (!line.trim()) { flushPara(); closeList(); i++; continue; }
        if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
          flushPara(); closeList();
          out.push(`<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`);
        } else if (/^>\s?/.test(line)) {
          flushPara(); closeList();
          out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ''))}</blockquote>`);
        } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
          flushPara(); closeList();
          out.push('<hr>');
        } else if ((m = /^[-*]\s+(.*)$/.exec(line))) {
          flushPara();
          if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } else { flushLi(); }
          liBuf = [m[1]];
        } else if ((m = /^\d+\.\s+(.*)$/.exec(line))) {
          flushPara();
          if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } else { flushLi(); }
          liBuf = [m[1]];
        } else if (list && liBuf !== null && /^\s+\S/.test(line)) {
          // Indented continuation of the item currently being built — these
          // KB articles routinely wrap a list item across lines. Without
          // this, each continuation line closed the list (see below) and
          // the next numbered item re-opened a FRESH <ol>, so every item
          // rendered "1." instead of counting up — caught by rendering a
          // real multi-line-list article, not by reading the regex.
          liBuf.push(line.trim());
        } else {
          closeList();
          para.push(inlineMd(line.trim()));
        }
        i++;
      }
      flushPara(); closeList();
      return out.join('\n');
    }
    // resolveImagePath/hydrateImages read image bytes on-demand and cache by
    // resolved path — renderPreview() re-runs on every keystroke, and
    // without a cache that would re-fetch every image in the article on
    // every keystroke.
    /** The directory a markdown's image srcs are relative to, kb/-relative and
     *  trailing-slashed (or '' for an article that sits at the root of kb/).
     *  Read off the article's own mdRel rather than inferred from its kind: a
     *  job-kind article whose job.md points back at kb/<slug>.md has ROOT-relative
     *  images, which is exactly the shape on disk during an authoring job for the
     *  minutes between the first job.json write and the markdown landing.
     *
     *  The leading "kb/" has to come off first. mdRel comes from the bridge's
     *  toKbRel(), which prefixes it for READING — every path this side then hands
     *  back to kb_read_image is resolved against kb/ already, so leaving it on
     *  asks for kb/kb/img/... and every image in every article comes up broken.
     *  Which is exactly what it did: the harnesses stubbed mdRel as a bare
     *  "<slug>.md" instead of the "kb/<slug>.md" the bridge really sends, so they
     *  all passed while the real app showed nothing. */
    function mdDirOf(mdRel) {
      const s = String(mdRel || '').replace(/\\/g, '/').replace(/^kb\//, '');
      const i = s.lastIndexOf('/');
      return i < 0 ? '' : s.slice(0, i + 1);
    }
    function resolveImagePath(rawSrc, dir) {
      if (/^([a-z]+:)?\/\//i.test(rawSrc) || rawSrc.startsWith('data:')) return null;   // remote/data URL — nothing to fetch
      return (dir || '') + rawSrc.replace(/^\.\//, '');
    }
    /** The job step a markdown image belongs to, matched on the path that step
     *  RENDERS to. Both sides are compared kb/-relative: job.json's src/out are
     *  relative to kb/, the markdown's are relative to the article's own .md —
     *  the asymmetry resolveImagePath() already exists to bridge. */
    function stepFor(resolved, job) {
      if (!job || !Array.isArray(job.steps)) return null;
      return job.steps.find((s) => s && s.out && s.out.replace(/^\.\//, '') === resolved) || null;
    }
    function destroySurfaces() {
      surfaces.forEach((s) => { try { s.destroy(); } catch (e) {} });
      surfaces.clear();
    }

    /** Fill in a rendered preview's images. Two previews go through here — the
     *  article panel's editable one and the New job panel's read-only view of
     *  the article a running job is building — and `ctx` is the entire
     *  difference between them:
     *
     *    root       the container the markdown was rendered into
     *    dir        what its image srcs are relative to (mdDirOf)
     *    job        job.json, for matching an image back to the step that made it
     *    surfaces   where to record the mounted surfaces, so they can be destroyed
     *    stale()    a newer render started while this one was awaiting bytes
     *    els(step)  the caller's current annotations for a step, saved or not
     *    readOnly() whether a click on the picture opens the editor
     *    onChange   null for a view; the article's dirty-tracking otherwise
     *    live       false leaves the exported PNG in place and mounts nothing */
    async function hydrateImages(ctx) {
      const wraps = Array.from(ctx.root.querySelectorAll('.kb-md-imgwrap[data-src]'));
      await Promise.all(wraps.map(async (wrap) => {
        const resolved = resolveImagePath(wrap.dataset.src, ctx.dir);
        const img = wrap.querySelector('img');
        if (!resolved) { wrap.classList.add('kb-md-imgwrap--broken'); return; }
        if (!imageCache.has(resolved)) {
          try {
            const { dataUrl } = await callBg('read_image', { relPath: resolved });
            imageCache.set(resolved, dataUrl);
          } catch (e) {
            imageCache.set(resolved, null);
          }
        }
        const dataUrl = imageCache.get(resolved);
        if (dataUrl) img.src = dataUrl; else wrap.classList.add('kb-md-imgwrap--broken');

        // The rendered PNG above is still fetched and still what the `PNG` toggle
        // shows — it is what the published markdown links to. What goes on screen
        // by default is the live surface, when this image is a job step whose base
        // capture is still on disk. Everything else (a flat article with no
        // job.json, an image the agent pasted in by hand, a base capture that has
        // been deleted) keeps the PNG, read-only, exactly as before.
        if (ctx.live === false) return;
        const step = stepFor(resolved, ctx.job);
        if (!step || !step.src) return;
        const inst = await window.SnapKit.kbSurface.mount(wrap, {
          step,
          els: ctx.els(step),
          // Drawn on every step, owned by the job — see job.globalEls in the /kb
          // skill. Read-only here: moving it on one step would not move it on the
          // other seven, and it is nearly always the PII redaction.
          lockedEls: (ctx.job && ctx.job.globalEls) || [],
          readOnly: ctx.readOnly(),
          onChange: ctx.onChange ? (jobEls) => ctx.onChange(step, jobEls) : null,
        });
        if (!inst) return;
        // A newer render started while this one was awaiting bytes, so the
        // wrapper this mounted into is already detached — throw it away rather
        // than leaving a second surface listening for the same step.
        if (ctx.stale()) { inst.destroy(); return; }
        ctx.surfaces.set(step.out, inst);
      }));
    }
    /** hydrateImages ctx for the article panel. `live: false` is History's
     *  "View": a snapshot is of the MARKDOWN and job.json's els are today's, so
     *  a past version gets the PNGs it linked to. */
    function articleCtx(gen, opts) {
      return {
        root: articlePreview, dir: mdDirOf(articleMdRel), job: articleJob, surfaces,
        stale: () => gen !== previewGen,
        els: (step) => stepEls.get(step.out) || step.els || [],
        readOnly: () => commentMode,
        onChange: (step, jobEls) => { stepEls.set(step.out, jobEls); refreshDirty(); },
        live: !(opts && opts.live === false),
      };
    }
    function renderPreview() {
      // Unsaved annotation edits are safe across this: stepEls is the state, and
      // the surfaces are only its view — every one is rebuilt from that map below.
      destroySurfaces();
      articlePreview.innerHTML = md2html(articleEditor.value);
      renderCommentPins();
      hydrateImages(articleCtx(++previewGen));
    }

    // ---- positioned comments -----------------------------------------------
    // One comment = a pin on a specific image at a normalized (xNorm, yNorm)
    // spot, matched back to a rendered <img> by its ORIGINAL markdown src
    // string (kb_comments_add/list persist that verbatim — see server.js's
    // own note on why). Comment mode gates click-to-pin so a reader
    // browsing the article doesn't drop a pin by accident.
    function closePopover() { if (activePopover) { activePopover.remove(); activePopover = null; } }
    function closeHistoryPanel() { historyPanel.hidden = true; }
    document.addEventListener('click', (ev) => {
      // historyBtn's own click toggles the panel open — excluded here by
      // target, not a suppress-flag, since it doesn't need the same
      // open/reopen dance the comment popovers do (plain toggle, no swap).
      // This check must run BEFORE the suppress-flag early return below:
      // opening a comment composer/viewer sets that flag on the very click
      // that should also close an already-open history panel, and the flag
      // is unrelated to the history panel's own state — gating this on it
      // left the panel stuck open whenever a popover opened at the same
      // time, caught by simulating that exact click ordering in a harness.
      if (!historyPanel.hidden && !historyPanel.contains(ev.target) && !historyBtn.contains(ev.target)) closeHistoryPanel();
      if (suppressPopoverAutoClose) { suppressPopoverAutoClose = false; return; }
      if (activePopover && !activePopover.contains(ev.target)) closePopover();
    });
    function renderCommentPins() {
      articlePreview.querySelectorAll('.kb-comment-pin').forEach((p) => p.remove());
      if (!comments.length) return;
      articlePreview.querySelectorAll('.kb-md-imgwrap[data-src]').forEach((wrap) => {
        comments.filter((c) => c.img === wrap.dataset.src).forEach((c) => {
          const pin = document.createElement('button');
          pin.type = 'button';
          pin.className = 'kb-comment-pin' + (c.resolved ? ' kb-comment-pin--resolved' : '');
          pin.style.left = (c.xNorm * 100) + '%';
          pin.style.top = (c.yNorm * 100) + '%';
          pin.textContent = c.resolved ? '✓' : '!';
          pin.title = c.text;
          // Deliberately NOT ev.stopPropagation() — the articlePreview
          // delegate below already ignores pin clicks via .closest('.kb-
          // comment-pin'), and this click must keep bubbling to document's
          // auto-close listener so it can consume suppressPopoverAutoClose.
          // Stopping it here left that flag stuck true, silently eating the
          // NEXT unrelated outside click — caught by dispatching a real
          // click sequence (pin, then elsewhere) and checking the popover
          // actually closed, not by reading the two listeners in isolation.
          pin.addEventListener('click', () => openViewer(wrap, c));
          wrap.appendChild(pin);
        });
      });
    }
    async function refreshComments() {
      if (!selectedSlug) { comments = []; return; }
      try {
        const { comments: list } = await callBg('comments_list', { slug: selectedSlug });
        comments = list;
      } catch (e) {
        comments = [];
      }
      renderCommentPins();
    }
    function openComposer(wrap, imgSrc, xNorm, yNorm) {
      closePopover();
      suppressPopoverAutoClose = true;
      const pop = document.createElement('div');
      pop.className = 'kb-comment-popover';
      pop.style.left = (xNorm * 100) + '%';
      pop.style.top = (yNorm * 100) + '%';
      const ta = document.createElement('textarea');
      ta.placeholder = 'Comment on this spot…';
      const actions = document.createElement('div');
      actions.className = 'kb-comment-popover-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button'; cancelBtn.className = 'btn sm ghost'; cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', closePopover);
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button'; saveBtn.className = 'btn sm primary'; saveBtn.textContent = 'Pin';
      saveBtn.addEventListener('click', async () => {
        const text = ta.value.trim();
        if (!text) return;
        saveBtn.disabled = true;
        try {
          await callBg('comments_add', { slug: selectedSlug, img: imgSrc, xNorm, yNorm, text });
          await refreshComments();
          closePopover();
        } catch (e) {
          toast('Could not save comment: ' + e.message);
          saveBtn.disabled = false;
        }
      });
      actions.append(cancelBtn, saveBtn);
      pop.append(ta, actions);
      wrap.appendChild(pop);
      activePopover = pop;
      ta.focus();
    }
    function openViewer(wrap, comment) {
      closePopover();
      suppressPopoverAutoClose = true;
      const pop = document.createElement('div');
      pop.className = 'kb-comment-popover';
      pop.style.left = (comment.xNorm * 100) + '%';
      pop.style.top = (comment.yNorm * 100) + '%';
      const p = document.createElement('p');
      p.textContent = comment.text;
      const actions = document.createElement('div');
      actions.className = 'kb-comment-popover-actions';
      const delBtn = document.createElement('button');
      delBtn.type = 'button'; delBtn.className = 'btn sm ghost'; delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        if (!confirm('Delete this comment?')) return;
        try { await callBg('comments_delete', { slug: selectedSlug, id: comment.id }); await refreshComments(); closePopover(); }
        catch (e) { toast('Could not delete: ' + e.message); }
      });
      const resolveBtn = document.createElement('button');
      resolveBtn.type = 'button'; resolveBtn.className = 'btn sm primary';
      resolveBtn.textContent = comment.resolved ? 'Reopen' : 'Resolve';
      resolveBtn.addEventListener('click', async () => {
        try {
          await callBg('comments_resolve', { slug: selectedSlug, id: comment.id, resolved: !comment.resolved });
          await refreshComments();
          closePopover();
        } catch (e) { toast('Could not update: ' + e.message); }
      });
      actions.append(delBtn, resolveBtn);
      pop.append(p);
      // What was changed when the pin was resolved — snap_comment_resolve
      // (agent side) always writes one. Without showing it, a resolved pin
      // just turns grey and the person who wrote the comment has to go read a
      // diff to find out whether anything actually happened.
      if (comment.resolvedNote) {
        const note = document.createElement('p');
        note.className = 'kb-comment-resolved-note';
        note.textContent = (comment.resolvedBy === 'agent' ? '🤖 ' : '✓ ') + comment.resolvedNote;
        pop.append(note);
      }
      pop.append(actions);
      wrap.appendChild(pop);
      activePopover = pop;
    }
    articlePreview.addEventListener('click', (ev) => {
      if (!commentMode) return;
      const wrap = ev.target.closest('.kb-md-imgwrap');
      if (!wrap || ev.target.closest('.kb-comment-pin') || ev.target.closest('.kb-comment-popover')) return;
      const rect = wrap.getBoundingClientRect();
      openComposer(wrap, wrap.dataset.src, (ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height);
    });
    commentModeBtn.addEventListener('click', () => {
      commentMode = !commentMode;
      commentModeBtn.classList.toggle('on', commentMode);
      articlePreview.classList.toggle('kb-comment-mode-on', commentMode);
      // While pinning, a click on a picture has to drop a pin — not select the
      // callout under the cursor. The surfaces stop taking pointer events for
      // the duration; the click then lands on the wrapper, as it always did.
      surfaces.forEach((s) => s.setReadOnly(commentMode));
      closePopover();
    });

    // ---- version history ----------------------------------------------------
    // A snapshot is taken server-side before every kb_save_md / snap_render_job
    // overwrite (see server.js's snapshotKbHistory) — this panel only lists,
    // views, and restores them. "View" swaps the PREVIEW pane to a read-only
    // rendering of the old content without touching the live editor; hitting
    // Refresh (already wired to reload the real article) is how you leave
    // that view — no separate "back" control needed.
    function renderHistoryList(snapshots) {
      historyPanel.innerHTML = '';
      if (!snapshots.length) {
        historyPanel.innerHTML = '<p class="empty-hint">No earlier versions yet — saving or re-rendering creates one automatically.</p>';
        return;
      }
      snapshots.forEach((s) => {
        const row = document.createElement('div');
        row.className = 'kb-history-item';
        const label = document.createElement('span');
        label.className = 'kb-history-item-label';
        label.textContent = `${fmtAge(s.ts)}${s.preview ? ' — ' + s.preview : ''}`;
        label.title = label.textContent;
        const viewBtn = document.createElement('button');
        viewBtn.type = 'button'; viewBtn.className = 'btn sm ghost'; viewBtn.textContent = 'View';
        viewBtn.addEventListener('click', async () => {
          try {
            const { md } = await callBg('history_read', { slug: selectedSlug, ts: s.ts });
            // A snapshot is of the MARKDOWN; job.json's els are today's. Drawing
            // them live over an old article would show a state that never
            // existed, so a past version gets the PNGs it linked to, read-only.
            destroySurfaces();
            articlePreview.innerHTML = md2html(md);
            hydrateImages(articleCtx(++previewGen, { live: false }));
            closeHistoryPanel();
            toast('Viewing a past version — hit Refresh to return to the live preview.');
          } catch (e) {
            toast('Could not load that version: ' + e.message);
          }
        });
        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button'; restoreBtn.className = 'btn sm'; restoreBtn.textContent = 'Restore';
        restoreBtn.addEventListener('click', async () => {
          if (!confirm('Restore this version? The current content is kept as a history entry too, so this is undoable.')) return;
          try {
            await callBg('history_restore', { slug: selectedSlug, ts: s.ts });
            closeHistoryPanel();
            toast('Restored.');
            await selectArticle(selectedSlug, articleTitle.textContent);
            refreshJobBoard();
          } catch (e) {
            toast('Could not restore: ' + e.message);
          }
        });
        row.append(label, viewBtn, restoreBtn);
        historyPanel.appendChild(row);
      });
    }
    async function refreshHistoryPanel() {
      if (!selectedSlug) return;
      try {
        const { snapshots } = await callBg('history_list', { slug: selectedSlug });
        renderHistoryList(snapshots);
      } catch (e) {
        historyPanel.innerHTML = `<p class="empty-hint">Could not load history: ${e.message}</p>`;
      }
    }
    historyBtn.addEventListener('click', async () => {
      if (!historyPanel.hidden) { closeHistoryPanel(); return; }
      closePopover();
      historyPanel.hidden = false;
      historyPanel.innerHTML = '<p class="empty-hint">Loading…</p>';
      await refreshHistoryPanel();
    });

    // ---- job board --------------------------------------------------------
    function fmtAge(ms) {
      const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    }
    function setDirty(d) {
      articleDirty = d;
      articleSaveBtn.disabled = !d;
      articleSaveNote.textContent = d ? 'Unsaved changes' : '';
    }
    /** "Unsaved" now has two halves — the markdown in the editor, and every
     *  step's annotations. The second is decided by comparing to what was last
     *  written rather than by a flag any drag sets, so a callout dragged back to
     *  where it started leaves the article clean, and so does re-reading an
     *  agent's change off disk. Returns the step numbers to re-render. */
    function changedSteps() {
      if (!articleJob || !Array.isArray(articleJob.steps)) return [];
      return articleJob.steps
        .map((s, i) => ({ s, n: s && s.n == null ? i + 1 : s.n }))
        .filter(({ s }) => s && s.out && stepEls.has(s.out)
          && JSON.stringify(stepEls.get(s.out)) !== stepSaved.get(s.out))
        .map(({ n }) => n);
    }
    function refreshDirty() { setDirty(mdDirty || changedSteps().length > 0); }
    /** After a save, or after loading: what is on screen IS what is on disk. */
    function markClean() {
      mdDirty = false;
      for (const [key, els] of stepEls) stepSaved.set(key, JSON.stringify(els));
      setDirty(false);
    }
    /** job.json's annotations, indexed the way the markdown refers to their
     *  images. Always replaces what is in memory, so it is only ever called when
     *  there is nothing unsaved to lose. */
    function seedStepsFromJob() {
      stepEls.clear(); stepSaved.clear();
      if (!articleJob || !Array.isArray(articleJob.steps)) return;
      for (const s of articleJob.steps) {
        if (!s || !s.out) continue;
        const els = s.els || [];
        stepEls.set(s.out, els);
        stepSaved.set(s.out, JSON.stringify(els));
      }
    }
    /** Leaving an article: its annotation state goes with it. */
    function resetArticleState() {
      destroySurfaces();
      window.SnapKit.kbSurface.clearCache();   // decoded base captures of the article being left
      articleJob = null;
      stepEls.clear(); stepSaved.clear();
      mdDirty = false;
      setDirty(false);
    }
    /** Somebody else wrote this article — an agent's snap_job mid-job, most of
     *  the time. Re-read it, and put the change on screen without rebuilding the
     *  page under someone who is reading it: if only the annotations moved, the
     *  surfaces are patched in place and nothing scrolls. */
    async function reloadFromDisk() {
      if (!selectedSlug) return;
      if (articleDirty) { toast('This article just changed on disk — hit Refresh to load it (you have unsaved edits).'); return; }
      let data;
      try { data = await callBg('read', { slug: selectedSlug }); } catch (e) { return; }
      articleKind = data.kind;
      articleMdRel = data.mdRel || '';
      articleJob = data.job || null;
      seedStepsFromJob();
      // Both caches: the agent may have re-shot the base capture, not just
      // re-rendered the PNG on top of it.
      imageCache.clear();
      window.SnapKit.kbSurface.clearCache();
      if ((data.md || '') !== articleEditor.value) {
        articleEditor.value = data.md || '';
        renderPreview();
      } else {
        for (const [key, inst] of surfaces) {
          const els = stepEls.get(key);
          if (els) inst.setJobEls(els);
        }
      }
      setDirty(false);
      refreshComments();
    }
    // Every board-switching action funnels through here so an in-progress
    // edit is never silently discarded by a stray click elsewhere in the rail.
    function confirmDiscard() {
      return !articleDirty || confirm('Discard unsaved changes to this article?');
    }
    function selectNewJob() {
      if (!confirmDiscard()) return;
      closePopover();
      closeHistoryPanel();
      resetArticleState();
      selectedSlug = null;
      articleKind = null;
      articleMdRel = '';
      comments = [];
      newJobPanel.hidden = false;
      articlePanel.hidden = true;
      boardNewBtn.dataset.selected = 'true';
      boardList.querySelectorAll('.kb-jobboard-item').forEach((li) => { li.dataset.selected = 'false'; });
      refreshJobPreview();     // it stopped following the job while it was hidden
    }
    async function selectArticle(slug, title) {
      if (!confirmDiscard()) return;
      closePopover();
      closeHistoryPanel();
      resetArticleState();
      selectedSlug = slug;
      articleKind = null;
      articleMdRel = '';
      comments = [];
      newJobPanel.hidden = true;
      articlePanel.hidden = false;
      boardNewBtn.dataset.selected = 'false';
      boardList.querySelectorAll('.kb-jobboard-item').forEach((li) => { li.dataset.selected = li.dataset.slug === slug ? 'true' : 'false'; });
      // The prompt log belongs to whichever article its job is revising —
      // don't leave another article's progress hanging under this one.
      if (jobSlug !== slug) { articleLog.innerHTML = ''; showArticleLog(false); } else { showArticleLog(true); }
      articleTitle.textContent = title;
      articleEditor.value = 'Loading…';
      articleEditor.disabled = true;
      renderPreview();
      try {
        const data = await callBg('read', { slug });
        articleKind = data.kind;
        articleMdRel = data.mdRel || '';
        // job.json comes back for a directory article AND for a flat <slug>.md
        // that has one beside it — the shape the first articles this tool made
        // are in. Without it every step image here would be a flat PNG again.
        articleJob = data.job || null;
        seedStepsFromJob();
        articleEditor.value = data.md || '';
        articleEditor.disabled = false;
        renderPreview();
        setDirty(false);
        refreshComments();
        refreshSessionBadge();
      } catch (e) {
        articleEditor.value = '';
        articleEditor.disabled = false;
        articlePreview.innerHTML = '';
        toast(`Could not load "${slug}": ${e.message}`);
      }
    }
    articleEditor.addEventListener('input', () => { mdDirty = true; refreshDirty(); renderPreview(); });
    articleSaveBtn.addEventListener('click', async () => {
      if (!selectedSlug) return;
      articleSaveBtn.disabled = true;
      // One Save for both halves of the article. The order matters: the markdown
      // goes first because it is the cheap write, so a failure in the seconds-long
      // re-render below does not also lose the prose.
      const steps = changedSteps();
      if (steps.length) articleSaveNote.textContent = `Re-rendering ${steps.length} image(s)…`;
      try {
        if (mdDirty) await callBg('save_md', { slug: selectedSlug, md: articleEditor.value });
        if (steps.length) {
          const job = JSON.parse(JSON.stringify(articleJob));
          for (const s of job.steps) { if (s && s.out && stepEls.has(s.out)) s.els = stepEls.get(s.out); }
          await callBg('job_save', { slug: selectedSlug, job, rerenderSteps: steps });
          articleJob = job;
          imageCache.clear();       // the PNGs the `PNG` toggle shows were just rewritten
        }
        markClean();
        toast(steps.length ? `Saved — re-rendered ${steps.length} image(s).` : 'Saved.');
        refreshJobBoard();
      } catch (e) {
        toast('Could not save: ' + e.message);
        refreshDirty();
      }
    });
    articleDeleteBtn.addEventListener('click', async () => {
      if (!selectedSlug) return;
      if (!confirm(`Delete "${articleTitle.textContent}"? This removes the article` +
        (articleKind === 'job' ? ', its images, comments, and history' : ' and its comments/history') +
        ' permanently — cannot be undone.')) return;
      articleDeleteBtn.disabled = true;
      try {
        await callBg('delete', { slug: selectedSlug });
        resetArticleState();   // the article is gone — an unsaved-edits guard on the way out would be pointless
        toast('Deleted.');
        // refreshJobBoard() itself falls back to selectNewJob() once it sees
        // selectedSlug missing from the list — no separate reset needed here.
        await refreshJobBoard();
      } catch (e) {
        toast('Could not delete: ' + e.message);
      } finally {
        articleDeleteBtn.disabled = false;
      }
    });

    function renderJobBoard(items) {
      boardList.innerHTML = '';
      items.forEach((it) => {
        const li = document.createElement('li');
        li.className = 'kb-jobboard-item';
        li.dataset.slug = it.slug;
        li.dataset.selected = it.slug === selectedSlug ? 'true' : 'false';
        const title = document.createElement('span');
        title.className = 'kb-jobboard-item-title';
        title.textContent = it.title;
        const meta = document.createElement('span');
        meta.className = 'kb-jobboard-item-meta';
        meta.textContent = (it.kind === 'job' ? `${it.steps} step${it.steps === 1 ? '' : 's'} · ${it.imgs} img${it.imgs === 1 ? '' : 's'} · ` : '') + fmtAge(it.updatedAt);
        li.append(title, meta);
        li.addEventListener('click', () => selectArticle(it.slug, it.title));
        boardList.appendChild(li);
      });
      // The selected article can no longer be found (renamed/deleted on disk another way) — fall back to New job.
      if (selectedSlug && !items.some((it) => it.slug === selectedSlug)) selectNewJob();
    }
    // ---- bridge-down state ----------------------------------------------------
    // kb_list travels over the snap-bridge WebSocket, so a bridge that isn't
    // running looks exactly like a kb/ folder with nothing in it. That is the
    // whole reason this block exists: after a reboot nothing restarts
    // snap-bridge, the rail comes up empty, and the articles read as lost when
    // they are sitting untouched on disk. Say so, and offer the fix.
    function setBridgeOffline(offline) {
      bridgeOffline.hidden = !offline;
      if (!offline) { bridgeHint.hidden = true; bridgeHint.innerHTML = ''; }
    }
    /** Chrome's own wording when no native host is registered for this
     *  extension. Matched loosely (it has varied across versions) because the
     *  cure — run install.ps1 once — is specific to exactly this failure and
     *  useless noise for any other. */
    function isHostMissing(message) {
      return /native messaging host/i.test(message) || /not found/i.test(message);
    }
    function showInstallHint() {
      bridgeHint.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = 'The launcher isn’t registered with Chrome yet. Run this once from the repo root, then reload the extension:';
      const code = document.createElement('code');
      code.className = 'kb-offline-cmd';
      const cmd = 'powershell -ExecutionPolicy Bypass -File snap-bridge\\native-host\\install.ps1';
      code.textContent = cmd;
      const copy = document.createElement('button');
      copy.className = 'btn sm block';
      copy.type = 'button';
      copy.textContent = 'Copy command';
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(cmd).then(() => toast('Command copied.'), () => toast('Could not copy.'));
      });
      bridgeHint.append(p, code, copy);
      bridgeHint.hidden = false;
    }
    bridgeStartBtn.addEventListener('click', async () => {
      bridgeStartBtn.disabled = true;
      const label = bridgeStartBtn.textContent;
      bridgeStartBtn.textContent = 'Starting…';
      bridgeHint.hidden = true;
      try {
        // The native host only answers once the port is accepting connections,
        // so by here the socket is either up or coming up within the tick.
        const res = await callLocal('launch', {});
        toast(res.already ? 'Bridge was already running.' : 'Bridge started.');
        setBridgeOffline(false);
        await refreshJobBoard();
        refreshSession();
      } catch (e) {
        if (isHostMissing(e.message)) showInstallHint();
        else { bridgeHint.textContent = e.message; bridgeHint.hidden = false; }
        toast('Could not start the bridge.');
      } finally {
        bridgeStartBtn.disabled = false;
        bridgeStartBtn.textContent = label;
      }
    });

    async function refreshJobBoard() {
      try {
        const { items } = await callBg('list', {});
        setBridgeOffline(false);
        renderJobBoard(items);
      } catch (e) {
        // bridge-worker.js's own wording when the socket is down. It already
        // knows, so take its word rather than paying a round trip to ask again
        // — and this is the one branch that still works against a worker too
        // old to answer kb-local-cmd at all.
        if (/not connected to snap-bridge/i.test(e.message)) { setBridgeOffline(true); return; }
        // Anything else: confirm before blaming the bridge. A real server-side
        // error deserves its own toast, not a "start the bridge" panel for a
        // bridge that is already running.
        const st = await callLocal('status', {}, 8000).catch(() => null);
        if (st && !st.connected) { setBridgeOffline(true); return; }
        toast('Could not list KB articles: ' + e.message);
      }
    }

    // ---- the New job panel's preview ---------------------------------------
    // What a KB job produces is an article, so that is what the panel shows
    // while one runs: the log answers "what is it doing", this answers "what has
    // it made so far". Built from kb/<slug>/job.json — which the agent writes
    // after every captured step (.claude/skills/kb/SKILL.md) — so steps appear
    // as they are shot, well before the markdown is assembled, and each is a
    // live surface rather than a PNG, so it needs no render pass either.
    //
    // An authoring job cannot be told its slug up front: the article is the
    // thing it is going to make. The slug arrives with the first
    // kb_article_changed push that names one, and the bridge stamps it onto the
    // running job so a page reload mid-job picks it back up from kb_query.

    function destroyJobSurfaces() {
      jobSurfaces.forEach((s) => { try { s.destroy(); } catch (e) {} });
      jobSurfaces.clear();
    }
    function showJobPreview(on) {
      jobPreviewWrap.hidden = !on;
      syncJobPanes();
    }
    /** The log keeps the whole column only while there is nothing above it. */
    function syncJobPanes() {
      const on = !agentWrap.hidden || !jobPreviewWrap.hidden;
      logResize.hidden = !on;
      logWrap.classList.toggle('kb-log-wrap--split', on);
    }
    function clearJobPreview() {
      destroyJobSurfaces();
      jobPreviewGen++;
      jobPreviewJob = null; jobPreviewDir = ''; jobPreviewMd = null; jobPreviewName = '';
      jobPreview.innerHTML = '';
      jobPreviewOpen.hidden = true;
    }
    /** A brand new job: nothing to show yet, and say so rather than leaving the
     *  panel looking broken for the minute before the first capture lands. */
    function resetJobPreview() {
      jobPreviewSlug = null;
      clearJobPreview();
      jobPreviewTitle.textContent = 'Waiting for the agent\u2019s first step\u2026';
    }
    /** The running job just named the article it is writing. */
    function adoptJobPreview(slug) {
      if (jobPreviewSlug === slug) return;
      jobPreviewSlug = slug;
      clearJobPreview();
      showJobPreview(true);
    }

    function firstHeading(md) {
      const m = /^#\s+(.+)$/m.exec(md || '');
      return m ? m[1].trim() : '';
    }
    /** job.json rendered as the article it is going to be, for the stretch of a
     *  job where the steps exist and the markdown does not. Deliberately the
     *  same shape the bridge's own assembleMarkdown() emits (server.js), so the
     *  preview does not re-lay-out the moment the real file lands — what you
     *  watched being built is what you get. */
    function jobToMarkdown(job, dir) {
      const rel = (out) => {
        const clean = String(out).replace(/^\.\//, '');
        return './' + (dir && clean.startsWith(dir) ? clean.slice(dir.length) : clean);
      };
      const lines = [];
      lines.push('# ' + (job.title || job.slug || 'Untitled'), '');
      if (job.intro) lines.push(String(job.intro).trim(), '');
      (job.steps || []).forEach((s, i) => {
        if (!s) return;
        const n = s.n == null ? i + 1 : s.n;
        lines.push(`## ${n}. ${(s.heading || '').trim()}`.trim(), '');
        if (s.out) lines.push(`![${(s.heading || 'Step ' + n).replace(/[[\]]/g, '')}](${rel(s.out)})`, '');
        if (s.body) lines.push(String(s.body).trim(), '');
        for (const note of s.notes || []) lines.push(`> **${note.kind || 'Note'}:** ${note.text}`, '');
      });
      if (job.outro) lines.push(String(job.outro).trim(), '');
      return lines.join('\n');
    }
    function renderJobPreview(md) {
      destroyJobSurfaces();
      jobPreviewMd = md;
      jobPreview.innerHTML = md2html(md);
      const gen = ++jobPreviewGen;
      hydrateImages({
        root: jobPreview, dir: jobPreviewDir, job: jobPreviewJob, surfaces: jobSurfaces,
        stale: () => gen !== jobPreviewGen,
        els: (step) => step.els || [],
        // The agent owns this file until its job ends, so nothing here opens the
        // editor — an edit made under it would be overwritten by the next step.
        readOnly: () => true,
        onChange: null,
        live: true,
      });
    }
    /** Re-read the article the job is building and put the change on screen.
     *  Coalesced rather than queued: pushes arrive in bursts (snap_job then
     *  snap_render_job for the same step) and every one of them wants the same
     *  thing — the current state of the file. */
    async function refreshJobPreview() {
      if (!jobPreviewSlug) return;
      // Off screen — the user went to read an article while the job runs.
      // Mounting into a display:none panel measures 0 and paints every capture
      // at its natural 2560px until a resize observation corrects it, which is
      // a flash of giant pictures on the way back in for no gain. selectNewJob()
      // refreshes instead, at the moment the panel is on screen again.
      if (newJobPanel.hidden) return;
      if (jobPreviewBusy) { jobPreviewAgain = true; return; }
      jobPreviewBusy = true;
      const slug = jobPreviewSlug;
      try {
        const data = await callBg('read', { slug });
        if (slug !== jobPreviewSlug) return;    // the user started another job mid-flight
        jobPreviewJob = data.job || null;
        jobPreviewDir = mdDirOf(data.mdRel);
        jobPreviewName = (jobPreviewJob && jobPreviewJob.title) || firstHeading(data.md) || slug;
        const n = jobPreviewJob && Array.isArray(jobPreviewJob.steps) ? jobPreviewJob.steps.length : 0;
        const count = `${n} step${n === 1 ? '' : 's'}`;
        jobPreviewTitle.textContent = jobStatus === 'running'
          ? `Building \u201c${jobPreviewName}\u201d \u2014 ${count} so far`
          : `\u201c${jobPreviewName}\u201d \u2014 ${count}`;
        jobPreviewOpen.hidden = false;
        // The markdown is assembled once, near the end of the job; until then
        // job.json is the only thing that exists, and rendering it is the whole
        // reason this preview is worth showing early.
        const md = (data.md || '').trim() ? data.md : (jobPreviewJob ? jobToMarkdown(jobPreviewJob, jobPreviewDir) : '');
        if (md !== jobPreviewMd) {
          // A new step, or the real markdown replacing the stand-in — so there
          // are new images, and the ones already cached for this article's steps
          // may have just been re-rendered under their old paths.
          for (const s of (jobPreviewJob && jobPreviewJob.steps) || []) {
            if (s && s.out) imageCache.delete(String(s.out).replace(/^\.\//, ''));
          }
          renderJobPreview(md);
        } else {
          // Same article, annotations moved: patch the surfaces in place so
          // nothing scrolls under someone who is reading it.
          for (const [key, inst] of jobSurfaces) {
            const step = stepFor(key, jobPreviewJob);
            if (step) inst.setJobEls(step.els || []);
          }
        }
      } catch (e) {
        // kb_read throws until the agent has written anything at all — the
        // normal state for the first minute of a job, not worth a toast per push.
      } finally {
        jobPreviewBusy = false;
        if (jobPreviewAgain) { jobPreviewAgain = false; refreshJobPreview(); }
      }
    }
    jobPreviewOpen.addEventListener('click', () => {
      if (jobPreviewSlug) selectArticle(jobPreviewSlug, jobPreviewName || jobPreviewSlug);
    });

    // ---- UI state -------------------------------------------------------------
    function updateControls() {
      const running = jobStatus === 'running';
      startBtn.hidden = running;
      stopBtn.hidden = !running;
      startBtn.disabled = running || !instructionInput.value.trim() || !sessionTabs.length;
      instructionInput.disabled = uploadBtn.disabled = sessionRefreshBtn.disabled = running;
      // One job at a time is enforced by the bridge (kb-job.js keeps a single
      // currentJob), so an authoring job locks this box too — better a
      // disabled button than a rejected start the user has to read an error for.
      articleSendBtn.disabled = running || !selectedSlug || !articlePrompt.value.trim();
      articlePrompt.disabled = running;
      articleNewSessionBtn.disabled = running || !selectedSlug || !articleHasSession;
      statusNote.textContent = {
        idle: 'No job running', running: `Running — ${jobInstruction ? jobInstruction.slice(0, 60) : ''}`,
        done: 'Last job finished successfully.', error: 'Last job failed — see log.',
        cancelled: 'Last job was cancelled.',
      }[jobStatus] || jobStatus;
      banner.hidden = !running;
    }
    function setStatus(s) { jobStatus = s; updateControls(); }

    // ---- wiring -----------------------------------------------------------
    instructionInput.addEventListener('input', updateControls);
    uploadBtn.addEventListener('click', () => mdInput.click());
    mdInput.addEventListener('change', () => {
      const f = mdInput.files[0];
      mdInput.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        markdown = String(reader.result || '');
        mdFilename = f.name;
        filenameEl.textContent = f.name;
      };
      reader.readAsText(f);
    });
    sessionRefreshBtn.addEventListener('click', refreshSession);
    boardNewBtn.addEventListener('click', selectNewJob);
    articleRefreshBtn.addEventListener('click', () => { if (selectedSlug) selectArticle(selectedSlug, articleTitle.textContent); });

    startBtn.addEventListener('click', async () => {
      const instruction = instructionInput.value.trim();
      if (!instruction || !sessionTabs.length) return;
      startBtn.disabled = true;
      try {
        const { id } = await callBg('start', {
          instruction, markdown, mdFilename,
          sessionTabs: sessionTabs.map((t) => ({ id: t.id, title: t.title, url: t.url })),
        });
        jobId = id;
        // Reset the mode too: a revise job may have run before this one, and
        // activeLog() routes by mode — leaving it stale sends this job's log
        // into the article panel instead of the one the user is looking at.
        jobMode = 'author';
        jobSlug = null;
        jobInstruction = instruction;
        renderLog([]);
        // Open the preview now, empty. Waiting until there is something to show
        // would mean the panel silently changes shape minutes into the job.
        resetJobPreview();
        showJobPreview(true);
        resetAgentCanvas();
        showAgentCanvas(true);
        setStatus('running');
        toast('KB job started.');
      } catch (e) {
        toast('Could not start KB job: ' + e.message);
        updateControls();
      }
    });

    // ---- prompt an agent at THIS article ----------------------------------
    // Same one-job-at-a-time machinery as "+ New job", pointed at an article
    // that already exists: no session tabs, no browser (kb-job.js's revise
    // mode), so the only inputs are this box and the files already in kb/.
    /** Whether the next prompt continues the article's conversation or opens a
     *  new one. Worth showing, not just tracking: it decides what "it" and "a
     *  bit further right" mean in the sentence the user is about to type. */
    async function refreshSessionBadge() {
      if (!selectedSlug) { articleSessionBadge.textContent = ''; articleHasSession = false; updateControls(); return; }
      const slug = selectedSlug;
      try {
        const { hasSession, turns } = await callBg('session', { slug });
        if (slug !== selectedSlug) return;      // user switched articles mid-flight
        articleHasSession = !!hasSession;
        articleSessionBadge.textContent = hasSession ? `continuing · ${turns} turn${turns === 1 ? '' : 's'}` : 'new session';
      } catch (e) {
        articleHasSession = false;
        articleSessionBadge.textContent = '';
      }
      updateControls();
    }

    articleNewSessionBtn.addEventListener('click', async () => {
      if (!selectedSlug) return;
      try {
        await callBg('session', { slug: selectedSlug, reset: true });
        articleLog.innerHTML = '';
        showArticleLog(false);
        toast('Next prompt starts a new session.');
      } catch (e) {
        toast('Could not start a new session: ' + e.message);
      }
      refreshSessionBadge();
    });

    function showArticleLog(on) { articleLogWrap.hidden = !on; }

    /* Drag the grip at a log's TOP-LEFT to make it taller. The log's bottom is
       pinned to its panel, so the edge that actually moves is the top one:
       dragging UP grows it and whatever sits above gives way (it is the flex:1
       child — the split editor in the article panel, the preview in the New job
       one). Pointer events rather than mouse ones so pen and touch work too,
       and setPointerCapture so a fast drag that outruns the 34px grip keeps
       resizing instead of stopping dead. */
    function makeLogResizer(grip, logEl) {
      const MIN_H = 64;
      const maxH = () => Math.round(window.innerHeight * 0.55);
      let dragging = false, startY = 0, startH = 0;
      grip.addEventListener('pointerdown', (ev) => {
        dragging = true;
        startY = ev.clientY;
        startH = logEl.getBoundingClientRect().height;
        try { grip.setPointerCapture(ev.pointerId); } catch (e) {}
        ev.preventDefault();     // no text selection while dragging
      });
      grip.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        logEl.style.height = Math.min(maxH(), Math.max(MIN_H, Math.round(startH + (startY - ev.clientY)))) + 'px';
      });
      const endDrag = (ev) => {
        if (!dragging) return;
        dragging = false;
        try { grip.releasePointerCapture(ev.pointerId); } catch (e) {}
      };
      grip.addEventListener('pointerup', endDrag);
      grip.addEventListener('pointercancel', endDrag);
    }
    makeLogResizer(articleLogResize, articleLog);
    makeLogResizer(logResize, logEl);

    articlePrompt.addEventListener('input', updateControls);
    articleSendBtn.addEventListener('click', async () => {
      const instruction = articlePrompt.value.trim();
      if (!instruction || !selectedSlug) return;
      // The agent reads what is SAVED on disk, not what is in the editor — so
      // unsaved edits would be invisible to it and then overwritten by it.
      if (articleDirty && !confirm('This article has unsaved edits. The agent works from the saved file and may overwrite them. Send anyway?')) return;
      articleSendBtn.disabled = true;
      try {
        const { id } = await callBg('start', { mode: 'revise', slug: selectedSlug, instruction });
        jobId = id;
        jobMode = 'revise';
        jobSlug = selectedSlug;
        jobInstruction = instruction;
        showArticleLog(true);
        renderLog([]);
        setStatus('running');
        articlePrompt.value = '';
        toast('Agent is working on this article.');
      } catch (e) {
        toast('Could not start: ' + e.message);
        updateControls();
      }
    });

    /** The agent just rewrote this article's markdown and/or re-rendered its
     *  images, so what is on screen — including every cached image data: URL —
     *  is stale. Reload it, unless the user has unsaved edits of their own, in
     *  which case say so rather than throwing their work away. */
    function afterReviseFinish() {
      if (jobMode !== 'revise' || !jobSlug || jobSlug !== selectedSlug) return;
      if (articleDirty) { toast('Agent finished — hit Refresh to load its changes (you have unsaved edits).'); return; }
      imageCache.clear();
      reloadFromDisk();
    }

    stopBtn.addEventListener('click', async () => {
      if (!jobId) return;
      stopBtn.disabled = true;
      try {
        await callBg('cancel', { id: jobId });
        setStatus('cancelled');
        toast('KB job cancelled.');
      } catch (e) {
        toast('Could not cancel KB job: ' + e.message);
      } finally {
        stopBtn.disabled = false;
      }
    });

    // ---- pick up an already-running (or just-finished) job on load, so
    // reopening/reloading the tab reflects reality instead of assuming idle.
    callBg('query', {}).then(({ job }) => {
      if (!job) return;
      jobId = job.id;
      jobMode = job.mode || 'author';
      jobSlug = job.slug || null;
      mdFilename = job.mdFilename;
      jobInstruction = job.instruction;
      if (jobMode === 'revise') showArticleLog(true);
      renderLog(job.log);
      setStatus(job.status);
      // An authoring job's article outlives the page: reopening or reloading
      // the tab mid-job has to find its way back to the preview, which is why
      // the bridge stamps the slug onto the job as soon as an agent names one.
      if (jobMode === 'author') {
        resetJobPreview();
        showJobPreview(true);
        // NOT reset: the canvas survives a page reload only if nothing clears
        // it, and a job three steps in has a capture on it worth seeing. It is
        // empty here after a reload — the agent's next snap_open fills it.
        showAgentCanvas(true);
        if (job.slug) { adoptJobPreview(job.slug); refreshJobPreview(); }
      }
    }).catch(() => {});

    refreshSession();
    refreshJobBoard();
    updateControls();
  }

  window.SnapKit.kb = { init };
})();
