import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { KobayDizini, type TestKaydi, type Verdict } from '../../src/depo/index.js';
import { OZET_ISARETI } from '../../src/rapor/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

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
  const cwd = await geciciDizinAc('kobay-ozet-');
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://localhost:3000', brain: { adaptor: 'sahte' } });
  return { cwd, dizin };
}

async function testVeKosu(
  dizin: KobayDizini,
  no: number,
  verdict: Verdict,
  secenek: { ad?: string; errorMessage?: string } = {},
): Promise<TestKaydi> {
  const id = `t_bbbbbb${String(no).padStart(2, '0')}`;
  const runId = `r_20261007100000_bb${String(no).padStart(2, '0')}`;
  const test: TestKaydi = {
    id,
    name: secenek.ad ?? `Checkout step ${no}`,
    type: 'frontend',
    createdFrom: 'cli',
    status: 'ready',
    planSteps: [{ type: 'action', description: 'Open the cart' }],
    priority: 'p1',
    codeVersion: 1,
    lastRunId: runId,
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
  };
  await dizin.testYaz(test);
  await dizin.kosuDizini(runId);
  await dizin.kosuSonucuYaz({
    testId: id,
    runId,
    status: verdict === 'passed' ? 'passed' : 'failed',
    verdict,
    startedAt: '2026-10-07T10:00:00.000Z',
    finishedAt: '2026-10-07T10:00:02.000Z',
    codeVersion: 1,
    ...(verdict === 'failed' ? { failedStepIndex: 0, failureKind: 'unknown' as const } : {}),
    ...(secenek.errorMessage === undefined ? {} : { errorMessage: secenek.errorMessage }),
  });
  return test;
}

