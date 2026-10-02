import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { hataAnalizEt } from '../../analiz/index.js';
import { beyinOlustur } from '../../beyin/index.js';
import {
  FileNotFound,
  type HaritaFarki,
  type KobayDizini,
  type TestKaydi,
  type Verdict,
} from '../../depo/index.js';
import { girisKuraliIhlali, planDosyasindanTest, planYenile } from '../../plan/index.js';
import { kostur } from '../../kos/index.js';
import { kodUret } from '../../uret/index.js';
import { CIKIS, type CikisKodu } from '../cikis.js';
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
    `Plan file url must be a path like "/records" or a full address on ${baseUrl}: ${url}`,
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
    throw new UsageError(`Plan file url is on a different origin than the project (${baseUrl}): ${url}`);
  }
  return yolMu ? `${adres.pathname}${adres.search}${adres.hash}` : adres.href;
}

export async function testCreate(a: { cwd: string; planPath: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    const yol = isAbsolute(a.planPath) ? a.planPath : resolve(a.cwd, a.planPath);
    await belgeYoluDenetle(dizin.projeKoku, yol, 'planPath');
    let plan: unknown;
    try {
      plan = JSON.parse(await readFile(yol, 'utf8')) as unknown;
    } catch (hata: unknown) {
      if (hata instanceof SyntaxError) throw new UsageError(`Plan file is not valid JSON: ${yol}`);
      throw hata;
    }
    const test = planDosyasindanTest(plan);
    if (test.url !== undefined) test.url = planUrlDogrula(test.url, (await dizin.configOku()).baseUrl);
    // Plan üretimiyle aynı kural: kayıtlı kimlik varsa oturum kobay'ın giriş adımıyla açılır ve test
    // gerçek kimliği yazamaz. Anlamı değişmesin diye plan reddedilir, test yazılmaz.
    const girisIhlali = girisKuraliIhlali(test.planSteps, (await dizin.kimlikOku()) !== null);
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
function kosuSatiriMetni(satir: Record<string, unknown>, errorMessage?: string): string {
  const id = String(satir.id);
  const verdict = String(satir.verdict);
  let metin = `${verdict} ${id}`;
  if (typeof satir.failureKind === 'string') metin += ` — ${satir.failureKind}`;

  let aciklama: string | undefined;
  if (typeof satir.error === 'string') aciklama = satir.error;
  else if (typeof satir.error === 'object' && satir.error !== null) {
    const bilgi = satir.error as { message?: unknown };
    aciklama = typeof bilgi.message === 'string' ? bilgi.message : JSON.stringify(satir.error);
  } else if (verdict === 'inconclusive' && errorMessage !== undefined) {
    aciklama = ilkSatir(errorMessage);
  }
  if (aciklama !== undefined) metin += ` — ${aciklama}`;

  if (verdict === 'failed') metin += `\n  failure bundle: kobay test failure get ${id}`;
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
    process.stderr.write(`[kobay] Warning: could not prune old run directories (${sebep}).\n`);
  }
}

async function tekTestKostur(
  dizin: KobayDizini,
  test: TestKaydi,
  rerun: boolean,
): Promise<{ exitCode: CikisKodu; satir: Record<string, unknown>; errorMessage?: string }> {
  try {
    const config = await dizin.configOku();
    let guncelTest = test;
    const mevcutKod = await dizin.kodOku(test.id);
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
    if (!rerun && (mevcutKod === null || test.status === 'draft')) {
      const harita = await haritaSagla(dizin);
      const beyin = beyinOlustur(config.brain, process.env);
      const uretim = await kodUret(beyin, test, harita, {
        projeKoku: dizin.projeKoku,
        kobayKoku: dizin.kok,
        logDizini: dizin.yol('logs'),
      });
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
          error: `Target app is not reachable: ${config.baseUrl}; start the app and run again`,
        },
      };
    }
    let sonKosuSonucu = kosu.sonuc;
    if (kosu.sonuc.verdict === 'failed') {
      const beyin = beyinOlustur(config.brain, process.env);
      const paket = await hataAnalizEt(beyin, dizin, guncelTest, kosu.sonuc, kosu.adimlar, {
        logDizini: dizin.yol('logs'),
      });
      // Analiz sınıfı result.json'a da işlenir; `test result` failureKind'ı analizden değil koşudan okur.
      sonKosuSonucu = { ...kosu.sonuc, failureKind: paket.failure.failureKind };
      await dizin.kosuSonucuYaz(sonKosuSonucu);
    }
    // Budama en sonda: düşen koşunun hata paketi artık yazıldı, kanıt dizini
    // silinse bile analiz tamamlanmış olur — ama bu koşu zaten korunuyor.
    await eskiKosulariBuda(dizin, test.id, sonKosuSonucu.runId);
    return {
      exitCode: verdictCikisi(sonKosuSonucu.verdict),
      satir: {
        id: test.id,
        name: test.name,
        verdict: sonKosuSonucu.verdict,
        runId: sonKosuSonucu.runId,
        ...(sonKosuSonucu.failureKind === undefined ? {} : { failureKind: sonKosuSonucu.failureKind }),
      },
      // Yalnız insan satırı için; JSON çıktısına girmez.
      ...(sonKosuSonucu.errorMessage === undefined ? {} : { errorMessage: sonKosuSonucu.errorMessage }),
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
    const sonuclar: Array<Record<string, unknown>> = [];
    const satirMetinleri: string[] = [];
    let exitCode: CikisKodu = CIKIS.GECTI;
    for (const test of testler) {
      const sonuc = await tekTestKostur(dizin, test, a.rerun === true);
      sonuclar.push(sonuc.satir);
      satirMetinleri.push(kosuSatiriMetni(sonuc.satir, sonuc.errorMessage));
      exitCode = Math.max(exitCode, sonuc.exitCode) as CikisKodu;
    }
    return {
      exitCode,
      json: sonuclar,
      // İnsan modunda tek satır yetmiyor: sebebi (kod yok, hedef kapalı…) yanına yaz.
      mesaj: satirMetinleri.join('\n'),
    };
  });
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

export async function failureGet(a: { cwd: string; id: string; out?: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    const istenen = a.out ?? await hataPaketiVarsayilanYol(dizin.projeKoku, a.id);
    const hedef = isAbsolute(istenen) ? istenen : resolve(a.cwd, istenen);
    // Paket oturum çerezi taşır: .git/, .claude/, .kobay/ altı yasak, tek istisna .kobay/failure-out/.
    await hataPaketiYoluDenetle(dizin.projeKoku, hedef, '--out');
    try {
      await dizin.hataPaketiKopyala(a.id, hedef);
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
    return basariliMetin({ id: a.id, destination: hedef }, `Failure bundle copied: ${hedef}`);
  });
}

/** Son hata paketindeki harita farkı; paket yok ya da okunamıyorsa bağlam olmadan devam edilir. */
async function sonHaritaFarki(dizin: KobayDizini, testId: string): Promise<HaritaFarki | undefined> {
  try {
    return (await dizin.hataPaketiOku(testId)).mapDiff;
  } catch {
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

    const { yeniSayfa, eskiSayfa } = await sayfaKesfiniYenile(dizin, test.url);
    const [config, haritaFarki] = await Promise.all([dizin.configOku(), sonHaritaFarki(dizin, a.id)]);
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
      `Page refreshed: ${yeniSayfa.url}`,
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
