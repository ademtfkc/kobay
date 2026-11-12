import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { ANALIZ_ATLANDI_BEYIN, KODSUZ_ENGEL_ONEKI, hataAnalizEt } from '../../analiz/index.js';
import { failureKindEtiketi } from '../../rapor/istem.js';
import { BrainError, BrainRuntimeError, beyinOlustur, beyinSinirlari } from '../../beyin/index.js';
import { gizliDegerleriMaskele } from '../../beyin/ortak.js';
import {
  FileNotFound,
  adresKimligiGizle,
  metindekiKimligiGizle,
  SchemaError,
  type HaritaFarki,
  type KobayDizini,
  type KosuSonucu,
  type TestKaydi,
  type Verdict,
  yeniRunId,
} from '../../depo/index.js';
import { girisKuraliIhlali, planDosyasindanTest, planYenile } from '../../plan/index.js';
import { girisYapilandirildiMi } from './giris-durumu.js';
import { kostur } from '../../kos/index.js';
import { kodUret } from '../../uret/index.js';
import { CIKIS, type CikisKodu } from '../cikis.js';
import { uyariYaz } from '../cikti.js';
import {
  UsageError,
  basarili,
  basariliMetin,
  hataBilgisi,
  hataCikisKodu,
  komutCalistir,
  type KomutSonucu,
} from '../komut.js';
import {
  belgeYoluDenetle,
  dizinBul,
  kayitliAdresleriDenetle,
  kayitliHaritayiDenetle,
  hataPaketiVarsayilanYol,
  hataPaketiYoluDenetle,
  haritaSagla,
  sayfaKesfiniYenile,
  testOku,
} from './ortak.js';

/**
 * Elle yazılan plan dosyasındaki sayfa adresi: `/yol` ya da hedefin kendi
 * origin'inde tam adres. Başka origin'deki adres haritayla hiç eşleşmez;
 * sessizce kaydetmek yerine kullanıcıya söylenir.
 *
 * Kısayol yok: her değer `new URL(url, baseUrl)` ile çözülür, yalnız http(s)
 * kabul edilir ve origin çözülmüş adres üzerinden kıyaslanır. (`"/\\evil.test/x"`
 * `/` ile başlasa da WHATWG çözümünde `http://evil.test/x` olur.) Kayda ham
 * metin değil çözülmüş biçim yazılır: yol verildiyse yol+sorgu+parça, tam adres
 * verildiyse normalleştirilmiş tam adres.
 */
export function planUrlDogrula(url: string, baseUrl: string): string {
  const bicimHatasi = new UsageError(
    `Plan file url must be a path like "/records" or a full address on ${adresKimligiGizle(baseUrl)}: ${adresKimligiGizle(url)}`,
  );
  const yolMu = url.startsWith('/');
  // Yol olmayan göreli metin ("records") baseUrl'in yoluna göre farklı çözülür; belirsiz, kabul edilmez.
  if (!yolMu && !/^[a-z][a-z\d+.-]*:/i.test(url)) throw bicimHatasi;
  let adres: URL;
  try {
    adres = new URL(url, baseUrl);
  } catch {
    throw bicimHatasi;
  }
  if (adres.protocol !== 'http:' && adres.protocol !== 'https:') throw bicimHatasi;
  if (adres.origin !== new URL(baseUrl).origin) {
    throw new UsageError(`Plan file url is on a different origin than the project (${adresKimligiGizle(baseUrl)}): ${adresKimligiGizle(url)}`);
  }
  return yolMu ? `${adres.pathname}${adres.search}${adres.hash}` : adres.href;
}

export async function testCreate(a: { cwd: string; planPath: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    const yol = isAbsolute(a.planPath) ? a.planPath : resolve(a.cwd, a.planPath);
    await belgeYoluDenetle(dizin.projeKoku, yol, '--plan');
    let plan: unknown;
    try {
      plan = JSON.parse(await readFile(yol, 'utf8')) as unknown;
    } catch (hata: unknown) {
      if (hata instanceof SyntaxError) throw new UsageError(`Plan file is not valid JSON: ${yol}`);
      throw hata;
    }
    const test = planDosyasindanTest(plan);
    if (test.url !== undefined) test.url = planUrlDogrula(test.url, (await dizin.configOku()).baseUrl);
    // Plan üretimiyle aynı kural: kayıtlı kimlik ya da içe alınan oturum varsa oturum zaten açılır ve
    // test gerçek kimliği yazamaz. Anlamı değişmesin diye plan reddedilir, test yazılmaz.
    const girisIhlali = girisKuraliIhlali(test.planSteps, await girisYapilandirildiMi(dizin));
    if (girisIhlali !== null) {
      throw new UsageError(
        `${girisIhlali}. Remove that step, or test the login flow only with invalid or empty values.`,
      );
    }
    await dizin.testYaz(test);
    // İnsan modunda test kaydının tamamı (plan adımları dahil) dökülmez; kimlik,
    // ad ve sayılar yeter. `--output json` aynı kaydı verir.
    return basariliMetin(test, [
      `Test created: ${test.id}`,
      `Name: ${test.name}`,
      `Steps: ${test.planSteps.length}, priority: ${test.priority}, status: ${test.status}`,
      `Next: kobay test run ${test.id}`,
    ].join('\n'));
  });
}

