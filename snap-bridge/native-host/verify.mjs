#!/usr/bin/env node
/* verify.mjs — kiểm tra native messaging host đã cài đúng chưa, trên cả ba nền.
   Chạy: node snap-bridge/native-host/verify.mjs

   Vì sao cần file này: khi native messaging hỏng, Chrome không nói gì cả — nút
   "Start bridge" chỉ báo "host not found" mà không phân biệt được là chưa cài,
   manifest trỏ sai chỗ, shim mất quyền chạy, hay repo đã bị chuyển thư mục
   (đổi luôn ID extension). Mỗi nguyên nhân một cách sửa khác nhau. File này đi
   hết chuỗi đó theo đúng thứ tự Chrome đi, và nói rõ hỏng ở mắt nào.

   Kiểm tra cuối cùng là bắt tay thật: khởi chạy chính cái shim đã cài, nói đúng
   giao thức framing của Chrome, đọc lời đáp. Đó là thứ duy nhất chứng minh
   đường dẫn node trong shim còn dùng được. */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, accessSync, constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.snapstudio.bridge";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOST_SCRIPT = path.join(__dirname, "snap-bridge-host.mjs");
const PORT = Number(process.env.SNAP_BRIDGE_PORT || 8788);

let failed = 0;
const ok = (label, detail) => console.log(`[ok]   ${label.padEnd(10)} ${detail}`);
const bad = (label, detail) => { failed++; console.log(`[LỖI] ${label.padEnd(10)} ${detail}`); };
const warn = (label, detail) => console.log(`[?]    ${label.padEnd(10)} ${detail}`);

/** Nơi Chrome tìm manifest, theo nền tảng. Trên Windows là một khoá registry
 *  trỏ tới file bất kỳ; trên mac/Linux là một thư mục cố định phải chứa file. */
function browserHomes() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    return [
      { name: "Chrome", home: path.join(base, "Google", "Chrome") },
      { name: "Edge", home: path.join(base, "Microsoft Edge") },
      { name: "Chromium", home: path.join(base, "Chromium") },
    ];
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      { name: "Chrome", home: path.join(base, "Google", "Chrome", "User Data"), reg: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts" },
      { name: "Edge", home: path.join(base, "Microsoft", "Edge", "User Data"), reg: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts" },
    ];
  }
  return [
    { name: "Chrome", home: path.join(home, ".config", "google-chrome") },
    { name: "Edge", home: path.join(home, ".config", "microsoft-edge") },
    { name: "Chromium", home: path.join(home, ".config", "chromium") },
  ];
}

/** Đường dẫn manifest Chrome sẽ thực sự đọc — qua registry trên Windows, qua
 *  thư mục NativeMessagingHosts trên mac/Linux. */
function manifestPathFor(browser) {
  if (browser.reg) {
    try {
      const out = execFileSync("reg", ["query", `${browser.reg}\\${HOST_NAME}`, "/ve"], { encoding: "utf8" });
      const m = /REG_SZ\s+(.+)/.exec(out);
      return m ? m[1].trim() : null;
    } catch { return null; }
  }
  const p = path.join(browser.home, "NativeMessagingHosts", `${HOST_NAME}.json`);
  return existsSync(p) ? p : null;
}

/** ID mà extension unpacked ĐANG có trong hồ sơ này. Sinh theo đường dẫn nạp,
 *  nên chuyển thư mục repo là đổi ID — và manifest cũ lập tức vô dụng dù mọi
 *  file vẫn còn nguyên chỗ cũ. Đây là cái bẫy verify này tồn tại để bắt. */
function liveExtensionId(browserHome) {
  if (!existsSync(browserHome)) return null;
  const norm = (p) => p.replace(/[/\\]+$/, "").toLowerCase();
  const want = norm(REPO_ROOT);
  let profiles;
  try {
    profiles = readdirSync(browserHome, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name === "Default" || d.name.startsWith("Profile")))
      .map((d) => path.join(browserHome, d.name));
  } catch { return null; }
  for (const prof of profiles) {
    for (const file of ["Secure Preferences", "Preferences"]) {
      const p = path.join(prof, file);
      if (!existsSync(p)) continue;
      let json;
      try { json = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
      const settings = json?.extensions?.settings;
      if (!settings) continue;
      for (const [id, ext] of Object.entries(settings)) {
        if (ext && typeof ext.path === "string" && norm(ext.path) === want) return id;
      }
    }
  }
  return null;
}

/** Bắt tay thật với shim đã cài, đúng cách Chrome làm: 4 byte độ dài
 *  little-endian + JSON UTF-8, một lượt đi một lượt về. */
