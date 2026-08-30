#!/usr/bin/env node
/* render.mjs — render ảnh KB đã chú thích bằng Chromium headless.

   Nạp CHÍNH src/editor.html qua file://, gọi window.SnapKit.render.* (xem
   src/render-api.js), rồi chụp #stage bằng Playwright.

   Vì sao không dùng đường cũ (`snap_export` → captureVisibleTab): bản xuất khi
   đó không bao giờ lớn hơn cửa sổ trình duyệt — cửa sổ nhỏ hơn khung ảnh thì
   ảnh **bị cắt** (KB-BRIDGE.md mục 2). Đường này đo bằng viewport headless tự
   đặt theo đúng kích thước ảnh, nên bẫy đó không tồn tại, và cũng không chiếm
   dụng cửa sổ thật của người dùng.

   Dùng như một module (server.js gọi renderSteps) hoặc chạy thẳng:
     node render.mjs <spec.json>
   với spec.json = { steps: [{ src, out, els: [{type, props}] }], scale? }
   `src` / `out` là đường dẫn tương đối so với kb/.  */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import childProcess from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EDITOR_URL = pathToFileURL(path.join(REPO_ROOT, "src", "editor.html")).href;

/** Render nhiều bước trong MỘT phiên trình duyệt — mở Chromium mỗi ảnh là lãng
 *  phí phần lớn thời gian của lệnh. Mỗi bước: nạp ảnh nền → thêm annotation →
 *  bật render mode → chụp #stage → dọn element cho bước sau.
 *
 *  @param steps [{ srcAbs, outAbs, els: [{type, props}] }]
 *  @param opts  { scale, accent }
 *                 scale  = deviceScaleFactor (mặc định 2)
 *                 accent = mã hex accent của người dùng. BẮT BUỘC truyền nếu
 *                          muốn ảnh trùng màu với bản render trong extension:
 *                          accent-ramp.js đọc accent từ chrome.storage.local
 *                          (trong extension) hoặc localStorage (ngoài), mà
 *                          headless file:// không có cái nào — nên nếu không
 *                          truyền, nó rơi về DEFAULT_500 (#1350DE, xanh) và mọi
 *                          annotation đổi màu so với bản người dùng thấy. Đã gặp
 *                          thật lần chạy đầu.
 *  @returns [{ out, width, height }]
 */
/** Chạy fn() với child_process.spawn bị ép windowsHide — rồi trả lại nguyên trạng.
 *
 *  Vì sao cần: `chrome-headless-shell.exe` là binary **console subsystem**, và
 *  launchProcess() của playwright-core dựng spawnOptions KHÔNG có `windowsHide`
 *  (chỉ có detached cho non-win32). server.js lại được native host spawn detached,
 *  không thừa kế console nào — nên Windows cấp cho headless shell một console mới,
 *  kéo theo conhost.exe và **một cửa sổ Windows Terminal nhảy lên** mỗi lần render.
 *  Đo được trực tiếp: chrome-headless-shell.exe, conhost.exe, OpenConsole.exe và
 *  WindowsTerminal.exe sinh ra trong cùng 3 mili-giây ngay khi `snap_export` chạy.
 *
 *  `windowsHide: true` = cờ CREATE_NO_WINDOW: tiến trình vẫn có console, chỉ là
 *  console không có cửa sổ. Playwright nói chuyện với browser qua
 *  `--remote-debugging-pipe` (fd 3/4), không qua console, nên cờ này không đụng gì
 *  tới đường điều khiển.
 *
 *  Vá bằng monkey-patch vì Playwright không hở tuỳ chọn spawn nào ra API công khai.
 *  Phạm vi hẹp nhất có thể: chỉ bọc đúng lời gọi launch(), rồi khôi phục trong
 *  finally — không để lại patch toàn cục cho phần còn lại của tiến trình. Không
 *  phải no-op trên Linux/macOS thì Node bỏ qua cờ này, nên không cần rẽ nhánh
 *  theo platform.
 *
 *  Đường còn lại là `channel: "chromium"` (dùng bản Chromium đầy đủ, chrome.exe
 *  là GUI subsystem nên không cấp console). Không chọn: nó đổi hẳn build trình
 *  duyệt đang render ảnh KB, tức đổi cả kết quả render — cái giá quá lớn cho một
 *  cửa sổ console. */
