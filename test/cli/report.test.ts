import {
  access, chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { main, programOlustur } from '../../src/cli/index.js';
import {
  KobayDizini,
  depoyuBuda,
  type AdimSonucu,
  type HataPaketi,
  type KosuSonucu,
  type PlanAdimi,
  type TestKaydi,
  type Verdict,
} from '../../src/depo/index.js';
import { metindekiKimligiGizle } from '../../src/depo/index.js';
import {
  adresKimligiGizle, eskiRaporlariSil, raporUret, terminaleGuvenli, yerelYollariGizle,
} from '../../src/rapor/index.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const windows = process.platform === 'win32';

function metinTopla(akis: PassThrough): () => string {
  let sonuc = '';
  akis.setEncoding('utf8');
  akis.on('data', (parca: string) => { sonuc += parca; });
  return () => sonuc;
}

async function calistir(argv: string[]): Promise<{ kod: number; stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutMetni = metinTopla(stdout);
  const stderrMetni = metinTopla(stderr);
  const kod = await main(['node', 'kobay', ...argv], { input: Readable.from([]), stdout, stderr });
  return { kod, stdout: stdoutMetni(), stderr: stderrMetni() };
}

async function proje(): Promise<{ cwd: string; dizin: KobayDizini }> {
  const cwd = await mkdtemp(join(tmpdir(), 'kobay-report-'));
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://localhost:3000', brain: { adaptor: 'sahte' } });
  return { cwd, dizin };
}

async function testKaydet(
  dizin: KobayDizini,
  id: string,
  ad: string,
  adimlar: PlanAdimi[],
  lastRunId?: string,
): Promise<TestKaydi> {
  const test: TestKaydi = {
    id,
    name: ad,
    type: 'frontend',
    createdFrom: 'cli',
    status: 'ready',
    planSteps: adimlar,
    priority: 'p1',
    codeVersion: 1,
    ...(lastRunId === undefined ? {} : { lastRunId }),
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
  };
  await dizin.testYaz(test);
  return test;
}

async function kosuKaydet(
  dizin: KobayDizini,
  testId: string,
  runId: string,
  verdict: Verdict,
  secenek: { adimlar?: AdimSonucu[]; errorMessage?: string; pngler?: number[]; stepsHam?: string } = {},
): Promise<KosuSonucu> {
  const sonuc: KosuSonucu = {
    testId,
    runId,
    status: verdict === 'passed' ? 'passed' : 'failed',
    verdict,
    startedAt: '2026-10-05T10:00:00.000Z',
    finishedAt: '2026-10-05T10:00:04.250Z',
    codeVersion: 1,
    ...(verdict === 'failed' ? { failedStepIndex: 1, failureKind: 'product_bug' as const } : {}),
    ...(secenek.errorMessage === undefined ? {} : { errorMessage: secenek.errorMessage }),
  };
  const kosuDizini = await dizin.kosuDizini(runId);
  await dizin.kosuSonucuYaz(sonuc);
  if (secenek.stepsHam !== undefined) await writeFile(join(kosuDizini, 'steps.json'), secenek.stepsHam);
  else if (secenek.adimlar !== undefined) await writeFile(join(kosuDizini, 'steps.json'), JSON.stringify(secenek.adimlar));
  for (const numara of secenek.pngler ?? []) await writeFile(join(kosuDizini, `step-${numara}.png`), PNG);
  return sonuc;
}

function paket(testId: string, runId: string, kok: string): HataPaketi {
  return {
    snapshotId: `s_${runId}`,
    testId,
    runId,
    result: {
      testId, runId, status: 'failed', verdict: 'failed',
      startedAt: '2026-10-05T10:00:00.000Z', finishedAt: '2026-10-05T10:00:04.250Z', codeVersion: 1,
    },
    steps: [],
    code: 'test("x", async () => {});',
    failure: {
      rootCauseHypothesis: kok,
      failureKind: 'product_bug',
      recommendedFixTarget: { kind: 'selector', reference: 'getByRole("button")', rationale: 'Button label changed' },
      evidence: [{ kind: 'screenshot', stepIndex: 1, path: '/secret/abs/path/step-1.png', summary: 'Save button missing' }],
    },
  };
}

const IKI_ADIM: PlanAdimi[] = [
  { type: 'action', description: 'Open the records page' },
  { type: 'assertion', description: 'The new record is listed' },
];

function adimSonuclari(durumlar: Array<AdimSonucu['status']>, hata?: string): AdimSonucu[] {
  return durumlar.map((status, stepIndex) => ({
    stepIndex,
    description: `step ${stepIndex}`,
    status,
    durationMs: 120 + stepIndex,
    screenshotPath: `step-${stepIndex}.png`,
    ...(status === 'failed' && hata !== undefined ? { errorMessage: hata } : {}),
  }));
}

async function raporHtmli(cwd: string): Promise<string> {
  return readFile(join(cwd, '.kobay', 'report', 'index.html'), 'utf8');
}

async function dosyaListesi(kok: string): Promise<string[]> {
  const sonuc: string[] = [];
  const gez = async (yol: string, onEk: string): Promise<void> => {
    for (const girdi of await readdir(yol, { withFileTypes: true })) {
      const goreli = onEk === '' ? girdi.name : `${onEk}/${girdi.name}`;
      if (girdi.isDirectory()) await gez(join(yol, girdi.name), goreli);
      else sonuc.push(goreli);
    }
  };
  await gez(kok, '');
  return sonuc.sort();
}

describe('kobay test report', () => {
  it('(a) reports passed, failed and never-run tests with counts and the JSON data shape; failed tests do not change the exit code', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'Login works', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'passed', {
      adimlar: adimSonuclari(['passed', 'passed']), pngler: [0, 1],
    });
    await testKaydet(dizin, 't_bbbbbbbb', 'Records can be saved', IKI_ADIM, 'r_20261005100000_bbbb');
    await kosuKaydet(dizin, 't_bbbbbbbb', 'r_20261005100000_bbbb', 'failed', {
      adimlar: adimSonuclari(['passed', 'failed'], 'expect(locator).toBeVisible() failed'),
      errorMessage: 'Assertion failed on step 1',
      pngler: [0, 1],
    });
    await testKaydet(dizin, 't_cccccccc', 'Never ran', IKI_ADIM);

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(0);
    const zarf = JSON.parse(sonuc.stdout) as { ok: boolean; exitCode: number; data: Record<string, unknown> };
    const raporDizini = join(dizin.kok, 'report');
    expect(zarf).toEqual({
      ok: true,
      exitCode: 0,
      data: {
        reportDir: raporDizini,
        indexPath: join(raporDizini, 'index.html'),
        tests: [
          { id: 't_aaaaaaaa', name: 'Login works', verdict: 'passed', runId: 'r_20261005100000_aaaa' },
          { id: 't_bbbbbbbb', name: 'Records can be saved', verdict: 'failed', runId: 'r_20261005100000_bbbb' },
          { id: 't_cccccccc', name: 'Never ran', verdict: 'not_run' },
        ],
        counts: { passed: 1, failed: 1, blocked: 0, inconclusive: 0, notRun: 1 },
        screenshots: 4,
        // Yalnız dikkat isteyen (düşen) test için; tek test olduğundan fixAllPrompt yok.
        fixPrompts: [{ id: 't_bbbbbbbb', prompt: expect.stringContaining('Fix the kobay test t_bbbbbbbb.') as unknown }],
      },
    });
    expect(await dosyaListesi(raporDizini)).toEqual([
      'assets/r_20261005100000_aaaa/step-0.png',
      'assets/r_20261005100000_aaaa/step-1.png',
      'assets/r_20261005100000_bbbb/step-0.png',
      'assets/r_20261005100000_bbbb/step-1.png',
      'index.html',
      'kobay-report.json',
    ]);
    const htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).toContain('Content-Security-Policy');
    expect(htmlMetni).toContain('Screenshots are not redacted.');
    expect(htmlMetni).toContain('href="assets/r_20261005100000_bbbb/step-1.png"');
    expect(htmlMetni).toContain('Open the records page');
    expect(htmlMetni).toContain('4.3 s');
    expect(htmlMetni).toContain('not run');
    expect(htmlMetni).not.toMatch(/<script|<iframe|<object|<embed|https?:\/\/(?!localhost:3000)/i);

    const insan = await calistir(['--cwd', cwd, 'test', 'report', 't_bbbbbbbb']);
    expect(insan.kod).toBe(0);
    expect(insan.stdout).toContain('Report written: 1 test (0 passed, 1 failed, 0 blocked, 0 inconclusive, 0 not run), 2 screenshots.');
    expect(insan.stdout).toContain(`Open: ${join(raporDizini, 'index.html')}`);
  });

  it('rejects missing selection, --all with IDs and unknown IDs as usage errors', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'A', IKI_ADIM);
    for (const argv of [[], ['--all', 't_aaaaaaaa'], ['t_zzzzzzzz'], ['../../etc']]) {
      const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', ...argv]);
      expect(sonuc.kod, argv.join(' ')).toBe(2);
    }
    await expect(access(join(dizin.kok, 'report'))).rejects.toThrow();
  });

  it('(b) escapes markup from test names, step descriptions and error messages', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', '<script>alert(1)</script>', [
      { type: 'action', description: '" onerror="alert(2)' },
      { type: 'assertion', description: "<img src=x onerror='alert(3)'>" },
    ], 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'failed', {
      adimlar: adimSonuclari(['passed', 'failed'], '<script>alert(4)</script>'),
      errorMessage: '"><svg onload=alert(5)>',
    });

    expect((await calistir(['--cwd', cwd, 'test', 'report', 't_aaaaaaaa'])).kod).toBe(0);
    const htmlMetni = await raporHtmli(cwd);

    expect(htmlMetni).not.toMatch(/<script/i);
    expect(htmlMetni).not.toContain('" onerror=');
    expect(htmlMetni).not.toContain('<img src=x');
    // Sayfanın kendi satır içi SVG ikonları var; saldırganın enjekte ettiği öğe yok.
    expect(htmlMetni).not.toContain('<svg onload');
    // Hiçbir etiket olay özniteliği taşımaz.
    expect(htmlMetni).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(htmlMetni).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(htmlMetni).toContain('&quot; onerror=&quot;alert(2)');
    expect(htmlMetni).toContain('&lt;img src=x onerror=&#39;alert(3)&#39;&gt;');
    expect(htmlMetni).toContain('&lt;script&gt;alert(4)&lt;/script&gt;');
    expect(htmlMetni).toContain('&quot;&gt;&lt;svg onload=alert(5)&gt;');
  });

  it('(c) masks secrets in error messages and failure analysis', async () => {
    const { cwd, dizin } = await proje();
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const anahtar = `sk-proj-${'x9Y8z7W6'.repeat(4)}`;
    await testKaydet(dizin, 't_aaaaaaaa', 'Secret test', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'failed', {
      adimlar: adimSonuclari(['passed', 'failed'], `request failed with Authorization: Bearer ${token}`),
      errorMessage: `GET /api?token=${token} returned 500`,
    });
    await dizin.hataPaketiYaz(paket('t_aaaaaaaa', 'r_20261005100000_aaaa', `The API key ${anahtar} was rejected`), []);

    expect((await calistir(['--cwd', cwd, 'test', 'report', 't_aaaaaaaa'])).kod).toBe(0);
    const htmlMetni = await raporHtmli(cwd);

    expect(htmlMetni).not.toContain(token);
    expect(htmlMetni).not.toContain(anahtar);
    expect(htmlMetni).toContain('[redacted]');
    expect(htmlMetni).toContain('was rejected');
  });

  it('(d) never copies screenshots from traversal or absolute paths, and survives a broken steps.json', async () => {
    const { cwd, dizin } = await proje();
    const disari = await mkdtemp(join(tmpdir(), 'kobay-report-outside-'));
    await writeFile(join(disari, 'step-5.png'), PNG);
    await testKaydet(dizin, 't_aaaaaaaa', 'Paths', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'passed', {
      adimlar: [
        { stepIndex: 0, description: 'a', status: 'passed', durationMs: 1, screenshotPath: '../../../step-5.png' },
        { stepIndex: 1, description: 'b', status: 'passed', durationMs: 1, screenshotPath: join(disari, 'step-5.png') },
        { stepIndex: 2, description: 'c', status: 'passed', durationMs: 1, screenshotPath: 'step-2.png' },
      ],
      pngler: [2],
    });
    await testKaydet(dizin, 't_bbbbbbbb', 'Broken steps', IKI_ADIM, 'r_20261005100000_bbbb');
    await kosuKaydet(dizin, 't_bbbbbbbb', 'r_20261005100000_bbbb', 'passed', { stepsHam: '{not json', pngler: [0] });

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(0);
    expect((JSON.parse(sonuc.stdout) as { data: { screenshots: number } }).data.screenshots).toBe(1);
    expect(await dosyaListesi(join(dizin.kok, 'report'))).toEqual([
      'assets/r_20261005100000_aaaa/step-2.png',
      'index.html',
      'kobay-report.json',
    ]);
    const htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).not.toContain(disari);
    expect(htmlMetni).not.toContain('../');
    expect(htmlMetni).toContain('Broken steps');
  });

  it.skipIf(windows)('(d) skips a symlinked step-N.png and a symlinked run directory', async () => {
    const { cwd, dizin } = await proje();
    const disari = await mkdtemp(join(tmpdir(), 'kobay-report-outside-'));
    await writeFile(join(disari, 'secret.png'), PNG);
    await testKaydet(dizin, 't_aaaaaaaa', 'Linked file', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'passed', {
      adimlar: adimSonuclari(['passed', 'passed']), pngler: [1],
    });
    await symlink(join(disari, 'secret.png'), join(dizin.yol('runs', 'r_20261005100000_aaaa'), 'step-0.png'));

    // Koşu dizininin kendisi dışarıyı gösteren bir bağ.
    const disKosu = await mkdtemp(join(tmpdir(), 'kobay-report-run-'));
    await testKaydet(dizin, 't_bbbbbbbb', 'Linked run', IKI_ADIM, 'r_20261005100000_bbbb');
    await kosuKaydet(dizin, 't_bbbbbbbb', 'r_20261005100000_bbbb', 'passed', {
      adimlar: adimSonuclari(['passed', 'passed']), pngler: [0, 1],
    });
    const kosuYolu = dizin.yol('runs', 'r_20261005100000_bbbb');
    for (const ad of await readdir(kosuYolu)) await writeFile(join(disKosu, ad), await readFile(join(kosuYolu, ad)));
    await rm(kosuYolu, { recursive: true });
    await symlink(disKosu, kosuYolu, 'dir');

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(0);
    expect(await dosyaListesi(join(dizin.kok, 'report'))).toEqual([
      'assets/r_20261005100000_aaaa/step-1.png',
      'index.html',
      'kobay-report.json',
    ]);
  });

  it('(e) refuses a non-empty foreign --out directory and leaves it untouched', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'A', IKI_ADIM);
    // Kendi üst dizini: paylaşılan tmpdir'de başka testlerin geçici klasörleri görünmesin.
    const yabanci = join(await mkdtemp(join(tmpdir(), 'kobay-report-foreign-')), 'mine');
    await mkdir(yabanci);
    await writeFile(join(yabanci, 'thesis.docx'), 'irreplaceable');
    await mkdir(join(yabanci, 'assets'));
    await writeFile(join(yabanci, 'assets', 'photo.png'), PNG);
    // index.html tek başına kanıt değil: işaret dosyası da gerekir.
    await writeFile(join(yabanci, 'index.html'), '<p>my site</p>');

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all', '--out', yabanci]);

    expect(sonuc.kod).toBe(2);
    expect(sonuc.stdout).toContain('is not a kobay report');
    expect(await dosyaListesi(yabanci)).toEqual(['assets/photo.png', 'index.html', 'thesis.docx']);
    await expect(readFile(join(yabanci, 'thesis.docx'), 'utf8')).resolves.toBe('irreplaceable');
    await expect(readFile(join(yabanci, 'index.html'), 'utf8')).resolves.toBe('<p>my site</p>');
    expect((await readdir(dirname(yabanci))).filter((ad) => ad.startsWith('.kobay-report-'))).toEqual([]);

    // Dosya olan hedef de reddedilir.
    const dosya = join(yabanci, 'thesis.docx');
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all', '--out', dosya])).kod).toBe(2);
    await expect(readFile(dosya, 'utf8')).resolves.toBe('irreplaceable');
  });

  it('(e) refuses hidden path components and other .kobay folders, allows a new or empty directory', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'A', IKI_ADIM);
    for (const out of ['.git/report', 'docs/.hidden/report', '.kobay/tests', '.kobay/report/nested', '.kobay']) {
      const sonuc = await calistir(['--cwd', cwd, 'test', 'report', '--all', '--out', out]);
      expect(sonuc.kod, out).toBe(2);
      expect(sonuc.stderr, out).toContain('--out cannot point inside .kobay');
    }
    await expect(readdir(dizin.yol('tests'))).resolves.toEqual(['t_aaaaaaaa.json']);
    await expect(access(join(cwd, '.git'))).rejects.toThrow();

    const bos = join(await mkdtemp(join(tmpdir(), 'kobay-report-empty-')), 'empty');
    await mkdir(bos);
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all', '--out', bos])).kod).toBe(0);
    const yeni = join(bos, 'nested', 'new-report');
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all', '--out', yeni])).kod).toBe(0);
    await expect(access(join(yeni, 'index.html'))).resolves.toBeUndefined();
    // Kanıtlı kobay raporu yenisiyle değişebilir.
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all', '--out', yeni])).kod).toBe(0);
  });

  it.skipIf(windows)('(e) refuses a symlinked --out and a symlinked .kobay/report', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'A', IKI_ADIM);
    const hedef = await mkdtemp(join(tmpdir(), 'kobay-report-target-'));
    const bag = join(cwd, 'report-link');
    await symlink(hedef, bag, 'dir');

    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all', '--out', bag])).kod).toBe(2);
    await symlink(hedef, join(dizin.kok, 'report'), 'dir');
    const varsayilan = await calistir(['--cwd', cwd, 'test', 'report', '--all']);
    expect(varsayilan.kod).toBe(2);
    await expect(readdir(hedef)).resolves.toEqual([]);
  });

  it('(f) a second report replaces the first completely', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'First name', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'passed', {
      adimlar: adimSonuclari(['passed', 'passed']), pngler: [0, 1],
    });
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);

    await testKaydet(dizin, 't_aaaaaaaa', 'Second name', IKI_ADIM, 'r_20261005110000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005110000_aaaa', 'passed', {
      adimlar: adimSonuclari(['passed', 'passed']), pngler: [1],
    });
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);

    expect(await dosyaListesi(join(dizin.kok, 'report'))).toEqual([
      'assets/r_20261005110000_aaaa/step-1.png',
      'index.html',
      'kobay-report.json',
    ]);
    const htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).toContain('Second name');
    expect(htmlMetni).not.toContain('First name');
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.kobay-report-'))).toEqual([]);
  });

  it('(f) two concurrent reports to the same folder each publish a whole report', async () => {
    const { dizin } = await proje();
    const test = await testKaydet(dizin, 't_aaaaaaaa', 'Concurrent', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'passed', {
      adimlar: adimSonuclari(['passed', 'passed']), pngler: [0, 1],
    });
    const hedef = join(dizin.kok, 'report');
    const uret = () => raporUret({ dizin, testler: [test], hedef, surum: '0.0.0', varsayilanHedef: true });

    const sonuclar = await Promise.allSettled([uret(), uret(), uret()]);

    expect(sonuclar.filter((sonuc) => sonuc.status === 'fulfilled').length).toBeGreaterThan(0);
    expect(await dosyaListesi(hedef)).toEqual([
      'assets/r_20261005100000_aaaa/step-0.png',
      'assets/r_20261005100000_aaaa/step-1.png',
      'index.html',
      'kobay-report.json',
    ]);
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.kobay-report-'))).toEqual([]);
  });

  it('(g) shows the failure analysis only when the bundle belongs to the reported run', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'Bundle', IKI_ADIM, 'r_20261005110000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005110000_aaaa', 'failed', {
      adimlar: adimSonuclari(['passed', 'failed'], 'boom'),
    });
    await dizin.hataPaketiYaz(paket('t_aaaaaaaa', 'r_20261005100000_aaaa', 'Hypothesis from an older run'), []);

    expect((await calistir(['--cwd', cwd, 'test', 'report', 't_aaaaaaaa'])).kod).toBe(0);
    let htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).not.toContain('Hypothesis from an older run');
    expect(htmlMetni).not.toContain('Failure analysis');

    await dizin.hataPaketiYaz(paket('t_aaaaaaaa', 'r_20261005110000_aaaa', 'Hypothesis for this run'), []);
    expect((await calistir(['--cwd', cwd, 'test', 'report', 't_aaaaaaaa'])).kod).toBe(0);
    htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).toContain('Hypothesis for this run');
    expect(htmlMetni).toContain('Failure analysis');
    expect(htmlMetni).toContain('Save button missing');
    expect(htmlMetni).not.toContain('/secret/abs/path');

    // Yarım paket (.partial) gösterilmez.
    await writeFile(dizin.yol('failure', 't_aaaaaaaa', '.partial'), '');
    expect((await calistir(['--cwd', cwd, 'test', 'report', 't_aaaaaaaa'])).kod).toBe(0);
    expect(await raporHtmli(cwd)).not.toContain('Hypothesis for this run');
  });

  it('(h) prune neither deletes nor reports the report folder', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'A', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'passed', {
      adimlar: adimSonuclari(['passed', 'passed']), pngler: [0],
    });
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);
    const once = await dosyaListesi(join(dizin.kok, 'report'));

    const sonuc = await depoyuBuda(dizin, { olderThanDays: 0.000001, maxMb: 0.000001 });

    const tumYollar = [...sonuc.deleted, ...sonuc.wouldDelete, ...sonuc.skipped].map((oge) => oge.path);
    expect(tumYollar.filter((yol) => yol.includes('report'))).toEqual([]);
    expect(await dosyaListesi(join(dizin.kok, 'report'))).toEqual(once);
  });

  it('(i) the managed .gitignore block lists report/', async () => {
    const { dizin } = await proje();
    const satirlar = (await readFile(dizin.yol('.gitignore'), 'utf8')).split('\n');
    const bas = satirlar.indexOf('# >>> kobay managed >>>');
    const son = satirlar.indexOf('# <<< kobay managed <<<');
    expect(satirlar.slice(bas, son)).toContain('report/');
    expect(satirlar.slice(bas, son)).toContain('.kobay-report-*');
  });

  it('(j) help for test report is English and describes every option', async () => {
    const test = programOlustur().commands.find((komut) => komut.name() === 'test');
    const rapor = test?.commands.find((komut: Command) => komut.name() === 'report');
    expect(rapor).toBeDefined();
    const metinler = [rapor?.description() ?? '', ...(rapor?.options ?? []).map((secenek) => secenek.description ?? '')];
    expect(rapor?.options.map((secenek) => secenek.flags)).toEqual(['--all', '--out <dir>', '--summary <path>', '--max-prompts <n>']);
    for (const metin of metinler) {
      expect(metin.trim()).not.toBe('');
      expect(metin).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    }
    const yardim = await calistir(['test', 'report', '--help']);
    expect(yardim.kod).toBe(0);
    expect(yardim.stdout).toContain('Usage: kobay test report [options] [ids...]');
    expect(yardim.stdout).toContain('--out <dir>');
  });
});

