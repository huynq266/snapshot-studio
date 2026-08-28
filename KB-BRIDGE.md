# Snap Studio — Nối với Claude Code qua MCP để dựng bài KB

Tài liệu này ghi lại kết quả nghiên cứu kiến trúc cho tính năng: thả một file `.md` từ team
dev vào, Sonnet đọc và rút ra danh sách màn hình cần chụp, Chrome Bridge lái trình duyệt qua
portal của app, Snap Studio chú thích ảnh, và kết quả là một bài KB hoàn chỉnh.

- Bản đầy đủ (có sơ đồ): https://claude.ai/code/artifact/8d383ac4-dadf-45fd-86ce-dedacb47f649
- Ngày nghiên cứu: 2026-08-27
- Trạng thái: **spine (topology A) đã dựng, chạy được đầu-cuối thật trong Chrome, đã qua
  review.** Mã ở `snap-bridge/` + `src/bridge-worker.js` + `src/bridge-editor.js`. Topology B
  (UI Snap Studio tự spawn Agent SDK) đã có kế hoạch chi tiết ở mục 7 dưới, **chưa dựng**. Kế
  hoạch triển khai đầy đủ (cả hai topology, từng bước): `C:\Users\huyng\.claude\plans\witty-sniffing-garden.md`.
- **Bước tiếp theo — nâng lên KB Studio: `KB-STUDIO-PLAN.md`** (lập 2026-08-28). Kế hoạch 5
  phase lấy từ Guide Studio của `ownegoMarketingMaterialToolkit` — nhánh anh em của repo này,
  đã giải xong tầng orchestration mà đây còn thiếu: render headless (xoá bẫy cắt ảnh ở mục 2
  dưới), `job.json` để re-render rẻ, neo annotation vào selector thật, và UI studio để review.

## Kết quả trial (2026-08-27)

Chạy trực tiếp từ phiên Claude Code này qua `mcp__snap__*`: Chrome Bridge mở một trang thật
→ `snap_capture_tab` chụp và ghi PNG thật xuống `kb/img/` → `snap_open` nạp vào editor →
`snap_add` (step marker + highlight box) → `snap_export` → kiểm tra bằng mắt file PNG cuối:
đúng nội dung trang, có annotation, không dính chrome của editor, không bị cắt.

Hai lỗi **có sẵn trong V1** (không phải do snap-bridge gây ra — README đã tự cảnh báo pipeline
này "chưa từng chạy trong trình duyệt thật") lộ ra ngay lần chạy thật đầu tiên, đã vá:

1. **`renderToPngDataUrl()` chụp trúng lúc `.render-veil` còn phủ kín màn hình.** Veil
   (`z-index:1000`, nền `--paper`) chỉ được gỡ ở khối `finally`, tức *sau* khi
   `capture-for-export` đã chụp xong — ảnh xuất ra luôn là một hình chữ nhật xám phẳng, không
   có nội dung. Sửa: gỡ veil (chờ hết transition 120ms) *trước* khi chụp, che lại ngay sau đó
   trước khi tắt `body.render` — vẫn giữ đúng mục đích che "cú giật hình" cho mắt người, chỉ
   đổi thứ tự với việc chụp. `src/export.js`.
2. **`cmdExport()` báo sai kích thước** — trả `capture.img.w/h` (kích thước ảnh nguồn) thay vì
   kích thước ảnh xuất ra thật (phụ thuộc devicePixelRatio + khung screenshot-canvas của máy
   đang chạy editor, không nhất thiết trùng ảnh nguồn). Sửa: decode lại `dataUrl` vừa xuất qua
   `loadImage()`, trả kích thước thật. `src/bridge-editor.js`.
3. **Race condition khi `ensureEditor()` vừa tạo tab mới.** `chrome.tabs.create()` resolve
   ngay khi tab *tồn tại*, không phải khi nó *load xong* — lệnh đầu tiên gửi xuống một tab vừa
   tạo (còn đang nạp 9 file component + Google Fonts) bị rơi mất vì `bridge-editor.js`'s
   listener chưa kịp đăng ký, dẫn tới timeout 20s. Sửa: `waitTabComplete()` chờ
   `tab.status === 'complete'` trước khi gửi lệnh đầu tiên. `src/bridge-worker.js`.

Cũng phát hiện thêm một lỗi vận hành ngoài code: đăng ký MCP server ở **local scope**
(`~/.claude.json`, key theo đường dẫn project) bị lệch do case ổ đĩa Windows không nhất quán
giữa các lần gọi CLI (`D:/...` vs `d:/...`) — cùng một máy, cùng một thư mục, hai lần đăng ký
ra hai key khác nhau, tool "biến mất" giữa các phiên. Chuyển sang **`--scope user`** (không
keyed theo đường dẫn) giải quyết dứt điểm.

**Đã xác nhận trực tiếp** (7/8 mục kiểm chứng ở mục 6 dưới): extension nối WS, ping giữ sống
service worker qua ngưỡng idle 30s thật, `snap_capture_tab` ghi PNG thật, chuỗi
open→add→export cho ảnh đúng, đóng tab giữa phiên rồi `snap_open` tự mở lại đúng.