async function withHiddenConsole(fn) {
  const origSpawn = childProcess.spawn;
  childProcess.spawn = function (cmd, args, opts) {
    if (opts && typeof opts === "object" && !Array.isArray(opts)) opts = { ...opts, windowsHide: true };
    return origSpawn.call(this, cmd, args, opts);
  };
  try { return await fn(); }
  finally { childProcess.spawn = origSpawn; }
}

export async function renderSteps(steps, opts = {}) {
  const scale = opts.scale || 2;
  const pw = await import("playwright");
  const browser = await withHiddenConsole(() => pw.chromium.launch());
  const results = [];
  const pageErrors = [];
  try {
    // Viewport phải đủ lớn để #stage nằm trọn ở kích thước tự nhiên — nếu không
    // getBoundingClientRect() trả hộp bị viewport cắt và ta lại rơi đúng vào bẫy
    // của đường cũ. Đặt theo ảnh lớn nhất trong lô, cộng lề cho padding của stage.
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: scale });
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));

    // Gieo accent TRƯỚC khi script của trang chạy — accent-ramp.js đọc nó ngay
    // lúc khởi tạo, nên set sau khi load là muộn. Dùng đúng khoá localStorage
    // của accent-ramp.js ('snapstudio.accentColor') để đi qua chính đường load()
    // của app, không phải override CSS từ ngoài.
    if (opts.accent) {
      await page.addInitScript((hex) => {
        try { localStorage.setItem("snapstudio.accentColor", hex); } catch (e) {}
      }, opts.accent);
    }

    await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.SnapKit && window.SnapKit.render, null, { timeout: 15000 });

    for (const step of steps) {
      const dataUrl = "data:image/png;base64," + readFileSync(step.srcAbs).toString("base64");
      const size = await page.evaluate(async (u) => window.SnapKit.render.open({ dataUrl: u }), dataUrl);

      // Viewport theo đúng ảnh + lề: stage ở render mode là ảnh ở kích thước tự
      // nhiên (cộng padding khi bật screenshot-canvas), nên viewport phải bao được nó.
      await page.setViewportSize({ width: Math.ceil(size.width) + 120, height: Math.ceil(size.height) + 120 });

      if (step.rawEls) {
        // Nguyên trạng từ một editor thật (snap_export) — không tái dựng qua
        // newElement(), xem chú thích của setEls() trong src/render-api.js.
        await page.evaluate((els) => window.SnapKit.render.setEls(els), step.rawEls);
      } else {
        for (const el of step.els || []) {
          await page.evaluate((e) => window.SnapKit.render.add(e), { type: el.type, props: el.props || {} });
        }
      }

      const box = await page.evaluate(async () => window.SnapKit.render.renderMode());
      if (box.width < 1 || box.height < 1) throw new Error(`#stage measured ${box.width}x${box.height} — nothing to capture`);
      await page.waitForTimeout(140);   // cho backdrop-filter paint xong

      mkdirSync(path.dirname(step.outAbs), { recursive: true });
      const handle = await page.$("#stage");
      if (!handle) throw new Error("#stage not found in the editor page");
      await handle.screenshot({ path: step.outAbs });

      await page.evaluate(() => { window.SnapKit.render.exitRenderMode(); window.SnapKit.render.reset(); });
      results.push({ out: step.outAbs, width: Math.round(box.width * scale), height: Math.round(box.height * scale) });
    }
  } finally {
    await browser.close();
  }
  if (pageErrors.length) console.error("[render] page errors:", pageErrors.join(" | "));
  return results;
}

// ---- CLI ------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const specPath = process.argv[2];
  if (!specPath) { console.error("usage: node render.mjs <spec.json>"); process.exit(1); }
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const KB = path.join(REPO_ROOT, "kb");
  const steps = spec.steps.map((s) => ({
    srcAbs: path.resolve(KB, s.src), outAbs: path.resolve(KB, s.out), els: s.els || [],
  }));
  renderSteps(steps, { scale: spec.scale, accent: spec.accent })
    .then((r) => { for (const x of r) console.log(`  ✓ ${path.relative(KB, x.out)} — ${x.width}x${x.height}`); })
    .catch((e) => { console.error("render failed:", e.message); process.exit(1); });
}
