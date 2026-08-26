# Snap Studio — Lộ trình triển khai

Tài liệu này nối **bản đề xuất sản phẩm** (artifact nội bộ, 2026-08-23) với **mã nguồn
thực tế** trong repo, và chia phần còn lại thành các bước triển khai dần.

- Đề xuất gốc: https://claude.ai/code/artifact/bb022e74-06c3-4396-98b5-e429ff224f52
- Repo tiền thân: `github.com/pdtoan2811-bit/ownegoMarketingMaterialToolkit` → `tools/doc-guide/packages/userguidesnap`
- Cập nhật lần cuối: 2026-08-26

> Đề xuất ghi trạng thái *"ý tưởng, chưa triển khai"* — dòng đó đã lỗi thời. V1 đã có mã
> chạy được. Tài liệu này là nguồn sự thật mới về tiến độ.

---

## 0. Tình trạng hiện tại

**V1 đã dựng xong về mặt mã nguồn, chưa được kiểm chứng trong trình duyệt thật.**

| Mục V1 trong đề xuất | Trạng thái | Ghi chú |
|---|---|---|
| Phím tắt chụp toàn tab (`Alt+Shift+S`) | ✅ Xong | `src/background.js` → `captureWholeTab()` |
| Kéo-chọn vùng (`Alt+Shift+R`) | ✅ Xong | `src/region-select.js`, crop trong editor |
| Chế độ chụp nhanh (không bắt tạo guide/job) | ✅ Xong | Editor mở thẳng với ảnh đã đặt sẵn |
| 8 component chú thích | ⚠️ Kit đã đổi | Không còn `connector` độc lập — xem mục "Đổi design kit" bên dưới |
| Xuất pixel-perfect | ⚠️ Đổi cơ chế | Xem "Lệch kiến trúc" bên dưới |
| Copy ảnh vào clipboard | ✅ Xong | `#copyImg` hoặc `Ctrl+C` — `copyImage()` |
| Dán ảnh từ clipboard vào editor | ✅ Xong | `Ctrl+V` — listener `paste` → `pasteImageFile()` |
| Nhiều lớp ảnh trong một khung | ✅ Xong | element `type:'image'`; ảnh nền là `BASE_ID` trong panel Layers |
| Copy link chia sẻ | ❌ Chưa | Cần server — không có trong V1 |
| Đóng dấu ngữ cảnh tự động | ✅ Xong | `stampText()` trong `src/editor.js` |
| Snap Library | ❌ Chưa | Đẩy sang V2 |

### Ba điểm lệch so với đề xuất (đã quyết, không phải thiếu sót)

**1. Cơ chế render đã thay hoàn toàn.**
Đề xuất: dùng nguyên `render.mjs` + Playwright headless. Thực tế: repo đứng riêng, không
có Node process nào, nên `renderToPngDataUrl()` nhờ service worker `captureVisibleTab`
chính tab editor ở chế độ `body.render`. Cùng nguyên lý — screenshot compositor thật, để
`backdrop-filter` không vỡ — nhưng khác process.
*Đánh đổi:* không chụp được ảnh lớn hơn cửa sổ trình duyệt; bản xuất bị cắt kèm toast báo.

**2. Repo tách riêng, trái khuyến nghị Option A của chính đề xuất.**
Mục 07 khuyến nghị làm studio thứ 6 sống chung repo với `design-kit`, lý do: *"Component
Forge cần đường dẫn tương đối ngắn tới `design-kit/`"*. Repo này lại đứng riêng, và
`src/tokens.css` chỉ là bản vendored mang banner `GENERATED — DO NOT EDIT` mà **không còn
lệnh sync nào enforce**. Hệ quả trực tiếp: V3 khó hơn đúng như đề xuất đã cảnh báo.
→ Xem "Quyết định còn treo" #1.

