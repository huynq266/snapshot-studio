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

**Giới hạn đã biết ở đây — sau này đổi hẳn cách tiếp cận, xem mục ngay dưới**: whitelist chỉ là
danh sách của Snap Studio; nếu một tab **có** trong whitelist này nhưng **không** nằm trong tab
group nội bộ của Chrome Bridge, lệnh `mcp__chrome__*` trên tab đó vẫn bị chính Chrome Bridge từ
chối (lỗi rõ ràng, không im lặng) — người dùng cần tab đó khả dụng ở cả hai phía.

### Giới hạn trên đã cắn thật — bỏ hẳn "dùng đúng tab người dùng mở", để agent tự mở tab (2026-08-28)

Chạy job KB thật đầu tiên (bài "Variant swatches") thì dính đúng giới hạn vừa ghi ở trên: tab
người dùng thêm vào session **có** trong whitelist Snap Studio nhưng job mới lại luôn được Chrome
Bridge gán một **tab group MỚI, rỗng** (`"Claude · f7b7"`, khác group của phiên tôi lúc đó, khác
group của lần chạy trước) — tab thật của người dùng không bao giờ tự nằm trong group đó, nên mọi
`mcp__chrome__*` bị chính Chrome Bridge từ chối ngay bước đầu. Xác nhận qua `kb_query` (WS thật):
job đã **kết thúc hẳn** (`status: "error"`) chứ không phải đang treo chờ — dòng "please drag the
tab... let me know" chỉ là câu chốt cuối cùng của agent trước khi phiên kết thúc.

Vì group luôn mới theo từng phiên agent (khác `chrome.tabGroups` thật — không có cách nào Snap
Studio tự gắn tab CÓ SẴN của người dùng vào một group agent chưa tồn tại tại thời điểm người dùng
bấm Start), yêu cầu "chỉ dùng đúng tab đã mở sẵn" **về cấu trúc là không khả thi** — người dùng
không thể biết trước tên group để kéo tab vào, và group cũ (nếu có) không tái dùng được cho lần
chạy sau.

**Quyết định (người dùng chọn qua 3 phương án được đề xuất)**: bỏ hẳn ràng buộc "phải đúng tabId
đã cho trước" — để job **tự mở tab của chính nó** (`mcp__chrome__navigate` không kèm `tabId`, tự
động mở/dùng tab trong group riêng của chính phiên đó — không xung đột group nữa) và điều hướng
thẳng tới URL của (các) tab người dùng đã thêm vào session. Cùng profile trình duyệt nên cookie/
đăng nhập vẫn còn — chỉ mất trạng thái cuộn/click tay người dùng đã làm trước khi thêm tab, việc
đó chuyển sang cho instruction mô tả bù. Điều hướng bị khoá theo **origin** (protocol+host) suy ra
từ chính URL của các tab đã thêm — không phải domain gõ tay lại (đó là đúng nhược điểm khiến domain
allowlist bị bỏ lần trước — "hạn chế mở tab để navigate" — lần này origin tự suy ra, không cần
người dùng nhập gì thêm, và chỉ áp cho `navigate`, không áp cho các thao tác khác trong cùng tab).

`snap-bridge/kb-job.js` đổi ba chỗ:

- `canUseTool`: `mcp__chrome__new_tab` vẫn bị chặn (không đổi lý do bảo mật gì — thuần vì
  `navigate` không kèm `tabId` đã tự làm việc "mở nếu chưa có" rồi, chặn `new_tab` giữ job chỉ có
  đúng MỘT tab dễ đoán). `mcp__chrome__navigate` được cho qua NẾU `url` nằm trong origin cho phép
  (không có `url` — tức action `back`/`forward`/`reload` — luôn cho qua, vì không tạo đích mới).
  Mọi `mcp__chrome__*` tên hợp lệ khác (click/fill/scroll/...) cho qua **không cần soát `tabId`
  nữa** — biên đó giờ do chính group nội bộ của Chrome Bridge lo (job không còn cách nào biết một
  `tabId` nằm ngoài group của chính nó, vì nó không còn được cho biết tabId thật của người dùng
  nữa).
- **`mcp__snap__*` thì khác** — các tool này gọi thẳng `chrome.tabs.*` trong `background.js`,
  **không** đi qua ranh giới group của Chrome Bridge, nên vẫn cần tự soát `tabId` phía
  `canUseTool`. Cái khó: `tabId` thật giờ chỉ biết được lúc chạy (Chrome Bridge tự gán), không biết
  trước — mà `canUseTool` chỉ thấy **input** của lệnh gọi tool, không thấy **kết quả**. Vá bằng
  cách đọc `tool_result` ngay trong vòng lặp message của `runJob()` (message `type: "user"` mang
  `tool_result`, khớp lại `tool_use_id` với lệnh `navigate` vừa gọi) để tự học `currentTabId`, rồi
  `canUseTool` so khớp mọi `snap_capture_tab`/`snap_frame_*`/`snap_add`'s `at.tabId` với đúng giá
  trị đó — không phải với một danh sách tabId biết trước nữa. `extractTabId()` (mới) đọc số
  `tabId` từ nội dung `tool_result` — thử `JSON.parse` trước, rơi về regex nếu không phải JSON
  thuần (hình dạng kết quả thật của Chrome Bridge không có tài liệu, nên không giả định cứng một
  dạng).
- **Đã test logic bằng harness riêng** (copy nguyên `canUseTool`/`extractTabId` ra khỏi
  `runJob()` — không export được vì kéo theo `query()` thật — chạy 27 assertion độc lập, không
  gọi Claude Agent SDK thật): `new_tab` luôn bị chặn; `navigate` trong origin được, ngoài origin
  bị chặn, không kèm `url` (back/forward/reload) được; mọi `mcp__chrome__*` khác không cần `tabId`
  vẫn được; `snap_capture_tab`/`snap_frame_*` bị chặn khi chưa có `currentTabId`, được khi khớp,
  bị chặn khi KHÔNG khớp (chặn được cả trường hợp đoán/dùng nhầm tabId khác); `snap_add` không
  `at` (toạ độ x/y thường) không cần soát gì, có `at.tabId` thì soát như các tool kia; các tool bị
  loại theo tên (PII: `get_page_text`, `read_page`, `javascript_eval`, `upload_file`, ...) vẫn bị
  chặn, không đổi. Test session tabs nhiều origin khác nhau — cả hai origin được, origin thứ ba lạ
  vẫn bị chặn. **Chưa test bằng một phiên agent thật** (tốn phí, cần trang thật) — logic đã kiểm
  chứng độc lập nhưng hành vi thật của `query()`/format `tool_result` thật của Chrome Bridge thì
  chưa chạy qua.

### Lật lại: job dùng ĐÚNG tab người dùng đưa vào session — `chrome.tabs.group()` chạy SAU khi group ra đời (2026-09-02)

Mục ngay trên chốt "về cấu trúc là không khả thi" và bỏ hẳn hướng dùng tab có sẵn. Kết luận đó
đúng **với thời điểm đã thử**, không đúng với Chrome API. `chrome.tabs.group({tabIds, groupId})`
dời một tab **đang mở** vào một group **đang tồn tại** — đúng việc cần. Chỗ hụt là thời điểm: lúc
người dùng bấm Start, group của job chưa tồn tại, và Chrome xoá group rỗng, nên `"Claude · f7b7"`
chỉ là **nhãn phiên** cho tới khi Chrome Bridge mở tab đầu tiên của nó. Nói cách khác lần trước
không thiếu API, chỉ là gọi quá sớm.

**Adopt hai pha** (đường đi hiện tại):

1. Job gọi `mcp__chrome__navigate` **không kèm `tabId`** đúng một lần → Chrome Bridge mở tab của
   phiên, và chính thao tác đó làm group thành hình. `kb-job.js` đã bắt được `tabId` này sẵn từ
   trước (`onTabId`, học từ `tool_result` của `navigate`).
2. snap-bridge gọi xuống extension `adopt_tabs({ jobTabId, tabIds })` → đọc `groupId` từ chính tab
   đó → `chrome.tabs.group()` kéo các tab session vào group ấy.