**Chưa ép được thành kịch bản thật**: nhánh "cửa sổ vẫn nhỏ hơn khung ảnh sau khi đã
maximize" trong `snap_export` — vì `snap_export` luôn tự maximize trước khi đo, nên trên máy
dev bình thường không có cách nào từ xa ép được nhánh lỗi này xảy ra (cần ảnh nguồn lớn hơn cả
màn hình đã maximize). Đã review code, luồng đúng cấu trúc (throw trước dòng crop khi
`strict`), nhưng chỉ dừng ở mức review, chưa chạy thật.

### `snap_capture_tab` cần biết chụp tab nào

Ban đầu chỉ có khớp mờ theo `url` (substring trong danh sách tab đang mở) hoặc rơi về "tab
đang active" — mơ hồ khi có nhiều tab khớp, hoặc khi Chrome Bridge và trình duyệt thật của
người dùng không cùng cửa sổ đang focus. Thêm `tabId` — đúng cái `mcp__chrome__navigate` /
`mcp__chrome__list_tabs` đã trả về — làm đường chính xác, không đoán; `url` lùi thành fallback.
Đã test cả hai chiều qua MCP thật: `tabId` hợp lệ chụp đúng tab, `tabId` không tồn tại báo lỗi
rõ ràng (`no tab with id … (it may have been closed)`), không rơi vào im lặng/timeout.
`src/bridge-worker.js`'s `cmdCaptureTab()`, `snap-bridge/server.js`.

### `snap_add` — cả 8 component addable đã test qua ảnh xuất thật

`step`, `highlight`, `arrow`, `textbox`, `spotlight`, `zoom`, `blur`, `label` — tất cả render
đúng. Một lần đọc sai ban đầu: `spotlight` với vùng cutout nhỏ (350×200) nhìn qua ảnh crop
trông như "làm tối cả khung, không có chỗ sáng" — test lại với vùng to (700×400), đặt giữa
ảnh, xác nhận cutout hoạt động đúng. Không phải bug, chỉ là đọc ảnh vội.

`image` **không** addable qua `snap_add` — xác nhận đúng dự đoán từ code: nó không có
`defaults()`, chỉ có `newImageElement(capture, src, natW, natH)` dùng riêng cho flow paste
clipboard trong `export.js`. Gọi `snap_add({type:'image'})` báo lỗi rõ ràng
(`unknown component type "image"`), không phải bug — đã bỏ `'image'` khỏi `ADD_TYPES` trong
`snap-bridge/server.js` để tool không quảng cáo sai khả năng của chính nó.

`custom:<id>` **chưa test được** — cần có sẵn một component tự tạo qua tab Components/Lab
trước (`chrome.storage` của profile này hiện chưa có cái nào: "None yet. Open the Components
tab to make one."). Việc tạo custom component là một tính năng khác (Component Forge), ngoài
phạm vi snap-bridge.

### `snap_add` với `arrow` — component đầu tiên lộ ra bug

`arrow` là type duy nhất trong 9 component dùng `x1/y1/x2/y2` (hai đầu mút) thay vì `x/y` như
mọi type khác — `newElement('arrow')` không đi qua flow kéo-thả tương tác của editor (đó là
đường duy nhất `addElement()` trong UI dùng cho arrow), mà dùng thẳng `arrow.defaults(c)`.

Đã xác nhận qua ảnh xuất thật: mặc định không `props` đặt gần tâm ảnh, hợp lý; `props` tuỳ
chỉnh (`x1,y1,x2,y2,shape:"curved"`) render đúng toạ độ, đúng dạng cong. Phát hiện và vá một
bug: response của `snap_add` báo `(undefined, undefined)` cho arrow vì code cũ giả định mọi
component đều có `el.x/el.y`. Sửa cả `src/bridge-editor.js`'s `cmdAdd()` (trả `x1/y1/x2/y2`
khi `el.type === 'arrow'`) và `snap-bridge/server.js`'s format response.

### Điều khiển nội dung trong iframe cross-origin (2026-08-28)

Job KB đầu tiên báo không cuộn/tìm/click được nội dung app Qikify nhúng trong Shopify admin:
`mcp__chrome__scroll` cuộn 3000px không đổi pixel nào, `mcp__chrome__find` trả 0 match cho
text đang hiện rõ trên màn hình. Nguyên nhân: app chạy trong **iframe cross-origin**
(`bkv-embedded.qikify.com` trong `admin.shopify.com`), và `activeTab` của Chrome Bridge chỉ
cấp host permission cho **origin của frame chính**, không lan xuống iframe khác origin — đã
xác minh qua doc chính thức, và qua schema thật của ba tool đó (không có tham số nhắm frame,
chỉ có `tabId`). `snap_capture_tab`/`take_screenshot` vẫn chụp được vì chúng làm việc ở tầng
compositor, không cần chạy JS trong DOM của frame.

Cách vá: `chrome.webNavigation.getAllFrames()` + `chrome.scripting.executeScript({target:
{frameIds}})` — injection được cấp quyền qua `host_permissions` của **chính Snap Studio**
(`<all_urls>`, đã có sẵn), không qua same-origin policy của trang. Thêm `webNavigation` vào
`permissions`; bốn tool mới `snap_frame_list` / `snap_frame_scroll` / `snap_frame_find` /
`snap_frame_click` trong `src/bridge-worker.js` + `snap-bridge/server.js`. Đã test thật:
liệt kê đúng iframe, cuộn tới đúng vị trí, click đổi đúng state (xác nhận cả bằng ảnh xuất
lẫn bằng đọc property sống).

**Ba bug tự gây ra trong lần dựng này, đều là bài học chung chứ không riêng trang này:**

