import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sahteler = vi.hoisted(() => ({
  verdict: 'failed' as 'passed' | 'failed' | 'blocked' | 'inconclusive',
  kosturHatasi: undefined as Error | undefined,
  errorMessage: undefined as string | undefined,
  girisYapildi: false,
  hedefAyakta: true,
}));

const dosyaDurumu = vi.hoisted(() => ({
  /** Belirli bir `rm` çağrısını düşürmek için; `true` dönerse o çağrı EBUSY verir. */
  rmKosulu: undefined as ((yol: string) => boolean) | undefined,
  /** Belirli bir `rename` çağrısını düşürmek için; dönen değer hatanın `code` alanıdır. */
  renameKosulu: undefined as ((eski: string, yeni: string) => string | undefined) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const asil = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...asil,
    rm: async (yol: Parameters<typeof asil.rm>[0], secenekler?: Parameters<typeof asil.rm>[1]) => {
      if (dosyaDurumu.rmKosulu?.(String(yol)) === true) {
        throw Object.assign(new Error('silme simülasyonu'), { code: 'EBUSY' });
      }
      await asil.rm(yol, secenekler);
    },
    rename: async (eski: string, yeni: string) => {
      const kod = dosyaDurumu.renameKosulu?.(String(eski), String(yeni));
      if (kod !== undefined) {
        throw Object.assign(new Error('yeniden adlandırma simülasyonu'), { code: kod });
      }
      await asil.rename(eski, yeni);
    },
  };
});

vi.mock('../../src/kesif/index.js', () => ({
  kesfet: vi.fn(async ({ baseUrl }: { baseUrl: string }) => ({
    baseUrl,
    girisYapildi: sahteler.girisYapildi,
    kesifTarihi: '2026-09-17T00:00:00.000Z',
    sayfalar: [{
      url: `${baseUrl}/`, baslik: 'Ana sayfa', basliklar: ['Ana sayfa'], linkler: [],
      formlar: [], dugmeler: [], menu: [],
    }],
  })),
}));

vi.mock('../../src/kos/index.js', () => ({
  hedefAyaktaMi: vi.fn(async () => sahteler.hedefAyakta),
  kostur: vi.fn(async (_dizin: unknown, test: { id: string; codeVersion: number }) => {
    if (sahteler.kosturHatasi !== undefined) throw sahteler.kosturHatasi;
    const durum = sahteler.verdict === 'inconclusive' ? 'unknown' : sahteler.verdict;
    const sonuc = {
      testId: test.id,
      runId: 'r_20260917010101_abcd',
      status: durum,
      verdict: sahteler.verdict,
      startedAt: '2026-09-17T00:00:00.000Z',
      finishedAt: '2026-09-17T00:00:01.000Z',
      codeVersion: test.codeVersion,
      ...(sahteler.verdict === 'failed' ? { failedStepIndex: 0, errorMessage: 'Başlık bulunamadı' } : {}),
      ...(sahteler.errorMessage === undefined ? {} : { errorMessage: sahteler.errorMessage }),
    };
    return {
      sonuc,
      adimlar: sahteler.verdict === 'failed'
        ? [{ stepIndex: 0, description: 'Ana sayfayı aç', status: 'failed', durationMs: 10, errorMessage: 'Başlık bulunamadı' }]
        : [],
    };
  }),
}));

import { BeyinHatasi } from '../../src/beyin/index.js';
import { ciktiYaz } from '../../src/cli/cikti.js';
import { KobayDizini, SAKLANAN_KOSU, yazAtomik, type KosuSonucu, type TestKaydi } from '../../src/depo/index.js';
import {
  agentInstall,
  doctor,
  explore,
  failureGet,
  planAccept,
  planGenerate,
  projectCreate,
  projectGet,
  projectUpdate,
  testResult,
  setup,
  testGet,
  testList,
  testCreate,
  testRerun,
  testRun,
} from '../../src/cli/komutlar/index.js';
import { kesfet } from '../../src/kesif/index.js';
import { CHROMIUM_ONERISI, nodeSurumuYeterliMi } from '../../src/cli/komutlar/doctor.js';

function metinTopla(akis: PassThrough): { oku: () => string } {
  let metin = '';
  akis.setEncoding('utf8');
  akis.on('data', (parca: string) => { metin += parca; });
  return { oku: () => metin };
}

async function geciciDizin(onEk = 'kobay-cli-'): Promise<string> {
  return mkdtemp(join(tmpdir(), onEk));
}

async function sahteYanitlariYaz(): Promise<string> {
  const yanitlar = await geciciDizin('kobay-cli-yanit-');
  const kod = [
    "import { test, expect } from './_fixture';",
    "test('Giriş akışı', async ({ page }) => {",
    "  await test.step('0: Ana sayfayı aç', async () => { await page.goto('/'); });",
    "  await test.step('1: Başlığı gör', async () => { await expect(page.locator('body')).toBeVisible(); });",
    '});',
    '',
  ].join('\n');
  await Promise.all([
    yazAtomik(join(yanitlar, 'plan.json'), JSON.stringify({ oneriler: [{
      title: 'Giriş akışı', description: 'Ana sayfa açılır', priority: 'p0', category: 'duman',
      feature: 'ana-sayfa', type: 'frontend', url: '/',
      steps: [
        { type: 'action', description: 'Ana sayfayı aç' },
        { type: 'assertion', description: 'Başlığı gör' },
      ],
    }] })),
    yazAtomik(join(yanitlar, 'playwright-kod-uret.json'), JSON.stringify({ kod })),
    yazAtomik(join(yanitlar, 'analiz.json'), JSON.stringify({
      rootCauseHypothesis: 'Başlık değişmiş', failureKind: 'product_bug',
      recommendedFixTarget: { kind: 'code', reference: 'ana sayfa', rationale: 'Beklenen başlık yok' },
      evidence: [],
    })),
  ]);
  return yanitlar;
}

/** Sahte `kostur` her koşuda bu kimliği döndürür. */
const SAHTE_KOSU_ID = 'r_20260917010101_abcd';

/** Koşusu budanacak, kodu hazır tek testli bir proje. */
async function budamaProjesi(): Promise<{ cwd: string; dizin: KobayDizini; test: TestKaydi }> {
  const cwd = await geciciDizin();
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
  const test: TestKaydi = {
    id: 't_abc12345', name: 'Hazır test', type: 'frontend', createdFrom: 'cli', status: 'ready',
    planSteps: [{ type: 'action', description: 'Ana sayfayı aç' }], priority: 'p1', codeVersion: 1,
    createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
  };
  await dizin.testYaz(test);
  await dizin.kodYaz(test.id, '// hazır');
  process.env.KOBAY_SAHTE_YANIT_DIZINI = await sahteYanitlariYaz();
  await yazAtomik(join(process.env.KOBAY_SAHTE_YANIT_DIZINI, `analiz-${test.id}.json`), JSON.stringify({
    rootCauseHypothesis: 'Başlık değişmiş', failureKind: 'product_bug',
    recommendedFixTarget: { kind: 'code', reference: 'ana sayfa', rationale: 'Beklenen başlık yok' }, evidence: [],
  }));
  return { cwd, dizin, test };
}

/** Diske gerçek bir koşu dizini (result.json + kanıt dosyası) bırakır. */
async function kosuYaz(
  dizin: KobayDizini,
  testId: string,
  runId: string,
  zaman: { startedAt: string; finishedAt: string },
  verdict: KosuSonucu['verdict'] = 'failed',
): Promise<void> {
  await dizin.kosuSonucuYaz({
    testId, runId, status: verdict === 'failed' ? 'failed' : 'passed', verdict, codeVersion: 1, ...zaman,
  });
  await yazAtomik(join(dizin.yol('runs'), runId, 'adim-0.html'), '<html>kanıt</html>');
}

function kosuKimlikleri(adet: number, gun: string): string[] {
  return Array.from({ length: adet }, (_, sira) => `r_2026${gun}0101${String(10 + sira)}_aa0${sira}`);
}

afterEach(() => {
  sahteler.verdict = 'failed';
  sahteler.kosturHatasi = undefined;
  sahteler.errorMessage = undefined;
  sahteler.girisYapildi = false;
  sahteler.hedefAyakta = true;
  dosyaDurumu.rmKosulu = undefined;
  dosyaDurumu.renameKosulu = undefined;
  delete process.env.KOBAY_SAHTE_YANIT_DIZINI;
});