3. Từ đó job truyền thẳng tabId thật của người dùng cho `snap_capture_tab`/`snap_frame_*`/
   `snap_add`'s `at.tabId`, và Chrome Bridge chấp nhận vì chúng đã nằm trong group của nó.

**Cái được** chính là cái mục 2026-08-28 phải bỏ: không navigate lại nghĩa là giữ nguyên vị trí
cuộn, panel đang mở, form điền dở — trạng thái người dùng dựng sẵn trước khi bấm Start, thứ trước
đây mất sạch và phải bắt instruction tả lại bằng lời.

**Quyền: manifest không đổi.** `chrome.tabs.group()`/`ungroup()` và đọc `Tab.groupId` đều nằm
trong quyền `"tabs"` đã có. Chỉ **namespace** `chrome.tabGroups` (đọc title/màu của group) mới
cần quyền `"tabGroups"` riêng — không dùng tới, nên không xin.

**Đường lùi còn nguyên.** Tab đã pin (`tabs.group()` từ chối), tab đã đóng từ lúc Start, hay
adopt lỗi vì bất cứ lý do gì → riêng tab đó rơi về cách cũ: navigate tab của job tới URL rồi tự
bấm về màn hình cần. System prompt nói rõ **cả hai** đường và `skipped[].reason` từ `adopt_tabs`
được đẩy thẳng vào job log bằng đúng câu agent cần ("its URL has to be navigated to instead").
Adopt là nâng cấp, không phải điều kiện tiên quyết — hỏng thì job vẫn chạy như trước.

**Trả tab về chỗ cũ là bắt buộc, không phải dọn dẹp cho gọn.** Tab là của người dùng và nó **dời
thật** trong thanh tab. Nặng hơn: Chrome Bridge tự dẹp group của nó khi phiên kết thúc, tab còn
nằm trong đó có thể bị đóng theo — đóng nhầm tab đang đăng nhập của người dùng là hỏng nặng hơn
mọi thứ tính năng này đem lại. Nên `adoptedTabs` ghi lại `groupId` **trước khi** adopt và
`release_tabs` đưa về đúng group cũ (không có group cũ thì `ungroup`; group cũ đã biến mất thì
vẫn `ungroup` — ra ngoài còn hơn kẹt lại). Map này persist qua `chrome.storage.local` cùng lý do
với `kbSessionTabIds`: service worker MV3 bị giết bất kỳ lúc nào, và một entry mất là một tab kẹt
trong group của người khác. `startJob()` gọi `release()` trên **mọi** kết cục — xong, lỗi, crash,
cancel (cancel cũng rơi vào đây vì `cancelJob()` chỉ xin dừng stream, promise vẫn settle).

**Hai cái bẫy đã xử:**

- **Race.** `onTabId` đọc một `tool_result` đang trôi qua — nó **không chặn** agent, nên lệnh tool
  kế tiếp có thể tới trước khi adopt xong. Vá bằng cách cho `canUseTool` `await adoptPromise`
  thay vì từ chối: tabId session hợp lệ đúng lúc agent được phép dùng, không phải một cuộc đua.
- **Mỗi round một group mới.** Mỗi stage/round là một phiên Chrome Bridge mới ⇒ group mới ⇒ adopt
  của round trước không còn giá trị. `cmdAdoptTabs` vì thế release phần tồn đọng trước rồi mới
  adopt lại, và vẫn nhớ **group gốc** chứ không phải group của round trước.

**Chốt chặn phía extension**: `cmdAdoptTabs` giao danh sách server gửi với `kbSessionTabIds` của
chính nó — tức danh sách người dùng thật sự bấm `+` trong rail. Trên thực tế hai bên là một
(`bridge-kb.js` snapshot từ đúng chỗ đó), nhưng như vậy câu "tab nào được phép dời" luôn trả lời
được từ thứ người dùng bấm, không phải từ thứ server nói.

**Đã test / chưa test.** `snap-bridge/adopt-tabs.test.mjs` (`npm test` trong `snap-bridge/`) cắt
khối `cmdAdoptTabs`/`cmdReleaseTabs` ra khỏi `bridge-worker.js` chạy trong `vm` với `chrome.tabs`
giả — 21 assertion: đường thuận (đi và về đúng group gốc), tab pin bị bỏ qua, tab không có trong
session bị từ chối **kể cả khi server hỏi**, tab đã đóng bị bỏ qua không làm hỏng tab còn lại, job
tab không có group thì báo lỗi rõ, round 2 adopt lại vào group mới mà vẫn nhớ nhà, và group gốc
biến mất thì vẫn thoát ra được. Cắt-rồi-eval xấu hơn import, và là cố ý: `bridge-worker.js` là
classic service-worker script không export gì, tách nó thành module sẽ là thay đổi lớn hơn nhiều
so với thứ đang được test.

**Ẩn số còn lại — chưa chạy qua Chrome thật**: Chrome Bridge soát theo *group-membership tại thời
điểm gọi*, hay theo *danh sách tabId do chính nó mở*? Adopt chỉ đúng ở vế đầu. Bằng chứng gián
tiếp khá mạnh: mô tả tool `list_tabs` của chính Chrome Bridge nói "drag a tab into the group (or
use new_tab) to make it visible here" — tức tab được kéo vào group là tab nó chấp nhận. Nếu hoá
ra sai thì thiệt hại bằng không: `adopt_tabs` trả `skipped`/lỗi, job rơi về đúng hành vi của mục
2026-08-28.

#### Chạy thật rồi: adopt hoạt động, và tab tạm được đóng lại (2026-09-02, cùng ngày, sau khi merge)

Job thật đầu tiên sau khi merge trả lời luôn ẩn số ghi ở cuối mục trên: **Chrome Bridge soát theo
group-membership tại thời điểm gọi**, không theo danh sách tabId nó tự mở. Tab người dùng được
`chrome.tabs.group()` kéo vào là tab nó chấp nhận — đúng vế mà `list_tabs` help text đã ám chỉ.
Vế "về cấu trúc không khả thi" của mục 2026-08-28 chính thức khép lại.

Nhưng người dùng báo tiếp: **vẫn thấy một tab mới nằm lại**. Đúng — tab đó là bắt buộc để group
thành hình, nhưng chỉ bắt buộc **trong khoảnh khắc đó**; xong việc thì nó là rác.

**Đo trước khi sửa** (phiên Claude Code thật, không phải job): mở tab A bằng `navigate`, mở thêm
tab B bằng `new_tab` (cùng group), **đóng A**, rồi gọi `navigate` **không kèm tabId** → Chrome
Bridge **dùng lại B**, không đẻ tab mới. Hai kết luận:

1. Đóng tab tạm là **an toàn** — phiên không chết, Bridge tự rơi về tab còn lại trong group. Nên
   `cmdAdoptTabs` giờ `chrome.tabs.remove(jobTabId)` ngay sau khi adopt được ít nhất một tab, và
   trả thêm `jobTabClosed`. **Chỉ khi adopt được ≥1 tab** — không adopt được gì thì tab tạm là tab
   DUY NHẤT của job, đóng nó là kết liễu luôn lần chạy.
2. Không cần chặn cứng lệnh thiếu `tabId` để tránh đẻ tab mới — nhưng **vẫn phải ép agent ghi
   `tabId`**, vì lý do khác và tệ hơn: lệnh thiếu `tabId` giờ rơi vào một tab **của người dùng**,
   và `navigate` nhầm tab đó là xoá đúng cái state cuộn/panel/form mà cả tính năng này sinh ra để
   giữ. System prompt và SKILL.md nói thẳng điều đó.

`kb-job.js` theo dõi `jobTabClosed` để cổng `canUseTool` thôi chấp nhận `jobTabId` sau khi tab đã
đóng (trước đó nó vẫn nằm trong danh sách "tab của job"), còn `jobTabId` chỉ còn vai trò đánh dấu
"đã navigate chưa".

**Đánh đổi đã chọn**: job không còn tab nháp riêng. Cần một màn hình khác thì phải `navigate`
chính tab của người dùng (trong origin cho phép) — tức chấp nhận làm mất state của tab đó. Đổi
lại là đúng thứ người dùng yêu cầu: không có tab lạ nào nằm lại sau khi job chạy.

