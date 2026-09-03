# Bỏ Chrome Bridge — kế hoạch chi tiết

- Lập: 2026-09-02
- Trạng thái: **kế hoạch, chưa triển khai**
- Ngữ cảnh trước đó: `KB-BRIDGE.md` mục "Lật lại: job dùng ĐÚNG tab người dùng…" và mục
  "Chạy thật rồi: adopt hoạt động…"

## 1. Quyết định đề xuất

Bỏ hẳn phụ thuộc vào Chrome Bridge trong pipeline KB, chuyển toàn bộ việc lái trình duyệt
sang extension Snap Studio + snap-bridge (`mcp__snap__*`).

Đây **không phải** "clone Chrome Bridge". Phần khó nhất đã nằm sẵn trong repo từ 2026-08-28,
đúng vì Chrome Bridge không làm nổi: điều khiển nội dung trong iframe cross-origin. Việc còn
lại là bịt bốn lỗ hổng nhỏ rồi rút dây.

## 2. Vì sao — ba lý do, không phải sở thích

**2.1. Với chính app này, Chrome Bridge đã hỏng ở phần quan trọng nhất.**
`KB-BRIDGE.md` mục "Điều khiển nội dung trong iframe cross-origin (2026-08-28)" ghi số đo
thật: app chạy trong iframe cross-origin (`bkv-embedded.qikify.com` trong `admin.shopify.com`),
`activeTab` của Chrome Bridge chỉ cấp host permission cho origin của **frame chính**. Kết quả:

- `mcp__chrome__scroll` cuộn 3000px → không đổi một pixel nào
- `mcp__chrome__find` → 0 match cho text đang hiện rõ trên màn hình

Ba tool cốt lõi để lái app — scroll, find, click — không dùng được. `snap_frame_*` sinh ra
chính vì thế. Snap Studio làm được vì manifest xin `<all_urls>`, không phải `activeTab`
(chú thích tại `src/bridge-worker.js:604-608` nêu đích danh cả ba tool, và nói rõ `target.frameIds` đi vòng được vì injection dựa trên host_permissions của chính extension).

**2.2. Toàn bộ vấn đề tab group là do Chrome Bridge, không phải do bài toán.**
`resolveTabInGroup()` trong extension Chrome Bridge từ chối mọi tab ngoài group của phiên.
Từ đó đẻ ra: tab tạm để group thành hình, `adopt_tabs`/`release_tabs`, việc dời tab thật của
người dùng trong thanh tab, và cả `jobTabClosed`. `mcp__snap__*` **vốn không bị ràng buộc
group** (chú thích tại `snap-bridge/kb-job.js:80-85`). Bỏ Chrome Bridge thì toàn bộ tầng này
biến mất, không phải sửa cho khéo hơn.

**2.3. Phụ thuộc vào một giao diện không có tài liệu.**
`chrome-bridge-config.js` phải mò `~/.claude.json` tìm url + token; `startJob()` chết cứng nếu
không thấy (`kb-job.js:264-265`); `extractTabId()` phải thử `JSON.parse` rồi rơi về regex vì
"hình dạng kết quả thật của Chrome Bridge không có tài liệu" (`KB-BRIDGE.md`). Cả ba đều là
chi phí trả cho một thành phần bên ngoài mà mình không kiểm soát phiên bản.

## 3. Hiện trạng — Chrome Bridge đang bám vào đâu

| Nơi | Nội dung |
|---|---|
| `snap-bridge/chrome-bridge-config.js` | toàn bộ file: tìm url/token trong `~/.claude.json` |
| `snap-bridge/kb-job.js:76-79` | `CHROME_SAFE_TOOLS` — 15 tool được pre-approve |
| `snap-bridge/kb-job.js:264-265` | `startJob` ném lỗi nếu không tìm thấy Bridge |
| `snap-bridge/kb-job.js:582-600` | `canUseTool`: chặn `new_tab`, soát origin cho `navigate` |
| `snap-bridge/kb-job.js:148-165` | system prompt: hướng dẫn navigate/tabId/tab tạm |
| `snap-bridge/kb-job.js:660-663` | `mcpServers.chrome` truyền vào stage capture |
| `snap-bridge/kb-job.js:1084-1098` | `describeToolUse` — nhãn log cho 15 tool |
| `snap-bridge/kb-job.js:961, 1109+` | `pendingNavigateIds` + `extractTabId()` |
| `src/bridge-worker.js` (khối adopt) | `cmdAdoptTabs`/`cmdReleaseTabs` — chỉ tồn tại vì group |
| `.claude/skills/kb/SKILL.md` | mục topology B, bảng tool |

