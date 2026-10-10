import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BundleLockTimeout, PAKET_KILIDI, paketKilidiniAl, type PaketKilidi, type PaketKilidiKancasi,
} from '../../src/depo/paket-kilidi.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * Aynı süreçte inceleme ile bırakma/alım arasındaki yarış (TOCTOU): C, A'nın
 * gövdesini okur; A bırakır, D taze kilidi alır; C eski gövdeye bakıp "bayat"
 * der ve D'nin kilidini devralma adına taşır. Taşıma ile geri koyma arasında
 * D'nin doğrulaması `BundleLockLost` alırdı. Sıralama C'nin kancasıyla zorlanır.
 */

/** Bekleyen tüm mikro görevler (await zincirleri) koştuktan sonra döner. */
function makroTur(): Promise<void> {
  return new Promise((coz) => setImmediate(coz));
}

/** Gerçek `.kobay` ve aynı dizini gösteren bir takma ad (üst dizin symlink'i). */
async function kobayKurulumu(): Promise<{ gercek: string; takmaAd: string }> {
  const ust = await geciciDizinAc('kobay-kilit-ayni-');
  await mkdir(join(ust, 'gercek', '.kobay', 'failure'), { recursive: true });
  await symlink(join(ust, 'gercek'), join(ust, 'takma'), process.platform === 'win32' ? 'junction' : 'dir');
  return { gercek: join(ust, 'gercek', '.kobay'), takmaAd: join(ust, 'takma', '.kobay') };
}

function al(kobayKoku: string, kanca?: PaketKilidiKancasi): Promise<PaketKilidi> {
  return paketKilidiniAl({
    kobayKoku, ad: 'failure', testId: 't_abc12345', reddet: (y, s) => new Error(`${y}: ${s}`), kanca,
  });
}

/** C `cKoku` üzerinden, A ve D `adKoku` üzerinden alır. */
async function senaryo(cKoku: string, adKoku: string): Promise<void> {
  let okunduSinyali!: () => void;
  const okundu = new Promise<void>((coz) => { okunduSinyali = coz; });
  let kapiyiAc!: () => void;
  const kapi = new Promise<void>((coz) => { kapiyiAc = coz; });
  let ilkOkuma = true;
  let tutan: PaketKilidi | undefined;
  let dogrulamaHatasi: unknown;
  let devirSayisi = 0;

  let aBirakBasladi = false;
  const a = await al(adKoku, { olay: (olay) => { if (olay === 'birak-basladi') aBirakBasladi = true; } });
  // C: A'nın gövdesini okur ve kapıda bekler.
  const c = al(cKoku, {
    gecikme: async (asama) => {
      if (asama === 'incele-okundu' && ilkOkuma) {
        ilkOkuma = false;
        okunduSinyali();
        await kapi;
      } else if (asama === 'devir-tasindi') {
        devirSayisi += 1;
        // Taşıma ile geri koyma arasında, kilidi tutan doğrular.
        if (tutan !== undefined) await tutan.dogrula().catch((hata: unknown) => { dogrulamaHatasi = hata; });
      }
    },
  });
  await okundu;
  // A bırakır, D alır. Doğru sırada A'nın bırakması C'nin incelemesi bitene dek
  // sırada bekler: bırakma sıraya girer (eşzamanlı), mikro görevler biter, işe
  // başlamamış olmalı. Zamanlayıcıya dayanılmaz.
  const birakA = a.birak();
  const d = al(adKoku).then((kilit) => { tutan = kilit; return kilit; });
  await makroTur();
  const birakmaSiradaKaldi = !aBirakBasladi;
  // Sıra delinmişse yarışı sonuna dek oynat: A bırakır, D alır, sonra kapı açılır.
  if (!birakmaSiradaKaldi) await Promise.all([birakA, d]);
  kapiyiAc();

  // İkisi de sırayla alır ve bırakır; hiçbir doğrulama kilidi kaybetmiş görmez.
  const [ilkAd, ilk] = await Promise.race([
    c.then((k) => ['c', k] as const),
    d.then((k) => ['d', k] as const),
  ]);
  tutan = ilk;
  await ilk.dogrula();
  await ilk.birak();
  const ikinci = await (ilkAd === 'd' ? c : d);
  tutan = ikinci;
  await ikinci.dogrula();
  await ikinci.birak();
  await birakA;

  expect(dogrulamaHatasi).toBeUndefined();
  expect(devirSayisi).toBe(0);
  // C kapıda beklerken A'nın bırakması sırada tutuldu (kanca gerçekten beklendi).
  expect(birakmaSiradaKaldi).toBe(true);
  // Kanca gerçekten bağlı: bırakma bittiğinde işine başlamış olmalı.
  expect(aBirakBasladi).toBe(true);
}

