import { access, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import { KobayDizini, SAKLANAN_KOSU, yazAtomik, type PlanAdimi, type TestKaydi } from '../../src/depo/index.js';
import {
  FixtureModuluYok,
  fixtureYenidenAktarimMetni,
  hedefAyaktaMi,
  kaliciCalismaAlaniHazirla,
  kostur,
  testSureciOrtami,
} from '../../src/kos/index.js';
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
  return KobayDizini.ac(await mkdtemp(join(tmpdir(), 'kobay-kos-')), { baseUrl, beyin: { adaptor: 'sahte' } });
}

function testKaydi(id: string, planSteps: PlanAdimi[], status: TestKaydi['status'] = 'ready'): TestKaydi {
  return {
    id, name: 'giriş ekranını doğrular', type: 'frontend', createdFrom: 'cli', status, planSteps, priority: 'p1', codeVersion: 1,
    createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
  };
}

function kod(baseUrl: string, hatali = false, ucuncuAdim = false): string {
  return `import { test, expect } from './_fixture';
test('giriş ekranını doğrular', async ({ page }) => {
  await test.step('0: Giriş sayfasını aç', async () => {
    await page.goto('${baseUrl}/giris');
  });
  await test.step('1: Giriş başlığını gör', async () => {
    await expect(page.getByRole('heading', { name: '${hatali ? 'Yanlış başlık' : 'Giriş'}' })).toBeVisible();
  });
  ${ucuncuAdim ? `await test.step('2: Ulaşılmaması gereken adım', async () => {
    await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
  });` : ''}
});
`;
}

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
    const kok = await mkdtemp(join(tmpdir(), 'kobay-rapor-'));
    await yazAtomik(join(kok, 'adim-0.png'), 'png');
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
      { stepIndex: 0, description: 'Sayfayı aç', status: 'passed', durationMs: 7, screenshotPath: 'adim-0.png' },
      { stepIndex: 1, description: 'Başlığı doğrula', status: 'failed', durationMs: 9, errorMessage: 'Başlık yok' },
      { stepIndex: 2, description: 'Sonraki adım', status: 'skipped', durationMs: 0 },
    ]);
    expect(sonuc.hataMesaji).toBe('doğrulama düştü');
  });
});

