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
    const { toast } = deps;

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

    let markdown = null;
    let mdFilename = null;
    let sessionTabs = [];       // tabs already added — {id, title, url}
    let candidateTabs = [];     // other open tabs, not yet added
    let jobId = null;
    let jobStatus = 'idle';   // idle | running | done | error | cancelled
    let jobInstruction = null;
    let selectedSlug = null;   // null = "+ New job" panel; otherwise an existing article's slug
    let articleKind = null;    // 'file' | 'job' — from the last kb_read, needed to resolve image paths
    let articleDirty = false;  // unsaved edits in the article editor
    let comments = [];         // the selected article's positioned comments
    let commentMode = false;
    let activePopover = null;
    let suppressPopoverAutoClose = false;
    const imageCache = new Map();   // resolved kb/-relative path -> dataUrl | null (null = failed)

    // ---- relay to the service worker, reqId-matched broadcast reply — same
    // reasoning as bridge-editor.js's own reply(): an MV3 sendMessage
    // callback is not a reliable channel across a service-worker wake cycle.
    const waiters = new Map();
    const sessionWaiters = new Map();
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
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
        if (msg.line.startsWith('Job finished')) { setStatus('done'); refreshJobBoard(); }
        else if (msg.line.startsWith('Job failed') || msg.line.startsWith('Job crashed')) { setStatus('error'); }
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

    // ---- log rendering ------------------------------------------------------
    function lineClass(line) {
      if (line.startsWith('→ ')) return 'kb-log-line--tool';
      if (line.startsWith('Denied ')) return 'kb-log-line--denied';
      if (line.startsWith('Job finished')) return 'kb-log-line--done';
      if (line.startsWith('Job failed') || line.startsWith('Job crashed')) return 'kb-log-line--error';
      return '';
    }
    function appendLine(line) {
      const p = document.createElement('p');
      p.className = 'kb-log-line ' + lineClass(line);
      p.textContent = line;
      logEl.appendChild(p);
      logEl.scrollTop = logEl.scrollHeight;
    }
    function renderLog(lines) {
      logEl.innerHTML = '';
      if (!lines || !lines.length) {
        logEl.innerHTML = '<p class="empty-hint">Write an instruction and add at least one session tab, then hit Start. Progress from the agent — what it navigates to, what it annotates, what it writes — appears here as it happens.</p>';
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
    function resolveImagePath(rawSrc) {
      if (/^([a-z]+:)?\/\//i.test(rawSrc) || rawSrc.startsWith('data:')) return null;   // remote/data URL — nothing to fetch
      const cleaned = rawSrc.replace(/^\.\//, '');
      return articleKind === 'job' && selectedSlug ? `${selectedSlug}/${cleaned}` : cleaned;
    }
    async function hydrateImages() {
      const wraps = Array.from(articlePreview.querySelectorAll('.kb-md-imgwrap[data-src]'));
      await Promise.all(wraps.map(async (wrap) => {
        const resolved = resolveImagePath(wrap.dataset.src);
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
      }));
    }
    function renderPreview() {
      articlePreview.innerHTML = md2html(articleEditor.value);
      renderCommentPins();
      hydrateImages();
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
      pop.append(p, actions);
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
            articlePreview.innerHTML = md2html(md);
            hydrateImages();
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
    // Every board-switching action funnels through here so an in-progress
    // edit is never silently discarded by a stray click elsewhere in the rail.
    function confirmDiscard() {
      return !articleDirty || confirm('Discard unsaved changes to this article?');
    }
    function selectNewJob() {
      if (!confirmDiscard()) return;
      closePopover();
      closeHistoryPanel();
      setDirty(false);
      selectedSlug = null;
      articleKind = null;
      comments = [];
      newJobPanel.hidden = false;
      articlePanel.hidden = true;
      boardNewBtn.dataset.selected = 'true';
      boardList.querySelectorAll('.kb-jobboard-item').forEach((li) => { li.dataset.selected = 'false'; });
    }
    async function selectArticle(slug, title) {
      if (!confirmDiscard()) return;
      closePopover();
      closeHistoryPanel();
      setDirty(false);
      selectedSlug = slug;
      articleKind = null;
      comments = [];
      newJobPanel.hidden = true;
      articlePanel.hidden = false;
      boardNewBtn.dataset.selected = 'false';
      boardList.querySelectorAll('.kb-jobboard-item').forEach((li) => { li.dataset.selected = li.dataset.slug === slug ? 'true' : 'false'; });
      articleTitle.textContent = title;
      articleEditor.value = 'Loading…';
      articleEditor.disabled = true;
      renderPreview();
      try {
        const data = await callBg('read', { slug });
        articleKind = data.kind;
        articleEditor.value = data.md || '';
        articleEditor.disabled = false;
        renderPreview();
        setDirty(false);
        refreshComments();
      } catch (e) {
        articleEditor.value = '';
        articleEditor.disabled = false;
        articlePreview.innerHTML = '';
        toast(`Could not load "${slug}": ${e.message}`);
      }
    }
    articleEditor.addEventListener('input', () => { setDirty(true); renderPreview(); });
    articleSaveBtn.addEventListener('click', async () => {
      if (!selectedSlug) return;
      articleSaveBtn.disabled = true;
      try {
        await callBg('save_md', { slug: selectedSlug, md: articleEditor.value });
        setDirty(false);
        toast('Saved.');
        refreshJobBoard();
      } catch (e) {
        toast('Could not save: ' + e.message);
        articleSaveBtn.disabled = false;
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
        setDirty(false);   // the article is gone — an unsaved-edits guard on the way out would be pointless
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
    async function refreshJobBoard() {
      try {
        const { items } = await callBg('list', {});
        renderJobBoard(items);
      } catch (e) {
        toast('Could not list KB articles: ' + e.message);
      }
    }

    // ---- UI state -------------------------------------------------------------
    function updateControls() {
      const running = jobStatus === 'running';
      startBtn.hidden = running;
      stopBtn.hidden = !running;
      startBtn.disabled = running || !instructionInput.value.trim() || !sessionTabs.length;
      instructionInput.disabled = uploadBtn.disabled = sessionRefreshBtn.disabled = running;
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
        jobInstruction = instruction;
        renderLog([]);
        setStatus('running');
        toast('KB job started.');
      } catch (e) {
        toast('Could not start KB job: ' + e.message);
        updateControls();
      }
    });

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
      mdFilename = job.mdFilename;
      jobInstruction = job.instruction;
      renderLog(job.log);
      setStatus(job.status);
    }).catch(() => {});

    refreshSession();
    refreshJobBoard();
    updateControls();
  }

  window.SnapKit.kb = { init };
})();
