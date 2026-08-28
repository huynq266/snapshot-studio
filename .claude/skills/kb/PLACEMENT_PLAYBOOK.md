<!-- ─────────────────────────────────────────────────────────────────────────
PLACEMENT PLAYBOOK — trí nhớ về cách đặt annotation cho đúng.

Cả Claude lẫn người dùng cùng sửa file này. Claude ĐỌC TRƯỚC khi đặt bất kỳ
step / textbox / highlight / arrow / zoom nào, và APPEND một LEARNING mới mỗi
lần người dùng sửa lại một chỗ đặt sai.

File này dạy CÁCH ĐẶT, không dạy CHỌN component nào — việc chọn component đã có
`snap_kit` (đọc từ `src/kit-catalog.js`, mỗi component có `use_when` + `gotchas`
riêng). Gọi `snap_kit` để chọn, đọc file này để đặt. Đừng chép lẫn nhau.

Định dạng:
  - PRINCIPLES: luật ổn định, quan trọng nhất trước.
  - LEARNINGS: bài học có ngày tháng, cụ thể (đổi gì · vì sao). Skill `/kb`
    append vào đây; khi một learning lặp lại đủ nhiều thì nâng thành PRINCIPLE.
────────────────────────────────────────────────────────────────────────── -->

# KB annotation — placement playbook

## Hệ toạ độ ở repo này (đọc kỹ — khác các công cụ slide-deck)

**Canvas KHÔNG cố định.** `.stage` là `display:inline-block` co theo `#baseImg`
(`src/editor.css:94`), nên vùng vẽ **chính là kích thước tự nhiên của ảnh chụp**:
`capture.img.w × capture.img.h`. Không có con số 1128×660 hay bất kỳ canvas cố định nào.

- **Biết kích thước thật ở đâu**: `snap_capture_tab` trả về `Captured <W>x<H> from …`.
  Dùng đúng W/H đó làm biên. Trên máy dev hiện tại thường là **1920×889** (viewport Chrome
  maximized), nhưng **không được hard-code** — máy khác, zoom khác, số khác.
- **Gốc toạ độ** (0,0) ở góc trên-trái ảnh. Không có padding ẩn.
- Không truyền `props.x/y` → element rơi vào **tâm ảnh** (`centerXY()`, `editor.js:96`).

### Ngữ nghĩa x/y khác nhau theo từng type — bẫy thật, đã kiểm chứng trong code

| Type | `x/y` nghĩa là gì | Kích thước mặc định |
|---|---|---|
| `textbox` | **góc trên-trái** (chiều cao tự co theo nội dung) | `w: 280` |
| `zoom` | **TÂM** của vùng zoom (`editor.js:457`) | `198 × 198` |
| `step` | góc trên-trái | `90 × 28` |
| `highlight` / `spotlight` | góc trên-trái | `180 × 48` |
| `blur` | góc trên-trái | `180 × 32` |
| `arrow` | dùng `x1/y1/x2/y2`, **không** có `x/y` | — |
| `label` | điểm neo | — |

Nhầm `zoom` (tâm) với `textbox` (góc) làm lệch đúng **99px** — đủ để trông "gần đúng mà sai".

---

## PRINCIPLES (đọc trước khi đặt)

### 0. Không gì được tràn khỏi khung ảnh. (hard rule)

Callout, step marker, arrow, zoom — **không phần nào** được vượt quá mép ảnh. Một
component bị cắt là **lỗi hỏng**, không phải "chấp nhận được".

Tính biên từ kích thước thật của ảnh (W×H từ `snap_capture_tab`) trừ đi kích thước của
chính component:

- `textbox` (w 280, cao ~120–200 tuỳ nội dung): giữ `x ≤ W - 300`, `y ≤ H - 220`.
- `zoom` (198×198, x/y là **tâm**): giữ `99 ≤ x ≤ W - 99` và `99 ≤ y ≤ H - 99`.
- `step` (90×28): giữ `x ≤ W - 100`, `y ≤ H - 40`.

**Luôn kiểm chứng bằng mắt**: sau `snap_export`, `Read` file PNG vừa xuất. Nếu bất kỳ mép
component nào bị cắt → sửa toạ độ và export lại. Không "chắc là ổn".

> **LEARNING 2026-08-28** — bài KB đầu tiên
> (`kb/multibuy-percentage-discount-per-combo-vs-highest-tier.md`): Step 4 đặt gần đáy khung
> và **bị cắt mất một nửa**, vì phần "Tier settings" nó trỏ tới nằm ngoài viewport chụp.
> Nguyên nhân kép: (a) toạ độ y quá sát đáy, (b) target thật ra không có trong ảnh — xem
> nguyên tắc #2.

### 1. Callout không bao giờ đè lên target của nó.

Đặt `textbox`/`step` **lệch sang bên**, chừa khoảng trống giữa nó và vùng nó nói tới, rồi
nối bằng `arrow`. Nếu callout nằm chồng lên chính thứ người đọc cần nhìn thì cả hai đều hỏng.

> **LEARNING 2026-08-28** — cùng bài KB đó: Step 5 đặt đè lên link "more products" trong
> vùng preview, che mất chính nội dung đang mô tả.

### 2. Xác minh target TỒN TẠI, HIỆN RÕ, ĐÚNG STATE trong ẢNH NÀY — trước khi đặt. (hard rule)

Dấu hiệu ảnh chụp sai (sửa **bước chụp**, không phải dời annotation):

- mũi tên kết thúc ở khoảng trống;
- copy bảo "bấm nút X" nhưng nút đang mờ/disabled;
- danh sách rỗng trong khi bài viết mô tả các dòng dữ liệu;
- nội dung cần trỏ tới nằm **dưới fold** — ngoài viewport chụp.