**3. `connector` bị cắt có chủ ý — nay đã lỗi thời theo cách khác.** Nhận định ban đầu
(component nặng tương tác nhất, `arrow` hai điểm phẳng đủ cho V1) vẫn đúng tinh thần,
nhưng bản thân component `connector` không còn tồn tại sau khi đổi design kit (xem mục
"Đổi design kit" ngay dưới) — kit mới không có `.cmp-connector` độc lập, chỉ có
`__connector` là *part* tuỳ chọn của `text-box` và `zoom-magnify` (chế độ "dời ra xa +
nối lại bằng một đường kèm chấm neo"). Phần CSS đó có sẵn trong `tokens.css`; phần neo
hai đầu + tính lại đường khi kéo vẫn chưa có trong `editor.js` — cùng một lỗ hổng, khác
tên class.

---

---

## Đổi design kit (2026-08-24)

`src/tokens.css` không còn là bản vendored của cùng "editorial-glass" mà đề xuất gốc và
mục 0–3 ở trên nói tới. Đã thay hẳn bằng **OneShot Guideline Kit** từ
`github.com/cedrus-8864/oeditions-tung` (`tools/design-kit/`) — một toolkit khác, tình cờ
brand pack của nó cũng tên "editorial-glass" (tím `#7c2cfb` liquid-glass) trùng tên với kit
cũ nhưng accent xanh `#1350de`, ngôn ngữ phẳng-kiểu-product-doc thay vì kính. Lý do đổi:
kit mới có `catalog.json` + spec docs + `sync.mjs` sống, tức còn nguồn để đồng bộ tiếp —
kit cũ trong repo này chỉ là bản vendored chết, không nơi nào giữ nguồn để sync lại.

Ánh xạ component cũ → mới, xem README mục "Design-system wiring" để có bảng đầy đủ. Điểm
đáng chú ý nhất cho lộ trình: **`.cmp-connector` độc lập biến mất** — kit mới không có
component "mũi tên neo hai đầu, tự tính lại đường" như một class riêng; thay vào đó
`text-box` và `zoom-magnify` mỗi cái có `__connector` là *part* tuỳ chọn của chính nó (dời
ra xa + nối lại bằng một đường kèm chấm neo), dùng chung "anchor-dot convention" mà
`arrow`'s `__origin` định nghĩa. Ba class riêng biến thành hai part phụ thuộc — hẹp việc
cần làm lại (mục V2 bên dưới) nhưng tăng số chỗ phải sửa nếu làm.

Có 2 component mới không nằm trong đề xuất gốc: `spotlight` (làm tối cả khung, khoét một
lỗ) và `screenshot-canvas` (nền đệm + khung bo cho ảnh, bắt buộc theo spec — bật mặc định
qua công tắc **Khung ảnh** ở topbar, không phải annotation nên không thả được lên ảnh).

Tab **Components** (mục V3 bên dưới) đọc trực tiếp `src/kit-catalog.js` — bản vendored của
`catalog.json` — nên panel bên phải hiển thị đúng `use_when`/`gotchas` của kit mới, không
phải diễn giải tay.

## V1.1 — Vá lỗ hổng trước khi dùng với ticket thật

Việc nhỏ, nhưng **chặn việc dùng thật**. Nên làm trước tất cả phần V2.

- [ ] **Kiểm chứng trong Chrome thật.** README ghi rõ: chưa từng chạy trong trình duyệt,
      mọi đường xử lý sự kiện chỉ được đọc lại chứ chưa test. Đi hết golden path:
      snap toàn tab → snap vùng → thêm cả 7 component → kéo/resize → export → copy.
      *Đây là việc số 1. Mọi mục dưới đây đều giả định V1 thực sự chạy.*

- [ ] **Xoá `pendingCapture` sau khi editor đã nhận ảnh.**
      `src/background.js:84,119` ghi ảnh vào `chrome.storage.local` nhưng **không nơi nào
      xoá**. Ảnh chụp màn hình khách hàng nằm lại trong storage vô thời hạn, sống qua cả
      lần khởi động lại trình duyệt. Đây chính là rủi ro "Dữ liệu khách hàng" mà mục 09
      của đề xuất nêu — và nó đã hiện diện ngay ở V1, không đợi tới Snap Library.
      → Gọi `chrome.storage.local.remove([...])` trong `loadCapture()` sau khi ảnh đã vào editor.

- [ ] **Thêm icon cho extension.** `manifest.json` không khai báo `icons` lẫn
      `action.default_icon` → hiện icon mảnh ghép xám mặc định. Repo tiền thân có sẵn bộ
      `hub/icons/camera*.webp` chưa tool nào dùng.

- [ ] **Self-host font.** `src/editor.html` nạp Google Fonts qua CDN. Chạy unpacked thì
      được, nhưng CSP mặc định của MV3 chặn font từ xa khi đóng gói.

- [ ] **Sửa dấu ngữ cảnh: `viewport` chứ không phải kích thước ảnh.** Đề xuất ghi
      *"trình duyệt · OS · viewport · URL · thời điểm"*; `stampText()` đang đóng dấu kích
      thước **ảnh**. Với ảnh chụp vùng, con số này không cho dev biết viewport thật.

---

## V2 — Snap Library & tích hợp ticket

Mục tiêu: *ảnh chụp có chỗ sống và có đường ra.*

- [x] **Thư viện lịch sử (Snap Library).** Đã dựng: tab **Library** thứ ba trong topbar
      (cạnh Snap/Components), `src/library.js`. Chỗ lưu đã quyết: **IndexedDB trong
      extension, không server** (theo hướng chỉ-trong-máy của "Quyết định còn treo" #2 —
      chưa có backend nào trong repo này, và job-board/share-link vẫn cần một cái nếu làm
      tiếp). Có dedup (so JSON của `els`, qua một `WeakMap` chứ không gắn field vào
      `capture`) để mở một mục ra rồi đóng lại không tự nhân bản. Nút **Save to library**
      trong toolbar là checkpoint thủ công, luôn ghi (không dedup) vì bấm nút mà không thấy
      gì xảy ra thì đọc như hỏng.
      **2026-08-26 — đổi cơ chế nguồn:** cơ chế đè mất của V1 giờ sửa tận gốc theo cách
      khác, không còn dựa vào Library làm nơi giữ duy nhất. `editor.js` giờ có một dải tab
      chụp (`#snapTabs`/`renderTabs()`) phía trên canvas — snap mới, và mở lại một mục từ
      Library, đều mở như MỘT TAB MỚI (`captures` array), giữ nguyên tab đang có để chuyển
      qua lại và copy chéo, thay vì gọi `finishCaptureSwap()` để ghi đè `capture` như trước.
      Library giờ chỉ còn là lưới cho hai đường THỰC SỰ vứt bỏ một capture: đóng một tab
      (nút ✕ trên tab, `closeTab()`) và **Replace base image…** (`replaceInPlace: true` —
      vẫn đổi ảnh ngay tại chỗ, có xác nhận, xem README mục "Try it" bước 7).
- [x] **Chính sách lưu trữ / tự xoá.** Không tách khỏi mục trên, làm cùng lúc, không phải
      sau. Mặc định **giữ 14 ngày**, chỉnh được 7/14/30/không bao giờ ngay trong tab
      Library; hạ xuống một mốc ngắn hơn thì xoá phần quá hạn ngay, không đợi lần mở sau.
      "Ai được xem": vì chọn không server, câu trả lời là *chỉ máy này* — không đồng bộ,
      không link chia sẻ, không nơi thứ hai nào đọc được — nói thẳng trong UI của tab
      Library, không giả định người dùng tự suy ra.
- [ ] **Đính thẳng vào Zendesk/Intercom/Slack**, theo kiểu "degrade loudly" mà repo tiền
      thân đã dùng cho các API key tùy chọn.
- [ ] **Link chia sẻ.** Hạng mục V1 duy nhất bị bỏ lại. Cần server → xem "Quyết định còn treo" #2.
- [ ] **Chụp cuộn trang dài (full-page).** `captureVisibleTab` chỉ lấy phần đang hiển thị;
      cần cuộn-và-ghép nhiều lần chụp.
- [ ] **Nối phần `__connector` (relocate mode) của `text-box` / `zoom-magnify`.**
      CSS đã có sẵn trong `tokens.css` (kit mới); việc còn lại là neo start point vào
      component, tính lại đường + chấm neo khi kéo — xem mục "Đổi design kit" ở trên.
- [ ] **Preset blur cho vùng nghi chứa PII.** Đề xuất nêu đây là khác biệt cốt lõi so với
      Monosnap: blur *được gợi ý sẵn*, không phải việc phải nhớ làm.

---

## V3 — Component Forge

Design system tự phục vụ, có kiểm soát. **Phụ thuộc vào quyết định #1 bên dưới.**

### Đã có: tab **Components** trong editor

Một lát cắt của Forge, làm được mà không cần MCP server hay repo hợp nhất:

- Tab thứ hai trong `src/editor.html` (`body.view-lab`), cạnh tab Snap.
- **Preview cả 8 component của kit** (7 annotation + `screenshot-canvas`) trên nền
  sáng / nền tối / chính ảnh vừa chụp, có một trang giả bên dưới để kính và
  `backdrop-filter` có thứ thật mà bẻ. Panel bên phải đọc thẳng `summary`/`use_when`/
  `gotchas` từ `src/kit-catalog.js` (bản vendored của `catalog.json`), không phải diễn
  giải tay. Đây cũng là rào chắn #4 ("preview trên cả nền sáng và nền tối") dựng thành
  UI thay vì thủ tục.
- **Tạo component mới**: chọn khuôn (kính / pill / thẻ trắng / khung / cảnh báo / trống),
  sửa CSS trực tiếp, lưu vào `chrome.storage`. Component hiện luôn trong palette tab Snap,
  thả lên ảnh được, và sống sót qua ảnh export vì CSS nằm cùng document với stage.
- **Lint CSS ngay lúc gõ**: chặn transform 3D (Chrome âm thầm bỏ `backdrop-filter`), cảnh
  báo màu hex cứng (rào chắn "không hardcode accent") và thiếu `-webkit-` prefix.
- Nút **Copy CSS** xuất rule để dán vào `tokens.css`, kèm cảnh báo rằng dán vào đây là
  *fork* bản vendored chứ không phải sync.

Còn thiếu so với Forge đầy đủ (vẫn phụ thuộc quyết định #1 và #4):

- [ ] Nhánh riêng + PR — hiện component mới chỉ nằm trong trình duyệt một người, không để
      lại dấu vết review nào. Đây là khoảng cách lớn nhất còn lại.
- [ ] Đọc `catalog.json` để bắt trùng trước khi tạo ("look before you build"). Chưa có,
      nên vẫn dễ đẻ ra component thứ 9 trùng chức năng với một trong 8 cái sẵn có.
- [ ] Phân quyền: hiện ai mở được editor là tạo được component.

### Phần còn lại — Forge đầy đủ

- [ ] MCP server: `read_catalog` / `read_component` / `write_component_css` /
      `update_catalog` / `add_gallery_demo` / `run_sync` / `render_preview`
- [ ] Khởi chạy agent Claude Code CLI cục bộ từ một file thiết kế `.md` kéo-thả vào
- [ ] **Bốn rào chắn bắt buộc** (nguyên văn mục 06 của đề xuất):
      1. Luôn làm việc trên nhánh riêng + mở PR — không commit thẳng `main`
      2. Prompt luôn kèm *"tìm trong `catalog.json` trước — nếu đã có component tương đương
         thì dừng và báo"* (câu mở đầu của skill `editorial-glass`: "Look before you build")
      3. Chỉ admin/người giữ design system được bấm — support agent chỉ chọn component có sẵn
      4. Không merge im lặng: luôn kèm preview trên **cả nền sáng và nền tối** trước khi duyệt

> Rào chắn không phải thủ tục thừa: `design-kit` được **5 studio** khác cùng nhận qua
> `bin/sync.mjs`. Một component sai token sẽ lan ra tất cả.

---

## Ngoài lộ trình

Quay video/GIF ngắn, và chụp ngoài trình duyệt (app desktop, terminal lỗi) — cần một app
riêng (Electron/Tauri), việc mà extension Chrome không làm được. Đánh giá lại sau khi
V1–V3 chứng minh được giá trị.

---

## Quyết định còn treo

**1. Repo này đứng riêng hay nhập lại vào toolkit?** *(chặn V3)*
Đề xuất khuyến nghị Option A — studio thứ 6, chung repo với `design-kit`. Thực tế đã đi
Option B. Chừng nào còn tách, `src/tokens.css` là bản chết: sửa design system phải làm ở
toolkit rồi copy tay sang. Component Forge cần đọc/ghi trực tiếp `catalog.json` và `css/`,
nên hoặc nhập lại repo, hoặc phải dựng một cơ chế đồng bộ hai chiều — việc mà đề xuất đã
cố tình tránh.

**2. V2 có server hay không?** *(một phần đã quyết — xem dưới)*
Link chia sẻ, Snap Library dùng chung, và tích hợp ticket đều cần nơi lưu ngoài trình
duyệt. Phần **Snap Library** đã chốt: **không server**, `IndexedDB` chỉ-trong-máy (xem
mục V2 ở trên) — quyết định này chỉ có hiệu lực cho lịch sử snap của MỘT máy/MỘT profile
trình duyệt. Hai phần còn lại của câu hỏi vẫn treo nguyên: **link chia sẻ** và **Snap
Library dùng chung giữa nhiều người/máy** đều đòi hỏi thứ mà chỉ-trong-máy không cho
được — cả hai vẫn cần server nếu làm.

**3. Link chia sẻ có hết hạn / có bắt đăng nhập không?** Đặc biệt quan trọng khi ảnh có
dữ liệu khách hàng và link lỡ lọt ra ngoài kênh nội bộ.

**4. Ai được quyền tạo component mới, và PR có bắt buộc review không?** Chốt trước khi
viết dòng mã đầu tiên của Component Forge.