export async function testList(a: { cwd: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const testler = await (await dizinBul(a.cwd)).testListele();
    const satirlar = testler.map((test) => ({
      id: test.id,
      status: test.status,
      priority: test.priority,
      name: test.name,
    }));
    if (satirlar.length === 0) {
      return basarili(
        satirlar,
        'No tests; generate proposals with `kobay test plan generate` and accept them with `kobay test plan accept`',
      );
    }
    return basarili(satirlar);
  });
}

export async function testGet(a: { cwd: string; id: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    return basarili(await testOku(dizin, a.id));
  });
}

export async function codeGet(a: { cwd: string; id: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    await testOku(dizin, a.id);
    const kod = await dizin.kodOku(a.id);
    if (kod === null) {
      throw new UsageError(`Test code has not been generated: ${a.id}; generate it with \`kobay test run ${a.id}\``);
    }
    return basarili(kod);
  });
}

export async function testDelete(a: { cwd: string; id: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    await testOku(dizin, a.id);
    await dizin.testSil(a.id);
    // İnsan modunda `{"id": ...}` dökümü yerine düz onay satırı; JSON modu aynı.
    return basariliMetin({ id: a.id }, `Test deleted: ${a.id}`);
  });
}

function verdictCikisi(verdict: Verdict): CikisKodu {
  switch (verdict) {
    case 'passed': return CIKIS.GECTI;
    case 'failed': return CIKIS.DUSTU;
    case 'blocked': return CIKIS.HEDEF_YOK;
    case 'inconclusive': return CIKIS.MOTOR;
  }
}

/** Çok satırlı motor hatasından insan satırına sığacak ilk anlamlı satırı alır. */
function ilkSatir(metin: string): string | undefined {
  for (const satir of metin.split('\n')) {
    const temiz = satir.trim();
    if (temiz !== '') return temiz;
  }
  return undefined;
}

/**
 * İnsan modunda tek koşu satırı. JSON çıktısı (`satir`) bundan etkilenmez:
 * düşen testte sınıf (`failureKind`) ve sonraki komut, sonuçsuz koşuda motor
 * hatasının ilk satırı buraya eklenir.
 */
export function kosuSatiriMetni(
  satir: Record<string, unknown>,
  errorMessage?: string,
  rootCauseHypothesis?: string,
  /** Analiz atlandıysa kısa sebep (hangi sınır ya da hangi beyin hatası). */
  analizAtlamaNedeni?: string,
): string {
  const id = String(satir.id);
  const verdict = String(satir.verdict);
  let metin = `${verdict} ${id}`;
  if (typeof satir.failureKind === 'string') metin += ` — ${failureKindEtiketi(satir.failureKind, rootCauseHypothesis)}`;

  let aciklama: string | undefined;
  // Koşmayan test: kısa gerekçe (`errorMessage`); uzun beyin mesajı JSON satırında ve özette kalır.
  if (satir.notRun === true && errorMessage !== undefined) aciklama = errorMessage;
  else if (typeof satir.error === 'string') aciklama = satir.error;
  else if (typeof satir.error === 'object' && satir.error !== null) {
    const bilgi = satir.error as { message?: unknown };
    aciklama = typeof bilgi.message === 'string' ? bilgi.message : JSON.stringify(satir.error);
  } else if (verdict === 'inconclusive' && errorMessage !== undefined) {
    aciklama = ilkSatir(errorMessage);
  }
  if (aciklama !== undefined) metin += ` — ${metindekiKimligiGizle(aciklama)}`;
  if (typeof satir.analysisError === 'object' && satir.analysisError !== null) {
    metin += ` — failure analysis skipped: ${metindekiKimligiGizle(analizAtlamaNedeni ?? 'brain error')}`;
  }
  const paketHatasi = typeof satir.bundleError === 'object' && satir.bundleError !== null
    ? (satir.bundleError as { message?: unknown }).message
    : undefined;
  const sonucHatasi = typeof satir.resultError === 'object' && satir.resultError !== null
    ? (satir.resultError as { message?: unknown }).message
    : undefined;
  if (sonucHatasi !== undefined) {
    metin += ` — the run result could not be updated with the failure kind: ${metindekiKimligiGizle(ilkSatir(String(sonucHatasi)) ?? 'unknown error')}`;
  }
  if (paketHatasi !== undefined) {
    metin += ` — the failure bundle could not be written: ${metindekiKimligiGizle(ilkSatir(String(paketHatasi)) ?? 'unknown error')}`;
  } else if (verdict === 'failed') {
    metin += `\n  failure bundle: kobay test failure get ${id}`;
  }
  return metin;
}

/**
 * Eski koşu dizinlerini budar. Yalnız koşunun işi bittikten sonra çağrılır:
 * düşen koşuda hata paketi yazıldıktan, geçen/engellenen koşuda analiz
 * gerekmediği belli olduktan sonra. Böylece bir koşu, kendi kanıtı analiz
 * edilmeden silinmez.
 *
 * Eşzamanlı başka koşulara karşı korumaların ikisi de depo katmanında: bu
 * koşuyu `korunanlar` ile geçiyoruz, son `TAZE_KOSU_MS` içinde bitenleri
 * `kosulariBuda` kendi listesi üzerinde kolluyor. Burada ikinci bir listeleme
 * yok; karar tek anlık görüntü üzerinde veriliyor.
 *
 * Budama hatası koşuyu düşürmez: stderr'e tek satır uyarı yazılır.
 */
