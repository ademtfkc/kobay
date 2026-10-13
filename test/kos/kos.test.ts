import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';
import { dirname, join, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import { KobayDizini, SAKLANAN_KOSU, yazAtomik, type PlanAdimi, type TestKaydi } from '../../src/depo/index.js';
import {
  FixtureModuleMissing,
  fixtureYenidenAktarimMetni,
  hedefAyaktaMi,
  kaliciCalismaAlaniHazirla,
  kostur,
  testSureciOrtami,
} from '../../src/kos/index.js';
import { contextAc, contextKapat, videoSaklanmali, videoyuSonlandir } from '../../src/kos/fixture.js';
import { eylemZamanAsimiCoz, kaliciConfigMetni } from '../../src/kos/calisma-alani.js';
import { kanitiYaz } from '../../src/kos/fixture-sablonu.js';
import { raporuAyristir } from '../../src/kos/rapor.js';
import { baslat } from '../kobay-demo/sunucu.mjs';

let tarayiciEngeli: unknown;
let demo: { url: string; kapat: () => Promise<void> } | undefined;

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
  }
  if (tarayiciEngeli === undefined) demo = await baslat(0);
});

afterAll(async () => { await demo?.kapat(); });

function playwrightMumkun(context: TestContext): boolean {
  if (tarayiciEngeli === undefined) return true;
  context.skip(`Chromium engelli: ${String(tarayiciEngeli).split('\n')[0] ?? ''}`);
  return false;
}

async function geciciDizin(baseUrl: string): Promise<KobayDizini> {
  return KobayDizini.ac(await geciciDizinAc('kobay-kos-'), { baseUrl, beyin: { adaptor: 'sahte' } });
}

function testKaydi(id: string, planSteps: PlanAdimi[], status: TestKaydi['status'] = 'ready'): TestKaydi {
  return {
    id, name: 'verifies the login screen', type: 'frontend', createdFrom: 'cli', status, planSteps, priority: 'p1', codeVersion: 1,
    createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
  };
}

function kod(baseUrl: string, hatali = false, ucuncuAdim = false): string {
  return `import { test, expect } from './_fixture';
test('verifies the login screen', async ({ page }) => {
  await test.step('0: Open the login page', async () => {
    await page.goto('${baseUrl}/login');
  });
  await test.step('1: See the login heading', async () => {
    await expect(page.getByRole('heading', { name: '${hatali ? 'Wrong heading' : 'Login'}' })).toBeVisible();
  });
  ${ucuncuAdim ? `await test.step('2: Step that must never be reached', async () => {
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  });` : ''}
});
`;
}

async function webmDosyalari(kok: string): Promise<string[]> {
  const girdiler = await readdir(kok, { recursive: true, withFileTypes: true });
  return girdiler.filter((girdi) => girdi.isFile() && girdi.name.endsWith('.webm')).map((girdi) => girdi.name);
}

describe('video saklama', () => {
  it('yalnız beklenmeyen sonuçta saklar', () => {
    expect(videoSaklanmali({ status: 'failed', expectedStatus: 'passed' })).toBe(true);
    expect(videoSaklanmali({ status: 'timedOut', expectedStatus: 'passed' })).toBe(true);
    expect(videoSaklanmali({ status: 'passed', expectedStatus: 'passed' })).toBe(false);
    expect(videoSaklanmali({ status: 'skipped', expectedStatus: 'skipped' })).toBe(false);
  });

  it('saklanacak videoyu video.webm yapar, saklanmayanı siler, eksik kaynakta hata atmaz', async () => {
    const kok = await geciciDizinAc('kobay-video-');
    await mkdir(join(kok, 'pw', 'video'), { recursive: true });
    const kaynak = join(kok, 'pw', 'video', 'abc.webm');
    await writeFile(kaynak, 'webm');
    await videoyuSonlandir(kaynak, kok, true);
    expect(await webmDosyalari(kok)).toEqual(['video.webm']);

    const ikinci = join(kok, 'pw', 'video', 'def.webm');
    await writeFile(ikinci, 'webm');
    await videoyuSonlandir(ikinci, kok, false);
    expect(await webmDosyalari(kok)).toEqual(['video.webm']);

    await expect(videoyuSonlandir(join(kok, 'yok.webm'), join(kok, 'yok-dizin'), true)).resolves.toBeUndefined();
    await expect(videoyuSonlandir(undefined, kok, true)).resolves.toBeUndefined();
  });
});

