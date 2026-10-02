import {
  access, lutimes, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  KobayDizini,
  UnsafePrunePath,
  depoyuBuda,
  type KosuSonucu,
} from '../../src/depo/index.js';

async function proje(): Promise<KobayDizini> {
  return KobayDizini.ac(await mkdtemp(join(tmpdir(), 'kobay-prune-')), {
    baseUrl: 'http://localhost:3000',
    brain: { adaptor: 'sahte' },
  });
}

function runId(sira: number): string {
  return `r_2026010100${String(sira).padStart(4, '0')}_abcd`;
}

async function kosuYaz(
  dizin: KobayDizini,
  testId: string,
  sira: number,
  verdict: KosuSonucu['verdict'] = 'passed',
  payload = 0,
): Promise<string> {
  const id = runId(sira);
  await dizin.kosuSonucuYaz({
    testId,
    runId: id,
    status: verdict === 'failed' ? 'failed' : 'passed',
    verdict,
    startedAt: `2026-01-01T00:00:${String(sira).padStart(2, '0')}.000Z`,
    finishedAt: `2026-01-01T00:00:${String(sira).padStart(2, '0')}.500Z`,
    codeVersion: 1,
  });
  if (payload > 0) await writeFile(dizin.yol('runs', id, 'payload.bin'), Buffer.alloc(payload));
  return id;
}

const ESKI_AN = new Date('2026-01-01T00:00:00Z');

async function testVar(dizin: KobayDizini, testId: string): Promise<void> {
  await writeFile(dizin.yol('tests', `${testId}.json`), '{}');
}

