# Bỏ Chrome Bridge — kế hoạch chi tiết

- Lập: 2026-09-02
- Trạng thái: **kế hoạch, chưa triển khai**
- Ngữ cảnh trước đó: `KB-BRIDGE.md` mục "Lật lại: job dùng ĐÚNG tab người dùng…" và mục
  "Chạy thật rồi: adopt hoạt động…"

## 1. Quyết định đề xuất

Bỏ hẳn phụ thuộc vào Chrome Bridge trong pipeline KB, chuyển toàn bộ việc lái trình duyệt
sang extension Snap Studio + snap-bridge (`mcp__snap__*`).

Đây **không phải** "clone Chrome Bridge". Phần khó nhất đã nằm sẵn trong repo từ 2026-08-28,
đúng vì Chrome Bridge không làm nổi: điều khiển nội dung trong iframe cross-origin. Việc còn
lại là bịt bốn lỗ hổng nhỏ rồi rút dây.

## 2. Vì sao — ba lý do, không phải sở thích

**2.1. Với chính app này, Chrome Bridge đã hỏng ở phần quan trọng nhất.**
`KB-BRIDGE.md` mục "Điều khiển nội dung trong iframe cross-origin (2026-08-28)" ghi số đo
thật: app chạy trong iframe cross-origin (`bkv-embedded.qikify.com` trong `admin.shopify.com`),
`activeTab` của Chrome Bridge chỉ cấp host permission cho origin của **frame chính**. Kết quả:

- `mcp__chrome__scroll` cuộn 3000px → không đổi một pixel nào
- `mcp__chrome__find` → 0 match cho text đang hiện rõ trên màn hình

Ba tool cốt lõi để lái app — scroll, find, click — không dùng được. `snap_frame_*` sinh ra
chính vì thế. Snap Studio làm được vì manifest xin `<all_urls>`, không phải `activeTab`
(chú thích tại `src/bridge-worker.js:604-608` nêu đích danh cả ba tool, và nói rõ `target.frameIds` đi vòng được vì injection dựa trên host_permissions của chính extension).

**2.2. Toàn bộ vấn đề tab group là do Chrome Bridge, không phải do bài toán.**
`resolveTabInGroup()` trong extension Chrome Bridge từ chối mọi tab ngoài group của phiên.
Từ đó đẻ ra: tab tạm để group thành hình, `adopt_tabs`/`release_tabs`, việc dời tab thật của
người dùng trong thanh tab, và cả `jobTabClosed`. `mcp__snap__*` **vốn không bị ràng buộc
group** (chú thích tại `snap-bridge/kb-job.js:80-85`). Bỏ Chrome Bridge thì toàn bộ tầng này
biến mất, không phải sửa cho khéo hơn.

**2.3. Phụ thuộc vào một giao diện không có tài liệu.**
`chrome-bridge-config.js` phải mò `~/.claude.json` tìm url + token; `startJob()` chết cứng nếu
không thấy (`kb-job.js:264-265`); `extractTabId()` phải thử `JSON.parse` rồi rơi về regex vì
"hình dạng kết quả thật của Chrome Bridge không có tài liệu" (`KB-BRIDGE.md`). Cả ba đều là
chi phí trả cho một thành phần bên ngoài mà mình không kiểm soát phiên bản.

## 3. Hiện trạng — Chrome Bridge đang bám vào đâu