describe('video hatası sonucu değiştirmez', () => {
  it('recordVideo ile context açılamazsa videosuz açar; videosuz da açılamazsa hata yayılır', async () => {
    const cagrilar: unknown[] = [];
    const sahteContext = { sahte: true };
    const tarayici = {
      newContext: async (secenek?: Record<string, unknown>) => {
        cagrilar.push(secenek);
        if (secenek?.recordVideo !== undefined) throw new Error('ffmpeg missing');
        return sahteContext;
      },
    } as unknown as Parameters<typeof contextAc>[0];
    const yazici = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const sonuc = await contextAc(tarayici, { storageState: 'state.json' }, '/tmp/x/pw/video');
      expect(sonuc).toEqual({ context: sahteContext, video: false });
      expect(cagrilar).toEqual([
        { storageState: 'state.json', recordVideo: { dir: '/tmp/x/pw/video' } },
        { storageState: 'state.json' },
      ]);
      const hepsiDuser = { newContext: async () => { throw new Error('browser gone'); } } as unknown as Parameters<typeof contextAc>[0];
      await expect(contextAc(hepsiDuser, {}, '/tmp/x/pw/video')).rejects.toThrow('browser gone');
    } finally {
      yazici.mockRestore();
    }
  });

  it('video varken reddedilen kapanışı yutar; videosuz ya da tarayıcı kopukken hatayı yayar', async () => {
    const dusen = { close: async () => { throw new Error('video flush failed'); } };
    const bagli = { isConnected: () => true };
    const yazici = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(contextKapat(dusen, true, bagli)).resolves.toBe(false);
      await expect(contextKapat(dusen, false, bagli)).rejects.toThrow('video flush failed');
      await expect(contextKapat(dusen, true, { isConnected: () => false })).rejects.toThrow('video flush failed');
      await expect(contextKapat({ close: async () => undefined }, true, bagli)).resolves.toBe(true);
    } finally {
      yazici.mockRestore();
    }
  });
});

describe('hedefAyaktaMi', () => {
  it('5xx yanıtını erişilebilir, bağlantı reddini erişilemez sayar', async () => {
    const oncekiFetch = globalThis.fetch;
    try {
      const cagriYontemleri: string[] = [];
      vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
        cagriYontemleri.push(String(init?.method ?? 'GET'));
        return new Response('', { status: 503 });
      });
      await expect(hedefAyaktaMi('http://ornek.test')).resolves.toBe(true);
      expect(cagriYontemleri).toEqual(['HEAD']);

      vi.stubGlobal('fetch', async () => { throw new TypeError('ECONNREFUSED'); });
      await expect(hedefAyaktaMi('http://ornek.test', 100)).resolves.toBe(false);
    } finally {
      vi.stubGlobal('fetch', oncekiFetch);
    }
  });
});

describe('raporuAyristir', () => {
  it('iç içe adımları düzleştirir, ANSI hatayı temizler ve olmayanı skipped yapar', async () => {
    const kok = await geciciDizinAc('kobay-rapor-');
    await yazAtomik(join(kok, 'step-0.png'), 'png');
    const rapor = {
      suites: [{ specs: [{ tests: [{ results: [{ status: 'failed', error: { message: '\u001b[31mdoğrulama düştü\u001b[0m' }, steps: [
        { title: 'yardımcı adım', duration: 2, steps: [{ title: '0: Sayfayı aç', duration: 7 }] },
        { title: '1: Başlığı doğrula', duration: 9, error: { message: '\u001b[31mBaşlık yok\u001b[0m' } },
      ] }] }] }] }],
    };
    const sonuc = await raporuAyristir(rapor, [
      { type: 'action', description: 'Sayfayı aç' },
      { type: 'assertion', description: 'Başlığı doğrula' },
      { type: 'assertion', description: 'Sonraki adım' },
    ], kok);
    expect(sonuc.adimlar).toEqual([
      { stepIndex: 0, description: 'Sayfayı aç', status: 'passed', durationMs: 7, screenshotPath: 'step-0.png' },
      { stepIndex: 1, description: 'Başlığı doğrula', status: 'failed', durationMs: 9, errorMessage: 'Başlık yok' },
      { stepIndex: 2, description: 'Sonraki adım', status: 'skipped', durationMs: 0 },
    ]);
    expect(sonuc.hataMesaji).toBe('doğrulama düştü');
  });
});

