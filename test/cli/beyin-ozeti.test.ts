import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { beyinKullanimFarki } from '../../src/beyin/index.js';
import { BeyinButcesi } from '../../src/beyin/ortak.js';
import { main } from '../../src/cli/index.js';
import { beyinSatiri, ciktiYaz } from '../../src/cli/cikti.js';
import { KobayDizini, yazAtomik } from '../../src/depo/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

function metinTopla(akis: PassThrough): () => string {
  let sonuc = '';
  akis.setEncoding('utf8');
  akis.on('data', (parca: string) => { sonuc += parca; });
  return () => sonuc;
}

async function kobay(argv: string[]): Promise<{ kod: number; stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutMetni = metinTopla(stdout);
  const stderrMetni = metinTopla(stderr);
  const kod = await main(['node', 'kobay', ...argv], { input: Readable.from([]), stdout, stderr });
  return { kod, stdout: stdoutMetni(), stderr: stderrMetni() };
}

/** Sahte beyinli proje + boş keşif haritası + tek önerili plan yanıtı. */
async function proje(): Promise<string> {
  const cwd = await geciciDizinAc('kobay-beyin-ozeti-');
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } });
  await dizin.haritaYaz({ baseUrl: 'http://uygulama.test', loggedIn: false,
    pages: [{ url: 'http://uygulama.test/', title: 'Home', headings: ['Home'], links: [], forms: [], buttons: [], menu: [] }],
    exploredAt: '2026-10-10T00:00:00.000Z' });
  const yanitlar = await geciciDizinAc('kobay-beyin-ozeti-yanit-');
  await yazAtomik(join(yanitlar, 'plan.json'), JSON.stringify({ proposals: [{
    title: 'Home page', description: 'Home page opens', priority: 'p0', category: 'smoke',
    feature: 'home', type: 'frontend', url: '/',
    steps: [
      { type: 'action', description: 'Open the home page' },
      { type: 'assertion', description: 'See the heading' },
    ],
  }] }));
  process.env.KOBAY_SAHTE_YANIT_DIZINI = yanitlar;
  return cwd;
}

function stderrYazici(): { akis: PassThrough; metin: () => string } {
  const akis = new PassThrough();
  return { akis, metin: metinTopla(akis) };
}

afterEach(() => {
  delete process.env.KOBAY_SAHTE_YANIT_DIZINI;
});

