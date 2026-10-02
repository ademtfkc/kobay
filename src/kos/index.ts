import { access, readFile, readdir, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, relative, sep, type PlatformPath } from 'node:path';
import {
  yeniRunId,
  yazAtomik,
  type AdimSonucu,
  type KobayDizini,
  type KosuSonucu,
  type TestKaydi,
} from '../depo/index.js';
import { kaliciCalismaAlaniHazirla } from './calisma-alani.js';
import { testSureciOrtami } from './ortam.js';
import { raporuAyristir } from './rapor.js';
import { kobayOlurkenAgaciOldur, sureciSonlandir } from '../ortak/komut-coz.js';
import { gizliDegerleriMaskele } from '../beyin/ortak.js';

export { FixtureModuleMissing, fixtureYenidenAktarimMetni, kaliciCalismaAlaniHazirla } from './calisma-alani.js';
export { testSureciOrtami } from './ortam.js';
export { hataMetniniTemizle, raporuAyristir, type PlaywrightRaporSonucu } from './rapor.js';

export interface KosturmaAyari {
  baseUrl: string;
  storageStateYolu?: string;
  testZamanAsimiMs?: number;
}

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');

async function dosyaVarMi(yol: string): Promise<boolean> {
  try {
    await access(yol);
    return true;
  } catch {
    return false;
  }
}

function jsonMetni(veri: unknown): string {
  return `${JSON.stringify(veri, null, 2)}\n`;
}

function simdi(): string {
  return new Date().toISOString();
}

/**
 * Playwright hatası ve stderr, testin yazdığı ya da sayfanın gösterdiği gizli değeri
 * (API anahtarı, token) taşıyabilir: result.json/steps.json'a ve `test_result`/`test_run`
 * çıktısına girmeden önce maskelenir.
 */
function sonucuMaskele(sonuc: KosuSonucu): KosuSonucu {
  return sonuc.errorMessage === undefined ? sonuc : { ...sonuc, errorMessage: gizliDegerleriMaskele(sonuc.errorMessage) };
}

function adimlariMaskele(adimlar: AdimSonucu[]): AdimSonucu[] {
  return adimlar.map((adim) => (adim.errorMessage === undefined
    ? adim
    : { ...adim, errorMessage: gizliDegerleriMaskele(adim.errorMessage) }));
}

async function kaydet(
  dizin: KobayDizini,
  test: TestKaydi,
  sonuc: KosuSonucu,
  adimlar: AdimSonucu[],
): Promise<void> {
  const kosuDizini = await dizin.kosuDizini(sonuc.runId);
  await Promise.all([
    yazAtomik(join(kosuDizini, 'steps.json'), jsonMetni(adimlariMaskele(adimlar))),
    dizin.kosuSonucuYaz(sonucuMaskele(sonuc)),
  ]);
  await dizin.testYaz({
    ...test,
    lastRunId: sonuc.runId,
    status: sonuc.status,
    updatedAt: sonuc.finishedAt,
  });
  // Budama burada yapılmaz: koşu motoru sonucu yazınca iş bitmiyor, düşen koşuda
  // hata analizi bu dizindeki kanıtı (DOM, png, konsol, ağ, trace) sonradan okuyor.
  // Eski koşuları komut katmanı, analiz bittikten sonra budar (`cli/komutlar/test.ts`).
}

/** Playwright konumsal filtreyi regex sayar; bu nedenle göreli, `/` ayracılı bir yol verilir. */
export function playwrightSpecArgumani(
  specYolu: string,
  cwd: string,
  yol: Pick<PlatformPath, 'relative' | 'sep'> = { relative, sep },
): string {
  return yol.relative(cwd, specYolu).split(yol.sep).join('/');
}

