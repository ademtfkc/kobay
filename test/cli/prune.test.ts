import { access, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { KobayDizini } from '../../src/depo/index.js';

function metinTopla(akis: PassThrough): () => string {
  let sonuc = '';
  akis.setEncoding('utf8');
  akis.on('data', (parca: string) => { sonuc += parca; });
  return () => sonuc;
}

async function proje(): Promise<{ cwd: string; dizin: KobayDizini }> {
  const cwd = await mkdtemp(join(tmpdir(), 'kobay-prune-cli-'));
  const dizin = await KobayDizini.ac(cwd, {
    baseUrl: 'http://localhost:3000',
    brain: { adaptor: 'sahte' },
  });
  return { cwd, dizin };
}

async function calistir(argv: string[]): Promise<{ kod: number; stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutMetni = metinTopla(stdout);
  const stderrMetni = metinTopla(stderr);
  const kod = await main(['node', 'kobay', ...argv], { input: Readable.from([]), stdout, stderr });
  return { kod, stdout: stdoutMetni(), stderr: stderrMetni() };
}

describe('kobay prune CLI', () => {
  it('deletes by default and prints a short human summary', async () => {
    const { cwd, dizin } = await proje();
    await writeFile(dizin.yol('failure-out', 'trace.zip'), 'legacy');
    await utimes(dizin.yol('failure-out', 'trace.zip'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const sonuc = await calistir(['--cwd', cwd, 'prune']);

    expect(sonuc.kod).toBe(0);
    expect(sonuc.stdout).toContain('Prune complete: removed 1 item and reclaimed');
    expect(sonuc.stdout).toContain('Run storage after prune:');
    expect(sonuc.stdout).not.toContain('{');
    expect(sonuc.stderr).toBe('');
    await expect(access(dizin.yol('failure-out', 'trace.zip'))).rejects.toThrow();
  });

  it('--dry-run --output json reports a deterministic candidate without deleting it', async () => {
    const { cwd, dizin } = await proje();
    await writeFile(dizin.yol('failure-out', 'console.json'), 'legacy');
    await utimes(dizin.yol('failure-out', 'console.json'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const sonuc = await calistir([
      '--cwd', cwd, '--output', 'json', 'prune', '--dry-run', '--max-mb', '12.5', '--older-than-days', '3',
    ]);
    const zarf = JSON.parse(sonuc.stdout) as {
      ok: boolean;
      data: { policy: { maxMb: number; olderThanDays: number }; deleted: unknown[]; wouldDelete: Array<{ path: string }> };
    };

    expect(sonuc.kod).toBe(0);
    expect(sonuc.stderr).toBe('');
    expect(zarf).toMatchObject({ ok: true, data: { dryRun: true } });
    expect(zarf.data).toMatchObject({ estimate: true, skipped: [] });
    expect(zarf.data.policy).toEqual(expect.objectContaining({ maxMb: 12.5, olderThanDays: 3 }));
    expect(zarf.data.deleted).toEqual([]);
    expect(zarf.data.wouldDelete.map((oge) => oge.path)).toEqual(['.kobay/failure-out/console.json']);
    await expect(access(dizin.yol('failure-out', 'console.json'))).resolves.toBeUndefined();
  });

  it('counts skipped failure-out items by reason in the human summary', async () => {
    const { cwd, dizin } = await proje();
    await writeFile(dizin.yol('failure-out', 'trace.zip'), 'recent');
    await writeFile(dizin.yol('failure-out', 'notes.txt'), 'mine');

    const sonuc = await calistir(['--cwd', cwd, 'prune']);

    expect(sonuc.kod).toBe(0);
    expect(sonuc.stdout).toContain('Skipped 2 failure-out items (1 unrecognized, 1 too recent).');
    await expect(access(dizin.yol('failure-out', 'trace.zip'))).resolves.toBeUndefined();
    await expect(access(dizin.yol('failure-out', 'notes.txt'))).resolves.toBeUndefined();
  });

  it('rejects an invalid number as a usage error with exit 2', async () => {
    const { cwd } = await proje();

    const sonuc = await calistir(['--cwd', cwd, '--output', 'json', 'prune', '--max-mb', '0']);

    expect(sonuc.kod).toBe(2);
    expect(JSON.parse(sonuc.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      error: { code: 'CommanderError' },
    });
  });
});
