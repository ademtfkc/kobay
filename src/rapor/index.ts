import { constants } from 'node:fs';
import {
  lstat, mkdir, open, readdir, readFile, realpath, rmdir, stat, unlink, writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import {
  AdimSonucuSemasi,
  HataPaketiSemasi,
  KobayConfigSemasi,
  KosuSonucuSemasi,
  PublishCleanupFailed,
  TestKaydiSemasi,
  adresKimligiGizle,
  altYol,
  guvenliKokuBul,
  kimlikDogrula,
  klasoruYayimla,
  type AdimSonucu,
  type HataPaketi,
  type KobayDizini,
  type KosuSonucu,
  type TestKaydi,
} from '../depo/index.js';
import {
  metniTemizle,
  raporHtml,
  type RaporAdimi,
  type RaporSayimlari,
  type RaporTesti,
  type RaporVerdict,
} from './html.js';
import { dikkatGerekenMi, duzeltmeIstemi, hepsiniDuzeltIstemi } from './istem.js';
import { ozetMarkdown } from './ozet.js';

export { htmlKacis, metniTemizle, raporHtml, sureMetni, yerelYollariGizle } from './html.js';
export { HATA_SINIRI, duzeltmeIstemi, guvenilmezBlok, hepsiniDuzeltIstemi } from './istem.js';
export {
  OZET_ISARETI, OZET_SINIRI, VARSAYILAN_ISTEM_SAYISI, hucreKacisi, ozetMarkdown,
} from './ozet.js';
export type { OzetGirdisi } from './ozet.js';
export type { RaporSayimlari, RaporTesti, RaporVerdict, RaporVerisi } from './html.js';

/**
 * Kobay'ın yazdığı rapor klasörünü tanıtan işaret dosyası. Gizli ad değil: CI
 * artifact yükleyicileri nokta ile başlayan dosyaları atlayabilir.
 *
 * Dolu bir klasör yalnız YAPISAL olarak tamamen kobay raporuysa değiştirilir:
 * geçerli işaret + `index.html` ve klasördeki her girdi beklenen kümeden
 * (`index.html`, `kobay-report.json`, `assets/<runId>/step-<n>.png`), hiçbiri
 * symlink değil. Tek bir yabancı girdi (`notes.txt`, `.DS_Store`) reddettirir.
 */
export const RAPOR_ISARETI = 'kobay-report.json';
const ISARET_BICIMI = 'kobay-run-report';
const ISARET_SINIRI = 4096;

/** Yayım sırasında hedefin yanında açılan geçici ve kenara alınan klasörlerin öneki. */
const YAYIM_ONEKI = '.kobay-report-';

/** Rapora kopyalanan tek ikili dosya türü; adı yalnız bu kalıptan okunur. */
const EKRAN_GORUNTUSU = /^step-(\d{1,6})\.png$/;
const PNG_IMZASI = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEST_KAYDI_ADI = /^(t_[a-z0-9]{8})\.json$/;

/**
 * Rapor hedefi güvenli değil ya da kobay'ın kendi raporu olduğu kanıtlanamıyor.
 * Kullanıcının klasörüne hiç dokunulmadan reddedilir (CLI'da çıkış 2).
 */
/**
 * Hata ve uyarı metnine giren dosya adı/yol için tek terminal-güvenli yardımcı:
 * kontrol karakterleri (satır sonu, ESC, C1, U+2028/2029) `\\uXXXX` olarak
 * yazılır; böylece kötü adlı bir dosya terminalde ya da CI günlüğünde sahte
 * satır/renk/annotation üretemez.
 */
export function terminaleGuvenli(metin: string): string {
  return metin.replace(
    // Kontrol karakterlerini yakalamak bu ifadenin amacı.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (karakter) => `\\u${karakter.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export class UnsafeReportPath extends Error {
  constructor(yol: string, sebep: string) {
    super(`Refusing to write the report to ${terminaleGuvenli(yol)}: ${terminaleGuvenli(sebep)}.`);
    this.name = 'UnsafeReportPath';
  }
}

/** Seçilen test okunamıyor ya da güvenle okunamıyor (CLI'da çıkış 2). */
export class ReportInputError extends Error {
  constructor(mesaj: string) {
    super(terminaleGuvenli(mesaj));
    this.name = 'ReportInputError';
  }
}

export interface RaporSonucu {
  reportDir: string;
  indexPath: string;
  tests: Array<{ id: string; name: string; verdict: RaporVerdict; runId?: string }>;
  counts: RaporSayimlari;
  screenshots: number;
  /** Silinmeyip yerinde bırakılan, yapısı kobay raporu olarak kanıtlanamayan eski klasörler. */
  keptAside: string[];
  /** Dikkat isteyen her test için ajan istemi (maskeli, yolları gizli); yoksa boş. */
  fixPrompts: Array<{ id: string; prompt: string }>;
  /** İki ya da daha çok test dikkat istiyorsa hepsini kapsayan istem. */
  fixAllPrompt?: string;
  /** Yalnız `ozet` istendiyse: PR'a hazır Markdown özet (JSON'a girmez, dosyaya yazılır). */
  summaryMarkdown?: string;
}

function hataKodu(hata: unknown): string | undefined {
  return typeof hata === 'object' && hata !== null && 'code' in hata && typeof hata.code === 'string'
    ? hata.code
    : undefined;
}

type Durum = Awaited<ReturnType<typeof lstat>>;

async function varsaLstat(yol: string): Promise<Durum | null> {
  try {
    return await lstat(yol);
  } catch (hata: unknown) {
    if (hataKodu(hata) === 'ENOENT') return null;
    throw hata;
  }
}

function kimlikGecerliMi(kimlik: string, tur: 'testId' | 'runId'): boolean {
  try {
    kimlikDogrula(kimlik, tur);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// .kobay içinden symlink izlemeyen okuma

/** `erisilemez`: bir bileşen EACCES/EPERM verdi (izin yok); veri okunmadı. */
type Okuma<T> =
  | { durum: 'yok' } | { durum: 'guvensiz' } | { durum: 'erisilemez' } | { durum: 'bozuk' }
  | { durum: 'tamam'; deger: T };

const IZIN_KODLARI = new Set(['EACCES', 'EPERM']);

/**
 * `.kobay` ve altındaki her bileşeni OKUMADAN ÖNCE `lstat` ile denetler: hiçbiri
 * symlink olamaz, aradakiler dizin, sonuncusu istenen türde olmalı. Eksik bileşen
 * `yok`, symlink ya da yanlış tür `guvensiz`, izin hatası `erisilemez`.
 */
async function bilesenleriDenetle(
  dizin: KobayDizini,
  parcalar: readonly string[],
  sonTur: 'dosya' | 'dizin',
): Promise<{ durum: 'yok' } | { durum: 'guvensiz' } | { durum: 'erisilemez' } | { durum: 'tamam'; yol: string; bilgi: Durum }> {
  try {
    return await bilesenleriYuru(dizin, parcalar, sonTur);
  } catch (hata: unknown) {
    if (IZIN_KODLARI.has(hataKodu(hata) ?? '')) return { durum: 'erisilemez' };
    throw hata;
  }
}

async function bilesenleriYuru(
  dizin: KobayDizini,
  parcalar: readonly string[],
  sonTur: 'dosya' | 'dizin',
): Promise<{ durum: 'yok' } | { durum: 'guvensiz' } | { durum: 'tamam'; yol: string; bilgi: Durum }> {
  let yol = dizin.kok;
  let bilgi = await varsaLstat(yol);
  if (bilgi === null) return { durum: 'yok' };
  if (bilgi.isSymbolicLink() || !bilgi.isDirectory()) return { durum: 'guvensiz' };
  for (const [sira, parca] of parcalar.entries()) {
    yol = join(yol, parca);
    bilgi = await varsaLstat(yol);
    if (bilgi === null) return { durum: 'yok' };
    if (bilgi.isSymbolicLink()) return { durum: 'guvensiz' };
    const son = sira === parcalar.length - 1;
    const dogruTur = son && sonTur === 'dosya' ? bilgi.isFile() : bilgi.isDirectory();
    if (!dogruTur) return { durum: 'guvensiz' };
  }
  return { durum: 'tamam', yol, bilgi };
}

/**
 * `O_NOFOLLOW` ile açar; tutamağın gösterdiği dosya, denetlenen dosyayla (dev/ino)
 * aynı olmalı ve tek adlı olmalı (`nlink === 1`): sert bağ dışarıdaki bir dosyayı
 * `.kobay` içinde göstermesin.
 */
async function tutamakla(yol: string, beklenen: Durum): Promise<Buffer | null> {
  let tutamak;
  try {
    tutamak = await open(yol, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const bilgi = await tutamak.stat();
    if (!bilgi.isFile() || bilgi.nlink !== 1 || bilgi.dev !== beklenen.dev || bilgi.ino !== beklenen.ino) return null;
    return await tutamak.readFile();
  } catch {
    return null;
  } finally {
    await tutamak.close();
  }
}

async function kobayDosyasiOku(dizin: KobayDizini, parcalar: readonly string[]): Promise<Okuma<Buffer>> {
  const denetim = await bilesenleriDenetle(dizin, parcalar, 'dosya');
  if (denetim.durum !== 'tamam') return denetim;
  const icerik = await tutamakla(denetim.yol, denetim.bilgi);
  return icerik === null ? { durum: 'guvensiz' } : { durum: 'tamam', deger: icerik };
}

async function kobayJsonOku<T>(
  dizin: KobayDizini,
  parcalar: readonly string[],
  sema: v.GenericSchema<unknown, T>,
): Promise<Okuma<T>> {
  const okuma = await kobayDosyasiOku(dizin, parcalar);
  if (okuma.durum !== 'tamam') return okuma;
  try {
    const sonuc = v.safeParse(sema, JSON.parse(okuma.deger.toString('utf8')) as unknown);
    return sonuc.success ? { durum: 'tamam', deger: sonuc.output } : { durum: 'bozuk' };
  } catch {
    return { durum: 'bozuk' };
  }
}

async function testKaydiOku(dizin: KobayDizini, id: string): Promise<TestKaydi> {
  kimlikDogrula(id, 'testId');
  const okuma = await kobayJsonOku(dizin, ['tests', `${id}.json`], TestKaydiSemasi);
  switch (okuma.durum) {
    case 'yok':
      throw new ReportInputError(`Test not found: ${id}; list the IDs with \`kobay test list\``);
    case 'guvensiz':
      throw new ReportInputError(
        `Test record ${id} is a symlink, a hard link, or is reached through a symlink; the report does not read it`,
      );
    case 'bozuk':
      throw new ReportInputError(`Test record ${id} is not valid; fix or delete .kobay/tests/${id}.json`);
    case 'erisilemez':
      throw new ReportInputError(`Test record ${id} cannot be read (permission denied)`);
    case 'tamam':
      if (okuma.deger.id !== id) {
        throw new ReportInputError(`Test record ${id} has a different id inside (${okuma.deger.id})`);
      }
      return okuma.deger;
  }
}

/**
 * Raporlanacak test kayıtlarını symlink izlemeden okur. `ids` verilmezse
 * `.kobay/tests` altındaki bütün `t_*.json` kayıtları. Okunamayan ya da symlink
 * üzerinden gelen kayıt `ReportInputError` ile reddedilir; içeriği okunmaz.
 */
export async function raporTestleriniSec(dizin: KobayDizini, ids?: readonly string[]): Promise<TestKaydi[]> {
  if (ids !== undefined) {
    const testler: TestKaydi[] = [];
    for (const id of new Set(ids)) testler.push(await testKaydiOku(dizin, id));
    return testler;
  }
  const denetim = await bilesenleriDenetle(dizin, ['tests'], 'dizin');
  if (denetim.durum === 'yok') return [];
  if (denetim.durum === 'erisilemez') {
    throw new ReportInputError('.kobay/tests cannot be read (permission denied)');
  }
  if (denetim.durum === 'guvensiz') {
    throw new ReportInputError('.kobay or .kobay/tests is a symlink or not a directory; the report does not read it');
  }
  const adlar = (await readdir(denetim.yol)).sort();
  const testler: TestKaydi[] = [];
  for (const ad of adlar) {
    const eslesme = TEST_KAYDI_ADI.exec(ad);
    if (eslesme?.[1] === undefined) continue;
    testler.push(await testKaydiOku(dizin, eslesme[1]));
  }
  return testler;
}

// ---------------------------------------------------------------------------
// Rapor klasörünün yapısı ve silme

type Yapi =
  | { tamam: true; dosyalar: string[]; dizinler: string[] }
  | { tamam: false; sebep: string };

async function isaretGecerliMi(yol: string, bilgi: Durum): Promise<boolean> {
  if (bilgi.size > ISARET_SINIRI) return false;
  try {
    const veri = JSON.parse(await readFile(yol, 'utf8')) as unknown;
    return typeof veri === 'object' && veri !== null
      && 'generator' in veri && veri.generator === 'kobay'
      && 'format' in veri && veri.format === ISARET_BICIMI;
  } catch {
    return false;
  }
}

/**
 * Klasörü gezip yalnız beklenen girdilerden oluştuğunu doğrular. `mod`:
 * - `rapor`: geçerli işaret ve `index.html` şart (dolu hedefin değiştirilmesi).
 * - `bosVeyaRapor`: boş klasör de kabul (kenara alınan eski hedef).
 * - `gecici`: işaret aranmaz (kendi yarım geçici klasörümüz).
 * Silinecek dosyalar ve (en derinden başlayarak) dizinler döner.
 */
async function raporYapisi(kok: string, mod: 'rapor' | 'bosVeyaRapor' | 'gecici'): Promise<Yapi> {
  const yabanci = (yol: string): Yapi => ({ tamam: false, sebep: `unexpected entry "${relative(kok, yol)}"` });
  const kokBilgi = await varsaLstat(kok);
  if (kokBilgi === null || kokBilgi.isSymbolicLink() || !kokBilgi.isDirectory()) {
    return { tamam: false, sebep: 'not a plain directory' };
  }
  const dosyalar: string[] = [];
  const dizinler: string[] = [];
  const girdiler = await readdir(kok);
  if (girdiler.length === 0) {
    return mod === 'rapor' ? { tamam: false, sebep: 'empty' } : { tamam: true, dosyalar, dizinler: [kok] };
  }
  let isaretVar = false;
  let indexVar = false;
  for (const ad of girdiler.sort()) {
    const yol = join(kok, ad);
    const bilgi = await varsaLstat(yol);
    if (bilgi === null) continue;
    if (bilgi.isSymbolicLink()) return yabanci(yol);
    if (ad === 'index.html' && bilgi.isFile()) {
      indexVar = true;
      dosyalar.push(yol);
    } else if (ad === RAPOR_ISARETI && bilgi.isFile()) {
      if (mod !== 'gecici' && !(await isaretGecerliMi(yol, bilgi))) {
        return { tamam: false, sebep: `${RAPOR_ISARETI} is not a valid kobay report marker` };
      }
      isaretVar = true;
      dosyalar.push(yol);
    } else if (ad === 'assets' && bilgi.isDirectory()) {
      for (const kosuAdi of (await readdir(yol)).sort()) {
        const kosuYolu = join(yol, kosuAdi);
        const kosuBilgi = await varsaLstat(kosuYolu);
        if (kosuBilgi === null) continue;
        if (kosuBilgi.isSymbolicLink() || !kosuBilgi.isDirectory() || !kimlikGecerliMi(kosuAdi, 'runId')) {
          return yabanci(kosuYolu);
        }
        for (const resimAdi of (await readdir(kosuYolu)).sort()) {
          const resimYolu = join(kosuYolu, resimAdi);
          const resimBilgi = await varsaLstat(resimYolu);
          if (resimBilgi === null) continue;
          if (resimBilgi.isSymbolicLink() || !resimBilgi.isFile() || !EKRAN_GORUNTUSU.test(resimAdi)) {
            return yabanci(resimYolu);
          }
          dosyalar.push(resimYolu);
        }
        dizinler.push(kosuYolu);
      }
      dizinler.push(yol);
    } else {
      return yabanci(yol);
    }
  }
  if (mod !== 'gecici' && (!isaretVar || !indexVar)) {
    return { tamam: false, sebep: `index.html or ${RAPOR_ISARETI} is missing` };
  }
  dizinler.push(kok);
  return { tamam: true, dosyalar, dizinler };
}

/** Klasör yapısal olarak tam bir kobay raporu mu (işaret + index + yalnız beklenen girdiler). */
export async function raporKlasoruMu(yol: string): Promise<boolean> {
  try {
    return (await raporYapisi(yol, 'rapor')).tamam;
  } catch {
    return false;
  }
}

/**
 * Rapor ağacını `rm -r` KULLANMADAN siler: yapı doğrulanır, yalnız beklenen
 * adlardaki dosyalar tek tek `unlink`, dizinler `rmdir` edilir. Yapı tutmazsa
 * ya da arada beklenmeyen bir şey belirirse (rmdir ENOTEMPTY) durulur; kalan
 * yerinde bırakılır ve `false` döner.
 */
async function raporAgaciniSil(yol: string, mod: 'bosVeyaRapor' | 'gecici'): Promise<boolean> {
  let yapi: Yapi;
  try {
    yapi = await raporYapisi(yol, mod);
  } catch {
    return false;
  }
  if (!yapi.tamam) return false;
  try {
    for (const dosya of yapi.dosyalar) {
      // Üst dizin arada bağa çevrildiyse dışarıdaki aynı adlı dosya silinmesin.
      const ust = await varsaLstat(dirname(dosya));
      if (ust === null) continue;
      if (ust.isSymbolicLink() || !ust.isDirectory()) return false;
      await unlink(dosya).catch((hata: unknown) => {
        if (hataKodu(hata) !== 'ENOENT') throw hata;
      });
    }
    for (const alt of yapi.dizinler) {
      await rmdir(alt).catch((hata: unknown) => {
        if (hataKodu(hata) !== 'ENOENT') throw hata;
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Yazmadan önce hedefi denetler. Yok ya da boş dizin: serbest. Symlink, dizin
 * olmayan yol ya da yapısal olarak kobay raporu olmayan dolu dizin: ret.
 */
export async function raporHedefiniDenetle(hedef: string, varsayilan = false): Promise<void> {
  const durum = await varsaLstat(hedef);
  if (durum === null) return;
  if (durum.isSymbolicLink()) throw new UnsafeReportPath(hedef, 'the destination is a symlink');
  if (!durum.isDirectory()) throw new UnsafeReportPath(hedef, 'the destination exists and is not a directory');
  if ((await readdir(hedef)).length === 0) return;
  const yapi = await raporYapisi(hedef, 'rapor');
  if (yapi.tamam) return;
  throw new UnsafeReportPath(
    hedef,
    `the directory is not empty and is not a kobay report (${yapi.sebep}); its contents were not touched.`
    + (varsayilan
      ? ' Remove that entry (for example a .DS_Store left by Finder), or pass --out <dir> to write the report elsewhere'
      : ' Choose an empty or new directory with --out'),
  );
}

/**
 * Yayımda kenara alınan eski klasörleri siler; yalnız yapısal olarak kobay raporu
 * ya da boş olan silinir. Başka her şey yerinde bırakılır ve yolu döndürülür.
 */
export async function eskiRaporlariSil(ust: string, yollar: readonly string[]): Promise<string[]> {
  const birakilan: string[] = [];
  for (const yol of yollar) {
    if (dirname(yol) !== ust || !basename(yol).startsWith(YAYIM_ONEKI)) {
      birakilan.push(yol);
      continue;
    }
    if ((await varsaLstat(yol)) === null) continue;
    if (!(await raporAgaciniSil(yol, 'bosVeyaRapor'))) birakilan.push(yol);
  }
  return birakilan;
}

// ---------------------------------------------------------------------------
// Veri toplama

/**
 * Ekran görüntüsünü güvenli okur: `.kobay/runs/<runId>` bileşenleri symlink
 * olmamalı, dosya `O_NOFOLLOW` ile açılır ve açtıktan sonra gerçek yolunun
 * gerçek koşu dizininin doğrudan altında olduğu, kimliğinin (dev/ino)
 * tutamakla aynı olduğu doğrulanır. PNG imzası şart. Uymayan her durumda `null`.
 */
async function pngOku(dizin: KobayDizini, runId: string, gercekKosu: string, numara: number): Promise<Buffer | null> {
  const denetim = await bilesenleriDenetle(dizin, ['runs', runId, `step-${numara}.png`], 'dosya');
  if (denetim.durum !== 'tamam') return null;
  let tutamak;
  try {
    tutamak = await open(denetim.yol, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const bilgi = await tutamak.stat();
    if (!bilgi.isFile() || bilgi.nlink !== 1) return null;
    const gercek = await realpath(denetim.yol);
    if (dirname(gercek) !== gercekKosu) return null;
    const gercekBilgi = await stat(gercek);
    if (gercekBilgi.dev !== bilgi.dev || gercekBilgi.ino !== bilgi.ino) return null;
    const icerik = await tutamak.readFile();
    return icerik.subarray(0, PNG_IMZASI.length).equals(PNG_IMZASI) ? icerik : null;
  } catch {
    return null;
  } finally {
    await tutamak.close();
  }
}

/** `screenshotPath` değerinden yalnız `step-<n>.png` kalıbının `n`'i okunur. */
function ekranGoruntusuNumarasi(deger: string | undefined): number | null {
  if (deger === undefined) return null;
  const eslesme = EKRAN_GORUNTUSU.exec(deger);
  if (eslesme?.[1] === undefined) return null;
  return Number.parseInt(eslesme[1], 10);
}

/** Koşu dizininin gerçek yolu; `.kobay/runs/<runId>` gerçekte de bu adla `.kobay` altında olmalı. */
async function gercekKosuDizini(dizin: KobayDizini, runId: string): Promise<string | null> {
  try {
    const [gercekKobay, gercekKosu] = await Promise.all([realpath(dizin.kok), realpath(dizin.yol('runs', runId))]);
    return gercekKosu === join(gercekKobay, 'runs', runId) ? gercekKosu : null;
  } catch {
    return null;
  }
}

/** Görüntüleri bellekte biriktirmeden doğrudan geçici rapor klasörüne yazar. */
class GorselYazici {
  readonly #yazilanlar = new Set<string>();

  constructor(private readonly gecici: string) {}

  get sayi(): number {
    return this.#yazilanlar.size;
  }

  async yaz(dizin: KobayDizini, runId: string, gercekKosu: string, numara: number): Promise<string | null> {
    const goreli = `assets/${runId}/step-${numara}.png`;
    if (this.#yazilanlar.has(goreli)) return goreli;
    const icerik = await pngOku(dizin, runId, gercekKosu, numara);
    if (icerik === null) return null;
    const hedef = altYol(this.gecici, 'assets', runId, `step-${numara}.png`);
    await mkdir(dirname(hedef), { recursive: true });
    await writeFile(hedef, icerik, { flag: 'wx' });
    this.#yazilanlar.add(goreli);
    return goreli;
  }
}

/** Yalnız bu koşuya ait, tamamlanmış (`.partial`'sız) ve symlink'siz hata paketi; aksi halde yok. */
async function kosununHataPaketi(dizin: KobayDizini, testId: string, runId: string): Promise<HataPaketi | null> {
  const paketDizini = await bilesenleriDenetle(dizin, ['failure', testId], 'dizin');
  if (paketDizini.durum !== 'tamam') return null;
  try {
    if ((await varsaLstat(join(paketDizini.yol, '.partial'))) !== null) return null;
  } catch {
    return null;
  }
  const okuma = await kobayJsonOku(dizin, ['failure', testId, 'failure.json'], HataPaketiSemasi);
  if (okuma.durum !== 'tamam') return null;
  const paket = okuma.deger;
  return paket.runId === runId && paket.result.runId === runId ? paket : null;
}

function planSatirlari(test: TestKaydi): RaporAdimi[] {
  return test.planSteps.map((adim, sira) => ({ index: sira, description: adim.description, type: adim.type }));
}

async function testiTopla(dizin: KobayDizini, test: TestKaydi, gorseller: GorselYazici): Promise<RaporTesti> {
  kimlikDogrula(test.id, 'testId');
  const kodOkuma = await kobayDosyasiOku(dizin, ['tests', `${test.id}.spec.ts`]);
  const ortak = {
    id: test.id,
    name: test.name,
    priority: test.priority,
    codeVersion: test.codeVersion,
    ...(kodOkuma.durum === 'tamam' ? { code: kodOkuma.deger.toString('utf8') } : {}),
  };
  const runId = test.lastRunId;
  if (runId === undefined || !kimlikGecerliMi(runId, 'runId')) {
    return { ...ortak, verdict: 'not_run', steps: planSatirlari(test) };
  }
  const kosuDizini = await bilesenleriDenetle(dizin, ['runs', runId], 'dizin');
  // Budanmış ya da hiç yazılmamış koşu: "not run".
  if (kosuDizini.durum === 'yok') return { ...ortak, verdict: 'not_run', steps: planSatirlari(test) };
  const okunamadi = (not: string): RaporTesti => ({
    ...ortak, verdict: 'inconclusive', runId, note: not, steps: planSatirlari(test),
  });
  if (kosuDizini.durum === 'erisilemez') {
    return okunamadi('The run directory could not be accessed (permission denied), so its data was not read.');
  }
  if (kosuDizini.durum === 'guvensiz') {
    return okunamadi('The run directory is a symlink or not a directory, so its data was not read.');
  }
  const kayit = await kobayJsonOku(dizin, ['runs', runId, 'result.json'], KosuSonucuSemasi);
  if (kayit.durum !== 'tamam') {
    return okunamadi('The run record (result.json) is missing, unreadable or not valid, so the outcome of this run is unknown.');
  }
  const kosu: KosuSonucu = kayit.deger;
  if (kosu.runId !== runId || kosu.testId !== test.id) {
    return okunamadi('The run record belongs to a different test or run, so it was not used.');
  }

  const adimOkuma = await kobayJsonOku(dizin, ['runs', runId, 'steps.json'], v.array(AdimSonucuSemasi));
  // Eksik ya da bozuk steps.json raporu düşürmez: adım tablosu plan adımlarıyla kalır.
  const kosuAdimlari: AdimSonucu[] = adimOkuma.durum === 'tamam' ? adimOkuma.deger : [];
  const gercekKosu = await gercekKosuDizini(dizin, runId);
  const adimHaritasi = new Map<number, AdimSonucu>();
  for (const adim of kosuAdimlari) {
    if (Number.isInteger(adim.stepIndex) && adim.stepIndex >= 0 && !adimHaritasi.has(adim.stepIndex)) {
      adimHaritasi.set(adim.stepIndex, adim);
    }
  }
  const indeksler = [...new Set([...test.planSteps.keys(), ...adimHaritasi.keys()])].sort((a, b) => a - b);
  const satirlar: RaporAdimi[] = [];
  for (const indeks of indeksler) {
    const plan = test.planSteps[indeks];
    const adim = adimHaritasi.get(indeks);
    const numara = gercekKosu === null ? null : ekranGoruntusuNumarasi(adim?.screenshotPath);
    const screenshot = numara === null || gercekKosu === null
      ? null
      : await gorseller.yaz(dizin, runId, gercekKosu, numara);
    const aciklama = plan?.description ?? adim?.description;
    const tur = plan?.type;
    satirlar.push({
      index: indeks,
      ...(aciklama === undefined ? {} : { description: aciklama }),
      ...(tur === undefined ? {} : { type: tur }),
      ...(adim === undefined ? {} : { status: adim.status, durationMs: adim.durationMs }),
      ...(adim?.errorMessage === undefined ? {} : { errorMessage: adim.errorMessage }),
      ...(screenshot === null ? {} : { screenshot }),
    });
  }

  const paket = kosu.verdict === 'failed' ? await kosununHataPaketi(dizin, test.id, runId) : null;
  const sure = Date.parse(kosu.finishedAt) - Date.parse(kosu.startedAt);
  return {
    ...ortak,
    verdict: kosu.verdict,
    runId,
    runCodeVersion: kosu.codeVersion,
    ...(kosu.failedStepIndex === undefined ? {} : { failedStepIndex: kosu.failedStepIndex }),
    startedAt: kosu.startedAt,
    finishedAt: kosu.finishedAt,
    ...(Number.isFinite(sure) && sure >= 0 ? { durationMs: sure } : {}),
    ...(kosu.failureKind === undefined ? {} : { failureKind: kosu.failureKind }),
    ...(kosu.errorMessage === undefined ? {} : { errorMessage: kosu.errorMessage }),
    steps: satirlar,
    ...(paket === null ? {} : {
      failure: {
        rootCauseHypothesis: paket.failure.rootCauseHypothesis,
        recommendedFixTarget: {
          kind: paket.failure.recommendedFixTarget.kind,
          reference: paket.failure.recommendedFixTarget.reference,
          rationale: paket.failure.recommendedFixTarget.rationale,
        },
        // Kanıtın dosya yolu rapora girmez; yalnız tür, adım ve özet.
        evidence: paket.failure.evidence.map((kanit) => ({
          kind: kanit.kind,
          stepIndex: kanit.stepIndex,
          summary: kanit.summary,
        })),
      },
    }),
  };
}

function sayimlariHesapla(testler: RaporTesti[]): RaporSayimlari {
  const sayim: RaporSayimlari = { passed: 0, failed: 0, blocked: 0, inconclusive: 0, notRun: 0 };
  for (const test of testler) {
    if (test.verdict === 'not_run') sayim.notRun += 1;
    else sayim[test.verdict] += 1;
  }
  return sayim;
}

export { adresKimligiGizle };

/** Proje adresi `config.json`'dan symlink/sert bağ izlenmeden okunur; okunamazsa `unknown`. */
async function guvenliBaseUrl(dizin: KobayDizini): Promise<string> {
  const okuma = await kobayJsonOku(dizin, ['config.json'], KobayConfigSemasi);
  return okuma.durum === 'tamam' ? adresKimligiGizle(okuma.deger.baseUrl) : 'unknown';
}

/**
 * kobay'ın kendi kurulum kökü (`dist/rapor/index.js` ya da `src/rapor/index.ts`
 * iki üstü). Hata yığınındaki kobay/Playwright çerçeveleri buradan gelir; CI'da
 * global kurulum ev dizini dışındadır (`/opt/hostedtoolcache/...`), yer tutucu
 * olmadan mutlak yol PR yorumuna giderdi.
 */
const KOBAY_KOKU = fileURLToPath(new URL('../../', import.meta.url));

/** Raporda yer tutucuyla değiştirilecek yerel kökler: proje kökü (gerçek yolu da), kobay kurulumu ve ev dizini. */
async function yerelKokler(dizin: KobayDizini): Promise<Array<{ yol: string; yerTutucu: string }>> {
  const kokler = [{ yol: dizin.projeKoku, yerTutucu: '[project]' }];
  const gercek = await realpath(dizin.projeKoku).catch(() => dizin.projeKoku);
  if (gercek !== dizin.projeKoku) kokler.push({ yol: gercek, yerTutucu: '[project]' });
  kokler.push({ yol: KOBAY_KOKU, yerTutucu: '[kobay]' });
  const gercekKobay = await realpath(KOBAY_KOKU).catch(() => KOBAY_KOKU);
  if (gercekKobay.replace(/[\\/]+$/, '') !== KOBAY_KOKU.replace(/[\\/]+$/, '')) kokler.push({ yol: gercekKobay, yerTutucu: '[kobay]' });
  kokler.push({ yol: homedir(), yerTutucu: '~' });
  return kokler;
}

/**
 * Seçilen testlerin son koşularından statik HTML raporu üretir ve `hedef`
 * klasörüne atomik olarak yayımlar. Yalnız diskte olanı okur (symlink izlemeden);
 * tarayıcı, beyin ya da ağ çağrısı yok.
 *
 * Yayım: içerik hedefin yanındaki geçici klasöre yazılır (görüntüler okunur
 * okunmaz), sonra `klasoruYayimla` ile yerine konur. Dolu hedef yalnız yapısal
 * olarak kobay raporuysa değiştirilir; kenara alınan eski klasörler `rm -r`
 * olmadan, yalnız beklenen adlar tek tek silinerek kaldırılır.
 */
export async function raporUret(secenek: {
  dizin: KobayDizini;
  testler: readonly TestKaydi[];
  hedef: string;
  surum: string;
  /** Varsayılan `.kobay/report` hedefinde `.kobay` ve `report` ayrıca symlink denetiminden geçer. */
  varsayilanHedef: boolean;
  /** Verilirse aynı veriden Markdown özet de üretilir (`--summary`). */
  ozet?: { maxIstem: number };
}): Promise<RaporSonucu> {
  const { dizin, hedef } = secenek;
  const varsayilanDenetimi = async (): Promise<void> => {
    if (!secenek.varsayilanHedef) return;
    await guvenliKokuBul(dizin.kok, 'report', (yol, sebep) => new UnsafeReportPath(yol, sebep));
  };
  await varsayilanDenetimi();
  await raporHedefiniDenetle(hedef, secenek.varsayilanHedef);

  const ust = dirname(hedef);
  await mkdir(ust, { recursive: true });
  const gecici = join(ust, `${YAYIM_ONEKI}tmp-${randomUUID()}`);
  await mkdir(gecici, { recursive: false });
  const gorseller = new GorselYazici(gecici);
  let testler: RaporTesti[];
  let counts: RaporSayimlari;
  let fixPrompts: Array<{ id: string; prompt: string }> = [];
  let fixAllPrompt: string | null = null;
  let adTemizle: (metin: string) => string = (metin) => metin;
  let summaryMarkdown: string | undefined;
  try {
    testler = [];
    for (const test of secenek.testler) testler.push(await testiTopla(dizin, test, gorseller));
    counts = sayimlariHesapla(testler);
    const uretimZamani = new Date().toISOString();
    const baseUrl = await guvenliBaseUrl(dizin);
    const kokler = await yerelKokler(dizin);
    const htmlMetni = raporHtml({ baseUrl, generatedAt: uretimZamani, version: secenek.surum, tests: testler, counts }, kokler);
    // İstemler değer değer temizlenmiş gelir (istem.ts); bütün metne ikinci maske uygulanmaz.
    const istemBaglami = { baseUrl, temizle: (metin: string) => metniTemizle(metin, kokler) };
    adTemizle = (metin) => metniTemizle(metin, kokler);
    fixPrompts = testler.filter(dikkatGerekenMi).map((test) => ({
      id: test.id,
      prompt: duzeltmeIstemi(test, istemBaglami),
    }));
    fixAllPrompt = hepsiniDuzeltIstemi(testler, istemBaglami);
    if (secenek.ozet !== undefined) {
      // Özet aynı, değer değer temizlenmiş istemleri kullanır; ad hücreleri de tek tek temizlenir.
      summaryMarkdown = ozetMarkdown({
        testler,
        counts,
        surum: secenek.surum,
        fixPrompts,
        ...(fixAllPrompt === null ? {} : { fixAllPrompt }),
        temizle: istemBaglami.temizle,
        maxIstem: secenek.ozet.maxIstem,
      });
    }
    await writeFile(altYol(gecici, 'index.html'), htmlMetni, { flag: 'wx' });
    await writeFile(altYol(gecici, RAPOR_ISARETI), `${JSON.stringify({
      generator: 'kobay',
      format: ISARET_BICIMI,
      formatVersion: 1,
      kobayVersion: secenek.surum,
      generatedAt: uretimZamani,
    }, null, 2)}\n`, { flag: 'wx' });
    // Hazırlık sürerken hedef değişmiş olabilir: yayımdan hemen önce yeniden denetle.
    await varsayilanDenetimi();
    await raporHedefiniDenetle(hedef, secenek.varsayilanHedef);
  } catch (hata: unknown) {
    if (!(await raporAgaciniSil(gecici, 'gecici'))) {
      process.stderr.write(`[kobay] Warning: the temporary report folder could not be removed: ${terminaleGuvenli(gecici)}\n`);
    }
    throw hata;
  }

  const birakilan: string[] = [];
  let eskiler: string[];
  try {
    eskiler = await klasoruYayimla({
      kaynak: gecici,
      hedef,
      eskiYolu: () => join(ust, `${YAYIM_ONEKI}old-${randomUUID()}`),
      eskileriSil: async (yollar) => {
        birakilan.push(...await eskiRaporlariSil(ust, yollar));
      },
      tamamMi: raporKlasoruMu,
      tukendi: () => new Error(`Report could not be published: ${terminaleGuvenli(hedef)}`),
    });
  } catch (hata: unknown) {
    // Kenara alınmış klasörlerin yolu kaybolmasın: mesajda yazsın.
    const korunan = hata instanceof PublishCleanupFailed && hata.keptAt !== undefined ? [hata.keptAt] : [];
    const yollar = [...new Set([...korunan, ...birakilan])];
    if (yollar.length === 0) throw hata;
    const mesaj = hata instanceof Error ? hata.message : String(hata);
    throw new Error(
      terminaleGuvenli(`${mesaj}. Folders set aside during publishing were kept: ${yollar.join(', ')}`),
      { cause: hata },
    );
  }
  birakilan.push(...await eskiRaporlariSil(ust, eskiler));

  return {
    reportDir: hedef,
    indexPath: join(hedef, 'index.html'),
    tests: testler.map((test) => ({
      id: test.id,
      // Test adı kullanıcı/beyin kaynaklı: JSON'da da maskeli ve yolları gizli.
      name: adTemizle(test.name),
      verdict: test.verdict,
      ...(test.runId === undefined ? {} : { runId: test.runId }),
    })),
    counts,
    screenshots: gorseller.sayi,
    keptAside: birakilan,
    fixPrompts,
    ...(fixAllPrompt === null ? {} : { fixAllPrompt }),
    ...(summaryMarkdown === undefined ? {} : { summaryMarkdown }),
  };
}
