# Setup tab KB — đưa file này cho Claude trên máy bạn

Mở Claude Code ngay trong thư mục repo và dán:

> Đọc `KB-SETUP.md` rồi setup tab KB trên máy này giúp tôi.

File này viết để một agent đọc và làm theo được. Mỗi bước có lệnh, kết quả mong đợi, và
cách xử lý khi hỏng. Ba việc agent **không** làm được (Chrome không cho) đánh dấu 👤 — đó
là phần của con người.

Chỉ muốn chụp ảnh + chú thích thôi thì **không cần file này**: nạp extension (bước 1) là
xong, xem [README](README.md) mục "Try it". Toàn bộ phần còn lại chỉ phục vụ tab KB.

---

## Bối cảnh — vì sao setup không chỉ là "cài rồi chạy"

Tab KB không đọc thẳng thư mục `kb/`. Nó hỏi một tiến trình node rời tên **snap-bridge**
qua WebSocket `127.0.0.1:8788`. Tiến trình đó:

- không tự bật lại sau khi khởi động máy;
- không thể được extension bật lên trực tiếp (trang extension không spawn được tiến trình).

Nên có nút **▶ Start bridge** trong tab KB, đi vòng qua **Chrome native messaging** — đường
duy nhất Chrome cho phép một extension chạm tới OS. Bước 4 bên dưới là cài cái cầu đó.
Thiết kế đầy đủ nằm ở [KB-BRIDGE.md](KB-BRIDGE.md), không cần đọc để setup.

Hệ quả cần biết trước: **ID của extension unpacked sinh theo đường dẫn thư mục nạp nó**.
Chuyển repo sang chỗ khác là ID đổi, và phải chạy lại bước 4. Bộ cài tự dò ID, không phải
nhập tay.

---

## Bước 0 — tiền đề

```bash
node --version    # cần 18 trở lên
```

Chưa có node thì cài trước (macOS: `brew install node`; Windows: winget/nodejs.org).

## Bước 1 👤 — nạp extension

`chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn **thư mục gốc
repo** (thư mục chứa `manifest.json`).

Agent không làm được bước này, và bước 4 **phụ thuộc vào nó**: bộ cài dò ID extension từ
hồ sơ Chrome, chưa nạp thì chưa có gì để dò.

## Bước 2 — cài dependency

```bash
cd snap-bridge
npm install
```

Kéo luôn Chromium của Playwright ([render.mjs](snap-bridge/render.mjs) dùng nó để render ảnh
KB đã chú thích). Nếu mạng chặn phần tải trình duyệt:

```bash
npx playwright install chromium
```

## Bước 3 — Chrome Bridge phải được đăng ký

KB job mượn url/token của Chrome Bridge để lái trình duyệt — xem
[chrome-bridge-config.js](snap-bridge/chrome-bridge-config.js). Nó đọc `mcpServers.chrome`
ở **top level** của `~/.claude.json`. Kiểm tra:

```bash
node -e "const c=require(require('os').homedir()+'/.claude.json');console.log(c.mcpServers&&c.mcpServers.chrome?'OK':'CHUA CO')"
```

Ra `CHUA CO` thì cài Chrome Bridge trước (trong Claude Code: `/ccchrome`), đăng ký ở
`--scope user`. Bỏ qua bước này thì sáu tool `snap_*` vẫn chạy, nhưng **KB job sẽ không
start được** — server nói thẳng điều đó trong log lúc khởi động.

## Bước 4 — cài native messaging host

**macOS / Linux**

```bash
chmod +x snap-bridge/native-host/install.sh
./snap-bridge/native-host/install.sh
```

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File snap-bridge\native-host\install.ps1
```

Cả hai đều tự dò node và ID extension, rồi ghi ba thứ: shim (đường dẫn node tuyệt đối),
manifest, và chỗ đăng ký (registry `HKCU` trên Windows; thư mục `NativeMessagingHosts` của
trình duyệt trên mac/Linux — hai nền đó không có registry). Ba thứ này đều theo từng máy và
đã được gitignore.

