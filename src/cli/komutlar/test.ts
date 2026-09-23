import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { hataAnalizEt } from '../../analiz/index.js';
import { beyinOlustur } from '../../beyin/index.js';
import {
  DosyaYok,
  type HaritaFarki,
  type KobayDizini,
  type TestKaydi,
  type Verdict,
} from '../../depo/index.js';
import { planDosyasindanTest, planYenile } from '../../plan/index.js';
import { kostur } from '../../kos/index.js';
import { kodUret } from '../../uret/index.js';
import { CIKIS, type CikisKodu } from '../cikis.js';
import {
  KullanimHatasi,
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

export async function testCreate(a: { cwd: string; planPath: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    const yol = isAbsolute(a.planPath) ? a.planPath : resolve(a.cwd, a.planPath);
    await belgeYoluDenetle(dizin.projeKoku, yol, 'planPath');
    let plan: unknown;
    try {
      plan = JSON.parse(await readFile(yol, 'utf8')) as unknown;
    } catch (hata: unknown) {
      if (hata instanceof SyntaxError) throw new KullanimHatasi(`Plan dosyası geçerli JSON değil: ${yol}`);
      throw hata;
    }
    const test = planDosyasindanTest(plan);
    await dizin.testYaz(test);
    // İnsan modunda test kaydının tamamı (plan adımları dahil) dökülmez; kimlik,
    // ad ve sayılar yeter. `--output json` aynı kaydı verir.
    return basariliMetin(test, [
      `Test oluşturuldu: ${test.id}`,
      `Ad: ${test.name}`,
      `Adım sayısı: ${test.planSteps.length}, öncelik: ${test.priority}, durum: ${test.status}`,
      `Sonraki: kobay test run ${test.id}`,
    ].join('\n'));
  });
}

export async function testList(a: { cwd: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const testler = await (await dizinBul(a.cwd)).testListele();
    const satirlar = testler.map((test) => ({
      id: test.id,
      durum: test.status,
      oncelik: test.priority,
      ad: test.name,
    }));
    if (satirlar.length === 0) {
      return basarili(satirlar, 'Test yok; `kobay test plan generate` ile öneri üretip `kobay test plan accept` ile kabul edin');
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
      throw new KullanimHatasi(`Test kodu üretilmemiş: ${a.id}; \`kobay test run ${a.id}\` ile kodu üretin`);
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
    return basariliMetin({ id: a.id }, `Test silindi: ${a.id}`);
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
  if (typeof satir.hata === 'string') aciklama = satir.hata;
  else if (typeof satir.hata === 'object' && satir.hata !== null) {
    const bilgi = satir.hata as { mesaj?: unknown };
    aciklama = typeof bilgi.mesaj === 'string' ? bilgi.mesaj : JSON.stringify(satir.hata);
  } else if (verdict === 'inconclusive' && errorMessage !== undefined) {
    aciklama = ilkSatir(errorMessage);
  }
  if (aciklama !== undefined) metin += ` — ${aciklama}`;

  if (verdict === 'failed') metin += `\n  hata paketi: kobay test failure get ${id}`;
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
    process.stderr.write(`[kobay] Uyarı: eski koşu dizinleri budanamadı (${sebep}).\n`);
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
          ad: test.name,
          verdict: 'inconclusive',
          hata: `Test kodu üretilmemiş; rerun yalnız var olan kodu koşturur. \`kobay test run ${test.id}\` ile üretin`,
        },
      };
    }
    if (!rerun && (mevcutKod === null || test.status === 'draft')) {
      const harita = await haritaSagla(dizin);
      const beyin = beyinOlustur(config.beyin, process.env);
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
          ad: test.name,
          verdict: 'blocked' as Verdict,
          runId: kosu.sonuc.runId,
          hata: `Hedef uygulamaya ulaşılamadı: ${config.baseUrl}; uygulamayı başlatıp yeniden koşturun`,
        },
      };
    }
    let sonKosuSonucu = kosu.sonuc;
    if (kosu.sonuc.verdict === 'failed') {
      const beyin = beyinOlustur(config.beyin, process.env);
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
        ad: test.name,
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
      satir: { id: test.id, ad: test.name, verdict: 'inconclusive', hata: bilgi },
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
      throw new KullanimHatasi('--all ile test kimlikleri birlikte kullanılamaz; ya kimlik verin ya --all kullanın');
    }
    if (a.all !== true && (a.ids === undefined || a.ids.length === 0)) {
      throw new KullanimHatasi(
        'En az bir test kimliği veya --all gerekli; kimlikleri `kobay test list` ile görün',
      );
    }
    const dizin = await dizinBul(a.cwd);
    const testler = a.all === true
      ? await dizin.testListele()
      : await Promise.all((a.ids ?? []).map(async (id) => testOku(dizin, id)));
    if (testler.length === 0) {
      throw new KullanimHatasi(
        'Koşturulacak test yok; `kobay test plan generate` ile öneri üretip `kobay test plan accept` ile kabul edin',
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
      throw new KullanimHatasi(`Koşu sonucu yok: ${a.id}; önce \`kobay test run ${a.id}\` çalıştırın`);
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
      if (hata instanceof DosyaYok) {
        throw new KullanimHatasi(
          `Hata paketi yok: ${a.id}; paket yalnız düşen koşudan sonra oluşur, önce \`kobay test run ${a.id}\` çalıştırın`,
        );
      }
      throw hata;
    }
    // İnsan modunda düz metin stdout'a: `kobay test failure get ... > not.txt` yönlendirmesi
    // JSON dökümü değil, okunur satırı almalı.
    return basariliMetin({ id: a.id, hedef }, `Hata paketi kopyalandı: ${hedef}`);
  });
}

