#!/usr/bin/env bash
# install.sh — đăng ký native messaging host của Snap Studio trên macOS/Linux,
# để nút "Start bridge" trong tab KB bật được snap-bridge/server.js.
#
# Bản song sinh của install.ps1 (Windows). Khác nhau đúng một chỗ, và đó là
# toàn bộ lý do phải có hai file:
#
#   Windows  — manifest nằm đâu cũng được, một khoá registry HKCU trỏ tới nó.
#   mac/Linux — không có registry; Chrome CHỈ quét một thư mục cố định
#               (NativeMessagingHosts) trong thư mục hồ sơ của từng trình
#               duyệt, nên manifest phải được ĐẶT VÀO đó.
#
# Giống nhau ở hai điểm quan trọng:
#   - Vẫn cần shim. Chrome khởi động từ Dock/Finder mang theo PATH tối thiểu
#     (/usr/bin:/bin:/usr/sbin:/sbin), không có /opt/homebrew/bin hay nvm —
#     nên `#!/usr/bin/env node` trong host sẽ không tìm thấy node. Shim nướng
#     cứng đường dẫn node vào.
#   - ID extension unpacked sinh theo ĐƯỜNG DẪN nạp, nên mỗi máy một khác.
#     Script tự dò ra từ hồ sơ Chrome; chạy lại sau khi chuyển thư mục repo.
#
# Dùng:
#   ./install.sh                      # cài
#   ./install.sh --uninstall          # gỡ
#   ./install.sh --node /path/to/node # chỉ định node khác
#   ./install.sh --extension-id <id>  # tự dò thất bại thì nhập tay
set -euo pipefail

HOST_NAME="com.snapstudio.bridge"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SHIM="$HERE/snap-bridge-host.sh"
HOST_SCRIPT="$HERE/snap-bridge-host.mjs"

NODE_BIN=""
EXT_ID_OVERRIDE=""
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    --node) NODE_BIN="${2:-}"; shift 2 ;;
    --extension-id) EXT_ID_OVERRIDE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "tham số lạ: $1 (xem --help)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- nền tảng
# Với cả hai nền, một thư mục hồ sơ trình duyệt vừa chứa các profile
# (Default, Profile 1, …) vừa chứa NativeMessagingHosts — nên một biến là đủ.
case "$(uname -s)" in
  Darwin)
    CHROME_HOME="$HOME/Library/Application Support/Google/Chrome"
    EDGE_HOME="$HOME/Library/Application Support/Microsoft Edge"
    CHROMIUM_HOME="$HOME/Library/Application Support/Chromium"
    ;;
  Linux)
    CHROME_HOME="$HOME/.config/google-chrome"
    EDGE_HOME="$HOME/.config/microsoft-edge"
    CHROMIUM_HOME="$HOME/.config/chromium"
    ;;
  *)
    echo "Nền tảng $(uname -s) không được hỗ trợ. Trên Windows dùng install.ps1." >&2
    exit 1
    ;;
esac
BROWSER_HOMES="$CHROME_HOME
$EDGE_HOME
$CHROMIUM_HOME"

# ------------------------------------------------------------------- gỡ
if [ "$UNINSTALL" = "1" ]; then
  while IFS= read -r home; do
    target="$home/NativeMessagingHosts/$HOST_NAME.json"
    if [ -f "$target" ]; then rm -f "$target"; echo "đã xoá $target"; fi
  done <<< "$BROWSER_HOMES"
  [ -f "$SHIM" ] && rm -f "$SHIM" && echo "đã xoá $SHIM"
  echo
  echo 'Đã gỡ. Nút "Start bridge" từ giờ sẽ báo chưa cài launcher.'
  exit 0
fi

# ------------------------------------------------------------------ node
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "Không tìm thấy node. Chạy lại với --node /đường/dẫn/tới/node" >&2
  exit 1
fi
[ -f "$HOST_SCRIPT" ] || { echo "thiếu host script: $HOST_SCRIPT" >&2; exit 1; }

