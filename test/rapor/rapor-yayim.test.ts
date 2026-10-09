import { link, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Yarış pencerelerini elle kurmak zor; bu dosya iki savunmayı sahte bağımlılıkla
 * sınar: (C) PNG açıldıktan sonra gerçek yolu koşu dizini dışına çıkıyorsa
 * kopyalanmaz; (A) yayım düşerse kenara alınmış klasörlerin yolu hatada yazar.
 */
const durum = vi.hoisted(() => ({ disariGoster: false, disYol: '', yayimDussun: false, birakilacak: '' }));

vi.mock('node:fs/promises', async (asil) => {
  const gercek = await asil<typeof import('node:fs/promises')>();
  return {
    ...gercek,
    realpath: (async (yol: string, ...kalan: unknown[]) => {
      if (durum.disariGoster && String(yol).endsWith('step-0.png')) return durum.disYol;
      return (gercek.realpath as (...a: unknown[]) => Promise<string>)(yol, ...kalan);
    }) as typeof gercek.realpath,
  };
});

vi.mock('../../src/depo/index.js', async (asil) => {
  const gercek = await asil<typeof import('../../src/depo/index.js')>();
  return {
    ...gercek,
    klasoruYayimla: (async (secenek: Parameters<typeof gercek.klasoruYayimla>[0]) => {
      if (!durum.yayimDussun) return gercek.klasoruYayimla(secenek);
      await secenek.eskileriSil([durum.birakilacak]);
      throw new Error('simulated publish failure');
    }) as typeof gercek.klasoruYayimla,
  };
});

const { KobayDizini } = await import('../../src/depo/index.js');
const { raporUret } = await import('../../src/rapor/index.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]);

async function hazirla(): Promise<{ dizin: InstanceType<typeof KobayDizini>; test: Awaited<ReturnType<InstanceType<typeof KobayDizini>['testOku']>> }> {
  const cwd = await mkdtemp(join(tmpdir(), 'kobay-report-mock-'));
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://localhost:3000', brain: { adaptor: 'sahte' } });
  const runId = 'r_20261005100000_aaaa';
  const test = {
    id: 't_aaaaaaaa', name: 'Mock', type: 'frontend' as const, createdFrom: 'cli' as const, status: 'ready' as const,
    planSteps: [{ type: 'action' as const, description: 'a' }, { type: 'action' as const, description: 'b' }],
    priority: 'p1' as const, codeVersion: 1, lastRunId: runId,
    createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
  };
  await dizin.testYaz(test);
  const kosu = await dizin.kosuDizini(runId);
  await dizin.kosuSonucuYaz({
    testId: test.id, runId, status: 'passed', verdict: 'passed',
    startedAt: '2026-10-05T10:00:00.000Z', finishedAt: '2026-10-05T10:00:01.000Z', codeVersion: 1,
  });
  await writeFile(join(kosu, 'steps.json'), JSON.stringify([0, 1].map((stepIndex) => ({
    stepIndex, description: 'x', status: 'passed', durationMs: 1, screenshotPath: `step-${stepIndex}.png`,
  }))));
  await writeFile(join(kosu, 'step-0.png'), PNG);
  await writeFile(join(kosu, 'step-1.png'), PNG);
  return { dizin, test };
}

afterEach(() => {
  durum.disariGoster = false;
  durum.yayimDussun = false;
});

describe('report publishing defenses', () => {
  it('(C) skips a screenshot whose real path, checked after opening, is outside the run directory', async () => {
    const { dizin, test } = await hazirla();
    // Aynı dosyanın (aynı dev/ino) koşu dizini dışındaki sert bağı: kimlik denetimi
    // geçer, yalnız "gerçek yol koşu dizininin altında mı" denetimi yakalar.
    durum.disYol = join(await mkdtemp(join(tmpdir(), 'kobay-report-hardlink-')), 'step-0.png');
    await link(join(dizin.yol('runs', 'r_20261005100000_aaaa'), 'step-0.png'), durum.disYol);
    durum.disariGoster = true;
    const hedef = join(dizin.kok, 'report');

    const sonuc = await raporUret({ dizin, testler: [test], hedef, surum: '0', varsayilanHedef: true });

    expect(sonuc.screenshots).toBe(1);
    await expect(readdir(join(hedef, 'assets', 'r_20261005100000_aaaa'))).resolves.toEqual(['step-1.png']);
  });

  it('(A) a failed publish names every folder it set aside and kept', async () => {
    const { dizin, test } = await hazirla();
    const hedef = join(dizin.kok, 'report');
    durum.birakilacak = join(dizin.kok, '.kobay-report-old-kept');
    await mkdir(durum.birakilacak);
    await writeFile(join(durum.birakilacak, 'user-file.txt'), 'mine');
    durum.yayimDussun = true;

    await expect(raporUret({ dizin, testler: [test], hedef, surum: '0', varsayilanHedef: true }))
      .rejects.toThrow(`Folders set aside during publishing were kept: ${durum.birakilacak}`);
    await expect(readdir(durum.birakilacak)).resolves.toEqual(['user-file.txt']);
  });
});
