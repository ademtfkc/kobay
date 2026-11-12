import { appendFileSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { chromium } from '@playwright/test';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { beyinOlustur, beyinSinirlari } from '../../src/beyin/index.js';
import { testRun } from '../../src/cli/komutlar/index.js';
import { KobayDizini, type TestKaydi } from '../../src/depo/index.js';
import { baslat } from '../kobay-demo/sunucu.mjs';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * 0.9.1: toplam tavan bir çağrıyı başlamadan reddedince `test run` o koşuda beyni bir daha
 * denemez — defter sonradan izin verse bile. Bunu yalnız sayaç kanıtlayabilir: defterin tek
 * başına çağrıyı başlatacağı bir an kurulur.
 *
 * Sıra (deterministik): bu süreçte başka bir çağrı (B0) $1 ayırıp bekler; toplam $1.5, kalan $0.5.
 * A'nın kod üretimi bu yüzden çağrıdan önce reddedilir. A'nın günlüğü düşünce B0 $0 ile biter;
 * defterde $1.5 boş kalır. B'nin testi B0 bitene dek bekler (dosya işareti), sonra geçer. C'nin
 * kod üretimi artık deftere sığardı; `claude` başlatılmamalı.
 */

const ORIJINAL_PATH = process.env.PATH;
let sayac = '';
let tarayiciEngeli: unknown;
let demo: { url: string; kapat: () => Promise<void> } | undefined;

beforeAll(async () => {
  const dizin = await geciciDizinAc('kobay-kisa-devre-cli-');
  sayac = join(dizin, 'cagrilar.txt');
  appendFileSync(sayac, '');
  await writeFile(join(dizin, 'claude'), `#!/usr/bin/env node
import { appendFileSync, readdirSync } from 'node:fs';
appendFileSync(${JSON.stringify(sayac)}, 'cagri\\n');
const klasor = process.env.T_BEKLE_KLASORU;
const onek = process.env.T_BEKLE_ONEK;
const bekle = (ms) => new Promise((coz) => setTimeout(coz, ms));
process.stdin.resume();
process.stdin.on('end', async () => {
  if (klasor !== undefined && onek !== undefined) {
    for (;;) {
      let adlar = [];
      try { adlar = readdirSync(klasor); } catch {}
      if (adlar.some((ad) => ad.startsWith(onek))) break;
      await bekle(20);
    }
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, result: '{"tamam":true}' }));
});
`);
  await chmod(join(dizin, 'claude'), 0o755);
  if (process.platform === 'win32') await writeFile(join(dizin, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude" %*\r\n');
  process.env.PATH = ORIJINAL_PATH === undefined ? dizin : `${dizin}${delimiter}${ORIJINAL_PATH}`;

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
  delete process.env.T_BEKLE_KLASORU;
  delete process.env.T_BEKLE_ONEK;
  await demo?.kapat();
});

function playwrightMumkun(context: TestContext): boolean {
  if (tarayiciEngeli === undefined) return true;
  if (process.env.KOBAY_CHROMIUM_TEST === '1') throw tarayiciEngeli;
  context.skip(`Chromium engelli: ${String(tarayiciEngeli).split('\n')[0] ?? ''}`);
  return false;
}

async function cagriSayisi(): Promise<number> {
  return (await readFile(sayac, 'utf8')).split('\n').filter((satir) => satir !== '').length;
}

function kayit(id: string, status: TestKaydi['status']): TestKaydi {
  return {
    id, name: `test ${id}`, type: 'frontend', createdFrom: 'cli', status,
    planSteps: [{ type: 'action', description: 'Open the login page' }, { type: 'assertion', description: 'See the heading' }],
    priority: 'p1', codeVersion: status === 'draft' ? 0 : 1,
    createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
  };
}

const A = 't_kisaa111';
const B = 't_kisab222';
const C = 't_kisac333';

describe('test run stops calling the brain after a total-limit refusal (0.9.1)', () => {
  it('a later test is not sent to claude even when the ledger would allow the call again', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const cwd = await geciciDizinAc('kobay-kisa-devre-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: demo.url, brain: { adaptor: 'claude' } });
    await dizin.haritaYaz({
      baseUrl: demo.url, loggedIn: false,
      pages: [{ url: `${demo.url}/login`, title: 'Login', headings: ['Login'], links: [], forms: [], buttons: [], menu: [] }],
      exploredAt: '2026-11-13T00:00:00.000Z',
    });
    const isaret = join(cwd, 'b0-bitti');
    await dizin.testYaz(kayit(A, 'draft'));
    await dizin.testYaz(kayit(B, 'ready'));
    await dizin.kodYaz(B, `import { existsSync } from 'node:fs';
import { test, expect } from './_fixture';
test('waits for the other call, then sees the login heading', async ({ page }) => {
  await test.step('0: Open the login page', async () => {
    await expect.poll(() => existsSync(${JSON.stringify(isaret)}), { timeout: 30000 }).toBe(true);
    await page.goto('${demo.url}/login');
  });
  await test.step('1: See the login heading', async () => {
    await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible({ timeout: 5000 });
  });
});
`);
    await dizin.testYaz(kayit(C, 'draft'));

    // B0: bu süreçte $1 ayırıp A'nın günlüğünü bekleyen çağrı.
    process.env.T_BEKLE_KLASORU = join(cwd, '.kobay', 'logs');
    process.env.T_BEKLE_ONEK = `brain-generate-${A}-`;
    const b0 = beyinOlustur({ adaptor: 'claude', maxBudgetUsd: 1, maxTotalCostUsd: 1.5 }, process.env)
      .sor({ gorev: 'b0', sistem: 'S', kullanici: 'K', sema: v.object({ tamam: v.boolean() }) })
      .then(async (yanit) => { await writeFile(isaret, 'tamam'); return yanit; });
    while (await cagriSayisi() < 1) await new Promise((coz) => setTimeout(coz, 20));
    delete process.env.T_BEKLE_KLASORU;
    delete process.env.T_BEKLE_ONEK;

    const kosu = await testRun({ cwd, all: true });
    await b0;
    const satirlar = kosu.json as Array<Record<string, unknown>>;
    expect(satirlar.map((s) => [s.id, s.verdict])).toEqual([[A, 'inconclusive'], [B, 'passed'], [C, 'inconclusive']]);
    expect((satirlar[0]?.error as { message: string }).message).toContain('Cost limit reached:');
    expect(satirlar[2]).toMatchObject({ notRun: true });

    // Defter C'nin çağrısını başlatırdı ($1.5 boş, çağrı $1 ayırır) …
    const sinir = beyinSinirlari(process.env);
    expect(sinir?.toplamSinirUsd).toBe(1.5);
    expect(sinir?.harcananUsd).toBe(0);
    // … ama koşu, toplam tavan reddinden sonra beyni bir daha denemedi: tek `claude` süreci B0.
    expect(await cagriSayisi()).toBe(1);
    expect(kosu.mesaj).toContain(`2 tests did not run because the total cost limit was reached: ${A} ${C}`);
  });
});
