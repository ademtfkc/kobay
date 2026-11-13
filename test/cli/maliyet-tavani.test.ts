import { appendFileSync } from 'node:fs';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium } from '@playwright/test';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import { ANALIZ_ATLANDI_BEYIN } from '../../src/analiz/index.js';
import { beyinOlustur } from '../../src/beyin/index.js';
import { main } from '../../src/cli/index.js';
import { testList, testReport, testResult, testRun } from '../../src/cli/komutlar/index.js';
import { KobayDizini, type HataPaketi, type TestKaydi } from '../../src/depo/index.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';
import { baslat } from '../kobay-demo/sunucu.mjs';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * 0.9.1: toplam maliyet tavanı bir `test run --all` koşusunun ortasında dolunca.
 *
 * Beyin defteri süreç başına tektir (`process.env` anahtarlı). `beforeAll` sahte bir `claude`
 * ile bir çağrı yapar: çağrı başına bütçe $1, toplam tavan $1.5, çağrı $0.60 tutar. Kalan $0.90
 * bir çağrının $1 rezervasyonuna yetmez; bu dosyadaki her sonraki `claude` çağrısı başlamadan
 * `cost_cap` ile reddedilir. Sahte CLI her başlatılışı sayaca yazar: sayaç 1'de kalmalı.
 */

const ORIJINAL_PATH = process.env.PATH;
let sayac = '';
let tarayiciEngeli: unknown;
let demo: { url: string; kapat: () => Promise<void> } | undefined;