describe('raporuAyristir — sahte yeşil koruması', () => {
  it('rapor hata taşıyor ve hiç test koşmadıysa motor hatası bildirir', async () => {
    const kok = await geciciDizinAc('kobay-rapor-');
    // Gerçek koşudan alınmış biçim: iki ayrı @playwright/test kopyası, sıfır test.
    const rapor = {
      stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0 },
      errors: [
        { message: 'Error: Playwright Test did not expect test() to be called here.\nYou have two different versions of @playwright/test.' },
        { message: 'Error: No tests found.' },
      ],
      suites: [],
    };
    const sonuc = await raporuAyristir(rapor, [
      { type: 'action', description: 'Sayfayı aç' },
      { type: 'assertion', description: 'Başlığı doğrula' },
    ], kok);
    expect(sonuc.motorHatasi).toContain('two different versions');
    expect(sonuc.adimlar.every((adim) => adim.status === 'skipped')).toBe(true);
  });

  it('istatistik sıfırsa hata listesi boş olsa da motor hatası bildirir', async () => {
    const kok = await geciciDizinAc('kobay-rapor-');
    const sonuc = await raporuAyristir(
      { stats: { expected: 0, unexpected: 0, skipped: 3, flaky: 0 }, errors: [], suites: [] },
      [{ type: 'action', description: 'Sayfayı aç' }],
      kok,
    );
    expect(sonuc.motorHatasi).toContain('ran no tests');
  });

  it('test geçti görünse bile hiçbir adım koşmadıysa motor hatası bildirir', async () => {
    const kok = await geciciDizinAc('kobay-rapor-');
    const sonuc = await raporuAyristir(
      {
        stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
        errors: [],
        suites: [{ specs: [{ tests: [{ results: [{ status: 'passed', steps: [] }] }] }] }],
      },
      [{ type: 'action', description: 'Sayfayı aç' }],
      kok,
    );
    expect(sonuc.adimlar[0]).toMatchObject({ status: 'skipped' });
    expect(sonuc.motorHatasi).toContain('does not show a single step running');
  });

  it('gerçekten koşan rapora motor hatası uydurmaz', async () => {
    const kok = await geciciDizinAc('kobay-rapor-');
    const sonuc = await raporuAyristir(
      {
        stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
        errors: [],
        suites: [{ specs: [{ tests: [{ results: [{ status: 'passed', steps: [{ title: '0: Sayfayı aç', duration: 5 }] }] }] }] }],
      },
      [{ type: 'action', description: 'Sayfayı aç' }],
      kok,
    );
    expect(sonuc.motorHatasi).toBeUndefined();
    expect(sonuc.adimlar[0]).toMatchObject({ status: 'passed' });
  });
});