async function eskiKosulariBuda(dizin: KobayDizini, testId: string, runId: string): Promise<void> {
  try {
    await dizin.kosulariBuda(testId, { korunanlar: [runId] });
  } catch (hata: unknown) {
    const sebep = hata instanceof Error ? hata.message : String(hata);
    uyariYaz(`[kobay] Warning: could not prune old run directories (${sebep}).\n`);
  }
}

function beyinHatasiMi(hata: unknown): hata is BrainError | BrainRuntimeError {
  return hata instanceof BrainError || hata instanceof BrainRuntimeError;
}

function maliyetTavaniMi(hata: unknown): hata is BrainRuntimeError {
  return hata instanceof BrainRuntimeError && hata.sebep === 'cost_cap';
}

/**
 * Toplam tavan çağrıdan ÖNCE reddetti mi? Bu koşuyu durduran tek durum budur: defter bir kez
 * reddedince sonraki çağrıları da başlamadan reddeder (para harcanmaz). `claude`'un kendi çağrı
 * başı durdurması (`error_max_budget_usd`) da `cost_cap`'tir ama yalnız o testi etkiler.
 */
function toplamTavanReddiMi(hata: unknown): hata is BrainRuntimeError {
  return maliyetTavaniMi(hata) && hata.toplamTavanReddi === true;
}

const TOPLAM_TAVAN_AYARI = 'KOBAY_MAX_TOTAL_COST_USD or brain.maxTotalCostUsd';

/** Tavan bu koşuda zaten dolduysa, beyin isteyen sonraki testlere verilen kısa gerekçe. */
function tavanDoluHatasi(): BrainRuntimeError {
  return new BrainRuntimeError(
    'cost_cap',
    `the total cost limit (${TOPLAM_TAVAN_AYARI}) was reached earlier in this run, so no brain call was made`,
    { toplamTavanReddi: true },
  );
}

/** İnsan satırı için analiz atlama sebebi: hangi sınır ya da hangi beyin hatası. */
function analizAtlamaNedeni(hata: BrainError | BrainRuntimeError): string {
  if (toplamTavanReddiMi(hata)) return `total cost limit reached (${TOPLAM_TAVAN_AYARI})`;
  return ilkSatir(hataBilgisi(hata).message) ?? 'brain error';
}

/** Koşu başında okunan kayıt hâlâ diskteki mi? Başka bir koşu bu arada yazdıysa değişmiştir. */
async function kayitDegismediMi(dizin: KobayDizini, test: TestKaydi): Promise<boolean> {
  let simdiki: TestKaydi;
  try {
    simdiki = await dizin.testOku(test.id);
  } catch (hata: unknown) {
    if (hata instanceof FileNotFound) return false;
    throw hata;
  }
  return simdiki.lastRunId === test.lastRunId && simdiki.status === test.status
    && simdiki.codeVersion === test.codeVersion && simdiki.updatedAt === test.updatedAt;
}

/**
 * Test hiç koşmadı (kod üretimi beyin hatasıyla düştü ya da toplam tavan doluydu): sonuç yine
 * diske yazılır ki `test report` ve `test result` koşunun bastığı `inconclusive`'i göstersin.
 * `--no-analysis` engel kaydıyla aynı kalıp: taslak taslak kalır (sonraki koşu kodu üretsin),
 * yalnız `lastRunId` bu kayda bağlanır. Taslak olmayan (kodu silinmiş) test, motorun sonuçsuz
 * koşusunda olduğu gibi `unknown` olur.
 *
 * `test` koşu başında okundu; döngü o arada başka testleri koşturmuş olabilir. Test kayıtları için
 * kilit yok: yazmadan hemen önce kayıt yeniden okunur ve yalnız değişmediyse yazılır. Paralel bir
 * koşu testi bu arada güncellediyse (ör. `passed`) onun sonucu ezilmez; `degisti: true` döner.
 */
async function kosulmadiKaydet(
  dizin: KobayDizini, test: TestKaydi, mesaj: string,
): Promise<{ runId: string } | { degisti: true }> {
  if (!(await kayitDegismediMi(dizin, test))) return { degisti: true };
  const an = new Date().toISOString();
  const kayit: KosuSonucu = {
    testId: test.id,
    runId: yeniRunId(),
    status: 'unknown',
    verdict: 'inconclusive',
    startedAt: an,
    finishedAt: an,
    codeVersion: test.codeVersion,
    errorMessage: gizliDegerleriMaskele(mesaj),
  };
  await dizin.kosuDizini(kayit.runId);
  await dizin.kosuSonucuYaz(kayit);
  // İkinci bakış pencereyi iki dosya yazımından tek yazıma daraltır; bağlanmayan kayıt zararsızdır.
  if (!(await kayitDegismediMi(dizin, test))) return { degisti: true };
  await dizin.testYaz({ ...test, lastRunId: kayit.runId, ...(test.status === 'draft' ? {} : { status: 'unknown' as const }) });
  await eskiKosulariBuda(dizin, test.id, kayit.runId);
  return { runId: kayit.runId };
}

const KAYIT_DEGISTI_NOTU = 'another kobay run updated this test meanwhile, so its record was left as that run wrote it';

