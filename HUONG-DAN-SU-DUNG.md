# Hướng dẫn sử dụng Snap Studio

Tài liệu này hướng dẫn cách **dùng** Snap Studio (chụp — chú thích — xuất ảnh). Muốn biết kiến
trúc kỹ thuật, giới hạn của bản V1, hay cách hệ thống token/CSS hoạt động, xem [README.md](README.md).

## 1. Snap Studio là gì

Một tiện ích mở rộng Chrome giúp chụp nhanh một trang, chú thích lên ảnh (đánh số bước, khoanh
vùng, mũi tên, che thông tin nhạy cảm...) rồi sao chép/xuất ảnh để dán vào ticket hoặc tài liệu.
Mỗi lần chỉ làm việc với **một ảnh** — chưa có thư viện lưu trữ nhiều ảnh (xem mục 12).

## 2. Cài đặt

1. Mở `chrome://extensions`.
2. Bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked**, chọn thư mục gốc của repo này.
4. Icon Snap Studio xuất hiện trên thanh công cụ Chrome.

> Vì chưa đóng gói (unpacked), font tải từ Google Fonts — chỉ hoạt động ở chế độ dev, không phải
> bản đóng gói cuối cùng.

## 3. Chụp màn hình

Bấm icon Snap Studio trên toolbar để mở popup, có 2 lựa chọn:

| Nút | Chức năng | Phím tắt |
|---|---|---|
| 📸 Snap visible tab | Chụp toàn bộ phần đang hiển thị của tab | `Alt+Shift+S` |
| ▭ Snap a region… | Kéo chọn một vùng trên trang để chụp | `Alt+Shift+R` |

Chụp xong, một tab **Snap Studio** (editor) tự mở với ảnh đã chụp sẵn trên canvas.

Đang kéo chọn vùng mà muốn hủy → nhấn `Esc`.

## 4. Làm quen giao diện editor

- **Thanh trên (topbar)**: 2 tab **Snap** (đang chú thích ảnh) và **Components** (xem/tạo
  component, mục 10), 2 công tắc **Image frame** / **Context stamp** (mục 8), và các nút
  **⧉ Copy image** / **⬇ Export PNG** (mục 9).
- **Cột trái**: hộp công cụ chú thích (**Components**), rồi đến **Yours** (component tự tạo ở tab
  Lab), cuối cùng là **Layers** — danh sách các lớp đang có trên ảnh.
- **Giữa**: canvas — nơi ảnh và các chú thích hiển thị, kéo/thả/resize trực tiếp tại đây.
- **Phải**: bảng **Properties** của phần tử đang chọn (sửa chữ, màu, kích thước, biến thể...).

## 5. Các công cụ chú thích

Bấm một nút trong cột trái để thả component vào giữa canvas, sau đó kéo vào đúng vị trí và chỉnh
trong bảng Properties bên phải.

| Công cụ | Dùng khi nào |
|---|---|
| ① **Step Marker** | Đánh số một bước trên ảnh cần tự giải thích được (không có bài viết đi kèm). Có biến thể `--compact` (số trần) khi ảnh đã nằm cạnh văn bản step-by-step riêng, và `--video` cho khung hình video. |
| 💬 **Text / Explanation Box** | Thẻ giải thích bằng chữ đặt ngay trên ảnh. Chế độ `step` gắn kèm badge số bước; chế độ `note` dùng cho một mẹo/lưu ý không gắn với bước nào. Không dùng cả step-marker rời **và** text-box chế độ step cho cùng một bước — bị trùng nhãn. |
| ⬚ **Highlight Box** | Khoanh vùng để thu hút chú ý. Mặc định viền (bordered) khi đã có mũi tên/step-marker chỉ vào cùng vùng đó; chỉ dùng biến thể `--shaded` (tô nền) khi ô này phải tự gánh toàn bộ sự chú ý, không có gì khác trỏ vào. Vùng có chữ/chi tiết nhỏ luôn dùng bordered — shaded làm giảm tương phản chữ. |
| ◎ **Spotlight** | Làm tối cả khung hình, chỉ chừa một vùng sáng — dùng cho một khoảnh khắc "bấm vào đây" duy nhất, không có gì khác cạnh tranh sự chú ý. |
| 🔍 **Zoom / Magnify** | Phóng to tại chỗ một chi tiết quá nhỏ để đọc (nút, toggle, chữ nhỏ). Luôn là hình chữ nhật bo góc, không phải kính lúp tròn. |
| ▒ **Privacy Blur** | Làm mờ dữ liệu nhạy cảm (email, tên, API key, đơn hàng...) trước khi ảnh được công khai. Chỉ dùng để che thông tin — không dùng thay cho highlight/spotlight để nhấn mạnh. Cần đặt đè khít lên đúng vùng cần che, đặt lệch ra ngoài sẽ không che được gì. |
| ↗ **Arrow** | Trỏ từ một nhãn/chú thích đến đúng phần tử nó mô tả. Dùng biến thể gấp khúc (elbow) khi hai điểm neo thẳng hàng theo trục; dùng đường cong mặc định khi không thẳng hàng. Cách thả: bấm nút rồi **kéo-thả** trực tiếp trên canvas từ điểm bắt đầu đến điểm kết thúc (không phải bấm một chỗ). |
| 🏷️ **Label** *(ngoài bộ kit gốc)* | Nhãn nhỏ tự do — cũng là loại phần tử dùng cho **Context stamp** (mục 8). |

Ngoài ra còn **Screenshot Presentation** (nền đệm + khung bo góc quanh toàn bộ ảnh) — đây **không**
phải nút thả trong cột trái, mà là công tắc **Image frame** trên topbar (mục 8).

## 6. Layers (lớp)

