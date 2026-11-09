import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mesgulseYinele, yazAtomik } from '../depo/index.js';
import { fixtureSablonu } from './fixture-sablonu.js';

/** Üretilen testlerin yükleyeceği fixture modülü bulunamadığında atılır. */
export class FixtureModuleMissing extends Error {
  constructor(paketKoku: string) {
    super(
      `Kobay fixture module not found (${paketKoku}). The package is missing or only partly built; `
      + 'run `npm run build` in the kobay source, or reinstall kobay.',
    );
    this.name = 'FixtureModuleMissing';
  }
}

/** Şu an çalışan kobay kurulumunun kökü: npm link, -g kurulum ya da kaynak ağaç. */
const AKTIF_PAKET_KOKU = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Önce derlenmiş modül; yoksa kaynaktan çalışan geliştirme kurulumu. */
const FIXTURE_ADAYLARI = [join('dist', 'kos', 'fixture.js'), join('src', 'kos', 'fixture.ts')];

export const VARSAYILAN_EYLEM_ZAMAN_ASIMI_MS = 15_000;

/** Yalnız pozitif tam sayı geçerli; 0 (Playwright'ta "sınırsız"), eksi, NaN, boş → varsayılan. */
export function eylemZamanAsimiCoz(deger: unknown): number {
  const sayi = typeof deger === 'number' ? deger : typeof deger === 'string' && deger.trim() !== '' ? Number(deger) : Number.NaN;
  return Number.isSafeInteger(sayi) && sayi > 0 ? sayi : VARSAYILAN_EYLEM_ZAMAN_ASIMI_MS;
}

/** Üretilen config'te çalışan, `eylemZamanAsimiCoz` ile aynı kuralın satır içi hali. */
export const EYLEM_ZAMAN_ASIMI_IFADESI = '(() => { const n = Number(process.env.KOBAY_ACTION_TIMEOUT_MS);'
  + ` return Number.isSafeInteger(n) && n > 0 ? n : ${String(VARSAYILAN_EYLEM_ZAMAN_ASIMI_MS)}; })()`;

/**
 * Trace oturum çerezini açık taşır: `retain-on-failure` ile yalnız düşen testte
 * kalır, geçen testte Playwright onu siler (spec 2026-11-06 Ş-C).
 */
export function kaliciConfigMetni(): string {
  return [
    'export default {',
    "  testDir: 'tests',",
    '  timeout: Number(process.env.KOBAY_TEST_TIMEOUT_MS ?? 120000),',
    '  workers: 1,',
    '  retries: 0,',
    "  reporter: [['json', { outputFile: process.env.KOBAY_REPORT_FILE }]],",
    `  use: { baseURL: process.env.KOBAY_BASE_URL, trace: 'retain-on-failure', actionTimeout: ${EYLEM_ZAMAN_ASIMI_IFADESI}, screenshot: 'only-on-failure', video: 'off' },`,
    "  outputDir: `${process.env.KOBAY_RUN_DIR}/pw`,",
    '};',
    '',
  ].join('\n');
}

async function dosyaVarMi(yol: string): Promise<boolean> {
  try {
    await access(yol);
    return true;
  } catch {
    return false;
  }
}

async function farkliysaYaz(yol: string, icerik: string): Promise<void> {
  try {
    if (await mesgulseYinele(() => readFile(yol, 'utf8')) === icerik) return;
  } catch (hata: unknown) {
    if (!(typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT')) throw hata;
  }
  await yazAtomik(yol, icerik);
}

/**
 * `.kobay/tests/_fixture.ts` içeriğini **çalışan** kobay kurulumuna göre üretir.
 *
 * Yol bir kere yazılıp bırakılamaz: kurulum değişince (npm link → npm install -g, sürüm
 * yükseltme) eski paketin fixture'ı ayrı bir @playwright/test kopyası yükler, Playwright
 * hiç test koşturamaz. Hedef modül yoksa `FixtureModuleMissing` atılır.
 */
export async function fixtureYenidenAktarimMetni(paketKoku: string = AKTIF_PAKET_KOKU): Promise<string> {
  for (const aday of FIXTURE_ADAYLARI) {
    const yol = join(paketKoku, aday);
    if (await dosyaVarMi(yol)) return fixtureSablonu(yol.split(sep).join('/'));
  }
  throw new FixtureModuleMissing(paketKoku);
}

/**
 * Bu süreçte kök başına hazırlık sırası. Aynı kökte eşzamanlı iki koşu
 * oku-karşılaştır-yaz adımını aynı anda yapıp aynı dosyayı iki kez taşırdı;
 * Windows'ta ikinci taşıma EPERM verir ve koşu `env` olurdu. Sırada ikinci
 * çağrı içeriği aynı bulur ve yazmaz. Farklı kökler birbirini beklemez; düşen
 * hazırlık sırayı kilitlemez. Ayrı süreçlerin yarışı `yazAtomik`in yeniden
 * denemesine kalır.
 */
const hazirlikSiralari = new Map<string, Promise<void>>();

async function kokSirasiyla<T>(kobayKoku: string, is: () => Promise<T>): Promise<T> {
  const anahtar = resolve(kobayKoku);
  const onceki = hazirlikSiralari.get(anahtar) ?? Promise.resolve();
  const sonuc = onceki.then(is);
  const zincir = sonuc.then(() => undefined, () => undefined);
  hazirlikSiralari.set(anahtar, zincir);
  void zincir.then(() => {
    if (hazirlikSiralari.get(anahtar) === zincir) hazirlikSiralari.delete(anahtar);
  });
  return sonuc;
}

/**
 * Koşuların paylaştığı kalıcı Playwright yapılandırmasını hazırlar.
 * `_fixture.ts` her koşudan önce tazelenir; içerik aynıysa dosyaya dokunulmaz.
 * Aynı kök için eşzamanlı çağrılar sıraya girer (bkz. `hazirlikSiralari`).
 */
export async function kaliciCalismaAlaniHazirla(
  kobayKoku: string,
  paketKoku: string = AKTIF_PAKET_KOKU,
): Promise<{ configYolu: string; fixtureYolu: string }> {
  return kokSirasiyla(kobayKoku, () => calismaAlaniniHazirla(kobayKoku, paketKoku));
}

async function calismaAlaniniHazirla(
  kobayKoku: string,
  paketKoku: string,
): Promise<{ configYolu: string; fixtureYolu: string }> {
  const configYolu = join(kobayKoku, 'playwright.config.ts');
  const fixtureYolu = join(kobayKoku, 'tests', '_fixture.ts');
  // Fixture modülü yoksa burada patlar; koşu tarayıcı açmadan inconclusive olur.
  const fixtureMetni = await fixtureYenidenAktarimMetni(paketKoku);
  // allSettled: biri düşse de kardeş yazım bitmeden sıra sonraki hazırlığa geçmesin.
  const sonuclar = await Promise.allSettled([
    farkliysaYaz(configYolu, kaliciConfigMetni()),
    farkliysaYaz(fixtureYolu, fixtureMetni),
  ]);
  for (const sonuc of sonuclar) {
    if (sonuc.status === 'rejected') throw sonuc.reason;
  }
  return { configYolu, fixtureYolu };
}
