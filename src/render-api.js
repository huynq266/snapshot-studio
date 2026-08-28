/* render-api.js — mặt API để render bài KB NGOÀI trình duyệt của người dùng.

   Vì sao tồn tại: `export.js`'s renderToPngDataUrl() chụp lại chính tab editor
   qua chrome.runtime → captureVisibleTab, nên bản xuất **không bao giờ lớn hơn
   cửa sổ** — cửa sổ nhỏ hơn khung ảnh thì ảnh bị cắt (xem chính đoạn cảnh báo
   trong export.js, và KB-BRIDGE.md mục 2). Nó cũng chiếm dụng cửa sổ thật của
   người dùng trong lúc render.

   Đường đi mới: `snap-bridge/render.mjs` mở editor.html trong Chromium headless
   qua file://, gọi ba hàm dưới đây, rồi tự chụp #stage bằng Playwright. Không
   phụ thuộc kích thước cửa sổ, không cần maximize, không cần .render-veil.

   Cố ý KHÔNG có guard `hasExt`: đây là đường duy nhất chạy khi extension API
   *không* tồn tại (file://). bridge-editor.js thì ngược lại — nó return sớm khi
   !hasExt, nên hai file không giẫm chân nhau.

   Cùng quy ước init(deps) như lab.js / export.js / bridge-editor.js: editor.js
   gọi một lần ở cuối, sau khi state và render() đã tồn tại. */
(() => {
  window.SnapKit = window.SnapKit || {};

  function init(deps) {
    const { getCapture, loadCapture, newElement, select, toast, render } = deps;

    /** Nạp một ảnh làm capture nền. Cùng đường với bridge-editor.js's cmdOpen(),
     *  trừ setView('snap') — headless không có tab nào để chuyển. */
    async function open({ dataUrl, url }) {
      await loadCapture({
        id: 'render_' + Math.random().toString(36).slice(2, 8),
        dataUrl, url: url || '', rect: null, note: 'Loaded for headless render.',
      });
      const c = getCapture();
      return { width: c.img.w, height: c.img.h };
    }

    /** Giống hệt bridge-editor.js's cmdAdd() — đi thẳng capture.els.push() thay
     *  vì editor.js's addElement(), vốn special-case 'arrow' thành kéo-thả
     *  tương tác (vô nghĩa khi không có chuột). */
    function add({ type, props }) {
      const capture = getCapture();
      if (!capture) throw new Error('no capture is open — call open() first');
      const el = newElement(type);
      if (!el) throw new Error(`unknown component type "${type}"`);
      Object.assign(el, props || {});
      capture.els.push(el);
      select(el.id);
      return { id: el.id, ...(el.type === 'arrow'
        ? { x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2 }
        : { x: el.x, y: el.y }) };
    }

    /** Bật body.render: gỡ chrome của editor, đưa #stage về đúng kích thước tự
     *  nhiên (xem editor.css). Đây là trạng thái Playwright chụp.
     *
     *  Khác export.js's renderToPngDataUrl(): KHÔNG đụng .render-veil. Veil tồn
     *  tại để che "cú giật hình" trước mắt người dùng khi tab thật đổi layout —
     *  headless không có ai nhìn, mà veil lại chính là thứ từng làm hỏng bản
     *  xuất (nó phủ kín màn hình đúng lúc chụp; xem KB-BRIDGE.md "Kết quả trial",
     *  lỗi 1). Không dùng veil thì lỗi đó không thể tái diễn ở đường này.
     *
     *  Trả về hộp của #stage để bên gọi biết chụp vùng nào (và để đối chiếu với
     *  kích thước ảnh nguồn). */
    async function renderMode() {
      document.body.classList.add('render');
      // hai rAF: một để flush class, một để backdrop-filter kịp paint thật
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
      const stage = document.getElementById('stage');
      const b = stage.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }

    function exitRenderMode() { document.body.classList.remove('render'); }

    /** Gán thẳng cả mảng element, không dựng lại qua newElement().
     *
     *  Dùng khi render lại đúng state một editor thật đang có (snap_export):
     *  đi vòng qua newElement() + Object.assign sẽ mất những gì không nằm trong
     *  defaults() của type — element `image` dán từ clipboard chẳng hạn không hề
     *  có defaults(), nên tái dựng nó là bất khả. Sao chép nguyên trạng thì
     *  không có đường nào để mất dữ liệu cả. */
    function setEls(els) {
      const c = getCapture();
      if (!c) throw new Error('no capture is open — call open() first');
      c.els.length = 0;
      for (const el of els || []) c.els.push(el);
      render();
    }

    /** Xoá sạch capture đang mở — để render nhiều bước liên tiếp trong cùng một
     *  trang mà bước sau không dính element của bước trước. */
    function reset() {
      const c = getCapture();
      if (c) c.els.length = 0;
    }

    window.SnapKit.render = { open, add, setEls, renderMode, exitRenderMode, reset, toast };
  }

  window.SnapKit.renderApi = { init };
})();