Báo *"Không tìm thấy hồ sơ trình duyệt nào đang nạp Snap Studio unpacked"* → bước 1 chưa
xong, hoặc extension nạp từ thư mục khác. Nạp đúng thư mục rồi chạy lại, hoặc truyền ID
hiện trên `chrome://extensions`:

```bash
./snap-bridge/native-host/install.sh --extension-id <id>     # mac/Linux
# install.ps1 -ExtensionId <id>                              # Windows
```

## Bước 5 — kiểm tra

```bash
node snap-bridge/native-host/verify.mjs
```

Nó đi đúng chuỗi Chrome đi và bắt tay thật với shim đã cài (đây là thứ duy nhất chứng minh
đường dẫn node trong shim còn dùng được). Mong đợi:

```
[ok]   host       .../snap-bridge-host.mjs
[ok]   manifest   Chrome: ...
[ok]   shim       ...
[ok]   id         Chrome: <id> khớp allowed_origins
[ok]   bắt tay    {"ok":true,"running":false,"port":8788}
[i]    bridge     chưa chạy — bình thường; bấm "Start bridge" trong tab KB
```

`bridge chưa chạy` ở đây **không phải lỗi** — đó chính là việc của nút. Còn dòng `[LỖI]` nào
thì sửa theo đúng câu nó nói rồi chạy lại; thoát khác 0 nghĩa là chưa đạt.

## Bước 6 👤 — reload extension

`chrome://extensions` → nút reload trên thẻ Snap Studio.

**Bắt buộc.** Quyền `nativeMessaging` chỉ được cấp khi nạp lại, và service worker
([bridge-worker.js](src/bridge-worker.js)) cũng chỉ nạp code mới lúc đó. Bỏ qua bước này thì
nút sẽ báo *"the extension's background worker didn't answer — reload Snap Studio"*.

## Bước 7 👤 — bấm nút

Mở Snap Studio → tab **KB**. Bridge chưa chạy thì đầu rail Articles có panel vàng
*"snap-bridge isn't running"*. Bấm **▶ Start bridge** → khoảng một giây sau panel biến mất
và danh sách bài tự hiện.

Thích terminal hơn thì `cd snap-bridge && npm start` cũng ra kết quả y hệt.

---

## Xong rồi thì sao

Rail rỗng là **đúng**: `kb/` bị gitignore, bài viết không đi theo repo. Bấm **+ New job**,
viết instruction, thêm session tab để agent dựng bài đầu tiên — hoặc dùng skill `/kb` trong
Claude Code.

**Tuỳ chọn** — muốn Claude Code lái thẳng snap-bridge qua MCP thì đăng ký như
[KB-BRIDGE.md](KB-BRIDGE.md) mục "Đăng ký với Claude Code". Token nằm ở `snap-bridge/.token`,
**tự sinh trên từng máy** lúc server chạy lần đầu và bị gitignore — đừng chép token của máy
khác sang.

---

## Lỗi thường gặp

| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| Rail Articles trống, không có panel vàng | Bridge chạy nhưng `kb/` rỗng thật | Bình thường trên máy mới — tạo bài đầu tiên |
| Panel vàng, bấm nút báo *"launcher isn't registered"* | Chưa làm bước 4 | Chạy bộ cài, rồi reload extension |
| Bấm nút báo *"background worker didn't answer"* | Chưa reload sau khi cài | Bước 6 |
| `verify` báo `id ... không khớp allowed_origins` | Repo đã đổi thư mục → ID đổi | Chạy lại bộ cài, reload extension |
| `verify` báo lỗi ở dòng `bắt tay` | Đường dẫn node trong shim đã sai (gỡ/nâng cấp node, đổi nvm) | Chạy lại bộ cài |
| Bridge lên nhưng KB job không start | Bước 3 chưa xong | Đăng ký Chrome Bridge `--scope user` |
| Job chạy nhưng không xuất được ảnh | Thiếu Chromium của Playwright | `npx playwright install chromium` |

Bridge chết giữa chừng vì bất kỳ lý do gì: rail tự hiện lại panel vàng, và tự nạp lại danh
sách ngay khi bridge quay lại — không cần refresh trang.
