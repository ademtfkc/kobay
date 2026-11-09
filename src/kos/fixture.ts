import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  test as temel, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page,
} from '@playwright/test';
import { yazAtomik } from '../depo/index.js';
import { adimSar } from './fixture-sablonu.js';

type Kayit = Record<string, unknown>;

function kosuDizini(): string | undefined {
  const dizin = process.env.KOBAY_RUN_DIR;
  return dizin === undefined || dizin === '' ? undefined : dizin;
}

function storageState(): string | undefined {
  const yol = process.env.KOBAY_STORAGE_STATE;
  return yol === undefined || yol === '' ? undefined : yol;
}

function adimIndeksi(baslik: string): number | undefined {
  const eslesme = /^(\d+):\s/.exec(baslik);
  return eslesme?.[1] === undefined ? undefined : Number(eslesme[1]);
}

function adimAlani(stepIndex: number | undefined): Kayit {
  return stepIndex === undefined ? {} : { stepIndex };
}

function konsolKaydi(mesaj: { type(): string; text(): string }, stepIndex: number | undefined): Kayit {
  return {
    tip: mesaj.type(),
    metin: mesaj.text(),
    ...adimAlani(stepIndex),
  };
}

/** Video yalnız beklenmeyen sonuçta (düşen, zaman aşımı, kesilen test) saklanır. */
export function videoSaklanmali(bilgi: { status?: string | undefined; expectedStatus: string }): boolean {
  return bilgi.status !== bilgi.expectedStatus;
}

/**
 * Kapanmış context'in videosunu `<koşu>/video.webm`'e taşır ya da siler. Video en iyi
 * çabadır: hiçbir hata testi düşürmez ve sonucu değiştirmez (en fazla video yok).
 */
export async function videoyuSonlandir(kaynak: string | undefined, dizin: string, sakla: boolean): Promise<void> {
  if (kaynak === undefined) return;
  try {
    if (sakla) {
      await rename(kaynak, join(dizin, 'video.webm'));
      return;
    }
  } catch {
    // Taşınamadıysa aşağıda silinir; yarım kalan video ara klasörde durmasın.
  }
  try {
    await rm(kaynak, { force: true });
  } catch {
    // Video en iyi çaba.
  }
}

function videoUyarisi(mesaj: string): void {
  try {
    process.stderr.write(`[kobay] Warning: ${mesaj}; the run continues without a video.\n`);
  } catch {
    // Uyarı da en iyi çaba.
  }
}

/**
 * Video kayıtlı context açar; `recordVideo` yüzünden açılamazsa videosuz açar.
 * Videosuz deneme de düşerse o hata gerçektir ve yayılır.
 */
export async function contextAc(
  tarayici: Pick<Browser, 'newContext'>,
  secenekler: BrowserContextOptions,
  videoKlasoru: string | undefined,
): Promise<{ context: BrowserContext; video: boolean }> {
  if (videoKlasoru !== undefined) {
    try {
      return { context: await tarayici.newContext({ ...secenekler, recordVideo: { dir: videoKlasoru } }), video: true };
    } catch {
      videoUyarisi('video recording could not start');
    }
  }
  return { context: await tarayici.newContext(secenekler), video: false };
}

/**
 * Context'i kapatır. Video kaydı varken kapanış (video yazımı) reddedilirse tarayıcı
 * hâlâ bağlıysa hata videoya sayılır ve sonuç değişmez; tarayıcı kopmuşsa ya da
 * video yoksa hata gerçektir ve yayılır.
 */
export async function contextKapat(
  context: Pick<BrowserContext, 'close'>,
  video: boolean,
  tarayici: Pick<Browser, 'isConnected'>,
): Promise<boolean> {
  try {
    await context.close();
    return true;
  } catch (hata: unknown) {
    if (!video || !tarayici.isConnected()) throw hata;
    videoUyarisi('the run video could not be finished');
    return false;
  }
}

/** Düşen testten sonraki oturum izinin toplam tavanı. */
export const OTURUM_IZI_TAVANI_MS = 12_000;

/**
 * `page` fixture'ının kendi zaman aşımı (kurulum + söküm; testin gövdesi buna girmez). Söküm
 * kanıt (en çok 5 sn), oturum izi (en çok 12 sn) ve video kapanışını içerir; testin kendi süresi
 * dolmuş olsa da bunlar kesilmez. Playwright söküm süresini söküm başlamadan ayırdığı için süre
 * sökümde uzatılamaz (`testInfo.setTimeout`); bu yüzden fixture'a ayrı süre verilir.
 */
export const SAYFA_FIXTURE_ZAMAN_ASIMI_MS = 30_000;

/**
 * Düşen testten sonra, sayfa parola alanı gösteriyorsa, testin KENDİ bağlamında (uygulamanın
 * döndürdüğü son oturumla) `baseUrl` açılır ve giriş ekranı mı diye bakılır; sonuç sır taşımayan
 * `session-check.json`'a yazılır (`{ "loginPage": true|false }`). Koşucu bunu diskteki oturumun
 * yoklamasıyla birlikte kullanır: testin bellekteki oturumu canlıysa gerçek hata `env` diye
 * saklanmaz. En iyi çabadır: hiçbir hata testi ya da sonucunu değiştirmez.
 * Bu yoklama bilerek korumasızdır: test aynı bağlamda, aynı jetonla zaten korumasız koştu;
 * uygulama bu ek açılışta testin kendisinde göremeyeceği hiçbir değer görmez.
 */
