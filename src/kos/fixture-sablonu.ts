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

/** Kanıt toplamanın toplam üst sınırı; aşılırsa kanıt atlanır, adımın asıl hatası bekletilmez. */
export const KANIT_TAVANI_MS = 5_000;

/**
 * Adım kanıtını (ekran görüntüsü + html) en iyi çabayla yazar. Sayfa kapalı ya da takılıysa
 * fırlatmaz ve `tavanMs` içinde döner: aksi halde `finally` içindeki hata adımın asıl hatasını
 * örter ya da testin kalan süresini yerdi. Biri alınamazsa öteki yine yazılır. Askıda kalan
 * çağrı sonradan reddedilirse işlenmemiş ret oluşmaz (her çağrıya `catch` bağlıdır).
 */
export async function kanitiYaz(
  sayfa: { screenshot(secenekler?: { timeout?: number }): Promise<Buffer>; content(): Promise<string> },
  dizin: string,
  indeks: number,
  tavanMs: number = KANIT_TAVANI_MS,
): Promise<void> {
  const yaz = (alVeYaz: () => Promise<void>): Promise<void> => {
    try {
      return alVeYaz().catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  };
  let zamanlayici: NodeJS.Timeout | undefined;
  const tavan = new Promise<void>((coz) => { zamanlayici = setTimeout(coz, tavanMs); });
  try {
    await Promise.race([
      Promise.all([
        yaz(async () => { await yazAtomik(`${dizin}/step-${indeks}.png`, await sayfa.screenshot({ timeout: tavanMs })); }),
        yaz(async () => { await yazAtomik(`${dizin}/step-${indeks}.html`, await sayfa.content()); }),
      ]),
      tavan,
    ]);
  } finally {
    clearTimeout(zamanlayici);
  }
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
      if (indeks !== null) await kanitiYaz(sayfa, dizin, indeks);
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