interface TekTestSonucu {
  exitCode: CikisKodu;
  satir: Record<string, unknown>;
  errorMessage?: string;
  rootCauseHypothesis?: string;
  analizAtlamaNedeni?: string;
  /** Bu testte toplam tavan çağrıyı başlamadan reddetti: koşunun geri kalanında beyin çağrılmaz. */
  tavanHatasi?: BrainRuntimeError;
  /** Test toplam maliyet tavanı yüzünden hiç koşmadı. */
  tavandanKosmadi?: boolean;
  /** Test koştu ve düştü, analiz toplam maliyet tavanı yüzünden yapılmadı. */
  tavandanAnalizsiz?: boolean;
}

async function tekTestKostur(
  dizin: KobayDizini,
  test: TestKaydi,
  secenek: { rerun: boolean; analizYok: boolean; tavanDolu: boolean },
): Promise<TekTestSonucu> {
  const { rerun, analizYok, tavanDolu } = secenek;
  try {
    const config = await dizin.configOku();
    // Kimlikli kayıtlı adresle hiçbir şey yazılmaz, kod üretilmez, tarayıcı açılmaz (exit 2).
    kayitliAdresleriDenetle(config);
    // Kod üretimi ve hata analizi haritayı beyne yollar: eski kimlikli harita da reddedilir.
    kayitliHaritayiDenetle(await dizin.haritaOku());
    let guncelTest = test;
    const mevcutKod = await dizin.kodOku(test.id);
    // `--no-analysis` (CI): beyin yok, kod üretilemez. Kodsuz ya da taslak (planı
    // değişmiş, kodu bayat) test koşturulmadan engellenir — motor taslağı zaten
    // koşturmaz. Diğer testler koşmaya devam eder (çıkış 3, kullanım hatası değil).
    if (analizYok && (mevcutKod === null || test.status === 'draft')) {
      const sebep = mevcutKod === null
        ? 'Test has no generated code'
        : 'Test code is out of date: the test is a draft whose plan changed after its code was generated';
      const mesaj = `${sebep}; run \`kobay test run ${test.id}\` locally with a brain, then commit .kobay/`;
      // Engel diske de yazılır: ardından gelen `test report` testi `not run` değil `blocked`
      // sayar ve istemi verir. Test kaydının durumu DEĞİŞMEZ (taslak taslak kalır ki yerel
      // `test run` kodu yeniden üretsin); yalnız `lastRunId` bu kayda bağlanır.
      const an = new Date().toISOString();
      const kayit: KosuSonucu = {
        testId: test.id,
        runId: yeniRunId(),
        status: 'blocked',
        verdict: 'blocked',
        startedAt: an,
        finishedAt: an,
        codeVersion: test.codeVersion,
        errorMessage: `${KODSUZ_ENGEL_ONEKI}${mesaj}`,
      };
      await dizin.kosuDizini(kayit.runId);
      await dizin.kosuSonucuYaz(kayit);
      await dizin.testYaz({ ...test, lastRunId: kayit.runId });
      await eskiKosulariBuda(dizin, test.id, kayit.runId);
      return {
        exitCode: verdictCikisi('blocked'),
        satir: {
          id: test.id,
          name: test.name,
          verdict: 'blocked' as Verdict,
          runId: kayit.runId,
          error: mesaj,
        },
      };
    }
    if (rerun && mevcutKod === null) {
      return {
        exitCode: CIKIS.MOTOR,
        satir: {
          id: test.id,
          name: test.name,
          verdict: 'inconclusive',
          error: `Test code has not been generated; rerun only runs existing code.`
            + ` Generate it with \`kobay test run ${test.id}\``,
        },
      };
    }
    if (!rerun && !analizYok && (mevcutKod === null || test.status === 'draft')) {
      // Kod üretimi beyin ister. Toplam tavan bu koşuda dolduysa hiç denenmez; üretim beyin
      // hatasıyla düşerse test koşmadan biter. İki durumda da sonuç diske yazılır (`kosulmadiKaydet`).
      let uretim: Awaited<ReturnType<typeof kodUret>> | undefined;
      let uretimHatasi: BrainError | BrainRuntimeError | undefined;
      if (tavanDolu) {
        uretimHatasi = tavanDoluHatasi();
      } else {
        try {
          const harita = await haritaSagla(dizin);
          const beyin = beyinOlustur(config.brain, process.env);
          uretim = await kodUret(beyin, test, harita, {
            projeKoku: dizin.projeKoku,
            kobayKoku: dizin.kok,
            logDizini: dizin.yol('logs'),
          });
        } catch (hata: unknown) {
          if (!beyinHatasiMi(hata)) throw hata;
          uretimHatasi = hata;
        }
      }
      if (uretim === undefined) {
        const hata = uretimHatasi ?? tavanDoluHatasi();
        const bilgi = hataBilgisi(hata);
        const toplam = toplamTavanReddiMi(hata);
        const kayit = await kosulmadiKaydet(
          dizin, test, `Not run: the test code could not be generated (${bilgi.message})`,
        );
        // İnsan satırı: toplam tavanda kısa (uzun mesaj koşu sonundaki özette bir kez); çağrı başı
        // durdurma ve öteki beyin hataları 0.9.0'daki gibi mesajın ilk satırıyla.
        const neden = toplam
          ? `total cost limit reached (${TOPLAM_TAVAN_AYARI}); the test code was not generated`
            + `${test.status === 'draft' ? ' (the test stays draft)' : ''}`
          : ilkSatir(bilgi.message) ?? bilgi.message;
        return {
          exitCode: hataCikisKodu(hata),
          satir: {
            id: test.id, name: test.name, verdict: 'inconclusive' as Verdict,
            ...('runId' in kayit ? { runId: kayit.runId } : {}), notRun: true, error: bilgi,
          },
          errorMessage: `not run: ${neden}${'degisti' in kayit ? `; ${KAYIT_DEGISTI_NOTU}` : ''}`,
          ...(toplam && !tavanDolu ? { tavanHatasi: hata } : {}),
          ...(toplam ? { tavandanKosmadi: true } : {}),
        };
      }
      await dizin.kodYaz(test.id, uretim.kod);
      guncelTest = {
        ...test,
        status: 'ready',
        codeVersion: test.codeVersion + 1,
        updatedAt: new Date().toISOString(),
      };
      await dizin.testYaz(guncelTest);
    }
    const kosu = await kostur(dizin, guncelTest, {
      baseUrl: config.baseUrl,
      storageStateYolu: dizin.storageStateYolu(),
    });
    if (kosu.sonuc.verdict === 'blocked') {
      // Engellenen koşuda analiz yok; kanıt beklemeden budanabilir.
      await eskiKosulariBuda(dizin, test.id, kosu.sonuc.runId);
      return {
        exitCode: verdictCikisi('blocked'),
        satir: {
          id: test.id,
          name: test.name,
          verdict: 'blocked' as Verdict,
          runId: kosu.sonuc.runId,
          error: `Target app is not reachable: ${adresKimligiGizle(config.baseUrl)}; start the app and run again`,
        },
      };
    }
    let sonKosuSonucu = kosu.sonuc;
    let analizHipotezi: string | undefined;
    let analizHatasi: BrainError | BrainRuntimeError | undefined;
    let paketHatasi: unknown;
    let sonucHatasi: unknown;
    if (kosu.sonuc.verdict === 'failed') {
      // `--no-analysis`: beyin hiç kurulmaz; paket yine yazılır, sınıf yerelden ya da `unknown`.
      // Toplam tavan bu koşuda dolduysa beyin kurulmaz; yerel sınıflama (`kobay:` öneki) yine önce
      // denenir, tutmazsa paket gerekçesiyle analizsiz yazılır. Analiz sırasında gelen beyin hatası
      // koşuyu `inconclusive`'e çevirmez: koşu gerçekten düştü ve diske `failed` yazıldı.
      const tavandanBeyinsiz = !analizYok && tavanDolu;
      const beyin = analizYok || tavanDolu ? null : beyinOlustur(config.brain, process.env);
      // İki yazım aşaması ayrı: (1) hata paketi, (2) result.json'a sınıfın işlenmesi. Beyin hatasından
      // sonra biri düşerse koşunun `failed`'i ve runId'si korunur; satır diskte ne varsa onu söyler.
      // Beyinle ilgisiz yazım hataları eskisi gibi dışarı çıkar.
      let paket: Awaited<ReturnType<typeof hataAnalizEt>> | undefined;
      try {
        paket = await hataAnalizEt(beyin, dizin, guncelTest, kosu.sonuc, kosu.adimlar, {
          logDizini: dizin.yol('logs'),
          ...(tavandanBeyinsiz ? { beyinHatasi: tavanDoluHatasi().message } : {}),
          ...(beyin === null ? {} : { beyinHatasindaAnalizsiz: (hata: BrainError | BrainRuntimeError) => { analizHatasi = hata; } }),
        });
      } catch (hata: unknown) {
        if (analizHatasi === undefined && !tavandanBeyinsiz) throw hata;
        paketHatasi = hata;
        // Paket yok ama analiz tavan yüzünden zaten yapılmayacaktı: atlandığı yine söylenir.
        if (analizHatasi === undefined) analizHatasi = tavanDoluHatasi();
      }
      if (paket !== undefined) {
        // `analysisError` yalnız analiz gerçekten atlandıysa (paket beyin-hatası işaretini taşıyorsa).
        const atlandi = paket.failure.rootCauseHypothesis === ANALIZ_ATLANDI_BEYIN;
        if (!atlandi) analizHatasi = undefined;
        else if (tavandanBeyinsiz) analizHatasi = tavanDoluHatasi();
        // Analiz sınıfı result.json'a da işlenir; `test result` failureKind'ı analizden değil koşudan okur.
        const siniflanmis = { ...kosu.sonuc, failureKind: paket.failure.failureKind };
        try {
          await dizin.kosuSonucuYaz(siniflanmis);
          sonKosuSonucu = siniflanmis;
          analizHipotezi = paket.failure.rootCauseHypothesis;
        } catch (hata: unknown) {
          if (analizHatasi === undefined) throw hata;
          // Paket yayımlandı ama result.json eski hâliyle (sınıfsız `failed`) kaldı: satır da sınıfsız.
          sonucHatasi = hata;
        }
      }
    }
    // Budama en sonda: düşen koşunun hata paketi artık yazıldı, kanıt dizini
    // silinse bile analiz tamamlanmış olur — ama bu koşu zaten korunuyor.
    await eskiKosulariBuda(dizin, test.id, sonKosuSonucu.runId);
    const analizTavani = toplamTavanReddiMi(analizHatasi) ? analizHatasi : undefined;
    let exitCode = verdictCikisi(sonKosuSonucu.verdict);
    // Analiz beyin hatasıyla düştüyse çıkış 0.9.0'daki gibi motor (4) kalır; verdict diskteki `failed`.
    if (analizHatasi !== undefined) exitCode = hataCikisKodu(analizHatasi);
    if (paketHatasi !== undefined) exitCode = Math.max(exitCode, hataCikisKodu(paketHatasi)) as CikisKodu;
    if (sonucHatasi !== undefined) exitCode = Math.max(exitCode, hataCikisKodu(sonucHatasi)) as CikisKodu;
    return {
      exitCode,
      satir: {
        id: test.id,
        name: test.name,
        verdict: sonKosuSonucu.verdict,
        runId: sonKosuSonucu.runId,
        ...(sonKosuSonucu.failureKind === undefined ? {} : { failureKind: sonKosuSonucu.failureKind }),
        ...(analizHatasi === undefined ? {} : { analysisError: hataBilgisi(analizHatasi) }),
        ...(paketHatasi === undefined ? {} : { bundleError: hataBilgisi(paketHatasi) }),
        ...(sonucHatasi === undefined ? {} : { resultError: hataBilgisi(sonucHatasi) }),
      },
      // Yalnız insan satırı için; JSON çıktısına girmez.
      ...(sonKosuSonucu.errorMessage === undefined ? {} : { errorMessage: sonKosuSonucu.errorMessage }),
      ...(analizHipotezi === undefined ? {} : { rootCauseHypothesis: analizHipotezi }),
      ...(analizHatasi === undefined ? {} : { analizAtlamaNedeni: analizAtlamaNedeni(analizHatasi) }),
      ...(analizTavani !== undefined && !tavanDolu ? { tavanHatasi: analizTavani } : {}),
      ...(analizTavani === undefined ? {} : { tavandanAnalizsiz: true }),
    };
  } catch (hata: unknown) {
    const bilgi = hataBilgisi(hata);
    return {
      exitCode: hataCikisKodu(hata),
      satir: { id: test.id, name: test.name, verdict: 'inconclusive', error: bilgi },
    };
  }
}

