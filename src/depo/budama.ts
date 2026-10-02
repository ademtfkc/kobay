import {
  lstat, readdir, readFile, realpath, rm, unlink,
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import * as v from 'valibot';
import { KosuSonucuSemasi } from './semalar.js';
import type { KosuSonucu } from './tipler.js';
import type { KobayDizini } from './dizin.js';

export const VARSAYILAN_BUDAMA_GUNU = 7;
export const VARSAYILAN_AZAMI_MB = 500;
export const BUDAMADA_SAKLANAN_KOSU = 5;
export const BUDAMADA_TAZE_MS = 10 * 60 * 1000;

const TEST_KIMLIGI = /^t_[a-z0-9]{8}$/;
const KOSU_KIMLIGI = /^r_\d{14}_[a-z0-9]{4}$/;
const ESKI_HATA_PAKETI = /^t_[a-z0-9]{8}-\d+$/;
/**
 * `hataPaketiYaz`'ın kenara aldığı eski paket: `.stale-<testId>-<ms>-<uuid>`.
 * `<ms>` kenara alınma anıdır; yoksa (0.2.0 biçimi) yaş dizinin mtime'ından okunur.
 */
const ESKI_HATA_ARTIGI = /^\.stale-t_[a-z0-9]{8}-(?:(\d{1,15})-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BEYIN_GUNLUGU = /^(?:brain|beyin)-.+\.log$/;
const ESKI_KOK_DOSYASI = /^(?:adim-\d+\.(?:html|png)|console\.json|code\.ts|failure\.json|meta\.json|network\.json|pw-rapor\.json|result\.json|steps\.json|trace\.zip)$/;
const BILINEN_HATA_DOSYASI = /^(?:(?:step|adim)-\d+\.(?:html|png)|console\.json|code\.ts|failure\.json|meta\.json|network\.json|pw-(?:report|rapor)\.json|result\.json|steps\.json|trace\.zip)$/;

export class UnsafePrunePath extends Error {
  constructor(yol: string, sebep: string) {
    super(`Unsafe prune path: ${yol} (${sebep}). Remove the link or file and run the command again.`);
    this.name = 'UnsafePrunePath';
  }
}

export interface DepoBudamaSecenekleri {
  dryRun?: boolean;
  maxMb?: number;
  olderThanDays?: number;
}

export type BudamaOgesiTuru =
  | 'run'
  | 'brain-log'
  | 'stale-failure-bundle'
  | 'legacy-failure-bundle'
  | 'legacy-failure-file'
  | 'legacy-root-file';

export interface BudamaOgesi {
  path: string;
  kind: BudamaOgesiTuru;
  bytes: number;
  reason: 'retention' | 'age' | 'size-limit' | 'legacy';
}

export interface AtlananBudamaOgesi {
  path: string;
  reason: 'unrecognized-failure-out-file' | 'too-recent';
}

export interface DepoBudamaSonucu {
  dryRun: boolean;
  estimate: boolean;
  policy: {
    maxMb: number;
    olderThanDays: number;
    keepRunsPerTest: number;
    freshMinutes: number;
  };
  deleted: BudamaOgesi[];
  wouldDelete: BudamaOgesi[];
  skipped: AtlananBudamaOgesi[];
  reclaimedBytes: number;
  reclaimedMb: number;
  wouldReclaimBytes: number;
  wouldReclaimMb: number;
  runBytesBefore: number;
  runBytesAfter: number;
  maxRunBytes: number;
  runLimitExceeded: boolean;
}

interface GuvenliKok {
  yol: string;
  gercek: string;
}

interface KosuKaydi {
  yol: string;
  boyut: number;
  sonuc: KosuSonucu;
}

interface Aday extends BudamaOgesi {
  yol: string;
  kok: GuvenliKok;
  hedef: 'file' | 'directory' | 'link';
  run?: KosuKaydi;
}

function hataKodu(hata: unknown): string | undefined {
  return typeof hata === 'object' && hata !== null && 'code' in hata && typeof hata.code === 'string'
    ? hata.code
    : undefined;
}

function kokIcindeMi(kok: string, yol: string): boolean {
  const fark = relative(kok, yol);
  return fark === '' || (fark !== '..' && !fark.startsWith(`..${sep}`) && !isAbsolute(fark));
}

function genelYol(projeKoku: string, yol: string): string {
  return relative(projeKoku, yol).split(sep).join('/');
}

function mb(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function zaman(metin: string): number {
  const sonuc = Date.parse(metin);
  return Number.isFinite(sonuc) ? sonuc : Number.POSITIVE_INFINITY;
}

/**
 * Kenara alınmış paketin yaşı için referans an. Rename dizinin mtime'ını
 * yenilemediği için yeni biçimde ad içindeki kenara alınma anı esas alınır.
 */
function eskiPaketAni(ad: string, mtimeMs: number): number {
  const an = ESKI_HATA_ARTIGI.exec(ad)?.[1];
  return an === undefined ? mtimeMs : Number(an);
}

function metinSirala(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function guvenliKok(kobayKoku: GuvenliKok, ad: string): Promise<GuvenliKok> {
  const yol = join(kobayKoku.yol, ad);
  const bilgi = await lstat(yol);
  if (bilgi.isSymbolicLink() || !bilgi.isDirectory()) {
    throw new UnsafePrunePath(yol, `${ad} is not a real directory`);
  }
  const gercek = await realpath(yol);
  if (!kokIcindeMi(kobayKoku.gercek, gercek)) {
    throw new UnsafePrunePath(yol, `its real path is outside ${kobayKoku.yol}`);
  }
  return { yol, gercek };
}

async function kokleriDogrula(dizin: KobayDizini): Promise<{
  kobay: GuvenliKok;
  tests: GuvenliKok;
  runs: GuvenliKok;
  failure: GuvenliKok;
  failureOut: GuvenliKok;
  logs: GuvenliKok;
}> {
  const bilgi = await lstat(dizin.kok);
  if (bilgi.isSymbolicLink() || !bilgi.isDirectory()) {
    throw new UnsafePrunePath(dizin.kok, '.kobay is not a real directory');
  }
  const kobay = { yol: dizin.kok, gercek: await realpath(dizin.kok) };
  return {
    kobay,
    tests: await guvenliKok(kobay, 'tests'),
    runs: await guvenliKok(kobay, 'runs'),
    failure: await guvenliKok(kobay, 'failure'),
    failureOut: await guvenliKok(kobay, 'failure-out'),
    logs: await guvenliKok(kobay, 'logs'),
  };
}

/** Counts on-disk bytes without following a symlink target. */
async function yolBoyutu(yol: string): Promise<number> {
  const bilgi = await lstat(yol);
  if (!bilgi.isDirectory() || bilgi.isSymbolicLink()) return bilgi.size;
  const adlar = (await readdir(yol)).sort(metinSirala);
  let toplam = bilgi.size;
  for (const ad of adlar) toplam += await yolBoyutu(join(yol, ad));
  return toplam;
}

async function kosuSonucuOku(yol: string): Promise<KosuSonucu | null> {
  try {
    const ham = JSON.parse(await readFile(join(yol, 'result.json'), 'utf8')) as unknown;
    return v.parse(KosuSonucuSemasi, ham);
  } catch {
    return null;
  }
}

async function testKimlikleri(tests: GuvenliKok): Promise<Set<string>> {
  const girdiler = await readdir(tests.yol, { withFileTypes: true });
  return new Set(girdiler
    .filter((girdi) => girdi.isFile() && girdi.name.endsWith('.json'))
    .map((girdi) => girdi.name.slice(0, -'.json'.length))
    .filter((ad) => TEST_KIMLIGI.test(ad)));
}

async function kosulariOku(runs: GuvenliKok): Promise<KosuKaydi[]> {
  const girdiler = (await readdir(runs.yol, { withFileTypes: true }))
    .filter((girdi) => girdi.isDirectory() && KOSU_KIMLIGI.test(girdi.name))
    .sort((a, b) => metinSirala(a.name, b.name));
  const sonuc: KosuKaydi[] = [];
  for (const girdi of girdiler) {
    const yol = join(runs.yol, girdi.name);
    const gercek = await realpath(yol);
    if (!kokIcindeMi(runs.gercek, gercek)) throw new UnsafePrunePath(yol, 'run resolves outside .kobay/runs');
    const kosu = await kosuSonucuOku(yol);
    if (kosu === null || kosu.runId !== girdi.name || !TEST_KIMLIGI.test(kosu.testId)) continue;
    sonuc.push({ yol, boyut: await yolBoyutu(yol), sonuc: kosu });
  }
  return sonuc;
}

async function kokIcerikBoyutu(kok: GuvenliKok): Promise<number> {
  const adlar = (await readdir(kok.yol)).sort(metinSirala);
  let toplam = 0;
  for (const ad of adlar) toplam += await yolBoyutu(join(kok.yol, ad));
  return toplam;
}

async function paketKosusu(failure: GuvenliKok, testId: string): Promise<string | undefined> {
  const paketDizini = join(failure.yol, testId);
  try {
    const bilgi = await lstat(paketDizini);
    if (bilgi.isSymbolicLink() || !bilgi.isDirectory()) return undefined;
    const gercek = await realpath(paketDizini);
    if (!kokIcindeMi(failure.gercek, gercek)) return undefined;
    const veri = JSON.parse(await readFile(join(paketDizini, 'failure.json'), 'utf8')) as unknown;
    if (typeof veri !== 'object' || veri === null || !('runId' in veri)) return undefined;
    return typeof veri.runId === 'string' && KOSU_KIMLIGI.test(veri.runId) ? veri.runId : undefined;
  } catch {
    return undefined;
  }
}

function gruplandir(kosular: KosuKaydi[]): Map<string, KosuKaydi[]> {
  const gruplar = new Map<string, KosuKaydi[]>();
  for (const kosu of kosular) {
    const grup = gruplar.get(kosu.sonuc.testId) ?? [];
    grup.push(kosu);
    gruplar.set(kosu.sonuc.testId, grup);
  }
  for (const grup of gruplar.values()) {
    grup.sort((a, b) => zaman(a.sonuc.startedAt) - zaman(b.sonuc.startedAt)
      || metinSirala(a.sonuc.runId, b.sonuc.runId));
  }
  return gruplar;
}

async function korunanKosular(
  gruplar: Map<string, KosuKaydi[]>,
  testler: Set<string>,
  failure: GuvenliKok,
  simdi: number,
): Promise<Set<string>> {
  const korunan = new Set<string>();
  for (const [testId, kosular] of gruplar) {
    if (testler.has(testId)) {
      for (const kosu of kosular.slice(-BUDAMADA_SAKLANAN_KOSU)) korunan.add(kosu.sonuc.runId);
    }
    const sonBasarisiz = kosular.findLast((kosu) => kosu.sonuc.verdict === 'failed');
    if (sonBasarisiz !== undefined) korunan.add(sonBasarisiz.sonuc.runId);
    const paket = await paketKosusu(failure, testId);
    if (paket !== undefined) korunan.add(paket);
    for (const kosu of kosular) {
      const bitis = Date.parse(kosu.sonuc.finishedAt);
      if (!Number.isFinite(bitis) || bitis >= simdi - BUDAMADA_TAZE_MS) korunan.add(kosu.sonuc.runId);
    }
  }
  return korunan;
}

function kosuAdayi(
  dizin: KobayDizini,
  runs: GuvenliKok,
  kosu: KosuKaydi,
  reason: BudamaOgesi['reason'],
): Aday {
  return {
    yol: kosu.yol,
    kok: runs,
    hedef: 'directory',
    run: kosu,
    path: genelYol(dizin.projeKoku, kosu.yol),
    kind: 'run',
    bytes: kosu.boyut,
    reason,
  };
}

async function dosyaAdaylari(
  dizin: KobayDizini,
  kokler: Awaited<ReturnType<typeof kokleriDogrula>>,
  esik: number,
): Promise<{ adaylar: Aday[]; skipped: AtlananBudamaOgesi[] }> {
  const adaylar: Aday[] = [];
  const skipped: AtlananBudamaOgesi[] = [];
  const loglar = (await readdir(kokler.logs.yol, { withFileTypes: true }))
    .filter((girdi) => (girdi.isFile() || girdi.isSymbolicLink()) && BEYIN_GUNLUGU.test(girdi.name))
    .sort((a, b) => metinSirala(a.name, b.name));
  for (const girdi of loglar) {
    const yol = join(kokler.logs.yol, girdi.name);
    const bilgi = await lstat(yol);
    if (bilgi.mtimeMs >= esik) continue;
    adaylar.push({
      yol,
      kok: kokler.logs,
      hedef: bilgi.isSymbolicLink() ? 'link' : 'file',
      path: genelYol(dizin.projeKoku, yol),
      kind: 'brain-log',
      bytes: bilgi.size,
      reason: 'age',
    });
  }

  const failure = (await readdir(kokler.failure.yol, { withFileTypes: true }))
    .filter((girdi) => ESKI_HATA_ARTIGI.test(girdi.name) && (girdi.isDirectory() || girdi.isSymbolicLink()))
    .sort((a, b) => metinSirala(a.name, b.name));
  for (const girdi of failure) {
    const yol = join(kokler.failure.yol, girdi.name);
    const bilgi = await lstat(yol);
    if (eskiPaketAni(girdi.name, bilgi.mtimeMs) >= esik) continue;
    adaylar.push({
      yol,
      kok: kokler.failure,
      hedef: bilgi.isSymbolicLink() ? 'link' : 'directory',
      path: genelYol(dizin.projeKoku, yol),
      kind: 'stale-failure-bundle',
      bytes: await yolBoyutu(yol),
      reason: 'age',
    });
  }

  const failureOut = (await readdir(kokler.failureOut.yol, { withFileTypes: true }))
    .sort((a, b) => metinSirala(a.name, b.name));
  for (const girdi of failureOut) {
    const eskiPaket = ESKI_HATA_PAKETI.test(girdi.name) && (girdi.isDirectory() || girdi.isSymbolicLink());
    const duzDosya = (girdi.isFile() || girdi.isSymbolicLink()) && BILINEN_HATA_DOSYASI.test(girdi.name);
    if ((girdi.isFile() || girdi.isSymbolicLink()) && !duzDosya) {
      skipped.push({
        path: genelYol(dizin.projeKoku, join(kokler.failureOut.yol, girdi.name)),
        reason: 'unrecognized-failure-out-file',
      });
    }
    if (!eskiPaket && !duzDosya) continue;
    const yol = join(kokler.failureOut.yol, girdi.name);
    // Bilinen adı taşıyan düz dosya kullanıcının kendi dosyası da olabilir:
    // yalnız yaş eşiğinden eskiyse eski sürüm artığı sayılır.
    if (duzDosya && (await lstat(yol)).mtimeMs >= esik) {
      skipped.push({ path: genelYol(dizin.projeKoku, yol), reason: 'too-recent' });
      continue;
    }
    adaylar.push({
      yol,
      kok: kokler.failureOut,
      hedef: girdi.isSymbolicLink() ? 'link' : girdi.isDirectory() ? 'directory' : 'file',
      path: genelYol(dizin.projeKoku, yol),
      kind: eskiPaket ? 'legacy-failure-bundle' : 'legacy-failure-file',
      bytes: await yolBoyutu(yol),
      reason: 'legacy',
    });
  }

  const kokGirdileri = (await readdir(kokler.kobay.yol, { withFileTypes: true }))
    .filter((girdi) => (girdi.isFile() || girdi.isSymbolicLink()) && ESKI_KOK_DOSYASI.test(girdi.name))
    .sort((a, b) => metinSirala(a.name, b.name));
  for (const girdi of kokGirdileri) {
    const yol = join(kokler.kobay.yol, girdi.name);
    const bilgi = await lstat(yol);
    adaylar.push({
      yol,
      kok: kokler.kobay,
      hedef: bilgi.isSymbolicLink() ? 'link' : 'file',
      path: genelYol(dizin.projeKoku, yol),
      kind: 'legacy-root-file',
      bytes: bilgi.size,
      reason: 'legacy',
    });
  }
  return { adaylar, skipped };
}

async function kosuHalaKorunuyorMu(
  aday: KosuKaydi,
  kokler: Awaited<ReturnType<typeof kokleriDogrula>>,
  simdi: number,
): Promise<boolean> {
  const guncel = await kosuSonucuOku(aday.yol);
  if (guncel === null || guncel.runId !== aday.sonuc.runId || guncel.testId !== aday.sonuc.testId) return true;
  const bitis = Date.parse(guncel.finishedAt);
  if (!Number.isFinite(bitis) || bitis >= simdi - BUDAMADA_TAZE_MS) return true;
  if (await paketKosusu(kokler.failure, guncel.testId) === guncel.runId) return true;

  const testYolu = join(kokler.tests.yol, `${guncel.testId}.json`);
  const testVar = await lstat(testYolu).then((bilgi) => bilgi.isFile(), () => false);
  const girdiler = (await readdir(kokler.runs.yol, { withFileTypes: true }))
    .filter((girdi) => girdi.isDirectory() && KOSU_KIMLIGI.test(girdi.name));
  const ayniTest: KosuSonucu[] = [];
  for (const girdi of girdiler) {
    const sonuc = await kosuSonucuOku(join(kokler.runs.yol, girdi.name));
    if (sonuc?.testId === guncel.testId && sonuc.runId === girdi.name) ayniTest.push(sonuc);
  }
  ayniTest.sort((a, b) => zaman(a.startedAt) - zaman(b.startedAt) || metinSirala(a.runId, b.runId));
  if (testVar && ayniTest.slice(-BUDAMADA_SAKLANAN_KOSU).some((kosu) => kosu.runId === guncel.runId)) return true;
  return ayniTest.findLast((kosu) => kosu.verdict === 'failed')?.runId === guncel.runId;
}

async function adayiSil(aday: Aday): Promise<number | null> {
  let bilgi;
  try {
    bilgi = await lstat(aday.yol);
  } catch (hata: unknown) {
    if (hataKodu(hata) === 'ENOENT') return null;
    throw hata;
  }
  if (aday.hedef === 'directory') {
    if (bilgi.isSymbolicLink() || !bilgi.isDirectory()) return null;
    const gercek = await realpath(aday.yol);
    if (!kokIcindeMi(aday.kok.gercek, gercek)) {
      throw new UnsafePrunePath(aday.yol, 'candidate resolves outside its managed directory');
    }
    const bytes = await yolBoyutu(aday.yol);
    await rm(aday.yol, { recursive: true, force: false });
    return bytes;
  }
  if (bilgi.isDirectory() && !bilgi.isSymbolicLink()) return null;
  await unlink(aday.yol);
  return bilgi.size;
}

export async function depoyuBuda(
  dizin: KobayDizini,
  secenekler: DepoBudamaSecenekleri = {},
): Promise<DepoBudamaSonucu> {
  const dryRun = secenekler.dryRun ?? false;
  const maxMb = secenekler.maxMb ?? VARSAYILAN_AZAMI_MB;
  const olderThanDays = secenekler.olderThanDays ?? VARSAYILAN_BUDAMA_GUNU;
  const maxRunBytes = Math.floor(maxMb * 1024 * 1024);
  const simdi = Date.now();
  const esik = simdi - olderThanDays * 24 * 60 * 60 * 1000;
  const kokler = await kokleriDogrula(dizin);
  const testler = await testKimlikleri(kokler.tests);
  const kosular = await kosulariOku(kokler.runs);
  const gruplar = gruplandir(kosular);
  const korunan = await korunanKosular(gruplar, testler, kokler.failure, simdi);
  const adayHaritasi = new Map<string, Aday>();

  for (const [testId, grup] of gruplar) {
    for (const kosu of grup) {
      if (korunan.has(kosu.sonuc.runId)) continue;
      if (testler.has(testId)) {
        adayHaritasi.set(kosu.yol, kosuAdayi(dizin, kokler.runs, kosu, 'retention'));
      } else if (zaman(kosu.sonuc.finishedAt) < esik) {
        adayHaritasi.set(kosu.yol, kosuAdayi(dizin, kokler.runs, kosu, 'age'));
      }
    }
  }

  // The limit counts incomplete and unknown entries under runs/, not only
  // directories with a readable result.json. Unsafe entries are kept; the
  // result reports when they and protected evidence keep usage over the cap.
  const runBytesBefore = await kokIcerikBoyutu(kokler.runs);
  let tahminiRunBytes = runBytesBefore;
  for (const aday of adayHaritasi.values()) tahminiRunBytes -= aday.bytes;
  if (tahminiRunBytes > maxRunBytes) {
    const sirali = [...kosular].sort((a, b) => zaman(a.sonuc.finishedAt) - zaman(b.sonuc.finishedAt)
      || metinSirala(a.sonuc.runId, b.sonuc.runId));
    for (const kosu of sirali) {
      if (tahminiRunBytes <= maxRunBytes) break;
      if (korunan.has(kosu.sonuc.runId) || adayHaritasi.has(kosu.yol)) continue;
      const aday = kosuAdayi(dizin, kokler.runs, kosu, 'size-limit');
      adayHaritasi.set(kosu.yol, aday);
      tahminiRunBytes -= aday.bytes;
    }
  }

  const dosyalar = await dosyaAdaylari(dizin, kokler, esik);
  for (const aday of dosyalar.adaylar) adayHaritasi.set(aday.yol, aday);
  const adaylar = [...adayHaritasi.values()].sort((a, b) => metinSirala(a.path, b.path));
  const uygulanan: BudamaOgesi[] = [];
  let silinenRunBytes = 0;
  for (const aday of adaylar) {
    if (aday.run !== undefined && await kosuHalaKorunuyorMu(aday.run, kokler, Date.now())) continue;
    if (aday.kind === 'brain-log' || aday.kind === 'stale-failure-bundle' || aday.kind === 'legacy-failure-file') {
      const ad = basename(aday.yol);
      const halaEski = await lstat(aday.yol).then(
        (bilgi) => (aday.kind === 'stale-failure-bundle' ? eskiPaketAni(ad, bilgi.mtimeMs) : bilgi.mtimeMs) < esik,
        () => false,
      );
      if (!halaEski) continue;
    }
    const silinenBytes = dryRun ? aday.bytes : await adayiSil(aday);
    if (silinenBytes === null) continue;
    const { path, kind, reason } = aday;
    const bytes = silinenBytes;
    uygulanan.push({ path, kind, bytes, reason });
    if (kind === 'run') silinenRunBytes += bytes;
  }

  const toplam = uygulanan.reduce((sonuc, aday) => sonuc + aday.bytes, 0);
  const runBytesAfter = dryRun
    ? Math.max(0, runBytesBefore - silinenRunBytes)
    : await kokIcerikBoyutu(kokler.runs);
  return {
    dryRun,
    estimate: dryRun,
    policy: {
      maxMb,
      olderThanDays,
      keepRunsPerTest: BUDAMADA_SAKLANAN_KOSU,
      freshMinutes: BUDAMADA_TAZE_MS / 60_000,
    },
    deleted: dryRun ? [] : uygulanan,
    wouldDelete: dryRun ? uygulanan : [],
    skipped: dosyalar.skipped,
    reclaimedBytes: dryRun ? 0 : toplam,
    reclaimedMb: dryRun ? 0 : mb(toplam),
    wouldReclaimBytes: dryRun ? toplam : 0,
    wouldReclaimMb: dryRun ? mb(toplam) : 0,
    runBytesBefore,
    runBytesAfter,
    maxRunBytes,
    runLimitExceeded: runBytesAfter > maxRunBytes,
  };
}