describe('kobay test report — hardening', () => {
  async function raporKur(cwd: string, dizin: KobayDizini, out?: string): Promise<void> {
    await testKaydet(dizin, 't_aaaaaaaa', 'A', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'passed', {
      adimlar: adimSonuclari(['passed', 'passed']), pngler: [0],
    });
    const argv = ['--cwd', cwd, 'test', 'report', '--all', ...(out === undefined ? [] : ['--out', out])];
    expect((await calistir(argv)).kod).toBe(0);
  }

  it('(A) refuses a kobay report folder that also holds a foreign entry, and names it', async () => {
    const { cwd, dizin } = await proje();
    const out = join(await mkdtemp(join(tmpdir(), 'kobay-report-extra-')), 'out');
    await raporKur(cwd, dizin, out);
    await raporKur(cwd, dizin);
    for (const [kok, ad] of [[out, 'my-notes.txt'], [join(dizin.kok, 'report'), '.DS_Store']] as const) {
      await writeFile(join(kok, ad), 'mine');
      const once = await dosyaListesi(kok);
      const argv = ['--cwd', cwd, 'test', 'report', '--all', ...(kok === out ? ['--out', out] : [])];
      const sonuc = await calistir(argv);
      expect(sonuc.kod, ad).toBe(2);
      expect(sonuc.stderr, ad).toContain(`unexpected entry "${ad}"`);
      expect(await dosyaListesi(kok), ad).toEqual(once);
      await expect(readFile(join(kok, ad), 'utf8')).resolves.toBe('mine');
    }
    // assets altında yabancı dosya da reddettirir.
    await rm(join(dizin.kok, 'report', '.DS_Store'));
    await writeFile(join(dizin.kok, 'report', 'assets', 'r_20261005100000_aaaa', 'notes.txt'), 'mine');
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(2);
  });

  it('(A) a forged marker next to user files does not make the folder replaceable', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'A', IKI_ADIM);
    const yabanci = join(await mkdtemp(join(tmpdir(), 'kobay-report-forged-')), 'site');
    await mkdir(join(yabanci, 'assets'), { recursive: true });
    await writeFile(join(yabanci, 'index.html'), '<p>my site</p>');
    await writeFile(join(yabanci, 'kobay-report.json'), JSON.stringify({ generator: 'kobay', format: 'kobay-run-report' }));
    await writeFile(join(yabanci, 'assets', 'logo.png'), PNG);
    await writeFile(join(yabanci, 'thesis.docx'), 'irreplaceable');
    const once = await dosyaListesi(yabanci);

    const sonuc = await calistir(['--cwd', cwd, 'test', 'report', '--all', '--out', yabanci]);

    expect(sonuc.kod).toBe(2);
    expect(await dosyaListesi(yabanci)).toEqual(once);
    await expect(readFile(join(yabanci, 'thesis.docx'), 'utf8')).resolves.toBe('irreplaceable');
  });

  it('(A) set-aside folders are deleted name by name; anything unexpected is kept', async () => {
    const { cwd, dizin } = await proje();
    const ust = await mkdtemp(join(tmpdir(), 'kobay-report-old-'));
    const kaynak = join(ust, 'src');
    await raporKur(cwd, dizin, kaynak);
    const kopyala = async (ad: string): Promise<string> => {
      const hedef = join(ust, ad);
      for (const goreli of await dosyaListesi(kaynak)) {
        await mkdir(dirname(join(hedef, goreli)), { recursive: true });
        await writeFile(join(hedef, goreli), await readFile(join(kaynak, goreli)));
      }
      return hedef;
    };
    const temiz = await kopyala('.kobay-report-old-temiz');
    const kirli = await kopyala('.kobay-report-old-kirli');
    await writeFile(join(kirli, 'assets', 'r_20261005100000_aaaa', 'notes.txt'), 'mine');
    const bos = join(ust, '.kobay-report-old-bos');
    await mkdir(bos);
    const yabanciAd = join(ust, 'not-ours');
    await mkdir(yabanciAd);

    const birakilan = await eskiRaporlariSil(ust, [temiz, kirli, bos, yabanciAd]);

    expect(birakilan).toEqual([kirli, yabanciAd]);
    await expect(access(temiz)).rejects.toThrow();
    await expect(access(bos)).rejects.toThrow();
    await expect(readFile(join(kirli, 'assets', 'r_20261005100000_aaaa', 'notes.txt'), 'utf8')).resolves.toBe('mine');
    await expect(access(join(kirli, 'index.html'))).resolves.toBeUndefined();
  });

  it.skipIf(windows)('(B) never reads code, run records, steps or bundles through symlinks', async () => {
    const { cwd, dizin } = await proje();
    const disari = await mkdtemp(join(tmpdir(), 'kobay-report-secret-'));
    await writeFile(join(disari, 'id_rsa'), 'PRIVATE-KEY-MATERIAL');
    // Kod dosyası dışarıyı gösteriyor.
    await testKaydet(dizin, 't_aaaaaaaa', 'Linked code', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'passed', { adimlar: adimSonuclari(['passed', 'passed']) });
    await symlink(join(disari, 'id_rsa'), dizin.kodYolu('t_aaaaaaaa'));
    // result.json dışarıdaki geçerli bir kaydı gösteriyor.
    await testKaydet(dizin, 't_bbbbbbbb', 'Linked result', IKI_ADIM, 'r_20261005100000_bbbb');
    await kosuKaydet(dizin, 't_bbbbbbbb', 'r_20261005100000_bbbb', 'passed', {});
    const sonucYolu = join(dizin.yol('runs', 'r_20261005100000_bbbb'), 'result.json');
    await writeFile(join(disari, 'result.json'), await readFile(sonucYolu));
    await rm(sonucYolu);
    await symlink(join(disari, 'result.json'), sonucYolu);
    // steps.json dışarıyı gösteriyor; hata paketi dizini dışarıyı gösteriyor.
    await testKaydet(dizin, 't_cccccccc', 'Linked steps and bundle', IKI_ADIM, 'r_20261005100000_cccc');
    await kosuKaydet(dizin, 't_cccccccc', 'r_20261005100000_cccc', 'failed', {});
    await writeFile(join(disari, 'steps.json'), JSON.stringify(adimSonuclari(['passed', 'failed'], 'OUTSIDE-STEP-ERROR')));
    await symlink(join(disari, 'steps.json'), join(dizin.yol('runs', 'r_20261005100000_cccc'), 'steps.json'));
    const disPaket = join(disari, 'bundle');
    await mkdir(disPaket);
    await writeFile(join(disPaket, 'failure.json'), JSON.stringify(paket('t_cccccccc', 'r_20261005100000_cccc', 'OUTSIDE-HYPOTHESIS')));
    await mkdir(dizin.yol('failure'), { recursive: true });
    await symlink(disPaket, dizin.yol('failure', 't_cccccccc'), 'dir');

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(0);
    const htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).not.toContain('PRIVATE-KEY-MATERIAL');
    expect(htmlMetni).not.toContain('OUTSIDE-STEP-ERROR');
    expect(htmlMetni).not.toContain('OUTSIDE-HYPOTHESIS');
    const veri = (JSON.parse(sonuc.stdout) as { data: { tests: Array<{ id: string; verdict: string }> } }).data;
    expect(veri.tests.map((test) => test.verdict)).toEqual(['passed', 'inconclusive', 'failed']);
    expect(htmlMetni).toContain('The run record (result.json) is missing, unreadable or not valid');
  });

  it.skipIf(windows)('(B) refuses symlinked test records and a symlinked tests folder', async () => {
    const { cwd, dizin } = await proje();
    const disari = await mkdtemp(join(tmpdir(), 'kobay-report-records-'));
    const kayit = await testKaydet(dizin, 't_aaaaaaaa', 'SECRET-RECORD-NAME', IKI_ADIM);
    await writeFile(join(disari, 't_aaaaaaaa.json'), JSON.stringify(kayit));
    await rm(dizin.yol('tests', 't_aaaaaaaa.json'));
    await symlink(join(disari, 't_aaaaaaaa.json'), dizin.yol('tests', 't_aaaaaaaa.json'));
    for (const argv of [['t_aaaaaaaa'], ['--all']]) {
      const sonuc = await calistir(['--cwd', cwd, 'test', 'report', ...argv]);
      expect(sonuc.kod, argv.join(' ')).toBe(2);
      expect(sonuc.stderr).toContain('symlink');
    }
    await rm(dizin.yol('tests'), { recursive: true });
    await symlink(disari, dizin.yol('tests'), 'dir');
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(2);
    await expect(access(join(dizin.kok, 'report'))).rejects.toThrow();
  });

  it('(D) replaces the project root and the home directory in report text', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'Paths', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'failed', {
      adimlar: adimSonuclari(['passed', 'failed'], `at ${join(homedir(), 'private-notes', 'x.ts')}:1:1`),
      errorMessage: `Error at ${join(cwd, '.kobay', 'tests', 't_aaaaaaaa.spec.ts')}:8:3`,
    });

    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);
    const htmlMetni = await raporHtmli(cwd);

    expect(htmlMetni).not.toContain(cwd);
    expect(htmlMetni).not.toContain(homedir());
    // join('/x', …).slice(2): platform ayracıyla `<ayraç>.kobay<ayraç>tests…`.
    expect(htmlMetni).toContain(`[project]${join('/x', '.kobay', 'tests', 't_aaaaaaaa.spec.ts').slice(2)}`);
    expect(htmlMetni).toContain(`~${process.platform === 'win32' ? '\\' : '/'}private-notes`);
  });

  it('(D) path placeholders cover POSIX and Windows separators without eating longer names', () => {
    const kokler = [
      { yol: 'C:\\Users\\alice\\proj', yerTutucu: '[project]' },
      { yol: 'C:\\Users\\alice', yerTutucu: '~' },
      { yol: '/home/al', yerTutucu: '~' },
    ];
    expect(yerelYollariGizle('at C:\\Users\\alice\\proj\\tests\\a.ts:1', kokler)).toBe('at [project]\\tests\\a.ts:1');
    expect(yerelYollariGizle('file:///c:/Users/alice/proj/tests/a.ts', kokler)).toBe('file:///[project]/tests/a.ts');
    expect(yerelYollariGizle('C:\\Users\\alice\\.ssh\\id', kokler)).toBe('~\\.ssh\\id');
    expect(yerelYollariGizle('/home/alice/x and /home/al/y and /home/al', kokler)).toBe('/home/alice/x and ~/y and ~');
    expect(yerelYollariGizle('/x', [{ yol: '/', yerTutucu: '~' }])).toBe('/x');
  });

  it('(F) an unreadable run record is inconclusive with a visible note; a missing run directory is not run', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'Corrupt record', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'passed', {});
    await writeFile(join(dizin.yol('runs', 'r_20261005100000_aaaa'), 'result.json'), '{broken');
    await testKaydet(dizin, 't_bbbbbbbb', 'Pruned run', IKI_ADIM, 'r_20261005100000_bbbb');

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(0);
    const veri = (JSON.parse(sonuc.stdout) as { data: { tests: unknown[]; counts: unknown } }).data;
    expect(veri.tests).toEqual([
      { id: 't_aaaaaaaa', name: 'Corrupt record', verdict: 'inconclusive', runId: 'r_20261005100000_aaaa' },
      { id: 't_bbbbbbbb', name: 'Pruned run', verdict: 'not_run' },
    ]);
    expect(veri.counts).toEqual({ passed: 0, failed: 0, blocked: 0, inconclusive: 1, notRun: 1 });
    expect(await raporHtmli(cwd)).toContain('The run record (result.json) is missing, unreadable or not valid');
  });

  it('(G) notes when the generated code is newer than the reported run', async () => {
    const { cwd, dizin } = await proje();
    const test = await testKaydet(dizin, 't_aaaaaaaa', 'Versions', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'passed', {});
    await dizin.kodYaz('t_aaaaaaaa', 'test("v", async () => {});');
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);
    expect(await raporHtmli(cwd)).not.toContain('the reported run used version');

    await dizin.testYaz({ ...test, codeVersion: 3 });
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);
    expect(await raporHtmli(cwd)).toContain('This is the current code (version 3); the reported run used version 1.');
  });
});

