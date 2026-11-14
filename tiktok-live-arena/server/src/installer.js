import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';

const MOD_SOURCE = path.join(PROJECT_ROOT, 'gta-mod', 'TikTokArena.cs');

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const anyExists = (dir, names) => names.some((n) => exists(path.join(dir, n)));

// Inspect a GTA V folder and report what is installed.
export function checkGta(gtaPath) {
  const dir = String(gtaPath || '').trim().replace(/^"|"$/g, '');
  const checks = {
    path: dir,
    folder: !!dir && exists(dir),
    gtaExe: false,
    enhanced: false,
    scriptHookV: false,
    asiLoader: false,
    shvdn: false,
    scriptsFolder: false,
    modInstalled: false,
  };
  if (!checks.folder) return checks;
  checks.gtaExe = anyExists(dir, ['GTA5.exe', 'GTA5_Enhanced.exe']);
  checks.enhanced = exists(path.join(dir, 'GTA5_Enhanced.exe'));
  checks.scriptHookV = exists(path.join(dir, 'ScriptHookV.dll'));
  checks.asiLoader = anyExists(dir, ['dinput8.dll', 'xinput1_4.dll', 'version.dll']);
  checks.shvdn = anyExists(dir, ['ScriptHookVDotNet.asi', 'ScriptHookVDotNet3.dll']);
  checks.scriptsFolder = exists(path.join(dir, 'scripts'));
  checks.modInstalled = exists(path.join(dir, 'scripts', 'TikTokArena.cs'));
  return checks;
}

export function installMod(gtaPath, port) {
  const checks = checkGta(gtaPath);
  if (!checks.folder) throw new Error('התיקייה לא נמצאה');
  if (!checks.gtaExe) throw new Error('לא נמצא GTA5.exe בתיקייה הזו - בחר את התיקייה הראשית של המשחק');
  const scripts = path.join(checks.path, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(MOD_SOURCE, path.join(scripts, 'TikTokArena.cs'));
  writeModIni(checks.path, port);
  return checkGta(checks.path);
}

export function writeModIni(gtaPath, port) {
  if (!gtaPath) return false;
  const scripts = path.join(String(gtaPath).trim(), 'scripts');
  if (!exists(scripts)) return false;
  const ini = [
    '; TikTok Live Arena - written automatically by the local server',
    `ServerUrl=http://127.0.0.1:${port}`,
    'PollMs=100',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(scripts, 'TikTokArena.ini'), ini);
  return true;
}
