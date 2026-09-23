import { PassThrough, Readable } from 'node:stream';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { main, programOlustur } from '../../src/cli/index.js';

async function calistir(argv: string[]): Promise<{ exitCode: number; cikti: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let cikti = '';
  for (const akis of [stdout, stderr]) {
    akis.setEncoding('utf8');
    akis.on('data', (parca: string) => { cikti += parca; });
  }
  const exitCode = await main(['node', 'kobay', ...argv], { input: Readable.from([]), stdout, stderr });
  return { exitCode, cikti };
}

/** Yardım metinleri README ile aynı dilde, İngilizce olmalı. */
const turkceHarf = /[çğıöşüÇĞİÖŞÜ]/;

function yardimMetinleri(komut: Command, yol: string[] = []): Array<{ yer: string; metin: string }> {
  const ad = [...yol, komut.name()].join(' ');
  return [
    { yer: ad, metin: komut.description() },
    ...komut.options.map((secenek) => ({ yer: `${ad} ${secenek.flags}`, metin: secenek.description })),
    ...komut.commands.flatMap((alt) => yardimMetinleri(alt, [...yol, komut.name()])),
  ];
}

describe('CLI yardım metinleri', () => {
  it('her komut ve seçenek açıklaması İngilizce', () => {
    const metinler = yardimMetinleri(programOlustur());

    expect(metinler.length).toBeGreaterThan(40);
    expect(metinler.filter((m) => m.metin.trim() === '' && !m.yer.endsWith('--beyin <adaptor>'))).toEqual([]);
    expect(metinler.filter((m) => turkceHarf.test(m.metin))).toEqual([]);
  });

  it('beyin seçen her komut yardımda --brain gösterir', () => {
    const metinler = yardimMetinleri(programOlustur());
    for (const komut of ['kobay setup', 'kobay project create', 'kobay project update']) {
      expect(metinler.map((m) => m.yer)).toContain(`${komut} --brain <adaptor>`);
    }
  });

  it('test beyni sahte yardımda listelenmez, geçersiz beyin reddedilir', async () => {
    for (const komut of [['project', 'create'], ['project', 'update']]) {
      const yardim = await calistir([...komut, '--help']);
      expect(yardim.exitCode).toBe(0);
      expect(yardim.cikti).toContain('"openrouter"');
      expect(yardim.cikti).not.toContain('sahte');
    }

    const hatali = await calistir(['project', 'create', '--url', 'http://uygulama.test', '--brain', 'yok']);
    expect(hatali.exitCode).toBe(2);
    expect(hatali.cikti).toContain("argument 'yok' is invalid. Allowed choices are claude, codex, openrouter.");
  });
});