describe('kobay test report — round 3', () => {
  async function tekKosu(dizin: KobayDizini, verdict: Verdict = 'passed', hata?: string): Promise<void> {
    await testKaydet(dizin, 't_aaaaaaaa', 'A', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', verdict, {
      adimlar: adimSonuclari(['passed', 'passed']), pngler: [0, 1],
      ...(hata === undefined ? {} : { errorMessage: hata }),
    });
  }

  it('(1) a secret whose value contains the project path is fully redacted, not turned into [project]/…', async () => {
    const { cwd, dizin } = await proje();
    const deger = join(cwd, 'private-key-material');
    process.env.KOBAY_REPORT_TEST_SECRET = deger;
    try {
      await tekKosu(dizin, 'failed', `could not read ${deger}`);
      expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);
    } finally {
      delete process.env.KOBAY_REPORT_TEST_SECRET;
    }
    const htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).toContain('could not read [redacted]');
    expect(htmlMetni).not.toContain('private-key-material');
  });

  it('(2) never reads hard-linked code, records or screenshots', async () => {
    const { cwd, dizin } = await proje();
    const disari = await mkdtemp(join(tmpdir(), 'kobay-report-hardlink-'));
    await tekKosu(dizin);
    await writeFile(join(disari, 'private.ts'), 'HARDLINKED-PRIVATE-SOURCE');
    await link(join(disari, 'private.ts'), dizin.kodYolu('t_aaaaaaaa'));
    await link(join(dizin.yol('runs', 'r_20261005100000_aaaa'), 'step-0.png'), join(disari, 'kept-copy.png'));
    await link(join(dizin.yol('runs', 'r_20261005100000_aaaa'), 'result.json'), join(disari, 'result.json'));

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(0);
    const veri = (JSON.parse(sonuc.stdout) as { data: { tests: Array<{ verdict: string }>; screenshots: number } }).data;
    expect(veri.tests[0]?.verdict).toBe('inconclusive');
    expect(veri.screenshots).toBe(0);
    expect(await raporHtmli(cwd)).not.toContain('HARDLINKED-PRIVATE-SOURCE');

    // Hard-linked test record is refused like a symlinked one.
    await link(dizin.yol('tests', 't_aaaaaaaa.json'), join(disari, 'record.json'));
    const kayit = await calistir(['--cwd', cwd, 'test', 'report', 't_aaaaaaaa']);
    expect(kayit.kod).toBe(2);
    expect(kayit.stderr).toContain('hard link');
  });

  it('(3) path placeholders ignore case on case-insensitive systems and match JSON-escaped and mixed separators', () => {
    const kokler = [{ yol: 'C:\\Users\\alice\\proj', yerTutucu: '[project]' }, { yol: '/Users/Alice/Project', yerTutucu: '[project]' }];
    expect(yerelYollariGizle('at /users/alice/project/x.ts', kokler, true)).toBe('at [project]/x.ts');
    expect(yerelYollariGizle('at /users/alice/project/x.ts', kokler, false)).toBe('at /users/alice/project/x.ts');
    expect(yerelYollariGizle('{"file":"C:\\\\Users\\\\alice\\\\proj\\\\x.ts"}', kokler, false)).toBe('{"file":"[project]\\\\x.ts"}');
    expect(yerelYollariGizle('C:/Users/alice\\proj/x.ts', kokler, false)).toBe('[project]/x.ts');
    expect(yerelYollariGizle('c:\\users\\ALICE\\proj\\x.ts', kokler, false)).toBe('[project]\\x.ts');
  });

  const rootMu = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(windows || rootMu)('(4) a run directory without permission is inconclusive with a note, not exit 4', async () => {
    const { cwd, dizin } = await proje();
    await tekKosu(dizin);
    const kosuYolu = dizin.yol('runs', 'r_20261005100000_aaaa');
    await chmod(kosuYolu, 0o000);
    try {
      const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);
      expect(sonuc.kod).toBe(0);
      expect((JSON.parse(sonuc.stdout) as { data: { tests: Array<{ verdict: string }> } }).data.tests[0]?.verdict)
        .toBe('inconclusive');
      expect(await raporHtmli(cwd)).toContain('The run record (result.json) is missing, unreadable or not valid');
    } finally {
      await chmod(kosuYolu, 0o755);
    }
  });

  it('(5) control characters in file names never reach the terminal raw', async () => {
    expect(terminaleGuvenli('a\nb\u001b[31mc\u2028')).toBe('a\\u000ab\\u001b[31mc\\u2028');
    if (windows) return; // NTFS dosya adında satır sonu ve ESC'ye izin vermez.
    const { cwd, dizin } = await proje();
    await tekKosu(dizin);
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);
    await writeFile(join(dizin.kok, 'report', 'evil\n::error::pwned\u001b[31m'), 'x');

    const sonuc = await calistir(['--cwd', cwd, 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(2);
    expect(sonuc.stderr).not.toContain('\n::error::');
    expect(sonuc.stderr).not.toContain('\u001b');
    expect(sonuc.stderr).toContain('evil\\u000a::error::pwned\\u001b[31m');
  });

  it('(6) a complete report structure with an invalid marker is refused and untouched', async () => {
    const { cwd, dizin } = await proje();
    await tekKosu(dizin);
    const out = join(await mkdtemp(join(tmpdir(), 'kobay-report-marker-')), 'out');
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all', '--out', out])).kod).toBe(0);
    for (const icerik of [
      JSON.stringify({ generator: 'kobay', format: 'something-else' }),
      'not json',
      JSON.stringify({ generator: 'kobay', format: 'kobay-run-report', pad: 'x'.repeat(5000) }),
    ]) {
      await writeFile(join(out, 'kobay-report.json'), icerik);
      const once = await dosyaListesi(out);
      const sonuc = await calistir(['--cwd', cwd, 'test', 'report', '--all', '--out', out]);
      expect(sonuc.kod, icerik.slice(0, 20)).toBe(2);
      expect(sonuc.stderr).toContain('kobay-report.json is not a valid kobay report marker');
      expect(await dosyaListesi(out)).toEqual(once);
      await expect(readFile(join(out, 'kobay-report.json'), 'utf8')).resolves.toBe(icerik);
    }
  });

  it.skipIf(windows)('(7) config.json is not read through a symlink or hard link', async () => {
    const { cwd, dizin } = await proje();
    await tekKosu(dizin);
    const disari = await mkdtemp(join(tmpdir(), 'kobay-report-config-'));
    const config = JSON.parse(await readFile(dizin.yol('config.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(disari, 'config.json'), JSON.stringify({ ...config, baseUrl: 'http://outside-secret.example' }));
    await rm(dizin.yol('config.json'));
    await symlink(join(disari, 'config.json'), dizin.yol('config.json'));
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);
    let htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).not.toContain('outside-secret');
    expect(htmlMetni).toContain('<dt>Base URL</dt><dd><code>unknown</code></dd>');

    await rm(dizin.yol('config.json'));
    await link(join(disari, 'config.json'), dizin.yol('config.json'));
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);
    htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).not.toContain('outside-secret');
  });

  it('(2) skips a hard-linked step screenshot even when the run record is intact', async () => {
    const { cwd, dizin } = await proje();
    await tekKosu(dizin);
    const disari = await mkdtemp(join(tmpdir(), 'kobay-report-pnglink-'));
    await link(join(dizin.yol('runs', 'r_20261005100000_aaaa'), 'step-0.png'), join(disari, 'other-name.png'));

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(0);
    const veri = (JSON.parse(sonuc.stdout) as { data: { tests: Array<{ verdict: string }>; screenshots: number } }).data;
    expect(veri.tests[0]?.verdict).toBe('passed');
    expect(veri.screenshots).toBe(1);
    expect(await dosyaListesi(join(dizin.kok, 'report'))).toEqual([
      'assets/r_20261005100000_aaaa/step-1.png',
      'index.html',
      'kobay-report.json',
    ]);
  });

  it('(3) the default is case-insensitive on macOS and Windows, case-sensitive elsewhere', () => {
    const kokler = [{ yol: '/Users/Alice/Project', yerTutucu: '[project]' }];
    const beklenen = process.platform === 'darwin' || process.platform === 'win32'
      ? 'at [project]/x.ts'
      : 'at /users/alice/project/x.ts';
    expect(yerelYollariGizle('at /users/alice/project/x.ts', kokler)).toBe(beklenen);
  });

  it.skipIf(windows)('human output prints the report path terminal-safe; the JSON envelope keeps it raw', async () => {
    const { cwd, dizin } = await proje();
    await tekKosu(dizin);
    const out = join(await mkdtemp(join(tmpdir(), 'kobay-report-ctl-')), 'out\n::warning::x');

    const insan = await calistir(['--cwd', cwd, 'test', 'report', '--all', '--out', out]);
    expect(insan.kod).toBe(0);
    expect(insan.stdout).not.toContain('\n::warning::');
    expect(insan.stdout).toContain('out\\u000a::warning::x');

    const json = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all', '--out', out]);
    expect((JSON.parse(json.stdout) as { data: { indexPath: string } }).data.indexPath).toBe(join(out, 'index.html'));
  });

  it('(9) the default folder names the foreign entry and suggests removing it or --out', async () => {
    const { cwd, dizin } = await proje();
    await tekKosu(dizin);
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);
    await writeFile(join(dizin.kok, 'report', '.DS_Store'), 'finder');

    const sonuc = await calistir(['--cwd', cwd, 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(2);
    expect(sonuc.stderr).toContain('unexpected entry ".DS_Store"');
    expect(sonuc.stderr).toContain('Remove that entry');
    expect(sonuc.stderr).toContain('pass --out <dir>');
    expect(sonuc.stderr).not.toContain('Choose an empty or new directory');
    await expect(readFile(join(dizin.kok, 'report', '.DS_Store'), 'utf8')).resolves.toBe('finder');
  });
});

