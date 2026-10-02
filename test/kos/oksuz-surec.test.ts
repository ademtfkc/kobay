import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, expect, it, type TestContext } from 'vitest';
import { KobayDizini, type PlanAdimi, type TestKaydi } from '../../src/depo/index.js';
import { kostur } from '../../src/kos/index.js';
import { baslat } from '../kobay-demo/sunucu.mjs';

// The generated spec lives in a temp workspace, so it needs an absolute path to this repo's Playwright.
const playwrightYolu = createRequire(import.meta.url).resolve('@playwright/test');

let tarayiciEngeli: unknown;
let demo: { url: string; kapat: () => Promise<void> } | undefined;

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
    demo = await baslat(0);
  } catch (hata) {
    tarayiciEngeli = hata;
  }
});

afterAll(async () => { await demo?.kapat(); });

function playwrightMumkun(context: TestContext): boolean {
  if (tarayiciEngeli === undefined) return true;
  context.skip(`Chromium engelli: ${String(tarayiciEngeli).split('\n')[0] ?? ''}`);
  return false;
}

function testKaydi(): TestKaydi {
  const planSteps: PlanAdimi[] = [{ type: 'action', description: 'Keep the browser open' }];
  return {
    id: 't_0b3a0001', name: 'terminates timed out process descendants', type: 'frontend', createdFrom: 'cli',
    status: 'ready', planSteps, priority: 'p1', codeVersion: 1,
    createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
  };
}

async function pidKaydiBekle(yol: string): Promise<{ workerPid: number; chromiumPid: number }> {
  let sonHata: unknown;
  for (let deneme = 0; deneme < 100; deneme += 1) {
    try {
      const kayit = JSON.parse(await readFile(yol, 'utf8')) as Partial<{ workerPid: number; chromiumPid: number }>;
      if (Number.isInteger(kayit.workerPid) && Number.isInteger(kayit.chromiumPid)) {
        return { workerPid: kayit.workerPid, chromiumPid: kayit.chromiumPid };
      }
    } catch (hata) {
      sonHata = hata;
    }
    await new Promise<void>((coz) => { setTimeout(coz, 100); });
  }
  throw new Error(`Playwright worker ve Chromium PID kaydı oluşmadı: ${String(sonHata)}`);
}

async function pidSonlansin(pid: number): Promise<boolean> {
  for (let deneme = 0; deneme < 100; deneme += 1) {
    try {
      process.kill(pid, 0);
    } catch (hata: unknown) {
      if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ESRCH') return true;
      throw hata;
    }
    await new Promise<void>((coz) => { setTimeout(coz, 100); });
  }
  return false;
}

it('zaman aşımı Playwright worker ile Chromium alt sürecini öksüz bırakmaz', async (context) => {
  if (!playwrightMumkun(context) || demo === undefined) return;
  const kok = await mkdtemp(join(tmpdir(), 'kobay-oksuz-surec-'));
  const dizin = await KobayDizini.ac(kok, { baseUrl: demo.url, beyin: { adaptor: 'sahte' } });
  const test = testKaydi();
  const pidYolu = join(kok, 'child-pids.json');
  const kod = `import { writeFileSync } from 'node:fs';
import { chromium } from ${JSON.stringify(playwrightYolu)};
import { test } from './_fixture';

test('keeps child processes alive until kobay terminates the run', async ({ page }) => {
  test.setTimeout(0);
  await page.goto('data:text/html,<title>timeout</title>');
  const server = await chromium.launchServer({ headless: true });
  writeFileSync(${JSON.stringify(pidYolu)}, JSON.stringify({ workerPid: process.pid, chromiumPid: server.process().pid }));
  await new Promise<void>(() => {});
});
`;
  await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, kod)]);

  const { sonuc } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 5_000 });
  const pids = await pidKaydiBekle(pidYolu);
  expect(sonuc).toMatchObject({ verdict: 'failed', errorMessage: 'Run timed out' });
  await expect(pidSonlansin(pids.workerPid)).resolves.toBe(true);
  await expect(pidSonlansin(pids.chromiumPid)).resolves.toBe(true);
}, 50_000);
