<!-- ─────────────────────────────────────────────────────────────────────────
PLACEMENT PLAYBOOK — trí nhớ về cách đặt annotation cho đúng.

Cả Claude lẫn người dùng cùng sửa file này. Claude ĐỌC TRƯỚC khi đặt bất kỳ
step / textbox / highlight / arrow / zoom nào, và APPEND một LEARNING mới mỗi
lần người dùng sửa lại một chỗ đặt sai.

Người dùng sửa chủ yếu bằng cách GHIM COMMENT lên đúng điểm sai trên ảnh trong
KB Studio. Đọc bằng `snap_comments` (pin đã quy đổi sẵn ra pixel của ảnh gốc,
kèm step và element gần nhất), đóng bằng `snap_comment_resolve` — quy trình đầy
đủ ở SKILL.md, phần "Vòng review".

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
thế nào · vì sao sai · luật rút ra. Nguồn chính của những lần sửa đó là comment ghim trên ảnh:
mỗi comment về **cách đặt** mà bạn `snap_comment_resolve` phải để lại một dòng ở đây — resolve mà
không ghi thì bài học chết theo cái pin.)*

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

- **2026-08-29** — 2026-08-29 — Revise job (no browser) on a flat single-file article (how-to-search-wikipedia, no job.json): the exported "-annotated.png" referenced in the markdown was NOT pixel-identical in resolution to its own unannotated base file on disk (annotated 2026x1008 vs true base img/01-homepage.png at 2560x1249 — same page, non-uniform aspect difference, cause unclear, not a clean scale factor). Do not reverse-engineer element coordinates by reading pixels off the (smaller) annotated export and reusing them on the base — open the actual unannotated base PNG, re-estimate target coordinates directly on IT, then render+snap_view to verify/iterate before overwriting the annotated file. Worked first try here for a well-defined target (search input + button) by eyeballing fractions of the base image width/height and refining with one test render.

- **2026-08-30** — 2026-08-30 — "step" (step-marker) component's number is NOT settable via any snap_add/job.json prop in this build. Tried n, number, index, step, label, text, variant:"compact" — always renders "Step 1", both via direct snap_add on a flat capture and via job.json steps[].n through snap_render_job. Confirmed engine limitation (12+ isolated tests, ruled out caching/stale-editor first per principle #3) — don't burn more than 2-3 prop-name guesses on this again. WORKAROUND: use type `label` instead, props:{x,y,text:"Step N"} — renders the literal text correctly, top-left positioned like a step badge. Its default pill is solid black, not `step`'s purple/white-ring style, so use `label` for EVERY step in an article (not just the broken ones) to keep a consistent look. Also: for a full-bleed capture, a highlight box's edge nearest a canvas/page corner (e.g. near a logo) can render clipped-looking even when props look right and the box's far edge is correctly placed — the canvas padding/scaling affects edges unevenly near corners; if only the near edge looks wrong, nudge it outward ~60-80px, not ~10-20px.

- **2026-08-30** — 2026-08-30 — Manual pixel-coordinate estimates from viewing a PNG are unreliable, even carefully: fixing "highlight lệch" I first extended a search-box highlight's left edge from x=700 to x=605 to stop it looking short, which actually pushed it INTO the neighboring "WikipediA" wordmark — invisible until the re-render was viewed. Separately, a title's real bbox was misjudged by ~170px. Rule: treat any manually-estimated x/y as a draft; after rendering, specifically check the highlight border against the target's real edges for overshoot into a NEIGHBORING element, not just undershoot, and expect 2-3 render/view iterations, not one. Also: a task prompt claiming "no job.json" can be stale — try `snap_job` first regardless; it returned real, useful ground-truth coordinates here.

- **2026-08-30** — 2026-08-30 — how-to-search-wikipedia steps 1-2 (Wikipedia main page, capture 2560x1249, Vector 2022 skin): job.json existed despite the revise-job prompt's metadata claiming "flat single-file, no job.json" — per the 2026-08-30 learning, always try snap_job first regardless of what the task description says. The highlight box around the search input was too wide on the left (x=705,w=320), spilling into the "WikipediA" logo/wordmark to its left instead of framing just the input; the right edge (705+320=1025) happened to be correct. Fix: x=790,y=10,w=245,h=34 tightly frames just the search `<input>` (magnifier icon + placeholder/typed text), excluding both the logo on the left and the separate "Search" button on the right. Rule: when a highlight "looks close but shifted", check whether it's actually bracketing a wider region than the real target (input-only vs input+button, or target+neighboring element) rather than assuming a uniform x/y translation — the right edge here was already right, only the left edge needed to move ~85px.

- **2026-08-30** — 2026-08-30 — textbox component (mode:"note") ignores any prop named text/note/title/heading for its content — only `body` is respected for the message; the header title is hard-coded to "Tip" and cannot be overridden by any prop name tried (title, heading). Same class of bug as the step-marker's fixed "Step 1" numeral (2026-08-30 learning). WORKAROUND: just write the note's message via props.body and accept the English "Tip" header even in a non-English article — don't burn more than 1-2 prop-name guesses on the header text next time.

- **2026-08-30** — 2026-08-30 — job.json steps[].els items must nest all annotation fields under a "props" key ({type, props:{x,y,...}}), matching snap_add's own {type, props} shape. Writing them flat ({type, x, y, text, ...} as siblings, no props wrapper) is silently accepted by snap_job/snap_render_job with no error, but the renderer then ignores every field and falls back to each component's hardcoded demo defaults (blur/highlight/zoom disappear entirely, textbox/label/step render the canned "Step 1 / Open Settings / Click the icon..." sample copy instead of your text) — a full 3-image article rendered wrong silently until the PNGs were actually viewed. Always nest under props when hand-building job.json (snap_job read of a working job confirms the shape); re-render and snap_view immediately after the first write to catch this class of silent-default bug before iterating on placement.