export async function testRun(a: {
  cwd: string;
  ids?: string[];
  all?: boolean;
  rerun?: boolean;
  /** CI kipi: beyin hiç çağrılmaz, yalnız var olan kod koşar (`--rerun`'u kapsar). */
  noAnalysis?: boolean;
}): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    if (a.all === true && a.ids !== undefined && a.ids.length > 0) {
      throw new UsageError('--all cannot be combined with test IDs; either pass IDs or use --all');
    }
    if (a.all !== true && (a.ids === undefined || a.ids.length === 0)) {
      throw new UsageError(
        'At least one test ID or --all is required; list the IDs with `kobay test list`',
      );
    }
    const dizin = await dizinBul(a.cwd);
    const testler = a.all === true
      ? await dizin.testListele()
      : await Promise.all((a.ids ?? []).map(async (id) => testOku(dizin, id)));
    if (testler.length === 0) {
      throw new UsageError(
        'No tests to run; generate proposals with `kobay test plan generate` and accept them with `kobay test plan accept`',
      );
    }
    // Koşu düşerse hata paketi yeniden yazılır. Seçilen testlerden birinin paketi daha yeni
    // (ya da geçersiz) sürümlüyse hiçbir test koşmaz, hiçbir şey yazılmaz (çıkış 2; 0.9.0
    // Karar 4). `--no-analysis` de paketi yazdığı için aynı denetimden geçer.
    await dizin.hataPaketleriniDenetle(testler.map((test) => test.id));
    const sonuclar: Array<Record<string, unknown>> = [];
    const satirMetinleri: string[] = [];
    let exitCode: CikisKodu = CIKIS.GECTI;
    // Toplam maliyet tavanı çağrıyı başlamadan reddettiyse (defterin ön reddi) bu koşuda beyin bir
    // daha denenmez: kodu olan testler `--no-analysis` gibi analizsiz koşar, kod üretimi isteyenler
    // koşmaz. `claude`'un kendi çağrı başı durdurması (KOBAY_MAX_BUDGET_USD) yalnız o testi etkiler;
    // döngü 0.9.0'daki gibi sürer. Mandal bu çağrıya özgü: sonraki bir `test run` (aynı MCP süreci
    // dahil) yeniden dener, defter de tavan doluysa çağrıyı yine başlamadan reddeder.
    let tavanHatasi: BrainRuntimeError | undefined;
    const kosmayanlar: string[] = [];
    const analizsizler: string[] = [];
    for (const test of testler) {
      const sonuc = await tekTestKostur(dizin, test, {
        rerun: a.rerun === true, analizYok: a.noAnalysis === true, tavanDolu: tavanHatasi !== undefined,
      });
      tavanHatasi ??= sonuc.tavanHatasi;
      if (sonuc.tavandanKosmadi === true) kosmayanlar.push(test.id);
      if (sonuc.tavandanAnalizsiz === true) analizsizler.push(test.id);
      sonuclar.push(sonuc.satir);
      satirMetinleri.push(kosuSatiriMetni(sonuc.satir, sonuc.errorMessage, sonuc.rootCauseHypothesis, sonuc.analizAtlamaNedeni));
      exitCode = Math.max(exitCode, sonuc.exitCode) as CikisKodu;
    }
    if (tavanHatasi !== undefined) {
      satirMetinleri.push('', ...tavanOzeti(tavanHatasi, kosmayanlar, analizsizler, (await dizin.configOku()).brain.adaptor));
    }
    return {
      exitCode,
      json: sonuclar,
      // İnsan modunda tek satır yetmiyor: sebebi (kod yok, hedef kapalı…) yanına yaz.
      mesaj: satirMetinleri.join('\n'),
    };
  });
}

