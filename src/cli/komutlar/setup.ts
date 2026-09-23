import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { yazAtomik, type BeyinAyari } from '../../depo/index.js';
import { UsageError, PermissionError, basariliMetin, komutCalistir, type KomutSonucu } from '../komut.js';

const execFileAsync = promisify(execFile);

export async function komutVarMi(ad: string): Promise<boolean> {
  try {
    await execFileAsync('which', [ad]);
    return true;
  } catch {
    return false;
  }
}

export async function chromiumVarMi(): Promise<boolean> {
  try {
    await access(chromium.executablePath());
    return true;
  } catch {
    return false;
  }
}

export async function setup(a: {
  beyin?: 'claude' | 'codex' | 'openrouter';
  model?: string;
  effort?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const adaptor = a.beyin ?? 'claude';
    const env = a.env ?? process.env;
    if ((adaptor === 'claude' || adaptor === 'codex') && !(await komutVarMi(adaptor))) {
      throw new UsageError(`${adaptor} not found on PATH; pick another brain`);
    }
    if (adaptor === 'openrouter' && !env.OPENROUTER_API_KEY) {
      throw new PermissionError('OPENROUTER_API_KEY is not set; pick another brain or set the key in the environment');
    }
    const beyin: BeyinAyari = {
      adaptor,
      ...(a.model === undefined ? {} : { model: a.model }),
      ...(a.effort === undefined ? {} : { effort: a.effort }),
    };
    const yol = join(a.home ?? homedir(), '.kobay', 'config.json');
    await yazAtomik(yol, `${JSON.stringify({ brain: beyin }, null, 2)}\n`);
    const chromiumKurulu = await chromiumVarMi();
    const oneri = chromiumKurulu ? undefined : 'Chromium is missing: run `kobay install-browser`';
    // İnsan modunda ham JSON dökümü yerine özet: ayar dosyası, seçilen beyin ve
    // sonraki komut. JSON modu (`--output json`) aynı gövdeyi verir.
    const ayrinti = [
      ...(beyin.model === undefined ? [] : [`model: ${beyin.model}`]),
      ...(beyin.effort === undefined ? [] : [`effort: ${beyin.effort}`]),
    ];
    const metin = [
      `Default brain set: ${adaptor}${ayrinti.length === 0 ? '' : ` (${ayrinti.join(', ')})`}`,
      `Config file: ${yol}`,
      chromiumKurulu ? 'Chromium: installed' : 'Chromium: missing; run `kobay install-browser`',
      `Next: ${chromiumKurulu ? 'kobay project create --url <URL>' : 'kobay install-browser'}`,
    ].join('\n');
    return basariliMetin(
      {
        path: yol,
        brain: beyin,
        chromiumInstalled: chromiumKurulu,
        ...(oneri === undefined ? {} : { hint: oneri }),
      },
      metin,
    );
  });
}
