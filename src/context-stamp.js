/* Context stamp — browser · OS · image size · URL · time, rendered as a
   .cmp-label element (see components/label.js's "stamp" registration) and
   as the plain-text block the "Copy context" button puts on the clipboard.
   Pure text/parsing helpers, no DOM state of their own — callers hand in
   whichever `capture` they mean. */
(() => {
  window.SnapKit = window.SnapKit || {};

  function parseUA() {
    const ua = navigator.userAgent;
    let browser = 'Browser', v = '';
    let m;
    if ((m = ua.match(/Edg\/([\d.]+)/))) { browser = 'Edge'; v = m[1]; }
    else if ((m = ua.match(/OPR\/([\d.]+)/))) { browser = 'Opera'; v = m[1]; }
    else if ((m = ua.match(/Chrome\/([\d.]+)/))) { browser = 'Chrome'; v = m[1]; }
    else if ((m = ua.match(/Firefox\/([\d.]+)/))) { browser = 'Firefox'; v = m[1]; }
    else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) { browser = 'Safari'; v = m[1]; }
    let os = 'OS';
    if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
    else if (/Windows NT/.test(ua)) os = 'Windows';
    else if (/Mac OS X [\d_]+/.test(ua)) os = 'macOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/iPhone|iPad/.test(ua)) os = 'iOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    return { browser, v: v.split('.').slice(0, 2).join('.'), os };
  }

  function hostPath(url) {
    try { const u = new URL(url); return u.host + (u.pathname === '/' ? '' : u.pathname); }
    catch (e) { return url || ''; }
  }

  function stampText(capture) {
    const { browser, v, os } = parseUA();
    const t = capture.capturedAt.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    return [`${browser} ${v}`, os, `${capture.img.w}×${capture.img.h}`, hostPath(capture.url), t].filter(Boolean).join(' · ');
  }

  function contextText(capture) {
    const { browser, v, os } = parseUA();
    return [
      `Trình duyệt: ${browser} ${v}`, `Hệ điều hành: ${os}`,
      `Kích thước ảnh: ${capture.img.w}×${capture.img.h}px`,
      `URL: ${capture.url || '(tải lên thủ công, không có URL)'}`,
      `Thời điểm chụp: ${capture.capturedAt.toLocaleString('vi-VN')}`,
    ].join('\n');
  }

  window.SnapKit.contextStamp = { parseUA, hostPath, stampText, contextText };
})();
