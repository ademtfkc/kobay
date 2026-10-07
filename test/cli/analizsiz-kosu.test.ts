import { access, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { ANALIZ_ATLANDI, KODSUZ_ENGEL_ONEKI } from '../../src/analiz/index.js';
import { failureGet, testReport, testRun } from '../../src/cli/komutlar/index.js';
import { KobayDizini, yazAtomik, type HataPaketi, type TestKaydi } from '../../src/depo/index.js';
import { baslat } from '../kobay-demo/sunucu.mjs';

/**
 * `kobay test run --no-analysis` gerçek koşuyla: demo uygulama + gerçek Chromium.
 * Beyin sahte adaptör ve her görev için HAZIR yanıt dosyası var: beyin çağrılsaydı
 * analiz `product_bug` dönerdi, kod üretilirdi ve `.kobay/logs` altına günlük
 * düşerdi. Üçünün de olmadığı beyin çağrısının sıfır olduğunu kanıtlar.
 */

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

afterEach(() => { delete process.env.KOBAY_SAHTE_YANIT_DIZINI; });

function playwrightMumkun(context: TestContext): boolean {
  if (tarayiciEngeli === undefined) return true;
  // Katı kipte (CI) Chromium yoksa atlama değil hata: gerçek koşu kanıtı şart.
  if (process.env.KOBAY_CHROMIUM_TEST === '1') throw tarayiciEngeli;
  context.skip(`Chromium engelli: ${String(tarayiciEngeli).split('\n')[0] ?? ''}`);
  return false;
}

const TEST_ID = 't_noan1234';

function kod(baseUrl: string, baslik: string): string {
  return `import { test, expect } from './_fixture';
test('shows the login heading', async ({ page }) => {
  await test.step('0: Open the login page', async () => {
    await page.goto('${baseUrl}/login');
  });
  await test.step('1: See the login heading', async () => {
    await expect(page.getByRole('heading', { name: '${baslik}' })).toBeVisible({ timeout: 3000 });
  });
});
`;
}

/** Her beyin görevine hazır yanıt: çağrı olsaydı başarılı olurdu, sessizce düşmezdi. */
async function hazirBeyinYanitlari(baseUrl: string): Promise<string> {
  const dizin = await mkdtemp(join(tmpdir(), 'kobay-analizsiz-yanit-'));
  await yazAtomik(join(dizin, `analysis-${TEST_ID}.json`), JSON.stringify({
    rootCauseHypothesis: 'The heading text changed', failureKind: 'product_bug',
    recommendedFixTarget: { kind: 'code', reference: 'login page', rationale: 'Wrong heading' }, evidence: [],
  }));
  await yazAtomik(join(dizin, `generate-${TEST_ID}.json`), JSON.stringify({ kod: kod(baseUrl, 'Login') }));
  return dizin;
}

async function proje(baseUrl: string, durum: TestKaydi['status'] = 'ready'): Promise<{ cwd: string; dizin: KobayDizini }> {
  const cwd = await mkdtemp(join(tmpdir(), 'kobay-analizsiz-'));
  const dizin = await KobayDizini.ac(cwd, { baseUrl, beyin: { adaptor: 'sahte' } });
  await dizin.testYaz({
    id: TEST_ID, name: 'shows the login heading', type: 'frontend', createdFrom: 'cli', status: durum,
    planSteps: [
      { type: 'action', description: 'Open the login page' },
      { type: 'assertion', description: 'See the login heading' },
    ],
    priority: 'p1', codeVersion: durum === 'draft' ? 0 : 1,
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z',
  });
  process.env.KOBAY_SAHTE_YANIT_DIZINI = await hazirBeyinYanitlari(baseUrl);
  return { cwd, dizin };
}

async function beyinGunlukleri(cwd: string): Promise<string[]> {
  return (await readdir(join(cwd, '.kobay', 'logs')).catch(() => [] as string[])).filter((ad) => ad.startsWith('brain-'));
}

describe('kobay test run --no-analysis (real demo run, no brain)', () => {
  it('a broken test fails with exit 1 and failure kind unknown, writes a readable bundle, and never calls the brain; fixed, it passes with exit 0', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const { cwd, dizin } = await proje(demo.url);
    await dizin.kodYaz(TEST_ID, kod(demo.url, 'Wrong heading'));

    const dusen = await testRun({ cwd, ids: [TEST_ID], noAnalysis: true });
    expect(dusen.exitCode, JSON.stringify(dusen.json)).toBe(1);
    expect(dusen.json).toEqual([expect.objectContaining({ id: TEST_ID, verdict: 'failed', failureKind: 'unknown' })]);
    expect(await beyinGunlukleri(cwd)).toEqual([]);

    // Kanıt paketi yine yazıldı ve `failure get` onu çıkarıyor.
    const hedef = join(cwd, 'bundle-out');
    const kopya = await failureGet({ cwd, id: TEST_ID, out: hedef });
    expect(kopya.exitCode, JSON.stringify(kopya.json)).toBe(0);
    const paket = JSON.parse(await readFile(join(hedef, 'failure.json'), 'utf8')) as HataPaketi;
    expect(paket.failure.failureKind).toBe('unknown');
    expect(paket.failure.rootCauseHypothesis).toBe(ANALIZ_ATLANDI);
    expect(paket.failure.recommendedFixTarget).toEqual({ kind: 'unknown', reference: ANALIZ_ATLANDI, rationale: ANALIZ_ATLANDI });
    expect(paket.result).toMatchObject({ verdict: 'failed', failureKind: 'unknown', failedStepIndex: 1 });
    expect(paket.result.errorMessage ?? paket.steps.find((adim) => adim.status === 'failed')?.errorMessage).toContain('Wrong heading');
    expect(paket.failure.evidence.map((kanit) => kanit.kind)).toContain('screenshot');
    await access(join(hedef, 'step-1.png'));
    await access(join(hedef, 'code.ts'));
    const sonuc = JSON.parse(await readFile(join(cwd, '.kobay', 'runs', paket.runId, 'result.json'), 'utf8')) as { failureKind?: string };
    expect(sonuc.failureKind).toBe('unknown');

    // İstem analiz yapılmadığını söyler; paket yerelde olmadığı için yerel yeniden koşuyu önerir.
    const ozetYolu = join(cwd, 'summary.md');
    expect((await testReport({ cwd, all: true, summary: ozetYolu })).exitCode).toBe(0);
    const ozet = await readFile(ozetYolu, 'utf8');
    expect(ozet).toContain('It ran without analysis');
    expect(ozet).not.toContain('could not tell the cause');
    expect(ozet).toContain(`Its failure bundle is not on this machine. Reproduce it: \`kobay test rerun ${TEST_ID} --output json\``);
    expect(ozet).not.toContain(`Get the evidence: \`kobay test failure get ${TEST_ID}`);

    await dizin.kodYaz(TEST_ID, kod(demo.url, 'Login'));
    const gecen = await testRun({ cwd, ids: [TEST_ID], noAnalysis: true });
    expect(gecen.exitCode, JSON.stringify(gecen.json)).toBe(0);
    expect(gecen.json).toEqual([expect.objectContaining({ id: TEST_ID, verdict: 'passed' })]);
    expect(await beyinGunlukleri(cwd)).toEqual([]);
  }, 120_000);

  it('a test without generated code, or a draft with stale code, is blocked (exit 3) with a hint, and no code is generated', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const { cwd, dizin } = await proje(demo.url, 'draft');

    const sonuc = await testRun({ cwd, all: true, noAnalysis: true });
    expect(sonuc.exitCode).toBe(3);
    const satir = (sonuc.json as Array<Record<string, unknown>>)[0];
    expect(satir).toMatchObject({ id: TEST_ID, verdict: 'blocked' });
    expect(String(satir?.error)).toContain(`kobay test run ${TEST_ID}`);
    expect(String(satir?.error)).toContain('locally with a brain');
    await expect(dizin.kodOku(TEST_ID)).resolves.toBeNull();
    expect((await dizin.testOku(TEST_ID)).status).toBe('draft');
    expect(await beyinGunlukleri(cwd)).toEqual([]);

    // Kodu olan ama taslak (planı değişmiş) test de engellenir: motor taslağı koşturmaz, bayat kod koşmaz.
    await dizin.kodYaz(TEST_ID, kod(demo.url, 'Login'));
    const taslak = await testRun({ cwd, ids: [TEST_ID], noAnalysis: true });
    expect(taslak.exitCode).toBe(3);
    expect(String((taslak.json as Array<Record<string, unknown>>)[0]?.error)).toContain('draft');
    // Engel diske yazılır (rapor `not run` saymasın), test kaydı taslak kalır (yerel `test run` kodu yeniden üretsin).
    const kosular = await dizin.kosuListele(TEST_ID);
    expect(kosular).toHaveLength(2);
    expect(kosular.every((k) => k.verdict === 'blocked' && k.errorMessage?.startsWith(KODSUZ_ENGEL_ONEKI))).toBe(true);
    const kayit = await dizin.testOku(TEST_ID);
    expect(kayit.status).toBe('draft');
    expect(kayit.lastRunId).toBe(kosular.at(-1)?.runId);

    // run → report: engelli test raporda `blocked` sayılır ve "kod yok" istemi alır (uygulama kapalı değil).
    const ozetYolu = join(cwd, 'summary.md');
    const rapor = await testReport({ cwd, all: true, summary: ozetYolu });
    expect(rapor.exitCode).toBe(0);
    expect(rapor.json).toMatchObject({ counts: { blocked: 1, notRun: 0 } });
    const ozet = await readFile(ozetYolu, 'utf8');
    expect(ozet).toContain('| 0 | 0 | 1 | 0 | 0 |');
    expect(ozet).toContain('Fix with your coding agent');
    expect(ozet).toContain('it has no up-to-date generated code');
    expect(ozet).toContain(`\`kobay test run ${TEST_ID} --output json\``);
    expect(ozet).not.toContain('the app could not be reached');

    // Karşılaştırma: bayraksız aynı koşu sahte beyinle kodu üretir (beyin yolu gerçekten açık).
    const bayraksiz = await testRun({ cwd, all: true });
    expect(bayraksiz.exitCode, JSON.stringify(bayraksiz.json)).not.toBe(3);
    expect((await dizin.testOku(TEST_ID)).status).not.toBe('draft');
    expect(await beyinGunlukleri(cwd)).toContain(`brain-generate-${TEST_ID}-1.log`);
  }, 120_000);
});
