import { stat } from 'node:fs/promises';
import { hedefAyaktaMi } from '../../kos/index.js';
import { basariliMetin, type KomutSonucu } from '../komut.js';
import { chromiumVarMi, komutVarMi } from './setup.js';
import { KobayDizini, adresKimligiGizle } from '../../depo/index.js';

/** Doctor satırı: `oneri` yalnız `ok: false` iken bulunur. */
export interface Kontrol {
  name: string;
  ok: boolean;
  hint?: string;
}

/** Chromium eksikse verilen öneri; kurulu makinede de sınanabilsin diye dışa açık. */
export const CHROMIUM_ONERISI = 'run `kobay install-browser` (Linux: `kobay install-browser --with-deps`)';

export function nodeSurumuYeterliMi(surum: string): boolean {
  const [ana = 0, alt = 0] = surum.split('.').map(Number);
  return ana > 22 || (ana === 22 && alt >= 12);
}

export const GIT_BASH_ONERISI =
  'optional: without Git Bash the claude CLI falls back to PowerShell for its shell tool;'
  + ' install Git for Windows (https://git-scm.com/downloads/win) if brain calls fail';

/** Env yolu Git Bash olabilir mi: bash.exe/sh.exe adı ve System32 (WSL) dışı; büyük/küçük harf duyarsız. */
function gitBashAdayiMi(yol: string): boolean {
  const norm = yol.replace(/\//g, '\\').toLowerCase();
  const ad = norm.slice(norm.lastIndexOf('\\') + 1);
  return (ad === 'bash.exe' || ad === 'sh.exe') && !norm.includes('\\windows\\system32\\');
}

/**
 * Windows'ta Git Bash denetimi (saf: platform, ortam ve dosya sorgusu enjekte).
 * Yalnız win32'de bir sonuç döner; başka platformda `null` (satır yok).
 * `C:\Windows\System32\bash.exe` WSL'dir, Git Bash değildir: PATH'te `bash`
 * aranmaz, yalnız `CLAUDE_CODE_GIT_BASH_PATH` ve Git for Windows'un
 * bilinen kurulum yerleri bakılır.
 */
export async function gitBashDenetle(a: {
  platform: NodeJS.Platform;
  ortam: NodeJS.ProcessEnv;
  dosyaVar: (yol: string) => Promise<boolean>;
}): Promise<{ ok: boolean; oneri: string } | null> {
  if (a.platform !== 'win32') return null;
  const belirtilen = a.ortam.CLAUDE_CODE_GIT_BASH_PATH;
  let gecersizEnv: string | undefined;
  if (belirtilen !== undefined && belirtilen !== '') {
    if (gitBashAdayiMi(belirtilen) && (await a.dosyaVar(belirtilen))) return { ok: true, oneri: '' };
    // Claude Code geçersiz değeri yok sayıp otomatik algılamaya devam eder.
    gecersizEnv = belirtilen;
  }
  const kokler = [a.ortam.ProgramFiles, a.ortam['ProgramFiles(x86)'], a.ortam.ProgramW6432]
    .filter((k): k is string => k !== undefined && k !== '')
    .map((k) => `${k.replace(/[\\/]+$/, '')}\\Git`);
  if (a.ortam.LOCALAPPDATA !== undefined && a.ortam.LOCALAPPDATA !== '') {
    kokler.push(`${a.ortam.LOCALAPPDATA.replace(/[\\/]+$/, '')}\\Programs\\Git`);
  }
  for (const kok of kokler) {
    if (await a.dosyaVar(`${kok}\\bin\\bash.exe`)) return { ok: true, oneri: '' };
  }
  const yoksayilan = gecersizEnv === undefined
    ? ''
    : `; CLAUDE_CODE_GIT_BASH_PATH (${gecersizEnv}) is ignored because it is not an existing Git Bash bash.exe`;
  return {
    ok: false,
    oneri: `${GIT_BASH_ONERISI}, or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe if it is installed elsewhere${yoksayilan}`,
  };
}

async function dosyaMi(yol: string): Promise<boolean> {
  try {
    return (await stat(yol)).isFile();
  } catch {
    return false;
  }
}

export async function doctor(a: {
  cwd: string;
  platform?: NodeJS.Platform;
  ortam?: NodeJS.ProcessEnv;
  dosyaVar?: (yol: string) => Promise<boolean>;
}): Promise<KomutSonucu> {
  const [claude, codex, chromium, dizin, gitBash] = await Promise.all([
    komutVarMi('claude'),
    komutVarMi('codex'),
    chromiumVarMi(),
    KobayDizini.bul(a.cwd),
    gitBashDenetle({
      platform: a.platform ?? process.platform,
      ortam: a.ortam ?? process.env,
      dosyaVar: a.dosyaVar ?? dosyaMi,
    }),
  ]);
  let hedef = false;
  let baseUrl: string | undefined;
  if (dizin !== null) {
    try {
      baseUrl = (await dizin.configOku()).baseUrl;
      hedef = await hedefAyaktaMi(baseUrl);
    } catch {
      hedef = false;
    }
  }
  const beyinVar = claude || codex;
  const ham = [
    {
      ad: `Node ${process.versions.node}`,
      ok: nodeSurumuYeterliMi(process.versions.node),
      oneri: 'install Node 22.12 or newer',
    },
    {
      ad: 'claude CLI',
      ok: claude,
      oneri: beyinVar
        ? 'missing; codex can be used as the brain'
        : 'install it, or switch to a key-based brain with `kobay setup --brain openrouter`',
    },
    {
      ad: 'codex CLI',
      ok: codex,
      oneri: beyinVar
        ? 'missing; claude can be used as the brain'
        : 'install it, or switch to a key-based brain with `kobay setup --brain openrouter`',
    },
    { ad: 'Chromium', ok: chromium, oneri: CHROMIUM_ONERISI },
    ...(gitBash === null ? [] : [{ ad: 'Git Bash', ok: gitBash.ok, oneri: gitBash.oneri }]),
    { ad: '.kobay', ok: dizin !== null, oneri: 'create a project with `kobay project create --url <URL>`' },
    {
      ad: 'target',
      ok: hedef,
      oneri: dizin === null
        ? 'no project; run `kobay project create --url <URL>` first'
        : `${baseUrl === undefined ? 'target' : adresKimligiGizle(baseUrl)} is not reachable; start the app or fix the address with \`kobay project update --base-url <URL>\``,
    },
  ];
  const metin = ham
    .map((kontrol) => (kontrol.ok ? `✓ ${kontrol.ad}` : `✗ ${kontrol.ad} — ${kontrol.oneri}`))
    .join('\n');
  // `oneri` yalnız düşen kontrolde yazılır: ok:true satırda öneri bırakmak
  // ajanı yanıltıyordu (hedef ayaktayken "ayakta değil" önerisi gibi).
  const kontroller: Kontrol[] = ham.map(({ ad, ok, oneri }) => ({ name: ad, ok, ...(ok ? {} : { hint: oneri }) }));
  return basariliMetin(kontroller, metin);
}