async function sahteClaude(): Promise<{ dizin: string; sayac: string }> {
  const dizin = await geciciDizinAc('kobay-tavan-cli-');
  const sayacYolu = join(dizin, 'cagrilar.txt');
  await writeFile(join(dizin, 'claude'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(sayacYolu)}, 'cagri\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.6, result: '{"tamam":true}' }));
});
`);
  await chmod(join(dizin, 'claude'), 0o755);
  if (process.platform === 'win32') {
    await writeFile(join(dizin, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude" %*\r\n');
  }
  appendFileSync(sayacYolu, '');
  return { dizin, sayac: sayacYolu };
}

async function cagriSayisi(): Promise<number> {
  return (await readFile(sayac, 'utf8')).split('\n').filter((satir) => satir !== '').length;
}

beforeAll(async () => {
  const cli = await sahteClaude();
  sayac = cli.sayac;
  process.env.PATH = ORIJINAL_PATH === undefined ? cli.dizin : `${cli.dizin}${delimiter}${ORIJINAL_PATH}`;
  const beyin = beyinOlustur({ adaptor: 'claude', maxBudgetUsd: 1, maxTotalCostUsd: 1.5 }, process.env);
  await beyin.sor({ gorev: 'isinma', sistem: 'S', kullanici: 'K', sema: v.object({ tamam: v.boolean() }) });
  expect(await cagriSayisi()).toBe(1);

  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
  }
  if (tarayiciEngeli === undefined) demo = await baslat(0);
});

afterAll(async () => {
  if (ORIJINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIJINAL_PATH;
  delete process.env.KOBAY_SAHTE_YANIT_DIZINI;
  await demo?.kapat();
});

function playwrightMumkun(context: TestContext): boolean {
  if (tarayiciEngeli === undefined) return true;
  if (process.env.KOBAY_CHROMIUM_TEST === '1') throw tarayiciEngeli;
  context.skip(`Chromium engelli: ${String(tarayiciEngeli).split('\n')[0] ?? ''}`);
  return false;
}

function metinTopla(akis: PassThrough): () => string {
  let sonuc = '';
  akis.setEncoding('utf8');
  akis.on('data', (parca: string) => { sonuc += parca; });
  return () => sonuc;
}

async function kobay(argv: string[]): Promise<{ kod: number; stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutMetni = metinTopla(stdout);
  const stderrMetni = metinTopla(stderr);
  const kod = await main(['node', 'kobay', ...argv], { input: Readable.from([]), stdout, stderr });
  return { kod, stdout: stdoutMetni(), stderr: stderrMetni() };
}

function testKaydi(id: string, status: TestKaydi['status']): TestKaydi {
  return {
    id, name: `test ${id}`, type: 'frontend', createdFrom: 'cli', status,
    planSteps: [
      { type: 'action', description: 'Open the login page' },
      { type: 'assertion', description: 'See the login heading' },
    ],
    priority: 'p1', codeVersion: status === 'draft' ? 0 : 1,
    createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
  };
}

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

async function proje(baseUrl: string, adaptor: 'claude' | 'sahte' = 'claude'): Promise<{ cwd: string; dizin: KobayDizini }> {
  const cwd = await geciciDizinAc('kobay-tavan-');
  const dizin = await KobayDizini.ac(cwd, { baseUrl, brain: { adaptor } });
  await dizin.haritaYaz({
    baseUrl, loggedIn: false,
    pages: [{ url: `${baseUrl}/login`, title: 'Login', headings: ['Login'], links: [], forms: [], buttons: [], menu: [] }],
    exploredAt: '2026-11-13T00:00:00.000Z',
  });
  return { cwd, dizin };
}

type Satir = Record<string, unknown> & { id: string; verdict: string };

async function listeDurumlari(cwd: string): Promise<Record<string, string>> {
  const liste = await testList({ cwd });
  return Object.fromEntries((liste.json as Array<{ id: string; status: string }>).map((t) => [t.id, t.status]));
}

async function raporOzeti(cwd: string): Promise<{
  verdicts: Record<string, string>; runIds: Record<string, string | undefined>; counts: Record<string, number>; html: string;
}> {
  const rapor = await testReport({ cwd, all: true, out: join(cwd, 'rapor') });
  expect(rapor.exitCode, JSON.stringify(rapor.json)).toBe(0);
  const veri = rapor.json as { indexPath: string; tests: Array<{ id: string; verdict: string; runId?: string }>; counts: Record<string, number> };
  return {
    verdicts: Object.fromEntries(veri.tests.map((t) => [t.id, t.verdict])),
    runIds: Object.fromEntries(veri.tests.map((t) => [t.id, t.runId])),
    counts: veri.counts,
    html: await readFile(veri.indexPath, 'utf8'),
  };
}

/** `kobay:` önekli bilinçli düşüş: yerelde `test_bug` sınıflanır, beyin gerekmez. */
function kobayDususKodu(baseUrl: string): string {
  return `import { test } from './_fixture';