| Nơi | Nội dung |
|---|---|
| `snap-bridge/chrome-bridge-config.js` | toàn bộ file: tìm url/token trong `~/.claude.json` |
| `snap-bridge/kb-job.js:76-79` | `CHROME_SAFE_TOOLS` — 15 tool được pre-approve |
| `snap-bridge/kb-job.js:264-265` | `startJob` ném lỗi nếu không tìm thấy Bridge |
| `snap-bridge/kb-job.js:582-600` | `canUseTool`: chặn `new_tab`, soát origin cho `navigate` |
| `snap-bridge/kb-job.js:148-165` | system prompt: hướng dẫn navigate/tabId/tab tạm |
| `snap-bridge/kb-job.js:660-663` | `mcpServers.chrome` truyền vào stage capture |
| `snap-bridge/kb-job.js:1084-1098` | `describeToolUse` — nhãn log cho 15 tool |
| `snap-bridge/kb-job.js:961, 1109+` | `pendingNavigateIds` + `extractTabId()` |
| `src/bridge-worker.js` (khối adopt) | `cmdAdoptTabs`/`cmdReleaseTabs` — chỉ tồn tại vì group |
| `.claude/skills/kb/SKILL.md` | mục topology B, bảng tool |

Seam sạch: không có chỗ nào khác trong repo chạm tới Chrome Bridge.

## 4. Ánh xạ 15 tool → thay bằng gì

| Tool Chrome Bridge | Dùng được với app này? | Thay bằng |
|---|---|---|
| `scroll` | **Không** (đã đo, iframe) | `snap_frame_scroll` — **đã có** |
| `find` | **Không** (đã đo, iframe) | `snap_frame_find` — **đã có** |
| `click` | **Không** (cùng nguyên nhân) | `snap_frame_click` — **đã có** |
| `take_screenshot` | Có (tầng compositor) | `snap_capture_tab` (ghi file) — **đã có**; cần thêm bản inline để *nhìn* |
| `navigate` | Có | **cần thêm** `snap_navigate` |
| `fill` / `fill_form` / `type_text` | Không (iframe) | **cần thêm** `snap_frame_fill` |
| `press_key` | Không (iframe) | **cần thêm** `snap_frame_press` |
| `wait_for` | Một phần | `waitTabComplete()` đã có (`bridge-worker.js:532`); gộp vào `snap_navigate` |
| `list_tabs` | Có | **bỏ** — job đã được cho sẵn danh sách tab trong prompt |
| `switch_tab` | Có | **bỏ** — schema của chính nó nói không cần trước khi dùng tool khác |
| `close_tab` | Có | **bỏ** — chỉ dùng cho tab tạm, mà tab tạm biến mất |
| `resize_window` | Có | **hoãn** — thêm `snap_resize` chỉ khi thực tế cần chuẩn hoá bề ngang ảnh |
| `chrome_status` | Có | `snap_status` — **đã có** |
| `new_tab` | — | đang bị chặn sẵn, bỏ luôn |

**Ròng lại: thêm 4 tool, bỏ 15.**

## 5. Spec bốn tool mới

Bộ máy đã có, không phải dựng mới: `resolveFrameId(tabId, {frameId, frameUrlContains})` +
`execInFrame(tabId, fid, pageFn, arg)` → `chrome.scripting.executeScript({target:{tabId,
frameIds:[fid]}, func, args:[arg]})`. Ba tool frame hiện tại đều chỉ là `cmdFrameX` gọi
`execInFrame` với một page function. Ba trong bốn tool dưới đi đúng khuôn đó.

**5.1. `snap_navigate({ tabId, url })`** — tool duy nhất *không* theo khuôn frame.
`chrome.tabs.update(tabId, { url })` rồi `await waitTabComplete(tabId)`. Trả `{tabId, url,
title}`. Bắt buộc `tabId` — không có khái niệm "tab mặc định" nữa, đây là điểm mạnh chứ không
phải thiếu sót. Xem rủi ro 8.1 về SPA.

**5.2. `snap_frame_fill({ tabId, frameId|frameUrlContains, selector, value })`**
Page function `pageFill`: set `.value`, bắn `input` + `change` (bubbles) để framework nhận.
Gộp luôn `type_text` — với KB, đặt giá trị là đủ; cần gõ thật từng phím thì dùng `press`.

**5.3. `snap_frame_press({ tabId, frameId|frameUrlContains, key, selector? })`**
Page function `pagePress`: `KeyboardEvent` keydown/keyup trên `selector` (hoặc
`document.activeElement`). Đủ cho Enter/Escape/Tab — gần như toàn bộ nhu cầu thật.

