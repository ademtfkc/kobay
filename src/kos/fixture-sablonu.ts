import type { Page, TestStepInfo, TestType } from '@playwright/test';
import { yazAtomik } from '../depo/index.js';

type AdimSecenekleri = {
  box?: boolean;
  location?: { file: string; line: number; column: number };
  timeout?: number;
  params?: Record<string, unknown>;
  subtitle?: string;
};

function adimIndeksi(baslik: string): number | null {
  const eslesme = /^(\d+):\s/.exec(baslik);
  return eslesme?.[1] === undefined ? null : Number(eslesme[1]);
}

/** Bir test.step çağrısını sarar; adım biter bitmez atomik kanıt dosyaları yazar. */
export function adimSar<TestArgumanlari extends object, IsciArgumanlari extends object>(
  test: TestType<TestArgumanlari, IsciArgumanlari>,
  sayfa: Page,
  dizin: string,
): () => void {
  const oncekiAdim = test.step;
  const sarmaliAdim = async (
    baslik: string,
    govde: (adim: TestStepInfo) => unknown | Promise<unknown>,
    secenekler?: AdimSecenekleri,
  ): Promise<unknown> => oncekiAdim(baslik, async (adim) => {
    try {
      return await govde(adim);
    } finally {
      const indeks = adimIndeksi(baslik);
      if (indeks !== null) {
        const [ekran, html] = await Promise.all([sayfa.screenshot(), sayfa.content()]);
        await Promise.all([
          yazAtomik(`${dizin}/adim-${indeks}.png`, ekran),
          yazAtomik(`${dizin}/adim-${indeks}.html`, html),
        ]);
      }
    }
  }, secenekler as never);

  test.step = sarmaliAdim as typeof test.step;
  return () => { test.step = oncekiAdim; };
}

/**
 * T6'nın .kobay/tests/_fixture.ts dosyasına yazacağı yeniden-dışa-aktarım metni.
 *
 * Not: bu modül üretilen testle birlikte Playwright alt sürecinde yüklenir ve orada TS
 * kaynağı CommonJS'e çevrilebilir; bu yüzden burada `import.meta` kullanılamaz. Hangi
 * fixture modülünün yazılacağına `calisma-alani.ts` karar verir.
 */
export function fixtureSablonu(fixtureModulu: string): string {
  return `export * from ${JSON.stringify(fixtureModulu)};\n`;
}