describe('raporuAyristir — sahte yeşil koruması', () => {
  it('rapor hata taşıyor ve hiç test koşmadıysa motor hatası bildirir', async () => {
    const kok = await mkdtemp(join(tmpdir(), 'kobay-rapor-'));
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
    const kok = await mkdtemp(join(tmpdir(), 'kobay-rapor-'));
    const sonuc = await raporuAyristir(
      { stats: { expected: 0, unexpected: 0, skipped: 3, flaky: 0 }, errors: [], suites: [] },
      [{ type: 'action', description: 'Sayfayı aç' }],
      kok,
    );
    expect(sonuc.motorHatasi).toContain('hiç test koşmadı');
  });

  it('test geçti görünse bile hiçbir adım koşmadıysa motor hatası bildirir', async () => {
    const kok = await mkdtemp(join(tmpdir(), 'kobay-rapor-'));
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
    expect(sonuc.motorHatasi).toContain('hiçbir adımın koştuğunu göstermiyor');
  });

  it('gerçekten koşan rapora motor hatası uydurmaz', async () => {
    const kok = await mkdtemp(join(tmpdir(), 'kobay-rapor-'));
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
    const kok = await mkdtemp(join(tmpdir(), 'kobay-calisma-alani-'));
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
    const kok = await mkdtemp(join(tmpdir(), 'kobay-calisma-alani-'));
    const fixtureYolu = join(kok, 'tests', '_fixture.ts');
    await yazAtomik(fixtureYolu, 'export * from "/eski/kurulum/kobay/dist/kos/fixture.js";\n');
    await kaliciCalismaAlaniHazirla(kok);
    const yeni = await readFile(fixtureYolu, 'utf8');
    expect(yeni).not.toContain('/eski/kurulum/kobay');
    expect(yeni).toContain('kos/fixture.');
  });

  it('paketin fixture modülü yoksa açık hata atar ve fixture yazmaz', async () => {
    const kok = await mkdtemp(join(tmpdir(), 'kobay-calisma-alani-'));
    const sahtePaket = await mkdtemp(join(tmpdir(), 'kobay-sahte-paket-'));
    await expect(fixtureYenidenAktarimMetni(sahtePaket)).rejects.toThrow(FixtureModuluYok);
    await expect(fixtureYenidenAktarimMetni(sahtePaket)).rejects.toThrow(/npm run build/);
    await expect(kaliciCalismaAlaniHazirla(kok, sahtePaket)).rejects.toThrow(FixtureModuluYok);
    await expect(access(join(kok, 'tests', '_fixture.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('derlenmiş modül varsa onu yeniden dışa aktarır', async () => {
    const sahtePaket = await mkdtemp(join(tmpdir(), 'kobay-sahte-paket-'));
    await yazAtomik(join(sahtePaket, 'dist', 'kos', 'fixture.js'), 'export const test = 1;\n');
    expect(await fixtureYenidenAktarimMetni(sahtePaket))
      .toBe(`export * from ${JSON.stringify(join(sahtePaket, 'dist', 'kos', 'fixture.js'))};\n`);
  });
});

describe('kostur', () => {
  it('hedef kapalıysa Playwright başlatmadan blocked sonucu kaydeder', async () => {
    const dizin = await geciciDizin('http://127.0.0.1:1');
    const test = testKaydi('t_abcd1234', []);
    await dizin.testYaz(test);
    const { sonuc } = await kostur(dizin, test, { baseUrl: 'http://127.0.0.1:1' });
    expect(sonuc.verdict).toBe('blocked');
    await expect(access(join(await dizin.kosuDizini(sonuc.runId), 'pw-rapor.json'))).rejects.toMatchObject({ code: 'ENOENT' });
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
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', errorMessage: 'Test kodu yok' });
  });

  it('geçen testin üç adımını, kanıtlarını ve trace dosyasını kaydeder', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const dizin = await geciciDizin(demo.url);
    const test = testKaydi('t_abcd1234', [
      { type: 'action', description: 'Giriş sayfasını aç' },
      { type: 'assertion', description: 'Giriş başlığını gör' },
      { type: 'assertion', description: 'Giriş düğmesini gör' },
    ]);
    await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, kod(demo.url, false, true))]);
    const { sonuc, adimlar } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 10_000 });
    expect(sonuc.verdict).toBe('passed');
    expect(adimlar).toHaveLength(3);
    const kosuDizini = await dizin.kosuDizini(sonuc.runId);
    await Promise.all([access(join(kosuDizini, 'adim-0.png')), access(join(kosuDizini, 'trace.zip'))]);
    expect(JSON.parse(await readFile(join(kosuDizini, 'steps.json'), 'utf8'))).toHaveLength(3);
  });

  it('düşen adımı, hatasını ve sonraki skipped adımı kaydeder', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const dizin = await geciciDizin(demo.url);
    const test = testKaydi('t_abcd1234', [
      { type: 'action', description: 'Giriş sayfasını aç' },
      { type: 'assertion', description: 'Giriş başlığını gör' },
      { type: 'assertion', description: 'Ulaşılmaması gereken adım' },
    ]);
    await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, kod(demo.url, true, true))]);
    const { sonuc, adimlar } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 10_000 });
    expect(sonuc).toMatchObject({ verdict: 'failed', failedStepIndex: 1 });
    expect(adimlar[1]?.errorMessage).toBeTruthy();
    expect(adimlar[2]).toMatchObject({ status: 'skipped' });
    await expect(access(join(await dizin.kosuDizini(sonuc.runId), 'adim-1.png'))).resolves.toBeUndefined();
  });

  it('bayat fixture yolunu koşudan önce tazeler ve yeşili gerçekten koşturur', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const dizin = await geciciDizin(demo.url);
    const test = testKaydi('t_abcd1234', [
      { type: 'action', description: 'Giriş sayfasını aç' },
      { type: 'assertion', description: 'Giriş başlığını gör' },
    ]);
    await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, kod(demo.url))]);
    // Eski kurulumdan kalan yol: ayrı bir @playwright/test kopyası yüklenir, hiç test koşmaz.
    const fixtureYolu = join(dizin.kok, 'tests', '_fixture.ts');
    await yazAtomik(fixtureYolu, 'export * from "/eski/kurulum/kobay/dist/kos/fixture.js";\n');
    const { sonuc, adimlar } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 10_000 });
    expect(await readFile(fixtureYolu, 'utf8')).not.toContain('/eski/kurulum/kobay');
    expect(sonuc.verdict).toBe('passed');
    expect(adimlar.every((adim) => adim.status === 'passed')).toBe(true);
    const rapor = JSON.parse(await readFile(join(await dizin.kosuDizini(sonuc.runId), 'pw-rapor.json'), 'utf8'));
    expect(rapor.stats.expected).toBeGreaterThanOrEqual(1);
  });

  it('çalışma alanı hazırlanamazsa tarayıcı açmadan inconclusive döner', async () => {
    const dizin = await geciciDizin('data:text/plain,ok');
    const test = testKaydi('t_abcd1234', [{ type: 'action', description: 'Giriş sayfasını aç' }]);
    await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, kod('http://ornek.test'))]);
    // Fixture yoluna dizin koyarak hazırlığı bozuyoruz: koşu Playwright'ı hiç çağıramamalı.
    await mkdir(join(dizin.kok, 'tests', '_fixture.ts'), { recursive: true });
    const { sonuc } = await kostur(dizin, test, { baseUrl: 'data:text/plain,ok', testZamanAsimiMs: 5_000 });
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', status: 'unknown', failureKind: 'env' });
    expect(sonuc.errorMessage).toBeTruthy();
    await expect(access(join(await dizin.kosuDizini(sonuc.runId), 'pw-rapor.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Playwright hiç test koşmazsa passed değil inconclusive kaydeder', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const dizin = await geciciDizin(demo.url);
    const test = testKaydi('t_abcd1234', [
      { type: 'action', description: 'Giriş sayfasını aç' },
      { type: 'assertion', description: 'Giriş başlığını gör' },
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
      await sayfa.goto(`${demo.url}/giris`);
      await sayfa.getByLabel('Kullanıcı').fill('demo');
      await sayfa.getByLabel('Parola').fill('demo123');
      await sayfa.getByRole('button', { name: 'Giriş yap' }).click();
      await sayfa.waitForURL(`${demo.url}/`);
      await dizin.storageStateYaz(JSON.stringify(await baglam.storageState()));
    } finally {
      await tarayici.close();
    }

    const test = testKaydi('t_5e1f0a11', [
      { type: 'action', description: 'Panele git' },
      { type: 'assertion', description: 'Panel başlığını gör' },
    ]);
    const ortamDosyasi = join(dizin.kok, 'sizan-ortam.json');
    // Hız kesicinin aşıldığını varsayan kod: modül düzeyinde ve test içinde ortamı diske döker.
    const sizdiran = `import { test, expect } from './_fixture';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(`${ortamDosyasi}.modul`)}, JSON.stringify(process.env));
test('giriş ekranını doğrular', async ({ page }) => {
  await test.step('0: Panele git', async () => {
    await page.goto('${demo.url}/');
  });
  await test.step('1: Panel başlığını gör', async () => {
    await expect(page.getByRole('heading', { name: 'Kontrol Paneli' })).toBeVisible();
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