/** Son hata paketindeki harita farkı; paket yok ya da okunamıyorsa bağlam olmadan devam edilir. */
async function sonHaritaFarki(dizin: KobayDizini, testId: string): Promise<HaritaFarki | undefined> {
  try {
    return (await dizin.hataPaketiOku(testId)).haritaFarki;
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
      throw new KullanimHatasi(
        `Testin URL'si yok; yenilenemez: ${a.id}.`
        + ' Plandan yeni test üretin: `kobay explore` → `kobay test plan generate`',
      );
    }

    const { yeniSayfa, eskiSayfa } = await sayfaKesfiniYenile(dizin, test.url);
    const [config, haritaFarki] = await Promise.all([dizin.configOku(), sonHaritaFarki(dizin, a.id)]);
    const beyin = beyinOlustur(config.beyin, process.env);
    const yeniPlan = await planYenile(
      beyin,
      {
        test,
        eskiSayfa,
        yeniSayfa,
        ...(haritaFarki === undefined ? {} : { haritaFarki }),
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
      ad: guncelTest.name,
      ...(guncelTest.name === test.name ? {} : { eskiAd: test.name }),
      url: test.url,
      sayfa: yeniSayfa.url,
      adimSayisi: guncelTest.planSteps.length,
      planSteps: guncelTest.planSteps,
      durum: guncelTest.status,
      codeVersion: guncelTest.codeVersion,
    };
    const adimSatirlari = guncelTest.planSteps
      .map((adim, sira) => `${sira}. [${adim.type}] ${adim.description}`)
      .join('\n');
    // İnsan modunda özetin JSON dökümü basılmaz; kimlik, sayfa ve yeni adımlar
    // bu metinde durur. `--output json` aynı gövdeyi verir.
    const basMetni = [
      `Sayfa yenilendi: ${yeniSayfa.url}`,
      `Test: ${guncelTest.id} — ${guncelTest.name}${guncelTest.name === test.name ? '' : ` (eski: ${test.name})`}`,
      `Yeni plan (${guncelTest.planSteps.length} adım, durum: ${guncelTest.status}):`,
      adimSatirlari,
    ].join('\n');

    if (a.run === false) {
      return basariliMetin(ozet, `${basMetni}\nKoşu yapılmadı (--no-run); kod \`kobay test run ${a.id}\` ile üretilir`);
    }

    const kosu = await testRun({ cwd: a.cwd, ids: [a.id] });
    const satir = Array.isArray(kosu.json) ? kosu.json[0] as Record<string, unknown> | undefined : undefined;
    // Kod üretimi codeVersion'ı ve durumu koşu sırasında değiştirir; özet güncel kayıttan okunur.
    const kosuSonrasi = await dizin.testOku(a.id);
    return {
      exitCode: kosu.exitCode,
      json: {
        ...ozet,
        durum: kosuSonrasi.status,
        codeVersion: kosuSonrasi.codeVersion,
        kosu: satir ?? null,
      },
      // Koşu satırları `test run` ile aynı biçimde; düşen koşuda metin stderr'e gider.
      metin: `${basMetni}\n${kosu.mesaj ?? ''}`,
    };
  });
}
