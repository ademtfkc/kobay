import { appendFileSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testList, testReport, testRun } from '../../src/cli/komutlar/index.js';
import { KobayDizini, type TestKaydi } from '../../src/depo/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * 0.9.1: `claude`'un kendi çağrı başı durdurması (`error_max_budget_usd`, KOBAY_MAX_BUDGET_USD) da
 * `cost_cap` hatasıdır ama toplam tavan değildir: yalnız o testi etkiler, döngü sürer.
 * Taze defter (bu dosyada önceden harcama yok): çağrı başı $1, toplam $5 (varsayılan). Her çağrı
 * $0.30 tutup çağrı sınırında durur; üç çağrı toplamın çok altında kalır.
 */

const ORIJINAL_PATH = process.env.PATH;
let sayac = '';

beforeAll(async () => {
  const dizin = await geciciDizinAc('kobay-cagri-siniri-cli-');
  sayac = join(dizin, 'cagrilar.txt');
  appendFileSync(sayac, '');
  await writeFile(join(dizin, 'claude'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(sayac)}, 'cagri\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.3, num_turns: 1 }));
});
`);
  await chmod(join(dizin, 'claude'), 0o755);
  if (process.platform === 'win32') await writeFile(join(dizin, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude" %*\r\n');
  process.env.PATH = ORIJINAL_PATH === undefined ? dizin : `${dizin}${delimiter}${ORIJINAL_PATH}`;
});

afterAll(() => {
  if (ORIJINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIJINAL_PATH;
});

async function cagriSayisi(): Promise<number> {
  return (await readFile(sayac, 'utf8')).split('\n').filter((satir) => satir !== '').length;
}

function taslak(id: string): TestKaydi {
  return {
    id, name: `test ${id}`, type: 'frontend', createdFrom: 'cli', status: 'draft',
    planSteps: [{ type: 'action', description: 'Open the login page' }, { type: 'assertion', description: 'See the heading' }],
    priority: 'p1', codeVersion: 0, createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
  };
}

const IDLER = ['t_cagria11', 't_cagrib22', 't_cagric33'];

describe('test run when claude stops at its per-call limit (0.9.1)', () => {
  it('only that test is affected: every test is still attempted, the text names the per-call limit, no total-limit summary', async () => {
    const cwd = await geciciDizinAc('kobay-cagri-siniri-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://127.0.0.1:9', brain: { adaptor: 'claude' } });
    await dizin.haritaYaz({
      baseUrl: 'http://127.0.0.1:9', loggedIn: false,
      pages: [{ url: 'http://127.0.0.1:9/login', title: 'Login', headings: ['Login'], links: [], forms: [], buttons: [], menu: [] }],
      exploredAt: '2026-11-13T00:00:00.000Z',
    });
    for (const id of IDLER) await dizin.testYaz(taslak(id));

    const kosu = await testRun({ cwd, all: true });
    expect(kosu.exitCode).toBe(4);
    // Döngü durmadı: her test için `claude` gerçekten başlatıldı.
    expect(await cagriSayisi()).toBe(3);
    const satirlar = kosu.json as Array<Record<string, unknown>>;
    expect(satirlar.map((s) => [s.id, s.verdict, s.notRun])).toEqual(IDLER.map((id) => [id, 'inconclusive', true]));
    for (const satir of satirlar) expect((satir.error as { message: string }).message).toContain('per-call limit');
    const metin = kosu.mesaj ?? '';
    for (const id of IDLER) expect(metin).toMatch(new RegExp(`^inconclusive ${id} — not run: .*per-call limit`, 'm'));
    expect(metin).not.toContain('total cost limit reached');
    expect(metin).not.toContain('did not run because the total cost limit was reached');
    expect(metin).not.toContain('Spent $');

    // Diskteki gerekçe de hangi sınır olduğunu söyler; durum ve rapor koşuyla aynı.
    const liste = await testList({ cwd });
    expect((liste.json as Array<{ status: string }>).map((t) => t.status)).toEqual(['draft', 'draft', 'draft']);
    const rapor = await testReport({ cwd, all: true, out: join(cwd, 'rapor') });
    const veri = rapor.json as { indexPath: string; counts: Record<string, number> };
    expect(veri.counts).toMatchObject({ inconclusive: 3, notRun: 0 });
    expect(await readFile(veri.indexPath, 'utf8')).toContain('per-call limit');
  });
});
