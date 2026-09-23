import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { basariliMetin, komutCalistir, type KomutSonucu } from '../komut.js';

export type AltSurecCalistir = (komut: string, argumanlar: string[]) => Promise<number>;

const require = createRequire(import.meta.url);

export function playwrightCliYolu(): string {
  return require.resolve('@playwright/test/cli');
}

const altSurecCalistir: AltSurecCalistir = (komut, argumanlar) => new Promise((coz, reddet) => {
  const altSurec = spawn(komut, argumanlar, { stdio: 'inherit' });
  altSurec.once('error', reddet);
  altSurec.once('exit', (kod, sinyal) => {
    if (sinyal !== null) {
      reddet(new Error(`Playwright install stopped on signal ${sinyal}`));
      return;
    }
    coz(kod ?? 1);
  });
});

export async function installBrowser(a: {
  withDeps?: boolean;
  calistir?: AltSurecCalistir;
  cliYolu?: string;
} = {}): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const argumanlar = [a.cliYolu ?? playwrightCliYolu(), 'install'];
    if (a.withDeps === true) argumanlar.push('--with-deps');
    argumanlar.push('chromium');
    const kod = await (a.calistir ?? altSurecCalistir)(process.execPath, argumanlar);
    if (kod !== 0) throw new Error(`Chromium install failed (exit ${kod})`);
    // İnsan modunda ham JSON yerine tek onay satırı; JSON modu aynı gövdeyi verir.
    return basariliMetin(
      { browser: 'chromium', withDeps: a.withDeps === true },
      'Installed the Chromium browser matching kobay\'s Playwright version',
    );
  });
}
