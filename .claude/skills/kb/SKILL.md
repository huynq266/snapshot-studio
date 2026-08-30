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
- Nếu là topology B (spawn từ UI KB Studio): job **không** có quyền vào tab người dùng đã mở sẵn
  (mỗi phiên Chrome Bridge luôn có tab group riêng, rỗng). Thay vào đó, gọi
  `mcp__chrome__navigate` **không kèm `tabId`** để tự mở tab của chính job (cùng profile trình
  duyệt nên vẫn đăng nhập), điều hướng thẳng tới URL của (các) tab trong session — chỉ được
  điều hướng trong đúng **origin** của các URL đó, nơi khác bị từ chối. Lấy `tabId` mà `navigate`
  trả về và dùng đúng giá trị đó cho mọi `snap_capture_tab`/`snap_frame_*`/`snap_add`'s
  `at.tabId` — các tool này không tự nhận tabId mặc định như `mcp__chrome__*`. `new_tab` luôn bị
  từ chối — luôn dùng `navigate` kể cả cho trang đầu tiên. Nếu cần một origin không có trong
  session, dừng lại và báo rõ cần thêm tab nào.

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
| `snap_comments` | Đọc comment người dùng ghim lên ảnh → pixel thật + step + element gần pin |
| `snap_comment_resolve` | Đóng một comment, sau khi đã sửa **và** đã nhìn ảnh render lại |
| `snap_job` | Đọc / ghi đè `job.json` của một bài — sửa `els` khi phiên không có tool sửa file |
| `snap_view` | **Nhìn** một ảnh trong `kb/` — thay cho `Read` khi phiên không đọc được file |
| `snap_learn` | Append một LEARNING vào `PLACEMENT_PLAYBOOK.md` (chỉ thêm, không sửa được phần đã có) |

`mcp__chrome__*` dùng để điều hướng (`navigate`, `click`, `fill`, `take_screenshot` để *nhìn*).
**`mcp__chrome__take_screenshot` không ghi file** — ảnh cho bài viết phải từ `snap_capture_tab`.

## Quy trình

### 0. Bài này đã có chưa? Đọc comment trước khi đụng vào
`snap_comments` (không tham số, một lần gọi, không cần extension). Nếu bài bạn sắp sửa đang có pin
mở, **xử lý chúng trước** theo "Vòng review" ở dưới — dựng đè lên feedback chưa đọc là cách chắc
chắn nhất để lặp lại đúng lỗi người dùng vừa chỉ ra. Bài hoàn toàn mới thì bỏ qua bước này.

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
`snap_export({ out: "img/NN-slug-annotated.png" })` → rồi **`Read` file PNG đó** (phiên không có
tool đọc file — ví dụ job spawn từ KB Studio — dùng `snap_view` thay thế; **không** được bỏ qua).

Nhìn thật sự: có component nào bị cắt mép không? callout có đè nội dung không? mũi tên có trỏ
vào chỗ trống không? PII còn lộ không? Nếu có → sửa toạ độ, export lại. **Không bỏ qua bước
này** — mọi lỗi của bài KB đầu tiên đều lẽ ra bắt được ở đây.

### 6b. Ghi `job.json` NGAY, trước khi chụp bước sau

Ảnh vừa duyệt xong → cập nhật `kb/<slug>/job.json` với bước đó (`snap_job`, hoặc ghi thẳng file
nếu phiên có tool sửa file). **Rồi mới** quay lại mục 3 cho bước tiếp theo. Schema đầy đủ ở mục 7.

Vì sao đây là một luật chứ không phải tuỳ thích: KB Studio vẽ mỗi ảnh trong bài **trực tiếp từ
`job.json`** — ảnh gốc (`src`) làm nền, `els` vẽ sống bên trên. Mỗi lần bạn ghi file đó, người
dùng thấy bước vừa xong hiện lên **ngay lúc job còn đang chạy**, và tự kéo lại được annotation
đặt lệch mà không cần đợi bạn. Gom đến cuối thì suốt cả job họ nhìn vào một khoảng trống — đã đo
trên một job thật: `job.json` đầu tiên rơi xuống ở phút 15/16,5, tức 92% chặng đường.

Ảnh live đó **không cần** `snap_render_job` mới thấy. Render là để tạo PNG cho bài xuất bản, không
phải để người dùng nhìn.

> ⚠️ `els` là `[{ type, props: { ... } }]` — toạ độ nằm **trong** `props`. Viết phẳng
> (`{type, x, y, w, h}`) thì `snap_job` sẽ từ chối, vì nếu lọt qua thì mọi annotation render ở
> **vị trí mặc định** của component chứ không phải vị trí bạn vừa tính, và cả PNG lẫn preview đều
> không nói cho bạn biết.

### 7. Ghi bài

**Bài nhiều bước → dùng `job.json`** (khuyến nghị): ghi `kb/<slug>/job.json` với `title`,
`slug`, `md`, `intro`, `steps[]` (`n`, `heading`, `src`, `out`, `body`, `notes`, `els`),
`outro`; rồi `snap_render_job({ path: "<slug>/job.json" })` để render mọi ảnh **và** ghép bài.

Lợi ích: sửa một câu chữ hay dịch một callout → chạy lại `snap_render_job` mất **vài giây**,
không cần lái browser, không chạm vào app thật. `els` lưu `props` đã tính xong, nên re-render
không cần capture lại.

> `job.json` phải được ghi **sau mỗi bước** trong lúc chụp, không phải một lần ở đây — xem mục
> 6b. Đến chỗ này thì nó đã đầy đủ rồi, việc còn lại chỉ là `snap_render_job` một lần.

