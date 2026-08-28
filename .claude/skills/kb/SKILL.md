---
name: kb
description: Dựng một bài KB (markdown + ảnh chụp có chú thích) từ một file spec .md và app đang chạy trong Chrome thật. Dùng khi người dùng muốn "viết bài KB", "làm hướng dẫn cho tính năng này", "chụp màn hình rồi chú thích thành bài viết", hoặc dựng lại một bước đã có. Lái snap-bridge — chụp tab thật, chú thích qua editor, xuất PNG, ghép thành kb/<slug>.md.
---

# /kb — dựng bài KB từ app đang chạy

Bạn đọc spec, lên kế hoạch từng bước, lái Chrome thật để chụp, chú thích, rồi ghi bài viết.
Người dùng duyệt.

**Đọc `PLACEMENT_PLAYBOOK.md` cạnh file này TRƯỚC khi đặt annotation đầu tiên** — nó chứa hệ
toạ độ của repo này (canvas **không** cố định), ngữ nghĩa `x/y` khác nhau theo từng type, và
các luật rút ra từ lỗi đã ship thật.

## Cần có trước

- **`snap-bridge` đang chạy** (`cd snap-bridge && npm start`) và extension Snap Studio đã nối.
  Kiểm tra bằng `snap_status` → phải trả `{"connected":true}`.
- **App đang mở sẵn trong Chrome thật, đã đăng nhập.** Pipeline này cố tình chạy trên profile
  thật (xem `KB-BRIDGE.md` 5.2) — không tự đăng nhập hộ.
- Nếu là topology B (spawn từ UI KB Studio): **chỉ được đụng tới các tab đã có sẵn trong
  session** (rail "Session tabs" của UI) — không tự mở tab mới. Mọi `mcp__chrome__*` và
  `snap_capture_tab`/`snap_frame_*` phải truyền đúng một `tabId` trong session; thiếu `tabId`
  hoặc dùng `tabId` ngoài session đều bị từ chối. Nếu cần một trang không có trong session,
  dừng lại và báo rõ cần thêm tab nào — đừng cố `new_tab`.

## Bộ tool

| Tool | Việc |
|---|---|
| `snap_status` | Extension còn nối không |
| `snap_frame_list` | Liệt kê frame trong tab (kể cả iframe cross-origin) |
| `snap_frame_find` | Tìm text trong frame → selector **duy nhất** + `rect` thật |
| `snap_frame_scroll` | Cuộn trong frame |
| `snap_frame_click` | Click trong frame |
| `snap_capture_tab` | Chụp tab → ghi PNG vào `kb/img/` (đường **duy nhất** ghi được file) |
| `snap_kit` | Đọc `use_when`/`gotchas` của 8 component — **gọi để chọn component** |
| `snap_open` | Nạp PNG vào editor |
| `snap_add` | Thêm annotation |
| `snap_export` | Render PNG cuối (headless — không phụ thuộc cỡ cửa sổ) |
| `snap_render_job` | Render lại **cả bài** từ `job.json`, không chụp lại — vòng lặp sửa nhanh |
| `snap_write_kb` | Ghi `kb/<slug>.md` — gọi **đúng một lần**, cuối cùng |

`mcp__chrome__*` dùng để điều hướng (`navigate`, `click`, `fill`, `take_screenshot` để *nhìn*).
**`mcp__chrome__take_screenshot` không ghi file** — ảnh cho bài viết phải từ `snap_capture_tab`.

## Quy trình

