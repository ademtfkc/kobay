import { spawn } from 'node:child_process';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, expect, it, type TestContext } from 'vitest';
import { KobayDizini, type PlanAdimi, type TestKaydi } from '../../src/depo/index.js';
import { kostur } from '../../src/kos/index.js';
import { baslat } from '../kobay-demo/sunucu.mjs';

// A worker stuck in a busy loop ignores SIGTERM (Playwright workers do) and never closes its Chromium,
// so only a process-tree kill can clean up. POSIX only: Windows uses taskkill /T /F.
const playwrightYolu = createRequire(import.meta.url).resolve('@playwright/test');
const depoKoku = resolve(import.meta.dirname, '../..');
const posix = process.platform !== 'win32';

let tarayiciEngeli: unknown;
let demo: { url: string; kapat: () => Promise<void> } | undefined;
const temizlenecek: number[] = [];
// SIGKILL ile öldürülen Chromium kendi profil klasörünü silemez; yolunu betik kaydeder, afterAll siler.
const profiller: string[] = [];

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
    demo = await baslat(0);
  } catch (hata) {
    tarayiciEngeli = hata;
  }
});

afterAll(async () => {
  await demo?.kapat();
  for (const pid of temizlenecek) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* zaten ölü */ }
  }
  await new Promise<void>((coz) => { setTimeout(coz, 300); });
  for (const yol of profiller) await rm(yol, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

function mumkun(context: TestContext): boolean {
  if (!posix) { context.skip('POSIX process-tree kill'); return false; }
  if (tarayiciEngeli === undefined) return true;
  context.skip(`Chromium engelli: ${String(tarayiciEngeli).split('\n')[0] ?? ''}`);
  return false;
}

function testKaydi(id: string): TestKaydi {
  const planSteps: PlanAdimi[] = [{ type: 'action', description: 'Hang the worker' }];
  return {
    id, name: 'kills a hung worker tree', type: 'frontend', createdFrom: 'cli',
    status: 'ready', planSteps, priority: 'p1', codeVersion: 1,
    createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
  };
}

function askiKod(pidYolu: string): string {
  return `import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from ${JSON.stringify(playwrightYolu)};
import { test } from './_fixture';

test('hangs the worker in a busy loop', async ({ page }) => {
  test.setTimeout(0);
  await page.goto('data:text/html,<title>hang</title>');
  const server = await chromium.launchServer({ headless: true });
  // Hem launchServer'ın hem de fixture tarayıcısının (worker'ın çocuğu) profil klasörleri: SIGKILL'den sonra kalırlar.
  const profilArgs = [server.process().spawnargs.find((arg) => arg.startsWith('--user-data-dir='))];
  for (const satir of execFileSync('ps', ['-axo', 'ppid=,command='], { encoding: 'utf8' }).split('\\n')) {
    if (satir.trim().startsWith(String(process.pid) + ' ')) profilArgs.push(/--user-data-dir=(\\S+)/.exec(satir)?.[0]);
  }
  const profilDizinleri = profilArgs.filter((arg) => arg !== undefined).map((arg) => arg.slice('--user-data-dir='.length));
  writeFileSync(${JSON.stringify(pidYolu)}, JSON.stringify({
    workerPid: process.pid, chromiumPid: server.process().pid, profilDizinleri,
  }));
  for (;;) { /* blocks the event loop: no IPC, no signal handler */ }
});
`;
}

async function pidKaydiBekle(yol: string): Promise<{ workerPid: number; chromiumPid: number }> {
  for (let deneme = 0; deneme < 300; deneme += 1) {
    try {
      const kayit = JSON.parse(await readFile(yol, 'utf8')) as Partial<{ workerPid: number; chromiumPid: number; profilDizinleri: string[] }>;
      if (Number.isInteger(kayit.workerPid) && Number.isInteger(kayit.chromiumPid)) {
        temizlenecek.push(kayit.workerPid!, kayit.chromiumPid!);
        if (Array.isArray(kayit.profilDizinleri)) profiller.push(...kayit.profilDizinleri);
        return { workerPid: kayit.workerPid!, chromiumPid: kayit.chromiumPid! };
      }
    } catch { /* dosya henüz yok ya da yarım yazıldı */ }
    await new Promise<void>((coz) => { setTimeout(coz, 100); });
  }
  throw new Error('worker/Chromium PID record never appeared');
}

async function pidOlduMu(pid: number, sureMs: number): Promise<boolean> {
  for (let deneme = 0; deneme < sureMs / 100; deneme += 1) {
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

async function hazirla(id: string): Promise<{ kok: string; dizin: KobayDizini; test: TestKaydi; pidYolu: string }> {
  const kok = await geciciDizinAc('kobay-asili-worker-');
  const dizin = await KobayDizini.ac(kok, { baseUrl: demo!.url, beyin: { adaptor: 'sahte' } });
  const test = testKaydi(id);
  const pidYolu = join(kok, 'child-pids.json');
  await Promise.all([dizin.testYaz(test), dizin.kodYaz(test.id, askiKod(pidYolu))]);
  return { kok, dizin, test, pidYolu };
}

it('timeout kills a hung worker and its Chromium (SIGTERM is ignored, SIGKILL escalation)', async (context) => {
  if (!mumkun(context) || demo === undefined) return;
  const { dizin, test, pidYolu } = await hazirla('t_0b3a0002');

  const { sonuc } = await kostur(dizin, test, { baseUrl: demo.url, testZamanAsimiMs: 5_000 });
  const pids = await pidKaydiBekle(pidYolu);
  expect(sonuc).toMatchObject({ verdict: 'failed', errorMessage: 'Run timed out' });
  expect(await pidOlduMu(pids.workerPid, 5_000)).toBe(true);
  expect(await pidOlduMu(pids.chromiumPid, 5_000)).toBe(true);
}, 60_000);

it('kills the worker tree when kobay itself receives SIGTERM', async (context) => {
  if (!mumkun(context) || demo === undefined) return;
  const { kok, test, pidYolu } = await hazirla('t_0b3a0003');
  const betik = join(kok, 'kobay-standin.mjs');
  const src = (ad: string): string => pathToFileURL(join(depoKoku, 'src', ad)).href;
  await writeFile(betik, `import { KobayDizini } from ${JSON.stringify(src('depo/index.ts'))};
import { kostur } from ${JSON.stringify(src('kos/index.ts'))};
const dizin = await KobayDizini.ac(${JSON.stringify(kok)}, { baseUrl: ${JSON.stringify(demo.url)}, beyin: { adaptor: 'sahte' } });
const test = ${JSON.stringify(test)};
await kostur(dizin, test, { baseUrl: ${JSON.stringify(demo.url)}, testZamanAsimiMs: 120_000 });
`);
  const kobay = spawn(process.execPath, ['--import', 'tsx', betik], { cwd: depoKoku, stdio: 'ignore' });
  temizlenecek.push(kobay.pid!);
  const kapandi = new Promise<void>((coz) => { kobay.once('close', () => { coz(); }); });

  const pids = await pidKaydiBekle(pidYolu);
  kobay.kill('SIGTERM');
  await kapandi;
  expect(await pidOlduMu(pids.workerPid, 5_000)).toBe(true);
  expect(await pidOlduMu(pids.chromiumPid, 5_000)).toBe(true);
}, 60_000);