**5.4. `snap_look({ tabId })`** — ảnh trả **inline**, không ghi file.
Dùng lại đúng đường `shootQuietly()` của `snap_capture_tab` nhưng trả data URL. Đây là thứ
thay `mcp__chrome__take_screenshot`, và nhắc lại ranh giới sẵn có: ảnh cho bài viết vẫn phải
đi qua `snap_capture_tab`.

## 6. Xoá những gì

- `snap-bridge/chrome-bridge-config.js` — cả file
- `cmdAdoptTabs` / `cmdReleaseTabs` / `adoptedTabs` / `TAB_GROUP_ID_NONE` trong
  `src/bridge-worker.js`, và hai lệnh `adopt_tabs`/`release_tabs` trong dispatch (~130 dòng)
- `snap-bridge/adopt-tabs.test.mjs` (23 assertion) — chết theo
- Trong `kb-job.js`: `CHROME_SAFE_TOOLS`, `extractTabId`, `pendingNavigateIds`, `onTabId`,
  `startAdoption`, `jobTabClosed`, `ctx.tabs`, `tabs.release()` ở `startJob`, và 15 case
  `mcp__chrome__*` trong `describeToolUse`
- Trong `server.js`: khối `tabs: { adopt, release }`

Đây là điểm đáng chú ý nhất của cả kế hoạch: **kết quả là ít code hơn hiện tại**, không phải
nhiều hơn.

## 7. Ranh giới an ninh sau khi bỏ

Hôm nay `canUseTool` mượn hàng rào group do Chrome Bridge cưỡng chế. Bỏ đi thì hàng rào là
của mình — và đó chính là whitelist `tabId` ở `KB-BRIDGE.md` mục 2 (2026-08-28), thứ **đã bị
bỏ vì lý do sai**: nó chết vì Chrome Bridge từ chối tab ngoài group, không phải vì bản thân
whitelist sai. Không còn Chrome Bridge thì nó đúng trở lại:

- mọi tool nhận `tabId` phải trúng một id trong `sessionTabs` của job; thiếu `tabId` → từ chối
- extension vẫn giao thêm với `kbSessionTabIds` — danh sách người dùng tự bấm `+`
- cổng origin cho `snap_navigate` giữ nguyên logic `originsOf(sessionTabs)` đang chạy

**Được thêm, không phải mất**: nhóm tool nguy hiểm (`javascript_eval`, `read_page`,
`get_page_text`, `read_network_requests`, `upload_file`) hiện đang phải *chặn* bằng
`canUseTool`; sau khi bỏ thì chúng **không tồn tại**. Bề mặt tấn công biến mất thay vì bị canh.

**Mất thật**: một lớp cưỡng chế độc lập do bên thứ ba giữ. Chấp nhận được, vì phần lớn công
việc của job (mọi `snap_*`) vốn đã nằm ngoài lớp đó rồi.

## 8. Rủi ro

**8.1. `snap_navigate` trên SPA — rủi ro thật duy nhất.**
Shopify admin là SPA: `tab.status === 'complete'` có thể bắn *trước* khi app nhúng render
xong, và điều hướng trong app có khi không đổi `status` chút nào. Đây là chỗ tốn công, không
phải số lượng tool.
*Giảm thiểu*: `snap_navigate` trả về sau `waitTabComplete`, rồi agent **xác nhận bằng
`snap_frame_find`** trước khi chụp — luật này đưa vào SKILL.md, không phải để agent tự đoán.
Nếu thực tế còn lệch thì thêm `snap_frame_wait({selector|text, timeoutMs})` theo đúng khuôn
`execInFrame` (polling trong frame) — đã dự trù, chưa làm ngay.

**8.2. Topology A đổi.** Người gõ `/kb` trong Claude Code lâu nay dùng `mcp__chrome__*` để
điều hướng. Sau khi bỏ, họ dùng `snap_navigate`. Phải sửa SKILL.md; không mất tính năng.