describe('kaliciCalismaAlaniHazirla', () => {
  it('kalıcı yapılandırmayı ve fixture yolunu yazar, aynı içerikte yeniden yazmaz', async () => {
    const kok = await geciciDizinAc('kobay-calisma-alani-');
    const ilk = await kaliciCalismaAlaniHazirla(kok);
    const once = await stat(ilk.configYolu);
    const fixtureOnce = await stat(ilk.fixtureYolu);
    const config = await readFile(ilk.configYolu, 'utf8');
    expect(config).toContain("testDir: 'tests'");
    expect(config).toContain("trace: 'on'");
    expect(await readFile(ilk.fixtureYolu, 'utf8')).toMatch(/^export \* from ".*kos\/fixture\.(js|ts)";\n$/);
    const ikinci = await kaliciCalismaAlaniHazirla(kok);
    expect((await stat(ikinci.configYolu)).mtimeMs).toBe(once.mtimeMs);
    expect((await stat(ikinci.fixtureYolu)).mtimeMs).toBe(fixtureOnce.mtimeMs);
  });

  it('bayat fixture yolunu aktif kobay paketine göre yeniden yazar', async () => {
    const kok = await geciciDizinAc('kobay-calisma-alani-');
    const fixtureYolu = join(kok, 'tests', '_fixture.ts');
    await yazAtomik(fixtureYolu, 'export * from "/eski/kurulum/kobay/dist/kos/fixture.js";\n');
    await kaliciCalismaAlaniHazirla(kok);
    const yeni = await readFile(fixtureYolu, 'utf8');
    expect(yeni).not.toContain('/eski/kurulum/kobay');
    expect(yeni).toContain('kos/fixture.');
  });

  it('paketin fixture modülü yoksa açık hata atar ve fixture yazmaz', async () => {
    const kok = await geciciDizinAc('kobay-calisma-alani-');
    const sahtePaket = await geciciDizinAc('kobay-sahte-paket-');
    await expect(fixtureYenidenAktarimMetni(sahtePaket)).rejects.toThrow(FixtureModuleMissing);
    await expect(fixtureYenidenAktarimMetni(sahtePaket)).rejects.toThrow(/npm run build/);
    await expect(kaliciCalismaAlaniHazirla(kok, sahtePaket)).rejects.toThrow(FixtureModuleMissing);
    await expect(access(join(kok, 'tests', '_fixture.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('derlenmiş modül varsa onu yeniden dışa aktarır', async () => {
    const sahtePaket = await geciciDizinAc('kobay-sahte-paket-');
    await yazAtomik(join(sahtePaket, 'dist', 'kos', 'fixture.js'), 'export const test = 1;\n');
    const beklenenYol = join(sahtePaket, 'dist', 'kos', 'fixture.js').split(sep).join('/');
    expect(await fixtureYenidenAktarimMetni(sahtePaket))
      .toBe(`export * from ${JSON.stringify(beklenenYol)};\n`);
  });

  it('aktif derlenmiş fixture İngilizce step kanıt adlarını içerir', async () => {
    const metin = await fixtureYenidenAktarimMetni();
    const eslesme = /^export \* from (.+);\n$/.exec(metin);
    expect(eslesme?.[1]).toBeDefined();
    const fixtureYolu = JSON.parse(eslesme?.[1] ?? 'null') as string;
    const sablonYolu = join(dirname(fixtureYolu), 'fixture-sablonu.js');
    expect(await readFile(sablonYolu, 'utf8')).toContain('step-${indeks}.png');
  });
});

describe('kostur', () => {
  it('hedef kapalıysa Playwright başlatmadan blocked sonucu kaydeder', async () => {
    const dizin = await geciciDizin('http://127.0.0.1:1');
    const test = testKaydi('t_abcd1234', []);
    await dizin.testYaz(test);
    const { sonuc } = await kostur(dizin, test, { baseUrl: 'http://127.0.0.1:1' });
    expect(sonuc.verdict).toBe('blocked');
    await expect(access(join(await dizin.kosuDizini(sonuc.runId), 'pw-report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await dizin.testOku(test.id)).status).toBe('blocked');
  });

  // Budama komut katmanına taşındı: koşu motoru, hata analizi henüz okumadan
  // kanıt dizinini silmemeli. Bu test budamanın buraya geri gelmesini yakalar.
  it('koşu motoru eski koşu dizinlerini budamaz', async () => {
    const dizin = await geciciDizin('http://127.0.0.1:1');
    const test = testKaydi('t_abcd1234', []);
    await dizin.testYaz(test);

    const runIdler: string[] = [];
    for (let sira = 0; sira < SAKLANAN_KOSU + 2; sira += 1) {
      const { sonuc } = await kostur(dizin, test, { baseUrl: 'http://127.0.0.1:1' });
      runIdler.push(sonuc.runId);
    }

    const kalan = (await dizin.kosuListele(test.id)).map((kosu) => kosu.runId);
    expect(kalan).toHaveLength(SAKLANAN_KOSU + 2);
    for (const runId of runIdler) {
      expect(kalan, runId).toContain(runId);
      expect((await stat(join(dizin.yol('runs'), runId))).isDirectory()).toBe(true);
    }
  });

  it('kod yoksa inconclusive sonucu kaydeder', async () => {
    const dizin = await geciciDizin('data:text/plain,ok');
    const test = testKaydi('t_abcd1234', [], 'draft');
    await dizin.testYaz(test);
    const { sonuc } = await kostur(dizin, test, { baseUrl: 'data:text/plain,ok' });
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', errorMessage: 'No test code' });
  });

  it('geçen testin üç adımını, kanıtlarını ve trace dosyasını kaydeder', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const dizin = await geciciDizin(demo.url);
    const test = testKaydi('t_abcd1234', [
      { type: 'action', description: 'Open the login page' },
      { type: 'assertion', description: 'See the login heading' },
      { type: 'assertion', description: 'See the login button' },
    ]);
    await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, kod(demo.url, false, true))]);
    const { sonuc, adimlar } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 10_000 });
    expect(sonuc.verdict).toBe('passed');
    expect(adimlar).toHaveLength(3);
    const kosuDizini = await dizin.kosuDizini(sonuc.runId);
    await Promise.all([access(join(kosuDizini, 'step-0.png')), access(join(kosuDizini, 'trace.zip'))]);
    expect(JSON.parse(await readFile(join(kosuDizini, 'steps.json'), 'utf8'))).toHaveLength(3);
    // Geçen testin videosu diskte hiçbir yerde kalmaz; ara video klasörü de kalmaz.
    expect(await webmDosyalari(kosuDizini)).toEqual([]);
    await expect(access(join(kosuDizini, 'pw', 'video'))).rejects.toThrow();
  });

  it('düşen adımı, hatasını ve sonraki skipped adımı kaydeder', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const dizin = await geciciDizin(demo.url);
    const test = testKaydi('t_abcd1234', [
      { type: 'action', description: 'Open the login page' },
      { type: 'assertion', description: 'See the login heading' },
      { type: 'assertion', description: 'Ulaşılmaması gereken adım' },
    ]);
    await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, kod(demo.url, true, true))]);
    const { sonuc, adimlar } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 10_000 });
    expect(sonuc).toMatchObject({ verdict: 'failed', failedStepIndex: 1 });
    expect(adimlar[1]?.errorMessage).toBeTruthy();
    expect(adimlar[2]).toMatchObject({ status: 'skipped' });
    const kosuDizini = await dizin.kosuDizini(sonuc.runId);
    await expect(access(join(kosuDizini, 'step-1.png'))).resolves.toBeUndefined();
    // Düşen testin videosu koşu dizininde tek WebM olarak kalır (EBML imzası).
    expect(await webmDosyalari(kosuDizini)).toEqual(['video.webm']);
    const video = await readFile(join(kosuDizini, 'video.webm'));
    expect(video.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  });

  it('Playwright hatasındaki gizli değer result.json, steps.json ve dönen sonuçta maskelenir (denetim N3)', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const dizin = await geciciDizin(demo.url);
    const sahteAnahtar = 'sk-SAHTEsahteSAHTE0123456789abcd';
    const test = testKaydi('t_abcd1234', [
      { type: 'action', description: 'Open the login page' },
      { type: 'assertion', description: 'See the key heading' },
    ]);
    const spec = kod(demo.url, true).replace("name: 'Wrong heading'", `name: '${sahteAnahtar}'`);
    expect(spec).toContain(sahteAnahtar);
    await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, spec)]);
    const { sonuc, adimlar } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 10_000 });
    expect(sonuc.verdict).toBe('failed');
    const kosuDizini = await dizin.kosuDizini(sonuc.runId);
    const [sonucMetni, adimMetni] = await Promise.all([
      readFile(join(kosuDizini, 'result.json'), 'utf8'), readFile(join(kosuDizini, 'steps.json'), 'utf8'),
    ]);
    // Anahtar Playwright hatasına gerçekten girdi (locator metni) ve maskelendi.
    expect(JSON.parse(sonucMetni).errorMessage).toContain('[redacted]');
    expect(adimlar[1]?.errorMessage).toContain('[redacted]');
    for (const metin of [sonucMetni, adimMetni, JSON.stringify(sonuc), JSON.stringify(adimlar)]) {
      expect(metin).not.toContain(sahteAnahtar);
    }
  });

  it('bayat fixture yolunu koşudan önce tazeler ve yeşili gerçekten koşturur', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const dizin = await geciciDizin(demo.url);
    const test = testKaydi('t_abcd1234', [
      { type: 'action', description: 'Open the login page' },
      { type: 'assertion', description: 'See the login heading' },
    ]);
    await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, kod(demo.url))]);
    // Eski kurulumdan kalan yol: ayrı bir @playwright/test kopyası yüklenir, hiç test koşmaz.
    const fixtureYolu = join(dizin.kok, 'tests', '_fixture.ts');
    await yazAtomik(fixtureYolu, 'export * from "/eski/kurulum/kobay/dist/kos/fixture.js";\n');
    const { sonuc, adimlar } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 10_000 });
    expect(await readFile(fixtureYolu, 'utf8')).not.toContain('/eski/kurulum/kobay');
    expect(sonuc.verdict).toBe('passed');
    expect(adimlar.every((adim) => adim.status === 'passed')).toBe(true);
    const rapor = JSON.parse(await readFile(join(await dizin.kosuDizini(sonuc.runId), 'pw-report.json'), 'utf8'));
    expect(rapor.stats.expected).toBeGreaterThanOrEqual(1);
  });

  it('çalışma alanı hazırlanamazsa tarayıcı açmadan inconclusive döner', async () => {
    const dizin = await geciciDizin('data:text/plain,ok');
    const test = testKaydi('t_abcd1234', [{ type: 'action', description: 'Open the login page' }]);
    await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, kod('http://ornek.test'))]);
    // Fixture yoluna dizin koyarak hazırlığı bozuyoruz: koşu Playwright'ı hiç çağıramamalı.
    await mkdir(join(dizin.kok, 'tests', '_fixture.ts'), { recursive: true });
    const { sonuc } = await kostur(dizin, test, { baseUrl: 'data:text/plain,ok', testZamanAsimiMs: 5_000 });
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', status: 'unknown', failureKind: 'env' });
    expect(sonuc.errorMessage).toBeTruthy();
    await expect(access(join(await dizin.kosuDizini(sonuc.runId), 'pw-report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Playwright hiç test koşmazsa passed değil inconclusive kaydeder', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const dizin = await geciciDizin(demo.url);
    const test = testKaydi('t_abcd1234', [
      { type: 'action', description: 'Open the login page' },
      { type: 'assertion', description: 'See the login heading' },
    ]);
    // Spec hiç test tanımlamıyor: Playwright "No tests found" der, rapor sıfır istatistikle döner.
    await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, "import { test, expect } from './_fixture';\nvoid test; void expect;\n")]);
    const { sonuc, adimlar } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 10_000 });
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', status: 'unknown', failureKind: 'env' });
    expect(sonuc.errorMessage).toContain('No tests found');
    expect(adimlar.every((adim) => adim.status === 'skipped')).toBe(true);
    expect((await dizin.testOku(test.id)).status).toBe('unknown');
  });
});

