/* bridge-kb.js — KB tab side of topology B. Unlike bridge-editor.js (which
   only ever ANSWERS commands the bridge sends down), this file is the
   INITIATOR: it uploads a spec + allowed domain, asks the service worker to
   relay a kb_start/kb_cancel/kb_query over the existing /ext WebSocket (see
   src/bridge-worker.js's callBridge()), and renders the kb_progress lines
   the bridge pushes back as the spawned agent works. See KB-BRIDGE.md mục 7
   for the full design and snap-bridge/kb-job.js for the other end of this.

   Same init(deps) wiring convention as lab.js / export.js / bridge-editor.js. */
(() => {
  window.SnapKit = window.SnapKit || {};
  const hasExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  const $ = (s) => document.querySelector(s);

  function init(deps) {
    if (!hasExt) return;
    const { toast } = deps;

    const uploadBtn = $('#kbUploadBtn');
    const mdInput = $('#kbMdInput');
    const filenameEl = $('#kbFilename');
    const domainInput = $('#kbDomainInput');
    const startBtn = $('#kbStartBtn');
    const stopBtn = $('#kbStopBtn');
    const statusNote = $('#kbStatusNote');
    const logEl = $('#kbLog');
    const banner = $('#kbBanner');

    let markdown = null;
    let mdFilename = null;
    let jobId = null;
    let jobStatus = 'idle';   // idle | running | done | error | cancelled

    // ---- relay to the service worker, reqId-matched broadcast reply — same
    // reasoning as bridge-editor.js's own reply(): an MV3 sendMessage
    // callback is not a reliable channel across a service-worker wake cycle.
    const waiters = new Map();
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'kb-bridge-reply') {
        const w = waiters.get(msg.reqId);
        if (!w) return;
        waiters.delete(msg.reqId);
        if (msg.ok) w.resolve(msg.data); else w.reject(new Error(msg.error || 'snap-bridge reported an error with no message'));
      } else if (msg.type === 'kb-progress') {
        appendLine(msg.line);
      }
    });
    function callBg(cmd, args) {
      return new Promise((resolve, reject) => {
        const reqId = 'kbui_' + Math.random().toString(36).slice(2, 10);
        waiters.set(reqId, { resolve, reject });
        chrome.runtime.sendMessage({ type: 'kb-bridge-cmd', reqId, cmd, args }, () => void chrome.runtime.lastError);
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
        logEl.innerHTML = '<p class="empty-hint">Choose a spec file and an allowed domain, then hit Start. Progress from the agent — what it navigates to, what it annotates, what it writes — appears here as it happens.</p>';
        return;
      }
      lines.forEach(appendLine);
    }

    // ---- UI state -------------------------------------------------------------
    function updateControls() {
      const running = jobStatus === 'running';
      startBtn.hidden = running;
      stopBtn.hidden = !running;
      startBtn.disabled = running || !markdown || !domainInput.value.trim();
      mdInput.disabled = uploadBtn.disabled = running;
      domainInput.disabled = running;
      statusNote.textContent = {
        idle: 'No job running', running: `Running — ${mdFilename || ''}`,
        done: 'Last job finished successfully.', error: 'Last job failed — see log.',
        cancelled: 'Last job was cancelled.',
      }[jobStatus] || jobStatus;
      banner.hidden = !running;
    }
    function setStatus(s) { jobStatus = s; updateControls(); }

    // ---- wiring -----------------------------------------------------------
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
        updateControls();
      };
      reader.readAsText(f);
    });
    domainInput.addEventListener('input', updateControls);

    startBtn.addEventListener('click', async () => {
      if (!markdown || !domainInput.value.trim()) return;
      startBtn.disabled = true;
      try {
        const { id } = await callBg('start', { markdown, allowedDomain: domainInput.value.trim(), mdFilename });
        jobId = id;
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
      renderLog(job.log);
      setStatus(job.status);
    }).catch(() => {});

    updateControls();
  }

  window.SnapKit.kb = { init };
})();