describe('hata paketi kilidi, aynı süreç', () => {
  it('inceleme okuduktan sonra bırakılan ve yeniden alınan kilit, eski gövdeye bakılarak taşınmaz', async () => {
    const { gercek } = await kobayKurulumu();
    await senaryo(gercek, gercek);
  });

  it('aynı dizine takma ad (symlink) üzerinden gelen çağrılar da aynı sıraya girer', async () => {
    const { gercek, takmaAd } = await kobayKurulumu();
    await senaryo(gercek, takmaAd);
  });

  it('süreç içi sırada bekleme de alım süresine dahildir: dolunca BundleLockTimeout', async () => {
    const { gercek } = await kobayKurulumu();
    let okunduSinyali!: () => void;
    const okundu = new Promise<void>((coz) => { okunduSinyali = coz; });
    let kapiyiAc!: () => void;
    const kapi = new Promise<void>((coz) => { kapiyiAc = coz; });
    let ilkOkuma = true;

    const a = await al(gercek);
    // C incelemede takılı kalır ve sırayı tutar.
    const c = al(gercek, {
      gecikme: async (asama) => {
        if (asama !== 'incele-okundu' || !ilkOkuma) return;
        ilkOkuma = false;
        okunduSinyali();
        await kapi;
      },
    });
    await okundu;

    const varsayilan = PAKET_KILIDI.beklemeMs;
    PAKET_KILIDI.beklemeMs = 200;
    const baslangic = Date.now();
    let hata: unknown;
    try {
      hata = await al(gercek).catch((h: unknown) => h);
    } finally {
      PAKET_KILIDI.beklemeMs = varsayilan;
      kapiyiAc();
    }
    expect(hata).toBeInstanceOf(BundleLockTimeout);
    expect((hata as Error).message).toContain('still queued behind another operation on this lock in the same process');
    expect(Date.now() - baslangic).toBeLessThan(5_000);

    await a.birak();
    await (await c).birak();
  });

  it('sırada süresi dolan bekleyici sırayı açmaz: sonraki çağrı çalışan iş bitmeden başlamaz', async () => {
    const { gercek } = await kobayKurulumu();
    let okunduSinyali!: () => void;
    const okundu = new Promise<void>((coz) => { okunduSinyali = coz; });
    let kapiyiAc!: () => void;
    const kapi = new Promise<void>((coz) => { kapiyiAc = coz; });
    let ilkOkuma = true;

    const a = await al(gercek);
    // P (C'nin incelemesi) sırada çalışıyor ve kapıda takılı.
    const c = al(gercek, {
      gecikme: async (asama) => {
        if (asama !== 'incele-okundu' || !ilkOkuma) return;
        ilkOkuma = false;
        okunduSinyali();
        await kapi;
      },
    });
    await okundu;

    // W: P'nin arkasında sıraya girer, süresi dolar; işi hiç koşmamalı.
    let wBasladi = 0;
    const varsayilan = PAKET_KILIDI.beklemeMs;
    PAKET_KILIDI.beklemeMs = 50;
    let wHata: unknown;
    try {
      wHata = await al(gercek, { olay: (olay) => { if (olay === 'incele-basladi') wBasladi += 1; } })
        .catch((h: unknown) => h);
    } finally {
      PAKET_KILIDI.beklemeMs = varsayilan;
    }

    // N: W düştükten sonra gelir; P bitmeden işine başlamamalı.
    let nSiradaSinyali!: () => void;
    const nSirada = new Promise<void>((coz) => { nSiradaSinyali = coz; });
    let nBasladi = false;
    const n = al(gercek, {
      olay: (olay) => {
        if (olay === 'incele-sirada') nSiradaSinyali();
        if (olay === 'incele-basladi') nBasladi = true;
      },
    });
    await nSirada;
    await makroTur();
    const nErkenBasladi = nBasladi;
    kapiyiAc();

    // Hepsi kilidi alınca hemen bırakır; hangisi önce alırsa alsın kilitlenmez.
    await a.birak();
    await Promise.all([c.then((k) => k.birak()), n.then((k) => k.birak())]);

    expect(wHata).toBeInstanceOf(BundleLockTimeout);
    expect(nErkenBasladi).toBe(false);
    // Kanca gerçekten bağlı: N kilidi aldığında incelemesi başlamış olmalı.
    expect(nBasladi).toBe(true);
    expect(wBasladi).toBe(0);
  });
});