describe('eylem zaman aşımı ve kanıt koruması', () => {
  it('kalıcı yapılandırma metni değerlendirilince actionTimeout geçerli değeri verir, geçersizde 15000', () => {
    const degerlendir = (ortam: Record<string, string>): number => {
      const govde = kaliciConfigMetni().replace('export default', 'return');
      const yapilandirma = new Function('process', govde)({ env: ortam }) as { use: { actionTimeout: number } };
      return yapilandirma.use.actionTimeout;
    };
    expect(degerlendir({ KOBAY_ACTION_TIMEOUT_MS: '2500' })).toBe(2500);
    for (const gecersiz of ['0', '-1', 'abc', '', '1.5', ' ']) {
      expect(degerlendir({ KOBAY_ACTION_TIMEOUT_MS: gecersiz }), gecersiz).toBe(15000);
    }
    expect(degerlendir({})).toBe(15000);
  });

  it('eylemZamanAsimiCoz yalnız pozitif tam sayıyı kabul eder', () => {
    expect(eylemZamanAsimiCoz(2500)).toBe(2500);
    expect(eylemZamanAsimiCoz('2500')).toBe(2500);
    for (const gecersiz of [0, -1, Number.NaN, 1.5, 'abc', '', '0', '-5', undefined, null]) {
      expect(eylemZamanAsimiCoz(gecersiz), String(gecersiz)).toBe(15000);
    }
  });

  it('screenshot ve content hiç çözülmezse kanitiYaz tavan içinde döner, hata fırlatmaz', async () => {
    const dizin = await geciciDizinAc('kobay-kanit-');
    const askida = (): Promise<never> => new Promise<never>(() => undefined);
    await expect(kanitiYaz({ screenshot: askida, content: askida }, dizin, 1, 20)).resolves.toBeUndefined();
    expect(await readdir(dizin)).toEqual([]);
  });

  it('tavandan sonra reddedilen askıdaki çağrı işlenmemiş ret üretmez', async () => {
    const dizin = await geciciDizinAc('kobay-kanit-');
    const islenmemis: unknown[] = [];
    const dinleyici = (neden: unknown): void => { islenmemis.push(neden); };
    process.on('unhandledRejection', dinleyici);
    try {
      let reddet: (hata: Error) => void = () => undefined;
      const gec = new Promise<never>((_, red) => { reddet = red; });
      await kanitiYaz({ screenshot: () => gec, content: () => gec }, dizin, 2, 20);
      reddet(new Error('geç ret'));
      await new Promise((coz) => setTimeout(coz, 20));
      expect(islenmemis).toEqual([]);
    } finally {
      process.off('unhandledRejection', dinleyici);
    }
  });

  it('kanıt yakalama fırlatırsa kanıtiYaz fırlatmaz, alınabilen kanıtı yazar', async () => {
    const dizin = await geciciDizinAc('kobay-kanit-');
    const hata = new Error('Target page, context or browser has been closed');
    await expect(kanitiYaz({
      screenshot: () => Promise.reject(hata),
      content: () => Promise.resolve('<html>kalan</html>'),
    }, dizin, 3)).resolves.toBeUndefined();
    expect(await readFile(join(dizin, 'step-3.html'), 'utf8')).toBe('<html>kalan</html>');
    await expect(access(join(dizin, 'step-3.png'))).rejects.toMatchObject({ code: 'ENOENT' });

    const bos = await geciciDizinAc('kobay-kanit-');
    await expect(kanitiYaz({
      screenshot: () => Promise.reject(hata),
      content: () => Promise.reject(hata),
    }, bos, 0)).resolves.toBeUndefined();
  });

  it('kilitli düğmeye tıklama eylem zaman aşımında adım hatası verir, kanıt yazılır, asıl hata korunur', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const dizin = await geciciDizin(demo.url);
    const test = testKaydi('t_abcd1234', [{ index: 0, description: 'Click the locked button' }]);
    await dizin.testYaz(test);
    await dizin.kodYaz(test.id, `import { test } from './_fixture';
test('locked button', async ({ page }) => {
  await test.step('0: Click the locked button', async () => {
    await page.setContent('<button disabled>Send</button>');
    await page.getByRole('button', { name: 'Send' }).click();
  });
});
`);
    const { sonuc } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 60_000, eylemZamanAsimiMs: 1_000 });
    // Sayaç/olay ölçülür, duvar saati değil: test süresi dolmadan, eylem süresinde düştü.
    expect(sonuc.errorMessage).not.toBe('Run timed out');
    expect(sonuc.errorMessage).toMatch(/Timeout 1000ms exceeded/);
    const kosu = await dizin.kosuDizini(sonuc.runId);
    await access(join(kosu, 'step-0.png'));
    expect(await readFile(join(kosu, 'step-0.html'), 'utf8')).toContain('disabled');
  });
});