function handshake(shimPath) {
  return new Promise((resolve) => {
    const child = process.platform === "win32"
      ? spawn("cmd.exe", ["/c", shimPath, `chrome-extension://verify/`, "--parent-window=0"], { stdio: ["pipe", "pipe", "ignore"] })
      : spawn(shimPath, [`chrome-extension://verify/`], { stdio: ["pipe", "pipe", "ignore"] });
    const body = Buffer.from(JSON.stringify({ cmd: "status" }), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ error: "quá 15s không trả lời" }); }, 15000);
    child.on("error", (e) => { clearTimeout(timer); resolve({ error: e.message }); });
    child.stdout.on("data", (c) => { buf = Buffer.concat([buf, c]); });
    child.on("close", () => {
      clearTimeout(timer);
      if (buf.length < 4) return resolve({ error: "không có khung trả lời nào" });
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return resolve({ error: "khung trả lời bị cụt" });
      let reply;
      try { reply = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")); }
      catch (e) { return resolve({ error: "JSON hỏng: " + e.message }); }
      resolve({ reply, trailing: buf.length - 4 - len });
    });
    try { child.stdin.write(Buffer.concat([head, body])); } catch {}
  });
}

function portUp() {
  return new Promise((resolve) => {
    const sock = net.connect({ port: PORT, host: "127.0.0.1" });
    const done = (up) => { try { sock.destroy(); } catch {} resolve(up); };
    sock.setTimeout(800);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

// ---------------------------------------------------------------------------
console.log(`Snap Studio native host — kiểm tra trên ${process.platform}`);
console.log(`repo: ${REPO_ROOT}\n`);

if (existsSync(HOST_SCRIPT)) ok("host", HOST_SCRIPT);
else bad("host", `thiếu ${HOST_SCRIPT} — repo bị cắt xén?`);

const homes = browserHomes();
const registered = homes.map((b) => ({ b, manifest: manifestPathFor(b) })).filter((r) => r.manifest);

if (!registered.length) {
  bad("manifest", `chưa đăng ký với trình duyệt nào — chạy ${process.platform === "win32" ? "install.ps1" : "./install.sh"} trước`);
} else {
  let shimForHandshake = null;
  for (const { b, manifest } of registered) {
    if (!existsSync(manifest)) { bad("manifest", `${b.name}: trỏ tới ${manifest} nhưng file không tồn tại — chạy lại bộ cài`); continue; }
    let mf;
    try { mf = JSON.parse(readFileSync(manifest, "utf8")); }
    catch (e) { bad("manifest", `${b.name}: JSON hỏng (${e.message})`); continue; }
    ok("manifest", `${b.name}: ${manifest}`);

    const shim = mf.path;
    if (!shim || !existsSync(shim)) {
      bad("shim", `${b.name}: manifest trỏ tới ${shim || "(trống)"} nhưng không tồn tại — repo đã bị chuyển? chạy lại bộ cài`);
    } else {
      if (process.platform !== "win32") {
        try { accessSync(shim, constants.X_OK); }
        catch { bad("shim", `${shim} thiếu quyền chạy — chmod +x, hoặc chạy lại ./install.sh`); }
      }
      ok("shim", shim);
      shimForHandshake = shimForHandshake || shim;
    }

    const origins = Array.isArray(mf.allowed_origins) ? mf.allowed_origins : [];
    const live = liveExtensionId(b.home);
    if (!live) {
      warn("id", `${b.name}: không thấy extension nạp unpacked từ repo này (chưa nạp, hoặc hồ sơ khác) — bỏ qua đối chiếu`);
    } else if (origins.some((o) => o.includes(live))) {
      ok("id", `${b.name}: ${live} khớp allowed_origins`);
    } else {
      bad("id", `${b.name}: extension đang là ${live} nhưng manifest chỉ cho phép ${origins.join(", ") || "(rỗng)"} — repo đã chuyển thư mục, chạy lại bộ cài`);
    }
  }

  if (shimForHandshake) {
    const res = await handshake(shimForHandshake);
    if (res.error) {
      bad("bắt tay", `${res.error} — thường là đường dẫn node trong shim đã sai; chạy lại bộ cài`);
    } else if (!res.reply || res.reply.ok !== true) {
      bad("bắt tay", `host trả lời nhưng không ok: ${JSON.stringify(res.reply)}`);
    } else if (res.trailing !== 0) {
      bad("bắt tay", `có ${res.trailing} byte thừa sau khung — thứ gì đó in ra stdout và làm hỏng giao thức`);
    } else {
      ok("bắt tay", `${JSON.stringify(res.reply)}`);
    }
  }
}

const up = await portUp();
console.log("");
if (up) console.log(`[ok]   bridge     đang chạy trên 127.0.0.1:${PORT}`);
else console.log(`[i]    bridge     chưa chạy — bình thường; bấm "Start bridge" trong tab KB, hoặc: cd snap-bridge && npm start`);

console.log("");
if (failed) {
  console.log(`${failed} vấn đề cần sửa (xem dòng [LỖI] ở trên).`);
  process.exit(1);
}
console.log("Tất cả đạt. Nếu nút vẫn báo lỗi: reload Snap Studio ở chrome://extensions —");
console.log("quyền nativeMessaging chỉ được cấp khi nạp lại extension.");