Seam sạch: không có chỗ nào khác trong repo chạm tới Chrome Bridge.

## 4. Ánh xạ 15 tool → thay bằng gì

| Tool Chrome Bridge | Dùng được với app này? | Thay bằng |
|---|---|---|
| `scroll` | **Không** (đã đo, iframe) | `snap_frame_scroll` — **đã có** |
| `find` | **Không** (đã đo, iframe) | `snap_frame_find` — **đã có** |
| `click` | **Không** (cùng nguyên nhân) | `snap_frame_click` — **đã có** |
| `take_screenshot` | Có (tầng compositor) | `snap_capture_tab` (ghi file) — **đã có**; cần thêm bản inline để *nhìn* |
| `navigate` | Có | **cần thêm** `snap_navigate` |
| `fill` / `fill_form` / `type_text` | Không (iframe) | **cần thêm** `snap_frame_fill` |
| `press_key` | Không (iframe) | **cần thêm** `snap_frame_press` |
| `wait_for` | Một phần | `waitTabComplete()` đã có (`bridge-worker.js:532`); gộp vào `snap_navigate` |
| `list_tabs` | Có | **bỏ** — job đã được cho sẵn danh sách tab trong prompt |
| `switch_tab` | Có | **bỏ** — schema của chính nó nói không cần trước khi dùng tool khác |
| `close_tab` | Có | **bỏ** — chỉ dùng cho tab tạm, mà tab tạm biến mất |
| `resize_window` | Có | **bỏ** — không có bằng chứng dùng thật, `snap_export` đã headless (mục 12.1) |
| `chrome_status` | Có | `snap_status` — **đã có** |
| `new_tab` | — | đang bị chặn sẵn, bỏ luôn |

**Ròng lại: thêm 4 tool, bỏ 15.**

## 5. Spec bốn tool mới

Bộ máy đã có, không phải dựng mới: `resolveFrameId(tabId, {frameId, frameUrlContains})` +
`execInFrame(tabId, fid, pageFn, arg)` → `chrome.scripting.executeScript({target:{tabId,
frameIds:[fid]}, func, args:[arg]})`. Ba tool frame hiện tại đều chỉ là `cmdFrameX` gọi
`execInFrame` với một page function. Ba trong bốn tool dưới đi đúng khuôn đó.

**5.1. `snap_navigate({ tabId, url })`** — tool duy nhất *không* theo khuôn frame.
`chrome.tabs.update(tabId, { url })` rồi `await waitTabComplete(tabId)`. Trả `{tabId, url,
title}`. Bắt buộc `tabId` — không có khái niệm "tab mặc định" nữa, đây là điểm mạnh chứ không
phải thiếu sót. Xem rủi ro 8.1 về SPA.

**5.2. `snap_frame_fill({ tabId, frameId|frameUrlContains, selector, value })`**
Page function `pageFill`: set `.value`, bắn `input` + `change` (bubbles) để framework nhận.
Gộp luôn `type_text` — với KB, đặt giá trị là đủ; cần gõ thật từng phím thì dùng `press`.

**5.3. `snap_frame_press({ tabId, frameId|frameUrlContains, key, selector? })`**
Page function `pagePress`: `KeyboardEvent` keydown/keyup trên `selector` (hoặc
`document.activeElement`). Đủ cho Enter/Escape/Tab — gần như toàn bộ nhu cầu thật.

**5.4. `snap_look({ tabId })`** — ảnh trả **inline**, không ghi file.
Dùng lại đúng đường `shootQuietly()` của `snap_capture_tab` nhưng trả data URL. Đây là thứ
thay `mcp__chrome__take_screenshot`, và nhắc lại ranh giới sẵn có: ảnh cho bài viết vẫn phải
đi qua `snap_capture_tab`.

## 6. Xoá những gì

- `snap-bridge/chrome-bridge-config.js` — cả file
- `cmdAdoptTabs` / `cmdReleaseTabs` / `adoptedTabs` / `TAB_GROUP_ID_NONE` trong
  `src/bridge-worker.js`, và hai lệnh `adopt_tabs`/`release_tabs` trong dispatch (~130 dòng)