function usd(deger: number): string {
  return `$${deger.toFixed(2)}`;
}

/**
 * Toplam maliyet tavanı dolan koşunun insan özeti: tavan mesajı (bir kez), koşmayan ve analizsiz kalan
 * testler, harcama/sınır ve `claude` çağrı rezervasyonu, kalan kimliklerle devam komutu.
 */
function tavanOzeti(hata: BrainRuntimeError, kosmayanlar: string[], analizsizler: string[], adaptor: string): string[] {
  const satirlar = [hata.detay ?? hata.message];
  if (kosmayanlar.length > 0) {
    satirlar.push(`${kosmayanlar.length} test${kosmayanlar.length === 1 ? '' : 's'} did not run because the total cost limit was reached: ${kosmayanlar.join(' ')}`);
  }
  if (analizsizler.length > 0) {
    satirlar.push(`Failure analysis skipped because the total cost limit was reached: ${analizsizler.join(' ')}`);
  }
  const sinir = beyinSinirlari(process.env);
  if (sinir !== undefined) {
    let harcama = `Spent ${usd(sinir.harcananUsd)} of the ${usd(sinir.toplamSinirUsd)} total cost limit (${TOPLAM_TAVAN_AYARI}).`;
    if (adaptor === 'claude') {
      const rezervasyon = Math.min(sinir.claudeCagriButcesiUsd, sinir.toplamSinirUsd);
      harcama += ` A call starts only if its full budget fits in what is left: each claude call reserves up to the per-call budget (${usd(rezervasyon)},`
        + ` KOBAY_MAX_BUDGET_USD or brain.maxBudgetUsd), so a run can use about ${usd(Math.max(0, sinir.toplamSinirUsd - rezervasyon))}`
        + ' of the total (the limit minus one call) before calls are refused.';
    }
    satirlar.push(harcama);
  }
  // Defter süreç başınadır: yeni bir kobay süreci sıfırdan sayar. Tavan mesajı onay istediği için
  // devam komutu da onaydan sonraya bağlanır.
  if (kosmayanlar.length > 0) {
    satirlar.push('Once the user approves more spending, continue with the remaining tests in a new kobay process'
      + ` (its spending counter starts at zero): kobay test run ${kosmayanlar.join(' ')}`);
  }
  if (analizsizler.length > 0) satirlar.push(`To also analyse the failures, run them again: kobay test run ${analizsizler.join(' ')}`);
  return satirlar;
}