### Khép lại câu chuyện tab group — Chrome Bridge bỏ hẳn khỏi stage capture (2026-09-03)

Hai mục ngay trên (2026-08-28 → 2026-09-02) là cả một hành trình: bỏ tab thật vì Chrome Bridge
từ chối tab ngoài group của nó → agent tự mở tab riêng, mất hết trạng thái người dùng → dựng lại
bằng adopt hai pha (navigate không tabId để group thành hình, `adopt_tabs` kéo session tab vào,
`release_tabs` trả lại lúc job xong) → chạy thật, xác nhận đúng, đóng luôn tab tạm sau khi adopt.
Mọi kết luận trong hai mục đó **đúng ở thời điểm viết** — đây không phải đính chính, mà là khép
lại: cả cơ chế đó chỉ tồn tại để lách đúng MỘT giới hạn, và giới hạn đó vừa bị gỡ bỏ theo cách
khác hẳn.

**Cái đã đổi**: `CHROME-BRIDGE-EXIT-PLAN.md` (lập 2026-09-02, chạy 2026-09-03) nhận ra bốn tool
`snap_frame_*` sẵn có (từ mục "Điều khiển nội dung trong iframe cross-origin" phía trên) đã đi
qua `chrome.scripting.executeScript` của chính Snap Studio — **không hề bị Chrome Bridge hay tab
group nào scope cả**, vì nó không phải Chrome Bridge. Thêm bốn tool cùng họ
(`snap_navigate`/`snap_frame_fill`/`snap_frame_press`/`snap_look`, GĐ 1) là đủ để stage capture
không cần `mcp__chrome__*` một chút nào nữa. GĐ 2 bỏ hẳn `chrome` khỏi `mcpServers` của stage đó
và thay hàng rào `canUseTool` cũ (mượn group-membership của Chrome Bridge) bằng một whitelist
`tabId` phẳng ngay trong chính `kb-job.js` — session tab dùng được **từ lệnh đầu tiên**, không
còn "mở đường"/group/adopt gì cả. GĐ 3 xoá hẳn cơ chế adopt: `cmdAdoptTabs`/`cmdReleaseTabs`/
`adoptedTabs`/`TAB_GROUP_ID_NONE` trong `bridge-worker.js`, `CHROME_SAFE_TOOLS`/`extractTabId`/
`pendingNavigateIds`/`onTabId` trong `kb-job.js`, và `chrome-bridge-config.js` cùng
`adopt-tabs.test.mjs` — cả hai file biến mất.

**Nghiệm thu bằng job thật**, ngay trong lúc GĐ 2 vừa xong: bài "How to translate Qikify Volume
Discount app settings and offers" (`kb/translate-volume-discount-app`) — đúng app iframe
cross-origin của mục "Điều khiển nội dung..." — chạy trọn capture → write → review, verdict
"pass", **không mở tab mới, không dời tab nào**. Log không có một dòng nào nhắc "adopt"/"tab
tạm"/"mở đường" — điều mục 2026-09-02 coi là thành tựu ("đóng được tab tạm sau adopt") giờ không
còn tồn tại để đóng nữa, vì không còn tab tạm nào được mở ra từ đầu.

**Đánh đổi thật, không phải miễn phí**: mục 2026-09-02 (dòng 360-362) có một đường lùi — tab
không adopt được thì rơi về "navigate tab của job tới URL, mất state". Đường lùi đó **biến mất
theo** cả cơ chế adopt: job giờ không có cách mở tab nào của riêng nó nữa (không `new_tab`,
không "tab của job" như trước). Tab session không dùng được thì job dừng lại và báo đúng tab nào
cần mở lại — không còn "vẫn chạy được, chỉ mất state" như trước, mà là "dừng, cần người can
thiệp". Đổi lại đúng thứ toàn bộ câu chuyện này theo đuổi từ đầu: không tab lạ nào bị mở, không
tab nào bị dời, và không còn phụ thuộc vào hành vi nội bộ (group-membership vs danh sách tabId)
của một extension khác mà repo này không kiểm soát phiên bản.

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

### Job không được cướp focus của người dùng (2026-08-30)

**Triệu chứng**: mỗi lần agent chạy job KB, màn hình bị giật sang tab extension, gõ dở câu nào
mất câu đó. Người dùng không làm được việc khác trong lúc job chạy — mà job chạy hàng phút.

**Ba chỗ gây ra, theo thứ tự mức độ**:

1. `relayToEditor()` (`src/bridge-worker.js`) gọi `focusEditor()` trước **mọi** lệnh chuyển
   xuống tab editor — `open`, `add`, `get_els`. Một bài KB gọi `snap_add` hàng chục lần, nên
   đây là nguồn chính của "tự nhảy qua tab extension". Và nó **không cần thiết**: cả ba lệnh chỉ
   là thao tác DOM chạy trong listener `chrome.runtime.onMessage`, mà listener đó nổ trong tab
   ẩn y hệt tab đang hiện; đường render của `editor.js` không chờ `requestAnimationFrame` ở
   đâu cả (rAF chỉ có trong `export.js` và `render-api.js`).
   → Bỏ focus, **trừ** `cmd === 'export'`: `cmdExport()` trong `bridge-editor.js` tự chụp
   chính tab editor bằng `captureVisibleTab` và có chờ rAF, hai thứ bắt buộc tab phải hiện.
   `snap_export` từ lúc chuyển sang render headless (`get_els` + `render.mjs`) không đi qua
   đường đó nữa, nhưng relay vẫn mang lệnh nên vẫn giữ nhánh focus cho đúng.

2. `cmdCaptureTab()` `tabs.update({active:true})` **và** `windows.update({focused:true})`
   trước mỗi lần chụp. `captureVisibleTab` luôn chụp **tab đang active của cửa sổ được truyền
   vào**, nên activate tab thì bắt buộc — nhưng **raise cửa sổ thì không**. Đó là toàn bộ khoảng
   trống mà `shootQuietly()` sống trong đó: chỉ activate khi tab chưa active, không raise cửa
   sổ, chụp xong trả lại đúng tab người dùng đang mở. Chỉ raise khi thật sự không còn gì để
   chụp — cửa sổ minimized, hoặc `captureVisibleTab` ném lỗi (Windows ngừng composite cửa sổ
   bị che hoàn toàn) — rồi `shootRaised()` trả cửa sổ về đúng trạng thái cũ, kể cả minimized.
   Restore chỉ hoàn tác **cái mình đổi**: nếu người dùng tự chuyển tab trong lúc đang chụp thì
   giữ nguyên lựa chọn của họ.

3. `cmdOpen()` gọi `setView('snap')`, trước chỉ chừa tab KB. Giờ tab editor không còn bị kéo
   ra trước nữa nên điều kiện đúng là `document.hidden` — không ai đang nhìn thì mới đổi view.
   Người đang ngồi ở Library/Lab/KB là cố ý ở đó.

**Còn lại, không sửa được từ repo này**: `mcp__chrome__navigate` là của Chrome Bridge
(`claude.exe --chrome-native-host`, xem `snap-bridge/chrome-bridge-config.js`) — nó tự
activate tab của nhóm nó khi mở trang, và đó là extension khác.

**Đường `resolveTarget()` không đụng tới**: đó là nhánh `snap_capture_tab` không có `tabId`,
mà `canUseTool` trong `kb-job.js` từ chối thẳng nhánh đó — job luôn phải truyền `tabId` từ
`navigate`. Nó chỉ còn phục vụ nút Snap trên toolbar, nơi người dùng vừa bấm và đang nhìn.

### Nháy tab lúc chụp — chuyển hẳn sang CDP, không còn phải activate (2026-09-03)

`shootQuietly()` (mục ngay trên) đã giảm cái nháy tab tối đa có thể **trong giới hạn của
`chrome.tabs.captureVisibleTab`** — nhưng không xoá được nó, vì API đó **bắt buộc** tab phải
đang active của cửa sổ mới chụp được. Người dùng hỏi thẳng: Chrome Bridge's
`mcp__chrome__take_screenshot` sao không nháy gì cả — có phải do tab group?

