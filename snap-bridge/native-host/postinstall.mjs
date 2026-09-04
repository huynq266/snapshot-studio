#!/usr/bin/env node
// postinstall.mjs — runs install.ps1 (Windows) or install.sh (mac/Linux)
// automatically after `npm install`, so re-registering the native messaging
// host after a repo move or a fresh clone doesn't need a separate command.
//
// Best-effort only: on a fresh clone the extension usually isn't loaded into
// Chrome yet (KB-SETUP.md step 1, which is manual — Chrome requires a real
// click through the file picker), so the installer's "extension not found"
// exit is expected here, not a broken install. Never fail `npm install`
// over it — just print the manual command as a reminder.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';

const result = isWin
  ? spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'install.ps1')], { stdio: 'inherit' })
  : spawnSync('bash', [path.join(here, 'install.sh')], { stdio: 'inherit' });

if (result.error || result.status !== 0) {
  console.log('\n(native messaging host not registered — run this by hand once the extension is loaded, see KB-SETUP.md step 3:');
  console.log(isWin
    ? '  powershell -ExecutionPolicy Bypass -File snap-bridge\\native-host\\install.ps1'
    : '  ./snap-bridge/native-host/install.sh');
  console.log(')');
}

process.exit(0); // postinstall must never fail `npm install`