# ----------------------------------------------------------- id extension
# Dò bằng node chứ không phải jq: node chắc chắn có (chính host cần nó), jq thì
# không. Extension unpacked được ghi trong "Secure Preferences" ở đa số bản
# Chrome và "Preferences" ở một số bản khác — đọc cả hai, mọi profile.
find_ext_id() {
  "$NODE_BIN" -e '
    const fs = require("fs"), path = require("path");
    const [userData, repoRoot] = process.argv.slice(1);
    if (!fs.existsSync(userData)) process.exit(0);
    const norm = (p) => p.replace(/[\/\\]+$/, "");
    const want = norm(repoRoot);
    let profiles = [];
    try {
      profiles = fs.readdirSync(userData, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (d.name === "Default" || d.name.startsWith("Profile")))
        .map((d) => path.join(userData, d.name));
    } catch { process.exit(0); }
    for (const prof of profiles) {
      for (const file of ["Secure Preferences", "Preferences"]) {
        const p = path.join(prof, file);
        if (!fs.existsSync(p)) continue;
        let json;
        try { json = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
        const settings = json && json.extensions && json.extensions.settings;
        if (!settings) continue;
        for (const [id, ext] of Object.entries(settings)) {
          if (ext && typeof ext.path === "string" && norm(ext.path) === want) {
            process.stdout.write(id);
            process.exit(0);
          }
        }
      }
    }
  ' "$1" "$REPO_ROOT"
}

IDS=""
if [ -n "$EXT_ID_OVERRIDE" ]; then
  IDS="$EXT_ID_OVERRIDE"
else
  while IFS= read -r home; do
    found="$(find_ext_id "$home")"
    if [ -n "$found" ]; then
      echo "tìm thấy Snap Studio trong $(basename "$home") với id $found"
      case "$IDS" in
        *"$found"*) ;;                                   # đã có, bỏ qua
        *) IDS="${IDS:+$IDS }$found" ;;
      esac
    fi
  done <<< "$BROWSER_HOMES"
fi

if [ -z "$IDS" ]; then
  cat >&2 <<ERR
Không tìm thấy hồ sơ trình duyệt nào đang nạp Snap Studio unpacked từ:
  $REPO_ROOT

Nạp extension trước (chrome://extensions -> Developer mode -> Load unpacked ->
chọn đúng thư mục đó), rồi chạy lại script này. Hoặc truyền thẳng ID hiện trên
trang đó:
  ./install.sh --extension-id <id>
ERR
  exit 1
fi

# --------------------------------------------------------------- ghi file
cat > "$SHIM" <<SHIMEOF
#!/bin/sh
# SINH TỰ ĐỘNG bởi snap-bridge/native-host/install.sh — chạy lại script đó sau
# khi chuyển thư mục repo hoặc đổi node. Chrome khởi động từ Dock không mang
# theo PATH có node, nên đường dẫn phải tuyệt đối ở đây.
exec "$NODE_BIN" "$HOST_SCRIPT" "\$@"
SHIMEOF
chmod +x "$SHIM"

# JSON sinh bằng node để id được escape đúng, thay vì nối chuỗi bằng tay.
MANIFEST_JSON="$("$NODE_BIN" -e '
  const [shim, ...ids] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    name: "com.snapstudio.bridge",
    description: "Starts the Snap Studio snap-bridge server on request from the Snap Studio extension.",
    path: shim,
    type: "stdio",
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  }, null, 2));
' "$SHIM" $IDS)"

# Không có registry: manifest phải nằm TRONG thư mục Chrome quét. Chỉ cài vào
# trình duyệt đã thật sự tồn tại trên máy — tạo thư mục hồ sơ cho một trình
# duyệt chưa cài là rác.
INSTALLED=0
while IFS= read -r home; do
  [ -d "$home" ] || continue
  dir="$home/NativeMessagingHosts"
  mkdir -p "$dir"
  printf '%s\n' "$MANIFEST_JSON" > "$dir/$HOST_NAME.json"
  echo "đã cài cho $(basename "$home") -> $dir/$HOST_NAME.json"
  INSTALLED=$((INSTALLED + 1))
done <<< "$BROWSER_HOMES"

if [ "$INSTALLED" = "0" ]; then
  echo "Không thấy thư mục hồ sơ của Chrome/Edge/Chromium nào trên máy này." >&2
  exit 1
fi

cat <<DONE

host script : $HOST_SCRIPT
shim        : $SHIM
node        : $NODE_BIN
extensions  : $IDS

Xong. Kiểm tra lại bằng:
  node "$HERE/verify.mjs"

Rồi reload Snap Studio ở chrome://extensions (quyền nativeMessaging chỉ được
cấp khi nạp lại), mở tab KB và bấm nút Start bridge.
DONE