describe('kobay test report — agent fix prompts', () => {
  it('puts the fix prompt through masking, path placeholders and HTML escaping, in HTML and in JSON', async () => {
    const { cwd, dizin } = await proje();
    const token = `ghp_${'Q7w8E9r0'.repeat(5)}`;
    await testKaydet(dizin, 't_aaaaaaaa', 'Prompt <b>bold</b>', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'failed', {
      adimlar: adimSonuclari(['passed', 'failed']),
      errorMessage: `<script>alert(1)</script> token=${token} at ${join(cwd, 'src', 'app.ts')}:3:1`,
    });

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(0);
    const htmlMetni = await raporHtmli(cwd);
    const kutu = htmlMetni.slice(htmlMetni.indexOf('id="prompt-t_aaaaaaaa"'), htmlMetni.indexOf('</pre>', htmlMetni.indexOf('id="prompt-t_aaaaaaaa"')));
    expect(kutu).toContain('Fix the kobay test t_aaaaaaaa.');
    expect(kutu).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(kutu).toContain('Test name: Prompt &lt;b&gt;bold&lt;/b&gt;');
    expect(kutu).toContain('[redacted]');
    expect(kutu).toContain(`[project]${join('/x', 'src', 'app.ts').slice(2)}`);
    expect(htmlMetni).not.toContain(token);
    expect(htmlMetni).not.toContain(cwd);

    const veri = (JSON.parse(sonuc.stdout) as { data: { fixPrompts: Array<{ id: string; prompt: string }>; fixAllPrompt?: string } }).data;
    expect(veri.fixPrompts.map((oge) => oge.id)).toEqual(['t_aaaaaaaa']);
    const json = veri.fixPrompts[0]?.prompt ?? '';
    expect(json).toContain('<script>alert(1)</script>');
    expect(json).toContain('[redacted]');
    expect(json).toContain('[project]');
    expect(json).not.toContain(token);
    expect(json).not.toContain(cwd);
    expect(veri.fixAllPrompt).toBeUndefined();
    expect(htmlMetni).not.toContain('id="prompt-all"');
  });

  it('adds one fix-all prompt above the cards when two or more tests need attention', async () => {
    const { cwd, dizin } = await proje();
    for (const [id, runId] of [['t_aaaaaaaa', 'r_20261005100000_aaaa'], ['t_bbbbbbbb', 'r_20261005100000_bbbb']] as const) {
      await testKaydet(dizin, id, `Failing ${id}`, IKI_ADIM, runId);
      await kosuKaydet(dizin, id, runId, 'failed', { adimlar: adimSonuclari(['passed', 'failed'], 'boom') });
    }

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    const htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).toContain('id="prompt-all"');
    expect(htmlMetni.indexOf('id="prompt-all"')).toBeLessThan(htmlMetni.indexOf('id="test-t_aaaaaaaa"'));
    expect(htmlMetni).toContain('Fix the 2 kobay tests that need attention');
    const veri = (JSON.parse(sonuc.stdout) as { data: { fixPrompts: unknown[]; fixAllPrompt?: string } }).data;
    expect(veri.fixPrompts).toHaveLength(2);
    expect(veri.fixAllPrompt).toContain('t_bbbbbbbb');
  });

  it('shows no prompt when nothing needs attention', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'Green', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'passed', { adimlar: adimSonuclari(['passed', 'passed']) });
    await testKaydet(dizin, 't_bbbbbbbb', 'Never ran', IKI_ADIM);

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    const htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).not.toContain('Fix with your coding agent');
    expect(htmlMetni).not.toContain('class="istem"');
    expect(htmlMetni).toContain('The test passed');
    const veri = (JSON.parse(sonuc.stdout) as { data: Record<string, unknown> }).data;
    expect(veri).not.toHaveProperty('fixPrompts');
    expect(veri).not.toHaveProperty('fixAllPrompt');
  });
});