**Bài một ảnh, dùng luôn** → `snap_write_kb({ path, content })` một lần, nhúng ảnh bằng
`![alt](img/NN-slug-annotated.png)`.

> ⚠️ Nếu `snap_render_job` trả kèm dòng `WARNING:` về accent — ảnh đã render bằng màu **mặc
> định**, không phải màu người dùng chọn. Kiểm tra extension còn nối không (`snap_status`) rồi
> chạy lại, đừng giao bộ ảnh sai màu.

### 8. Dọn dẹp — bắt buộc nếu đã click vào app thật
Nếu trong quá trình làm có click đổi state (radio, checkbox, form): **khôi phục lại**. Bấm
Discard của app, hoặc chọn lại giá trị cũ. **Không để lại "Unsaved changes" trên store thật
của người dùng.** Xác nhận bằng ảnh chụp cuối.

## Vòng review — khi người dùng ghim comment lên ảnh

Trong KB Studio (tab KB) người dùng bật **💬 Comment** rồi click thẳng vào điểm sai trên ảnh. Đó
là đường chính để họ sửa cách bạn đặt annotation — cụ thể hơn mọi lời mô tả, vì nó chỉ đúng chỗ.

1. **`snap_comments`** (không tham số) → bài nào đang có feedback chờ. `snap_comments({slug})` →
   từng pin, kèm:
   - `at.x` / `at.y` — **pixel thật trong hệ toạ độ của ảnh gốc** (`at.space.base`), đúng hệ mà
     `props` của `snap_add` và `els` trong `job.json` đang dùng. Không phải tự quy đổi.
   - `step` — bước nào trong `job.json` sở hữu ảnh đó, và file job ở đâu.
   - `nearestEls` — element gần pin nhất kèm `props`, sắp theo khoảng cách. Comment kiểu "mũi tên
     trỏ vào chỗ trống" gần như luôn nói về `nearestEls[0]`.
2. **Đọc lại `PLACEMENT_PLAYBOOK.md`** trước khi dời bất cứ thứ gì — comment thường chỉ là một
   luật đã có trong đó bị vi phạm lần nữa.
3. **Sửa `els` trong `job.json`** (`snap_job` đọc/ghi cả object, nếu phiên không sửa file trực tiếp
   được) rồi `snap_render_job`. Không chụp lại, không đụng app thật —
   trừ khi comment nói ảnh chụp sai state (playbook #2); lúc đó phải quay lại bước 2–4.
4. **`Read` — hoặc `snap_view` — file PNG vừa render** và nhìn thật (bước 6). Chưa nhìn là chưa xong.
5. **`snap_comment_resolve({slug, id, note})`** — `note` một dòng nói bạn đã đổi gì; nó hiện ngay
   trên pin trong KB Studio. Chỉ resolve cái đã thực sự sửa. Cái bạn quyết định **không** sửa thì
   để mở và nói ra, đừng resolve cho sạch bảng.
6. **Append một LEARNING vào `PLACEMENT_PLAYBOOK.md`** (`snap_learn` nếu không sửa file được) nếu
   comment đó sửa một quyết định *đặt*
   (tràn mép, đè target, trỏ vào chỗ trống, lộ PII). Đây là bước duy nhất khiến lần sau không lặp
   lại — bỏ nó thì vòng review chỉ vá được đúng một bài.

**Đừng** thêm hay xoá comment hộ người dùng — bộ tool cố tình không có đường đó. Pin là phía họ
nói; bạn đọc, sửa, và trả lời bằng `note`.

## Job "revise" — khi người dùng gõ prompt thẳng trong KB Studio

Chọn một bài trong tab KB → gõ vào ô prompt dưới bài → snap-bridge spawn một phiên agent **không
có browser** (`kb-job.js`, mode `revise`), nạp sẵn cho nó: markdown hiện tại của bài, các comment
đang mở (đã quy đổi ra pixel), và câu người dùng vừa gõ.

**Nếu bạn LÀ phiên đó**: mọi tool `mcp__chrome__*` và mọi `snap_*` cần `tabId` (`snap_capture_tab`,
`snap_frame_*`, `snap_add` với `at`) đều bị từ chối — đó là ranh giới của job này, không phải lỗi
cấu hình, đừng thử lại. Bạn làm việc trên file đã có trong `kb/`:

`snap_comments` → `snap_job` → `snap_render_job` (hoặc `snap_open`/`snap_add` với toạ độ `props`
tường minh + `snap_export` cho bài không có `job.json`) → **`snap_view`** → `snap_comment_resolve`
→ `snap_learn`.

**Nhiều lượt là CÙNG một phiên.** Prompt thứ hai trở đi mở đầu bằng "Follow-up from the user in the
same session" — bạn còn nguyên ngữ cảnh lượt trước, nên "vẫn lệch, dịch phải thêm chút" là câu có
nghĩa. Phần trạng thái (comment đang mở + markdown) vẫn được đọc lại từ đĩa mỗi lượt và **tin nó
hơn trí nhớ** khi hai bên khác nhau — người dùng có thể đã sửa tay giữa hai lượt. Người dùng bấm
"⟲ New session" là cắt phiên; lúc đó bạn bắt đầu lại từ đầu, không có gì để nhớ.

Cần ảnh mới — app đổi, target chưa bao giờ nằm trong khung, state trong ảnh sai (playbook #2) —
thì **dừng lại và nói rõ bước nào cần chụp lại**. Người dùng sẽ chạy "+ New job" với tab mở sẵn.
Tuyệt đối không dời annotation sang một target không có trong ảnh để trông như đã sửa.

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

Áp dụng như nhau dù họ sửa bằng comment ghim (vòng review ở trên) hay chỉ nói trong chat — comment
chỉ là kênh chính xác hơn, không phải một việc khác.