describe('depo budama', () => {
  it('end-of-test pruning keeps the latest failed run even outside the newest five', async () => {
    const dizin = await proje();
    const testId = 't_abc12345';
    const ilk = await kosuYaz(dizin, testId, 40);
    const sonBasarisiz = await kosuYaz(dizin, testId, 41, 'failed');
    for (let sira = 42; sira < 47; sira += 1) await kosuYaz(dizin, testId, sira);

    const silinen = await dizin.kosulariBuda(testId);

    expect(silinen).toEqual([ilk]);
    await expect(access(dizin.yol('runs', sonBasarisiz))).resolves.toBeUndefined();
  });

  it('keeps the newest five, the latest failed run, and the failure bundle run', async () => {
    const dizin = await proje();
    const testId = 't_abc12345';
    await testVar(dizin, testId);
    const ilk = await kosuYaz(dizin, testId, 0, 'failed');
    const paketKosusu = await kosuYaz(dizin, testId, 1, 'passed');
    const sonBasarisiz = await kosuYaz(dizin, testId, 2, 'failed');
    const digerleri = [];
    for (let sira = 3; sira < 8; sira += 1) digerleri.push(await kosuYaz(dizin, testId, sira));
    await mkdir(dizin.yol('failure', testId));
    await writeFile(dizin.yol('failure', testId, 'failure.json'), JSON.stringify({ runId: paketKosusu }));

    const sonuc = await depoyuBuda(dizin);

    expect(sonuc.deleted.map((oge) => oge.path)).toEqual([`.kobay/runs/${ilk}`]);
    await expect(access(dizin.yol('runs', ilk))).rejects.toThrow();
    for (const id of [paketKosusu, sonBasarisiz, ...digerleri.slice(-5)]) {
      await expect(access(dizin.yol('runs', id))).resolves.toBeUndefined();
    }
  });

  it('removes old runs of a deleted test but keeps its latest failed run', async () => {
    const dizin = await proje();
    const eskiPassed = await kosuYaz(dizin, 't_old12345', 10);
    const eskiFailed = await kosuYaz(dizin, 't_old12345', 11, 'failed');

    const sonuc = await depoyuBuda(dizin, { olderThanDays: 1 });

    expect(sonuc.deleted.map((oge) => oge.path)).toEqual([`.kobay/runs/${eskiPassed}`]);
    await expect(access(dizin.yol('runs', eskiFailed))).resolves.toBeUndefined();
  });

  it('removes old brain logs, failure-out leftovers, and known root artifacts', async () => {
    const dizin = await proje();
    const eskiLog = dizin.yol('logs', 'brain-plan-1.log');
    const yeniLog = dizin.yol('logs', 'brain-plan-2.log');
    await Promise.all([
      writeFile(eskiLog, 'old'),
      writeFile(yeniLog, 'new'),
      writeFile(dizin.yol('failure-out', 'trace.zip'), 'legacy-flat'),
      writeFile(dizin.yol('trace.zip'), 'legacy-root'),
      writeFile(dizin.yol('user-note.txt'), 'keep'),
      mkdir(dizin.yol('failure-out', 't_abc12345-2')),
      mkdir(dizin.yol('failure-out', 't_abc12345')),
    ]);
    await writeFile(dizin.yol('failure-out', 't_abc12345-2', 'failure.json'), 'legacy-bundle');
    await utimes(eskiLog, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await utimes(dizin.yol('failure-out', 'trace.zip'), ESKI_AN, ESKI_AN);

    const sonuc = await depoyuBuda(dizin, { olderThanDays: 1 });

    expect(sonuc.deleted.map((oge) => [oge.path, oge.kind])).toEqual([
      ['.kobay/failure-out/t_abc12345-2', 'legacy-failure-bundle'],
      ['.kobay/failure-out/trace.zip', 'legacy-failure-file'],
      ['.kobay/logs/brain-plan-1.log', 'brain-log'],
      ['.kobay/trace.zip', 'legacy-root-file'],
    ]);
    await expect(readFile(yeniLog, 'utf8')).resolves.toBe('new');
    await expect(readFile(dizin.yol('user-note.txt'), 'utf8')).resolves.toBe('keep');
    await expect(access(dizin.yol('failure-out', 't_abc12345'))).resolves.toBeUndefined();
  });

  it('keeps unknown failure-out files and links and reports why they were skipped', async () => {
    const dizin = await proje();
    const disari = join(await mkdtemp(join(tmpdir(), 'kobay-prune-note-')), 'valuable.txt');
    await writeFile(disari, 'keep');
    await Promise.all([
      writeFile(dizin.yol('failure-out', 'notes.txt'), 'keep'),
      symlink(disari, dizin.yol('failure-out', 'custom-link')),
      symlink(disari, dizin.yol('failure-out', 'trace.zip')),
    ]);
    await lutimes(dizin.yol('failure-out', 'trace.zip'), ESKI_AN, ESKI_AN);

    const sonuc = await depoyuBuda(dizin);

    expect(sonuc.deleted.map((oge) => oge.path)).toEqual(['.kobay/failure-out/trace.zip']);
    expect(sonuc.skipped).toEqual([
      { path: '.kobay/failure-out/custom-link', reason: 'unrecognized-failure-out-file' },
      { path: '.kobay/failure-out/notes.txt', reason: 'unrecognized-failure-out-file' },
    ]);
    await expect(readFile(dizin.yol('failure-out', 'notes.txt'), 'utf8')).resolves.toBe('keep');
    await expect(access(dizin.yol('failure-out', 'custom-link'))).resolves.toBeUndefined();
    await expect(readFile(disari, 'utf8')).resolves.toBe('keep');
  });

  it('removes only old failure bundle stale directories', async () => {
    const dizin = await proje();
    const eski = dizin.yol('failure', '.stale-t_abc12345-11111111-1111-4111-8111-111111111111');
    const yeni = dizin.yol('failure', '.stale-t_abc12345-22222222-2222-4222-8222-222222222222');
    const bilinmeyen = dizin.yol('failure', '.stale-user-notes');
    await Promise.all([mkdir(eski), mkdir(yeni), mkdir(bilinmeyen)]);
    await utimes(eski, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const sonuc = await depoyuBuda(dizin, { olderThanDays: 1 });

    expect(sonuc.deleted).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.kobay/failure/.stale-t_abc12345-11111111-1111-4111-8111-111111111111', kind: 'stale-failure-bundle', reason: 'age' }),
    ]));
    await expect(access(eski)).rejects.toThrow();
    await expect(access(yeni)).resolves.toBeUndefined();
    await expect(access(bilinmeyen)).resolves.toBeUndefined();
  });

  it('keeps a known-name failure-out file newer than the age threshold and reports it as too recent', async () => {
    const dizin = await proje();
    const yeni = dizin.yol('failure-out', 'trace.zip');
    const eski = dizin.yol('failure-out', 'console.json');
    await Promise.all([writeFile(yeni, 'user-trace'), writeFile(eski, 'legacy')]);
    await utimes(eski, ESKI_AN, ESKI_AN);

    const sonuc = await depoyuBuda(dizin, { olderThanDays: 7 });

    expect(sonuc.deleted.map((oge) => [oge.path, oge.kind])).toEqual([
      ['.kobay/failure-out/console.json', 'legacy-failure-file'],
    ]);
    expect(sonuc.skipped).toEqual([{ path: '.kobay/failure-out/trace.zip', reason: 'too-recent' }]);
    await expect(readFile(yeni, 'utf8')).resolves.toBe('user-trace');
    await expect(access(eski)).rejects.toThrow();
  });

  it('ages a stale failure bundle by the time in its name, not by its (unrefreshed) mtime', async () => {
    const dizin = await proje();
    const taze = dizin.yol('failure', `.stale-t_abc12345-${Date.now()}-33333333-3333-4333-8333-333333333333`);
    const eskiAd = `.stale-t_abc12345-${ESKI_AN.getTime()}-44444444-4444-4444-8444-444444444444`;
    const eski = dizin.yol('failure', eskiAd);
    await Promise.all([mkdir(taze), mkdir(eski)]);
    // Rename mtime'ı yenilemez: kenara yeni alınmış bir paketin mtime'ı çok eski olabilir.
    await utimes(taze, ESKI_AN, ESKI_AN);

    const sonuc = await depoyuBuda(dizin, { olderThanDays: 1 });

    expect(sonuc.deleted.map((oge) => oge.path)).toEqual([`.kobay/failure/${eskiAd}`]);
    await expect(access(taze)).resolves.toBeUndefined();
    await expect(access(eski)).rejects.toThrow();
  });

  it('dry-run returns deterministic candidates and reclaimable bytes without changing files', async () => {
    const dizin = await proje();
    const eski = await kosuYaz(dizin, 't_old12345', 20, 'passed', 2048);
    await writeFile(dizin.yol('failure-out', 'console.json'), 'legacy');
    await utimes(dizin.yol('failure-out', 'console.json'), ESKI_AN, ESKI_AN);

    const sonuc = await depoyuBuda(dizin, { dryRun: true, olderThanDays: 1 });

    expect(sonuc.deleted).toEqual([]);
    expect(sonuc.estimate).toBe(true);
    expect(sonuc.wouldDelete.map((oge) => oge.path)).toEqual([
      '.kobay/failure-out/console.json',
      `.kobay/runs/${eski}`,
    ]);
    expect(sonuc.wouldReclaimBytes).toBeGreaterThan(2048);
    expect(sonuc.reclaimedBytes).toBe(0);
    await expect(access(dizin.yol('runs', eski))).resolves.toBeUndefined();
    await expect(access(dizin.yol('failure-out', 'console.json'))).resolves.toBeUndefined();
  });

  it('marks completed deletion figures as measured rather than estimated', async () => {
    const dizin = await proje();
    const eski = await kosuYaz(dizin, 't_old12345', 21, 'passed', 2048);

    const sonuc = await depoyuBuda(dizin, { olderThanDays: 1 });

    expect(sonuc.estimate).toBe(false);
    expect(sonuc.runBytesAfter).toBe(0);
    expect(sonuc.reclaimedBytes).toBeGreaterThan(2048);
    await expect(access(dizin.yol('runs', eski))).rejects.toThrow();
  });

  it('remeasures run storage after deletion instead of subtracting the initial candidate size', async () => {
    const dizin = await proje();
    const eski = await kosuYaz(dizin, 't_old12345', 22, 'passed', 2048);
    const eskiYolu = dizin.yol('runs', eski);
    const eszamanli = dizin.yol('runs', 'incomplete-added-during-prune');
    const gercekFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.resetModules();
    vi.doMock('node:fs/promises', async () => ({
      ...gercekFs,
      rm: async (...argumanlar: Parameters<typeof gercekFs.rm>) => {
        await gercekFs.rm(...argumanlar);
        if (String(argumanlar[0]) === eskiYolu) {
          await gercekFs.mkdir(eszamanli);
          await gercekFs.writeFile(join(eszamanli, 'payload.bin'), Buffer.alloc(4096));
        }
      },
    }));
    try {
      const { depoyuBuda: olculenBuda } = await import('../../src/depo/budama.js');

      const sonuc = await olculenBuda(dizin, { olderThanDays: 1 });

      expect(sonuc.estimate).toBe(false);
      expect(sonuc.runBytesAfter).toBeGreaterThanOrEqual(4096);
      await expect(access(eszamanli)).resolves.toBeUndefined();
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('removes the oldest unprotected run under size pressure even below the age threshold', async () => {
    const dizin = await proje();
    const eski = await kosuYaz(dizin, 't_old12345', 30, 'passed', 4096);
    await kosuYaz(dizin, 't_old12345', 31, 'failed', 4096);

    const sonuc = await depoyuBuda(dizin, { olderThanDays: 3650, maxMb: 0.001 });

    expect(sonuc.deleted).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `.kobay/runs/${eski}`, reason: 'size-limit' }),
    ]));
    expect(sonuc.runLimitExceeded).toBe(true);
  });

  it('rejects a managed-directory symlink without touching its external target', async () => {
    const dizin = await proje();
    const disari = await mkdtemp(join(tmpdir(), 'kobay-prune-outside-'));
    await writeFile(join(disari, 'brain-plan-1.log'), 'valuable');
    await rm(dizin.yol('logs'), { recursive: true });
    await symlink(disari, dizin.yol('logs'));

    await expect(depoyuBuda(dizin)).rejects.toBeInstanceOf(UnsafePrunePath);
    await expect(readFile(join(disari, 'brain-plan-1.log'), 'utf8')).resolves.toBe('valuable');
  });
});

describe('0.1 data migration notice', () => {
  it('writes one stderr line only when migration changes data', async () => {
    const kok = await mkdtemp(join(tmpdir(), 'kobay-migration-notice-'));
    await mkdir(join(kok, '.kobay'));
    await writeFile(join(kok, '.kobay', 'config.json'), JSON.stringify({
      baseUrl: 'http://localhost:3000',
      beyin: { adaptor: 'sahte' },
    }));
    const satirlar: string[] = [];
    const casus = vi.spyOn(process.stderr, 'write').mockImplementation((parca: string | Uint8Array) => {
      satirlar.push(String(parca));
      return true;
    });
    try {
      await KobayDizini.bul(kok);
      expect(satirlar).toEqual(['[kobay] Migrated project data from the 0.1 format to 0.2.\n']);
      satirlar.length = 0;
      await KobayDizini.bul(kok);
      expect(satirlar).toEqual([]);
    } finally {
      casus.mockRestore();
    }
    expect(await readFile(join(kok, '.kobay', 'config.json'), 'utf8')).toContain('"brain"');
  });
});