describe('kobay test report --summary', () => {
  it('writes the Markdown summary next to the HTML report and returns summaryPath; secrets in names and errors are masked', async () => {
    const { cwd, dizin } = await proje();
    await testVeKosu(dizin, 1, 'passed');
    await testVeKosu(dizin, 2, 'failed', { ad: 'Pay with password: hunter22', errorMessage: 'POST failed: {"password": "s3cretValue9"}' });
    await testVeKosu(dizin, 3, 'failed');
    const ozet = join(await geciciDizinAc('kobay-ozet-cikti-'), 'alt', 'kobay-summary.md');

    const sonuc = await calistir(['test', 'report', '--all', '--summary', ozet, '--output', 'json', '--cwd', cwd]);
    expect(sonuc.kod, sonuc.stdout + sonuc.stderr).toBe(0);
    const zarf = JSON.parse(sonuc.stdout) as { ok: boolean; data: { summaryPath: string; indexPath: string; counts: { failed: number } } };
    expect(zarf.ok).toBe(true);
    expect(zarf.data.summaryPath).toBe(ozet);
    expect(zarf.data.counts.failed).toBe(2);
    // HTML rapor yine üretildi.
    await expect(access(zarf.data.indexPath)).resolves.toBeUndefined();

    const md = await readFile(ozet, 'utf8');
    expect(md.split('\n')[0]).toBe(OZET_ISARETI);
    expect(md).toContain('| 1 | 2 | 0 | 0 | 0 |');
    expect(md).toContain('Fix all 2 tests that need attention');
    expect(md).not.toContain('hunter22');
    expect(md).not.toContain('s3cretValue9');
    expect(md).toContain('[redacted]');
    // Yalnız metin: ekran görüntüsü yolu, mutlak proje yolu yok.
    expect(md).not.toContain(cwd);
    expect(md).not.toMatch(/\.png/);
    // Rapor klasörüne yabancı dosya girmedi (bir sonraki rapor reddetmesin).
    expect((await readdir(join(cwd, '.kobay', 'report'))).sort()).toEqual(['index.html', 'kobay-report.json']);
  });

  it('hides absolute paths of the kobay installation (stack frames) and of the project behind placeholders', async () => {
    const { cwd, dizin } = await proje();
    const kobayKoku = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]+$/, '');
    await testVeKosu(dizin, 1, 'failed', {
      errorMessage: `Error: expect failed\n    at ${join(cwd, '.kobay', 'tests', 't_bbbbbb01.spec.ts')}:7:72\n`
        + `    at ${join(kobayKoku, 'dist', 'kos', 'fixture.js')}:43:30`,
    });
    const ozet = join(await geciciDizinAc('kobay-ozet-cikti-'), 'ozet.md');
    expect((await calistir(['test', 'report', '--all', '--summary', ozet, '--cwd', cwd])).kod).toBe(0);
    const md = await readFile(ozet, 'utf8');
    expect(md).toContain(`at [kobay]${sep}dist${sep}kos${sep}fixture.js:43:30`);
    expect(md).toContain(`at [project]${sep}.kobay${sep}tests${sep}t_bbbbbb01.spec.ts:7:72`);
    expect(md).not.toContain(kobayKoku);
    expect(md).not.toContain(cwd);
  });

  it('hides credentials in free-text URLs and absolute paths outside the known roots, in the summary and the JSON prompts', async () => {
    const { cwd, dizin } = await proje();
    await testVeKosu(dizin, 1, 'failed', {
      ad: 'Sync with http://bob:NamePass77@example.test',
      errorMessage: 'GET http://alice:S3cretPass@example.test/x failed\n    at /opt/private/file.js:3:9\n'
        + '    at (C:\\Builds\\agent\\x.ts:1:2)\nExpected URL /records/new',
    });
    const ozet = join(await geciciDizinAc('kobay-ozet-cikti-'), 'ozet.md');
    const sonuc = await calistir(['test', 'report', '--all', '--summary', ozet, '--output', 'json', '--cwd', cwd]);
    expect(sonuc.kod).toBe(0);
    const md = await readFile(ozet, 'utf8');
    for (const metin of [md, sonuc.stdout]) {
      expect(metin).not.toContain('S3cretPass');
      expect(metin).not.toContain('NamePass77');
      expect(metin).not.toContain('alice');
      expect(metin).not.toContain('/opt/private');
      expect(metin).not.toMatch(/Builds/);
    }
    expect(md).toContain('http://[redacted]@example.test/x');
    expect(md).toContain('at [path]/file.js:3:9');
    expect(md).toContain('[path]/x.ts:1:2');
    // Uygulama rotası dosya yolu sayılmaz.
    expect(md).toContain('Expected URL /records/new');
  });

  it('--max-prompts limits the prompts; text output names the summary file', async () => {
    const { cwd, dizin } = await proje();
    for (const no of [1, 2, 3]) await testVeKosu(dizin, no, 'failed');
    const ozet = join(await geciciDizinAc('kobay-ozet-cikti-'), 'ozet.md');

    const sonuc = await calistir(['test', 'report', '--all', '--summary', ozet, '--max-prompts', '1', '--cwd', cwd]);
    expect(sonuc.kod, sonuc.stderr).toBe(0);
    expect(sonuc.stdout).toContain(`Summary written: ${ozet}`);
    const md = await readFile(ozet, 'utf8');
    expect(md.match(/Fix with your coding agent — /g)).toHaveLength(1);
    expect(md).toContain('2 more failing tests — see the report artifact.');
  });

  it('refuses summary paths under .git/, .claude/, .kobay/ (the report folder too) and inside --out with exit 2, before writing anything', async () => {
    const { cwd, dizin } = await proje();
    await testVeKosu(dizin, 1, 'failed');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const disari = await geciciDizinAc('kobay-ozet-out-');
    const reddedilenler: Array<string[]> = [
      ['--summary', join(cwd, '.git', 'summary.md')],
      ['--summary', '.git/hooks/pre-commit'],
      ['--summary', join(cwd, '.claude', 'summary.md')],
      ['--summary', join(cwd, '.kobay', 'summary.md')],
      ['--summary', join(cwd, '.kobay', 'report', 'summary.md')],
      ['--summary', join(cwd, '.kobay', 'report')],
      ['--summary', join(disari, 'rapor', 'summary.md'), '--out', join(disari, 'rapor')],
      ['--summary', cwd],
    ];
    for (const ek of reddedilenler) {
      const sonuc = await calistir(['test', 'report', '--all', ...ek, '--output', 'json', '--cwd', cwd]);
      expect(sonuc.kod, ek.join(' ')).toBe(2);
      expect(JSON.parse(sonuc.stdout)).toMatchObject({ ok: false, error: { code: 'UsageError' } });
    }
    await expect(access(join(cwd, '.git', 'summary.md'))).rejects.toThrow();
    await expect(access(join(cwd, '.kobay', 'report'))).rejects.toThrow();
    await expect(access(join(disari, 'rapor'))).rejects.toThrow();
  });

  it('--max-prompts without --summary and invalid numbers are usage errors', async () => {
    const { cwd, dizin } = await proje();
    await testVeKosu(dizin, 1, 'passed');
    expect((await calistir(['test', 'report', '--all', '--max-prompts', '2', '--cwd', cwd])).kod).toBe(2);
    expect((await calistir(['test', 'report', '--all', '--summary', join(cwd, 's.md'), '--max-prompts', '-1', '--cwd', cwd])).kod).toBe(2);
    expect((await calistir(['test', 'report', '--all', '--summary', join(cwd, 's.md'), '--max-prompts', 'x', '--cwd', cwd])).kod).toBe(2);
  });
});
