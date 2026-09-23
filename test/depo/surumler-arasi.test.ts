import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ISARET_ESKI_ANAHTARLARI, KALICI_ANAHTARLAR } from '../../src/depo/anahtar-gocu.js';

/**
 * 0.1 ile 0.2 aynı projede koşabilir. Kimlik işlemi kilidi bu yüzden iki adla
 * birden tutulur: `.credentials-txn` (0.2) ve `.kimlik-islemi` (0.1). Buradaki
 * testler kilidin GERÇEKTEN iki sürüm arasında tuttuğunu, iki ayrı `dist` ve
 * iki ayrı süreçle doğrular; tek süreç içinde taklit edilen bir kilit bu
 * hatayı yakalayamıyordu (0.1 İngilizce gövdeyi geçersiz sayıp siliyordu).
 */

/** KOBAY_TEST_KATI=1 verildiğinde atlama yasak: eksik ortam hata sayılır. */
const kati = process.env.KOBAY_TEST_KATI === '1';
/** 0.1 kurulumu olmayan ortamlarda (CI) bilerek atlandığını söyleyen açık bayrak. */
const ATLAMA_BAYRAGI = 'skip';
const ESKI_DIST_HAM = process.env.KOBAY_01_DIST ?? '';

/** 0.2 tarafı: bu deponun derlenmiş çıktısı (`npm run build` şart). */
const YENI_DIST = join(fileURLToPath(new URL('../..', import.meta.url)), 'dist');

/** 0.1'in okuyabildiği config: alan adı `beyin`, `brain` değil. */
const ESKI_CONFIG = `${JSON.stringify(
  { baseUrl: 'http://localhost:3000', beyin: { adaptor: 'claude' } },
  null,
  2,
)}\n`;

/**
 * Gerçek bir kimlik işlemi başlatıp kilidi açık tutan süreç. CLI komutları
 * işlemi saniyeler içinde bitirdiği için kilidi tutan bir süreci CLI ile
 * yakalamak imkânsız; bu betik aynı `dist`in depo katmanını doğrudan çağırır,
 * yani diske inen işaret o sürümün GERÇEKTEN yazdığı gövdedir.
 */
const TUTUCU_BETIGI = `const dist = process.env.KOBAY_DIST;
const { KobayDizini } = await import(new URL('depo/dizin.js', 'file://' + dist + '/').href);
const dizin = await KobayDizini.bul(process.cwd());
const eskiConfig = await dizin.configOku().catch(() => null);
const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig, yeniKimlikYazilacak: true });
process.stdout.write('READY\\n');
setInterval(() => {}, 60000);
`;

async function duruyorMu(yol: string): Promise<boolean> {
  return access(yol).then(() => true, () => false);
}

/** `KOBAY_01_DIST` bir depo kökünü de (`<kok>/dist`) doğrudan `dist`i de gösterebilir. */
async function eskiDistCoz(): Promise<string | null> {
  if (ESKI_DIST_HAM === '' || ESKI_DIST_HAM === ATLAMA_BAYRAGI) return null;
  for (const aday of [join(ESKI_DIST_HAM, 'dist'), ESKI_DIST_HAM]) {
    if (await duruyorMu(join(aday, 'cli', 'index.js'))) return aday;
  }
  throw new Error(`KOBAY_01_DIST altında cli/index.js bulunamadı: ${ESKI_DIST_HAM}`);
}

/**
 * Ortam hazır değilse testi atlar. Katı kipte atlama hatadır — ama CI'da 0.1
 * kurulumu yok, bu yüzden `KOBAY_01_DIST=skip` bilerek atlamaya izin verir.
 */
function ortamYoksaAtla(context: { skip: () => void }): boolean {
  if (ESKI_DIST_HAM === ATLAMA_BAYRAGI) {
    context.skip();
    return true;
  }
  if (ESKI_DIST_HAM === '') {
    if (kati) {
      throw new Error(
        'KOBAY_TEST_KATI=1: sürümler arası testler atlanamaz;'
        + ' KOBAY_01_DIST=<0.1 kurulumu> verin ya da bilerek atlamak için KOBAY_01_DIST=skip verin',
      );
    }
    context.skip();
    return true;
  }
  return false;
}