- Danh sách bên trái, theo đúng thứ tự vẽ: **Base image** (ảnh gốc) luôn ở đầu — chọn được nhưng
  không xoá được, vì nó quyết định khung ảnh khi xuất.
- Bấm một dòng để chọn phần tử đó trên canvas; bấm ✕ ở cuối dòng để xoá.
- Chưa hỗ trợ kéo-thả đổi thứ tự lớp nói chung. Riêng các lớp **ảnh dán thêm** (mục 7) có nút đẩy
  lên/xuống trong bảng Properties, nhưng luôn nằm dưới mọi chú thích — để một ảnh dán sau không
  đè mất text-box/highlight đã đặt trước đó.
- Muốn chụp lại từ đầu: dùng **Replace base image…** trong Properties của Base image, thay vì xoá.

## 7. Dán ảnh vào canvas

`Ctrl+V` dán bất kỳ ảnh nào đang có trong clipboard (ảnh từ Snipping Tool, ảnh khách gửi, ảnh copy
từ ứng dụng khác...):

- Nếu canvas đang trống → ảnh dán vào trở thành **ảnh nền** (base image).
- Nếu canvas đã có ảnh → mỗi lần dán thêm **một lớp ảnh mới**, kéo/resize được (khoá tỉ lệ), xếp
  chồng lên nhau — dùng để ghép ảnh trước/sau, hoặc đặt một chi tiết phóng to bên cạnh ảnh toàn
  trang. Dán không bao giờ thay thế ảnh cũ.

## 8. Hai công tắc trên topbar

| Công tắc | Ý nghĩa |
|---|---|
| **Image frame** | Bật/tắt nền đệm + khung bo góc quanh toàn bộ ảnh xuất ra (component Screenshot Presentation). Bật sẵn theo mặc định. |
| **Context stamp** | Bật/tắt nhãn nhỏ đóng dấu trình duyệt / hệ điều hành / URL / thời gian lên góc ảnh. |

## 9. Xuất / sao chép kết quả

Chỉ xuất **PNG**. Trước khi xuất, ẩn hết khung/panel của editor rồi chụp lại đúng tab đó (không
phải vẽ lại canvas) — vì hiệu ứng kính mờ (`backdrop-filter`) của Zoom/Magnify, Privacy Blur...
không thể "vẽ lại" qua canvas thông thường.

| Nút | Kết quả | Phím tắt |
|---|---|---|
| ⧉ Copy image | Chép ảnh đã chú thích vào clipboard, dán thẳng vào ticket/chat | `Ctrl+C` (khi đang focus vào canvas) |
| ⬇ Export PNG | Tải file `snap-<domain>-<ngày>-<giờ>.png` về máy | — |

**Lưu ý quan trọng**: `captureVisibleTab` chỉ chụp được đúng phần đang thực sự hiển thị trong cửa
sổ trình duyệt. Nếu ảnh gốc lớn hơn cửa sổ hiện tại, phần xuất ra sẽ bị cắt bớt (có toast báo) —
phóng to cửa sổ rồi xuất lại.

## 10. Tab Components (xem & tạo component riêng)

Tab **Components** trên topbar cho xem trước toàn bộ component của kit trên nền sáng, nền tối,
hoặc chính ảnh bạn vừa chụp — không phải nơi để chú thích ảnh thật.

**+ New component** không phải viết CSS tự do ngay trong ứng dụng: quy trình là

1. Copy sẵn một prompt có trong tab (đã soạn sẵn cấu trúc yêu cầu).
2. Dán prompt đó vào một phiên Claude riêng, mô tả component bạn muốn.
3. Nhận lại một file `.md` theo đúng khuôn mẫu, rồi tải (upload) file đó vào tab Components.
4. Sau khi tạo, có thể sửa tay phần CSS thô trong ô textarea — có cảnh báo (lint) ngay khi gõ nếu
   dùng màu/khoảng cách/bo góc/cỡ chữ viết cứng (hardcode) thay vì token thiết kế.

Component tạo ra xuất hiện trong cột trái ở mục **Yours**, thả lên ảnh như mọi công cụ khác.
Tính năng này dành cho người quen CSS và bộ token thiết kế (vd. kỹ sư hỗ trợ kỹ thuật), không phải
để người dùng thông thường viết CSS ngẫu hứng.

## 11. Tổng hợp phím tắt

| Phím | Tác dụng |
|---|---|
| `Alt+Shift+S` | Chụp toàn bộ tab đang hiển thị |
| `Alt+Shift+R` | Chụp một vùng chọn |
| `Ctrl/Cmd+V` | Dán ảnh từ clipboard (ảnh nền hoặc lớp ảnh mới) |
| `Ctrl/Cmd+C` | Copy ảnh đã chú thích vào clipboard |
| `Backspace` / `Delete` | Xoá phần tử đang chọn |
| `Esc` | Huỷ khi đang kéo-thả mũi tên hoặc đang chọn vùng chụp |

## 12. Giới hạn hiện tại (bản V1)

- Không lưu lịch sử ảnh — chụp ảnh mới sẽ thay ảnh đang mở. Nhớ copy/export **trước** khi chụp
  ảnh tiếp theo.
- Không có tính năng gắn liên kết ticket/Slack.
- Không sửa chữ trực tiếp trên canvas — phải sửa trong bảng Properties bên phải.
- Tab Components chưa có quy trình duyệt/PR — component tự tạo chỉ tồn tại trong trình duyệt của
  bạn cho tới khi ai đó dán CSS thủ công vào `tokens.css`.

Chi tiết đầy đủ và lý do kỹ thuật của từng giới hạn: xem mục "What this is NOT (yet)" trong
[README.md](README.md).