describe('CLI komut fonksiyonları', () => {
  it('project create → plan generate → accept → run → failure get zincirini tamamlar', async () => {
    const cwd = await geciciDizin();
    process.env.KOBAY_SAHTE_YANIT_DIZINI = await sahteYanitlariYaz();

    expect((await projectCreate({ cwd, url: 'http://uygulama.test', beyin: { adaptor: 'sahte' } })).exitCode).toBe(0);
    const plan = await planGenerate({ cwd, hint: 'Duman akışını üret' });
    expect(plan.exitCode).toBe(0);
    expect((plan.json as { oneriler: unknown[] }).oneriler).toHaveLength(1);

    const kabul = await planAccept({ cwd, all: true });
    expect(kabul.exitCode).toBe(0);
    const test = (kabul.json as TestKaydi[])[0];
    expect(test?.status).toBe('draft');
    await yazAtomik(join(process.env.KOBAY_SAHTE_YANIT_DIZINI!, `uret-${test?.id}.json`), JSON.stringify({
      kod: [
        "import { test, expect } from './_fixture';",
        "test('Giriş akışı', async ({ page }) => {",
        "  await test.step('0: Ana sayfayı aç', async () => { await page.goto('/'); });",
        "  await test.step('1: Başlığı gör', async () => { await expect(page.locator('body')).toBeVisible(); });",
        '});',
        '',
      ].join('\n'),
    }));
    await yazAtomik(join(process.env.KOBAY_SAHTE_YANIT_DIZINI!, `analiz-${test?.id}.json`), JSON.stringify({
      rootCauseHypothesis: 'Başlık değişmiş', failureKind: 'product_bug',
      recommendedFixTarget: { kind: 'code', reference: 'ana sayfa', rationale: 'Beklenen başlık yok' }, evidence: [],
    }));

    const kosu = await testRun({ cwd, all: true });
    expect(kosu.exitCode).toBe(1);
    expect(kosu.json).toEqual([expect.objectContaining({ id: test?.id, verdict: 'failed' })]);
    await Promise.all([
      access(join(cwd, '.kobay', 'logs', `beyin-uret-${test?.id}-1.log`)),
      access(join(cwd, '.kobay', 'logs', `beyin-analiz-${test?.id}-1.log`)),
    ]);

    const hedef = join(cwd, 'disari-aktarilan-hata');
    const paket = await failureGet({ cwd, id: test?.id ?? '', out: hedef });
    expect(paket.exitCode).toBe(0);
    await expect(access(join(hedef, 'failure.json'))).resolves.toBeUndefined();
    expect(await readFile(join(hedef, 'code.ts'), 'utf8')).toContain("test('Giriş akışı'");
  });

  it.each([
    ['passed', 0],
    ['failed', 1],
    ['blocked', 3],
    ['inconclusive', 4],
  ] as const)('%s sonucunu doğru exit koduna eşler', async (verdict, exitCode) => {
    const cwd = await geciciDizin();
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    const test: TestKaydi = {
      id: 't_abc12345', name: 'Hazır test', type: 'frontend', createdFrom: 'cli', status: 'ready',
      planSteps: [{ type: 'action', description: 'Ana sayfayı aç' }], priority: 'p1', codeVersion: 1,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    };
    await dizin.testYaz(test);
    await dizin.kodYaz(test.id, '// hazır');
    process.env.KOBAY_SAHTE_YANIT_DIZINI = await sahteYanitlariYaz();
    await yazAtomik(join(process.env.KOBAY_SAHTE_YANIT_DIZINI!, `analiz-${test.id}.json`), JSON.stringify({
      rootCauseHypothesis: 'Başlık değişmiş', failureKind: 'product_bug',
      recommendedFixTarget: { kind: 'code', reference: 'ana sayfa', rationale: 'Beklenen başlık yok' }, evidence: [],
    }));
    sahteler.verdict = verdict;

    expect((await testRun({ cwd, all: true })).exitCode).toBe(exitCode);
  });

  it('BeyinHatasi için exit 4 döndürür ve diğer testlere devam edebilir', async () => {
    const cwd = await geciciDizin();
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    const test: TestKaydi = {
      id: 't_abc12345', name: 'Hazır test', type: 'frontend', createdFrom: 'cli', status: 'ready',
      planSteps: [{ type: 'action', description: 'Aç' }], priority: 'p1', codeVersion: 1,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    };
    await dizin.testYaz(test);
    await dizin.kodYaz(test.id, '// hazır');
    sahteler.kosturHatasi = new BeyinHatasi('ag');

    const sonuc = await testRun({ cwd, all: true });
    expect(sonuc.exitCode).toBe(4);
    expect(sonuc.json).toEqual([expect.objectContaining({ verdict: 'inconclusive' })]);
  });

  it('düşen koşuda budamayı hata paketinden sonra yapar, koşunun kanıtını bırakır', async () => {
    const { cwd, dizin, test } = await budamaProjesi();
    // Hepsi bu koşudan eski ve bayat (10 dakikadan yaşlı) koşular.
    const eskiler = kosuKimlikleri(SAKLANAN_KOSU + 1, '0916');
    for (const runId of eskiler) {
      await kosuYaz(dizin, test.id, runId, {
        startedAt: '2026-09-16T01:01:01.000Z', finishedAt: '2026-09-16T01:01:02.000Z',
      });
    }
    sahteler.verdict = 'failed';

    expect((await testRun({ cwd, ids: [test.id] })).exitCode).toBe(1);

    const kalan = (await dizin.kosuListele(test.id)).map((kosu) => kosu.runId);
    // Budama komut katmanında çalıştı: en eski ikisi gitti, son beş kaldı.
    expect(kalan).toHaveLength(SAKLANAN_KOSU);
    expect(kalan).not.toContain(eskiler[0]);
    // Analiz edilen koşunun kanıtı yerinde ve paket bu koşuyu gösteriyor.
    expect(kalan).toContain(SAHTE_KOSU_ID);
    await expect(access(join(cwd, '.kobay', 'runs', SAHTE_KOSU_ID, 'result.json'))).resolves.toBeUndefined();
    await expect(dizin.hataPaketiOku(test.id)).resolves.toMatchObject({ runId: SAHTE_KOSU_ID });
  });

  it('budama, son beşin dışında kalsa bile az önce biten koşuyu silmez', async () => {
    const { cwd, dizin, test } = await budamaProjesi();
    // Bu koşudan daha yeni ama bayat altı koşu: koruma olmasa az önce biten koşu silinirdi.
    for (const runId of kosuKimlikleri(SAKLANAN_KOSU + 1, '0918')) {
      await kosuYaz(dizin, test.id, runId, {
        startedAt: '2026-09-18T01:01:01.000Z', finishedAt: '2026-09-18T01:01:02.000Z',
      });
    }
    // Geçen koşuda paket yazılmaz; koşunun dizinini gerçek motorun yerine burada kuruyoruz.
    await kosuYaz(dizin, test.id, SAHTE_KOSU_ID, {
      startedAt: '2026-09-17T00:00:00.000Z', finishedAt: '2026-09-17T00:00:01.000Z',
    }, 'passed');
    sahteler.verdict = 'passed';

    expect((await testRun({ cwd, ids: [test.id] })).exitCode).toBe(0);

    const kalan = (await dizin.kosuListele(test.id)).map((kosu) => kosu.runId);
    expect(kalan).toContain(SAHTE_KOSU_ID);
    await expect(access(join(cwd, '.kobay', 'runs', SAHTE_KOSU_ID, 'adim-0.html'))).resolves.toBeUndefined();
  });

  it('son dakikalarda biten koşuları budamaz (eşzamanlı koşunun kanıtı)', async () => {
    const { cwd, dizin, test } = await budamaProjesi();
    // Eşzamanlı koşuları taklit eder: biraz önce bitmişler, analizleri daha başlamamış olabilir.
    const tazeler = kosuKimlikleri(SAKLANAN_KOSU + 1, '0919');
    for (const [sira, runId] of tazeler.entries()) {
      const an = new Date(Date.now() - (tazeler.length - sira) * 1000).toISOString();
      await kosuYaz(dizin, test.id, runId, { startedAt: an, finishedAt: an });
    }
    // Bu koşu hepsinden yeni: kendi koruması son beşi zaten kapsıyor, tazeler
    // yalnız "son 10 dakika" kuralıyla kurtuluyor.
    const simdi = new Date().toISOString();
    await kosuYaz(dizin, test.id, SAHTE_KOSU_ID, { startedAt: simdi, finishedAt: simdi }, 'passed');
    sahteler.verdict = 'passed';

    expect((await testRun({ cwd, ids: [test.id] })).exitCode).toBe(0);

    const kalan = (await dizin.kosuListele(test.id)).map((kosu) => kosu.runId);
    for (const runId of tazeler) expect(kalan, runId).toContain(runId);
    expect(kalan).toHaveLength(tazeler.length + 1);
  });

  it('budama listeyi bir kez okur: listeleme sonrası beliren koşuyu silmez', async () => {
    const { cwd, dizin, test } = await budamaProjesi();
    // Son beşin dışında kalacak, hepsi bayat koşular.
    const eskiler = kosuKimlikleri(SAKLANAN_KOSU + 1, '0916');
    for (const runId of eskiler) {
      await kosuYaz(dizin, test.id, runId, {
        startedAt: '2026-09-16T01:01:01.000Z', finishedAt: '2026-09-16T01:01:02.000Z',
      });
    }
    // Eşzamanlı koşu: liste alındıktan sonra diske düşüyor, startedAt'i
    // hepsinden eski olduğu için sıralamada başa girer. Zaman damgaları bilerek
    // bayat: kurtulması "listede yoktu" kuralından gelsin, tazelik korumasından
    // değil. Budama listeyi ikinci kez okursa onu son beşin dışında görüp siler.
    const gecBeliren = 'r_20260915000000_gec1';
    let enjekteEdildi = false;
    const asilListele = KobayDizini.prototype.kosuListele;
    const casus = vi.spyOn(KobayDizini.prototype, 'kosuListele')
      .mockImplementation(async function listele(this: KobayDizini, testId: string) {
        const liste = await asilListele.call(this, testId);
        if (!enjekteEdildi) {
          enjekteEdildi = true;
          await kosuYaz(this, testId, gecBeliren, {
            startedAt: '2026-09-15T00:00:00.000Z', finishedAt: '2026-09-15T00:00:02.000Z',
          });
        }
        return liste;
      });

    try {
      expect((await testRun({ cwd, ids: [test.id] })).exitCode).toBe(1);
      // Tek listeleme: silme kararı tek anlık görüntü üzerinde verilir.
      expect(casus).toHaveBeenCalledTimes(1);
    } finally {
      casus.mockRestore();
    }

    const kalan = (await dizin.kosuListele(test.id)).map((kosu) => kosu.runId);
    expect(kalan).toContain(gecBeliren);
    expect(kalan).toContain(SAHTE_KOSU_ID);
    // Budama yine de işini yaptı: en eski iki bayat koşu gitti.
    expect(kalan).not.toContain(eskiler[0]);
    expect(kalan).not.toContain(eskiler[1]);
  });

  it('rerun kod yoksa kod üretmeden exit 4 döndürür', async () => {
    const cwd = await geciciDizin();
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    await dizin.testYaz({
      id: 't_abc12345', name: 'Kodsuz', type: 'frontend', createdFrom: 'cli', status: 'draft',
      planSteps: [{ type: 'action', description: 'Aç' }], priority: 'p1', codeVersion: 0,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    });

    const sonuc = await testRun({ cwd, ids: ['t_abc12345'], rerun: true });
    expect(sonuc.exitCode).toBe(4);
    await expect(dizin.kodOku('t_abc12345')).resolves.toBeNull();
  });

  it('başarısız girişi exit 5 olarak eşler', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd,
      url: 'http://uygulama.test',
      login: { kullanici: 'yanlis', parola: 'yanlis' },
      beyin: { adaptor: 'sahte' },
    });

    const sonuc = await explore({ cwd });
    expect(sonuc.exitCode).toBe(5);
    expect(sonuc.json).toEqual({
      hata: expect.objectContaining({ kod: 'YetkiHatasi' }),
    });
  });

  it('yarım hata paketini exit 4 olarak eşler', async () => {
    const cwd = await geciciDizin();
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    await yazAtomik(dizin.yol('failure', 't_abc12345', '.partial'), '');

    const sonuc = await failureGet({ cwd, id: 't_abc12345', out: join(cwd, 'paket') });
    expect(sonuc.exitCode).toBe(4);
    expect(sonuc.json).toEqual({ hata: expect.objectContaining({ kod: 'PaketYarim' }) });
  });

  it('OpenRouter anahtarı yoksa exit 5 verir ve anahtar değeri üretmez', async () => {
    const sonuc = await setup({ beyin: 'openrouter', env: {}, home: await geciciDizin() });
    expect(sonuc.exitCode).toBe(5);
    expect(JSON.stringify(sonuc.json)).not.toContain('sk-');
  });

  it('setup global varsayılanı atomik yazar, OpenRouter anahtarını yazmaz', async () => {
    const home = await geciciDizin();
    const sonuc = await setup({
      beyin: 'openrouter', model: 'ornek-model', env: { OPENROUTER_API_KEY: 'sk-cok-gizli' }, home,
    });
    expect(sonuc.exitCode).toBe(0);
    const metin = await readFile(join(home, '.kobay', 'config.json'), 'utf8');
    expect(JSON.parse(metin)).toEqual({ beyin: { adaptor: 'openrouter', model: 'ornek-model' } });
    expect(`${JSON.stringify(sonuc)}${metin}`).not.toContain('sk-cok-gizli');
  });
  it('project update yalnız verilen alanları değiştirir, gerisini korur', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://uygulama.test', docs: 'docs/eski.md', beyin: { adaptor: 'sahte', model: 'eski-model' },
    });
    const dizin = await KobayDizini.bul(cwd);

    expect((await projectUpdate({ cwd, loginUrl: 'http://uygulama.test/giris' })).exitCode).toBe(0);
    await expect(dizin?.configOku()).resolves.toEqual({
      baseUrl: 'http://uygulama.test',
      docsPath: 'docs/eski.md',
      loginUrl: 'http://uygulama.test/giris',
      beyin: { adaptor: 'sahte', model: 'eski-model' },
    });

    expect((await projectUpdate({ cwd, beyin: { adaptor: 'codex' } })).exitCode).toBe(0);
    await expect(dizin?.configOku()).resolves.toMatchObject({ beyin: { adaptor: 'codex', model: 'eski-model' } });

    expect((await projectUpdate({
      cwd, url: 'http://yeni.test', loginUrl: 'http://yeni.test/giris', docs: 'docs/yeni.md',
    })).exitCode).toBe(0);
    await expect(dizin?.configOku()).resolves.toEqual({
      baseUrl: 'http://yeni.test',
      docsPath: 'docs/yeni.md',
      loginUrl: 'http://yeni.test/giris',
      beyin: { adaptor: 'codex', model: 'eski-model' },
    });
  });

  it('project create ve update farklı origin loginUrl kaydetmez', async () => {
    const cwd = await geciciDizin();
    const olustur = await projectCreate({
      cwd,
      url: 'http://uygulama.test',
      loginUrl: 'https://kimlik.test/giris',
      beyin: { adaptor: 'sahte' },
    });
    expect(olustur.exitCode).toBe(2);
    await expect(access(join(cwd, '.kobay'))).rejects.toThrow();

    await projectCreate({
      cwd,
      url: 'http://uygulama.test',
      loginUrl: 'http://uygulama.test/giris',
      beyin: { adaptor: 'sahte' },
    });
    const guncelle = await projectUpdate({ cwd, loginUrl: 'http://kimlik.test/giris' });
    expect(guncelle.exitCode).toBe(2);
    expect(JSON.stringify(guncelle.json)).toContain('aynı origin');
    await expect((await KobayDizini.bul(cwd))?.configOku()).resolves.toMatchObject({
      baseUrl: 'http://uygulama.test', loginUrl: 'http://uygulama.test/giris',
    });
  });

  it('project update alan verilmezse, proje yoksa ve URL bozuksa exit 2 döner', async () => {
    const cwd = await geciciDizin();
    const projesiz = await projectUpdate({ cwd, url: 'http://uygulama.test' });
    expect(projesiz.exitCode).toBe(2);
    expect(projesiz.json).toEqual({ hata: expect.objectContaining({ kod: 'KullanimHatasi' }) });

    await projectCreate({ cwd, url: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    expect((await projectUpdate({ cwd })).exitCode).toBe(2);
    expect((await projectUpdate({ cwd, url: 'bozuk-url' })).exitCode).toBe(2);
    await expect((await KobayDizini.bul(cwd))?.configOku()).resolves.toMatchObject({
      baseUrl: 'http://uygulama.test',
    });
  });

  it('project create var olan projede exit 2; --force yalnız configi yeniden yazar', async () => {
    const cwd = await geciciDizin();
    await projectCreate({ cwd, url: 'http://uygulama.test', docs: 'docs/eski.md', beyin: { adaptor: 'sahte' } });
    const dizin = await KobayDizini.bul(cwd);
    const test: TestKaydi = {
      id: 't_abc12345', name: 'Korunacak test', type: 'frontend', createdFrom: 'cli', status: 'ready',
      planSteps: [{ type: 'action', description: 'Aç' }], priority: 'p1', codeVersion: 1,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    };
    await dizin?.testYaz(test);
    await dizin?.kodYaz(test.id, '// korunacak kod');
    await dizin?.haritaYaz({
      baseUrl: 'http://uygulama.test', girisYapildi: false, kesifTarihi: '2026-09-17T00:00:00.000Z', sayfalar: [],
    });

    const zorlamasiz = await projectCreate({ cwd, url: 'http://yeni.test', beyin: { adaptor: 'sahte' } });
    expect(zorlamasiz.exitCode).toBe(2);
    expect(zorlamasiz.json).toEqual({ hata: expect.objectContaining({ kod: 'KullanimHatasi' }) });

    const zorlamali = await projectCreate({ cwd, url: 'http://yeni.test', beyin: { adaptor: 'sahte' }, force: true });
    expect(zorlamali.exitCode).toBe(0);
    await expect(dizin?.configOku()).resolves.toEqual({
      baseUrl: 'http://yeni.test', beyin: { adaptor: 'sahte' },
    });
    await expect(dizin?.testOku(test.id)).resolves.toMatchObject({ name: 'Korunacak test' });
    await expect(dizin?.kodOku(test.id)).resolves.toBe('// korunacak kod');
    await expect(dizin?.haritaOku()).resolves.toMatchObject({ baseUrl: 'http://uygulama.test' });
  });

  it('düşen koşuda failureKind result.jsona yazılır ve test result çıktısında görünür', async () => {
    const cwd = await geciciDizin();
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    const test: TestKaydi = {
      id: 't_abc12345', name: 'Hazır test', type: 'frontend', createdFrom: 'cli', status: 'ready',
      planSteps: [{ type: 'action', description: 'Ana sayfayı aç' }], priority: 'p1', codeVersion: 1,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    };
    await dizin.testYaz(test);
    await dizin.kodYaz(test.id, '// hazır');
    process.env.KOBAY_SAHTE_YANIT_DIZINI = await sahteYanitlariYaz();
    await yazAtomik(join(process.env.KOBAY_SAHTE_YANIT_DIZINI!, `analiz-${test.id}.json`), JSON.stringify({
      rootCauseHypothesis: 'Başlık değişmiş', failureKind: 'product_bug',
      recommendedFixTarget: { kind: 'code', reference: 'ana sayfa', rationale: 'Beklenen başlık yok' }, evidence: [],
    }));

    const kosu = await testRun({ cwd, all: true });
    expect(kosu.exitCode).toBe(1);
    const paket = await dizin.hataPaketiOku(test.id);
    const kayitli = await dizin.kosuSonucuOku('r_20260917010101_abcd');
    expect(kayitli.failureKind).toBe(paket.failure.failureKind);
    expect(kayitli.failureKind).toBeDefined();

    const sonuc = await testResult({ cwd, id: test.id });
    expect(sonuc.json).toMatchObject({ failureKind: paket.failure.failureKind });
    const stdout = new PassThrough();
    const insan = metinTopla(stdout);
    ciktiYaz(sonuc, false, stdout, new PassThrough());
    expect(insan.oku()).toContain(`"failureKind": "${paket.failure.failureKind}"`);
  });

  it('doctor insan modunda tek çıktı, JSON modunda yalnız JSON verir', async () => {
    const cwd = await geciciDizin();
    const sonuc = await doctor({ cwd });
    expect(sonuc.exitCode).toBe(0);
    expect(sonuc.mesaj).toBeUndefined();
    expect(sonuc.metin).toMatch(/^[✓✗] Node /);

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const cikti = metinTopla(stdout);
    const hata = metinTopla(stderr);
    ciktiYaz(sonuc, false, stdout, stderr);
    expect(hata.oku()).toBe('');
    expect(cikti.oku()).toBe(`${sonuc.metin ?? ''}\n`);
    expect(cikti.oku()).not.toContain('\t');
    expect(cikti.oku().trim().split('\n')).toHaveLength(6);

    const jsonCikti = new PassThrough();
    const jsonHata = new PassThrough();
    const jsonMetni = metinTopla(jsonCikti);
    const jsonStderr = metinTopla(jsonHata);
    ciktiYaz(sonuc, true, jsonCikti, jsonHata);
    expect(jsonStderr.oku()).toBe('');
    expect(jsonMetni.oku().trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(jsonMetni.oku())).toMatchObject({ ok: true, exitCode: 0 });
    expect(jsonMetni.oku()).not.toContain('✓');
  });

  it('doctor JSON çıktısında ok:true satırlar öneri taşımaz', async () => {
    const cwd = await geciciDizin('kobay-doctor-json-');
    await projectCreate({ cwd, url: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    sahteler.hedefAyakta = true;

    const sonuc = await doctor({ cwd });
    const kontroller = sonuc.json as Array<{ ad: string; ok: boolean; oneri?: string }>;

    const hedef = kontroller.find((kontrol) => kontrol.ad === 'hedef');
    expect(hedef?.ok).toBe(true);
    expect(hedef).not.toHaveProperty('oneri');
    expect(kontroller.filter((kontrol) => kontrol.ok && kontrol.oneri !== undefined)).toEqual([]);
    expect(JSON.stringify(sonuc.json)).not.toContain('ayakta değil');
    // Düşen kontrolde öneri yerinde kalır.
    const dusen = kontroller.filter((kontrol) => !kontrol.ok);
    for (const kontrol of dusen) expect(kontrol.oneri, kontrol.ad).toBeTruthy();
  });

  it('agent install insan modunda ham JSON basmaz', async () => {
    const cwd = await geciciDizin('kobay-agent-');
    const sonuc = await agentInstall({ cwd, target: 'claude', home: join(cwd, 'home') });

    expect(sonuc.exitCode).toBe(0);
    expect(sonuc.mesaj).toBeUndefined();

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const cikti = metinTopla(stdout);
    const hata = metinTopla(stderr);
    ciktiYaz(sonuc, false, stdout, stderr);

    expect(hata.oku()).toBe('');
    const satirlar = cikti.oku().trim().split('\n');
    expect(satirlar.some((satir) => satir.trimStart().startsWith('{'))).toBe(false);
    expect(satirlar.some((satir) => satir.includes('"yol"'))).toBe(false);
    expect(satirlar[0]).toContain('Skill created');
    expect(cikti.oku()).toContain(join(cwd, '.claude', 'skills', 'kobay', 'SKILL.md'));
    expect(cikti.oku()).toContain('MCP registered in .mcp.json');

    const jsonCikti = new PassThrough();
    const jsonMetni = metinTopla(jsonCikti);
    ciktiYaz(sonuc, true, jsonCikti, new PassThrough());
    expect(JSON.parse(jsonMetni.oku())).toMatchObject({
      ok: true,
      exitCode: 0,
      data: { islem: 'olusturuldu', mcp: { yol: join(cwd, '.mcp.json'), islem: 'olusturuldu' } },
    });
  });

  it('failure get insan modunda ham JSON basmaz, JSON modunda aynı gövdeyi verir', async () => {
    const cwd = await geciciDizin('kobay-failure-metin-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    await dizin.hataPaketiYaz({
      snapshotId: 's_1',
      testId: 't_abc12345',
      runId: 'r_20260917010101_abcd',
      result: {
        testId: 't_abc12345', runId: 'r_20260917010101_abcd', status: 'failed', verdict: 'failed',
        startedAt: '2026-09-17T00:00:00.000Z', finishedAt: '2026-09-17T00:00:01.000Z', codeVersion: 1,
      },
      steps: [{ stepIndex: 0, description: 'Giriş yap', status: 'failed', durationMs: 10 }],
      code: 'test("giriş", async () => {});',
      failure: {
        rootCauseHypothesis: 'Buton görünmüyor', failureKind: 'test_bug',
        recommendedFixTarget: { kind: 'selector', reference: 'login', rationale: 'Rol değişti' }, evidence: [],
      },
    }, []);

    const hedef = join(cwd, 'paket');
    const sonuc = await failureGet({ cwd, id: 't_abc12345', out: hedef });
    expect(sonuc.exitCode).toBe(0);
    expect(sonuc.mesaj).toBeUndefined();

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const cikti = metinTopla(stdout);
    const hata = metinTopla(stderr);
    ciktiYaz(sonuc, false, stdout, stderr);
    expect(hata.oku()).toBe('');
    expect(cikti.oku()).toBe(`Hata paketi kopyalandı: ${hedef}\n`);
    expect(cikti.oku()).not.toContain('"hedef"');

    const jsonCikti = new PassThrough();
    const jsonMetni = metinTopla(jsonCikti);
    ciktiYaz(sonuc, true, jsonCikti, new PassThrough());
    expect(JSON.parse(jsonMetni.oku())).toEqual({
      ok: true, exitCode: 0, data: { id: 't_abc12345', hedef },
    });
  });

  it('explore, project create/update, test create ve setup insan modunda JSON gövdesi basmaz', async () => {
    const cwd = await geciciDizin('kobay-insan-ozet-');
    const olustur = await projectCreate({
      cwd, url: 'http://uygulama.test', beyin: { adaptor: 'sahte', model: 'ornek-model' },
    });
    const guncelle = await projectUpdate({ cwd, loginUrl: 'http://uygulama.test/giris' });
    const kesif = await explore({ cwd });
    await writeFile(join(cwd, 'plan.json'), JSON.stringify({
      projectId: 'kobay-demo',
      type: 'frontend',
      name: 'Cari ekleme akışı',
      priority: 'p0',
      planSteps: [
        { type: 'action', description: 'Cariler sayfasını aç' },
        { type: 'assertion', description: 'Başlığı gör' },
      ],
    }));
    const testOlustur = await testCreate({ cwd, planPath: 'plan.json' });
    const ayar = await setup({
      beyin: 'openrouter', env: { OPENROUTER_API_KEY: 'sk-cok-gizli' }, home: join(cwd, 'home'),
    });

    for (const [ad, sonuc] of [
      ['project create', olustur],
      ['project update', guncelle],
      ['explore', kesif],
      ['test create', testOlustur],
      ['setup', ayar],
    ] as const) {
      expect(sonuc.exitCode, ad).toBe(0);
      expect(sonuc.mesaj, ad).toBeUndefined();

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const cikti = metinTopla(stdout);
      const hata = metinTopla(stderr);
      ciktiYaz(sonuc, false, stdout, stderr);

      expect(hata.oku(), ad).toBe('');
      const satirlar = cikti.oku().trim().split('\n');
      expect(satirlar.some((satir) => /^[{["]/.test(satir.trimStart())), ad).toBe(false);
      expect(cikti.oku(), ad).not.toContain('": ');
      expect(satirlar.at(-1), ad).toMatch(/^Sonraki: kobay /);

      // JSON modu gövdeyi aynen verir; özet yalnız insan moduna aittir.
      const jsonCikti = new PassThrough();
      const jsonHata = new PassThrough();
      const jsonMetni = metinTopla(jsonCikti);
      const jsonStderr = metinTopla(jsonHata);
      ciktiYaz(sonuc, true, jsonCikti, jsonHata);
      expect(jsonStderr.oku(), ad).toBe('');
      expect(jsonMetni.oku().trim().split('\n'), ad).toHaveLength(1);
      expect(JSON.parse(jsonMetni.oku()), ad).toEqual({ ok: true, exitCode: 0, data: sonuc.json });
    }

    // Özet bilgi kaybetmez: komutun ürettiği kimlikler metinde durur.
    expect(olustur.metin).toContain(join(cwd, '.kobay'));
    expect(olustur.metin).toContain('http://uygulama.test');
    expect(olustur.metin).toContain('sahte (model: ornek-model)');
    expect(guncelle.metin).toContain('http://uygulama.test/giris');
    expect(kesif.metin).toMatch(/^1 sayfa keşfedildi/);
    expect(kesif.metin).toContain(join(cwd, '.kobay', 'harita.json'));
    const testKaydi = testOlustur.json as TestKaydi;
    expect(testOlustur.metin).toContain(testKaydi.id);
    expect(testOlustur.metin).toContain('Adım sayısı: 2, öncelik: p0, durum: draft');
    expect(ayar.metin).toContain(join(cwd, 'home', '.kobay', 'config.json'));
    expect(`${ayar.metin}${JSON.stringify(ayar.json)}`).not.toContain('sk-cok-gizli');
  });

  it('test run düşen testte sınıfı ve sonraki komutu yazar, JSON satırını değiştirmez', async () => {
    const cwd = await geciciDizin('kobay-run-mesaj-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    const test: TestKaydi = {
      id: 't_abc12345', name: 'Hazır test', type: 'frontend', createdFrom: 'cli', status: 'ready',
      planSteps: [{ type: 'action', description: 'Ana sayfayı aç' }], priority: 'p1', codeVersion: 1,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    };
    await dizin.testYaz(test);
    await dizin.kodYaz(test.id, '// hazır');
    process.env.KOBAY_SAHTE_YANIT_DIZINI = await sahteYanitlariYaz();
    await yazAtomik(join(process.env.KOBAY_SAHTE_YANIT_DIZINI, `analiz-${test.id}.json`), JSON.stringify({
      rootCauseHypothesis: 'Başlık değişmiş', failureKind: 'product_bug',
      recommendedFixTarget: { kind: 'code', reference: 'ana sayfa', rationale: 'Beklenen başlık yok' }, evidence: [],
    }));

    const sonuc = await testRun({ cwd, all: true });
    expect(sonuc.exitCode).toBe(1);
    expect(sonuc.json).toEqual([{
      id: 't_abc12345',
      ad: 'Hazır test',
      verdict: 'failed',
      runId: 'r_20260917010101_abcd',
      failureKind: 'product_bug',
    }]);
    expect(sonuc.mesaj).toBe(
      'failed t_abc12345 — product_bug\n  hata paketi: kobay test failure get t_abc12345',
    );
  });

  it('test run sonuçsuz koşuda motor hatasının ilk satırını gösterir', async () => {
    const cwd = await geciciDizin('kobay-run-inconclusive-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    await dizin.testYaz({
      id: 't_abc12345', name: 'Hazır test', type: 'frontend', createdFrom: 'cli', status: 'ready',
      planSteps: [{ type: 'action', description: 'Aç' }], priority: 'p1', codeVersion: 1,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    });
    await dizin.kodYaz('t_abc12345', '// hazır');
    sahteler.verdict = 'inconclusive';
    sahteler.errorMessage = 'Playwright başlatılamadı\nikinci satır görünmemeli';

    const sonuc = await testRun({ cwd, all: true });
    expect(sonuc.exitCode).toBe(4);
    expect(sonuc.mesaj).toBe('inconclusive t_abc12345 — Playwright başlatılamadı');
    expect(sonuc.json).toEqual([expect.not.objectContaining({ errorMessage: expect.anything() })]);
  });

  it('klonlanmış projede .kobay/failure ve runs yokken düşen koşu paketi üretir', async () => {
    const cwd = await geciciDizin('kobay-klon-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    const test: TestKaydi = {
      id: 't_abc12345', name: 'Hazır test', type: 'frontend', createdFrom: 'cli', status: 'ready',
      planSteps: [{ type: 'action', description: 'Ana sayfayı aç' }], priority: 'p1', codeVersion: 1,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    };
    await dizin.testYaz(test);
    await dizin.kodYaz(test.id, '// hazır');
    process.env.KOBAY_SAHTE_YANIT_DIZINI = await sahteYanitlariYaz();
    await yazAtomik(join(process.env.KOBAY_SAHTE_YANIT_DIZINI, `analiz-${test.id}.json`), JSON.stringify({
      rootCauseHypothesis: 'Başlık değişmiş', failureKind: 'product_bug',
      recommendedFixTarget: { kind: 'code', reference: 'ana sayfa', rationale: 'Beklenen başlık yok' }, evidence: [],
    }));
    // `.kobay/.gitignore` bu dizinleri dışlar; klonlayan ikinci geliştiricide gelmezler.
    await rm(dizin.yol('failure'), { recursive: true, force: true });
    await rm(dizin.yol('runs'), { recursive: true, force: true });

    const sonuc = await testRun({ cwd, all: true });

    expect(sonuc.exitCode).toBe(1);
    expect(sonuc.json).toEqual([expect.objectContaining({ verdict: 'failed' })]);
    await access(join(cwd, '.kobay', 'failure', 't_abc12345', 'failure.json'));

    const paket = await failureGet({ cwd, id: test.id, out: join(cwd, 'disari') });
    expect(paket.exitCode).toBe(0);
    await access(join(cwd, 'disari', 'failure.json'));
  });
});

describe('hata mesajları eyleme yönlendirir', () => {
  it('doctor Node 22.12 altını reddeder', () => {
    expect(nodeSurumuYeterliMi('22.11.0')).toBe(false);
    expect(nodeSurumuYeterliMi('22.12.0')).toBe(true);
    expect(nodeSurumuYeterliMi('23.0.0')).toBe(true);
  });

  async function bosProje(): Promise<string> {
    const cwd = await geciciDizin('kobay-mesaj-');
    await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    return cwd;
  }

  it('olmayan test kimliğinde iç dosya yolu yerine `test list` önerir', async () => {
    const cwd = await bosProje();

    for (const sonuc of [
      await testGet({ cwd, id: 't_yok12345' }),
      await testRun({ cwd, ids: ['t_yok12345'] }),
      await testResult({ cwd, id: 't_yok12345' }),
    ]) {
      expect(sonuc.exitCode).toBe(2);
      expect(sonuc.mesaj).toContain('Test bulunamadı: t_yok12345');
      expect(sonuc.mesaj).toContain('kobay test list');
      expect(sonuc.mesaj).not.toContain('.kobay/tests');
    }
  });

  it('kimlik verilmezse ve test listesi boşsa sonraki komutu söyler', async () => {
    const cwd = await bosProje();

    const kimliksiz = await testRun({ cwd });
    expect(kimliksiz.exitCode).toBe(2);
    expect(kimliksiz.mesaj).toContain('kobay test list');

    const tumu = await testRun({ cwd, all: true });
    expect(tumu.exitCode).toBe(2);
    expect(tumu.mesaj).toContain('kobay test plan generate');

    const liste = await testList({ cwd });
    expect(liste.exitCode).toBe(0);
    expect(liste.mesaj).toContain('kobay test plan generate');
  });

  it('koşusu olmayan testte `test run` önerir', async () => {
    const cwd = await bosProje();
    const dizin = await KobayDizini.bul(cwd);
    await dizin?.testYaz({
      id: 't_abc12345', name: 'Hazır test', type: 'frontend', createdFrom: 'cli', status: 'ready',
      planSteps: [{ type: 'action', description: 'Aç' }], priority: 'p1', codeVersion: 1,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    });

    const sonuc = await testResult({ cwd, id: 't_abc12345' });
    expect(sonuc.exitCode).toBe(2);
    expect(sonuc.mesaj).toContain('Koşu sonucu yok: t_abc12345');
    expect(sonuc.mesaj).toContain('kobay test run t_abc12345');
  });

  it('kodu olmayan testte rerun `test run` önerir', async () => {
    const cwd = await bosProje();
    const dizin = await KobayDizini.bul(cwd);
    await dizin?.testYaz({
      id: 't_abc12345', name: 'Kodsuz', type: 'frontend', createdFrom: 'cli', status: 'draft',
      planSteps: [{ type: 'action', description: 'Aç' }], priority: 'p1', codeVersion: 0,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    });

    const sonuc = await testRerun({ cwd, id: 't_abc12345' });
    expect(sonuc.exitCode).toBe(4);
    expect(JSON.stringify(sonuc.json)).toContain('kobay test run t_abc12345');
  });

  it('hedef ayakta değilse explore tarayıcı açmadan exit 3 ve adres verir', async () => {
    const cwd = await bosProje();
    sahteler.hedefAyakta = false;

    const sonuc = await explore({ cwd });
    expect(sonuc.exitCode).toBe(3);
    expect(sonuc.mesaj).toContain('Hedef uygulamaya ulaşılamadı: http://uygulama.test');
    expect(sonuc.json).toEqual({ hata: expect.objectContaining({ kod: 'HedefYokHatasi' }) });
  });

  it('hata paketi yokken hangi komutun paket ürettiğini söyler', async () => {
    const cwd = await bosProje();

    const sonuc = await failureGet({ cwd, id: 't_abc12345', out: join(cwd, 'paket') });
    expect(sonuc.exitCode).toBe(2);
    expect(sonuc.mesaj).toContain('Hata paketi yok: t_abc12345');
    expect(sonuc.mesaj).toContain('kobay test run t_abc12345');
  });

  it('failure get --out gizli yolları reddeder, .kobay/failure-out altını kabul eder', async () => {
    const cwd = await bosProje();

    const reddedilecek = [
      '.git/hooks-x',
      '.claude/skills/x',
      '.kobay/tests/x',
      '.kobay/failure-out',
      '.kobay/failure-out/../credentials.json',
      '.kobay/failure-out/x/../../storageState.json',
      '.kobay/failure-out/.gizli',
      'alt/.gizli',
    ];
    for (const out of reddedilecek) {
      const sonuc = await failureGet({ cwd, id: 't_abc12345', out });
      expect(sonuc.exitCode, out).toBe(2);
      expect(sonuc.mesaj, out).toContain('nokta ile başlayan');
    }
    // Paket yok: kabul edilen yollar gizli yol hatası değil, "hata paketi yok" hatası verir.
    for (const out of ['paket', '.kobay/failure-out/t_abc12345-1', '.kobay/failure-out/t_abc12345-1/alt']) {
      const sonuc = await failureGet({ cwd, id: 't_abc12345', out });
      expect(sonuc.mesaj, out).not.toContain('nokta ile başlayan');
      expect(sonuc.mesaj, out).toContain('Hata paketi yok');
    }
  });

  it('failure get --out verilmezse hep .kobay/failure-out/<id> kullanır', async () => {
    const cwd = await bosProje();
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    await dizin.hataPaketiYaz({
      snapshotId: 's_1',
      testId: 't_abc12345',
      runId: 'r_20260917010101_abcd',
      result: {
        testId: 't_abc12345',
        runId: 'r_20260917010101_abcd',
        status: 'failed',
        verdict: 'failed',
        startedAt: '2026-09-17T00:00:00.000Z',
        finishedAt: '2026-09-17T00:00:01.000Z',
        codeVersion: 1,
      },
      steps: [{ stepIndex: 0, description: 'Giriş yap', status: 'failed', durationMs: 10 }],
      code: 'test("giriş", async () => {});',
      failure: {
        rootCauseHypothesis: 'Buton görünmüyor',
        failureKind: 'test_bug',
        recommendedFixTarget: { kind: 'selector', reference: 'login', rationale: 'Rol değişti' },
        evidence: [],
      },
    }, []);

    const cikisKoku = join(cwd, '.kobay', 'failure-out');
    for (const tur of ['ilk', 'ikinci']) {
      const sonuc = await failureGet({ cwd, id: 't_abc12345' });
      expect(sonuc.exitCode, tur).toBe(0);
      expect(sonuc.json, tur).toEqual({ id: 't_abc12345', hedef: join(cikisKoku, 't_abc12345') });
      await access(join(cikisKoku, 't_abc12345', 'failure.json'));
    }
    // Aynı test tek klasör kullanır: ikinci çağrı çöp bırakmaz.
    expect(await readdir(cikisKoku)).toEqual(['t_abc12345']);
  });

  it('beyin hata kodlarını Türkçe eyleme çevirir', async () => {
    const { basarisiz } = await import('../../src/cli/komut.js');

    const cliYok = basarisiz(new BeyinHatasi('cli_yok'));
    expect(cliYok.exitCode).toBe(4);
    expect(cliYok.mesaj).toContain('kobay doctor');
    expect(cliYok.mesaj).not.toContain('cli_yok');
    expect(basarisiz(new BeyinHatasi('sema')).mesaj).toContain('.kobay/logs/');
    expect(basarisiz(new BeyinHatasi('anahtar_yok')).mesaj).toContain('OPENROUTER_API_KEY');
  });

  it('doctor eksik bileşen için yapılacak işi yazar', async () => {
    const cwd = await geciciDizin('kobay-doctor-');
    const sonuc = await doctor({ cwd });
    const satirlar = (sonuc.metin ?? '').split('\n');
    const kobaySatiri = satirlar.find((satir) => satir.includes('.kobay'));
    expect(kobaySatiri).toContain('✗');
    expect(kobaySatiri).toContain('kobay project create');
    expect(JSON.stringify(sonuc.json)).toContain('kobay project create');
    expect(JSON.stringify(sonuc.json)).not.toContain('npx playwright');
    // Chromium bu makinede kurulu olabilir; öneri yalnız düşen satırda durur.
    const chromium = (sonuc.json as Array<{ ad: string; ok: boolean; oneri?: string }>)
      .find((kontrol) => kontrol.ad === 'Chromium');
    if (chromium?.ok === false) expect(chromium.oneri).toContain('kobay install-browser');
    else expect(chromium).not.toHaveProperty('oneri');
    expect(CHROMIUM_ONERISI).toContain('kobay install-browser');
    expect(CHROMIUM_ONERISI).not.toContain('npx playwright');
  });
});

describe('güvenlik sınırları (karşıt denetim 3)', () => {
  const varMi = (yol: string): Promise<boolean> => access(yol).then(() => true, () => false);

  it('baseUrl başka origin\'e değişince kayıtlı giriş bilgisi ve oturum silinir; aynı origin korunur', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' });

    // Aynı origin içinde yol değişikliği giriş bilgisini korur.
    expect((await projectUpdate({ cwd, url: 'http://mesru.test/uygulama' })).exitCode).toBe(0);
    await expect(dizin.kimlikOku()).resolves.not.toBeNull();

    const guncelle = await projectUpdate({ cwd, url: 'http://kotu.test' });
    expect(guncelle.exitCode).toBe(0);
    expect(guncelle.metin).toContain('giriş bilgisi ve oturum silindi');
    await expect(dizin.kimlikOku()).resolves.toBeNull();
    expect(await varMi(dizin.storageStateYolu())).toBe(false);
  });

  it('create --force yeni origin\'de eski parolayı taşımaz, aynı origin\'de korur', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    expect((await projectCreate({ cwd, url: 'http://mesru.test', force: true })).exitCode).toBe(0);
    await expect(dizin.kimlikOku()).resolves.not.toBeNull();
    expect((await projectCreate({ cwd, url: 'http://kotu.test', force: true })).exitCode).toBe(0);
    await expect(dizin.kimlikOku()).resolves.toBeNull();
    // Yeni origin için kullanıcı yeniden verirse yeni origin'e bağlanır.
    await projectCreate({ cwd, url: 'http://kotu.test', force: true, login: { kullanici: 'veli', parola: 'gizli-2' } });
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'veli', parola: 'gizli-2', origin: 'http://kotu.test' });
  });

  it('config yazımı düşerse giriş bilgisi, oturum ve eski config aynen kalır', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    const oncekiConfig = await readFile(dizin.yol('config.json'), 'utf8');

    const casus = vi.spyOn(KobayDizini.prototype, 'configYaz')
      .mockRejectedValueOnce(Object.assign(new Error('disk dolu'), { code: 'ENOSPC' }));
    const guncelle = await projectUpdate({ cwd, url: 'http://kotu.test' });
    casus.mockRestore();

    expect(guncelle.exitCode).not.toBe(0);
    expect(guncelle.mesaj).toContain('disk dolu');
    // Veri kaybı olmamalı: parola, oturum ve eski hedef yerinde.
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' });
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    await expect(readFile(dizin.yol('config.json'), 'utf8')).resolves.toBe(oncekiConfig);
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
  });

  it('create --force --login yeni kimlik yazımı düşerse eski kimlik ve config geri gelir', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');

    const casus = vi.spyOn(KobayDizini.prototype, 'kimlikYaz')
      .mockRejectedValueOnce(Object.assign(new Error('izin yok'), { code: 'EACCES' }));
    const olustur = await projectCreate({
      cwd, url: 'http://kotu.test', force: true, login: { kullanici: 'veli', parola: 'gizli-2' },
    });
    casus.mockRestore();

    expect(olustur.exitCode).not.toBe(0);
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' });
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    await expect(dizin.configOku()).resolves.toMatchObject({ baseUrl: 'http://mesru.test' });
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
  });

  /** İşlem işaretinin ham içeriği. */
  async function isaretiOku(dizin: KobayDizini): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(dizin.yol('.kimlik-islemi'), 'utf8')) as Record<string, unknown>;
  }

  /** Komutu çalıştıran sürecin bittiğini taklit eder: işaret tazelik penceresinden eskir. */
  async function isaretiBayatlat(dizin: KobayDizini): Promise<void> {
    const ham = await isaretiOku(dizin);
    await writeFile(
      dizin.yol('.kimlik-islemi'),
      JSON.stringify({ ...ham, baslatildi: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
    );
  }

  /**
   * Kenara alınan kopyayı asıl adına geri koyan bir rakip süreci taklit eder:
   * `kesinlestir()` "kimlik işlemi bozuldu" diye düşer. Gerçek kilitle bu yol
   * artık oluşmaz; sağlamlık için tutuluyor.
   */
  function kalintiyiGeriKoyanCasus(hedefMetot: 'configYaz' | 'kimlikYaz') {
    const asil = KobayDizini.prototype[hedefMetot];
    return vi.spyOn(KobayDizini.prototype, hedefMetot).mockImplementationOnce(
      async function (this: KobayDizini, deger: never): Promise<void> {
        await (asil as (this: KobayDizini, d: never) => Promise<void>).call(this, deger);
        for (const ad of (await readdir(this.kok)).filter((girdi) => girdi.startsWith('.eski-'))) {
          await rename(join(this.kok, ad), join(this.kok, ad.slice('.eski-'.length + 36 + 1)));
        }
      },
    );
  }

  it('update: kesinleştirme düşerse yeni config kalıcı olmaz, eskisi geri gelir', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    const casus = kalintiyiGeriKoyanCasus('configYaz');

    const guncelle = await projectUpdate({ cwd, url: 'http://kotu.test' });
    casus.mockRestore();

    expect(guncelle.exitCode).not.toBe(0);
    expect(guncelle.mesaj).toContain('Kimlik işlemi bozuldu');
    // Asıl bulgu: hedef eski değerinde kaldı, yarım işlem kalıcı iz bırakmadı.
    await expect(dizin.configOku()).resolves.toMatchObject({ baseUrl: 'http://mesru.test' });
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' });
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
    await expect(access(dizin.yol('.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('create --force --login: kesinleştirme düşerse config ve kimlik eski değerine döner', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    // Rakip, yeni kimlik yazıldıktan sonra kopyayı asıl adına geri koyuyor.
    const casus = kalintiyiGeriKoyanCasus('kimlikYaz');

    const olustur = await projectCreate({
      cwd, url: 'http://kotu.test', force: true, login: { kullanici: 'veli', parola: 'gizli-2' },
    });
    casus.mockRestore();

    expect(olustur.exitCode).not.toBe(0);
    expect(olustur.mesaj).toContain('Kimlik işlemi bozuldu');
    await expect(dizin.configOku()).resolves.toMatchObject({ baseUrl: 'http://mesru.test' });
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' });
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
    await expect(access(dizin.yol('.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kesinleşmeden sonra yedek silinemezse komut başarılı olur; kalıntıyı sonraki komut toparlar', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');

    // Kesinleşme noktası geçildikten sonra bir yedek silinemiyor (EBUSY);
    // ötekinin silinmesi sürüyor. Eski davranışta bu hata işlemi düşürür,
    // çağıran eksik yedekle geri almaya girer ve eski parola kaybolurdu.
    dosyaDurumu.rmKosulu = (yol) => yol.includes('-credentials.json');
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const olustur = await projectCreate({
      cwd, url: 'http://kotu.test', force: true, login: { kullanici: 'veli', parola: 'gizli-2' },
    });
    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();
    dosyaDurumu.rmKosulu = undefined;

    expect(olustur.exitCode).toBe(0);
    expect(basilan).toContain('credentials.json kopyası silinemedi');
    // Yeni durum yerinde: hedef, yeni kimlik ve silinebilen oturum kopyası.
    await expect(dizin.configOku()).resolves.toMatchObject({ baseUrl: 'http://kotu.test' });
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'veli', parola: 'gizli-2', origin: 'http://kotu.test' });
    await expect(access(dizin.storageStateYolu())).rejects.toMatchObject({ code: 'ENOENT' });
    const kalintilar = (await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'));
    expect(kalintilar).toHaveLength(1);
    expect(kalintilar[0]).toMatch(/-credentials\.json$/);
    // Kalıntı kaldığı için işaret kesinleşme damgasıyla yerinde bırakıldı.
    await expect(isaretiOku(dizin)).resolves.toMatchObject({ committed: true });

    // Sonraki komut (süreç bittiği için işaret bayat): kalıntı silinir, yeni
    // kimliğin üstüne konmaz.
    await isaretiBayatlat(dizin);
    await KobayDizini.bul(dizin.projeKoku);

    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
    await expect(access(dizin.yol('.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'veli', parola: 'gizli-2', origin: 'http://kotu.test' });
  });

  it('kesinleşmiş oturum yedeği sonraki komutta geri KONMAZ: origin değişince eski çerez dirilmez', async () => {
    const cwd = await geciciDizin();
    await projectCreate({ cwd, url: 'http://mesru.test', beyin: { adaptor: 'sahte' } });
    const dizin = (await KobayDizini.bul(cwd))!;
    // Kayıtlı kimlik yok, yalnız oturum var: origin denetimini yapacak
    // credentials.json bulunmadığı için geri konan oturum sessizce kullanılırdı.
    await dizin.storageStateYaz('{"cookies":[{"name":"oturum"}],"origins":[]}');

    // Hedef origin değişiyor; kesinleşmeden sonra yedek silinemiyor.
    dosyaDurumu.rmKosulu = (yol) => yol.includes('-storageState.json');
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const guncelle = await projectUpdate({ cwd, url: 'http://kotu.test:8080' });
    dosyaDurumu.rmKosulu = undefined;

    expect(guncelle.exitCode).toBe(0);
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toHaveLength(1);

    // Süreç bitti (işaret bayat), sonraki komut kurtarmayı çalıştırıyor.
    await isaretiBayatlat(dizin);
    await KobayDizini.bul(dizin.projeKoku);
    uyari.mockRestore();

    await expect(access(dizin.storageStateYolu())).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
    await expect(access(dizin.yol('.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('geri almada config geri yazımı düşerse komut geri alma hatasıyla durur; sonraki komut toparlar', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    const eskiConfig = await dizin.configOku();

    // Disk dolu: hem yeni config yazımı hem de geri almanın ilk adımı düşüyor.
    const casus = vi.spyOn(KobayDizini.prototype, 'configYaz')
      .mockRejectedValueOnce(Object.assign(new Error('disk dolu'), { code: 'ENOSPC' }))
      .mockRejectedValueOnce(Object.assign(new Error('disk dolu'), { code: 'ENOSPC' }));
    const guncelle = await projectUpdate({ cwd, url: 'http://kotu.test' });
    casus.mockRestore();

    // Motor hatası (4): kullanıcının komutunda değil, dosya sisteminde sorun var.
    expect(guncelle.exitCode).toBe(4);
    expect(guncelle.mesaj).toContain('Kimlik işlemi geri alınamadı');
    expect(guncelle.mesaj).toContain('yeniden çalıştırın');
    expect(guncelle.mesaj).toContain('disk dolu');
    // Yedekler geri KONMADI ve düzeltmeyi taşıyan işaret silinmedi: eski
    // davranışta ikisi de olur, kalıcı tutarsızlığı düzeltecek iz kalmazdı.
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toHaveLength(2);
    await expect(dizin.kimlikOku()).resolves.toBeNull();
    const isaret = await isaretiOku(dizin);
    expect(isaret.committed ?? false).toBe(false);
    expect(isaret.eskiConfig).toEqual(eskiConfig);

    // Sonraki komut (salt okunur `project get` bile) kurtarmayı çalıştırır.
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const bak = await projectGet({ cwd });
    uyari.mockRestore();

    expect(bak.exitCode).toBe(0);
    await expect(dizin.configOku()).resolves.toEqual(eskiConfig);
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' });
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
    await expect(access(dizin.yol('.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bayat işlemin kurtarması düşerse komut durur; project update bayat işareti devralmaz', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    const eskiConfig = await dizin.configOku();
    // Süreci ölmüş bir `project update --base-url`: kenara alma bitmiş, yeni
    // config inmiş, kesinleştirme hiç çalışmamış.
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig });
    await dizin.configYaz({ ...eskiConfig, baseUrl: 'http://kotu.test' });
    await isaretiBayatlat(dizin);
    // Kurtarma yedeği asıl adına koyamıyor.
    dosyaDurumu.renameKosulu = (eski) => (eski.includes('/.eski-') ? 'EACCES' : undefined);

    const guncelle = await projectUpdate({ cwd, url: 'http://baska.test' });

    expect(guncelle.exitCode).toBe(4);
    expect(guncelle.mesaj).toContain('Kimlik işlemi geri alınamadı');
    expect(guncelle.mesaj).toContain('EACCES');
    expect(guncelle.mesaj).toContain('yeniden çalıştırın');
    // Komut hiç başlamadı: bayat işaret devralınmadı, ikinci bir kenara alma yok.
    const kalintilar = (await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'));
    expect(kalintilar).toHaveLength(2);
    const isaret = await isaretiOku(dizin);
    expect(isaret.eskiConfig).toEqual(eskiConfig);
    expect(isaret.committed ?? false).toBe(false);

    // Sorun giderilince sonraki komut geri almayı tamamlar, hedef eskiye döner.
    dosyaDurumu.renameKosulu = undefined;
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const bak = await projectGet({ cwd });
    uyari.mockRestore();

    expect(bak.exitCode).toBe(0);
    await expect(dizin.configOku()).resolves.toEqual(eskiConfig);
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' });
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
  });

  it('kimliği değiştiren ikinci komut, birincisi sürerken reddedilir (çıkış 2)', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    // Birinci komut kenara aldı, henüz kesinleştirmedi: kilit onda.
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: await dizin.configOku() });
    const oncekiKalintilar = (await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'));

    const ikinci = await projectUpdate({ cwd, url: 'http://kotu.test' });

    expect(ikinci.exitCode).toBe(2);
    expect(ikinci.mesaj).toContain('kimliğini değiştiriyor');
    // Birinci işlemin dosyalarına ve hedefine dokunulmadı.
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual(oncekiKalintilar);
    await expect(dizin.configOku()).resolves.toMatchObject({ baseUrl: 'http://mesru.test' });

    await islem.kesinlestir();
  });

  it('gerçek dosya sistemi hatasında da (config.json yazılamıyor) giriş bilgisi kaybolmaz', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    // config.json'un yerine dizin koyulursa atomik yazma EISDIR ile düşer; sahte yok.
    await rm(dizin.yol('config.json'));
    await mkdir(dizin.yol('config.json'));

    const olustur = await projectCreate({ cwd, url: 'http://kotu.test', force: true, beyin: { adaptor: 'sahte' } });

    expect(olustur.exitCode).not.toBe(0);
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' });
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
  });

  it('yarıda kalan geri almadan sonraki komut, geri konmuş giriş bilgisini silmez', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    const eskiConfig = await dizin.configOku();
    // `project create --force --login` akışının ortası: kenara al, yeni hedefi
    // ve yeni parolayı yaz, sonra kesinleşmede düş.
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig, yeniKimlikYazilacak: true });
    await dizin.configYaz({ ...eskiConfig, baseUrl: 'http://kotu.test' });
    await dizin.kimlikYaz({ kullanici: 'veli', parola: 'gizli-2', origin: 'http://kotu.test' });
    // Geri almanın ilk denemesi: giriş bilgisi geri kondu, oturum kopyası düştü.
    dosyaDurumu.renameKosulu = (eski) => (eski.includes('-storageState.json') ? 'EACCES' : undefined);
    await expect(islem.geriAl({ configYazildi: true, yeniKimlikYazildi: true }))
      .rejects.toThrow('Kimlik işlemi geri alınamadı');
    dosyaDurumu.renameKosulu = undefined;
    await isaretiBayatlat(dizin);

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const bak = await projectGet({ cwd });
    uyari.mockRestore();

    // Asıl bulgu: kurtarma, geri konmuş ORİJİNAL credentials.json'ı `--login`
    // artığı sanıp silmiyor.
    expect(bak.exitCode).toBe(0);
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' });
    await expect(dizin.configOku()).resolves.toEqual(eskiConfig);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
    await expect(access(dizin.yol('.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('yarım kalmış işlemin kalıntısı sonraki komutta toparlanır', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    // Süreç kenara aldıktan sonra öldürüldü: ne silindi ne geri kondu, işaret bayatladı.
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: await dizin.configOku() });
    const isaret = JSON.parse(await readFile(dizin.yol('.kimlik-islemi'), 'utf8')) as Record<string, unknown>;
    await writeFile(dizin.yol('.kimlik-islemi'), JSON.stringify({
      ...isaret,
      baslatildi: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toHaveLength(1);

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const guncelle = await projectUpdate({ cwd, docs: 'README.md' });
    uyari.mockRestore();

    expect(guncelle.exitCode).toBe(0);
    // Kalıntı sessizce beklemez: asıl dosya yok olduğu için parola geri konur.
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' });
  });

  it('config yazıldıktan sonra ölen komut sonraki komutta tümüyle geri alınır (hedef dahil)', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.storageStateYaz('{"cookies":[{"name":"oturum"}],"origins":[]}');
    const eskiConfig = await dizin.configOku();
    // `project update --base-url http://mesru.test:8080` akışının tam ortası:
    // kenara alma bitti, yeni config diske indi, kesinleştirme hiç çalışmadı.
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig });
    await dizin.configYaz({ ...eskiConfig, baseUrl: 'http://mesru.test:8080' });
    await isaretiBayatlat(dizin);

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const bak = await projectGet({ cwd });
    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();

    expect(bak.exitCode).toBe(0);
    // Hedef eski değerine döndü; geri konan oturum aynı hostun başka portunda kullanılamaz.
    await expect(dizin.configOku()).resolves.toEqual(eskiConfig);
    await expect(dizin.kimlikOku()).resolves.toEqual({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' });
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[{"name":"oturum"}],"origins":[]}');
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
    await expect(access(dizin.yol('.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(basilan).toContain('yarım kalmış bir hedef değişikliği geri alındı');
  });

  it('kullanım anında kimlik origin\'i uyuşmazsa ya da eski biçimse keşif hiç başlamaz (exit 5)', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    const dizin = (await KobayDizini.bul(cwd))!;
    // Ajan config.json'u doğrudan düzenleyip hedefi değiştirdi.
    await dizin.configYaz({ ...(await dizin.configOku()), baseUrl: 'http://kotu.test' });
    vi.mocked(kesfet).mockClear();
    const sonuc = await explore({ cwd });
    expect(sonuc.exitCode).toBe(5);
    expect(sonuc.mesaj).toContain('parola gönderilmedi');
    expect(sonuc.mesaj).toContain('--login --force');
    expect(kesfet).not.toHaveBeenCalled();

    // Eski biçim (origin'siz) kimlik de kullanılmaz.
    await dizin.configYaz({ ...(await dizin.configOku()), baseUrl: 'http://mesru.test' });
    await dizin.kimlikYaz({ kullanici: 'ali', parola: 'gizli-1' });
    const eski = await explore({ cwd });
    expect(eski.exitCode).toBe(5);
    expect(eski.mesaj).toContain('eski biçim');
    expect(kesfet).not.toHaveBeenCalled();
  });

  it('project update ve create --force beyin tavanlarını korur', async () => {
    const cwd = await geciciDizin();
    await projectCreate({ cwd, url: 'http://mesru.test', beyin: { adaptor: 'sahte' } });
    const dizin = (await KobayDizini.bul(cwd))!;
    const tavanlar = { maxTotalCostUsd: 0.5, maxCalls: 10, maxBudgetUsd: 0.2, maxTokens: 4000 };
    await dizin.configYaz({ ...(await dizin.configOku()), beyin: { adaptor: 'sahte', model: 'm1', ...tavanlar } });

    expect((await projectUpdate({ cwd, docs: 'README.md' })).exitCode).toBe(0);
    await expect(dizin.configOku()).resolves.toMatchObject({ beyin: { adaptor: 'sahte', model: 'm1', ...tavanlar } });
    expect((await projectUpdate({ cwd, beyin: { adaptor: 'codex', effort: 'high' } })).exitCode).toBe(0);
    await expect(dizin.configOku()).resolves.toMatchObject({
      beyin: { adaptor: 'codex', model: 'm1', effort: 'high', ...tavanlar },
    });
    expect((await projectCreate({ cwd, url: 'http://mesru.test', force: true, beyin: { model: 'm2' } })).exitCode).toBe(0);
    await expect(dizin.configOku()).resolves.toMatchObject({
      beyin: { adaptor: 'codex', model: 'm2', effort: 'high', ...tavanlar },
    });
    expect((await projectCreate({ cwd, url: 'http://mesru.test', force: true })).exitCode).toBe(0);
    await expect(dizin.configOku()).resolves.toMatchObject({ beyin: { adaptor: 'codex', model: 'm2', ...tavanlar } });
  });

  it('docs/docsPath/planPath .kobay altını ve nokta ile başlayan bileşenleri reddeder', async () => {
    const cwd = await geciciDizin();
    await projectCreate({
      cwd, url: 'http://mesru.test', login: { kullanici: 'ali', parola: 'gizli-1' }, beyin: { adaptor: 'sahte' },
    });
    await writeFile(join(cwd, '.env'), 'SIR=1\n');
    await mkdir(join(cwd, 'belge'), { recursive: true });
    await symlink(join(cwd, '.kobay', 'credentials.json'), join(cwd, 'belge', 'masum.md'));

    for (const docs of ['.kobay/credentials.json', '.env', 'alt/.git/config', 'belge/masum.md']) {
      const guncelle = await projectUpdate({ cwd, docs });
      expect(guncelle.exitCode, docs).toBe(2);
      expect(guncelle.mesaj, docs).toContain('nokta ile başlayan');
      const olustur = await projectCreate({ cwd, url: 'http://mesru.test', force: true, docs });
      expect(olustur.exitCode, docs).toBe(2);
    }
    for (const planPath of ['.kobay/credentials.json', join(cwd, '.env'), 'belge/masum.md']) {
      const sonuc = await testCreate({ cwd, planPath });
      expect(sonuc.exitCode, planPath).toBe(2);
      expect(JSON.stringify(sonuc.json), planPath).not.toContain('gizli-1');
    }
    // Okuma anı: config.json elle düzenlenmiş olsa da belge okunmaz.
    const dizin = (await KobayDizini.bul(cwd))!;
    await dizin.configYaz({ ...(await dizin.configOku()), docsPath: '.kobay/credentials.json' });
    const plan = await planGenerate({ cwd });
    expect(plan.exitCode).toBe(2);
    expect(plan.mesaj).toContain('nokta ile başlayan');
    // Normal belge hâlâ kabul edilir.
    await writeFile(join(cwd, 'belge', 'urun.md'), '# Ürün\n');
    expect((await projectUpdate({ cwd, docs: 'belge/urun.md' })).exitCode).toBe(0);
  });
});