export async function testRerun(a: { cwd: string; id: string }): Promise<KomutSonucu> {
  return testRun({ cwd: a.cwd, ids: [a.id], rerun: true });
}

export async function testResult(a: { cwd: string; id: string; history?: boolean }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    await testOku(dizin, a.id);
    const kosular = await dizin.kosuListele(a.id);
    if (kosular.length === 0) {
      throw new UsageError(`No run result: ${a.id}; run \`kobay test run ${a.id}\` first`);
    }
    return basarili(a.history === true ? kosular : kosular.at(-1));
  });
}

export async function failureGet(a: { cwd: string; id: string; out?: string; includeTrace?: boolean }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    const istenen = a.out ?? await hataPaketiVarsayilanYol(dizin.projeKoku, a.id);
    const hedef = isAbsolute(istenen) ? istenen : resolve(a.cwd, istenen);
    // Paket oturum çerezi taşır: .git/, .claude/, .kobay/ altı yasak, tek istisna .kobay/failure-out/.
    await hataPaketiYoluDenetle(dizin.projeKoku, hedef, '--out');
    let kopya;
    try {
      kopya = await dizin.hataPaketiKopyala(a.id, hedef, { traceDahil: a.includeTrace === true });
    } catch (hata: unknown) {
      if (hata instanceof FileNotFound) {
        throw new UsageError(
          `No failure bundle: ${a.id}; a bundle is created only after a failed run,`
          + ` so run \`kobay test run ${a.id}\` first`,
        );
      }
      throw hata;
    }
    // İnsan modunda düz metin stdout'a: `kobay test failure get ... > not.txt` yönlendirmesi
    // JSON dökümü değil, okunur satırı almalı.
    // trace.zip oturum çerezini açık taşır (spec 2026-11-06 Ş-C): varsayılan kopyada yok, yeri söylenir.
    const satirlar = [`Failure bundle copied: ${hedef}`];
    if (kopya.traceDahil) {
      satirlar.push(`Trace included: ${kopya.traceYolu ?? ''} (it contains session cookies in plain text; do not share it)`);
    } else if (kopya.traceYolu !== null) {
      satirlar.push(`Trace not copied (it contains session cookies in plain text): ${kopya.traceYolu}; pass --include-trace to copy it`);
    }
    return basariliMetin({
      id: a.id,
      destination: hedef,
      trace: { included: kopya.traceDahil, path: kopya.traceYolu },
    }, satirlar.join('\n'));
  });
}