test('needs the real credentials', async ({ page }) => {
  await test.step('0: Open the login page', async () => {
    await page.goto('${baseUrl}/login');
  });
  await test.step('1: Type the real password', async () => {
    throw new Error('kobay: this step needs the real credentials, which generated tests never see');
  });
});
`;
}

async function uretimGunlukleri(cwd: string): Promise<string[]> {
  return (await readdir(join(cwd, '.kobay', 'logs')).catch(() => [] as string[])).filter((ad) => ad.startsWith('brain-generate-'));
}

const A = 't_tavana11';
const B = 't_tavanb22';
const C = 't_tavanc33';
const D = 't_tavand44';
const E = 't_tavane55';
const F = 't_tavanf66';
const G = 't_tavang77';

describe('test run when the total cost cap is reached (0.9.1)', () => {
  it('code generation hits the cap: the cap message appears once, no further call starts, and run, list and report agree that the tests did not run', async () => {
    const { cwd, dizin } = await proje('http://127.0.0.1:9');
    for (const id of [A, B, C]) await dizin.testYaz(testKaydi(id, 'draft'));

    const insan = await kobay(['--cwd', cwd, 'test', 'run', '--all']);
    const metin = insan.stdout + insan.stderr;
    expect(insan.kod, metin).toBe(4);
    // Uzun tavan mesajı bir kez, test başına değil.
    expect(metin.split('Cost limit reached:').length - 1, metin).toBe(1);
    for (const id of [A, B, C]) expect(metin).toMatch(new RegExp(`^inconclusive ${id} — not run: total cost limit reached`, 'm'));
    expect(metin).toContain(`3 tests did not run because the total cost limit was reached: ${A} ${B} ${C}`);
    expect(metin).toContain('Spent $0.60 of the $1.50 total cost limit');
    expect(metin).toContain('each claude call reserves up to the per-call budget ($1.00');
    expect(metin).toContain('about $0.50');
    expect(metin).toContain(`kobay test run ${A} ${B} ${C}`);
    // Tavan çağrıdan önce denetlenir: hiçbir `claude` süreci başlamadı. Yalnız ilk test beyne
    // sorulup reddedildi (tek üretim günlüğü); B ve C için beyin hiç çağrılmadı.
    expect(await cagriSayisi()).toBe(1);
    expect(await uretimGunlukleri(cwd)).toEqual([`brain-generate-${A}-1.log`]);

    // `test list`: kod üretilmedi, testler taslak kaldı (bir sonraki koşu kodu üretir).
    expect(await listeDurumlari(cwd)).toEqual({ [A]: 'draft', [B]: 'draft', [C]: 'draft' });
    // `test report` koşunun bastığı sonucu gösterir: sonuçsuz, gerekçesiyle.
    const rapor = await raporOzeti(cwd);
    expect(rapor.verdicts).toEqual({ [A]: 'inconclusive', [B]: 'inconclusive', [C]: 'inconclusive' });
    expect(rapor.counts).toMatchObject({ inconclusive: 3, notRun: 0 });
    expect(rapor.html).toContain('Not run: the test code could not be generated');
    expect(rapor.html).toContain('cost_cap');
    const sonuc = await testResult({ cwd, id: B });
    expect(sonuc.json).toMatchObject({ verdict: 'inconclusive' });

    // JSON satırları: verdict aynı, `notRun` ve diske yazılan `runId` eklenir.
    const json = await kobay(['--cwd', cwd, '--output', 'json', 'test', 'run', '--all']);
    expect(json.kod).toBe(4);
    const zarf = JSON.parse(json.stdout) as { data: Satir[] };
    expect(zarf.data.map((s) => [s.id, s.verdict, s.notRun])).toEqual([
      [A, 'inconclusive', true], [B, 'inconclusive', true], [C, 'inconclusive', true],
    ]);
    for (const satir of zarf.data) expect(typeof satir.runId).toBe('string');
    // Rapor, koşunun yazdığı kaydı gösteriyor.
    expect((await raporOzeti(cwd)).runIds).toEqual(Object.fromEntries(zarf.data.map((s) => [s.id, s.runId])));
    const mesajlar = zarf.data.map((s) => (s.error as { message: string }).message);
    expect(mesajlar[0]).toContain('Cost limit reached:');
    expect(mesajlar.slice(1).every((m) => !m.includes('Cost limit reached:'))).toBe(true);
    expect(mesajlar.slice(1).every((m) => m.includes('the total cost limit (KOBAY_MAX_TOTAL_COST_USD'))).toBe(true);
    expect(await cagriSayisi()).toBe(1);
  });

  it('MCP test_run takes the same path: verdict rows with notRun, the state on disk agrees', async () => {
    const { cwd, dizin } = await proje('http://127.0.0.1:9');
    for (const id of [A, B]) await dizin.testYaz(testKaydi(id, 'draft'));
    const sunucu = mcpSunucusuOlustur({ cwd });
    const istemci = new Client({ name: 'kobay-test', version: '0.1.0' });
    const [sunucuTasima, istemciTasima] = InMemoryTransport.createLinkedPair();
    await Promise.all([sunucu.connect(sunucuTasima), istemci.connect(istemciTasima)]);
    try {
      const yanit = await istemci.callTool({ name: 'test_run', arguments: { all: true } });
      expect(yanit.isError).toBe(true);
      const satirlar = JSON.parse((yanit.content as Array<{ text: string }>)[0]?.text ?? '') as Satir[];
      expect(satirlar.map((s) => [s.id, s.verdict, s.notRun])).toEqual([[A, 'inconclusive', true], [B, 'inconclusive', true]]);
    } finally {
      await istemci.close();
      await sunucu.close();
    }
    expect((await raporOzeti(cwd)).verdicts).toEqual({ [A]: 'inconclusive', [B]: 'inconclusive' });
    expect(await cagriSayisi()).toBe(1);
  });

  it('any brain error during code generation is written to disk: run, list and report agree', async () => {
    const { cwd, dizin } = await proje('http://127.0.0.1:9', 'sahte');
    // Boş yanıt dizini: sahte beyin `empty_response` verir (tavanla ilgisiz bir beyin hatası).
    process.env.KOBAY_SAHTE_YANIT_DIZINI = await geciciDizinAc('kobay-tavan-bos-');
    await dizin.testYaz(testKaydi(A, 'draft'));
    const kosu = await testRun({ cwd, ids: [A] });
    expect(kosu.exitCode).toBe(4);
    expect(kosu.json).toEqual([expect.objectContaining({ id: A, verdict: 'inconclusive', notRun: true })]);
    expect(kosu.mesaj).toMatch(new RegExp(`^inconclusive ${A} — not run`));
    expect(kosu.mesaj).not.toContain('did not run because');
    expect(await listeDurumlari(cwd)).toEqual({ [A]: 'draft' });
    const rapor = await raporOzeti(cwd);
    expect(rapor.verdicts).toEqual({ [A]: 'inconclusive' });
    expect(rapor.html).toContain('Not run: the test code could not be generated (The brain returned an empty answer');
  });

  it('a parallel run that updates a skipped test meanwhile is not overwritten by the not-run record', async () => {
    const { cwd, dizin } = await proje('http://127.0.0.1:9');
    for (const id of [A, B]) await dizin.testYaz(testKaydi(id, 'draft'));
    // Başka bir kobay süreci, bu koşu A'yı işlerken B'yi koşturup `passed` yazıyor.
    const paralel: TestKaydi = {
      ...testKaydi(B, 'passed'), codeVersion: 1, lastRunId: 'r_20261113000000_para', updatedAt: '2026-11-13T09:00:00.000Z',
    };
    const asil = KobayDizini.prototype.kosuSonucuYaz;
    const casus = vi.spyOn(KobayDizini.prototype, 'kosuSonucuYaz').mockImplementation(async function (this: KobayDizini, kayit) {
      await asil.call(this, kayit);
      if (kayit.testId === A) await this.testYaz(paralel);
    });
    try {
      const kosu = await testRun({ cwd, all: true });
      const satirlar = kosu.json as Satir[];
      expect(satirlar[1]).toMatchObject({ id: B, verdict: 'inconclusive', notRun: true });
      expect(satirlar[1]).not.toHaveProperty('runId');
      expect(kosu.mesaj).toContain('another kobay run updated this test meanwhile');
    } finally {
      casus.mockRestore();
    }
    expect(await dizin.testOku(B)).toEqual(paralel);
    expect(await listeDurumlari(cwd)).toEqual({ [A]: 'draft', [B]: 'passed' });
  });

  // Six real Playwright runs, four of them waiting out a 3 s heading check: ~16 s locally, more on loaded CI runners.
  it('a run that fails and then hits the cap in analysis stays failed everywhere; tests with code still run, drafts are not attempted', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const { cwd, dizin } = await proje(demo.url);
    await dizin.testYaz(testKaydi(A, 'ready'));
    await dizin.kodYaz(A, kod(demo.url, 'Wrong heading'));
    await dizin.testYaz(testKaydi(B, 'draft'));
    await dizin.testYaz(testKaydi(C, 'ready'));
    await dizin.kodYaz(C, kod(demo.url, 'Login'));
    await dizin.testYaz(testKaydi(D, 'ready'));
    await dizin.kodYaz(D, kod(demo.url, 'Another wrong heading'));
    // E: `kobay:` önekli düşüş, yerel sınıflama tutar; tavan dolu olsa da analiz "atlanmış" sayılmaz.
    await dizin.testYaz(testKaydi(E, 'ready'));
    await dizin.kodYaz(E, kobayDususKodu(demo.url));
    // F: düşer, tavan doluyken analizsiz paket yazımı da düşer (disk dolu gibi).
    await dizin.testYaz(testKaydi(F, 'ready'));
    await dizin.kodYaz(F, kod(demo.url, 'Yet another wrong heading'));
    // G: düşer, analizsiz paket yayımlanır, ardından result.json'a sınıfın işlenmesi düşer.
    await dizin.testYaz(testKaydi(G, 'ready'));
    await dizin.kodYaz(G, kod(demo.url, 'Still a wrong heading'));
    const asil = KobayDizini.prototype.hataPaketiYaz;
    const casus = vi.spyOn(KobayDizini.prototype, 'hataPaketiYaz').mockImplementation(async function (this: KobayDizini, paket, ekler) {
      if (paket.testId === F) throw new Error('ENOSPC: no space left on device');
      return asil.call(this, paket, ekler);
    });
    const asilSonuc = KobayDizini.prototype.kosuSonucuYaz;
    const sonucCasusu = vi.spyOn(KobayDizini.prototype, 'kosuSonucuYaz').mockImplementation(async function (this: KobayDizini, kayit) {
      if (kayit.testId === G && kayit.failureKind !== undefined) throw new Error('EXDEV: rename failed');
      return asilSonuc.call(this, kayit);
    });

    let kosu;
    try {
      kosu = await testRun({ cwd, all: true });
    } finally {
      casus.mockRestore();
      sonucCasusu.mockRestore();
    }
    expect(kosu.exitCode, JSON.stringify(kosu.json)).toBe(4);
    const satirlar = kosu.json as Satir[];
    expect(satirlar.map((s) => [s.id, s.verdict])).toEqual([
      [A, 'failed'], [B, 'inconclusive'], [C, 'passed'], [D, 'failed'], [E, 'failed'], [F, 'failed'], [G, 'failed'],
    ]);
    expect(satirlar[0]).toMatchObject({ failureKind: 'unknown' });
    expect((satirlar[0]?.analysisError as { message: string }).message).toContain('Cost limit reached:');
    expect((satirlar[3]?.analysisError as { message: string }).message).toContain('the total cost limit (KOBAY_MAX_TOTAL_COST_USD');
    expect(satirlar[1]).toMatchObject({ notRun: true });
    expect(satirlar[2]).not.toHaveProperty('analysisError');
    // E: yerel sınıflama diskte ve satırda aynı; analiz hatası yok.
    expect(satirlar[4]).toMatchObject({ failureKind: 'test_bug' });
    expect(satirlar[4]).not.toHaveProperty('analysisError');
    // F: koşunun `failed`'i ve runId'si korunur, paket yazım hatası ayrı alanda.
    expect(typeof satirlar[5]?.runId).toBe('string');
    expect((satirlar[5]?.bundleError as { message: string }).message).toContain('ENOSPC');
    expect(satirlar[5]).not.toHaveProperty('failureKind');
    // F: paket yazılamasa da analiz tavan yüzünden atlandı; bu da söylenir.
    expect((satirlar[5]?.analysisError as { message: string }).message).toContain('the total cost limit (KOBAY_MAX_TOTAL_COST_USD');
    // G: paket yayımlandı, result.json sınıfsız kaldı: satır diskteki gibi sınıfsız, hata ayrı alanda.
    const g = satirlar[6] ?? {};
    expect(typeof g.runId).toBe('string');
    expect(g).not.toHaveProperty('failureKind');
    expect(g).not.toHaveProperty('bundleError');
    expect((g.resultError as { message: string }).message).toContain('EXDEV');
    expect(g).toHaveProperty('analysisError');
    const gSonucu = JSON.parse(await readFile(join(cwd, '.kobay', 'runs', String(g.runId), 'result.json'), 'utf8')) as Record<string, unknown>;
    expect(gSonucu).toMatchObject({ verdict: 'failed' });
    expect(gSonucu).not.toHaveProperty('failureKind');
    const gPaketi = JSON.parse(await readFile(join(cwd, '.kobay', 'failure', G, 'failure.json'), 'utf8')) as HataPaketi;
    expect(gPaketi.runId).toBe(g.runId);

    const metin = kosu.mesaj ?? '';
    expect(metin.split('Cost limit reached:').length - 1, metin).toBe(1);
    expect(metin).toMatch(new RegExp(`^failed ${A} — not analysed`, 'm'));
    expect(metin).toMatch(new RegExp(`^inconclusive ${B} — not run`, 'm'));
    expect(metin).toMatch(new RegExp(`^passed ${C}$`, 'm'));
    expect(metin).toMatch(new RegExp(`^failed ${E} — test_bug$`, 'm'));
    expect(metin).toMatch(new RegExp(`^failed ${F} — failure analysis skipped: total cost limit reached .* — the failure bundle could not be written: .*ENOSPC`, 'm'));
    expect(metin).toContain(`1 test did not run because the total cost limit was reached: ${B}`);
    expect(metin).toMatch(new RegExp(`^failed ${G} — failure analysis skipped: .* — the run result could not be updated with the failure kind: .*EXDEV.*\n  failure bundle: kobay test failure get ${G}$`, 'm'));
    expect(metin).toContain(`Failure analysis skipped because the total cost limit was reached: ${A} ${D} ${F} ${G}`);
    expect(metin).toContain(`kobay test run ${B}`);
    expect(await cagriSayisi()).toBe(1);

    expect(await listeDurumlari(cwd)).toEqual({
      [A]: 'failed', [B]: 'draft', [C]: 'passed', [D]: 'failed', [E]: 'failed', [F]: 'failed', [G]: 'failed',
    });
    const rapor = await raporOzeti(cwd);
    expect(rapor.verdicts).toEqual({
      [A]: 'failed', [B]: 'inconclusive', [C]: 'passed', [D]: 'failed', [E]: 'failed', [F]: 'failed', [G]: 'failed',
    });
    expect(rapor.runIds[F]).toBe(satirlar[5]?.runId);
    expect(rapor.counts).toMatchObject({ passed: 1, failed: 5, inconclusive: 1, notRun: 0 });
    // Beyin hatasıyla analizsiz paket yerelde: istem "bu makinede değil" demez, paketi gösterir.
    const ozetYolu = join(cwd, 'ozet.md');
    expect((await testReport({ cwd, ids: [A], out: join(cwd, 'rapor-a'), summary: ozetYolu })).exitCode).toBe(0);
    const ozet = await readFile(ozetYolu, 'utf8');
    expect(ozet).not.toContain('not on this machine');
    expect(ozet).toContain(`kobay test failure get ${A} --output json`);
    expect(ozet).toContain('a brain limit was reached');
    const ePaketi = JSON.parse(await readFile(join(cwd, '.kobay', 'failure', E, 'failure.json'), 'utf8')) as HataPaketi;
    expect(ePaketi.failure.failureKind).toBe('test_bug');

    // Kanıt paketi analizsiz yazıldı; gerekçe pakette.
    const paket = JSON.parse(await readFile(join(cwd, '.kobay', 'failure', A, 'failure.json'), 'utf8')) as HataPaketi;
    expect(paket.failure.rootCauseHypothesis).toBe(ANALIZ_ATLANDI_BEYIN);
    expect(paket.failure.failureKind).toBe('unknown');
    expect(paket.failure.recommendedFixTarget.rationale).toContain('cost_cap');
  }, 120_000);
});
