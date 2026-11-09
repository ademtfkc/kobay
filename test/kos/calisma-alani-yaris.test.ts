import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * P2-2: Windows'ta ilk koşuda iki eşzamanlı koşu aynı dosyayı aynı anda
 * `yazAtomik` ile taşıyordu; ikinci taşıma EPERM verip koşuyu `env` yapıyordu
 * (public CI windows/22). macOS/Linux'ta aynı hedefe eşzamanlı rename sorunsuz
 * olduğundan Windows davranışı burada taklit edilir: hedefe bir taşıma sürerken
 * aynı hedefe gelen ikinci taşıma EPERM alır.
 */
const durum = vi.hoisted(() => ({
  /** Açıkken rename Windows gibi davranır: hedef o an yazılıyorsa EPERM. */
  windows: false,
  /** Taklit taşımanın sürdüğü pencere. */
  gecikmeMs: 50,
  /** Şu an taşınmakta olan hedefler. */
  yazilan: new Set<string>(),
  /** Bütün rename çağrılarının hedefleri (çözülmüş yol). */
  hedefler: [] as string[],
  /** Taklidin verdiği EPERM sayısı; taklidin gerçekten tetiklendiğinin kanıtı. */
  eperm: 0,
  /** Verilirse o hedef için gerçek taşıma yapılmadan bu kodla düşülür. */
  zorla: undefined as ((hedef: string) => string | undefined) | undefined,
  /** Verilirse o hedef için gerçek taşımadan önce beklenir. */
  kapi: undefined as ((hedef: string) => Promise<void> | undefined) | undefined,
  /** Verilirse o yol için okuma gerçek okumadan önce bu kodla düşer. */
  zorlaOku: undefined as ((yol: string) => string | undefined) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const asil = await importOriginal<typeof import('node:fs/promises')>();
  const bekle = (ms: number): Promise<void> => new Promise((coz) => { setTimeout(coz, ms); });
  return {
    ...asil,
    readFile: (async (yol: string, ...geri: unknown[]) => {
      const kod = durum.zorlaOku?.(resolve(String(yol)));
      if (kod !== undefined) {
        throw Object.assign(new Error(`${kod}: simulated, open '${String(yol)}'`), { code: kod });
      }
      return (asil.readFile as (...a: unknown[]) => Promise<unknown>)(yol, ...geri);
    }) as typeof asil.readFile,
    rename: async (eski: string, yeni: string) => {
      const hedef = resolve(String(yeni));
      durum.hedefler.push(hedef);
      const kod = durum.zorla?.(hedef);
      if (kod !== undefined) {
        throw Object.assign(new Error(`${kod}: simulated, rename '${String(eski)}' -> '${String(yeni)}'`), { code: kod });
      }
      if (!durum.windows) {
        await durum.kapi?.(hedef);
        await asil.rename(eski, yeni);
        return;
      }
      if (durum.yazilan.has(hedef)) {
        durum.eperm += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(eski)}' -> '${String(yeni)}'`), { code: 'EPERM' });
      }
      durum.yazilan.add(hedef);
      try {
        await bekle(durum.gecikmeMs);
        await durum.kapi?.(hedef);
        await asil.rename(eski, yeni);
      } finally {
        durum.yazilan.delete(hedef);
      }
    },
  };
});

const { ATOMIK_YAZIM, yazAtomik } = await import('../../src/depo/index.js');
const { FixtureModuleMissing, kaliciCalismaAlaniHazirla } = await import('../../src/kos/calisma-alani.js');

const VARSAYILAN_TAVAN = ATOMIK_YAZIM.tasimaBeklemeMs;

afterEach(() => {
  durum.windows = false;
  durum.gecikmeMs = 50;
  durum.yazilan.clear();
  durum.hedefler = [];
  durum.eperm = 0;
  durum.zorla = undefined;
  durum.kapi = undefined;
  durum.zorlaOku = undefined;
  ATOMIK_YAZIM.tasimaBeklemeMs = VARSAYILAN_TAVAN;
});

async function geciciler(dizin: string): Promise<string[]> {
  return (await readdir(dizin)).filter((ad) => ad.endsWith('.tmp'));
}

function sayi(hedef: string): number {
  return durum.hedefler.filter((h) => h === resolve(hedef)).length;
}

describe('yazAtomik: meşgul hedefe taşıma (Windows taklidi)', () => {
  it('aynı hedefe eşzamanlı iki yazım EPERM ile düşmez; yeniden deneme ikisini de bitirir', async () => {
    const dizin = await geciciDizinAc('kobay-atomik-');
    const yol = join(dizin, 'tests', 't_abc12345.json');
    durum.windows = true;

    await expect(Promise.all([yazAtomik(yol, 'bir'), yazAtomik(yol, 'iki')])).resolves.toEqual([undefined, undefined]);

    expect(durum.eperm).toBeGreaterThan(0);
    expect(['bir', 'iki']).toContain(await readFile(yol, 'utf8'));
    expect(await geciciler(join(dizin, 'tests'))).toEqual([]);
  });

  it('meşgul kod süre sınırı boyunca sürerse özgün kodla düşer ve geçici dosyayı siler', async () => {
    const dizin = await geciciDizinAc('kobay-atomik-');
    const yol = join(dizin, 'a.json');
    ATOMIK_YAZIM.tasimaBeklemeMs = 150;
    durum.zorla = (hedef) => (hedef === resolve(yol) ? 'EPERM' : undefined);

    const bas = Date.now();
    await expect(yazAtomik(yol, 'x')).rejects.toMatchObject({ code: 'EPERM' });
    const gecen = Date.now() - bas;

    expect(sayi(yol)).toBeGreaterThan(1);
    expect(gecen).toBeGreaterThanOrEqual(140);
    expect(gecen).toBeLessThan(1_500);
    expect(await geciciler(dizin)).toEqual([]);
  });

  it('ENOENT yeniden denenmez: tek denemede özgün kodla düşer, geçici dosya kalmaz', async () => {
    const dizin = await geciciDizinAc('kobay-atomik-');
    const yol = join(dizin, 'a.json');
    durum.zorla = (hedef) => (hedef === resolve(yol) ? 'ENOENT' : undefined);

    await expect(yazAtomik(yol, 'x')).rejects.toMatchObject({ code: 'ENOENT' });

    expect(sayi(yol)).toBe(1);
    expect(await geciciler(dizin)).toEqual([]);
  });
});

