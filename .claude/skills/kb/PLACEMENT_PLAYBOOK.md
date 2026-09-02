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
`snap_kit`: `use_when` + `gotchas` từ `src/kit-catalog.js`, CỘNG với `anchor`,
danh sách prop thật và giá trị mặc định đọc thẳng ra từ `src/components/*.js`
(`snap-bridge/kit-introspect.js`). Gọi `snap_kit` để chọn component VÀ để tra tên
prop; đọc file này để đặt. Đừng chép lẫn nhau, và đừng đoán tên prop.

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
- Không truyền `props.x/y` → element rơi vào **tâm ảnh** (`centerXY()`, `src/surface.js`).
- **Cần đọc một toạ độ khỏi ảnh** → `snap_view({ path, grid: true })`, đừng ước lượng
  (PRINCIPLE #7 — ảnh bạn nhìn thấy đã bị thu nhỏ).

### Ngữ nghĩa x/y khác nhau theo từng type — bẫy thật, đã kiểm chứng trong code

> ⚠️ **Bảng này từng SAI về `step` và `label`** (ghi là "góc trên-trái" trong khi cả hai
> render qua `translate(-50%,-50%)`). Sửa ngày 2026-09-01. Nếu bạn nhớ luật cũ, quên đi.
> **Đừng tin trí nhớ ở mục này — gọi `snap_kit`**, nó đọc `anchor` + danh sách prop thật
> ra thẳng từ `style()`/`defaults()` của từng component (`snap-bridge/kit-introspect.js`),
> nên không thể lệch khỏi code như bảng dưới đã từng.

| Type | `x/y` nghĩa là gì | Kích thước mặc định (ở khung 1280px) |
|---|---|---|
| `textbox` | **góc trên-trái** (chiều cao tự co theo nội dung) | `w: 280` |
| `zoom` | **TÂM** (`src/components/zoom.js` `style()`) | `198 × 198`, `zoom: 2.2` |
| `step` | **TÂM** (`src/components/step.js:46`) | `90 × 28` |
| `label` | **TÂM** (`src/components/label.js`) | tự co theo chữ: rộng `7.2k × số ký tự + 28k`, cao `28k` |
| `highlight` / `spotlight` | góc trên-trái | `180 × 48` |
| `blur` | góc trên-trái | `180 × 32` |
| `arrow` | dùng `x1/y1/x2/y2`, **không** có `x/y` | — |

Nhầm `zoom` (tâm) với `textbox` (góc) làm lệch đúng **99px** — đủ để trông "gần đúng mà sai".
Nhầm `step` (tâm) thành góc thì pill 90px nằm lệch **45px sang trái**, tức đè lên đúng cái
control nó đang đánh số.

### Kích thước annotation TỰ CO theo bề rộng ảnh (từ 2026-09-01)

Kit được vẽ cho khung ~**1280px**. Trên ảnh rộng hơn, mọi phần "chrome" của component
(chiều cao pill, cỡ chữ, độ dày viền, ô mosaic của blur, độ đậm mũi tên) được nhân với

```
uiScale = clamp(round(img.w / 1280 * 4) / 4, 1, 3)
```

— `src/surface.js` `uiScale()`. Ảnh 2560 (viewport HiDPI, rất phổ biến) → **×2**.

Ba hệ quả bạn phải biết:

- **Không tự nhân toạ độ.** Chỉ chrome co giãn; `x/y/w/h` vẫn là pixel thật của ảnh.
- **Kích thước mặc định trong bảng trên là ở 1280.** Một `step` không truyền `w/h` trên ảnh
  2560 thật ra là `180 × 56`. Tính biên theo số đã nhân, không theo số trong bảng.
- **`snap_add` với `at` đã tự lo phần này** — nó đọc `uiScale` từ ảnh đang mở. Đây là một lý
  do nữa để dùng `at` thay vì gõ tay.

---

## PRINCIPLES (đọc trước khi đặt)

### −1. Đừng đoán toạ độ khi có element thật để neo. (hard rule)

`snap_add({ type, at: { selector, tabId } })` đọc hộp thật của element rồi tự lo **cả ba**
thứ hay sai: ngữ nghĩa `x/y` của type đó, `uiScale` của ảnh, và chọn phía còn chỗ trống.
`at` giờ neo được **cả `arrow`** (`side`, hoặc `toSelector` để nối hai element) — trước đây
arrow là type duy nhất buộc phải gõ tay, và đó là lý do mọi bài KB cũ đều có mũi tên dài
600px cắt ngang vùng trống rồi đâm vào giữa cái khung nó trỏ tới.

`at` nhận thêm: `side` (`left`/`right`/`top`/`bottom` — bỏ trống thì tự chọn phía **còn đủ
chỗ**, không phải mặc định cứng), `pad`, `gap`, `fromId` (riêng arrow: id của callout mà mũi
tên xuất phát), `length` (riêng arrow — **gần như không bao giờ cần**, xem #1b).

Chỉ gõ `props.x/y` khi thật sự không có element nào để neo (callout đặt giữa vùng trắng).
Khi đó: đọc bảng ngữ nghĩa `x/y` ở trên, và **đọc toạ độ bằng `snap_view({path, grid:true})`
chứ không ước lượng** — xem #7.

### 0. Không gì được tràn khỏi khung ảnh. (hard rule)

Callout, step marker, arrow, zoom — **không phần nào** được vượt quá mép ảnh. Một
component bị cắt là **lỗi hỏng**, không phải "chấp nhận được".

Tính biên từ kích thước thật của ảnh (W×H từ `snap_capture_tab`) trừ đi kích thước của
chính component — **đã nhân `uiScale`** (mục "Kích thước annotation tự co" ở trên; ảnh 2560
thì `k = 2`):

- `textbox` (w `280k`, cao ~`150k`): giữ `x ≤ W - 300k`, `y ≤ H - 220k`.
- `zoom` (`198k × 198k`, x/y là **tâm**): giữ `99k ≤ x ≤ W - 99k` và `99k ≤ y ≤ H - 99k`.
- `step` / `label` (`90k × 28k`, x/y là **tâm**): giữ `45k ≤ x ≤ W - 45k`, `14k ≤ y ≤ H - 14k`.

**Bạn không phải tự tính nữa — nhưng vẫn phải đọc.** `snap_add`, `snap_job` và
`snap_render_job` đều chạy kiểm tra hình học và trả về khối `WARNING:` khi có element tràn
mép, đè lên vùng nó trỏ tới, mũi tên đâm vào trong khung, hoặc prop không tồn tại. Cảnh báo
**không chặn** — nó vẫn render. Bỏ qua cảnh báo là tự chọn ship ảnh hỏng.

**Và vẫn phải kiểm chứng bằng mắt**: sau `snap_export`/`snap_render_job`, `Read` (hoặc
`snap_view`) file PNG vừa xuất. Máy bắt được "tràn mép" và "đè nhau"; nó **không** bắt được
"mũi tên trỏ vào chỗ trống", "che mất chữ quan trọng", "PII còn lộ". Không "chắc là ổn".

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

### 1b. Độ dài mũi tên là **hệ quả**, không phải con số bạn chọn. (từ 2026-09-02)

Mũi tên trong bài KB luôn nối **hai thứ đã có trên ảnh**: callout của bước đó
(`label`/`step`/`textbox`) và target nó trỏ tới. Khoảng cách giữa hai thứ đó là một **số đo**,
không phải thứ để gõ tay. Gõ tay thì sai cả hai chiều — và đã sai đúng như vậy trong **cùng
một bài đã ship**:

- **Dài quá** — đuôi gõ "quá mép pill một chút" thật ra nằm **trong** pill (pill của `label`
  tự co theo chữ; ở ảnh 2560 nó rộng gấp 2–3 lần cảm giác bằng mắt), nên thân mũi tên vẽ
  xuyên qua chính chữ của label. Hoặc callout bị đỗ ở một chỗ cố định trong máng trống và mũi
  tên phải kéo **540px = 21% bề ngang ảnh** mới với tới.
- **Ngắn quá** — đuôi gõ sát ngay cạnh pill: cả mũi tên chỉ 160px trong khi riêng **đầu mũi đã
  42px** (ảnh 2560, `scale` mặc định `1.5 × k` = 3). Nhìn ra một tam giác mập có cái cuống,
  không ra mũi tên.

**Cách làm đúng — đặt cặp callout + arrow trên cùng một target, để `at` tự tính:**

```
snap_add({ type: "label", at: { selector, tabId }, props: { text: "Bước 3: …" } })
snap_add({ type: "arrow", at: { selector, tabId } })     // đuôi tự bám vào label vừa đặt
```

Thứ tự nào cũng được: đặt `arrow` trước thì `label`/`step`/`textbox` sau đó rơi đúng vào **đuôi
mũi tên**. Kết quả cố định: đầu mũi dừng `14k` trước mép target, đuôi cách pill `14k`, thân dài
`4.5 × chiều dài đầu mũi` — và **mọi mũi tên trong bài dài bằng nhau**, dù chữ trong label dài
ngắn thế nào. (Vì vậy callout neo bằng `at` giờ đứng cách mép target đúng một mũi tên tối
thiểu, chứ không sát mép như trước.)

- Nhiều callout cùng một phía → chỉ đích danh bằng `at.fromId` (id `snap_add` trả về khi thêm
  callout đó).
- Không có callout nào phía sau → độ dài rơi về mặc định `150k`, **cắt theo chỗ trống thật**
  của phía đó nên không bao giờ tràn mép.
- `at.length` chỉ dùng khi không có callout để bám **và** độ dài tự tính vẫn sai. Gõ `length`
  chính là cách sinh ra hai lỗi ở trên.

Kiểm tra hình học (`snap_add` / `snap_job` / `snap_render_job`) giờ bắt cả bốn dạng: đuôi nằm
**trong** callout (báo kèm số `x1` đúng), thân **vẽ xuyên qua** callout, mũi tên ngắn hơn
`4.5 ×` đầu mũi, và mũi tên vượt **18% bề ngang ảnh** (dấu hiệu callout bị đỗ sai chỗ — sửa
callout, đừng sửa mũi tên).

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

**Và trước khi đoán tên prop lần thứ hai: gọi `snap_kit`.** Nó liệt kê chính xác prop nào
component đọc. Hai learning trong file này là "engine limitation" tự kết luận sau 1–2 lần
đoán sai tên prop — cả hai đều sai, xem phần ĐÍNH CHÍNH. Prop không tồn tại giờ được báo
thẳng trong kết quả `snap_add`/`snap_job`, không còn im lặng nữa.

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

**Neo `zoom` bằng `at`, đừng gõ tâm bằng tay.** `zoom` phóng vùng `w / magnification` pixel
quanh tâm nó. Gõ tâm lệch vài chục pixel là rơi vào **khoảng trắng giữa hai field**, và kết
quả không phải "hơi lệch" mà là **một ô kính trắng trơn** đè lên screenshot — trông như
render hỏng. `snap_add({ type:"zoom", at:{selector} })` canh tâm vào đúng element và chọn
kích thước đủ để có ngữ cảnh xung quanh.

Hai con số cần nhớ nếu vẫn phải gõ tay:

- **Độ phóng mặc định là `2.2×`** (trước đây là `1.1×` — dưới ngưỡng nhìn ra được, nó chỉ tạo
  một bản sao lệch pha của chính vùng bên dưới, đúng thứ trông "hỏng và xấu" trong các bài cũ).
- **Vùng nguồn = `w / 2.2`.** Muốn phóng một control rộng ~`X` pixel thì đặt `w ≈ 2.2 × X`.
  `w` quá nhỏ → crop quá bé → kính trắng. `snap_job`/`snap_add` cảnh báo khi crop xuống dưới
  ~72 CSS px, nhưng nó **không** biết vùng đó có nội dung hay không — cái đó chỉ nhìn ảnh mới
  thấy.

### 6. Che PII trước khi xuất. (hard rule cho bài công khai)

Ảnh chụp từ portal thật **luôn** chứa thứ không nên lên KB công khai: tên tài khoản, email,
tên cửa hàng, tên khách, số đơn thật. `blur` lên chúng **trước** `snap_export` — sau khi
export là quá muộn, file đã nằm trên đĩa.

Chủ động đề xuất blur; đừng chờ được nhắc. Nếu không chắc một vùng có phải PII không → hỏi
người dùng, đừng tự quyết là "chắc không sao".

**Dùng `job.globalEls`, không blur từng bước.** PII của một app luôn nằm **cùng một chỗ trên
mọi ảnh** — chip tài khoản góc phải trên, tên cửa hàng ở header. Đặt các `blur` đó **một lần**
vào `globalEls` ở cấp job:

```json
{ "title": "...", "slug": "...",
  "globalEls": [ { "type": "blur", "props": { "x": 2486, "y": 14, "w": 64, "h": 28 } } ],
  "steps": [ ... ] }
```

`snap_render_job` vẽ chúng **dưới** els của từng bước, trên **mọi** ảnh. KB Studio cũng hiện
chúng trong bản xem sống (khoá, không kéo được — chúng thuộc về job chứ không thuộc bước nào).
Đây là cách duy nhất chống lại kiểu lỗi "blur ở bước 1 rồi quên 7 bước còn lại".

Ngoại lệ: PII chỉ xuất hiện ở một ảnh (tên khách trong một đơn cụ thể) thì vẫn để trong
`steps[].els` của ảnh đó.

> **LEARNING 2026-08-28** — `kb/img/01-multibuy-offer-settings-annotated.png` lộ tên tài khoản
> thật `huynq-vl` ở thanh nav Shopify admin, không blur. `KB-BRIDGE.md` mục 5.4 đã cảnh báo
> trước rằng blur PII "chưa bắt buộc" trong lần dựng đầu — và đúng là nó đã lọt.
>
> **LEARNING 2026-09-01** — cùng một lỗi, quy mô lớn hơn: `multibuy-mix-match-combo` blur
> `huynq-vl` ở bước 1 và **để lộ ở 10 bước còn lại**. Không phải quên nguyên tắc — mà là nguyên
> tắc đòi lặp lại một thao tác thủ công 11 lần. Đó là lý do `globalEls` tồn tại.

### 7. Đọc toạ độ bằng lưới, đừng ước lượng bằng mắt. (hard rule)

Ảnh trả về cho bạn qua `snap_view`/`Read` **luôn bị thu nhỏ** cho vừa ngân sách ảnh (2560px
→ ~2000px hoặc nhỏ hơn). Một toạ độ ước lượng trên bản thu nhỏ sai đúng bằng hệ số đó —
thường 20–35%, đủ để "gần đúng mà sai" và không đủ để nhìn ra ngay.

Khi cần **đọc** một con số x/y khỏi ảnh (không phải chỉ đánh giá "trông ổn không"):

```
snap_view({ path: "img/03-foo.png", grid: true })
```

Lưới có nhãn, vẽ theo **pixel thật của ảnh**. Đọc số trên nhãn. Không nhân, không quy đổi.

Thứ tự ưu tiên vẫn là: `at` (không cần toạ độ) → `grid:true` (đọc số) → ước lượng (đừng).

## ĐÍNH CHÍNH — đọc trước phần LEARNINGS

`snap_learn` chỉ **thêm** được, không sửa được. Nên một learning sai sẽ nằm đó mãi và được
nạp vào system prompt của **mọi** job sau. Dưới đây là những cái đã được kiểm chứng lại và
xác định là sai. Bản ghi gốc vẫn giữ nguyên bên dưới (có gắn nhãn) để thấy được nó sai thế
nào — nhưng **luật thì lấy ở đây**.

### ✗ SAI — "`step` không set được số, dùng `label` cho mọi bước" (2026-08-30)

Đúng một nửa, kết luận sai. `step` thật sự **không có** prop `n`/`number` — số của nó là
**vị trí trong `capture.els`** (`src/surface.js` `stepNumber()`), nên một ảnh có đúng một
step marker thì luôn ra "Step 1". Đó là thiết kế, không phải bug.

**Nhưng cách đúng không phải là bỏ `step`.** Dùng `textbox`:

```json
{ "type": "textbox", "props": { "x": 300, "y": 240, "mode": "step",
    "customNumber": 4, "title": "Tier Settings", "body": "..." } }
```

`customNumber` ghi đè số tự động và render đúng "Step 4" (`src/components/textbox.js`,
`surface.js` `stepLabel()`). Cần đúng một pill số, không kèm chữ? `hideBody: true` +
`hideTitle: false`.

**Cái giá của learning sai này**: `multibuy-mix-match-combo` dùng `label` cho cả 11 bước.
`label` là pill **neutral-900 đặc**, không có vòng ring trắng và màu accent của step marker
— mà `kit-catalog.js` gọi vòng ring đó là *"load-bearing, not decorative"*: nó chính là thứ
giữ cho marker đọc được trên nền screenshot bất kỳ. Bài viết mất nó ở mọi bước.

### ✗ SAI — "`textbox` chỉ nhận `body`, header hard-code là 'Tip'" (2026-08-30)

Sai hoàn toàn. `textbox` có hai mode và **cả hai** đều đặt được tiêu đề:

- `mode: "step"` → `title` (chuỗi tự do) + badge "Step N" (`customNumber` để chỉ định số).
- `mode: "note"` → `label` (chuỗi tự do). `"Tip"` chỉ là **giá trị mặc định** của `label`,
  truyền `label: "Lưu ý"` là đổi được.

Cả hai còn có: `hideTitle`, `hideBody`, `compactBadge`, `border`, `borderWidth`, `fontSize`,
`w`. Learning cũ suy ra từ 1–2 lần đoán tên prop rồi kết luận là "engine limitation" —
đúng cái lỗi mà PRINCIPLE #3 cảnh báo.

**Cách tra cho chắc, thay vì đoán**: `snap_kit` giờ trả về **danh sách prop thật** của từng
component (đọc thẳng từ `defaults()` của nó) kèm `anchor` và giá trị mặc định. Prop nào không
có trong danh sách đó thì `snap_add`/`snap_job` sẽ cảnh báo là bị bỏ qua — không còn im lặng.

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

- **2026-08-30** — ⚠️ **SUPERSEDED — xem ĐÍNH CHÍNH ở trên. Kết luận "dùng `label` cho mọi bước" là SAI.** — 2026-08-30 — "step" (step-marker) component's number is NOT settable via any snap_add/job.json prop in this build. Tried n, number, index, step, label, text, variant:"compact" — always renders "Step 1", both via direct snap_add on a flat capture and via job.json steps[].n through snap_render_job. Confirmed engine limitation (12+ isolated tests, ruled out caching/stale-editor first per principle #3) — don't burn more than 2-3 prop-name guesses on this again. WORKAROUND: use type `label` instead, props:{x,y,text:"Step N"} — renders the literal text correctly, top-left positioned like a step badge. Its default pill is solid black, not `step`'s purple/white-ring style, so use `label` for EVERY step in an article (not just the broken ones) to keep a consistent look. Also: for a full-bleed capture, a highlight box's edge nearest a canvas/page corner (e.g. near a logo) can render clipped-looking even when props look right and the box's far edge is correctly placed — the canvas padding/scaling affects edges unevenly near corners; if only the near edge looks wrong, nudge it outward ~60-80px, not ~10-20px.

- **2026-08-30** — ⚠️ **Nguyên nhân gốc đã tìm ra 2026-09-01: ảnh trả về bị THU NHỎ trước khi tới bạn. Không phải "cẩn thận hơn" — dùng `snap_view({grid:true})`, xem PRINCIPLE #7.** — 2026-08-30 — Manual pixel-coordinate estimates from viewing a PNG are unreliable, even carefully: fixing "highlight lệch" I first extended a search-box highlight's left edge from x=700 to x=605 to stop it looking short, which actually pushed it INTO the neighboring "WikipediA" wordmark — invisible until the re-render was viewed. Separately, a title's real bbox was misjudged by ~170px. Rule: treat any manually-estimated x/y as a draft; after rendering, specifically check the highlight border against the target's real edges for overshoot into a NEIGHBORING element, not just undershoot, and expect 2-3 render/view iterations, not one. Also: a task prompt claiming "no job.json" can be stale — try `snap_job` first regardless; it returned real, useful ground-truth coordinates here.

- **2026-08-30** — 2026-08-30 — how-to-search-wikipedia steps 1-2 (Wikipedia main page, capture 2560x1249, Vector 2022 skin): job.json existed despite the revise-job prompt's metadata claiming "flat single-file, no job.json" — per the 2026-08-30 learning, always try snap_job first regardless of what the task description says. The highlight box around the search input was too wide on the left (x=705,w=320), spilling into the "WikipediA" logo/wordmark to its left instead of framing just the input; the right edge (705+320=1025) happened to be correct. Fix: x=790,y=10,w=245,h=34 tightly frames just the search `<input>` (magnifier icon + placeholder/typed text), excluding both the logo on the left and the separate "Search" button on the right. Rule: when a highlight "looks close but shifted", check whether it's actually bracketing a wider region than the real target (input-only vs input+button, or target+neighboring element) rather than assuming a uniform x/y translation — the right edge here was already right, only the left edge needed to move ~85px.

- **2026-08-30** — ⚠️ **SUPERSEDED — xem ĐÍNH CHÍNH ở trên. `title` (mode:"step") và `label` (mode:"note") ĐỀU hoạt động.** — 2026-08-30 — textbox component (mode:"note") ignores any prop named text/note/title/heading for its content — only `body` is respected for the message; the header title is hard-coded to "Tip" and cannot be overridden by any prop name tried (title, heading). Same class of bug as the step-marker's fixed "Step 1" numeral (2026-08-30 learning). WORKAROUND: just write the note's message via props.body and accept the English "Tip" header even in a non-English article — don't burn more than 1-2 prop-name guesses on the header text next time.

- **2026-08-30** — 2026-08-30 — job.json steps[].els items must nest all annotation fields under a "props" key ({type, props:{x,y,...}}), matching snap_add's own {type, props} shape. Writing them flat ({type, x, y, text, ...} as siblings, no props wrapper) is silently accepted by snap_job/snap_render_job with no error, but the renderer then ignores every field and falls back to each component's hardcoded demo defaults (blur/highlight/zoom disappear entirely, textbox/label/step render the canned "Step 1 / Open Settings / Click the icon..." sample copy instead of your text) — a full 3-image article rendered wrong silently until the PNGs were actually viewed. Always nest under props when hand-building job.json (snap_job read of a working job confirms the shape); re-render and snap_view immediately after the first write to catch this class of silent-default bug before iterating on placement.

- **2026-09-01** — 2026-09-01 — Nested cross-origin iframe (Shopify admin > embedded app, capture 2560x1249): a snap_frame_find `rect` copied straight into snap_add's manual x/y is WRONG for a NESTED iframe (boxes landed hundreds of px off) — always use `at:{selector,tabId,frameId}` there instead. For a TOP-LEVEL (non-nested) page, e.g. the plain storefront product page, frame rect DOES equal canvas coords 1:1 — the transform only exists once you're inside a nested iframe.

- **2026-09-01** — 2026-09-01 — `label` component's x/y acts as a RIGHT-edge anchor (text extends LEFTWARD from x), not left-edge/center. A small x for a long label ran it off canvas-left entirely (hard rule #0). Rule: for `label`, set x ≈ desired right edge, budget ~9-10px/char leftward for the string, and keep x large enough that x-minus-textwidth stays ≥0 (and clear of any sidebar).

- **2026-09-01** — 2026-09-01 — `zoom`'s props.x/y is BOTH the source-sample center AND the display position (true in-place magnifier), not two independent things. Overriding x/y to "relocate" the bubble away from its `at`-anchored element instead re-samples FROM the new (often empty) spot, producing a blank white zoom bubble. There's a `connector` prop for true relocation (schema unexplored). Safe default: leave zoom in-place; if that would cover important adjacent text, drop the zoom for that image rather than pass a naive x/y override.

- **2026-09-01** — 2026-09-01 — In one session, every hand-typed x/y/w/h (no `at`) rendered at a uniform ~0.78× the typed value with ~zero offset, confirmed via two far-apart calibration round-trips (snap_add → export → snap_view grid). Not uiScale (that only scales chrome, not position) and too big for canvas-padding — likely stale shared-editor state from a prior session's image size. Fix: before placing real annotations, calibrate empirically (place a test element, render, measure with grid, derive factor k), then type every coordinate as desired_pixel / k. The overflow WARNING checks raw typed values against frame size and will false-positive on a correctly-compensated element — trust snap_view, not the warning text, in this state. Also: current label/highlight render sizes for a given string are much larger than older reference images in this repo (~450px for a 30-char label on a 2560-wide capture) — when translating/recreating annotations on an existing article, budget much more open space per label than the original layout used.

- **2026-09-02** — 2026-09-02 — User feedback "components too big, don't let them overlap, prefer empty space" on an article using `label` pills for step callouts: `label` has no fontSize prop, so the only lever to shrink its rendered pill is shortening the text itself (e.g. "Step 2: Open the Quantity Break offer" → "Step 2: Open the offer" visibly shrank the pill). Also reduced `highlight` borderWidth 2.5→1.75 and `arrow` scale 1.5→1 for a lighter look. Separately found a real overlap bug: a label placed at real-pixel center (407,195) on a 2560-wide storefront capture overlapped the product photo (which started at x=565) — the fix was checking the actual photo/content bounding box before centering a callout in what looks like "empty" space to the left of it, not just checking it doesn't hit the sidebar/table like an admin screenshot. When shortening an existing label's text, double-check any arrow that pointed at a fixed absolute coordinate near the old pill's edge — it must be re-derived from the new (smaller) pill's actual edge, not reused, or it starts mid-air short of the pill or overshoots into the wrong target.

- **2026-09-02** — 2026-09-02 — dich-ngon-ngu-app-volume-discount steps 2-3: arrow tails hand-typed at what looked like "just past the label pill's right edge" (e.g. x1=607 for a label centered at x=492) actually landed WELL INSIDE the pill and rendered as a line drawn straight through the label's own text ("...choose a langu[arrow]age", "...default con[arrow]tent"). Cause: `label`'s pill auto-sizes to its text at 2x uiScale (2560-wide capture), so a 26-33 char string is ~500-700px wide even though it "looks" narrower when eyeballing the source screenshot mentally. Rule: never anchor an arrow tail near a `label`/`step`/`textbox` using a guessed offset from its center x/y — auto-sized components can be 2-3x wider than intuition suggests at 2x uiScale. Either (a) shorten the label text (cheapest, also shrinks the pill per the 2026-09-02 principle already in this file), or (b) give the tail a large, deliberately generous clearance (100px+) past the estimated edge, then render+snap_view and pull it back in if the gap looks too big — pulling back in is a safe correction, starting inside the pill is not.

- **2026-09-02** — 2026-09-02 — dich-ngon-ngu-app-volume-discount step 3: tried to fix a known "zoom at 1.1x looks broken/glitchy" case by bumping `zoom` from 1.1 to 1.8 while keeping the same w/h (280x76), expecting only a tighter, more-magnified in-place crop. Result was worse, not better: the rendered zoom bubble showed a garbled fragment (a stray letter and a couple of stray lines) instead of the intended "Item text" field — reverted to 1.1 and it rendered correctly again. Rule: changing a `zoom` component's `zoom` factor is not a safe math-only edit even with x/y/w/h untouched — it changes exactly which source pixels get sampled, and a bad combination can visibly corrupt the crop. Never change a zoom's magnification without immediately re-rendering and snap_view-ing the result before moving on; if it looks worse, revert rather than trying to "fix the fix" by further guessing, especially when the magnification wasn't what was actually asked for.

- **2026-09-02** — "component mũi tên khi gắn vào ảnh trong KB lúc thì dài quá, lúc thì ngắn quá". Nguyên nhân không phải người đặt cẩu thả mà là hai hằng số **không biết đến nhau**: `geometryFor` đặt `label`/`step` cách mép target `46k` tính tới **TÂM** pill, còn `arrowGeometry` luôn kéo đuôi ra `150k` — nên trên ảnh 2560, một label 23 ký tự (rộng 387px) trùm qua cả target lẫn toàn bộ thân mũi tên, còn mũi tên thì lúc xuyên qua chữ của label, lúc hụt lại giữa không trung. `label` lại **vô hình** với mọi kiểm tra hình học vì nó không có `w/h` trong props (`elBox` trả 0×0), nên không có cảnh báo nào. Sửa: (a) `elSize()` tính đúng pill của label từ chính CSS của `label.js` — font mono nên mỗi ký tự đúng `0.6em`, đối chiếu với renderer thật ở k = 1/1.5/2/2.5 khớp tới từng pixel; (b) callout neo bằng `at` giờ đo từ **mép gần** của pill và chừa sẵn chỗ cho một mũi tên tối thiểu; (c) độ dài mũi tên suy ra từ callout nó xuất phát (`chooseCompanion`), hoặc từ chỗ trống thật của phía đó, không còn hằng số; (d) callout đặt sau cũng tự rơi vào đuôi mũi tên đã có, nên thứ tự đặt không còn quan trọng; (e) `checkGeometry` thêm 4 cảnh báo về mũi tên. Luật rút ra: **độ dài mũi tên là hệ quả của vị trí hai đầu — nếu đang gõ một con số độ dài thì đang làm sai** (xem PRINCIPLE #1b).