1. **Selector sinh ra không duy nhất — bug nghiêm trọng nhất, tốn 6 vòng thử sai.**
   `pageFind` dựng selector từ tag + `nth-of-type` với giới hạn 6 tầng, không neo vào đâu cả:
   `ul > li:nth-of-type(1) > div > label > span:nth-of-type(2) > span`. Component kit lặp lại
   y hệt cấu trúc markup cho mọi instance, nên `document.querySelector()` trả về **match đầu
   tiên trong toàn tài liệu** — radio "All products" của nhóm khác, không phải "Percentage"
   đang cần. Tệ hơn: "All products" vốn đã được chọn sẵn, nên mọi lần click đều báo
   `checked: true` một cách thuyết phục, và tôi đã kết luận nhầm rằng đây là "quirk không vá
   được của Polaris/Qikify" — trong khi thực tế chưa từng click đúng phần tử nào. Người dùng
   phát hiện ra bằng cách chỉ ra selector của họ (`[data-field-name="discount_type"] .Polaris-
   RadioButton__ChoiceLabel`) có neo vào container duy nhất. Sửa: `uniqueSelector()` đi ngược
   lên cây (và neo vào `id` duy nhất ngay khi gặp) tới khi selector thật sự resolve lại đúng
   phần tử nó sinh ra từ đó; thêm cờ `selectorIsUnique` để trường hợp còn mơ hồ lộ ra thay vì
   im lặng tác động nhầm.
2. **Đọc `checked` qua `outerHTML` là sai.** Dump HTML chỉ phản ánh **attribute** `checked=""`;
   set `.checked` bằng JS đổi **property** mà không đồng bộ ngược lại attribute. Phải đọc
   thẳng property sống (`controlChecked`).
3. **Ảnh chụp có thể trễ hơn state thật.** Vài lần chụp ngay sau click cho ảnh chưa re-render,
   dẫn tới kết luận "click không ăn" trong khi DOM đã đổi. Đọc property là nguồn tin cậy;
   ảnh chỉ để xác nhận cuối.

**Đã thử và đã gỡ bỏ**: `chrome.debugger` + `Input.dispatchMouseEvent` (CDP) — dựng xong,
chạy không lỗi, nhưng hoàn toàn thừa một khi selector đã đúng, mà lại đòi quyền `debugger`
(banner "đang debug trình duyệt này"). Đã xoá `snap_frame_click_native` cùng quyền đó.
Cũng từng đổi `executeScript` sang `world: 'MAIN'` theo một giả thuyết sai; đã trả về
`ISOLATED` (mặc định an toàn hơn) và test lại xác nhận `ISOLATED` chưa từng là vấn đề.

Bài học chung của cả ba lần đi sai trên: khi một thao tác "chạy không lỗi nhưng không có tác
dụng", hãy nghi ngờ **mình đang tác động nhầm đối tượng** trước khi kết luận môi trường hay
thư viện bên kia có quirk không vá được.

### KB Studio UI (Phase 3) — instruction + session tabs thay cho MD + domain (2026-08-28)

Hai đổi cấu trúc ở tab KB, thay cho phần "chốt qua hỏi trực tiếp người dùng" ở mục 7 gốc:

**1. Instruction thay vì chỉ nhận MD.** Trước đây file `.md` là **bắt buộc** và là toàn bộ
input — không có chỗ gõ lệnh. Giờ `#kbInstructionInput` (textarea) là input chính, **bắt
buộc**; file `.md` (`#kbUploadBtn`) chuyển thành **tài liệu tham khảo, tuỳ chọn** — đưa vào
`prompt` như bối cảnh nền, không phải nguồn sự thật. `buildPrompt()`/`buildSystemPrompt()`
trong `kb-job.js` nói rõ với agent: instruction là việc thật phải làm, reference doc (nếu có)
chỉ để tham khảo.

**2. Session tabs thay domain allowlist.** Lý do đổi: domain allowlist chặn nhầm chỗ — nó hạn
chế agent **mở tab để navigate** dựa trên so khớp chuỗi domain (dễ hụt khi có iframe khác
origin, chuyển hướng, hoặc app cần nhiều domain), trong khi ranh giới thật sự nên là **tab
nào người dùng cho phép đụng tới**, không phải **domain nào**. Chrome Bridge chính nó đã làm
đúng việc này từ trước — mọi tool `mcp__chrome__*` nhận `tabId` **tuỳ chọn** nhưng bị khoá
cứng vào "tab group của phiên nó" (theo đúng schema thật của các tool, xác nhận qua
`ToolSearch`: "must be in this session's own tab group; any other tab is refused"), và
`new_tab`/`navigate` khi không truyền `tabId` sẽ tự mở/dùng tab **trong group riêng của Chrome
Bridge** — không phải group của Snap Studio.

Vì group đó do process Chrome Bridge tự quản, Snap Studio không có API để đọc/ghi trực tiếp
vào nó. Cách vá: dựng một whitelist tabId **riêng của Snap Studio**, độc lập, cùng mô hình
UX ("mở sẵn tab, đưa vào phiên") nhưng không phụ thuộc group nội bộ của Chrome Bridge:

- `bridge-worker.js`: `kbSessionTabIds` (Set, persist qua `chrome.storage.local`), tự dọn tab
  đã đóng (`chrome.tabs.onRemoved` + prune khi load). Ba lệnh cục bộ `kb-session-cmd`
  (`list`/`add`/`remove`) — **không** đi qua snap-bridge, thuần `chrome.tabs` nên trả lời tại
  chỗ.