export async function oturumIziniYaz(
  context: Pick<BrowserContext, 'newPage'>,
  sayfa: Pick<Page, 'locator'>,
  dizin: string,
  baseUrl: string,
  tavanMs: number = OTURUM_IZI_TAVANI_MS,
): Promise<void> {
  const is = async (): Promise<void> => {
    if (await sayfa.locator('input[type="password"]').count() === 0) return;
    const yeni = await context.newPage();
    try {
      await yeni.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: tavanMs });
      await yeni.waitForLoadState('networkidle', { timeout: Math.min(5_000, tavanMs) }).catch(() => undefined);
      const girisEkrani = new URL(yeni.url()).origin !== new URL(baseUrl).origin
        || await yeni.locator('input[type="password"]').count() > 0;
      await yazAtomik(join(dizin, 'session-check.json'), `${JSON.stringify({ loginPage: girisEkrani })}\n`);
    } finally {
      await yeni.close().catch(() => undefined);
    }
  };
  let zamanlayici: NodeJS.Timeout | undefined;
  const tavan = new Promise<void>((coz) => { zamanlayici = setTimeout(coz, tavanMs); });
  try {
    await Promise.race([is().catch(() => undefined), tavan]);
  } finally {
    clearTimeout(zamanlayici);
  }
}

function tabanAdres(): string | undefined {
  const adres = process.env.KOBAY_BASE_URL;
  return adres === undefined || adres === '' ? undefined : adres;
}

export const test = temel.extend<{ page: Page }>({
  page: [async ({ browser }, kullan, testBilgisi) => {
    const durum = storageState();
    const dizin = kosuDizini();
    // Config'teki `use.video` bu özel context'e uygulanmaz; kayıt yalnız burada (çift kayıt yok).
    const { context, video } = await contextAc(
      browser,
      durum === undefined ? {} : { storageState: durum },
      dizin === undefined ? undefined : join(dizin, 'pw', 'video'),
    );
    const page = await context.newPage();
    const konsol: Kayit[] = [];
    const ag: Kayit[] = [];
    let aktifStepIndex: number | undefined;
    const geriAlKanit = dizin === undefined ? undefined : adimSar(test, page, dizin);
    const oncekiAdim = test.step;
    const sarmaliAdim = async (
      baslik: string,
      govde: (adim: unknown) => unknown | Promise<unknown>,
      secenekler?: unknown,
    ): Promise<unknown> => oncekiAdim(baslik, async (adim) => {
      const oncekiStepIndex = aktifStepIndex;
      const indeks = adimIndeksi(baslik);
      if (indeks !== undefined) aktifStepIndex = indeks;
      try {
        return await govde(adim);
      } finally {
        aktifStepIndex = oncekiStepIndex;
      }
    }, secenekler as never);
    if (dizin !== undefined) test.step = sarmaliAdim as typeof test.step;

    if (dizin !== undefined) {
      page.on('console', (mesaj) => {
        if (mesaj.type() === 'error' || mesaj.type() === 'warning') konsol.push(konsolKaydi(mesaj, aktifStepIndex));
      });
      page.on('requestfailed', (istek) => {
        ag.push({
          url: istek.url(),
          method: istek.method(),
          hata: istek.failure()?.errorText ?? 'Unknown network error',
          ...adimAlani(aktifStepIndex),
        });
      });
      page.on('response', (yanit) => {
        if (yanit.status() >= 400) {
          ag.push({
            url: yanit.url(),
            method: yanit.request().method(),
            status: yanit.status(),
            ...adimAlani(aktifStepIndex),
          });
        }
      });
    }

    try {
      await kullan(page);
    } finally {
      if (dizin !== undefined) test.step = oncekiAdim;
      geriAlKanit?.();
      const taban = tabanAdres();
      if (dizin !== undefined && durum !== undefined && taban !== undefined && videoSaklanmali(testBilgisi)) {
        await oturumIziniYaz(context, page, dizin, taban);
      }
      try {
        if (dizin !== undefined) {
          await Promise.all([
            yazAtomik(`${dizin}/console.json`, `${JSON.stringify(konsol, null, 2)}\n`),
            yazAtomik(`${dizin}/network.json`, `${JSON.stringify(ag, null, 2)}\n`),
          ]);
        }
      } finally {
        let videoYolu: string | undefined;
        try {
          videoYolu = await page.video()?.path();
        } catch {
          videoYolu = undefined;
        }
        // Video ancak context kapanınca tamamlanır; taşıma/silme kapanıştan sonra.
        let kapandi = false;
        try {
          kapandi = await contextKapat(context, video, browser);
        } finally {
          // Video tamamlanamadıysa (kapanış reddedildi) yarım dosya saklanmaz, silinir.
          if (dizin !== undefined) await videoyuSonlandir(videoYolu, dizin, kapandi && videoSaklanmali(testBilgisi));
        }
      }
    }
  }, { scope: 'test', timeout: SAYFA_FIXTURE_ZAMAN_ASIMI_MS }],
});

export { expect };
