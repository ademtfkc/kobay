import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdimSonucu, PlanAdimi } from '../depo/index.js';

type BilinmeyenKayit = Record<string, unknown>;

export interface PlaywrightRaporSonucu {
  adimlar: AdimSonucu[];
  hataMesaji?: string;
  /**
   * Playwright'ın kendi hatası: testin hiç koşmadığını ya da raporun sonucu taşımadığını
   * gösterir. Doluysa koşu `inconclusive` sayılır; "geçti" demek yasaktır.
   */
  motorHatasi?: string;
}

function kayitMi(deger: unknown): deger is BilinmeyenKayit {
  return typeof deger === 'object' && deger !== null;
}

function ansiTemizle(metin: string): string {
  const ansiDeseni = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return metin.replace(ansiDeseni, '').slice(0, 2000);
}

function hataMetni(deger: unknown): string | undefined {
  if (typeof deger === 'string' && deger !== '') return ansiTemizle(deger);
  if (!kayitMi(deger)) return undefined;
  if (typeof deger.message === 'string' && deger.message !== '') return ansiTemizle(deger.message);
  if (Array.isArray(deger.errors)) {
    for (const hata of deger.errors) {
      const metin = hataMetni(hata);
      if (metin !== undefined) return metin;
    }
  }
  if (kayitMi(deger.error)) return hataMetni(deger.error);
  return undefined;
}

function sayi(deger: unknown): number {
  return typeof deger === 'number' && Number.isFinite(deger) ? deger : 0;
}

function planAdimlariniTopla(adimlar: unknown, bulunanlar: Map<number, { sure: number; hata?: string }>): void {
  if (!Array.isArray(adimlar)) return;
  for (const adim of adimlar) {
    if (!kayitMi(adim)) continue;
    const baslik = typeof adim.title === 'string' ? adim.title : '';
    const eslesme = /^(\d+):\s/.exec(baslik);
    const hata = hataMetni(adim);
    if (eslesme?.[1] !== undefined) {
      const indeks = Number(eslesme[1]);
      const onceki = bulunanlar.get(indeks);
      bulunanlar.set(indeks, {
        sure: sayi(adim.duration) + (onceki?.sure ?? 0),
        ...(hata === undefined ? (onceki?.hata === undefined ? {} : { hata: onceki.hata }) : { hata }),
      });
    }
    planAdimlariniTopla(adim.steps, bulunanlar);
  }
}

function sonucKayitlariniTopla(rapor: unknown): BilinmeyenKayit[] {
  const sonuclar: BilinmeyenKayit[] = [];
  const gez = (dugum: unknown): void => {
    if (!kayitMi(dugum)) return;
    if (Array.isArray(dugum.results)) {
      for (const sonuc of dugum.results) if (kayitMi(sonuc)) sonuclar.push(sonuc);
    }
    for (const anahtar of ['suites', 'specs', 'tests']) {
      const cocuklar = dugum[anahtar];
      if (Array.isArray(cocuklar)) for (const cocuk of cocuklar) gez(cocuk);
    }
  };
  gez(rapor);
  return sonuclar;
}

/**
 * Raporun kendisi koşunun gerçekleştiğini kanıtlıyor mu?
 * Playwright, spec'i hiç yükleyemediğinde (ör. iki ayrı @playwright/test kopyası) rapor
 * üst düzeyde `errors` taşır, `stats` sıfır kalır ve hiçbir sonuç kaydı yazılmaz.
 */