- `bridge-kb.js`: hai danh sách trong rail — "In session" / "Open tabs" (nút refresh, thêm
  bằng nút `+`, bỏ bằng nút `×`). Lúc bấm Start, snapshot `{id, title, url}` của các tab đang
  trong session gửi kèm `kb_start`.
- `kb-job.js`: `startJob({instruction, markdown, mdFilename, sessionTabs, ...})` — đòi
  `sessionTabs` non-empty. `canUseTool` giờ khoá theo `tabId`, không theo domain: mọi tool có
  tham số `tabId` (`mcp__chrome__*` **và** `snap_capture_tab`/`snap_frame_*`, cộng
  `snap_add`'s `at.tabId`) phải trúng một tabId trong session, **thiếu `tabId` cũng bị từ
  chối** (thiếu nghĩa là "dùng tab mặc định của Chrome Bridge" — nằm ngoài whitelist này).
  `mcp__chrome__new_tab` bị chặn tuyệt đối — tool đó không có `tabId` để soát, và tab mới nó
  mở rơi vào group của Chrome Bridge chứ không phải whitelist này.
- **Tác dụng phụ quan trọng**: `mcp__snap__*` phải **rời khỏi `allowedTools`** để đi qua
  `canUseTool` (một entry trong `allowedTools` bỏ qua `canUseTool` hoàn toàn — xác nhận lại
  đúng cơ chế đã ghi ở mục 7 gốc, giờ áp dụng cho cả nhánh snap chứ không riêng chrome nữa).
  `allowedTools: []`, mọi quyết định đi qua `canUseTool`.

**Giới hạn đã biết, chưa vá**: whitelist chỉ là danh sách của Snap Studio; nếu một tab **có**
trong whitelist này nhưng **không** nằm trong tab group nội bộ của Chrome Bridge, lệnh
`mcp__chrome__*` trên tab đó vẫn bị chính Chrome Bridge từ chối (lỗi rõ ràng, không im lặng)
— người dùng cần tab đó khả dụng ở cả hai phía. Không tự tạo/gắn Chrome Tab Group thật
(`chrome.tabGroups`) để đồng bộ hai bên — cân nhắc thêm quyền + độ phức tạp so với lợi ích,
để dành nếu sau này thấy cần.

### Ảnh chụp bị ám vàng/cam — xác nhận không phải Chrome Bridge, không phải Night Light, nguồn thật chưa chốt (2026-08-28)

Người dùng báo ảnh trong `kb/img/test-01-nav*.png` và `kb/demo-job/01-nav.png` bị dính một lớp
tint vàng/cam ở góc, nghi do "tool Chrome bridge". Điều tra qua nhiều vòng, ghi lại đầy đủ vì
kết luận đầu tiên **sai** (Night Light — người dùng xác nhận máy không bật):

**1. Không phải Chrome Bridge.** So sánh trực tiếp, cùng lúc, cùng một trang trắng tuyệt đối
(`background:#ffffff`, không nội dung): `mcp__chrome__take_screenshot` (Chrome Bridge, CDP
`Page.captureScreenshot`) → ảnh trắng sạch tuyệt đối. `snap_capture_tab` (Snap Studio thật,
`chrome.tabs.captureVisibleTab` trong `background.js:88`) → tint y hệt ảnh gốc bị báo lỗi, tái
hiện được ngay lập tức. Tint đến từ đường capture thật Snap Studio dùng cho mọi người dùng, không
phải công cụ test.

**2. Không phải Night Light.** Giả thuyết ban đầu — người dùng xác nhận tính năng này đang tắt.

**3. Không phải phần tử Chrome Bridge tự vẽ lên trang.** Nghi tiếp: Chrome Bridge có vẻ tiêm một
`<div id="__cc_border">` (`position:fixed`, `z-index:2147483647`, nằm ngoài `<body>` nên sống sót
qua `body.innerHTML = ''`) vào mọi trang nó điều khiển — khả năng nó là viền chỉ báo "tab đang bị
điều khiển" và bị `captureVisibleTab` chụp trúng nhưng CDP tự loại khi chụp chính nó. **Đã bác
bỏ bằng thực nghiệm**: poll style của phần tử này mỗi 20ms trong suốt một lần gọi `snap_capture_tab`
thật (183 lần đọc, trải dài qua cả một lần gọi lỗi "image readback failed" và một lần thành công)
— style **không đổi một lần nào**, luôn `width:0;height:0;border:0` (vô hình), trong khi ảnh chụp
ra vẫn có tint. Phần tử này không phải nguồn.

**Dữ liệu pixel đã đo được** (giải mã PNG thủ công bằng `zlib.inflateSync`, không qua thư viện —
tránh phụ thuộc `sharp`/`pngjs` không có sẵn trong `snap-bridge/node_modules`), trên ảnh
1920×889 chụp từ trang trắng tuyệt đối:

| Điểm | RGB |
|---|---|
| 4 góc (0,0 / topRight / bottomLeft / bottomRight) | `[242,177,121]` – `[243,178,122]` — **gần như giống hệt nhau** |
| 4 điểm giữa cạnh (midTop/midLeft/midBottom/midRight) | `[245,197,156]` – `[246,198,158]` — **gần như giống hệt nhau** |
| Tâm ảnh, và điểm 25%/25% từ góc | `[255,255,255]` — **trắng tuyệt đối** |

Đối xứng hoàn hảo theo cả 4 góc lẫn cả 4 cạnh, tâm ảnh trắng tinh — đúng hình dạng một
**vignette toán học** (rơi dần đều từ viền vào tâm), không giống một dịch chuyển màu đồng đều
(Night Light/ICC profile kiểu gamma-ramp thường tint **toàn ảnh như nhau**, không tạo vignette),
cũng không giống artefact quang học thật (hiếm khi đối xứng hoàn hảo 4 góc/4 cạnh như vậy).

**Giả thuyết còn lại, chưa kiểm chứng được** — nghiêng về một tính năng "adaptive
brightness"/"chống lưu hình" ở tầng driver GPU hoặc hệ điều hành mà `chrome.tabs.captureVisibleTab`
đọc trúng còn CDP thì không (vd: tính năng chống burn-in cho panel OLED của Windows 11, hoặc
Intel Display Power Saving Technology / "Adaptive Brightness" trong driver đồ hoạ — cả hai đều
được biết là làm tối/ám màu vùng sáng lớn tĩnh theo kiểu rơi dần từ viền, độc lập với Night
Light). Chưa xác nhận được vì không nên tự dò registry/driver settings của máy người dùng khi
chưa được hỏi. **Không có cách vá trong code dù nguồn là gì** —
`chrome.tabs.captureVisibleTab({format:'png'})` không có tham số tắt color management; nếu xác
nhận đúng nguồn thì hướng xử lý vẫn là phía driver/hệ điều hành, không phải sửa `background.js`.

`kb/img/test-01-nav*.png` và `kb/demo-job/01-nav.png` là ảnh fixture của phiên test (không phải
nội dung KB thật của người dùng) — xoá bằng nút Delete rồi chụp lại sau khi xác định/tắt được
nguồn là đủ, không cần giữ.

---

## 0. Bốn điều đã kiểm chứng trên máy này (không phải suy đoán)

Bốn điều này quyết định toàn bộ hình dạng kiến trúc bên dưới:

1. **Chrome Bridge (`mcp__chrome__*`, cổng `127.0.0.1:8787`) không mở được trang
   `chrome-extension://`.** Thử trực tiếp: `navigate` tới `chrome-extension://…/editor.html` →
   `Cannot navigate to … (browser-internal page)`. Nghĩa là Claude Code **không** lái được
   editor của Snap Studio qua Chrome Bridge. Mọi phương án kiểu "cứ dùng `javascript_eval` gọi
   thẳng vào editor" đều không đi được.
2. **`mcp__chrome__take_screenshot` không ghi ra file.** Ảnh trả thẳng vào context của model
   (`<output_image>` inline), không có path nào cả — không có gì để chú thích, không có gì để
   nhúng vào bài KB. Cần một đường chụp thứ hai.
3. **Cổng `8787` là do chính `claude.exe --chrome-native-host` host**, khai báo trong
   `~/.claude.json` dạng MCP `type: "http"` kèm header `Authorization: Bearer …`. Ta không dựng
   lại nó — ta dựng một tiến trình **thứ hai** bên cạnh, sao y đúng mô hình đó.
4. **MV3 service worker chỉ sống được nhờ hoạt động WebSocket.** Từ Chrome 116, mọi hoạt động
   trên một kết nối WebSocket reset lại đồng hồ idle 30 giây của service worker — ping mỗi ~20s
   là cách chuẩn để giữ nó sống, và đúng là cách Chrome Bridge đang làm.
   (Nguồn: [Use WebSockets in service workers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets),
   [Chrome 116 for Extensions](https://developer.chrome.com/blog/chrome-116-beta-whats-new-for-extensions).)

## 1. Hình dạng bắt buộc

Snap Studio là extension MV3 thuần, không có process Node đứng sau (README đã nói rõ điều này
khi giải thích vì sao export phải nhờ `captureVisibleTab` thay vì Playwright — xem "How export
actually works" trong README.md). Một extension không tự mở được cổng nghe, nên nó không thể
*là* MCP server — nó phải nối *ra* một tiến trình local.

Tiến trình đó, gọi là **`snap-bridge`**, có hai mặt:

- **MCP HTTP server** cho Claude Code, cổng đề xuất `:8788` (Chrome Bridge đã chiếm `:8787`).
- **WebSocket server** cho service worker của Snap Studio nối vào, ping/pong giữ sống theo
  đúng cơ chế Chrome 116 ở mục 0.4.

```
Claude Code ──MCP :8787──▶ Chrome Bridge ──▶ portal của app (tab web thường)
     │
     └──MCP :8788──▶ snap-bridge ──WebSocket──▶ Snap Studio service worker ──▶ editor.html
                          │
                          └──▶ ghi kb/img/*.png + kb/*.md xuống đĩa
```

Đường Chrome Bridge → Snap Studio (`chrome-extension://`) bị chặn theo mục 0.1 — đó chính là
lý do `snap-bridge` phải tồn tại như một kênh riêng.

## 2. Bề mặt tool của `snap-bridge`

Sáu tool, mỗi cái ánh xạ thẳng vào một đường đã có sẵn trong mã nguồn — không cái nào đòi viết
lại engine của editor:

| Tool | Làm gì | Đi qua mã nào đã có |
|---|---|---|
| `snap_status` | Extension còn nối không, đang mở capture nào | Ping trên WebSocket |
| `snap_capture_tab` | Kích hoạt tab → chụp → **ghi PNG ra đĩa** | `background.js` → `shootVisibleTab()` |
| `snap_open` | Nạp một PNG vào editor | `chrome.storage.local.pendingCapture` + message `snap-capture` — đúng đường `loadCapture()` đang nghe (`editor.js` cuối file) |
| `snap_kit` | Trả `use_when` / `gotchas` của 8 component | `src/kit-catalog.js` |
| `snap_add` | Thêm annotation vào ảnh đang mở | `newElement(type)` trong `editor.js` — `step`, `textbox`, `highlight`, `blur`, `zoom`, `arrow`, `spotlight`, `label`, `image`, `custom:<id>` |
| `snap_export` | Render PNG cuối, ghi ra đường dẫn | `export.js` → `renderToPngDataUrl()` |

### Bẫy đã có sẵn trong README, phải xử lý trong `snap_export`

Export chụp lại chính tab editor ở chế độ `body.render`; nếu cửa sổ nhỏ hơn khung ảnh, bản xuất
**bị cắt** — hiện chỉ có một toast báo (`export.js`, đoạn `Browser window is smaller than…`).
Trong pipeline tự động không ai đọc toast đó. Vậy `snap_export` phải:

1. Gọi `chrome.windows.update({ state: 'maximized' })` trước khi render.
2. **Trả lỗi thay vì trả ảnh** nếu khung vẫn không vừa sau khi maximize — một bài KB có ảnh cụt
   còn tệ hơn một bài KB dựng thất bại.

### Đăng ký với Claude Code

Sao y mô hình Chrome Bridge — HTTP local kèm Bearer token, scope project để chia sẻ qua git:

```bash
claude mcp add --transport http snap http://127.0.0.1:8788/mcp \
  --header "Authorization: Bearer $SNAP_BRIDGE_TOKEN"
```

hoặc `.mcp.json` ở gốc repo:

```json
{
  "mcpServers": {
    "snap": {
      "type": "http",
      "url": "http://127.0.0.1:8788/mcp",
      "headers": { "Authorization": "Bearer ${SNAP_BRIDGE_TOKEN}" }
    }
  }
}
```

## 3. Luồng dựng một bài KB

1. **Bạn** — thả `release-notes.md` vào (terminal, hoặc ô upload trong Snap Studio tuỳ topology).
2. **Sonnet** — đọc MD, ép ra JSON có schema: mỗi mục gồm URL, thao tác để tới đúng trạng thái,
   và điều cần làm nổi bật. Đây là chỗ duy nhất file MD được diễn giải — mọi bước sau chạy trên
   JSON đó.
3. **Chrome Bridge (`:8787`)** — `navigate` → `click`/`fill` → `take_screenshot`. Ảnh này vào
   thẳng context để model *nhìn thấy* UI thật mà mô tả cho đúng; không cần thành file.
4. **`snap-bridge` (`:8788`)** — `snap_capture_tab` → PNG xuống đĩa. Bù đúng lỗ hổng ở mục 0.2;
   đây mới là file sẽ đi vào bài viết.
5. **`snap-bridge`** — `snap_open` → `snap_add` (step marker, highlight, blur vùng PII) →
   `snap_export` ra `kb/img/`. Model đọc `snap_kit` trước để chọn đúng component thay vì đoán.
6. **Sonnet** — viết `kb/<slug>.md`, nhúng ảnh đã xuất, bám cấu trúc bài KB sẵn có của team.
7. **Người** — duyệt trước khi đăng. Không phải thủ tục thừa — xem mục 5.2.

## 4. Hai topology — cùng một `snap-bridge`, khác một cạnh

**A — Claude Code là driver (dùng được ngay).** Bạn gõ trong terminal, Claude Code tự gọi các
MCP tool ở cả hai cổng `:8787` và `:8788`.

**B — Snap Studio là driver (thêm một vòng gọi ngược).** Bạn thả file vào UI Snap Studio,
`snap-bridge` tự spawn một phiên Claude Agent SDK chạy `model: "claude-sonnet-5"`, phiên đó gọi
ngược lại chính `snap-bridge` (và Chrome Bridge) qua MCP.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const msg of query({
  prompt: kbPrompt(mdFileContents),
  options: {
    model: "claude-sonnet-5",
    mcpServers: {
      chrome: { type: "http", url: "http://127.0.0.1:8787/mcp",
                headers: { Authorization: `Bearer ${chromeToken}` } },
      snap:   { type: "http", url: "http://127.0.0.1:8788/mcp",
                headers: { Authorization: `Bearer ${snapToken}` } },
    },
    allowedTools: ["mcp__snap__*", "mcp__chrome__*", "Read", "Write"],
  },
})) { /* stream tiến độ ngược về UI Snap Studio */ }
```

> Model ID đúng là `claude-sonnet-5`. (Tài liệu Agent SDK còn ví dụ cũ ghi
> `claude-3-5-sonnet-20241022` — đừng chép theo, và đừng gắn hậu tố ngày tháng vào ID.)

**Khuyến nghị: dựng `snap-bridge` trước, chạy topology A để kiểm chứng toàn bộ luồng ở mục 3,
rồi mới bọc UI thành B.** B chỉ thêm cách khởi động, không thêm năng lực nào — nếu bước phân
tích MD hay bước chọn component sai, phát hiện ở A rẻ hơn nhiều so với debug xuyên qua một tầng
spawn.

## 5. Ba việc phải chốt trước khi viết dòng code đầu tiên

### 5.1 — Ảnh khách hàng nằm lại trong `chrome.storage.local` (chặn, phải vá trước)

`background.js:84,119` ghi `pendingCapture` nhưng không nơi nào xoá. ROADMAP.md mục V1.1 đã ghi
nhận đây là việc chặn dùng thật với người dùng thủ công. Với pipeline tự động, vấn đề nặng hơn:
số ảnh bơm vào storage tăng theo *mỗi lần dựng KB*, không phải mỗi lần một người bấm nút. Phải
gọi `chrome.storage.local.remove([...])` trong `loadCapture()` sau khi ảnh đã vào editor —
**trước** khi bridge bắt đầu gọi `snap_open` lặp lại nhiều lần trong một phiên.

### 5.2 — Agent chạy trên phiên đăng nhập thật của bạn

Chrome Bridge dùng đúng profile Chrome đang mở — đó là lý do nó vào được portal mà không cần xử
lý đăng nhập, và cũng là lý do nó vào được *mọi thứ khác* bạn đang đăng nhập. Cần allowlist
domain ở tầng prompt cho bước `navigate`, và **không** đặt phiên dựng KB ở `permissionMode:
"bypassPermissions"`.

### 5.3 — `snap-bridge` chính là câu trả lời cho "V2 có server hay không" đang treo trong ROADMAP

ROADMAP.md, mục "Quyết định còn treo" #2, để ngỏ việc này vì link chia sẻ, Snap Library dùng
chung và tích hợp ticket đều cần một nơi lưu ngoài trình duyệt. Dựng `snap-bridge` là đã chọn
"có server", dù lý do ban đầu khác. Nên chốt phạm vi của nó ngay — output KB, ảnh chụp, quản lý
storage — kẻo mỗi tính năng V2 sau này lại đẻ ra một tiến trình local riêng.

### 5.4 — Blur PII đổi tính chất khi tự động hoá

ROADMAP.md xếp "preset blur cho vùng nghi chứa PII" vào V2 như một điểm khác biệt so với
Monosnap — tiện ích người dùng *nhớ* bấm. Trong pipeline tự động nó là thứ duy nhất đứng giữa
một màn hình portal có dữ liệu thật và một bài KB công khai. Bước 5 ở mục 3 (`snap_add` chọn
`privacy-blur`) không được là tuỳ chọn bị bỏ qua — hoặc model phải chủ động đề xuất blur, hoặc
bước duyệt ở mục 3.7 phải bắt xác nhận rõ ràng trước khi xuất.

## 6. Việc tiếp theo (trial — topology A trước)

Trật tự dựng đề xuất, theo đúng khuyến nghị ở mục 4:

1. `snap-bridge/` — server Node tối thiểu: WebSocket server (`ws`) + MCP HTTP server
   (`@modelcontextprotocol/sdk`), hai tool đầu: `snap_status`, `snap_capture_tab`.
2. Phía extension: thêm WS client vào `background.js` (kết nối `ws://127.0.0.1:<port>`,
   ping/pong, reconnect khi rớt) — **không** đổi hành vi capture hiện có, chỉ thêm một người
   nghe mới bên cạnh `chrome.runtime.onMessage` đang có.
3. Vá mục 5.1 (xoá `pendingCapture`) trước khi bridge gọi `snap_open` lần đầu.
4. Đăng ký `snap` server với Claude Code (`claude mcp add`), thử `snap_status` +
   `snap_capture_tab` từ chính phiên Claude Code này (topology A).
5. Thêm `snap_open` / `snap_kit` / `snap_add` / `snap_export`, thử trọn luồng mục 3 trên một
   trang thật, xác nhận bẫy cửa sổ nhỏ ở mục 2 báo lỗi đúng cách thay vì âm thầm cắt ảnh.
6. Chỉ sau khi (4)–(5) chạy ổn: bọc topology B (spawn Agent SDK từ UI).

## 7. Topology B — kế hoạch triển khai (chưa dựng)

Tính năng gốc user yêu cầu từ đầu: thả `.md` **vào chính UI Snap Studio**, không gõ terminal.
Mọi tool `snap_*` đã có (mục 2) không đổi gì — phiên Agent SDK spawn ra chỉ là một MCP client
thứ hai gọi vào đúng `:8788/mcp`. Phần việc mới nằm ở nơi UI nhận file, cách `snap-bridge` spawn
và giám sát phiên đó, và ranh giới an toàn cho một agent chạy không người giám sát trên trình
duyệt đã đăng nhập thật (mục 5.2). Kế hoạch chi tiết từng bước dựng-và-tự-kiểm-chứng nằm ở
`C:\Users\huyng\.claude\plans\witty-sniffing-garden.md` (phần "Trial 2"); mục này ghi lại các
**quyết định kiến trúc đã chốt**, để không phải lật lại file plan mỗi lần cần tra.

**Domain allowlist cho `navigate` (mục 5.2): bắt buộc**, không tuỳ chọn — nút Start ở UI bị khoá
tới khi người dùng nhập domain/URL-prefix cho phép. Đã chốt qua hỏi trực tiếp người dùng, không
phải suy đoán.

**Kênh điều khiển + tiến độ: dùng lại `/ext` WebSocket đã có**, không mở endpoint HTTP mới,
không dùng SSE. `EventSource` không set được header `Authorization` (buộc nhét token vào query
string); một endpoint HTTP mới còn phải tự nghĩ lại cơ chế xác thực từ đầu vì Bearer không dùng
được ở phía extension (không đọc được file `.token`) — đúng lý do `/ext` đã chọn Origin-check
thay vì token ngay từ đầu. Thêm `cmd: 'kb_start'`/`'kb_cancel'` (request/response đúng khuôn
`callExtension()`) và một push một chiều `kb_progress` vào đúng message handler `/ext` đang có.

**Ghi bài KB cuối: tool MCP thứ bảy `snap_write_kb`**, không cấp `Write` chung cho phiên spawn —
`Write` không tự giới hạn thư mục, còn `snap_write_kb` đi qua đúng `resolveOut()` đang khoá mọi
ghi file vào `kb/`, giữ topology B trên cùng ranh giới an toàn mà mọi ảnh của topology A đã đi
qua. `{ path, content, overwrite? }`; từ chối đuôi khác `.md`; từ chối ghi đè trừ khi
`overwrite:true`.

**Tự phát hiện token Chrome Bridge** từ `~/.claude.json` (`mcpServers.chrome.{url,
headers.Authorization}`) thay vì bắt người dùng nhập tay lần hai — đã xác nhận trực tiếp trên
máy này rằng cả `chrome` lẫn `snap` đều nằm ở top level (`--scope user`), không keyed theo path
project, đọc ổn định. Không throw khi thiếu — chỉ đường khởi tạo job KB phụ thuộc cái này, sáu
tool `snap_*` cũ và kênh `/ext` không đụng tới.

**`allowedTools` cho phiên spawn** — toàn bộ `mcp__snap__*` (bảy tool); từ `mcp__chrome__*` chỉ
`navigate`, `click`, `fill`, `fill_form`, `type_text`, `scroll`, `find`, `wait_for`, `list_tabs`,
`new_tab`, `switch_tab`, `close_tab`, `resize_window`, `take_screenshot`, `chrome_status`. Loại
hẳn `javascript_eval` (thực thi code tuỳ ý — đọc được cả thứ không hiện trên ảnh chụp),
`read_network_requests`/`read_console_messages` (có thể lộ secret/PII chưa từng hiện ra màn
hình), `get_page_text`/`read_page` (kéo thẳng text trang — kể cả PII — vào context rồi có thể
trôi thẳng vào văn bản bài KB; ảnh chụp còn có `blur` để che, đoạn văn thì không có cơ chế che
tương đương — rủi ro này **nặng hơn**, không nhẹ hơn ảnh), `upload_file` (agent không người giám
sát submit file lên form bên thứ ba là một lớp rủi ro khác hẳn). Không `Read`/`Write`/`Bash`/
`Glob`/`Grep`/`WebFetch`/`WebSearch` — MD đi thẳng vào `prompt` dạng string. **Không bao giờ
`permissionMode: 'bypassPermissions'`.**

**Domain allowlist — hai lớp**: (1) tầng prompt, luôn có — domain được nhét vào cả đầu
`systemPrompt` (khối lệnh cứng) lẫn cuối `prompt` (nhắc lại). (2) tầng code, có điều kiện — nếu
`canUseTool` của SDK cho xem được argument `url` trước khi tool chạy (phải xác minh qua `.d.ts`
thật trước khi code, xem dưới), `kb-job.js` chặn thẳng `navigate`/`new_tab` lệch allowlist. Nếu
SDK không hỗ trợ đúng shape đó, lớp 2 không có — phải ghi rõ, không được im lặng coi như đã chặn
cứng.

**Cần xác minh qua `.d.ts` thật của `@anthropic-ai/claude-agent-sdk` trước khi viết `kb-job.js`**
(đúng cách đã giải quyết dứt điểm sự mơ hồ tương tự với `@modelcontextprotocol/sdk` — đọc gói đã
cài, không tin fetch trang doc): enum thật của `permissionMode` (đã thấy hai nguồn khác nhau
trong quá trình research); shape thật của `canUseTool`; có hook interrupt/cancel thật trên
`query()` không (quyết định nút Stop dừng thật hay chỉ ngừng hiện log); shape chính xác của
`options.mcpServers`/`allowedTools`/`systemPrompt` và các message type trong stream.

**Việc mới cần dựng**: `snap_write_kb` (trong `server.js`); `snap-bridge/chrome-bridge-config.js`;
`snap-bridge/kb-job.js`; nối `kb_start`/`kb_cancel`/`kb_progress` vào `/ext`; UI — tab thứ ba
`data-view="kb"` trong `editor.html` (input `#kbMdInput` riêng, không đụng `#mdInput` đã có của
Component Forge), banner `#kbBanner` cạnh `#viewTabs` (báo canvas đang bị điều khiển tự động —
`snap_open`/`snap_add`/`snap_export` dùng chung state `capture`/`els` singleton với người dùng
thao tác tay), `src/bridge-kb.js` mới, và một vá nhỏ có chủ đích ở `bridge-editor.js`'s
`cmdOpen()`: chỉ `setView('snap')` khi view hiện tại không phải `'kb'`, để người đang xem log
job không bị giật màn hình. Đây là thay đổi duy nhất chạm vào code topology A đã hoàn thiện.

**Không làm trong lần dựng này**: siết `/ext` Origin-check xuống đúng ID extension (cần pin
`key` trong `manifest.json`); hàng đợi nhiều job cùng lúc; preset blur PII bắt buộc (mục 5.4).