- `snap-bridge/adopt-tabs.test.mjs` (23 assertion) — chết theo
- Trong `kb-job.js`: `CHROME_SAFE_TOOLS`, `extractTabId`, `pendingNavigateIds`, `onTabId`,
  `startAdoption`, `jobTabClosed`, `ctx.tabs`, `tabs.release()` ở `startJob`, và 15 case
  `mcp__chrome__*` trong `describeToolUse`
- Trong `server.js`: khối `tabs: { adopt, release }`

Đây là điểm đáng chú ý nhất của cả kế hoạch: **kết quả là ít code hơn hiện tại**, không phải
nhiều hơn.

## 7. Ranh giới an ninh sau khi bỏ

Hôm nay `canUseTool` mượn hàng rào group do Chrome Bridge cưỡng chế. Bỏ đi thì hàng rào là
của mình — và đó chính là whitelist `tabId` ở `KB-BRIDGE.md` mục 2 (2026-08-28), thứ **đã bị
bỏ vì lý do sai**: nó chết vì Chrome Bridge từ chối tab ngoài group, không phải vì bản thân
whitelist sai. Không còn Chrome Bridge thì nó đúng trở lại:

- mọi tool nhận `tabId` phải trúng một id trong `sessionTabs` của job; thiếu `tabId` → từ chối
- extension vẫn giao thêm với `kbSessionTabIds` — danh sách người dùng tự bấm `+`
- cổng origin cho `snap_navigate` giữ nguyên logic `originsOf(sessionTabs)` đang chạy

**Được thêm, không phải mất**: nhóm tool nguy hiểm (`javascript_eval`, `read_page`,
`get_page_text`, `read_network_requests`, `upload_file`) hiện đang phải *chặn* bằng
`canUseTool`; sau khi bỏ thì chúng **không tồn tại**. Bề mặt tấn công biến mất thay vì bị canh.

**Mất thật**: một lớp cưỡng chế độc lập do bên thứ ba giữ. Chấp nhận được, vì phần lớn công
việc của job (mọi `snap_*`) vốn đã nằm ngoài lớp đó rồi.

## 8. Rủi ro

**8.1. `snap_navigate` trên SPA — rủi ro thật duy nhất.**
Shopify admin là SPA: `tab.status === 'complete'` có thể bắn *trước* khi app nhúng render
xong, và điều hướng trong app có khi không đổi `status` chút nào. Đây là chỗ tốn công, không
phải số lượng tool.
*Giảm thiểu*: `snap_navigate` trả về sau `waitTabComplete`, rồi agent **xác nhận bằng
`snap_frame_find`** trước khi chụp — luật này đưa vào SKILL.md, không phải để agent tự đoán.
Nếu thực tế còn lệch thì thêm `snap_frame_wait({selector|text, timeoutMs})` theo đúng khuôn
`execInFrame` (polling trong frame) — đã dự trù, chưa làm ngay.

**8.2. Topology A đổi.** Người gõ `/kb` trong Claude Code lâu nay dùng `mcp__chrome__*` để
điều hướng. Sau khi bỏ, họ dùng `snap_navigate`. Phải sửa SKILL.md; không mất tính năng.

**8.3. Chrome Bridge vẫn hữu ích ngoài project.** Bỏ ở đây **không** gỡ cài đặt nó; phiên
Claude Code thường vẫn dùng nó để duyệt web bình thường.

**8.4. Có phiên khác đang sửa cùng file.** Tại thời điểm lập kế hoạch, `kb-job.js`,
`SKILL.md`, `server.js` đang có thay đổi chưa commit của một phiên khác (`kb-playbook.js`).
Phải đồng bộ trước khi bắt đầu GĐ 2.

## 9. Bốn giai đoạn, mỗi giai đoạn tự đứng được

**GĐ 1 — Thêm bốn tool (thuần bổ sung, không đổi hành vi). ĐÃ XONG (2026-09-03).**
`snap_navigate`, `snap_frame_fill`, `snap_frame_press`, `snap_look`. Chrome Bridge vẫn nguyên
tại chỗ, job vẫn chạy như cũ — `kb-job.js` (topology B) chưa đụng tới, bốn tool mới chưa nằm
trong `canUseTool`/`describeToolUse` của job spawn.

