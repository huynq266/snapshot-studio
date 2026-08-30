# KB Studio — kế hoạch triển khai

Kế hoạch nâng pipeline KB hiện tại (topology A + B trong `KB-BRIDGE.md`) lên thành một
**KB Studio** hoàn chỉnh, lấy ý tưởng đã được kiểm chứng từ **Guide Studio** trong
[ownegoMarketingMaterialToolkit](https://github.com/pdtoan2811-bit/ownegoMarketingMaterialToolkit)
(`tools/doc-guide/`).

- Ngày lập: 2026-08-28
- Trạng thái: **chưa triển khai phần nào** — tài liệu này là bản thiết kế để làm dần.
- Đọc trước: `KB-BRIDGE.md` (kiến trúc snap-bridge hiện có, và các bẫy đã biết).

---

## 0. Bối cảnh — hai repo cùng huyết thống

`tools/doc-guide/packages/userguidesnap/` trong repo kia **chính là tiền thân của Snap Studio**:
cùng `manifest.json`, cùng `src/editor.js` / `editor.css` / `tokens.css` / `popup.js` /
`background.js`, cùng kiến trúc MV3 + `captureVisibleTab`.

| | userGuideSnap | Snap Studio (repo này) |
|---|---|---|
| `src/editor.js` | 1151 dòng | 1166 |
| `src/editor.css` | 204 | **404** |
| `src/tokens.css` | 360 | **921** |
| `src/background.js` | 102 | **254** |
| permissions | 4 | 7 (thêm `webNavigation`, `clipboardWrite`, `desktopCapture`) |
| commands | 1 (capture) | 3 (thêm region, desktop) |

**Kết luận định hướng**: tầng editor/annotation của repo này đã đi xa hơn. Thứ repo kia có mà
đây chưa có là **toàn bộ tầng orchestration phía trên**: job spec bền vững, worker pipeline,
studio UI để review, history, comment, publish. Đây không phải "port code từ dự án lạ" — mà là
"nhánh anh em đã giải xong đúng tầng mình đang thiếu".

### Những gì ĐÃ xác minh trên máy này (không phải suy đoán)

Các phase dưới đây dựa trên bốn điều đã đọc thẳng từ mã nguồn repo này, ngày 2026-08-28:

1. **`editor.js` đã tự degrade khi không chạy trong extension.**
   `src/editor.js:30` — `hasExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id`.
   Mọi đường dùng `chrome.*` đều nằm sau guard này (`editor.js:1145`, `:1160`, `export.js:63`).
   Nạp `editor.html` qua `file://` trong Chromium headless → `hasExt === false` → không lỗi.
   **Đây là điều làm Phase 1 khả thi.**
2. **`#stage` tồn tại** (`editor.html:107`) — đúng phần tử mà `render.mjs` của repo kia chụp
   (`page.$('#stage').screenshot()`). Không cần dựng lại gì về mặt DOM.
3. **`renderToPngDataUrl()` là chỗ duy nhất phụ thuộc `chrome.runtime`** (`export.js:63`,
   `sendMessage({type:'capture-for-export'})`), và cũng chính là chỗ chứa bẫy cắt ảnh
   (`export.js:79-84`: cửa sổ nhỏ hơn khung → ảnh bị cắt). Render headless đi đường khác hoàn
   toàn nên bẫy này biến mất, không phải "vá" nó.
4. **`loadCapture()` là một hàm nội bộ của IIFE trong `editor.js`**, không nằm trên `window`.
   Nó được truyền vào `export.js` dạng dep (`export.js:19`). `window.SnapKit` hiện có
   `.export`, `.bridge`, `.kb`, `.library`, `.lab`, `.accent`, `.contextStamp` — **chưa có mặt
   API nào cho render ngoài-extension**. Phase 1 phải thêm mặt đó.

### Khác biệt mô hình dữ liệu — điều cần biết trước khi chép ý tưởng

| | userGuideSnap | Snap Studio |
|---|---|---|
| Đơn vị làm việc | `guide.json` có `slides[]`, **nhiều slide một lúc** | **một capture singleton** (`capture` + `els`) |
| API render | `window.__ugs.slideCount()` / `gotoSlide(i)` / `renderMode()` | chưa có |
| Nguồn ảnh | Playwright chụp app | `captureVisibleTab` trên profile Chrome thật |

**Không đổi mô hình singleton sang multi-slide.** Nó kéo theo sửa lớn `editor.js`, `library.js`,
session restore, và không mang lại gì cho KB — vòng lặp "một ảnh, chú thích, xuất, ảnh tiếp
theo" đã đúng. Phase 1 vì thế **lặp từng capture một** trong headless, không cần `slideCount`/
`gotoSlide`.

### Điều KHÔNG lấy từ repo kia

- **Playwright để chụp app.** Repo này cố ý không dùng được (MV3, xem README "How export
  actually works"), và **không nên đổi**: đường hiện tại chạy trên **profile Chrome thật đang
  đăng nhập**, vào thẳng Shopify admin không phải xử lý login/2FA (`KB-BRIDGE.md` mục 5.2).
  Playwright sẽ phải giải lại bài toán đăng nhập từ đầu. Playwright chỉ dùng cho **render**
  (Phase 1), không dùng cho **capture**.
- **`marketing.config.json` project-agnostic.** Repo kia cần vì phục vụ nhiều dự án; KB ở đây
  tập trung vào app Qikify. Thêm tầng config lúc này là phức tạp hoá sớm.
- **`publish.mjs` → Astro Starlight.** Chỉ đáng làm nếu team có docs repo — chưa xác nhận.

---

## 1. Nguyên tắc chung cho mọi phase

1. **Mỗi phase phải tự chạy được và tự kiểm chứng được**, không phụ thuộc phase sau. Thứ tự
   dưới đây là thứ tự phụ thuộc thật, không phải thứ tự ưu tiên tuỳ ý.
2. **Không đụng đường capture hiện có.** `snap_capture_tab` → `background.js` →
   `shootVisibleTab()` đang chạy đúng trên profile thật. Mọi thay đổi chỉ ở tầng render, spec,
   và UI.
3. **Đang thao tác trên store thật.** Mọi bước tự kiểm chứng có click vào app phải kèm bước dọn
   dẹp (Discard / khôi phục state gốc). Xem `KB-BRIDGE.md`, phần iframe cross-origin.
4. **Ghi lại cái sai, không chỉ cái đúng.** `KB-BRIDGE.md` đã có tiền lệ: mục "Ba bug tự gây ra"
   giá trị hơn phần mô tả tính năng. Giữ thói quen đó.

---

## Phase 0 — `/kb` skill + placement playbook ✅ ĐÃ XONG (2026-08-28)

**Rẻ nhất, không phụ thuộc gì, dùng được ngay cho cả topology A lẫn B.** Làm trước.

> **Đã dựng**: `.claude/skills/kb/SKILL.md`, `.claude/skills/kb/PLACEMENT_PLAYBOOK.md`,
> và `snap-bridge/kb-job.js` giờ đọc hai file đó làm system prompt (giữ HARD CONSTRAINT
> domain trong code, không đưa vào file skill sửa được).
>
> **Giả định sai đã phát hiện khi làm** — đúng rủi ro mục này cảnh báo: canvas ~1128×660 là
> của engine repo kia và **hoàn toàn không đúng ở đây**. `.stage` là `display:inline-block`
> co theo `#baseImg` (`editor.css:94`), nên vùng vẽ **chính là kích thước ảnh chụp**
> (`capture.img.w × capture.img.h`) — biến thiên, đọc từ response `snap_capture_tab`.
> Nếu chép thẳng số của họ thì playbook đã dạy sai ngay từ dòng đầu.
>
> **Bẫy thứ hai phát hiện thêm**: ngữ nghĩa `x/y` **khác nhau theo từng type** —
> `zoom` là **tâm** (`editor.js:457`), `textbox` là **góc trên-trái** (có comment giải thích
> ngay trong `textbox.js:31`), phần còn lại là góc trên-trái. Nhầm hai cái lệch đúng 99px.
> Đã ghi thành bảng trong playbook.

### Vấn đề đang có

System prompt của KB job hiện là **một string nhúng trong `snap-bridge/kb-job.js:56-64`** —
khó đọc, khó sửa, không version hoá riêng được, và **không dùng được cho topology A** (khi
người dùng gõ trực tiếp trong Claude Code, không qua UI).

Bài KB đầu tiên (`kb/multibuy-percentage-discount-per-combo-vs-highest-tier.md`, 2026-08-28)
lộ ra ba lỗi chất lượng mà một playbook sẽ chặn được:

- Step 4 bị **cắt ở mép dưới khung ảnh** (tier settings nằm ngoài viewport chụp).
- Step 5 **đè lên** link "more products" — callout nằm trên nội dung.
- Ảnh lộ **tên tài khoản thật `huynq-vl`** ở thanh nav — chưa blur PII (`KB-BRIDGE.md` 5.4).

### Việc cần làm

1. **`.claude/skills/kb/SKILL.md`** — skill chính. Nội dung tối thiểu:
   - Đọc spec `.md` → lên kế hoạch từng bước (1 màn hình / 1 bước).
   - Chuỗi tool: `snap_capture_tab` → `snap_open` → `snap_kit` (nếu chưa chắc chọn component gì)
     → `snap_add` → `snap_export` → `snap_write_kb` (đúng một lần, cuối cùng).
   - **Bài học iframe cross-origin**: nếu `mcp__chrome__scroll/find/click` chạy mà không đổi gì
     (cuộn không nhúc nhích, `find` trả 0 match cho text đang hiện rõ) → nội dung nằm trong
     iframe cross-origin → chuyển sang `snap_frame_list` → `snap_frame_find` →
     `snap_frame_scroll`/`snap_frame_click`. **Không lặp lại tool cũ.**
   - **Kỷ luật dọn dẹp**: đang ở store thật — sau khi click thử phải Discard, không để lại
     "Unsaved changes".
   - **Kỷ luật PII**: chủ động đề xuất `blur` lên vùng chứa tên tài khoản / email / dữ liệu
     khách trước khi `snap_export`.
2. **`.claude/skills/kb/PLACEMENT_PLAYBOOK.md`** — luật đặt annotation. Chép **tinh thần** từ
   `annotate/PLACEMENT_PLAYBOOK.md` của repo kia, nhưng **số đo phải đo lại của repo này**
   (canvas ~1128×660 là của engine họ, không nhất thiết đúng ở đây — xem "Rủi ro" dưới):
   - **#0 (hard rule)** Không gì được tràn khỏi khung ảnh. Callout bị cắt = hỏng, không phải
     "chấp nhận được".
   - **#0b** Callout **không bao giờ** đè hoặc nằm ngay trên target của nó — đặt lệch sang bên,
     chừa khoảng trống để mũi tên đi một quãng nhìn thấy được.
   - **#0c (hard rule)** Xác minh target **tồn tại, hiện rõ, đúng state** trong *capture này*
     trước khi đặt annotation. Mũi tên chỉ vào chỗ trống = lỗi **capture**, sửa bước chụp,
     không phải dời callout.
   - **#0a** Đừng đổ lỗi cho engine khi annotation trông sai — gần như luôn là placement hoặc
     capture. *(Bài học đã trả giá 6 vòng thử sai ngày 2026-08-28 — xem `KB-BRIDGE.md`.)*
   - **Step 1 định vị trong menu** — trả lời câu hỏi đầu tiên của người đọc: "bấm đâu để tới
     màn hình này?"
   - **Mỗi bài ≥1 magnifier/zoom** lên đúng chi tiết nhỏ mà bước đó nói về, thay vì tả bằng lời.
3. **`kb-job.js` đọc file skill làm system prompt** thay vì hard-code string. Giữ nguyên phần
   HARD CONSTRAINT về domain allowlist (đó là ràng buộc an toàn, không phải hướng dẫn phong
   cách — không được để nó lẫn vào file skill mà người dùng có thể sửa).

### Files đụng tới
`.claude/skills/kb/SKILL.md` (mới), `.claude/skills/kb/PLACEMENT_PLAYBOOK.md` (mới),
`snap-bridge/kb-job.js` (đọc file thay vì string).

### Tự kiểm chứng
Chạy lại đúng bài KB cũ (multibuy percentage vs highest tier) với skill mới, đối chiếu:
Step 4 còn bị cắt không, Step 5 còn đè nội dung không, có blur `huynq-vl` không.
**So sánh trực tiếp với `kb/img/01-multibuy-offer-settings-annotated.png` hiện có.**

### Rủi ro / điều chưa chắc
- **Con số canvas ~1128×660 là của engine repo kia, chưa đo ở repo này.** Phải đo `#stage`
  thật trước khi viết số vào playbook, nếu không playbook sẽ dạy sai ngay từ đầu.
- Playbook chỉ có giá trị nếu **được cập nhật khi phát hiện lỗi mới**. Nếu không có thói quen
  append learning, nó sẽ thành tài liệu chết trong 2 tuần.

---

## Phase 1 — Render headless, xoá bẫy cắt ảnh ✅ ĐÃ XONG (2026-08-28)

**Giá trị cao nhất về mặt kỹ thuật.** Độc lập với Phase 0.

> **Đã dựng**: `src/render-api.js` (mặt `SnapKit.render` — `open`/`add`/`setEls`/`renderMode`),
> `snap-bridge/render.mjs` (Playwright), `snap_export` chuyển sang đường headless, cộng
> `get_els` (`bridge-editor.js`) và `get_accent` (`bridge-worker.js`) để renderer lấy đúng
> state + màu của editor thật.
>
> **Bằng chứng quyết định** — đúng nhánh `KB-BRIDGE.md` ghi là "chưa bao giờ ép được xảy ra
> thật": render ảnh nguồn **3000×2000**, lớn hơn mọi cửa sổ Chrome trên máy này, ra file
> **đủ 3000×2000 không cắt** (`kb/img/big-rendered.png`). Đường cũ `captureVisibleTab` về mặt
> vật lý không làm được — nó chụp tab đang hiện, nên bản xuất luôn ≤ kích thước cửa sổ.
>
> **Ba rủi ro kế hoạch nêu — kết quả thật:**
> - *Playwright nặng*: thực tế **299MB** `node_modules` + **1.2GB** browser cache dùng chung
>   (`~/AppData/Local/ms-playwright`). Nặng hơn ước tính 300MB. Đã chấp nhận —
>   `connectOverCDP` không dùng được vì Chrome của người dùng không mở cổng debug, và Chrome
>   Bridge đi qua native host chứ không phải CDP.
> - *Google Fonts qua `file://`*: **không thành vấn đề** — chữ tiếng Việt có dấu render đúng,
>   glass/`backdrop-filter` nguyên vẹn.
> - *`restoreSession()` lúc boot*: **không gây nhiễu** — headless `file://` có IndexedDB
>   trống nên không có session cũ nào để khôi phục.
>
> **Rủi ro KHÔNG nêu trong kế hoạch mà thực tế đã cắn — accent đổi màu.** Bản headless đầu
> tiên render mọi annotation thành **xanh dương** thay vì đỏ: `accent-ramp.js` đọc accent từ
> `chrome.storage.local` (trong extension) hoặc `localStorage` (ngoài), mà headless `file://`
> không có cái nào → rơi về `DEFAULT_500 = #1350DE`. Vá: `render.mjs` gieo
> `localStorage['snapstudio.accentColor']` qua `addInitScript` **trước khi** script trang chạy,
> và `snap_export` hỏi extension accent thật qua `get_accent`. Bài học tổng quát: **mọi thứ
> app đọc từ storage đều biến mất ở headless** — không chỉ accent.
>
> **Còn lại (cố ý)**: `renderToPngDataUrl()` và `cmdExport()` cũ **vẫn giữ** — nút Download và
> Ctrl+C trong UI editor vẫn dùng chúng, và đó là đường đúng cho thao tác tay của người dùng.
> Chỉ `snap_export` đổi đường.

### Vấn đề đang có

`renderToPngDataUrl()` (`src/export.js:38`) chụp lại **chính tab editor** ở chế độ
`body.render` qua `captureVisibleTab`. Hệ quả (`export.js:79-84`):

> nếu cửa sổ nhỏ hơn khung ảnh → **ảnh xuất bị cắt**.

`snap_export` hiện xử lý bằng cách maximize cửa sổ trước rồi throw nếu vẫn không vừa
(`KB-BRIDGE.md` mục 2). Đó là **giảm nhẹ**, không phải sửa: vẫn không xuất được ảnh lớn hơn
màn hình, và vẫn chiếm dụng cửa sổ thật của người dùng khi render.

`KB-BRIDGE.md` cũng ghi nhận nhánh lỗi này **chưa từng ép được xảy ra thật để test** — vì
`snap_export` luôn maximize trước khi đo.

### Cách repo kia làm

`packages/userguidesnap/render.mjs` — Chromium headless nạp **chính `editor.html`** qua
`file://`, seed dữ liệu vào `window` bằng `addInitScript` (in-memory, **không** localStorage —
để ảnh nhiều MB không đụng quota ~5MB), rồi `page.$('#stage').screenshot()`.

Không phụ thuộc kích thước cửa sổ. Không cần maximize. Không cần `.render-veil`. Render được ở
`deviceScaleFactor` 2–3.

### Việc cần làm

1. **Mở một mặt API render trên `window.SnapKit`** (tương đương `window.__ugs` của họ) —
   `SnapKit.render = { loadCapture, addElement, renderMode }`. Dùng lại đúng các hàm nội bộ mà
   `bridge-editor.js` đã gọi (`cmdOpen` → `loadCapture`, `cmdAdd` → `newElement`+`addElement`);
   **không viết lại logic**, chỉ expose.
2. **`snap-bridge/render.mjs`** — script Node:
   - `chromium.launch()` → `newPage({ deviceScaleFactor: 2 })`
   - `addInitScript` seed capture + els
   - `goto('file://.../src/editor.html')` → `hasExt` false, editor boot sạch
   - `page.evaluate(() => SnapKit.render.loadCapture(...))`, rồi từng `addElement`
   - `document.fonts.ready`, `renderMode()`, chờ ~120ms cho `backdrop-filter` paint xong
   - `page.$('#stage').screenshot({ path })`
   - Lặp cho từng bước (mô hình singleton — nạp capture kế tiếp, không cần `gotoSlide`).
3. **`snap_export` chuyển sang gọi `render.mjs`** thay vì `callExtension('export')`, giữ nguyên
   chữ ký MCP tool để không phá agent đang chạy.

### Files đụng tới
`src/editor.js` (expose `SnapKit.render`), `snap-bridge/render.mjs` (mới),
`snap-bridge/server.js` (`snap_export` đổi đường), `snap-bridge/package.json` (+playwright).

### Tự kiểm chứng
1. Render đúng bài KB cũ bằng đường mới, **so sánh pixel** với ảnh cũ (`kb/img/*.png`) —
   glass/`backdrop-filter` phải còn nguyên, không phẳng.
2. **Ép đúng nhánh lỗi mà `KB-BRIDGE.md` ghi là "chưa test được"**: capture lớn hơn màn hình
   thật. Đường cũ phải cắt/throw; đường mới phải xuất đủ. Đây là bằng chứng quyết định.
3. Render khi cửa sổ Chrome đang **thu nhỏ** — đường mới không được ảnh hưởng.

### Rủi ro / điều chưa chắc
- **Playwright là dependency nặng** (~300MB kèm Chromium). `snap-bridge` hiện chỉ có 4 dep
  nhẹ. Cần cân nhắc: chấp nhận, hay `connectOverCDP` vào Chrome sẵn có của máy (nhẹ hơn nhưng
  phụ thuộc Chrome đang chạy — mâu thuẫn với mục tiêu "không chiếm dụng cửa sổ người dùng").
  **Chưa quyết.**
- **`file://` + `backdrop-filter` + Google Fonts**: `tokens.css` nạp font từ Google Fonts. Headless
  offline sẽ fallback font → ảnh khác bản người dùng thấy. Phải kiểm tra và có thể phải nhúng
  font. **Chưa kiểm chứng.**
- `restoreSession()` chạy lúc boot (`editor.js` cuối file) — trong headless nó đọc session cũ ở
  đâu? Có thể phải chặn để render sạch. **Chưa kiểm chứng.**

---

## Phase 2 — `job.json` + neo annotation vào selector thật ✅ ĐÃ XONG (2026-08-28)

**Phụ thuộc Phase 1** (để re-render rẻ thì phải render được ngoài trình duyệt trước).

> **Đã dựng**:
> - `snap_add` nhận `at: {selector, tabId, frameId|frameUrlContains, pad}` — đọc box thật của
>   element rồi tự tính toạ độ. `props` vẫn thắng, nên vẫn ghi đè tay được.
> - `cmdFrameRect()` trong `bridge-worker.js` — phép ánh xạ mà kế hoạch ghi là "chưa từng
>   viết ở repo này": rect trong frame **+** vị trí `<iframe>` trên trang cha **×** tỷ lệ
>   ảnh-chụp/CSS-pixel. Mảnh thứ ba quan trọng hơn dự đoán: `captureVisibleTab` chụp ở device
>   pixel, nên trên màn hình HiDPI bỏ qua nó là lệch gấp đôi. Suy tỷ lệ từ bề rộng ảnh thật
>   (`captureWidth / innerWidth`) chứ không tin `devicePixelRatio`, vì `captureVisibleTab` có
>   thể giới hạn kích thước ảnh và khi đó hai số không bằng nhau.
> - `geometryFor()` trong `server.js` — **một chỗ duy nhất** giữ ngữ nghĩa `x/y` khác nhau theo
>   type (`zoom` là tâm, `textbox` là góc, `highlight`/`blur`/`spotlight` nở theo `pad`,
>   `step`/`label` lùi ra ngoài góc trên-trái, `arrow` không tự neo được vì cần hai đầu mút).
>   Trước đây luật này chỉ nằm trong playbook để agent tự nhớ; giờ nó là code.
> - `snap_render_job({path})` — render lại toàn bộ job từ `job.json` + ghép lại `.md`,
>   **không chụp lại, không cần trình duyệt lái**. Đo thật: **2.8 giây** cho 2 ảnh + bài viết,
>   so với ~3 phút của một job đầy đủ.
>
> **Đã kiểm chứng**: `at` với `[id="812"]` → element `443x92 @ (612,547)` → highlight đặt tại
> `(604,539)` = trừ đúng `pad: 8`; ảnh xuất cho thấy khung ôm chính xác nhóm radio "Discount
> type" (`kb/img/at-verified.png`). `snap_render_job` chạy trên `kb/demo-job/job.json`.
>
> **Một khiếm khuyết tự gây ra, đã sửa**: lần chạy `snap_render_job` đầu tiên cho ra ảnh **xanh**
> thay vì đỏ — extension chưa kịp reconnect sau khi restart server (reconnect mỗi 4s, tôi chỉ
> đợi 3s), `catch {}` nuốt lỗi và render bằng accent mặc định **trong im lặng**. Đây đúng là
> loại lỗi "output sai mà không có gì báo". Đã gom vào `accentForRender()` và luôn trả
> `WARNING:` khi không đọc được accent, thay vì âm thầm đổi màu cả bộ ảnh.
>
> **Mẹo rút ra**: id bắt đầu bằng số (`#812`) cần escape CSS rất khó chịu (`#\38 12`) và dễ
> hỏng khi đi qua JSON/shell. Dùng `[id="812"]` — không cần escape gì cả.
>
> **Còn thiếu so với kế hoạch gốc**: mục "ghi lại `__box`/`__space` lúc capture" **không dựng**
> — hoá ra không cần: `job.json` lưu thẳng `props` đã tính xong, nên re-render không cần biết
> gì về box gốc nữa. Đơn giản hơn đúng một tầng.
>
> **Điểm chưa hoàn hảo đã thấy**: offset mặc định của `step` (`y - 34`) có thể rơi trúng nội
> dung liền kề — trong ảnh test nó đè lên tiêu đề "Tier settings". `at` neo đúng, nhưng **chọn
> chỗ đặt marker vẫn cần phán đoán**; offset chỉ là điểm khởi đầu.

### Vấn đề đang có

**(a) Job KB là một phát ăn ngay.** Agent làm tất cả trong một phiên, không để lại artifact nào
để chạy lại. Sửa một câu chữ hay dịch một callout sang phải 20px → phải chạy lại toàn bộ job
(~3 phút, tốn token, lái lại browser, rủi ro chạm vào store thật thêm lần nữa).

**(b) `snap_add` nhận `x/y` thô — agent đoán toạ độ.** Đó chính xác là gốc của Step 4 tràn mép và
Step 5 đè nội dung ở bài KB đầu tiên.

### Cách repo kia làm

`job.json` là nguồn sự thật bền vững; `run.mjs` có `--no-capture` (re-render không chụp lại) và
`--from-guide` (re-render sau khi sửa tay trong editor).

Annotation neo bằng `"at": "<css selector>"`, **không** phải `x/y`. Lúc capture, Playwright đọc
`boundingBox()` thật của selector (`run.mjs:124-130`), rồi ánh xạ capture-space → canvas-space
(`run.mjs:159-172`):

```js
x: frameEl.x + ((b.x - sp.x) / sp.w) * frameEl.w
```

Mỗi loại element có luật riêng: `highlight`/`blur` nở theo `pad`, `magnifier` tự tính size từ
element, `anchor` canh tâm.

### Điểm thuận lợi: mảnh còn thiếu đã có sẵn

`snap_frame_find` (dựng ngày 2026-08-28) **đã trả về `rect` thật + selector duy nhất**
(`selectorIsUnique`). Chỉ còn thiếu phép ánh xạ **frame-coords → canvas-coords của capture đang
mở**. Không cần Playwright cho bước này — dữ liệu đã có.

### Việc cần làm

1. **Schema `kb/<slug>/job.json`** — rút gọn từ schema của họ, bỏ những gì không dùng
   (`baseUrl`/`viewport`/`storageState` là của Playwright capture, không hợp mô hình profile
   thật). Giữ: `title`, `slug`, `intro`, `steps[]` (`n`, `heading`, `capture`, `body`, `notes`,
   `els`), `outro`.
2. **`snap_add` nhận `at` bên cạnh `x/y`** — khi có `at`, đọc rect từ `snap_frame_find` và ánh
   xạ sang toạ độ canvas.
3. **Ghi lại `__box` + `__space` lúc capture**, đúng như họ làm — để re-render không cần chụp lại.
4. **`snap_render_job`** (tool MCP mới) — render lại toàn bộ job từ `job.json`, không chụp lại.

### Files đụng tới
`snap-bridge/server.js` (`snap_add` + tool mới), `src/bridge-editor.js` (`cmdAdd` nhận toạ độ đã
ánh xạ), `snap-bridge/render.mjs` (đọc `job.json`).

### Tự kiểm chứng
1. Dựng `job.json` cho bài KB cũ, render → khớp bản hiện có.
2. Sửa một chữ trong `body` → `snap_render_job` → **chỉ vài giây**, không mở browser.
3. Đổi selector của một `highlight` sang element khác → annotation phải nhảy đúng chỗ mới,
   không phải chỉnh tay `x/y`.

### Rủi ro / điều chưa chắc
- **Phép ánh xạ frame→canvas chưa từng viết ở repo này.** `snap_frame_find` trả rect trong toạ
  độ *frame*; capture được `snap_open` nạp vào canvas với scale/offset riêng. Cần đo và test kỹ
  — sai ở đây thì mọi annotation lệch có hệ thống.
- Trang có **scroll**: rect từ `snap_frame_find` là toạ độ viewport tại thời điểm gọi; nếu giữa
  `snap_frame_find` và `snap_capture_tab` có cuộn thêm thì lệch. Phải chốt thứ tự gọi.

---

## Phase 3 — KB Studio UI ✅ ĐÃ XONG (2026-08-28)

**Phụ thuộc Phase 2** (job board cần `job.json` để liệt kê; nút re-render cần `snap_render_job`).

### Vấn đề đang có

Tab KB hiện tại (`src/editor.html:239-253`, 18 dòng) là **một cái launcher**: chọn file → nhập
domain → xem log chạy. Không xem lại được bài đã viết, không sửa được markdown, không review
được ảnh, không có lịch sử.

### Cách repo kia làm (`apps/guide-studio/`, 125 + 192 dòng)

| Thành phần | Của họ | Áp dụng ở đây |
|---|---|---|
| **Job board rail** | Danh sách guide + chip trạng thái (`draft/capturing/rendering/ready/error`) + `n steps · n imgs` + nút "Mark ready" | Thay `#kbFilename` tĩnh. State đã có trong `kb-job.js`'s `job.status` |
| **Split markdown \| preview** | `<textarea>` + `md2html()` tự viết ~25 dòng, **không thư viện** | Rất hợp — đọc/sửa `kb/*.md` không rời editor |
| **Live reload** | Poll `/api/jobs/<slug>/rev` mỗi 600ms | **Ở đây làm tốt hơn được**: `kb_progress` push qua WS đã có sẵn, không cần poll |
| **⭐ Positioned comments** | Bật comment mode → click lên ảnh → ghim `{step, xNorm, yNorm, text}` → `/annotate` đọc và sửa | Tính năng nổi bật nhất: vòng review người↔agent thật |
| **Version history** | Snapshot kèm app version, View / Restore, giữ 20 bản | Hợp với `snap_write_kb` (đang từ chối ghi đè — history là câu trả lời đúng hơn) |
| **"✎ Edit images"** | Mở cửa sổ editor annotation cho job đó | **Lợi thế ở đây**: editor ở ngay tab bên cạnh, không cần cửa sổ mới |
| **"↻ Re-render"** | Chạy lại worker từ `guide.json` đã sửa tay | Cần Phase 2 |

### Khác biệt kiến trúc cần quyết

Guide Studio là **web app Node riêng** (`serve.mjs`, port riêng). Tab KB ở đây nằm **trong
`editor.html` của extension**. Cách ở đây gọn hơn (editor annotation ngay cạnh, không phải đồng
bộ 2 cửa sổ), nhưng cần thêm **API đọc/liệt kê** từ `snap-bridge`: hiện `resolveOut()` chỉ cho
*ghi* vào `kb/`, chưa có đường *đọc* hay *liệt kê*.

### Việc cần làm
1. ✅ `snap-bridge`: thêm lệnh `/ext` `kb_list` / `kb_read` / `kb_save_md` (đi qua `resolveOut()`,
   giữ nguyên ranh giới `kb/`).
2. ✅ `src/bridge-kb.js`: job board rail (thay rail cũ) + panel "New job" + **split
   markdown|preview** trong panel bài viết — textarea sửa được (`kbArticleEditor`) + preview
   sống bên cạnh (`kbArticlePreview`, `md2html()` tự viết ~70 dòng, không thư viện — hỗ trợ
   heading/bold/italic/inline-code/link/list nhiều dòng/blockquote/hr/**bảng GFM**/**code
   fence**). Nút Save gọi `kb_save_md`, có guard "Discard unsaved changes?" khi chuyển bài
   đang sửa dở. Ảnh **hiện `<img>` thật** — `kb_read_image` (server, mới thêm) đọc byte ảnh
   qua `resolveOut()` trả về `data:` URL; `hydrateImages()` phía UI gọi và cache theo path đã
   resolve (job-kind: `<slug>/<src markdown>`; file-kind: `<src markdown>` thẳng), tránh gọi
   lại mỗi lần gõ phím vì preview re-render trên mỗi `input`.
3. ✅ **Comment layer** (tính năng nổi bật nhất theo bảng trên) — `kb_comments_list/add/
   resolve/delete` (server, `kb/<slug>/comments.json` cho job-kind, `kb/<slug>.comments.json`
   sibling cho file-kind vì không có thư mục riêng). UI: nút "💬 Comment" bật chế độ ghim →
   click lên ảnh đã hydrate → popover nhập text tại đúng điểm click (toạ độ chuẩn hoá
   `xNorm`/`yNorm` theo khung ảnh) → ghim hiện thành nút tròn trên ảnh, click lại xem/Resolve/
   Delete. Pin khớp lại đúng ảnh bằng **chuỗi src gốc trong markdown**, không phải path đã
   resolve — xem ghi chú trong `server.js`.
4. ✅ **Version history** — snapshot server-side trước mỗi lần ghi đè (`kb_save_md` **và**
   `snap_render_job`), lưu phẳng `kb/<slug>/history/<ts>.md` (job-kind) hoặc
   `kb/<slug>.history/<ts>.md` (file-kind sibling), giữ 20 bản gần nhất, `ts` được validate
   chặt (số nguyên dương) trước khi ghép path để chặn path traversal. UI: nút "🕐 History" mở
   panel liệt kê (tuổi bản ghi + dòng heading đầu tiên làm preview) → "View" đổi tạm preview
   pane sang bản cũ (đọc-only, không đụng editor sống, thoát bằng nút Refresh sẵn có) → "Restore"
   (có `confirm()`) ghi bản cũ trở lại làm bản hiện tại — **tự nó cũng snapshot bản đang có
   trước khi ghi**, nên restore luôn undo được.

5. ✅ **Xoá bài** — thêm sau khi Phase 3 đã đóng, theo yêu cầu người dùng. `kb_delete` (server,
   `deleteKbArticle()`): file-kind xoá `<slug>.md` + `<slug>.comments.json` (nếu có) +
   `<slug>.history/` (nếu có); job-kind xoá thẳng cả thư mục `<slug>/` (job.json, ảnh,
   comments.json, history/ — mọi thứ, vì đó là thư mục riêng của job). Không snapshot trước khi
   xoá — khác `saveKbMarkdown`, xoá chính là hành động phá huỷ ở đây, không phải ghi đè cần undo.
   UI: nút "🗑 Delete" quiet-by-default (đỏ khi hover, giống triết lý `.del-row` đã có sẵn cho
   Lab tab) — `confirm()` với thông báo khác nhau theo `articleKind` (job-kind cảnh báo rõ mất
   luôn cả ảnh). Xoá xong tự rơi về "+ New job" bằng cách tái dùng logic fallback có sẵn của
   `renderJobBoard()` (đã có từ trước, dùng cho trường hợp bài bị xoá "từ bên ngoài" UI) — không
   viết thêm state-transition riêng cho nút Delete.

6. ✅ **Mở comment cho agent** (2026-08-29) — `snap_comments` / `snap_comment_resolve` trên **MCP**,
   không chỉ `/ext`. Trước đó comment chỉ sống trong UI: agent muốn đọc phải tự mở `comments.json`,
   và cái đọc được là `xNorm/yNorm` trên ảnh **đã render** — trong khi mọi thứ sửa được (`props` của
   `snap_add`, `els` trong `job.json`) lại tính bằng pixel trên ảnh **gốc**. `describeKbComments()`
   là lớp dịch đó: pin → pixel ảnh gốc (chuẩn hoá **theo từng trục**, nên `scale` khác 1 hay đường
   export-tab-editor cũ — ảnh annotated 2026×1008 từ base 2560×1249 — đều ra đúng), + step nào sở
   hữu ảnh, + `nearestEls` (element gần pin nhất kèm `props`, vì một pin gần như luôn nói về một
   element cụ thể). `snap_comment_resolve` ghi thêm `resolvedBy/resolvedAt/resolvedNote`; note hiện
   lại trên pin trong `openViewer()` để người ghim thấy đã sửa gì mà không phải đọc diff. Cố tình
   **không** expose add/delete — agent xoá được feedback thì một correction có thể biến mất thay vì
   được xử lý. Skill `/kb` có thêm mục "Vòng review" nối vòng: đọc pin → đọc playbook → sửa `els` →
   `snap_render_job` → nhìn PNG → resolve kèm note → append LEARNING vào `PLACEMENT_PLAYBOOK.md`.

7. ✅ **Prompt gõ thẳng trong KB Studio** (2026-08-29) — ô prompt dưới bài viết, spawn một job
   **mode `revise`** (`kb-job.js`) trên đúng bài đang mở. Khác job "+ New job" ở chỗ nó là job
   **nhỏ hơn**, không phải cùng một job đổi prompt: không gắn MCP server `chrome`, `canUseTool` từ
   chối mọi tool không phải `mcp__snap__*` và mọi `snap_*` cần `tabId` — nên một job khởi từ ô text
   không bao giờ lái được phiên đăng nhập thật của người dùng; đổi lại nó **không cần session tab
   cũng không cần Chrome Bridge**, chạy được cả khi phía browser chưa dựng. Điều kiện "xong" cũng
   khác: không bắt buộc `snap_write_kb` (một job trả lời "bước 3 chụp thiếu target, phải chụp lại"
   là đã làm đúng việc mà không ghi gì).

   Ba tool phải thêm để job đó **làm được việc thật** — nó không có `Read`/`Edit`/`Write` nào
   (`tools: []`): `snap_job` (đọc/ghi `job.json`, giữ `job.prev.json` làm undo một cấp — trước đó
   topology B không có đường nào sửa `els`, tức là không dời nổi một annotation), `snap_view` (trả
   về chính tấm ảnh — "nhìn lại ảnh đã xuất" là luật cứng của playbook mà topology B chưa bao giờ
   theo được), và `snap_learn` (append LEARNING vào `PLACEMENT_PLAYBOOK.md` — write duy nhất ra
   ngoài `kb/`, append-only, một file cố định, cap 1200 ký tự).

   Phía UI: `.kb-article-prompt` dưới split editor, log riêng `#kbArticleLog` — `appendLine()` chọn
   log theo **mode của job đang chạy**, không theo panel đang hiện, để đổi panel giữa chừng không
   nuốt mất dòng log. Job xong thì tự nạp lại bài (xoá `imageCache` trước, vì ảnh vừa render lại),
   trừ khi người dùng đang có sửa chưa lưu — lúc đó chỉ toast, không đè lên việc của họ.
8. ✅ **Một hội thoại cho mỗi bài** (2026-08-29) — prompt thứ hai **nối tiếp** phiên agent cũ qua
   `options.resume` của Agent SDK, không spawn phiên trắng. `reviseSessions` (Map `slug -> {id,
   turns}`, chỉ nằm trong RAM: CLI giữ transcript thật, đây chỉ là con trỏ — mất khi restart bridge
   thì tốn một phiên mới chứ không mất dữ liệu). `session_id` bắt từ **message bất kỳ** trong
   stream: mọi message đều mang nó, bền hơn bám vào một message init cụ thể của SDK. Cơ chế đã kiểm
   chứng bằng hai lượt thật — lượt 1 "nhớ số 4127", lượt 2 kèm `resume` trả đúng "4127", và
   `session_id` giữ nguyên qua hai lượt.

   Prompt lượt sau đổi khung: không lặp lại đề bài (nó nhớ rồi) mà chỉ đưa **trạng thái đọc lại từ
   đĩa ngay lúc đó**, kèm câu "trust it over your memory where they disagree" — người dùng có thể đã
   sửa tay giữa hai lượt. Resume hỏng (session bị prune) thì xoá con trỏ và báo rõ "press Send again
   to start a fresh one", không để người dùng bấm mãi vào cùng bức tường.

   UI: badge `continuing · N turns` / `new session` cạnh nút **⟲ New session** — `kb_session` với
   `reset` trả luôn state mới trong cùng một round trip, nên badge không bao giờ cũ.

Ngoài ra, theo yêu cầu người dùng, hai đổi cấu trúc **ngoài phạm vi bảng trên** đã làm cùng đợt
này — xem "KB Studio UI (Phase 3) — instruction + session tabs..." trong `KB-BRIDGE.md`:
- Input chính đổi từ "chỉ nhận file `.md`" sang **instruction (textarea) bắt buộc + file `.md`
  tham khảo tuỳ chọn**.
- **Domain allowlist bị bỏ hẳn**, thay bằng **session tabs** — whitelist tabId riêng của Snap
  Studio (`kbSessionTabIds` trong `bridge-worker.js`), UI "In session / Open tabs" trong panel
  New job (phần UI này KHÔNG đổi). Cách `kb-job.js` dùng whitelist đó bên trong **đã đổi lần
  nữa** cùng ngày, sau khi job thật đầu tiên cho thấy "đúng tabId đã cho trước" không khả thi
  (Chrome Bridge luôn cấp một tab group mới, rỗng, mỗi phiên agent — tab thật của người dùng
  không bao giờ tự vào được đó) — job giờ tự mở tab của chính nó và điều hướng theo **origin**
  suy ra từ URL các tab trong session, thay vì khoá cứng theo đúng tabId. Xem "Giới hạn trên đã
  cắn thật — bỏ hẳn 'dùng đúng tab người dùng mở'..." trong `KB-BRIDGE.md` cho chi tiết đầy đủ.

### Rủi ro
- **Đây là phase dễ làm sớm nhất và cũng dễ phí công nhất.** Nó là tầng review cho một pipeline
  đã ổn định; làm khi Phase 1–2 còn thay đổi thì phải sửa lại. Giữ đúng thứ tự.
- **Đã xảy ra thật, bắt được trước khi ship**: `jobMdRel()` (đường dẫn `.md` của job nhiều bước)
  ban đầu viết sai — tưởng `job.md` trong `job.json` là tương đối so với thư mục **của job**,
  thực ra nó tương đối so với `kb/` (đúng quy ước `snap_render_job` đã dùng sẵn) — double-prefix
  slug, đọc ra chuỗi rỗng. Bắt được bằng cách chạy `listKbArticles()`/`readKbArticle()` offline
  trên `kb/demo-job` thật (fixture có sẵn từ Phase 2) trước khi đụng tới server đang chạy thật —
  không có fixture đó, bug này rất dễ lọt qua vì code trông hợp lý và không throw.
- **Đã kiểm bằng mắt thật, không chỉ đọc code** — `chrome-extension://` bị Chrome Bridge chặn
  điều hướng (đã xác nhận), nên dùng đường vòng: mở `editor.html` qua `file://` (giống cách
  `render.mjs` render headless) rồi bấm/chụp ảnh thật qua Chrome Bridge. Cách này bắt được **3
  bug thật** mà đọc code không thấy:
  1. `.kb-banner`/`.kb-new-job-panel`/`.kb-article-panel` đều có rule CSS riêng `display: flex`
     hoặc `display: grid` **không điều kiện** — một rule tác giả luôn thắng default
     `[hidden]{display:none}` của UA stylesheet dù cùng độ đặc hiệu, nên set `.hidden = true`
     bằng JS không có tác dụng thị giác. Đây là đúng cái bẫy đã ghi chú sẵn cho `.tb-actions`
     (dòng ~212 `editor.css`) nhưng chưa áp dụng cho 3 phần tử KB mới — vá bằng
     `.selector[hidden] { display: none; }` cho cả ba.
  2. `md2html()` không xử lý bảng GFM và code fence — khi chạy thử với markdown thật (bài
     `multibuy-percentage-discount-...md`, có bảng và fence thật) mới lộ ra; thêm nhánh xử lý
     riêng cho cả hai.
  3. `md2html()` xuống dòng lại số thứ tự — mọi `<li>` liên tiếp trong cùng danh sách đều ra
     "1." thay vì đếm lên, vì dòng tiếp nối thụt lề (rất phổ biến trong văn phong bài KB ở đây)
     bị đóng nhầm `</ol>` rồi mở `<ol>` mới. Chỉ lộ ra khi test bằng bài thật nhiều dòng — dữ
     liệu tổng hợp ngắn trong lúc code không đủ để bắt lỗi này.
  Bài học chung, khớp với bài học 2026-08-28 khác trong `KB-BRIDGE.md`: test bằng dữ liệu và
  render thật luôn bắt được nhiều hơn đọc code hoặc test bằng dữ liệu tự bịa.
- **Vẫn cần người dùng reload extension thật** trước khi phần này chạy trong Chrome thật — mọi
  test ở trên chạy qua `file://` (bản sao độc lập trên đĩa), không phải bản đã nạp vào Chrome.
- **Đợt comment layer + đọc ảnh thật (cùng ngày)**: `chrome-extension://` cũng không có API
  `chrome.tabs.query` không lọc, và Chrome Bridge lại chặn điều hướng vào đó — nên không lấy
  được tabId của tab `editor.html` thật đang mở để test qua `snap_frame_*`. Test server-side
  (image read + comments CRUD) chạy qua một WS client tạm nối `/ext` — cách này đã dùng ở đợt
  trước, không mới. Cái mới: test phần UI tương tác (composer, ghim, popover) bằng cách gắn
  đúng các hàm thật từ `bridge-kb.js` (trích trực tiếp từ file, không chép tay lại) vào DOM
  thật của `editor.html` qua `file://`, kèm `callBg`/`toast` giả lập — rồi dùng
  `mcp__chrome__javascript_eval` để tự bắn `MouseEvent` với toạ độ thật (không dùng
  `mcp__chrome__click` cho việc này: nó gọi `.click()` không toạ độ, `clientX/Y` ra `0`, làm
  popover tính toạ độ âm hàng trăm phần trăm — biết được nhờ query lại `pop.style.left` sau
  khi "không thấy gì" trên ảnh chụp, không phải đoán).
  Bắt được **1 bug thật** qua cách này: `renderCommentPins()`'s pin có `ev.stopPropagation()`
  — chặn hẳn sự kiện click lan tới listener `document`-level chịu trách nhiệm tự đóng popover,
  nên cờ `suppressPopoverAutoClose` (được set khi MỞ popover) không bao giờ được listener đó
  tiêu thụ và reset — nó nằm lại `true`, khiến **click tiếp theo ở bất kỳ đâu** (không liên
  quan gì tới pin đó) bị nuốt mất một cách im lặng. Chỉ lộ ra khi bắn đúng chuỗi sự kiện thật
  (click ghim → click chỗ khác) và so sánh state trước/sau — đọc riêng từng listener một trông
  đều hợp lý. Vá: bỏ `stopPropagation()`, để bubble tới `document` như bình thường (listener
  `articlePreview` đã tự loại click-vào-pin bằng `.closest('.kb-comment-pin')` rồi, không cần
  chặn lan truyền để làm việc đó).
- **Đợt version history (cùng ngày)**: server-side test qua WS client tạm nối `/ext`, chạy trên
  fixture thật `kb/test-tier-settings-discount-type.md` — save 2 lần liên tiếp, đọc lại bản cũ
  nhất, restore, kiểm `ts` không hợp lệ (`"../../etc/passwd"`, `"not-a-number"`) đều bị từ chối
  — dọn sạch dữ liệu test và trả file về nội dung gốc sau khi xong. UI test lại đúng kỹ thuật
  trích-hàm-thật-vào-DOM-`file://`-rồi-bắn-`MouseEvent`-thật đã dùng cho comment layer.
  Bắt được **1 bug thật** qua cách này, khác bug trước nhưng cùng họ (thứ tự early-return trong
  cùng một `document` click-listener): `if (suppressPopoverAutoClose) { ...; return; }` nằm
  TRƯỚC điều kiện đóng `historyPanel`, nên khi một popover comment vừa mở (cờ này vừa được set
  `true` bởi `openComposer`/`openViewer`) đúng lúc history panel đang mở, hàm return sớm và bỏ
  qua luôn việc đóng panel — panel bị kẹt mở, chồng lên popover mới. Lộ ra khi mô phỏng đúng
  thứ tự click đó (mở history panel → set cờ suppress → bắn click) rồi so `historyPanel.hidden`
  trước/sau; đọc riêng từng nhánh `if` trông vẫn hợp lý vì mỗi nhánh tự nó đúng, chỉ sai *thứ
  tự*. Vá: đổi thứ tự — điều kiện đóng `historyPanel` chạy trước, không phụ thuộc cờ suppress
  (cờ đó vốn chỉ có ý nghĩa với popover, không liên quan gì tới panel), rồi mới tới early-return
  và điều kiện đóng popover. Re-test lại toàn bộ luồng cũ (mở/đóng qua nút, đóng khi click ra
  ngoài, View, Restore) sau khi đổi thứ tự — không có regression.

---

## Phase 4 — (tuỳ chọn, chưa cam kết)

Chỉ làm khi có nhu cầu thật, **không làm vì repo kia có**:

- **`/kb-review`** — spawn agent độc lập đọc PNG đã render, chấm theo playbook. Điểm đáng học
  nhất là **Step 3 của họ**: *"Reviewers are strict but imperfect. Before acting, verify their
  big claims yourself"* — có ghi lại một lần cả hội agent đều báo sai cùng một lỗi. Trùng khớp
  với bài học 6-vòng-thử-sai ngày 2026-08-28 ở repo này.
- **`/kb-sync`** — app Qikify đổi UI → bài KB nào stale. Repo kia map qua route file (Remix);
  ở đây không có quyền đọc source app Qikify → **có thể không khả thi**, phải nghĩ cách khác
  (so ảnh? theo dõi version app?).
- **Publish pipeline** — chỉ khi team có docs repo.

---

## Thứ tự khuyến nghị

```
Phase 0 (skill + playbook)  ─── độc lập, rẻ nhất, làm trước
                                 │
Phase 1 (headless render)   ─────┤ độc lập với Phase 0, giá trị kỹ thuật cao nhất
                                 │
Phase 2 (job.json + at:)    ◀────┘ cần Phase 1
                                 │
Phase 3 (Studio UI)         ◀────┘ cần Phase 2
                                 │
Phase 4 (review/sync/publish) ◀──┘ chỉ khi có nhu cầu thật
```

Nếu chỉ làm được một phase: **Phase 0** (chặn được đúng ba lỗi chất lượng đã thấy ở bài KB đầu
tiên, không cần đụng kiến trúc).
Nếu làm được hai: **Phase 0 + Phase 1**.

---

## Phụ lục — đối chiếu API hai bên

| Việc | userGuideSnap | Snap Studio |
|---|---|---|
| Mặt API trên window | `window.__ugs` | `window.SnapKit` (`.export`, `.bridge`, `.kb`, `.library`, `.lab`, `.accent`, `.contextStamp`) |
| Nạp ảnh | seed `window.__UGS_GUIDE__` | `loadCapture({id, dataUrl, url, rect})` — **nội bộ IIFE, chưa expose** |
| Thêm annotation | `els[]` trong `guide.json` | `cmdAdd({type, props})` (`bridge-editor.js:43`) |
| Xuất ảnh | `page.$('#stage').screenshot()` | `renderToPngDataUrl()` (`export.js:38`) → `captureVisibleTab` |
| Phần tử chụp | `#stage` | `#stage` (`editor.html:107`) — **trùng** |
| Guard ngoài-extension | (không cần) | `hasExt` (`editor.js:30`) — **đã có sẵn** |
