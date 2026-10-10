import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BundleIncomplete, KobayDizini, type HataPaketi, type KobayConfig } from '../../src/depo/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * Aynı test kimliğine ayrı Node süreçlerinden yazan kobay çağrıları. Süreç içi
 * yarış testleri tek bir olay döngüsünde koşar; kilidin gerçek amacı ayrı
 * süreçleri (iki terminal, CLI + MCP) sıraya sokmaktır.
 */

const DEPO = resolve(import.meta.dirname, '../../src/depo');
const KOK = resolve(import.meta.dirname, '../..');

const config: KobayConfig = {
  baseUrl: 'http://localhost:3000',
  brain: { adaptor: 'sahte' },
} as KobayConfig;

function paket(snapshotId: string): HataPaketi {
  return {
    snapshotId,
    testId: 't_abc12345',
    runId: 'r_20260917010101_abcd',
    result: {
      testId: 't_abc12345', runId: 'r_20260917010101_abcd', status: 'failed', verdict: 'failed',
      startedAt: '2026-09-17T00:00:00.000Z', finishedAt: '2026-09-17T00:00:01.000Z', codeVersion: 1,
    },
    steps: [{ stepIndex: 0, description: 'x', status: 'failed', durationMs: 10 }],
    code: `// ${snapshotId}`,
    failure: {
      rootCauseHypothesis: 'x', failureKind: 'test_bug',
      recommendedFixTarget: { kind: 'selector', reference: 'l', rationale: 'r' }, evidence: [],
    },
  } as HataPaketi;
}

/** `tsx` ile bir betik koşturur; çıkış kodu ve stderr döner. */
function kostur(betik: string, argumanlar: string[]): Promise<{ kod: number | null; hata: string }> {
  return new Promise((coz, red) => {
    const surec = spawn(process.execPath, ['--import', 'tsx', betik, ...argumanlar], { cwd: KOK, stdio: ['ignore', 'ignore', 'pipe'] });
    let hata = '';
    surec.stderr.on('data', (parca: Buffer) => { hata += parca.toString(); });
    surec.on('error', red);
    surec.on('close', (kod) => coz({ kod, hata }));
  });
}

async function betikYaz(ad: string, govde: string): Promise<string> {
  const dizin = await geciciDizinAc('kobay-kilit-betik-');
  const yol = join(dizin, ad);
  await writeFile(yol, govde);
  return yol;
}

const depoUrl = (dosya: string): string => pathToFileURL(join(DEPO, dosya)).href;

describe('hata paketi kilidi, ayrı süreçler', () => {
  it('üç ayrı süreç aynı testin paketini 15\'er kez yazar: hepsi başarır, paket eksiksiz, artık yok', async () => {
    const kok = await geciciDizinAc('kobay-kilit-');
    const dizin = await KobayDizini.ac(kok, config);
    await dizin.hataPaketiYaz(paket('s_0'), []);
    const betik = await betikYaz('yazici.mts', `
      import { KobayDizini } from ${JSON.stringify(depoUrl('index.ts'))};
      const [kok, ad, tur] = process.argv.slice(2);
      const paket = JSON.parse(process.env.PAKET);
      const dizin = await KobayDizini.bul(kok);
      for (let i = 0; i < Number(tur); i += 1) {
        await dizin.hataPaketiYaz({ ...paket, snapshotId: ad, code: '// ' + ad }, []);
      }
    `);

    const sonuclar = await Promise.all(['s_1', 's_2', 's_3'].map((ad) => new Promise<{ kod: number | null; hata: string }>((coz, red) => {
      const surec = spawn(process.execPath, ['--import', 'tsx', betik, kok, ad, '15'], {
        cwd: KOK, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PAKET: JSON.stringify(paket('x')) },
      });
      let hata = '';
      surec.stderr.on('data', (parca: Buffer) => { hata += parca.toString(); });
      surec.on('error', red);
      surec.on('close', (kod) => coz({ kod, hata }));
    })));

    for (const sonuc of sonuclar) expect(sonuc, sonuc.hata).toMatchObject({ kod: 0 });
    const yayimlanan = await dizin.hataPaketiOku('t_abc12345');
    expect(['s_1', 's_2', 's_3']).toContain(yayimlanan.snapshotId);
    expect(yayimlanan.code).toBe(`// ${yayimlanan.snapshotId}`);
    expect(await readdir(dizin.yol('failure'))).toEqual(['t_abc12345']);
  }, 120_000);

  it('kilidi tutan süreç yayım ortasında ölürse: yarım paket kabul edilmez, sonraki yazım kilidi devralır', async () => {
    const kok = await geciciDizinAc('kobay-kilit-');
    const dizin = await KobayDizini.ac(kok, config);
    await dizin.hataPaketiYaz(paket('s_1'), []);
    // Ölen süreç: kilidi alır, hedefe yarım (`.partial` işaretli) bir paket bırakır, bırakmadan çıkar.
    const betik = await betikYaz('olen.mts', `
      import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { paketKilidiniAl } from ${JSON.stringify(depoUrl('paket-kilidi.ts'))};
      const [kobay] = process.argv.slice(2);
      await paketKilidiniAl({ kobayKoku: kobay, ad: 'failure', testId: 't_abc12345', reddet: (y, s) => new Error(y + s) });
      const hedef = join(kobay, 'failure', 't_abc12345');
      await rename(hedef, join(kobay, 'failure', '.stale-t_abc12345-' + Date.now() + '-00000000-0000-4000-8000-000000000000'));
      await mkdir(hedef);
      await writeFile(join(hedef, '.partial'), '');
      await writeFile(join(hedef, 'failure.json'), '{"yarim":');
      process.exit(0);
    `);
    const sonuc = await kostur(betik, [dizin.kok]);
    expect(sonuc, sonuc.hata).toMatchObject({ kod: 0 });
    expect((await readdir(dizin.yol('failure'))).some((ad) => ad === '.lock-t_abc12345')).toBe(true);

    await expect(dizin.hataPaketiOku('t_abc12345')).rejects.toBeInstanceOf(BundleIncomplete);
    const yeni = paket('s_2');
    await dizin.hataPaketiYaz(yeni, []);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(yeni);
    const kalanlar = await readdir(dizin.yol('failure'));
    // Ölen sürecin kenara aldığı eski paket (`.stale-*`) budamaya kalır; kilit ve yarım paket kalmaz.
    expect(kalanlar.filter((ad) => !ad.startsWith('.stale-'))).toEqual(['t_abc12345']);
  }, 60_000);
});