describe('testSureciOrtami', () => {
  it('sırları atar, Playwright ve tarayıcı için gerekenleri geçirir', () => {
    const ortam = testSureciOrtami({
      PATH: '/usr/bin', HOME: '/ev', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', TZ: 'Europe/Istanbul',
      PLAYWRIGHT_BROWSERS_PATH: '/pw', XAUTHORITY: '/x', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/d',
      HTTPS_PROXY: 'http://vekil:3128', HTTP_PROXY: 'http://ali:gizli@vekil:3128',
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', OPENROUTER_API_KEY: 'r', GITHUB_TOKEN: 'g', AWS_SECRET_ACCESS_KEY: 's',
      DB_PASSWORD: 'p', SMTP_PASS: 'p', KOBAY_LOGIN_PASS: 'demo123', KOBAY_LOGIN_USER: 'demo', DATABASE_URL: 'postgres://u:p@h/d',
      PLAYWRIGHT_SERVICE_ACCESS_TOKEN: 't', NODE_OPTIONS: '--require /kanca.js',
    }, { KOBAY_BASE_URL: 'http://hedef' });
    expect(ortam).toEqual({
      PATH: '/usr/bin', HOME: '/ev', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', TZ: 'Europe/Istanbul',
      PLAYWRIGHT_BROWSERS_PATH: '/pw', XAUTHORITY: '/x', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/d',
      HTTPS_PROXY: 'http://vekil:3128', KOBAY_BASE_URL: 'http://hedef',
    });
  });
});