### 1. Đọc spec, lên kế hoạch
Một bước = một màn hình. Với mỗi bước: đường dẫn cần tới, tiêu đề ngắn, phần prose, và
annotation dự kiến. Bước 1 **luôn** định vị trong menu (playbook #4).

### 2. Điều hướng tới đúng màn hình, đúng state
`mcp__chrome__navigate` → click/fill để tới đúng trạng thái.

> ⚠️ **Nếu `mcp__chrome__scroll` / `find` / `click` chạy mà không có tác dụng gì** — cuộn không
> nhúc nhích, `find` trả 0 match cho text đang hiện rõ trên màn hình — thì nội dung nằm trong
> **iframe cross-origin** và các tool đó không với tới được. **Đừng lặp lại chúng.** Chuyển sang:
> `snap_frame_list` (tìm frame) → `snap_frame_find` (lấy selector) → `snap_frame_scroll` /
> `snap_frame_click`. Xem `KB-BRIDGE.md` phần iframe cross-origin để hiểu vì sao.

### 3. Xác minh target CÓ trong khung trước khi chụp
`snap_frame_find` trả `rect` thật. Nếu `rect.y` âm hoặc > chiều cao viewport → **chưa có trong
khung**, phải `snap_frame_scroll` tới trước. (Playbook #2 — đây là lỗi đã làm hỏng bài KB đầu.)

### 4. Chụp
`snap_capture_tab({ tabId, out: "img/NN-slug.png" })`. **Ghi lại `<W>x<H>` trong response** —
đó là biên canvas cho mọi toạ độ ở bước sau.

### 5. Chú thích
`snap_open` → (`snap_kit` nếu chưa chắc chọn gì) → `snap_add`.

- **Dùng `at` thay vì đoán toạ độ.** `snap_add({type, at: {selector, tabId, frameId}})` đọc box
  thật của element rồi tự tính toạ độ, tự xử lý ngữ nghĩa `x/y` riêng của từng type. `props`
  vẫn ghi đè được khi cần dịch đi.
  - Selector lấy từ `snap_frame_find` (nó đảm bảo duy nhất — xem `selectorIsUnique`).
  - **Id bắt đầu bằng số** thì dùng `[id="812"]`, đừng dùng `#812` (cần escape `#\38 12`,
    rất dễ hỏng khi đi qua JSON).
  - `arrow` **không** neo được bằng `at` (cần hai đầu mút) — truyền `x1/y1/x2/y2`.
  - `at` đọc vị trí **sống**, nên trang phải đang cuộn y như lúc `snap_capture_tab` chạy.
- Chỉ đoán `x/y` khi không có element nào để neo (ví dụ callout đặt ở vùng trắng). Khi đó đọc
  playbook cho ngữ nghĩa `x/y` từng type (`zoom` là **tâm**, `textbox` là **góc trên-trái**).
- **Blur PII** (tên tài khoản, email, tên cửa hàng, tên khách) — playbook #6.
- ≥1 `zoom` lên chi tiết quyết định — playbook #5.

### 6. Xuất và KIỂM TRA BẰNG MẮT
`snap_export({ out: "img/NN-slug-annotated.png" })` → rồi **`Read` file PNG đó**.

Nhìn thật sự: có component nào bị cắt mép không? callout có đè nội dung không? mũi tên có trỏ
vào chỗ trống không? PII còn lộ không? Nếu có → sửa toạ độ, export lại. **Không bỏ qua bước
này** — mọi lỗi của bài KB đầu tiên đều lẽ ra bắt được ở đây.

### 7. Ghi bài

**Bài nhiều bước → dùng `job.json`** (khuyến nghị): ghi `kb/<slug>/job.json` với `title`,
`slug`, `md`, `intro`, `steps[]` (`n`, `heading`, `src`, `out`, `body`, `notes`, `els`),
`outro`; rồi `snap_render_job({ path: "<slug>/job.json" })` để render mọi ảnh **và** ghép bài.

Lợi ích: sửa một câu chữ hay dịch một callout → chạy lại `snap_render_job` mất **vài giây**,
không cần lái browser, không chạm vào app thật. `els` lưu `props` đã tính xong, nên re-render
không cần capture lại.

**Bài một ảnh, dùng luôn** → `snap_write_kb({ path, content })` một lần, nhúng ảnh bằng
`![alt](img/NN-slug-annotated.png)`.

> ⚠️ Nếu `snap_render_job` trả kèm dòng `WARNING:` về accent — ảnh đã render bằng màu **mặc
> định**, không phải màu người dùng chọn. Kiểm tra extension còn nối không (`snap_status`) rồi
> chạy lại, đừng giao bộ ảnh sai màu.

### 8. Dọn dẹp — bắt buộc nếu đã click vào app thật
Nếu trong quá trình làm có click đổi state (radio, checkbox, form): **khôi phục lại**. Bấm
Discard của app, hoặc chọn lại giá trị cũ. **Không để lại "Unsaved changes" trên store thật
của người dùng.** Xác nhận bằng ảnh chụp cuối.

## Không làm

- **Đừng** dùng `mcp__chrome__javascript_eval` / `read_page` / `get_page_text` cho nội dung
  portal — chúng kéo cả PII vào context rồi có thể trôi thẳng vào bài viết; ảnh còn blur được,
  đoạn văn thì không (`KB-BRIDGE.md` mục 7).
- **Đừng** tự đăng nhập, tự đổi cài đặt, tự Save. Chỉ đọc và chụp; mọi thay đổi để test phải
  hoàn tác.
- **Đừng** hard-code kích thước canvas — đọc từ response của `snap_capture_tab`.

## Khi người dùng sửa lại chỗ đặt của bạn

Append một LEARNING vào `PLACEMENT_PLAYBOOK.md`: ngày · đặt sai thế nào · vì sao sai · luật rút
ra. Playbook chỉ có giá trị nếu được cập nhật; không cập nhật thì 2 tuần nữa nó là tài liệu chết.