**Không phải tab group.** Tab group là ranh giới *quyền* (tab nào Chrome Bridge được đụng),
không liên quan gì tới việc chụp có lộ ra ngoài hay không. Lý do thật: `take_screenshot` của
Chrome Bridge dùng **CDP** (`Page.captureScreenshot` qua `chrome.debugger`), đọc pixel thẳng từ
renderer của tab qua kênh debug — **không cần tab đó là tab active**. Khác hẳn
`captureVisibleTab`, chỉ chụp được đúng tab active của window được truyền vào.

**Xác minh bằng thực nghiệm**, không suy đoán: mở 2 tab qua Chrome Bridge, `list_tabs` xác nhận
**cả hai `active:false`**, rồi `take_screenshot` thẳng lên từng tab nền. Cả hai lần đều chụp ra
đúng nội dung thật (trang "Example Domain", trang chủ Wikipedia đầy đủ) — không trắng, không
hỏng.

**Đính chính mục "Ảnh chụp bị ám vàng/cam" (2026-08-28) ở trên**: dòng ghi CDP trả về "ảnh
trắng sạch tuyệt đối" **không phải** bằng chứng CDP chụp tab nền nói chung không đáng tin — đó
là kết quả của MỘT lần tái hiện đúng một bug render cụ thể (mà `captureVisibleTab` tình cờ bắt
được, CDP thì không), không phải một phép test độ tin cậy tổng quát. Test lần này (2026-09-03)
mới thật sự trả lời câu hỏi "CDP có chụp được tab nền không" — và câu trả lời là có.

**Vậy sao không đổi hẳn sang CDP từ đầu?** Vì repo này **đã thử `chrome.debugger` cho việc khác
rồi bỏ** (`snap_frame_click_native`, mục "Cách A" phía trên) — gắn quyền `debugger` thì Chrome
hiện banner vàng **cố định** "đang bị debug bởi một tiện ích mở rộng" trên mọi cửa sổ, suốt thời
gian còn gắn. Lần này khác ở chỗ: **chỉ attach đúng lúc chụp** (`attach` → `Page.captureScreenshot`
→ `detach` trong `finally`, không giữ), nên banner chỉ nháy ~100-300ms mỗi lần chụp thay vì dán
suốt cả job — đánh đổi chấp nhận được.

**Cài đặt**: `shootViaDebugger(tab)` trong `src/bridge-worker.js`. `cmdCaptureTab()` thử CDP
trước cho nhánh có `tabId`/`url` (đường `snap_capture_tab`/`snap_look` dùng); nếu CDP từ chối
(DevTools đang mở sẵn trên tab đó → "Another debugger is already attached", tab `chrome://`,
v.v.) thì rơi về `shootQuietly()` cũ, không cắt đường lui. Nhánh `resolveTarget()` (nút Snap thủ
công, không có `tabId`/`url`) **giữ nguyên** `shootVisibleTab` — ở đó activate là chủ ý (người
dùng vừa bấm và đang nhìn), không có gì để giấu. Quyền mới trong `manifest.json`: `"debugger"`.

**Xác nhận bằng người dùng thật**, hai lần, ngay trong lúc theo dõi màn hình: gọi `snap_look`
lên một tab đã xác nhận `active:false` qua `list_tabs` — cả hai lần người dùng đều báo **không
thấy gì nháy**, đúng như thiết kế.

### Tab trong session tự động group, phân biệt với tab người dùng tự mở (2026-09-03)

Từ `CHROME-BRIDGE-EXIT-PLAN.md` GĐ 2, tab group **không còn là ranh giới quyền** nữa —
`mcp__snap__*` làm việc thẳng trên bất kỳ `tabId` nào trong `sessionTabs` job được giao, không
cần group nào của Chrome Bridge nữa (xem mục "Nghiệm thu thật" trong file đó — một job KB thật
chạy xong, không mở tab mới, không dời tab nào). Nhưng group vẫn có giá trị **thuần hình ảnh**:
nhìn vào thanh tab là biết ngay tab nào đang "thuộc về" một job KB, phân biệt với tab người dùng
tự mở/điều hướng trong lúc job chạy.

**Cài đặt**: `groupIntoKbSession(tabId)` trong `src/bridge-worker.js`, gọi từ `addKbSessionTab()`
mỗi khi người dùng bấm "+" trong KB Studio. Tab đầu tiên thêm vào session tạo group mới, đặt tên
**"KB job"**, màu xanh dương (`chrome.tabGroups.update` — quyền `tabGroups` mới thêm vào
`manifest.json`); tab sau join đúng group đó qua `chrome.tabs.group({tabIds, groupId})`. Group
cũ đã mất (Chrome tự dissolve group rỗng, không có API "xoá group" tường minh) thì tự phát hiện
lỗi và tạo group mới. `removeKbSessionTab()` ungroup tab đó khi bỏ khỏi session. Không lỗi nào ở
đây được coi là chặn — nhóm tab hỏng (VD tab bị pin, `chrome.tabs.group()` từ chối) thì
`kbSessionTabIds` vẫn hoạt động bình thường, group chỉ là tiện ích thêm.

**Không phải ranh giới an toàn**: `canUseTool` trong `kb-job.js` không đọc `groupId` này ở đâu
cả — hoàn toàn là bookkeeping hiển thị, tách bạch khỏi whitelist `tabId` thật (GĐ 2).

**Xác nhận bằng người dùng thật**: bấm "+" thêm tab trong KB Studio → group "KB job" màu cyan
xuất hiện đúng như thiết kế. Sau đó đổi màu theo yêu cầu người dùng (2026-09-03): trước qua đỏ,
rồi chốt lại thành xanh dương (`'blue'`) để ăn theo `--color-primary-500`/`--accent` của
`tokens.css` (`#1350de`) — enum màu group của Chrome cố định 8 giá trị, không đọc được CSS
variable từ service worker, nên đây là màu enum khớp nhất chứ không phải giá trị chính xác. Chỉ
đổi giá trị `color`, không đổi cơ chế.

### Job kẹt vì dialog gốc của trình duyệt — CDP tự trả lời (2026-09-03)