describe('brain usage line', () => {
  it('prints one stderr line after a brain command in human mode', async () => {
    const cwd = await proje();
    const sonuc = await kobay(['--cwd', cwd, 'test', 'plan', 'generate']);
    expect(sonuc.kod, sonuc.stderr + sonuc.stdout).toBe(0);
    expect(sonuc.stderr.trimEnd().split('\n').at(-1)).toBe('Brain: 1 call, $0.00');
    expect(sonuc.stdout).not.toContain('Brain:');
  });

  it('adds a brain field to the JSON envelope only when the command called the brain', async () => {
    const cwd = await proje();
    const uretim = await kobay(['--cwd', cwd, '--output', 'json', 'test', 'plan', 'generate']);
    expect(uretim.kod).toBe(0);
    const zarf = JSON.parse(uretim.stdout) as Record<string, unknown>;
    expect(zarf.brain).toEqual({ calls: 1, costUsd: 0 });
    expect(Object.keys(zarf)).toEqual(['ok', 'exitCode', 'data', 'brain']);

    // Aynı süreçte, beyinsiz bir komut önceki komutun kullanımını taşımaz.
    const kabul = await kobay(['--cwd', cwd, '--output', 'json', 'test', 'plan', 'accept', '--all']);
    expect(kabul.kod).toBe(0);
    expect(JSON.parse(kabul.stdout)).not.toHaveProperty('brain');
    const insan = await kobay(['--cwd', cwd, 'test', 'list']);
    expect(insan.stderr).not.toContain('Brain:');
  });

  it('formats the count, the cost and an unknown cost', () => {
    expect(beyinSatiri({ calls: 7, costUsd: 1.1 })).toBe('Brain: 7 calls, $1.10');
    expect(beyinSatiri({ calls: 1, costUsd: 0.004 })).toBe('Brain: 1 call, $0.0040');
    expect(beyinSatiri({ calls: 7, costUsd: null })).toBe('Brain: 7 calls, cost unknown');

    const stdout = new PassThrough();
    const hata = stderrYazici();
    ciktiYaz({ exitCode: 0, json: { ok: 1 } }, false, stdout, hata.akis, { calls: 2, costUsd: null });
    expect(hata.metin()).toBe('Brain: 2 calls, cost unknown\n');

    const jsonCikti = new PassThrough();
    const jsonMetni = metinTopla(jsonCikti);
    ciktiYaz({ exitCode: 4, json: { error: { code: 'BrainRuntimeError', message: 'x' } } }, true, jsonCikti, new PassThrough(), { calls: 2, costUsd: null });
    expect(JSON.parse(jsonMetni())).toEqual({
      ok: false, exitCode: 4, error: { code: 'BrainRuntimeError', message: 'x' }, brain: { calls: 2, costUsd: null },
    });
  });

  it('shows sub-cent costs with four decimals and rounds decimal halves up', () => {
    const satir = (costUsd: number): string => beyinSatiri({ calls: 1, costUsd });
    expect(satir(0)).toBe('Brain: 1 call, $0.00');
    expect(satir(0.004)).toBe('Brain: 1 call, $0.0040');
    expect(satir(0.00012345)).toBe('Brain: 1 call, $0.0001');
    expect(satir(0.00015)).toBe('Brain: 1 call, $0.0002');
    expect(satir(1e-7)).toBe('Brain: 1 call, $0.0000');
    expect(satir(0.009996)).toBe('Brain: 1 call, $0.01');
    expect(satir(0.01)).toBe('Brain: 1 call, $0.01');
    // İkili kayan nokta tuzağı: 1.005.toFixed(2) === '1.00', 0.015.toFixed(2) === '0.01'.
    expect(satir(1.005)).toBe('Brain: 1 call, $1.01');
    expect(satir(0.015)).toBe('Brain: 1 call, $0.02');
    expect(satir(0.00045)).toBe('Brain: 1 call, $0.0005');
    expect(satir(1.1)).toBe('Brain: 1 call, $1.10');
    expect(satir(12.344)).toBe('Brain: 1 call, $12.34');
    expect(satir(2.675)).toBe('Brain: 1 call, $2.68');
    expect(satir(1.10)).toBe('Brain: 1 call, $1.10');
    expect(satir(-0)).toBe('Brain: 1 call, $0.00');
    expect(satir(9_000_000_000)).toBe('Brain: 1 call, $9000000000.00');
    // Yuvarlama tamsayı mikro-dolar üzerinden: 0.024999999999999998 × 1e6 = 24999.999999999996 → 25000 µ$ = $0.025,
    // yarım-yukarı $0.03. (En kısa ondalık dize tekniği burada $0.02 verirdi; 1.005 ile tutarlı tek kural bu.)
    expect(satir(0.024999999999999998)).toBe('Brain: 1 call, $0.03');
    expect(satir(0.0249994)).toBe('Brain: 1 call, $0.02');
    expect(satir(0.005)).toBe('Brain: 1 call, $0.0050');
    expect(satir(0.00995)).toBe('Brain: 1 call, $0.01');
  });

  it('treats a negative, NaN, infinite or out-of-range cost as unknown in both modes', () => {
    for (const costUsd of [-0.01, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e21]) {
      expect(beyinSatiri({ calls: 3, costUsd }), String(costUsd)).toBe('Brain: 3 calls, cost unknown');
      const jsonCikti = new PassThrough();
      const jsonMetni = metinTopla(jsonCikti);
      ciktiYaz({ exitCode: 0, json: [] }, true, jsonCikti, new PassThrough(), { calls: 3, costUsd });
      const zarf = JSON.parse(jsonMetni()) as { brain: unknown };
      expect(zarf.brain, String(costUsd)).toEqual({ calls: 3, costUsd: null });
      expect(Object.keys(zarf.brain as object)).toEqual(['calls', 'costUsd']);
    }
    const jsonCikti = new PassThrough();
    const jsonMetni = metinTopla(jsonCikti);
    ciktiYaz({ exitCode: 0, json: [] }, true, jsonCikti, new PassThrough(), { calls: 3, costUsd: 0.024999999999999998 });
    expect(JSON.parse(jsonMetni())).toMatchObject({ brain: { calls: 3, costUsd: 0.024999999999999998 } });
  });

  it('prints nothing and adds no field without brain calls', () => {
    const stdout = new PassThrough();
    const hata = stderrYazici();
    ciktiYaz({ exitCode: 0, json: { ok: 1 } }, false, stdout, hata.akis);
    expect(hata.metin()).toBe('');
    const jsonCikti = new PassThrough();
    const jsonMetni = metinTopla(jsonCikti);
    ciktiYaz({ exitCode: 0, json: [] }, true, jsonCikti, new PassThrough());
    expect(JSON.parse(jsonMetni())).toEqual({ ok: true, exitCode: 0, data: [] });
  });
});

describe('brain usage ledger', () => {
  const env = {} as NodeJS.ProcessEnv;
  const ayar = { adaptor: 'sahte' as const };

  it('sums the reported cost and ignores reservations and calls that never started', () => {
    const butce = new BeyinButcesi(ayar, env);
    const once = butce.kullanim();
    butce.cagriTamamla(butce.claudeCagrisiBaslat(), 0.7);
    butce.cagriHarcandi(butce.cagriBaslat(0.5), 0.4);
    butce.cagriIptal(butce.cagriBaslat(0.5));
    expect(beyinKullanimFarki(once, butce.kullanim())).toEqual({ cagri: 2, maliyetUsd: expect.closeTo(1.1, 10) as number });
  });

  it('reports the cost as unknown when a provider did not report it', () => {
    const codexGibi = new BeyinButcesi(ayar, env);
    const once = codexGibi.kullanim();
    codexGibi.cagriTamamla(codexGibi.claudeCagrisiBaslat(), 0.2);
    codexGibi.cagriTamamla(codexGibi.cagriBaslat(), 0, false);
    expect(beyinKullanimFarki(once, codexGibi.kullanim())).toEqual({ cagri: 2, maliyetUsd: null });

    const hatali = new BeyinButcesi(ayar, env);
    hatali.cagriHarcandi(hatali.claudeCagrisiBaslat());
    expect(beyinKullanimFarki({ cagri: 0, bilinenMaliyetUsd: 0, maliyetiBilinmeyenCagri: 0 }, hatali.kullanim()))
      .toEqual({ cagri: 1, maliyetUsd: null });
  });

  it('returns nothing when no call closed', () => {
    const butce = new BeyinButcesi(ayar, env);
    const once = butce.kullanim();
    butce.cagriIptal(butce.cagriBaslat());
    expect(beyinKullanimFarki(once, butce.kullanim())).toBeUndefined();
  });
});