**8.3. Chrome Bridge vẫn hữu ích ngoài project.** Bỏ ở đây **không** gỡ cài đặt nó; phiên
Claude Code thường vẫn dùng nó để duyệt web bình thường.

**8.4. Có phiên khác đang sửa cùng file.** Tại thời điểm lập kế hoạch, `kb-job.js`,
`SKILL.md`, `server.js` đang có thay đổi chưa commit của một phiên khác (`kb-playbook.js`).
Phải đồng bộ trước khi bắt đầu GĐ 2.

## 9. Bốn giai đoạn, mỗi giai đoạn tự đứng được

**GĐ 1 — Thêm bốn tool (thuần bổ sung, không đổi hành vi).**
`snap_navigate`, `snap_frame_fill`, `snap_frame_press`, `snap_look`. Chrome Bridge vẫn nguyên
tại chỗ, job vẫn chạy như cũ. Test từng tool bằng tay trên tab thật.
*Xong khi*: bốn tool chạy được trên trang Shopify thật, kể cả trong iframe nhúng.

**GĐ 2 — Lật công tắc.**
Bỏ `chrome` khỏi `mcpServers` của stage capture; `canUseTool` chuyển sang whitelist `tabId`
theo `sessionTabs`; viết lại system prompt + `buildPrompt` (bỏ hết chuyện tab tạm/adopt); sửa
SKILL.md. Job giờ **chỉ** dùng `snap_*`.
*Xong khi*: một job KB thật dựng trọn bài, không mở tab nào mới, không dời tab nào.

**GĐ 3 — Xoá tầng adopt.**
Xoá theo danh sách mục 6. Chỉ làm sau khi GĐ 2 đã chạy thật xanh — đây là bước không quay lại
rẻ được, và giữ nó lại một vòng không tốn gì.

**GĐ 4 — Dọn tài liệu.**
`KB-BRIDGE.md`: mục mới khép lại toàn bộ câu chuyện tab group, giữ lại lịch sử (đừng xoá —
nó giải thích vì sao repo từng đi đường vòng). `SKILL.md`: bảng tool. `KB-SETUP.md`: bỏ bước
cài Chrome Bridge.

## 10. Test

- **GĐ 1**: mỗi tool một lần chạy tay trên tab thật, có iframe nhúng. Không viết unit test cho
  page function — chúng chạy trong DOM thật, fake DOM sẽ test cái mình tự bịa ra.
- **Logic thuần** (cổng `canUseTool` sau khi đổi sang whitelist): theo đúng khuôn
  `adopt-tabs.test.mjs` — vm + fake, chạy bằng `node`, không thêm dependency.
- **Nghiệm thu GĐ 2**: dựng lại một bài đã có (`quantity-break-overview`) và so ảnh xuất ra
  với bản cũ. Bài đã có là bộ test hồi quy tốt nhất đang có sẵn.

## 11. Rollback

GĐ 1 thuần bổ sung → không cần rollback. GĐ 2 là một commit lật công tắc → `git revert` là về
được, vì GĐ 3 (xoá) cố tình tách rời và làm sau. Sau GĐ 3 thì đường về là revert cả hai.

## 12. Chưa quyết — cần người quyết

1. **`snap_resize`**: có cần chuẩn hoá bề ngang cửa sổ trước khi chụp không? Hiện dùng
   `mcp__chrome__resize_window` bao nhiêu lần trong thực tế? Nếu ~0 thì bỏ luôn.
2. **`snap_frame_wait`**: làm ngay ở GĐ 1, hay chờ SPA cắn thật rồi mới thêm? Nghiêng về chờ —
   thêm sớm là đoán mò hình dạng vấn đề.
3. **Topology A có bỏ Chrome Bridge không**, hay chỉ topology B? Giữ cho topology A thì mất
   cái lợi "một đường duy nhất", nhưng người ngồi máy vẫn có thể thích 22 tool của Bridge.