Cài đặt: `src/bridge-worker.js` (`cmdNavigate`, `pageFill`+`cmdFrameFill`,
`pagePress`+`cmdFramePress`, gắn vào `handleBridgeCommand`) và `snap-bridge/server.js` (4 tool
MCP tương ứng; `snap_look` tái dùng thẳng `callExtension("capture_tab", …)` của
`snap_capture_tab`, không thêm command mới ở tầng extension).

Test tay: `node --check` sạch cả hai file; `npm test` (adopt-tabs, kb-playbook, kb-notes) vẫn
xanh; gọi trực tiếp qua MCP client (bypass session bị cache "ConnectionRefused" từ lúc server
chưa chạy) trên một tab Chrome thật của người dùng — **không phải Shopify** (không có sẵn tab
Shopify đã đăng nhập lúc test), dùng `httpbin.org/forms/post` cho navigate/fill/press/look ở
frame chính, và trang MDN `<input>` (nhiều iframe `*.mdnplay.dev`, khác hẳn origin
`developer.mozilla.org`) cho phần quan trọng nhất — `snap_frame_fill`/`snap_frame_press` **bên
trong iframe cross-origin thật**. Cả bốn tool chạy đúng; `snap_look` có một lần lỗi thoáng qua
"image readback failed" (race điều kiện có sẵn của `chrome.tabs.captureVisibleTab`, không liên
quan code mới) — retry qua ngay.

Phát hiện đáng ghi: **extension không tự hot-reload** — sau khi sửa `bridge-worker.js` phải vào
`chrome://extensions` bấm reload thủ công thì service worker mới nhận code mới; lần đầu test cả
ba tool mới báo "unknown command" vì chạy code cũ.

*Xong khi*: bốn tool chạy được trên trang Shopify thật, kể cả trong iframe nhúng — **đạt phần
cơ chế** (cross-origin iframe thật, không phải Shopify cụ thể). Nên chạy lại một lượt trên đúng
tab Shopify trước khi coi GĐ 1 đóng hẳn, vì SPA/Polaris có thể lộ ra thứ trang MDN không có.

**GĐ 2 — Lật công tắc. ĐÃ XONG, NGHIỆM THU THẬT ĐÃ CHẠY (2026-09-03).**
Bỏ `chrome` khỏi `mcpServers` của stage capture; `canUseTool` chuyển sang whitelist `tabId`
theo `sessionTabs`; viết lại system prompt + `buildPrompt` (bỏ hết chuyện tab tạm/adopt); sửa
SKILL.md. Job giờ **chỉ** dùng `snap_*`.

Cài đặt, tất cả trong `runCaptureStage` (`snap-bridge/kb-job.js`) trừ khi ghi khác:
- `mcpServers`: chỉ còn `snapServer(snapSelf)` — bỏ hẳn khối `chrome: {...chromeCfg}`.
- `canUseTool`: bỏ `CHROME_SAFE_TOOLS`/`new_tab`/`mcp__chrome__navigate` branch, bỏ
  `jobTabId`/`adoptedTabIds`/`jobTabClosed`/`adoptPromise`/`startAdoption()`. Thay bằng một
  whitelist phẳng: `sessionTabIds = new Set(sessionTabs.map(t => t.id))`, mọi tool trong
  `SNAP_TAB_TOOLS` (đã thêm `snap_navigate`/`snap_look`/`snap_frame_fill`/`snap_frame_press`)
  hoặc `snap_add` có `at.tabId` phải trúng tập đó; `snap_navigate` **thêm** một cổng origin độc
  lập (`originAllowed(url)`, logic y hệt cổng cũ của `mcp__chrome__navigate`) — hai cổng
  (tabId, origin) kiểm tra tách rời, không cổng nào miễn trừ cổng kia.
- `startJob()`: bỏ `loadChromeBridgeConfig()`/`chromeCfg`/throw-nếu-thiếu-Bridge — một job giờ
  khởi động được dù máy chưa từng cài Chrome Bridge. Bỏ import `chrome-bridge-config.js` khỏi
  `kb-job.js` (file đó vẫn còn, GĐ 3 mới xoá — `server.js` vẫn import nó cho dòng log chẩn đoán
  lúc khởi động, đã sửa lại chữ cho đúng: không còn nói "KB jobs will fail to start").