interface Cikti { readonly kod: number | null; readonly cikti: string }

function kobayCalistir(dist: string, cwd: string, argumanlar: string[]): Promise<Cikti> {
  return new Promise((coz, dus) => {
    const surec = spawn(process.execPath, [join(dist, 'cli', 'index.js'), ...argumanlar], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let cikti = '';
    surec.stdout.on('data', (parca: Buffer) => { cikti += parca.toString(); });
    surec.stderr.on('data', (parca: Buffer) => { cikti += parca.toString(); });
    surec.on('error', dus);
    surec.on('close', (kod) => { coz({ kod, cikti }); });
  });
}

interface Tutucu { readonly pid: number; readonly oldur: () => void }

/** Verilen `dist` ile kimlik işlemi başlatır ve işaret diske inene kadar bekler. */
async function tutucuBaslat(dist: string, cwd: string, betik: string): Promise<Tutucu> {
  const surec = spawn(process.execPath, [betik], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KOBAY_DIST: dist },
  });
  let cikti = '';
  surec.stdout.on('data', (parca: Buffer) => { cikti += parca.toString(); });
  surec.stderr.on('data', (parca: Buffer) => { cikti += parca.toString(); });
  const hazir = new Promise<void>((coz, dus) => {
    surec.stdout.on('data', () => { if (cikti.includes('READY')) coz(); });
    surec.on('error', dus);
    surec.on('close', () => { dus(new Error(`tutucu süreç READY demeden bitti: ${cikti}`)); });
  });
  await hazir;
  const pid = surec.pid;
  if (pid === undefined) throw new Error('tutucu sürecin pid değeri yok');
  return { pid, oldur: () => { surec.kill('SIGKILL'); } };
}

/** Süreç gerçekten ölene kadar bekler; bayat işaret testleri buna dayanır. */
async function olmesiniBekle(pid: number): Promise<void> {
  for (let deneme = 0; deneme < 200; deneme += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((coz) => setTimeout(coz, 25));
  }
  throw new Error(`tutucu süreç ${pid} ölmedi`);
}

/** Boş bir proje: `dist` ile oluşturulur, sonra kayıtlı bir kimlik konur. */
async function projeKur(dist: string): Promise<string> {
  const kok = await mkdtemp(join(tmpdir(), 'kobay-surumler-'));
  const sonuc = await kobayCalistir(dist, kok, ['project', 'create', '--url', 'http://localhost:3000']);
  expect(sonuc.kod, sonuc.cikti).toBe(0);
  await writeFile(
    join(kok, '.kobay', 'credentials.json'),
    JSON.stringify({ kullanici: 'u', parola: 'p', origin: 'http://localhost:3000' }),
    { mode: 0o600 },
  );
  return kok;
}

/**
 * config.json'u 0.1'in şemasına geri yazar. 0.2 açılışta alan adlarını yerinde
 * göçürüyor (`beyin` → `brain`); göçmüş bir config'i 0.1 hiç okuyamaz ve kilide
 * bakmadan düşer. Testin ölçtüğü şey kilit olduğu için, 0.1 koşmadan hemen önce
 * config 0.1'in okuyabildiği hâle getirilir — yani "0.1'in hâlâ kullanabildiği
 * bir proje" durumu kurulur.
 */
async function configiEskiSemayaAl(kok: string): Promise<void> {
  await writeFile(join(kok, '.kobay', 'config.json'), ESKI_CONFIG);
}

function isaretYollari(kok: string): { yeni: string; eski: string } {
  return {
    yeni: join(kok, '.kobay', '.credentials-txn'),
    eski: join(kok, '.kobay', '.kimlik-islemi'),
  };
}