Cách sửa đúng: cuộn tới đúng chỗ (`snap_frame_scroll` / `mcp__chrome__scroll`) **rồi mới**
`snap_capture_tab`, hoặc click để mở đúng state trước. **Không** dời callout lên một target
không có trong ảnh.

**Cách chắc chắn nhất**: dùng `snap_frame_find` để lấy `rect` thật của element trước khi
chụp. Nếu `rect.y` âm hoặc lớn hơn chiều cao viewport → nó **không có trong khung**, phải
cuộn trước.

### 3. Đừng đổ lỗi cho engine khi annotation trông sai.

Gần như luôn là **placement** hoặc **capture**, không phải engine hỏng. Trước khi kết luận
"component này không vá được", kiểm tra lại: đúng toạ độ chưa, đúng ngữ nghĩa x/y của type đó
chưa, target có thật trong ảnh không.

> **LEARNING 2026-08-28** — mất 6 vòng thử sai vì kết luận "Polaris radio có quirk không vá
> được", trong khi lỗi thật là **selector tự sinh không duy nhất** nên click trúng radio khác.
> Chi tiết: `KB-BRIDGE.md`, phần iframe cross-origin. Bài học tổng quát: khi một thao tác
> "chạy không lỗi nhưng không có tác dụng", **nghi ngờ mình đang tác động nhầm đối tượng trước**.

### 4. Bước 1 luôn định vị trong menu.

Câu hỏi đầu tiên của người đọc là *"bấm đâu để tới màn hình này?"*. Ảnh đầu tiên của mỗi bài
KB phải trỏ vào mục menu/nav mở ra màn hình đó — `highlight` lên mục menu + `step` + `arrow`.
Giữ cue nav ở **bước 1 thôi**, trừ khi bước sau đổi màn hình.

### 5. Mỗi bài ≥1 `zoom` lên chi tiết quyết định.

Mỗi bài KB nên có ít nhất một `zoom` phóng đúng một chi tiết nhỏ mà bài viết nói về (một
badge trạng thái, một ô số, một giá trị dropdown, một toggle) — thay vì tả bằng lời "cái ô
nhỏ ở góc phải".

Đừng chồng `zoom` và `highlight` lên cùng một điểm nhỏ; chọn một.

### 6. Che PII trước khi xuất. (hard rule cho bài công khai)

Ảnh chụp từ portal thật **luôn** chứa thứ không nên lên KB công khai: tên tài khoản, email,
tên cửa hàng, tên khách, số đơn thật. `blur` lên chúng **trước** `snap_export` — sau khi
export là quá muộn, file đã nằm trên đĩa.

Chủ động đề xuất blur; đừng chờ được nhắc. Nếu không chắc một vùng có phải PII không → hỏi
người dùng, đừng tự quyết là "chắc không sao".

> **LEARNING 2026-08-28** — `kb/img/01-multibuy-offer-settings-annotated.png` lộ tên tài khoản
> thật `huynq-vl` ở thanh nav Shopify admin, không blur. `KB-BRIDGE.md` mục 5.4 đã cảnh báo
> trước rằng blur PII "chưa bắt buộc" trong lần dựng đầu — và đúng là nó đã lọt.

---

## LEARNINGS (mới nhất trước)

*(Skill `/kb` append vào đây mỗi khi người dùng sửa lại một chỗ đặt sai. Ghi: ngày · đặt sai
thế nào · vì sao sai · luật rút ra.)*

- **2026-08-28 (lần chạy thử playbook này)** — Ba lỗi cũ **đều không tái diễn**. Ba điều học
  thêm được:

  1. **Toạ độ từ `snap_frame_find` KHÔNG dùng thẳng được cho `snap_add`.** `rect` trả về nằm
     trong hệ toạ độ **của frame đó**, còn `snap_capture_tab` chụp **cả tab** (gồm sidebar +
     topbar của Shopify admin). Phải cộng offset của iframe trên trang cha. Đo được lần này:
     `canvas = frame + (240, 121)` — 240 = bề rộng sidebar, 121 = topbar + page header. **Con số
     này của riêng layout Shopify admin ở cỡ cửa sổ đó**, không phải hằng số: đo lại bằng cách
     đối chiếu một element có `rect` với vị trí của nó trên ảnh đã chụp. Ánh xạ tự động là việc
     của Phase 2 trong `KB-STUDIO-PLAN.md`; tới lúc đó vẫn phải làm tay.
  2. **`zoom` che mất ngữ cảnh xung quanh nó.** Nó phóng to *tại chỗ*, nên vùng 198×198 dưới nó
     bị thay thế. Lần này zoom lên cặp radio Discount type đã che luôn tiêu đề "Tier settings"
     ngay trên. Chấp nhận được vì phần phóng to chính là nội dung chính, nhưng **hãy chọn tâm
     zoom sao cho phần bị che là chỗ ít quan trọng nhất** — đừng đặt giữa hai thứ đều cần thấy.
  3. **Kích thước canvas đổi giữa các phiên**: lần trước 1920×**889**, lần này 1920×**945** (cùng
     máy, khác chiều cao cửa sổ). Xác nhận luật "đọc W×H từ response `snap_capture_tab`, không
     hard-code" là bắt buộc chứ không phải cẩn thận thừa.

- **2026-08-28** — Lần dựng KB đầu tiên lộ ba lỗi cùng lúc: Step 4 tràn mép (→ #0), Step 5 đè
  nội dung (→ #1), lộ tên tài khoản thật (→ #6). Cả ba đều là lỗi *đặt* và *chụp*, không phải
  lỗi chọn component — đó là lý do playbook này tách khỏi `snap_kit`.