- Comment đầu file `kb-job.js` và comment quanh khối `tabs: {adopt, release}` trong `server.js`
  viết lại cho khớp thực tế — bản cũ mô tả đúng cơ chế adopt như thể vẫn đang chạy, để nguyên
  là tài liệu nói dối. Khối `tabs`/`ctx.tabs`/`tabs.release()` trong `startJob()` **cố tình để
  nguyên, không xoá** — giờ là no-op vô hại (không còn ai gọi `ctx.tabs.adopt`), xoá thật là
  việc của GĐ 3 theo đúng mục 6.
- `SKILL.md`: viết lại bullet topology B ở "Cần có trước" (không còn tab tạm/adopt, mọi tool
  bắt buộc `tabId`, **không có cách mở tab mới** — nếu một tab không dùng được thì dừng lại và
  báo, không còn đường lùi "navigate tab của job tới URL đó" như bản cũ); thêm 4 tool mới vào
  bảng "Bộ tool"; mở rộng cảnh báo iframe cross-origin để nhắc cả `snap_frame_fill`/
  `snap_frame_press` thay cho `mcp__chrome__fill`/`press_key`.
- **Cố tình CHƯA làm** trong GĐ 2 này: hướng dẫn topology A (dòng 67 SKILL.md, "mcp__chrome__*
  dùng để điều hướng") — mục 12.3 đã quyết bỏ Chrome Bridge cho cả topology A, nhưng làm ngay
  sẽ lộ một lỗ chưa có lời giải: topology A không có sessionTabs được giao sẵn trong prompt như
  topology B, nên nó cần một cách TỰ tìm tabId (`mcp__chrome__list_tabs`/`new_tab` hôm nay) mà
  `mcp__snap__*` chưa có tool thay thế. Để nguyên, gắn cờ cho một lượt riêng.

Test: `node --check` sạch `kb-job.js`/`server.js`; `npm test` — bộ cũ (adopt-tabs, kb-playbook,
kb-notes) vẫn xanh, cộng bộ mới `capture-canusetool.test.mjs` (13 assertion, cùng khuôn vm+fake
với `adopt-tabs.test.mjs`: slice `canUseTool` ra khỏi `kb-job.js` thật, chạy trong vm với
`SNAP_TAB_TOOLS` đọc thật từ nguồn chứ không gõ tay lại) — phủ: tab trong session dùng được
ngay lần gọi đầu (không cần navigate/adopt trước); tab ngoài session bị từ chối dù là tab
Chrome thật; gọi thiếu tabId bị từ chối; `snap_navigate` đúng origin đi qua, sai origin bị chặn;
đúng origin nhưng SAI tabId vẫn bị chặn (hai cổng độc lập); `snap_add` đọc tabId từ `at.tabId`
đúng chỗ; `snap_add` không có `at` (toạ độ tay) không cần tabId; các role-gate cũ (chặn
`snap_write_kb`/`snap_findings` ở capture stage) vẫn nguyên; **không** tool `mcp__chrome__*` nào
còn lọt qua được nữa. Khởi động lại `snap-bridge` thật — boot sạch, dòng log chẩn đoán mới hiện
đúng.

**Nghiệm thu thật — ĐẠT (2026-09-03, ~10:01-10:48).** Người dùng tự chạy một job KB thật qua
KB Studio ngay trong lúc đang review kế hoạch này: bài "How to translate Qikify Volume Discount
app settings and offers" (`kb/translate-volume-discount-app`), 1 session tab, app Shopify thật
với **iframe cross-origin thật** (Qikify Volume Discount). `job-log.json` cuối cùng:
`status: "done"`, review round 1 verdict `"pass"`, không lỗi. Bằng chứng cụ thể từ log:
- Không một dòng nào nhắc "adopt"/"tab tạm"/"mở đường" — agent dùng thẳng `tabId` của session
  tab ngay từ lệnh đầu tiên, đúng `buildSystemPrompt` mới.
- Hai lần agent gọi nhầm `mcp__chrome__click`/`mcp__chrome__list_tabs` (phản xạ cũ) và bị
  `canUseTool` **từ chối đúng** ("Denied — ...: not something this job may do") — whitelist mới
  hoạt động, agent tự phục hồi bằng `snap_navigate` ngay sau.
- `snap_frame_list/find/click/scroll` dùng xuyên suốt để lái nội dung trong iframe cross-origin
  — đúng bài toán gốc mục 2.1, không phải giả lập.
- Dọn dẹp đúng luật skill (đóng modal Cancel, navigate về URL ban đầu); write + review stage
  chạy trọn, review chỉ filed 2 nit không chặn (chọn component annotation, không liên quan gì
  tới phần hạ tầng Chrome Bridge).
- **Không mở tab mới, không dời tab nào** — đúng 1 tab session dùng suốt từ đầu tới cuối.

*Xong khi*: một job KB thật dựng trọn bài, không mở tab nào mới, không dời tab nào — **✅ đạt**.

**GĐ 3 — Xoá tầng adopt. ĐÃ XONG (2026-09-03).**
Xoá đúng theo danh sách mục 6, ngay sau khi GĐ 2 chạy xanh thật (job
`translate-volume-discount-app`) — không đợi "một vòng" như dự tính ban đầu, vì bằng chứng xanh
đã có sẵn ngay trong phiên này.

Đã xoá:
- `snap-bridge/chrome-bridge-config.js` — cả file.
- `snap-bridge/adopt-tabs.test.mjs` — cả file, và bỏ khỏi `npm test` trong `package.json`.
- `src/bridge-worker.js`: `cmdAdoptTabs`, `cmdReleaseTabs`, `adoptedTabs`, `TAB_GROUP_ID_NONE`,
  toàn bộ comment block "Adopting the KB session's tabs...", và 2 dòng dispatch
  `adopt_tabs`/`release_tabs` trong `handleBridgeCommand`.
- `snap-bridge/kb-job.js`: `CHROME_SAFE_TOOLS`, `extractTabId`, `pendingNavigateIds`, tham số
  `onTabId` (ở `runStage`/`consumeStream`), 15 case `mcp__chrome__*` trong `describeToolUse`,
  tham số `tabs` xuyên suốt `startJob`→`runAuthorPipeline`→`ctx`, khối `tabs.release()` cuối
  `startJob`.
- `snap-bridge/server.js`: khối `tabs: {adopt, release}` trong `kb_start`, import
  `loadChromeBridgeConfig` và dòng log chẩn đoán Chrome Bridge lúc khởi động (file cung cấp nó
  không còn tồn tại).

Nhân tiện sửa hai chỗ tài liệu bị lỗi thời phát hiện trong lúc xoá (không nằm trong danh sách
mục 6 nhưng để nguyên là nói dối): doc-comment của `startJob()` vẫn ghi "throws... if Chrome
Bridge cannot be found" (đã không còn đúng từ GĐ 2), và một câu trong `CAPTURE_ROLE` dặn agent
"navigate again first" ở fix round vì tưởng tab phiên trước "gone" — sai, tab session dùng được
xuyên suốt các round bằng đúng `tabId`, không cần lập lại.

Test: `node --check` sạch cả 3 file; `npm test` (`kb-playbook`, `kb-notes`,
`capture-canusetool` — bộ `adopt-tabs` chết theo đúng dự tính) xanh; restart `snap-bridge` thật
— boot sạch, không còn dòng log Chrome Bridge, extension reconnect bình thường.

Rollback theo mục 11: từ đây trở đi, quay lại trạng thái trước GĐ 3 phải `revert` cả GĐ 2 lẫn
GĐ 3 cùng lúc — không tách được nữa.

**GĐ 4 — Dọn tài liệu. ĐÃ XONG (2026-09-03).**
`KB-BRIDGE.md`: mục mới khép lại toàn bộ câu chuyện tab group, giữ lại lịch sử (đừng xoá —
nó giải thích vì sao repo từng đi đường vòng). `SKILL.md`: bảng tool. `KB-SETUP.md`: bỏ bước
cài Chrome Bridge.

- `KB-BRIDGE.md`: thêm mục "Khép lại câu chuyện tab group — Chrome Bridge bỏ hẳn khỏi stage
  capture (2026-09-03)", chèn ngay sau mục "Lật lại: job dùng ĐÚNG tab người dùng..."
  (2026-09-02) — đúng chỗ câu chuyện adopt kết thúc. Tường thuật lại toàn bộ cung: bỏ tab thật
  → agent tự mở tab riêng → dựng adopt hai pha → chạy thật xác nhận → GĐ 1-3 gỡ bỏ theo hướng
  khác hẳn (bỏ Chrome Bridge khỏi phương trình thay vì lách quanh nó). Nêu rõ đánh đổi thật: mất
  đường lùi "navigate tab của job" khi một session tab không dùng được — giờ job dừng và báo,
  không còn tự chữa cháy. Không xoá mục 2026-08-28/2026-09-02 nào — giữ nguyên làm lịch sử.
  Không đụng tới mục 3/4/6/7 (thiết kế/trial gốc, đã tự nhận là "chưa dựng"/lịch sử ở nơi khác
  trong repo) — ngoài phạm vi GĐ 4, việc viết lại toàn bộ tài liệu thiết kế gốc không phải mục
  tiêu của giai đoạn dọn dẹp này.
- `SKILL.md` — mục "Bộ tool" đã đủ (thêm ở GĐ 2: 4 tool mới + mô tả); rà lại lần nữa không thấy
  chỗ nào khác cần sửa cho GĐ 4 riêng.
- `KB-SETUP.md`: xoá hẳn bước "Chrome Bridge phải được đăng ký" (bước 3 cũ) — KB job giờ khởi
  động được không cần Chrome Bridge. Đánh số lại các bước sau (4→3, 5→4, 6→5, 7→6) và mọi chỗ
  tham chiếu chéo số bước; bỏ dòng tương ứng trong bảng "Lỗi thường gặp". Số việc đánh dấu 👤
  (con người phải tự làm) vẫn đúng "ba việc" như dòng mở đầu — không đổi.

Test: đọc lại toàn bộ `KB-SETUP.md` sau khi đánh số lại, không còn tham chiếu số bước nào lệch;
grep sạch — không còn "Chrome Bridge"/"sáu tool"/"bảy tool" nào sót trong file đó.

**Topology A — khép nốt lỗ mục 12.3. ĐÃ XONG (2026-09-03).**
Mục 12.3 liệt kê 4 tool topology A từng dùng (`navigate`, `click`, `fill`, `take_screenshot`) và
map thẳng sang `snap_navigate`/`snap_frame_fill`/`snap_frame_press`/`snap_look` — nhưng bỏ sót
một việc `mcp__chrome__*` vẫn đang âm thầm làm: **tìm tabId**. Topology A không có `sessionTabs`
giao sẵn như topology B (mục GĐ 2, dòng "Cố tình CHƯA làm"); người gõ `/kb` tương tác phải tự
`list_tabs` để biết đang có tab nào, hoặc `new_tab` khi cần mở tab mới — và `mcp__snap__*` tới
GĐ 4 chưa có tool nào làm việc đó.

Cài đặt:
- `src/bridge-worker.js`: thêm `cmdNewTab({url})` (gọi `chrome.tabs.create`, đợi tab load xong
  nếu có `url`) ngay sau `cmdNavigate`; dispatch `list_tabs`/`new_tab` trong
  `handleBridgeCommand` — `list_tabs` tái dùng thẳng `listKbSessionTabs()` đã có sẵn (không viết
  hàm mới), trả về **mọi** tab chụp được, không lọc theo group/session nào.
- `snap-bridge/server.js`: thêm `snap_list_tabs` (không tham số) và `snap_new_tab` (tham số
  `url` tuỳ chọn) ngay trước `snap_navigate`; sửa vài chỗ mô tả tool (`snap_look`,
  `snap_capture_tab`, `snap_frame_list`) còn nhắc `mcp__chrome__navigate`/`list_tabs` làm nguồn
  tabId — trỏ lại `snap_navigate`/`snap_new_tab`/`snap_list_tabs`.
- `SKILL.md`: thêm bullet topology A riêng ở "Cần có trước" (dùng `snap_list_tabs` để biết tab
  đang mở, `snap_new_tab` khi cần mở mới); thêm 2 dòng vào bảng "Bộ tool"; xoá hẳn câu cũ
  `mcp__chrome__* dùng để điều hướng (...)`; viết lại "Quy trình" bước 2 — `snap_list_tabs`/
  `snap_new_tab`/`snap_navigate` + `snap_frame_*` giờ là đường **chính**, không còn khung ⚠️ nói
  đây là đường lùi khi `mcp__chrome__*` "âm thầm fail".

Test: `node --check` sạch `server.js`/`bridge-worker.js`; `npm test` xanh; sau khi reload
extension, gọi tay qua MCP client thật (không phải trang test — tab thật của người dùng đang
mở): `snap_list_tabs` trả về đúng 4 tab thật đang mở (Crisp chat, hai trang quản trị Shopify,
một video YouTube) — **không lọc theo group nào**, khác hẳn `mcp__chrome__list_tabs` cũ (chỉ
thấy tab trong group riêng của Chrome Bridge); `snap_new_tab({url: "https://example.org"})` mở
tab mới thành công, tab đó xuất hiện ngay ở lần `snap_list_tabs` kế tiếp; `snap_navigate` trên
đúng tabId vừa mở hoạt động bình thường — xác nhận `snap_new_tab` trả về `tabId` dùng được ngay
cho tool khác, không cần bước trung gian nào.

*Xong khi*: topology A không còn tham chiếu `mcp__chrome__*` nào trong `SKILL.md`, và tab-
discovery hoạt động trên tab thật của người dùng, không cần Chrome Bridge — **✅ đạt**. Mục
12.3 giờ đã có tool thay thế đầy đủ; kế hoạch này không còn hạng mục nào bỏ ngỏ.

## 10. Test

- **GĐ 1**: mỗi tool một lần chạy tay trên tab thật, có iframe nhúng. Không viết unit test cho
  page function — chúng chạy trong DOM thật, fake DOM sẽ test cái mình tự bịa ra.
- **Logic thuần** (cổng `canUseTool` sau khi đổi sang whitelist): theo đúng khuôn
  `adopt-tabs.test.mjs` — vm + fake, chạy bằng `node`, không thêm dependency.
- **Nghiệm thu GĐ 2**: dựng lại một bài đã có (`quantity-break-overview`) và so ảnh xuất ra
  với bản cũ. Bài đã có là bộ test hồi quy tốt nhất đang có sẵn.

## 11. Rollback

GĐ 1 thuần bổ sung → không cần rollback. GĐ 2 là một commit lật công tắc → `git revert` là về
được, vì GĐ 3 (xoá) cố tình tách rời và làm sau. Sau GĐ 3 thì đường về là revert cả hai.

## 12. Đã quyết (2026-09-03)

1. **`snap_resize`: bỏ, không làm.** Grep toàn repo không thấy nơi nào ghi nhận
   `resize_window` từng thực sự được gọi trong một job thật — chỉ có mặt trong whitelist
   (được phép, chưa từng thấy dùng). Bằng chứng mạnh hơn: `snap_export` đã tự nhận "headless —
   không phụ thuộc cỡ cửa sổ" (`SKILL.md` mục *Bộ tool*) — ảnh xuất bản cuối cùng vốn không
   phụ thuộc kích thước cửa sổ lúc chụp. Không giữ trong GĐ 1, không thêm vào mục 5.
2. **`snap_frame_wait`: hoãn**, đúng hướng nghiêng ban đầu. Đây là tool duy nhất trong nhóm
   không có tiền lệ 1:1 với tool cũ — viết trước khi có ca lỗi thật là đoán hình dạng vấn đề.
   Cách vá tạm (agent tự gọi `snap_frame_find` xác nhận trước khi chụp, xem mục 8.1) đủ cho
   GĐ 1–2. Chỉ viết tool này khi GĐ 2 chạy thật và gặp ca SPA-race cụ thể.
3. **Topology A: bỏ Chrome Bridge theo luôn**, dùng đúng bốn tool mới. `SKILL.md` mục *Bộ tool*
   hiện tại cho thấy topology A (người gõ `/kb` tương tác) chỉ dùng 4 trong 22 tool của Chrome
   Bridge — `navigate`, `click`, `fill`, `take_screenshot` (để nhìn) — và mục *Quy trình* bước 2
   đã tự cảnh báo đúng triệu chứng iframe cross-origin. Lý do cốt lõi ở mục 2.1 (activeTab
   không cấp quyền cho iframe cross-origin) áp dụng y hệt cho người ngồi gõ tương tác, không
   riêng gì job spawn — cái topology A không dính là tầng tab-group/adopt (mục 2.2), vì nó
   chưa từng đi qua `kb-job.js`. Đổi dòng `mcp__chrome__navigate/click/fill/take_screenshot`
   trong `SKILL.md` sang `snap_navigate/snap_frame_fill/snap_frame_press/snap_look`, giữ đúng
   lợi ích "một đường duy nhất" — không mất gì vì A chưa từng cần hơn 4 tool đó.