describe('kostur sır yalıtımı', () => {
  it('girişli koşu storageState ile çalışır, üretilen kod sır ortam değişkenlerini göremez', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const dizin = await geciciDizin(demo.url);
    // Gerçek giriş: storageState kobay keşfinin yazdığı biçimde dosyaya düşer.
    const tarayici = await chromium.launch({ headless: true });
    try {
      const baglam = await tarayici.newContext();
      const sayfa = await baglam.newPage();
      await sayfa.goto(`${demo.url}/login`);
      await sayfa.getByLabel('Username').fill('demo');
      await sayfa.getByLabel('Password').fill('demo123');
      await sayfa.getByRole('button', { name: 'Log in' }).click();
      await sayfa.waitForURL(`${demo.url}/`);
      await dizin.storageStateYaz(JSON.stringify(await baglam.storageState()));
    } finally {
      await tarayici.close();
    }

    const test = testKaydi('t_5e1f0a11', [
      { type: 'action', description: 'Go to the dashboard' },
      { type: 'assertion', description: 'See the dashboard heading' },
    ]);
    const ortamDosyasi = join(dizin.kok, 'sizan-ortam.json');
    // Hız kesicinin aşıldığını varsayan kod: modül düzeyinde ve test içinde ortamı diske döker.
    const sizdiran = `import { test, expect } from './_fixture';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(`${ortamDosyasi}.modul`)}, JSON.stringify(process.env));
test('verifies the login screen', async ({ page }) => {
  await test.step('0: Go to the dashboard', async () => {
    await page.goto('${demo.url}/');
  });
  await test.step('1: See the dashboard heading', async () => {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    writeFileSync(${JSON.stringify(ortamDosyasi)}, JSON.stringify(process.env));
  });
});
`;
    await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, sizdiran)]);
    vi.stubEnv('FAKE_API_KEY', 'sahte-anahtar-9f3c');
    vi.stubEnv('KOBAY_LOGIN_PASS', 'sahte-parola-9f3c');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sahte-anthropic-9f3c');
    try {
      const { sonuc } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 10_000 });
      expect(sonuc.verdict).toBe('passed');
    } finally {
      vi.unstubAllEnvs();
    }
    for (const yol of [ortamDosyasi, `${ortamDosyasi}.modul`]) {
      const metin = await readFile(yol, 'utf8');
      expect(metin).not.toContain('9f3c');
      const ortam = JSON.parse(metin) as Record<string, string>;
      expect(ortam).not.toHaveProperty('FAKE_API_KEY');
      expect(ortam).not.toHaveProperty('KOBAY_LOGIN_PASS');
      expect(ortam.PATH).toBeTruthy();
    }
    const testIci = JSON.parse(await readFile(ortamDosyasi, 'utf8')) as Record<string, string>;
    expect(testIci.KOBAY_BASE_URL).toBe(demo.url);
  });
});