function motorHatasiBul(rapor: unknown, sonucKayitlari: BilinmeyenKayit[]): string | undefined {
  const kok = kayitMi(rapor) ? rapor : {};
  const hatalar = Array.isArray(kok.errors) ? kok.errors : [];
  if (hatalar.length > 0) {
    return hatalar.map(hataMetni).find((metin) => metin !== undefined)
      ?? 'Playwright wrote an error into the report but its message could not be read.';
  }
  const istatistik = kayitMi(kok.stats) ? kok.stats : undefined;
  if (istatistik === undefined) return 'The Playwright report has no stats; the run could not be verified.';
  const kosan = sayi(istatistik.expected) + sayi(istatistik.unexpected) + sayi(istatistik.flaky);
  if (kosan === 0) {
    return `Playwright ran no tests (expected ${sayi(istatistik.expected)}, unexpected ${sayi(istatistik.unexpected)}, flaky ${sayi(istatistik.flaky)}, skipped ${sayi(istatistik.skipped)}).`;
  }
  if (sonucKayitlari.length === 0) return 'The Playwright report has no test results; the run could not be verified.';
  return undefined;
}

async function kanitYollari(kosuDizini: string, indeks: number): Promise<{ screenshotPath?: string; htmlPath?: string }> {
  const [png, html] = await Promise.all([
    access(join(kosuDizini, `adim-${indeks}.png`)).then(() => true).catch(() => false),
    access(join(kosuDizini, `adim-${indeks}.html`)).then(() => true).catch(() => false),
  ]);
  return {
    ...(png ? { screenshotPath: `adim-${indeks}.png` } : {}),
    ...(html ? { htmlPath: `adim-${indeks}.html` } : {}),
  };
}

/** JSON reporter'ın iç içe adımlarını Kobay'ın düz adım sonucuna dönüştürür. */
export async function raporuAyristir(
  rapor: unknown,
  planAdimlari: PlanAdimi[],
  kosuDizini: string,
): Promise<PlaywrightRaporSonucu> {
  const sonucKayitlari = sonucKayitlariniTopla(rapor);
  const bulunanlar = new Map<number, { sure: number; hata?: string }>();
  for (const sonuc of sonucKayitlari) planAdimlariniTopla(sonuc.steps, bulunanlar);
  const testHatasi = sonucKayitlari.map(hataMetni).find((metin) => metin !== undefined);
  const testBasarisiz = sonucKayitlari.some((sonuc) => sonuc.status !== 'passed');

  // Reporter bazen adım hatasını yalnız test seviyesinde taşır; bu durumda son görülen adım düşmüştür.
  if (testBasarisiz && ![...bulunanlar.values()].some((adim) => adim.hata !== undefined) && testHatasi !== undefined) {
    const sonIndeks = Math.max(...bulunanlar.keys());
    const sonAdim = bulunanlar.get(sonIndeks);
    if (sonAdim !== undefined) bulunanlar.set(sonIndeks, { ...sonAdim, hata: testHatasi });
  }

  const adimlar = await Promise.all(planAdimlari.map(async (planAdimi, indeks): Promise<AdimSonucu> => {
    const bulunan = bulunanlar.get(indeks);
    if (bulunan === undefined) {
      return { stepIndex: indeks, description: planAdimi.description, status: 'skipped', durationMs: 0 };
    }
    return {
      stepIndex: indeks,
      description: planAdimi.description,
      status: bulunan.hata === undefined ? 'passed' : 'failed',
      durationMs: bulunan.sure,
      ...(bulunan.hata === undefined ? {} : { errorMessage: bulunan.hata }),
      ...(await kanitYollari(kosuDizini, indeks)),
    };
  }));
  // Emniyet kemeri: rapor yeşil görünse bile tek bir adım bile koşmadıysa sonuç geçerli değildir.
  const hicAdimKosmadi = planAdimlari.length > 0 && adimlar.every((adim) => adim.status === 'skipped');
  const yesilGorunuyor = !testBasarisiz && testHatasi === undefined;
  const motorHatasi = motorHatasiBul(rapor, sonucKayitlari)
    ?? (yesilGorunuyor && hicAdimKosmadi
      ? 'The report does not show a single step running; the run could not be verified.'
      : undefined);

  return {
    adimlar,
    ...(testHatasi === undefined ? {} : { hataMesaji: testHatasi }),
    ...(motorHatasi === undefined ? {} : { motorHatasi }),
  };
}

export { ansiTemizle as hataMetniniTemizle };