async function jsonOku(yol: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(yol, 'utf8')) as Record<string, unknown>;
}

it('işaretin eski adı için kullanılan ters tablo, kalıcı tablonun tam tersidir', () => {
  for (const [yeni, eski] of Object.entries(ISARET_ESKI_ANAHTARLARI)) {
    expect(KALICI_ANAHTARLAR[eski], `${eski} → ${yeni}`).toBe(yeni);
  }
});

describe('0.1 ve 0.2 aynı projede', () => {
  it('0.2 işlemi yürürken 0.1 kimliği değiştiremez', async (context) => {
    if (ortamYoksaAtla(context)) return;
    const eskiDist = await eskiDistCoz();
    if (eskiDist === null) return;

    const kok = await projeKur(YENI_DIST);
    const betik = join(kok, 'tutucu.mjs');
    await writeFile(betik, TUTUCU_BETIGI);
    const tutucu = await tutucuBaslat(YENI_DIST, kok, betik);
    try {
      const { yeni, eski } = isaretYollari(kok);
      const yeniGovde = await jsonOku(yeni);
      const eskiGovde = await jsonOku(eski);
      // Yeni ad İngilizce, eski ad 0.1'in Türkçe şemasıyla: aynı bilgi, eski adlar.
      expect(yeniGovde['txnId']).toBeTypeOf('string');
      expect(eskiGovde['islemId']).toBe(yeniGovde['txnId']);
      expect(eskiGovde['baslatildi']).toBe(yeniGovde['startedAt']);
      expect(eskiGovde['kenaraAlinanlar']).toEqual(yeniGovde['setAside']);
      expect(eskiGovde['yeniKimlikYazilacak']).toBe(true);
      expect(eskiGovde['txnId']).toBeUndefined();
      // 0.1'in config şeması `beyin`i zorunlu tutar; `brain` yazsaydık işaret
      // bütünüyle geçersiz sayılır, silinir ve kilit düşerdi.
      expect((eskiGovde['eskiConfig'] as Record<string, unknown>)['beyin']).toBeDefined();

      await configiEskiSemayaAl(kok);
      const oncekiYeni = await readFile(yeni, 'utf8');
      const oncekiEski = await readFile(eski, 'utf8');
      const oncekiConfig = await readFile(join(kok, '.kobay', 'config.json'), 'utf8');

      const sonuc = await kobayCalistir(eskiDist, kok, [
        'project', 'update', '--base-url', 'http://localhost:4000',
      ]);
      expect(sonuc.kod, sonuc.cikti).toBe(2);
      expect(sonuc.cikti).toContain('Başka bir kobay komutu');
      expect(sonuc.cikti).toContain(`pid ${tutucu.pid}`);
      // 0.1 ne işaretlere ne config'e dokunmuş olmalı.
      expect(await readFile(yeni, 'utf8')).toBe(oncekiYeni);
      expect(await readFile(eski, 'utf8')).toBe(oncekiEski);
      expect(await readFile(join(kok, '.kobay', 'config.json'), 'utf8')).toBe(oncekiConfig);
    } finally {
      tutucu.oldur();
    }
  }, 60_000);

  it('0.1 işlemi yürürken 0.2 kimliği değiştiremez ve geride işaret bırakmaz', async (context) => {
    if (ortamYoksaAtla(context)) return;
    const eskiDist = await eskiDistCoz();
    if (eskiDist === null) return;

    const kok = await projeKur(eskiDist);
    const betik = join(kok, 'tutucu.mjs');
    await writeFile(betik, TUTUCU_BETIGI);
    const tutucu = await tutucuBaslat(eskiDist, kok, betik);
    try {
      const { yeni, eski } = isaretYollari(kok);
      expect(await duruyorMu(eski)).toBe(true);
      expect(await duruyorMu(yeni)).toBe(false);

      const sonuc = await kobayCalistir(YENI_DIST, kok, [
        'project', 'update', '--base-url', 'http://localhost:4000',
      ]);
      expect(sonuc.kod, sonuc.cikti).toBe(2);
      expect(sonuc.cikti).toContain("Another kobay command is changing this project's credentials");
      expect(sonuc.cikti).toContain(`pid ${tutucu.pid}`);
      // Reddedilen 0.2 komutu kendi adını geride bırakmamalı: bırakırsa 0.1'in
      // işlemi bittikten sonra kimse o dosyayı temizlemez.
      expect(await duruyorMu(yeni)).toBe(false);
      expect(await duruyorMu(eski)).toBe(true);
    } finally {
      tutucu.oldur();
    }
  }, 60_000);

  it('0.1 bayat işaret bırakmışsa 0.2 kurtarır ve iki ad da temiz kalır', async (context) => {
    if (ortamYoksaAtla(context)) return;
    const eskiDist = await eskiDistCoz();
    if (eskiDist === null) return;

    const kok = await projeKur(eskiDist);
    const betik = join(kok, 'tutucu.mjs');
    await writeFile(betik, TUTUCU_BETIGI);
    const tutucu = await tutucuBaslat(eskiDist, kok, betik);
    tutucu.oldur();
    await olmesiniBekle(tutucu.pid);

    const sonuc = await kobayCalistir(YENI_DIST, kok, [
      'project', 'update', '--base-url', 'http://localhost:4000',
    ]);
    expect(sonuc.kod, sonuc.cikti).toBe(0);
    expect(sonuc.cikti).toContain('an unfinished target change was rolled back');
    const { yeni, eski } = isaretYollari(kok);
    expect(await duruyorMu(yeni)).toBe(false);
    expect(await duruyorMu(eski)).toBe(false);
    const kalanlar = (await readdir(join(kok, '.kobay')))
      .filter((ad) => ad.startsWith('.eski-') || ad.startsWith('.stale-'));
    expect(kalanlar).toEqual([]);
  }, 60_000);

  it('0.2 bayat çift işaret bırakmışsa 0.1 kurtarır, kalan yeni ad sonraki 0.2 komutunda temizlenir', async (context) => {
    if (ortamYoksaAtla(context)) return;
    const eskiDist = await eskiDistCoz();
    if (eskiDist === null) return;

    const kok = await projeKur(YENI_DIST);
    const betik = join(kok, 'tutucu.mjs');
    await writeFile(betik, TUTUCU_BETIGI);
    const tutucu = await tutucuBaslat(YENI_DIST, kok, betik);
    tutucu.oldur();
    await olmesiniBekle(tutucu.pid);
    await configiEskiSemayaAl(kok);

    const { yeni, eski } = isaretYollari(kok);
    const eskiSonuc = await kobayCalistir(eskiDist, kok, [
      'project', 'update', '--base-url', 'http://localhost:4000',
    ]);
    expect(eskiSonuc.kod, eskiSonuc.cikti).toBe(0);
    // 0.1 kendi tanıdığı adı kurtarıp siler; `.credentials-txn`'i tanımaz.
    expect(await duruyorMu(eski)).toBe(false);
    expect(await duruyorMu(yeni)).toBe(true);

    // Sonraki 0.2 komutu kalan adı bayat sayıp işlemi geri alır ve temizler.
    const yeniSonuc = await kobayCalistir(YENI_DIST, kok, ['project', 'get']);
    expect(yeniSonuc.kod, yeniSonuc.cikti).toBe(0);
    expect(await duruyorMu(yeni)).toBe(false);
    expect(await duruyorMu(eski)).toBe(false);
    const kalanlar = (await readdir(join(kok, '.kobay')))
      .filter((ad) => ad.startsWith('.eski-') || ad.startsWith('.stale-'));
    expect(kalanlar).toEqual([]);
    // Yarım kalan işlem geri alındığı için kayıtlı kimlik yerine konmuş olmalı.
    expect(await duruyorMu(join(kok, '.kobay', 'credentials.json'))).toBe(true);
  }, 60_000);
});