/**
 * Son hata paketindeki harita farkı; paket yok ya da yarımsa bağlam olmadan devam edilir.
 * Daha yeni sürümlü (`SchemaVersionTooNew`) ya da şemaya uymayan paket (`SchemaError`)
 * yutulmaz: komut çıkış 2 ile durur (0.9.0 Karar 4).
 */
async function sonHaritaFarki(dizin: KobayDizini, testId: string): Promise<HaritaFarki | undefined> {
  try {
    return (await dizin.hataPaketiOku(testId)).mapDiff;
  } catch (hata: unknown) {
    if (hata instanceof SchemaError) throw hata;
    return undefined;
  }
}

/**
 * `product_changed` sonrası tek komut: testin sayfasını yeniden keşfeder,
 * haritayı yerinde günceller, plan adımlarını yeni arayüze uyarlar ve testi
 * taslağa çeker. `run` false değilse ardından normal koşu yolunu çalıştırır
 * (kod üret → koştur → düşerse analiz).
 */
export async function testRefresh(a: { cwd: string; id: string; run?: boolean }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    const test = await testOku(dizin, a.id);
    if (test.url === undefined) {
      throw new UsageError(
        `The test has no URL, so it cannot be refreshed: ${a.id}.`
        + ' Generate a new test from a plan: `kobay explore` → `kobay test plan generate`',
      );
    }

    // Paket her yan etkiden (beyin, harita, test yazımı) ÖNCE denetlenir ve okunur: failure.json
    // ya da meta.json daha yeni (ya da geçersiz) sürümlüyse hiçbir şey yazılmaz.
    await dizin.hataPaketleriniDenetle([a.id]);
    const haritaFarki = await sonHaritaFarki(dizin, a.id);
    const { yeniSayfa, eskiSayfa } = await sayfaKesfiniYenile(dizin, test.url);
    const config = await dizin.configOku();
    const beyin = beyinOlustur(config.brain, process.env);
    const yeniPlan = await planYenile(
      beyin,
      {
        test,
        eskiSayfa,
        yeniSayfa,
        ...(haritaFarki === undefined ? {} : { mapDiff: haritaFarki }),
      },
      dizin.yol('logs'),
    );
    // Plan üretimi ve elle planla aynı kural: giriş yapılandırılmışsa beynin yenilediği adımlar gerçek
    // kimliği yazamaz. Beyin çıktısı reddi motor hatasıdır (exit 4); eski test hiç yazılmadan kalır.
    const girisIhlali = girisKuraliIhlali(yeniPlan.planSteps, await girisYapilandirildiMi(dizin));
    if (girisIhlali !== null) {
      throw new Error(
        `The refreshed plan was rejected: ${girisIhlali}. The test was not changed.`
        + ` Run \`kobay test refresh ${a.id}\` again; to write the steps yourself, create a new test with \`kobay test create --plan <file>\`.`,
      );
    }

    // status draft: `test run` eski kodu atıp yeniden üretir; kodu ayrıca silmek gerekmez.
    const guncelTest: TestKaydi = {
      ...test,
      name: yeniPlan.name,
      planSteps: yeniPlan.planSteps,
      status: 'draft',
      // codeVersion'ı yalnız kod üretimi artırır; refresh kodu üretmez, `test run` üretir.
      updatedAt: new Date().toISOString(),
    };
    await dizin.testYaz(guncelTest);

    const ozet = {
      id: guncelTest.id,
      name: guncelTest.name,
      ...(guncelTest.name === test.name ? {} : { previousName: test.name }),
      url: test.url,
      pageUrl: yeniSayfa.url,
      stepCount: guncelTest.planSteps.length,
      planSteps: guncelTest.planSteps,
      status: guncelTest.status,
      codeVersion: guncelTest.codeVersion,
    };
    const adimSatirlari = guncelTest.planSteps
      .map((adim, sira) => `${sira}. [${adim.type}] ${adim.description}`)
      .join('\n');
    // İnsan modunda özetin JSON dökümü basılmaz; kimlik, sayfa ve yeni adımlar
    // bu metinde durur. `--output json` aynı gövdeyi verir.
    const basMetni = [
      `Page refreshed: ${adresKimligiGizle(yeniSayfa.url)}`,
      `Test: ${guncelTest.id} — ${guncelTest.name}${guncelTest.name === test.name ? '' : ` (was: ${test.name})`}`,
      `New plan (${guncelTest.planSteps.length} step${guncelTest.planSteps.length === 1 ? '' : 's'}, status: ${guncelTest.status}):`,
      adimSatirlari,
    ].join('\n');

    if (a.run === false) {
      return basariliMetin(ozet, `${basMetni}\nNot run (--no-run); generate the code with \`kobay test run ${a.id}\``);
    }

    const kosu = await testRun({ cwd: a.cwd, ids: [a.id] });
    const satir = Array.isArray(kosu.json) ? kosu.json[0] as Record<string, unknown> | undefined : undefined;
    // Kod üretimi codeVersion'ı ve durumu koşu sırasında değiştirir; özet güncel kayıttan okunur.
    const kosuSonrasi = await dizin.testOku(a.id);
    return {
      exitCode: kosu.exitCode,
      json: {
        ...ozet,
        status: kosuSonrasi.status,
        codeVersion: kosuSonrasi.codeVersion,
        run: satir ?? null,
      },
      // Koşu satırları `test run` ile aynı biçimde; düşen koşuda metin stderr'e gider.
      metin: `${basMetni}\n${kosu.mesaj ?? ''}`,
    };
  });
}