function kosuSureci(
  specYolu: string,
  configYolu: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  zamanAsimiMs: number,
): Promise<{ zamanAsimi: boolean; stderr: string }> {
  return new Promise((coz) => {
    const specArgumani = playwrightSpecArgumani(specYolu, cwd);
    const surec = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', specArgumani, '--config', configYolu], {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    // Kobay ölürse (SIGINT/SIGTERM) Playwright worker'ı ve Chromium öksüz kalmasın.
    const olumDinleyicisiniKaldir = kobayOlurkenAgaciOldur(surec);
    let stderr = '';
    let bitti = false;
    let oldurmeBasladi = false;
    const bitir = (sonuc: { zamanAsimi: boolean; stderr: string }): void => {
      if (bitti) return;
      bitti = true;
      clearTimeout(zamanlayici);
      olumDinleyicisiniKaldir();
      coz(sonuc);
    };
    const zamanlayici = setTimeout(() => {
      // Kök ölünce `close` gelir; sonucu ağaç tamamen kapanana kadar bu yol verir.
      oldurmeBasladi = true;
      void sureciSonlandir(surec, { agac: true }).finally(() => { bitir({ zamanAsimi: true, stderr }); });
    }, zamanAsimiMs + 30_000);
    surec.stderr.setEncoding('utf8');
    surec.stderr.on('data', (parca: string) => { stderr += parca; });
    surec.once('error', (hata: Error) => bitir({ zamanAsimi: false, stderr: `${stderr}${hata.message}` }));
    surec.once('close', () => { if (!oldurmeBasladi) bitir({ zamanAsimi: false, stderr }); });
  });
}

/** Hedefe HEAD, gerekirse GET ile erişilebildiğini denetler; HTTP hata yanıtı da erişilebilirdir. */
export async function hedefAyaktaMi(url: string, zamanAsimiMs = 3_000): Promise<boolean> {
  for (const method of ['HEAD', 'GET']) {
    try {
      await fetch(url, { method, signal: AbortSignal.timeout(zamanAsimiMs) });
      return true;
    } catch {
      // HEAD reddedilmiş olabilir; GET ile yeniden dene.
    }
  }
  return false;
}

/** Bir üretilmiş Playwright testini izole süreçte çalıştırır ve kanıtlarını kaydeder. */
export async function kostur(
  dizin: KobayDizini,
  test: TestKaydi,
  s: KosturmaAyari,
): Promise<{ sonuc: KosuSonucu; adimlar: AdimSonucu[] }> {
  // Diskteki kayıtla aynı maske dönen değere de uygulanır (komut katmanı result.json'u yeniden yazar).
  const { sonuc, adimlar } = await kosturHam(dizin, test, s);
  return { sonuc: sonucuMaskele(sonuc), adimlar: adimlariMaskele(adimlar) };
}