describe('kaliciCalismaAlaniHazirla: kök başına sıra', () => {
  it('aynı kök için eşzamanlı iki hazırlık aynı dosyayı iki kez taşımaz', async () => {
    const kok = await geciciDizinAc('kobay-alan-');
    durum.windows = true;

    const [bir, iki] = await Promise.all([kaliciCalismaAlaniHazirla(kok), kaliciCalismaAlaniHazirla(kok)]);

    expect(iki).toEqual(bir);
    // İkinci çağrı sırada bekler, içeriği aynı bulur ve yazmaz.
    expect(sayi(bir.configYolu)).toBe(1);
    expect(sayi(bir.fixtureYolu)).toBe(1);
    expect(durum.eperm).toBe(0);
    expect(await readFile(bir.configYolu, 'utf8')).toContain("testDir: 'tests'");
  });

  it('farklı kökler birbirini beklemez', async () => {
    const kokA = await geciciDizinAc('kobay-alan-a-');
    const kokB = await geciciDizinAc('kobay-alan-b-');
    let birakA!: () => void;
    const kapiA = new Promise<void>((coz) => { birakA = coz; });
    durum.kapi = (hedef) => (hedef.startsWith(resolve(kokA)) ? kapiA : undefined);

    const a = kaliciCalismaAlaniHazirla(kokA);
    let aBitti = false;
    void a.then(() => { aBitti = true; }, () => { aBitti = true; });
    await expect(kaliciCalismaAlaniHazirla(kokB)).resolves.toMatchObject({ configYolu: join(kokB, 'playwright.config.ts') });
    expect(aBitti).toBe(false);

    birakA();
    await expect(a).resolves.toMatchObject({ configYolu: join(kokA, 'playwright.config.ts') });
  });

  it('başka süreç dosyayı taşırken okuma meşgul kodu alırsa yeniden denenir (Codex P2-a)', async () => {
    const kok = await geciciDizinAc('kobay-alan-');
    await kaliciCalismaAlaniHazirla(kok);
    const config = resolve(join(kok, 'playwright.config.ts'));
    let kalan = 2;
    durum.zorlaOku = (yol) => {
      if (yol !== config || kalan === 0) return undefined;
      kalan -= 1;
      return 'EPERM';
    };

    await expect(kaliciCalismaAlaniHazirla(kok)).resolves.toMatchObject({ configYolu: join(kok, 'playwright.config.ts') });
    expect(kalan).toBe(0);
  });

  it('bir yazım düşünce kardeş yazım bitmeden sıra sonraki hazırlığa geçmez (Codex P2-c)', async () => {
    const kok = await geciciDizinAc('kobay-alan-');
    const config = resolve(join(kok, 'playwright.config.ts'));
    const fixture = resolve(join(kok, 'tests', '_fixture.ts'));
    let birak!: () => void;
    const kapi = new Promise<void>((coz) => { birak = coz; });
    let ilkConfig = true;
    let fixtureBitti = false;
    let erkenAcildi = false;
    durum.zorla = (hedef) => {
      if (hedef !== config || !ilkConfig) return undefined;
      ilkConfig = false;
      return 'EISDIR';
    };
    durum.kapi = (hedef) => {
      if (hedef === fixture && !fixtureBitti) return kapi.then(() => { fixtureBitti = true; });
      if (hedef === config && !fixtureBitti) erkenAcildi = true;
      return undefined;
    };

    const ilk = kaliciCalismaAlaniHazirla(kok);
    const ikinci = kaliciCalismaAlaniHazirla(kok);
    void ilk.catch(() => undefined);
    await new Promise((coz) => { setTimeout(coz, 100); });
    birak();

    await expect(ilk).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(ikinci).resolves.toMatchObject({ configYolu: join(kok, 'playwright.config.ts') });
    expect(erkenAcildi).toBe(false);
  });

  it('düşen hazırlık sırayı kilitlemez', async () => {
    const kok = await geciciDizinAc('kobay-alan-');
    const bosPaket = await geciciDizinAc('kobay-bos-paket-');

    const [ilk, ikinci] = await Promise.allSettled([
      kaliciCalismaAlaniHazirla(kok, bosPaket),
      kaliciCalismaAlaniHazirla(kok),
    ]);

    expect(ilk.status).toBe('rejected');
    expect((ilk as PromiseRejectedResult).reason).toBeInstanceOf(FixtureModuleMissing);
    expect(ikinci.status).toBe('fulfilled');
    await expect(kaliciCalismaAlaniHazirla(kok)).resolves.toMatchObject({ fixtureYolu: join(kok, 'tests', '_fixture.ts') });
  });
});