**Sự cố thật**: job `variant-swatches-volume` (bài "How to customize variant swatches in Qikify
Volume Discount") — capture stage gọi `snap_navigate` trong lúc trang còn báo unsaved changes,
Shopify bật `beforeunload` guard, trình duyệt bật hộp thoại gốc "Leave site?". Không tool nào của
job tắt được — dialog gốc chặn đứng toàn bộ JS thread của tab, `snap_look`/`snap_capture_tab`/
`snap_navigate` trên tab đó đều đứng im. Agent tự viết báo cáo, nhờ người dùng bấm tay vào tab để
gỡ dialog rồi mới đi tiếp — job vẫn xong (write/review chạy trên `job.json` đã có, không cần tab
đó nữa), nhưng đây là đúng kiểu lỗ hổng "job không ai ngồi cạnh" không được phép có.

**Cơ chế**: CDP có `Page.javascriptDialogOpening` (bắn ra khi `alert`/`confirm`/`prompt`/
`beforeunload` xuất hiện) và `Page.handleJavaScriptDialog({accept})` để trả lời nó — đúng cơ chế
Puppeteer/Playwright dùng để không bao giờ bị kẹt dialog. Nhưng nghe được event này cần
`Page.enable`, và cần debugger **đang attach** tại đúng lúc dialog nổi lên — không có cách nào
"bắt lại" một dialog đã lỡ xuất hiện trước khi attach.

**Cài đặt**: `attachSessionDebugger(tabId)`/`detachSessionDebugger(tabId)` trong
`src/bridge-worker.js`, gọi từ `addKbSessionTab()`/`removeKbSessionTab()` — khác hẳn
`shootViaDebugger()` (mục "Nháy tab lúc chụp" ở trên) vốn attach-chụp-detach trong ~100-300ms,
debugger session này **giữ mở suốt lúc tab còn trong KB session**, chỉ để nghe
`Page.javascriptDialogOpening` và tự gọi `handleJavaScriptDialog({accept: true})` — `accept:true`
nghĩa là "Leave"/"OK" cho mọi loại dialog, vì job không đọc được nội dung dialog để quyết định, và
một dialog bị bỏ mặc chặn tab y hệt bất kể loại nào. `chrome.debugger.onDetach` giữ
`debuggedSessionTabIds` đúng thực tế khi Chrome tự ngắt (DevTools thật mở trên tab đó, tab
crash…); lúc service worker restart giữa job, danh sách session tab được nạp lại từ
`chrome.storage.local` cũng tự động attach lại — không thì tính năng âm thầm ngừng hoạt động mà
không ai biết.

**Đụng `shootViaDebugger()`**: một tab chỉ attach được MỘT debugger session cùng lúc — nếu tab đã
có session dài hạn ở trên, `shootViaDebugger()` gọi `chrome.debugger.attach()` lần nữa sẽ ăn lỗi
"Another debugger is already attached". Sửa: `shootViaDebugger()` kiểm tra
`debuggedSessionTabIds.has(tab.id)` trước — có thì dùng thẳng session đã mở (không attach/detach
gì thêm), không thì giữ nguyên hành vi attach-chụp-detach cũ cho tab ngoài session.

**Đánh đổi đã chọn có cân nhắc** (người dùng đồng ý trước khi làm): banner "this tab is being
debugged" của Chrome giờ hiện **suốt** lúc tab còn trong KB session, không còn là một cái nháy
~100-300ms như lúc chỉ dùng cho chụp ảnh. Đổi lại: job không còn cách nào bị treo cứng vì một
dialog gốc không ai bấm giúp.

### Cửa sổ Windows Terminal nhảy lên mỗi lần render (2026-08-30)

**Triệu chứng**: mỗi lần job chạy, một cửa sổ console (trông như PowerShell) bật lên.

**Đo được, không phải suy đoán** — theo dõi tiến trình mới sinh trong lúc gọi `snap_export`:

```
12:08:32.492  chrome-headless-shell.exe   ppid = node server.js
12:08:32.493  conhost.exe                 ppid = chrome-headless-shell
12:08:32.494  OpenConsole.exe    -Embedding
12:08:32.495  WindowsTerminal.exe -Embedding
```

Bốn tiến trình trong 3 mili-giây, ngay lúc `renderSteps()` gọi `chromium.launch()`.

**Nguyên nhân**: `chrome-headless-shell.exe` là binary **console subsystem**. `launchProcess()`
của `playwright-core` dựng `spawnOptions` chỉ gồm `detached` (và chỉ cho non-win32), `env`,
`cwd`, `shell`, `stdio` — **không có `windowsHide`**. Mà `server.js` được native host spawn
detached, không thừa kế console nào, nên Windows cấp cho headless shell một console mới; trên
Windows 11 console host mặc định là Windows Terminal, nên nó hiện ra thành một cửa sổ thật.

**Vá**: `withHiddenConsole()` trong `render.mjs` — monkey-patch `child_process.spawn` ép
`windowsHide: true` (cờ `CREATE_NO_WINDOW`) đúng trong lúc gọi `launch()`, rồi khôi phục
trong `finally`. Playwright không hở tuỳ chọn spawn nào ra API công khai nên không có đường
sạch hơn. Cờ này không đụng đường điều khiển: Playwright nói chuyện với browser qua
`--remote-debugging-pipe` (fd 3/4), không qua console.

**Đã xác nhận sau khi vá**: chạy lại đúng `snap_export` đó → vẫn có `chrome-headless-shell.exe`
và một `conhost.exe` (console không cửa sổ, đúng ý nghĩa của `CREATE_NO_WINDOW`), nhưng
**không còn `OpenConsole.exe` lẫn `WindowsTerminal.exe`**.

**Đường đã cân nhắc và bỏ**: `chromium.launch({ channel: "chromium" })` dùng bản Chromium đầy
đủ (`chrome.exe` là GUI subsystem nên không cấp console) — bản `chromium-1234` có sẵn trong
`ms-playwright`. Bỏ vì nó đổi hẳn build trình duyệt đang render ảnh KB, tức đổi cả kết quả
render, quá đắt cho một cửa sổ console.

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

Sáu tool đầu tiên (bản trial), mỗi cái ánh xạ thẳng vào một đường đã có sẵn trong mã nguồn —
không cái nào đòi viết lại engine của editor:

| Tool | Làm gì | Đi qua mã nào đã có |
|---|---|---|
| `snap_status` | Extension còn nối không, đang mở capture nào | Ping trên WebSocket |
| `snap_capture_tab` | Kích hoạt tab → chụp → **ghi PNG ra đĩa** | `background.js` → `shootVisibleTab()` |
| `snap_open` | Nạp một PNG vào editor | `chrome.storage.local.pendingCapture` + message `snap-capture` — đúng đường `loadCapture()` đang nghe (`editor.js` cuối file) |
| `snap_kit` | Trả `use_when` / `gotchas` của 8 component | `src/kit-catalog.js` |
| `snap_add` | Thêm annotation vào ảnh đang mở | `newElement(type)` trong `editor.js` — `step`, `textbox`, `highlight`, `blur`, `zoom`, `arrow`, `spotlight`, `label`, `image`, `custom:<id>` |
| `snap_export` | Render PNG cuối, ghi ra đường dẫn | `export.js` → `renderToPngDataUrl()` |

**Thêm sau bản trial** (tổng 14 tool):

| Tool | Làm gì |
|---|---|
| `snap_frame_list` / `snap_frame_find` / `snap_frame_scroll` / `snap_frame_click` | Với tới nội dung trong iframe cross-origin — xem mục "Điều khiển nội dung trong iframe cross-origin" ở trên |
| `snap_render_job` | Render lại cả bài từ `job.json`, không chụp lại |
| `snap_write_kb` | Ghi `kb/<slug>.md` (mục 7 — không có RPC nào sang extension) |
| `snap_comments` | Đọc comment người dùng ghim trong KB Studio: pin `xNorm/yNorm` → **pixel trong hệ toạ độ ảnh gốc**, + step sở hữu ảnh, + element gần pin nhất kèm `props` |
| `snap_comment_resolve` | Đóng một comment kèm `note` "đã sửa gì" — note hiện lại trên pin trong UI |
| `snap_job` | Đọc / ghi đè `job.json` (giữ một bản `job.prev.json` để undo) — đường duy nhất để một phiên **không có tool sửa file** dời được một annotation |
| `snap_view` | Trả về **chính tấm ảnh** trong `kb/` dưới dạng image block — phiên spawn không có `Read`, mà "nhìn lại ảnh đã xuất" là luật cứng của playbook |
| `snap_learn` | Append một LEARNING vào `PLACEMENT_PLAYBOOK.md`. Write **duy nhất** ra ngoài `kb/`: append-only, một file cố định, giới hạn 1200 ký tự — bài học của một phiên không có tool sửa file mà không ghi lại được thì chết theo phiên đó |

Hai tool comment cố tình **không** có `add` / `delete`: pin là phía người dùng nói. Một agent xoá
được feedback thì một correction có thể biến mất thay vì được xử lý — mà đó chính là thứ cả vòng
review này tồn tại để giữ lại.

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

### Nút "Start bridge" trong Studio (native messaging)

`snap-bridge` là một tiến trình rời, **không có gì tự bật lại sau khi khởi động máy**.
Triệu chứng đã gặp: mở tab KB thấy rail Articles trống trơn, tưởng mất hết bài — thực ra
`kb/` vẫn nguyên, chỉ là `kb_list` đi qua WebSocket của bridge mà bridge thì không chạy.
Rail giờ nói thẳng điều đó, kèm nút bật lại.

Trang extension không thể spawn tiến trình, nên nút đó phải đi qua **Chrome native
messaging** — đường duy nhất Chrome cho phép một extension chạm tới OS:

```
bridge-kb.js --kb-local-cmd--> bridge-worker.js --sendNativeMessage-->
  snap-bridge-host.cmd -> snap-bridge-host.mjs --spawn detached--> server.js
```

- `snap-bridge/native-host/snap-bridge-host.mjs` — host, chỉ hiểu đúng hai lệnh `status` và
  `start`. Nó không nhận đường dẫn hay tham số nào từ extension: thứ nó chạy được hardcode
  là `../server.js` ngay bên cạnh, nên điều xấu nhất một trang bị chiếm quyền làm được qua
  nó là bật chính cái bridge của repo này. Host chỉ trả lời khi port **đã thật sự lắng
  nghe**, nên UI không bao giờ báo "xong" trong lúc server còn đang lên.
- `snap-bridge/native-host/install.ps1` — ghi manifest, shim `.cmd` (Chrome trên Windows
  không chạy thẳng được `.mjs`, và không bảo đảm có PATH dùng được, nên đường dẫn node được
  nướng cứng vào shim) và khoá registry
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.snapstudio.bridge`.
  **Chạy một lần**, và chạy lại mỗi khi repo đổi thư mục — extension unpacked đổi ID theo
  đường dẫn nạp, script tự dò ID đó ra từ profile Chrome:

  ```powershell
  powershell -ExecutionPolicy Bypass -File snap-bridge\native-host\install.ps1
  # gỡ:  powershell -ExecutionPolicy Bypass -File snap-bridge\native-host\install.ps1 -Uninstall
  ```

  Sau đó **reload extension** ở `chrome://extensions` — quyền `nativeMessaging` chỉ được cấp
  khi nạp lại.

Chưa cài host thì nút vẫn hiện; bấm vào sẽ in đúng câu lệnh trên kèm nút copy, thay vì im
lặng thất bại. Muốn khỏi bấm hẳn thì thêm scheduled task chạy lúc logon, đúng kiểu
`ccchrome-bridge` vẫn làm — nhưng nút này cố ý không phụ thuộc vào việc đó.

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

## 8. Ảnh trong bài KB là surface sống, không phải PNG

**Vấn đề**: tab KB hiển thị `step.out` — file PNG đã render. Ảnh đó là ngõ cụt: người dùng sửa
gì trong tab Snap cũng không dội về bài, muốn dời một callout đặt lệch thì phải dựng lại shot
bên Snap hoặc ghim comment nhờ agent, và suốt lúc agent chạy job thì không thấy nó làm gì cho
tới khi xong.

**Quyết định**: bài viết vẽ **ảnh gốc (`step.src`) + `els` của step đó, sống**, bằng đúng bộ
component và đúng surface mà tab Snap dùng. PNG trở lại đúng vai trò của nó — artifact mà
markdown xuất bản trỏ tới — và có nút `Live | PNG` trên từng ảnh để đối chiếu hai bên.

**Hai surface cho mỗi step, và chỗ chia đôi này là toàn bộ thiết kế:**

- **Trong bài — chỉ xem.** Ảnh 2560px nhét vào nửa cột bài viết còn ~20%; ở cỡ đó không có cách
  chỉnh grip nào biến nó thành chỗ kéo thả tử tế được. Nó là một **view sống**: hiện cả sửa đổi
  chưa lưu lẫn thay đổi agent vừa ghi vào `job.json`, không cần render ở giữa.
- **Trong modal — editor**, mở bằng cách bấm vào ảnh. Gần trọn cửa sổ, có zoom riêng (Fit /
  100% / ±), palette component và panel Properties. Hai surface **dùng chung một object
  `capture`**, nên cái modal sửa chính là cái bài đang hiện.

(Bản dựng đầu cho sửa thẳng trong bài, toolbar + Properties nhét dưới mỗi ảnh. Bỏ vì đúng một lý
do: ảnh quá nhỏ để thao tác. Cỡ ảnh là cỡ cột bài, không sửa được bằng CSS.)

Bốn hệ quả kiến trúc:

- **`src/surface.js`** — phần canvas (vẽ el, `makeCtx`, kéo/resize/vẽ-để-đặt, ⌫) tách khỏi
  `editor.js` thành một factory dùng chung. Tách chứ không chép: phần drag có những chi tiết
  không nhìn ra từ source mà lộ ngay trên màn hình (uốn cung arrow hai trục, snap góc elbow, sàn
  chiều rộng pill "Step n" đo theo font, khoá tỉ lệ ảnh) — bản sao thứ hai sẽ trôi, rồi hai tab
  bất đồng về việc "kéo" nghĩa là gì. `makeCtx`'s `$` phải **scoped** theo `propsRoot`, nếu
  không `$('#pCompact')` trong panel KB sẽ bắt nhầm ô cùng id ở panel tab Snap đang ẩn.
- **Toạ độ không rời hệ pixel của ảnh gốc.** Stage vẽ ở kích thước tự nhiên rồi `transform:
  scale()` xuống bề ngang cột; `getZoom()` trả đúng hệ số đó cho surface. Đây là hệ mà
  `job.json`, `props` của `snap_add` và pin đã resolve của `snap_comments` đều đang nói — không
  đẻ thêm hệ toạ độ thứ hai phải giữ đồng bộ.
- **Chỉ ảnh nằm trong `.kb-md-imgwrap`.** Pin comment định vị theo phần trăm của hộp đó và
  handler click-để-ghim đo chính nó; thêm bất cứ thứ gì vào trong sẽ lệch mọi pin đã có. Nút
  `Live | PNG` là anh em của nó, không phải con.
- **CSS cấu trúc của stage KHÔNG được scope theo `.kb-article-preview`.** `buildStage()` dựng
  cùng một cây DOM cho cả hai chỗ; scope nó vào tab KB làm `.kbs-scaler` trong modal mất mốc
  `position: relative`, rơi về `.kbs-modal` rồi vẽ ảnh ở kích thước gốc đè kín cửa sổ. Bắt được
  bằng một cú click không tới được nút zoom, không phải bằng đọc CSS.
- **`--kbs-grip`**: mọi grip (handle, `.el-del`, `.arrow-end`, khung nét đứt) nhân ngược với hệ
  số scale nên luôn đúng cỡ thiết kế trên màn hình. Nội dung thì scale, cái để cầm nội dung thì
  không.
- **`kb_job_save` không phải `snap_render_job`.** Chỉ render lại step nào thực sự đổi, và
  **không** ghép lại markdown — dời một element thì không đổi tên file `out`, còn
  `assembleMarkdown()` sẽ đè lên chữ người dùng tự gõ, vốn là nửa còn lại của cùng nút Save.

**Chiều agent**: push một chiều `kb_article_changed` trên `/ext` (đúng khuôn `kb_progress`), bắn
từ `snap_job` / `snap_render_job` / `snap_write_kb` / `snap_export`. Vì bài vẽ thẳng từ
`job.json`, agent **không cần render** thì người dùng đã thấy element dịch chuyển — nên
`.claude/skills/kb/SKILL.md` yêu cầu ghi `job.json` sau MỖI bước thay vì gom đến cuối. `slug`
null nghĩa là "có gì đó dưới `kb/` đổi, bên ghi không nói được bài nào" (`snap_export` ghi một
đường dẫn trần); UI đọc là "đọc lại bài đang mở". Bài đang có sửa đổi chưa lưu thì **không** bị
đọc đè — toast bảo bấm Refresh, đúng luật `afterReviseFinish()` vẫn dùng.

**Bài phẳng vẫn chạy như cũ**: không có `job.json`, hoặc ảnh gốc đã bị xoá → giữ nguyên PNG
read-only. `readKbArticle()` giờ trả kèm `job` cả khi bài là `kb/<slug>.md` phẳng có thư mục
`kb/<slug>/job.json` bên cạnh — đúng hình dạng của những bài đầu tiên tool này làm ra, mà trước
đó UI không hề nhận được `els` của chúng.

## 9. Panel "+ New job": preview ở trên, log ở dưới

Trước đó nửa phải của panel New job chỉ có log. Log trả lời "agent đang làm gì"; nó không trả
lời được câu người ta thực sự hỏi khi ngồi chờ — "nó làm ra cái gì rồi". Dòng
`wrote img/02-search-typed-annotated.png` không thay được việc nhìn thấy bước 2 hiện lên.

Nên panel chia đôi: **preview bài đang được dựng ở trên, log ở dưới** (grip kéo được, dùng
chung `makeLogResizer()` với log của panel bài viết). Preview mở **ngay lúc bấm Start**, rỗng —
đợi đến khi có cái để hiện mới mở nghĩa là panel tự đổi hình dạng giữa chừng.

Ba điểm đáng ghi:

- **Preview dựng từ `job.json`, không đợi markdown.** Agent ghi `job.json` sau mỗi bước chụp
  (mục 8), còn markdown thì mãi cuối job mới ghép. Nên khi `kb_read` trả `md` rỗng, UI tự dựng
  markdown tạm từ `job.json` bằng `jobToMarkdown()` — cố ý cùng hình dạng với
  `assembleMarkdown()` bên server, để lúc file thật rơi xuống thì preview không nhảy layout.
  Cộng với ảnh là surface sống, mỗi bước hiện ra **ngay khi chụp xong, không cần render PNG**.
- **Job authoring không biết slug của chính nó** — bài viết là thứ nó sắp làm ra. Slug đến cùng
  push `kb_article_changed` đầu tiên có tên bài; `noteJobSlug()` (kb-job.js) đóng dấu nó lên job
  đang chạy để `kb_query` trả lại được, tức là reload trang giữa job vẫn tìm về đúng preview.
- **Preview này chỉ xem, không sửa** — agent đang sở hữu file, sửa vào đó thì bước sau nó ghi đè.
  Không có chip `✎ Edit`, bấm vào ảnh không mở modal. Xong job (hoặc bất cứ lúc nào) thì nút
  `Open article →` đưa sang panel bài viết, nơi mới sửa được.

Một cái bẫy: preview dùng chung class `.kb-article-preview` với panel bài viết (cùng renderer,
cùng surface sống), nên `document.querySelectorAll('.kb-article-preview …')` từ giờ khớp **hai**
chỗ. Trong code đã luôn query theo element (`articlePreview.querySelectorAll`), nhưng test thì
phải đổi sang `#kbArticlePreview` — bắt được vì Playwright báo "resolved to 4 elements" rồi chờ
mãi cái đầu tiên (nằm trong panel đang `hidden`) hiện ra.

Và: khi panel New job bị ẩn (người dùng sang đọc bài khác giữa job), `refreshJobPreview()` bỏ
qua luôn. Mount vào panel `display:none` thì `clientWidth` bằng 0, `fit()` rơi về kích thước tự
nhiên và vẽ ảnh 2560px cho tới khi ResizeObserver sửa lại — một cú loé ảnh khổng lồ lúc quay
lại, đổi lấy đúng con số không. `selectNewJob()` refresh bù ngay khi panel hiện lại.

## 10. Agent vẽ trong tab KB, tab Snap trả về cho người dùng

**Vấn đề**: `snap_open`/`snap_add`/`get_els` đi qua `callExtension()` xuống **canvas của tab
Snap** (`bridge-editor.js`). Nghĩa là agent và người dùng dùng chung một chỗ làm việc:

- `loadCapture()` push mỗi ảnh thành **một tab capture mới** trong session của người dùng
  ([editor.js](src/editor.js) `loadCapture` → `captures.push(next)`), nên job 5 bước để lại 5 tab
  lạ.
- `finishCaptureSwap()` gọi `saveSessionNow()`, và hook `onMutate` của surface gọi
  `scheduleSessionSave()` — tức mỗi ảnh 2560px của agent bị ghi đi ghi lại vào
  `chrome.storage.local`, cho một thứ hoàn toàn tạm: artifact thật là `job.json` + PNG.
- Và một toast `snap-bridge added <type>` cho **mỗi** `snap_add`, vốn là tín hiệu duy nhất báo
  có gì đó đang xảy ra ở một view không ai nhìn.

**Quyết định**: agent có canvas riêng, `mountAgent()` trong `kb-surface.js`, nằm ở khung trên
cùng của panel New job. Cột phải giờ đọc từ trên xuống là **"đang làm gì / đã làm ra gì / nói
gì"**: agent canvas — preview bài — log. Tab Snap không nhận gì từ agent nữa.

- **Cùng một surface, cùng một modal.** Canvas trong khung là view chỉ-xem (khung cao bằng 1/3
  cột — đúng lý do mục 8 nêu cho ảnh trong bài), bấm vào mở **đúng modal editor** của ảnh bài
  viết. `openEditor()` giờ nhận `title`/`hint` ghi đè, vì cái này không phải một step nào cả.
- **Sửa tay vẫn tính.** `get_els` đọc thẳng `capture.els` của canvas này, nên một callout người
  dùng kéo lại trước khi agent gọi `snap_export` vẫn vào PNG — đúng tính chất cũ, chỉ đổi chỗ.
- **`getAgent` phải resolve muộn.** `SnapKit.bridge.init()` chạy **trước** `SnapKit.kb.init()`
  ở cuối `editor.js`, nên `bridge-editor.js` không thể giữ tham chiếu lúc wiring; nó gọi
  `SnapKit.kb.agent()` tại thời điểm lệnh tới.
- **Nút `→ Snap`.** Đường duy nhất còn lại để một capture của agent sang tab Snap, và chỉ khi
  người dùng bấm. `els` được **dựng lại** với capture mới chứ không bê nguyên sang: blur và zoom
  đọc pixel từ `capture.img.el`, một element mang theo tham chiếu sẽ vẫn đang lấy mẫu từ ảnh cũ.
- **`cmdExport` giờ ném lỗi.** Đường export bằng `captureVisibleTab` đã không còn ai gọi từ hồi
  `snap_export` chuyển sang render headless qua `get_els`; giờ agent không vẽ trên stage Snap
  nữa thì nó sẽ chụp nhầm capture của người dùng. Từ chối to hơn là đoán.
- Banner đổi lời: canvas Snap không còn "bị lái tự động".

Kiểm bằng harness: `jobtest.mjs` giả luôn cả chiều `snap-bridge-cmd` (emit lệnh, bắt
`snap-bridge-reply` theo `reqId`) nên `snap_open`/`snap_add`/`get_els`/`export` chạy thật qua
`bridge-editor.js`, rồi khẳng định `#snapTabs` và `#canvas` **vẫn rỗng**.

**Bố cục cuối**: canvas trái, bài phải, log dưới cả hai. Hai khung trên trả lời hai câu hỏi khác
nhau về **cùng một thời điểm** — "đang làm gì" và "đã làm ra gì" — nên giá trị nằm ở chỗ đọc cái
này đối chiếu cái kia; xếp dọc thì phải cuộn giữa chúng. `.kb-job-panes` dùng
`grid-auto-flow: column` + `grid-auto-columns: 1fr` chứ không phải `1fr 1fr` cố định: khung bị ẩn
là `display:none` nên **không còn là grid item**, khung còn lại tự chiếm trọn bề ngang thay vì
ngồi cạnh một nửa trống.

## 11. Bốn lỗi một job thật lôi ra (2026-08-30)

Chạy quan sát một job thật (bài "dịch app Volume Discount", 3 bước, 16,5 phút) và đối chiếu mtime
của `kb/` với code. Fixture chứng minh code chạy; job thật chứng minh **giả định** nào sai.

**1. `slugFromKbRel("img/01-x-annotated.png")` trả `"img"`.** Mọi article của tool này để ảnh ở
`kb/img/`, nên mỗi `snap_export` — kể cả 6 lần export thử — đẩy `kb_article_changed { slug: "img" }`,
một bài không tồn tại. UI adopt nó rồi chỉ có thể đọc lỗi; tệ hơn, `noteJobSlug("img")` đóng dấu
**vĩnh viễn** lên job đang chạy (nó chỉ ghi khi còn trống), nên reload trang giữa job quay về đúng
chỗ không có gì. Sửa: chỉ trả slug khi có bài thật trên đĩa (`kb/<slug>.md` hoặc
`kb/<slug>/job.json`) — đúng cái `null` mà comment của `snap_export` vốn đã hứa.

**2. Job báo fail dù bài đã ghi xong.** `_wroteKb` chỉ đếm `mcp__snap__snap_write_kb`, trong khi
skill **khuyến nghị** đường `job.json` + `snap_render_job` cho bài nhiều bước — và chính
`snap_render_job` gọi `assembleMarkdown()` rồi ghi `.md`. Làm đúng skill thì luôn nhận
"The session finished without ever calling snap_write_kb", với bài và 3 PNG nằm sẵn trong `kb/`.
Đổi thành `_wroteArticle`, đếm cả hai tool.

**3. `snap_job` nhận `els` sai shape mà không nói gì.** Job đó ghi `job.json` đầu tiên với els
**phẳng** (`{type, x, y, w, h}`) thay vì `{type, props}`. `render.mjs` truyền `props: el.props || {}`
và `render.add()` làm `Object.assign(el, {})`, nên **mọi** annotation render ở vị trí mặc định của
component — đo được: label ra `1280,625` chữ `"Label"` thay vì `230,470` "Bước 1: Mở Translations".
`toElements()` của KB Studio đọc `el.props` y hệt, nên preview khớp với PNG và **không cái nào nói
tại sao**. Agent mất ~70 giây và hai lượt render đầy đủ để tự phát hiện. Giờ `assertElShapes()`
từ chối tại chỗ ghi, kèm object đã sửa sẵn để chép.

**4. Luật "ghi `job.json` sau MỖI bước" nằm ở mục 7.** Vòng lặp thật của agent là 3→4→5→6 lặp cho
từng bước, mục 7 chỉ tới sau khi mọi thứ đã chụp xong — tức agent chỉ đọc luật sau khi đã làm xong
đúng cái việc luật muốn đổi. Đo được: `job.json` đầu tiên rơi xuống ở phút 15/16,5, **92% chặng
đường**, nên khung preview trống suốt phần làm việc của job. Chuyển thành mục **6b**, ngay sau
"xuất và kiểm tra bằng mắt"; mục 7 còn lại một dòng trỏ ngược.

Ba trong bốn lỗi này không fixture nào bắt được, vì cả ba đều là giả định về **hành vi của agent
và hình dạng đường dẫn thật**, không phải về code. Cái rẻ nhất để lặp lại:
[`snap-bridge/watch-kb.mjs`](snap-bridge/watch-kb.mjs) — poll `kb/` 4 giây một lần và log mọi thay
đổi kèm timestamp cùng tóm tắt `job.json`, không đụng `/ext` nên không cướp socket của extension.

### Lỗi thứ năm, và nó là lỗi của harness

Ngay sau đó: **mọi ảnh trong mọi bài KB đều không hiện.** Trong khi cả 5 harness đều xanh, kể cả
một cái mở đúng bài vừa dựng ra.

Nguyên nhân: `toKbRel()` trả `"kb/" + đường dẫn`, nên `mdRel` thật là **`kb/<slug>.md`**. Còn
`kb_read_image` thì resolve `relPath` **so với `kb/` sẵn rồi**. Khi tôi đổi `resolveImagePath` từ
suy ra theo `articleKind` sang đọc `mdRel` (để lo trường hợp bài chưa có markdown giữa job), phần
tiền tố đó không được cắt — mọi ảnh đi hỏi `kb/kb/img/...` và hỏng sạch.

Harness không bắt được vì nó **không gọi bridge thật**: nó tự bịa reply, và bịa `mdRel` là
`"<slug>.md"` — cái shape tôi *tưởng*, không phải cái bridge *gửi*. Một stub sai thì mọi assertion
dựng trên nó đều vô nghĩa, và càng nhiều assertion càng tự tin nhầm.

Hai việc đã làm, và việc thứ hai mới là việc đáng kể:

1. `mdDirOf()` cắt tiền tố `kb/`.
2. **Chốt contract ở `servertest.mjs`** — nó nói chuyện với server thật, nên `mdRel` được assert ở
   đúng đó cho cả bài phẳng lẫn bài thư mục. Stub của các harness UI giờ chép đúng shape ấy; shape
   đổi thì `servertest` gãy trước và chỉ thẳng vào chỗ phải sửa.

Đã soát lại mọi field khác các stub bịa ra (`read_image` → `{dataUrl}`, `comments_list` →
`{comments}`, `session` → `{hasSession, turns}`, `job_save` → `{savedRel, rendered, warn}`,
`list` → `{items}`) đối chiếu handler thật: chỉ `mdRel` sai.

## 12. Job xong thì bàn giao bài, log ở lại với bài (2026-09-01)

Job chạy xong đang hiện **hai chỗ**: mục ghim ngay dưới "+ New job" (màn hình run — canvas,
preview, log) và chính bài viết trong danh sách bên dưới. Cùng một job, hai dòng trong rail, và
cái người ta muốn mở là bài. Yêu cầu: *"sau khi job finished thì chỉ cần báo finished rồi hiện
luôn ở Editor"*. Thay hành vi mô tả ở cuối mục 9 (mở bài bằng nút `Open article →`).

**`finishAuthorRun()`** (bridge-kb.js) chạy khi dòng `Job finished` về:

- Gỡ mục ghim, thu hồi luôn màn hình run (huỷ surface của preview + canvas agent — không còn
  đường vào thì đừng để nó mount ngầm), toast "Job finished — opening …", rồi `selectArticle()`.
- **Chỉ tự nhảy khi chưa mở bài nào.** Nếu người dùng đang đọc/sửa bài khác giữa lúc job chạy thì
  chỉ báo toast; giật họ ra khỏi bài đang sửa để khoe bài mới là đổi một thứ đang làm dở lấy một
  thứ chờ được.
- **Run hỏng thì giữ nguyên màn hình.** `Job failed`/`Job crashed`/cancel, hoặc xong mà không đặt
  tên bài nào: lúc đó canvas và log là câu trả lời **duy nhất** cho "nó đã làm gì", không có bài
  nào để bàn giao. Reload trang cũng theo đúng luật này (`kb_query` trả `status === 'done'` +
  `slug` thì không ghim lại).

**Log không được chết theo màn hình.** Đó là hồ sơ của việc bài này được dựng ra sao, mà màn hình
chứa nó thì vừa bị thu hồi. Hai lớp:

- `jobLog` (RAM) — mọi dòng vào đây song song với việc vẽ ra DOM, vì **không panel nào là nhà lâu
  dài của nó**: panel bài viết bị xoá mỗi lần mở bài khác, màn hình run thì bị thu hồi hẳn. Cả hai
  vẽ lại từ `jobLog` (`paintLog`) chứ không dựa vào DOM còn sót lại. Có buffer rồi thì
  `activeLog()` đổi câu hỏi: từ "job này sở hữu panel nào" sang **"người dùng có đang mở đúng bài
  của job này không"** — không mở thì dòng mới chỉ vào `jobLog`, không vẽ đi đâu cả. Trước đó nó
  vẽ thẳng vào panel bài viết bất kể panel đang mở bài nào, tức log của bài này nằm dưới tiêu đề
  bài kia (job revise cũng dính, không riêng gì luồng mới).
- `kb/<slug>/job-log.json` (đĩa) — [`snap-bridge/kb-log.js`](snap-bridge/kb-log.js), ghi lúc job
  *settle* (done/failed/crashed/cancelled đều ghi — run kết thúc xấu mới đúng là run đáng đọc
  lại), đọc qua lệnh mới `kb_log_read`. Không có nó thì "agent đã làm gì với bài này" chỉ trả lời
  được cho tới khi job kế tiếp bắt đầu.

**Vì sao là file riêng chứ không phải một key trong `job.json`** — đúng lý do `review.json` là
file riêng (kb-review.js): `snap_job` ghi **cả object**, nên thứ gì runner nhét vào `job.json` sẽ
bị agent lưu bước kế tiếp xoá sạch. File này chỉ runner ghi, chỉ KB Studio đọc, không ai render
bài từ nó. Một bài một file, job sau đè job trước: panel này trả lời "agent vừa làm gì với bài
này", không phải "mọi lần chạy từ trước tới nay" — lịch sử **chữ** của bài đã có
`kb/<slug>/history/`.

Mở một bài mà log đang chạy không thuộc về nó thì UI đọc bản trên đĩa (`paintSavedLog`), và chèn
một dòng banner `— Build finished · <ngày giờ>` lên đầu: cùng panel, nhưng đây là hồ sơ của một
run đã xong chứ không phải job đang chạy, mà panel thì không có manh mối nào khác để phân biệt.