describe('kobay test report — prompt frame and JSON cleaning', () => {
  /** HTML kutusundaki istemi kaçış öncesi metne çevirir. */
  function kutudakiIstem(htmlMetni: string, kimlik: string): string {
    const bas = htmlMetni.indexOf(`id="${kimlik}" tabindex="0">`);
    const ham = htmlMetni.slice(bas + `id="${kimlik}" tabindex="0">`.length, htmlMetni.indexOf('</pre>', bas));
    return ham.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
  }

  function cerceveSaglam(istem: string, sonBaslik: string): void {
    const satirlar = istem.split('\n');
    const acilislar = satirlar.filter((satir) => /^`{3,}text$/.test(satir));
    expect(acilislar, istem).toHaveLength(1);
    const cit = (acilislar[0] ?? '').replace(/text$/, '');
    const kapanis = satirlar.indexOf(cit);
    expect(satirlar.filter((satir) => satir === cit), istem).toHaveLength(1);
    expect(satirlar.slice(kapanis + 1).join('\n')).toContain(`\n${sonBaslik}\n1. `);
  }

  it('a secret-looking tail in the error never eats the fence or the steps, in HTML and JSON, single and fix-all', async () => {
    const { cwd, dizin } = await proje();
    const hatalar = ['Login failed. Invalid password:', 'Request rejected. Missing token:', 'Body sent: {"password": "'];
    for (const [sira, hata] of hatalar.entries()) {
      const id = `t_aaaaaaa${sira}`;
      const runId = `r_2026100510000${sira}_aaaa`;
      await testKaydet(dizin, id, `Case ${sira}`, IKI_ADIM, runId);
      await kosuKaydet(dizin, id, runId, 'failed', { adimlar: adimSonuclari(['passed', 'failed']), errorMessage: hata });
    }

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(0);
    const veri = (JSON.parse(sonuc.stdout) as { data: { fixPrompts: Array<{ id: string; prompt: string }>; fixAllPrompt: string } }).data;
    const htmlMetni = await raporHtmli(cwd);
    for (const { id, prompt } of veri.fixPrompts) {
      cerceveSaglam(prompt, 'What to do:');
      expect(kutudakiIstem(htmlMetni, `prompt-${id}`)).toBe(prompt);
      expect(prompt).toContain('If the test still fails after two fix attempts');
    }
    cerceveSaglam(veri.fixAllPrompt, 'For each test:');
    expect(kutudakiIstem(htmlMetni, 'prompt-all')).toBe(veri.fixAllPrompt);
    for (const sira of [0, 1, 2]) expect(veri.fixAllPrompt).toContain(`[t_aaaaaaa${sira}]\nApp URL: `);
  });

  it('masks secrets in JSON test names and in the fix-all prompt', async () => {
    const { cwd, dizin } = await proje();
    process.env.KOBAY_REPORT_NAME_SECRET = 'name-secret-value-123';
    try {
      for (const [id, runId] of [['t_aaaaaaaa', 'r_20261005100000_aaaa'], ['t_bbbbbbbb', 'r_20261005100000_bbbb']] as const) {
        await testKaydet(dizin, id, `Uses name-secret-value-123 in ${cwd}`, IKI_ADIM, runId);
        await kosuKaydet(dizin, id, runId, 'failed', { adimlar: adimSonuclari(['passed', 'failed'], 'boom') });
      }
      const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);
      expect(sonuc.stdout).not.toContain('name-secret-value-123');
      const veri = (JSON.parse(sonuc.stdout) as { data: { tests: Array<{ name: string }>; fixAllPrompt: string } }).data;
      // reportDir/indexPath mutlak yol taşır (beklenen); ad ve istemde proje yolu yok.
      expect(JSON.stringify(veri.tests)).not.toContain(cwd);
      expect(veri.fixAllPrompt).not.toContain(cwd);
      expect(veri.tests[0]?.name).toBe('Uses [redacted] in [project]');
      expect(veri.fixAllPrompt).toContain('Test name: Uses [redacted] in [project]');
    } finally {
      delete process.env.KOBAY_REPORT_NAME_SECRET;
    }
  });

  it('shows readable UTC times and keeps the full ISO value in datetime', async () => {
    const { cwd, dizin } = await proje();
    await testKaydet(dizin, 't_aaaaaaaa', 'Times', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'failed', { adimlar: adimSonuclari(['passed', 'failed']) });
    expect((await calistir(['--cwd', cwd, 'test', 'report', '--all'])).kod).toBe(0);
    const htmlMetni = await raporHtmli(cwd);
    expect(htmlMetni).toContain('<time datetime="2026-10-05T10:00:00.000Z" title="2026-10-05T10:00:00.000Z">2026-10-05 10:00 UTC</time>');
    expect(htmlMetni).toMatch(/<dt>Generated<\/dt><dd class="veri"><time datetime="[^"]+" title="[^"]+">\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/time>/);
  });
});

describe('kobay test report — base URL credentials', () => {
  it('never shows user:password from the base URL, in HTML or in the JSON prompts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kobay-report-userinfo-'));
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://admin:Hunter2Pass@localhost:3000', brain: { adaptor: 'sahte' } });
    await testKaydet(dizin, 't_aaaaaaaa', 'Creds', IKI_ADIM, 'r_20261005100000_aaaa');
    await kosuKaydet(dizin, 't_aaaaaaaa', 'r_20261005100000_aaaa', 'failed', { adimlar: adimSonuclari(['passed', 'failed'], 'boom') });

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'test', 'report', '--all']);

    expect(sonuc.kod).toBe(0);
    const htmlMetni = await raporHtmli(cwd);
    for (const metin of [htmlMetni, sonuc.stdout]) {
      expect(metin).not.toContain('Hunter2Pass');
      expect(metin).not.toContain('admin:');
    }
    expect(htmlMetni).toContain('<dt>Base URL</dt><dd><code>http://[redacted]@localhost:3000</code></dd>');
    expect(sonuc.stdout).toContain('App URL: http://[redacted]@localhost:3000');
  });

  it('keeps a plain address as it is and hides anything unparseable that holds credentials', () => {
    expect(adresKimligiGizle('http://localhost:3000')).toBe('http://localhost:3000');
    expect(adresKimligiGizle('https://user@app.test/x?y=1')).toBe('https://[redacted]@app.test/x?y=1');
    expect(adresKimligiGizle('not a url with user:pass@host')).toBe('[redacted]');
    expect(adresKimligiGizle('not a url')).toBe('not a url');
    expect(adresKimligiGizle('http://admin:Hunter2Pass@localhost:3000')).toBe('http://[redacted]@localhost:3000');
  });

  it('masks userinfo of every address inside free text and leaves the rest alone', () => {
    const metin = 'open http://admin:Hunter2Pass@a.test:3000/x?y=1 then https://b.test/ok and wss://u:p@c.test, done';
    expect(metindekiKimligiGizle(metin))
      .toBe('open http://[redacted]@a.test:3000/x?y=1 then https://b.test/ok and wss://[redacted]@c.test, done');
    expect(metindekiKimligiGizle('no address here: a@b.test')).toBe('no address here: a@b.test');
    // Bilinen sınır: kullanıcı bilgisinde boşluk varsa maskelenmez (düz metindeki e-postayı yutmamak için).
    expect(metindekiKimligiGizle('see http://u name:p@host/x')).toBe('see http://u name:p@host/x');
    expect(metindekiKimligiGizle('http://backend.test failed; contact ops@example.com'))
      .toBe('http://backend.test failed; contact ops@example.com');
    const kacisli = JSON.stringify({ message: 'bad http://u"v:p@host/x' });
    expect(metindekiKimligiGizle(kacisli)).toBe('{"message":"bad http://[redacted]@host/x"}');
  });

  it('treats non-http(s) or schemeless values as unparsed: credentials hidden, plain values kept', () => {
    expect(adresKimligiGizle('admin:Hunter2Pass@localhost:3000')).toBe('[redacted]');
    expect(adresKimligiGizle('localhost:3000')).toBe('localhost:3000');
    expect(adresKimligiGizle('mailto:admin@example.com')).toBe('[redacted]');
    expect(adresKimligiGizle('ftp://user:pw@files.test/x')).toBe('[redacted]');
    expect(adresKimligiGizle('ftp://files.test/x')).toBe('ftp://files.test/x');
  });
});