async function kosturHam(
  dizin: KobayDizini,
  test: TestKaydi,
  s: KosturmaAyari,
): Promise<{ sonuc: KosuSonucu; adimlar: AdimSonucu[] }> {
  const runId = yeniRunId();
  const startedAt = simdi();
  await dizin.kosuDizini(runId);
  const temel = { testId: test.id, runId, startedAt, codeVersion: test.codeVersion };

  if (!(await hedefAyaktaMi(s.baseUrl))) {
    const sonuc: KosuSonucu = { ...temel, status: 'blocked', verdict: 'blocked', finishedAt: simdi() };
    const adimlar: AdimSonucu[] = [];
    await kaydet(dizin, test, sonuc, adimlar);
    return { sonuc, adimlar };
  }

  const specYolu = dizin.kodYolu(test.id);
  if (test.status === 'draft' || !(await dosyaVarMi(specYolu))) {
    const sonuc: KosuSonucu = {
      ...temel, status: 'unknown', verdict: 'inconclusive', finishedAt: simdi(), errorMessage: 'No test code',
    };
    const adimlar: AdimSonucu[] = [];
    await kaydet(dizin, test, sonuc, adimlar);
    return { sonuc, adimlar };
  }

  // Fixture aktif kobay paketine göre burada tazelenir; modül yoksa tarayıcı hiç açılmaz.
  let configYolu: string;
  try {
    ({ configYolu } = await kaliciCalismaAlaniHazirla(dizin.kok));
  } catch (hata: unknown) {
    const sonuc: KosuSonucu = {
      ...temel,
      status: 'unknown',
      verdict: 'inconclusive',
      failureKind: 'env',
      finishedAt: simdi(),
      errorMessage: (hata instanceof Error ? hata.message : String(hata)).slice(0, 2000),
    };
    const adimlar: AdimSonucu[] = [];
    await kaydet(dizin, test, sonuc, adimlar);
    return { sonuc, adimlar };
  }
  const zamanAsimiMs = s.testZamanAsimiMs ?? 120_000;
  const kosuDizini = await dizin.kosuDizini(runId);
  const raporYolu = join(kosuDizini, 'pw-report.json');
  const storageStateYolu = s.storageStateYolu ?? dizin.storageStateYolu();
  // Üretilen kod bu süreçte çalışır: kullanıcının sırları (API anahtarları, KOBAY_LOGIN_PASS…)
  // devredilmez. Oturum storageState dosyasıyla taşınır.
  const env = testSureciOrtami(process.env, {
    KOBAY_BASE_URL: s.baseUrl,
    KOBAY_RUN_DIR: join('runs', runId),
    KOBAY_REPORT_FILE: join('runs', runId, 'pw-report.json'),
    KOBAY_TEST_TIMEOUT_MS: String(zamanAsimiMs),
    // 0.3'te eski adlar kalkar.
    KOBAY_KOSU_DIZINI: join('runs', runId),
    KOBAY_RAPOR_DOSYASI: join('runs', runId, 'pw-report.json'),
    KOBAY_TEST_ZAMAN_ASIMI_MS: String(zamanAsimiMs),
    ...(await dosyaVarMi(storageStateYolu) ? { KOBAY_STORAGE_STATE: storageStateYolu } : {}),
  });
  const calisma = await kosuSureci(specYolu, configYolu, dizin.kok, env, zamanAsimiMs);
  if (calisma.zamanAsimi) {
    const sonuc: KosuSonucu = {
      ...temel, status: 'failed', verdict: 'failed', failureKind: 'env', finishedAt: simdi(), errorMessage: 'Run timed out',
    };
    const adimlar: AdimSonucu[] = [];
    await kaydet(dizin, test, sonuc, adimlar);
    return { sonuc, adimlar };
  }

  if (!(await dosyaVarMi(raporYolu))) {
    const sonuc: KosuSonucu = {
      ...temel, status: 'unknown', verdict: 'inconclusive', finishedAt: simdi(), errorMessage: calisma.stderr.slice(0, 2000),
    };
    const adimlar: AdimSonucu[] = [];
    await kaydet(dizin, test, sonuc, adimlar);
    return { sonuc, adimlar };
  }

  let rapor: unknown;
  try {
    rapor = JSON.parse(await readFile(raporYolu, 'utf8')) as unknown;
  } catch {
    const sonuc: KosuSonucu = {
      ...temel, status: 'unknown', verdict: 'inconclusive', finishedAt: simdi(), errorMessage: calisma.stderr.slice(0, 2000),
    };
    const adimlar: AdimSonucu[] = [];
    await kaydet(dizin, test, sonuc, adimlar);
    return { sonuc, adimlar };
  }
  const ayrismis = await raporuAyristir(rapor, test.planSteps, kosuDizini);
  const dusenAdim = ayrismis.adimlar.find((adim) => adim.status === 'failed');
  const basarisiz = dusenAdim !== undefined || ayrismis.hataMesaji !== undefined;
  // Playwright'ın kendi hatası (hiç test koşmaması dahil) "geçti"yi de "düştü"yü de geçersiz kılar.
  const sonuc: KosuSonucu = ayrismis.motorHatasi === undefined ? {
    ...temel,
    status: basarisiz ? 'failed' : 'passed',
    verdict: basarisiz ? 'failed' : 'passed',
    finishedAt: simdi(),
    ...(dusenAdim === undefined ? {} : { failedStepIndex: dusenAdim.stepIndex }),
    ...(ayrismis.hataMesaji === undefined ? {} : { errorMessage: ayrismis.hataMesaji }),
  } : {
    ...temel,
    status: 'unknown',
    verdict: 'inconclusive',
    failureKind: 'env',
    finishedAt: simdi(),
    errorMessage: [ayrismis.motorHatasi, ayrismis.hataMesaji].filter((metin) => metin !== undefined).join('\n').slice(0, 2000),
  };
  const kaynakTrace = join(kosuDizini, 'pw');
  const traceYolu = await traceBul(kaynakTrace);
  if (traceYolu !== undefined) await rename(traceYolu, join(kosuDizini, 'trace.zip'));
  await kaydet(dizin, test, sonuc, ayrismis.adimlar);
  return { sonuc, adimlar: ayrismis.adimlar };
}

async function traceBul(kok: string): Promise<string | undefined> {
  try {
    const girdiler = await readdir(kok, { withFileTypes: true });
    for (const girdi of girdiler) {
      const yol = join(kok, girdi.name);
      if (girdi.isFile() && girdi.name === 'trace.zip') return yol;
      if (girdi.isDirectory()) {
        const bulundu = await traceBul(yol);
        if (bulundu !== undefined) return bulundu;
      }
    }
  } catch (hata: unknown) {
    if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') return undefined;
    throw hata;
  }
  return undefined;
}
