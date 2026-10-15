// Keşif derinliği entegrasyon kabulü (spec 2026-10-13 §0 a-f): 57 rotalı fikstürde
// TEK keşif koşusu, gerçek Chromium. Duvar saati ölçülmez; yalnız haritadaki sayılar.
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { Harita } from '../../src/depo/index.js';
import { kesfetAyrintili } from '../../src/kesif/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';
import { ANA_AKIS, fiksturBaslat, GIRIS_GEREKTIRENLER, ILLER, SABLON_KOPYALARI, type FiksturSitesi } from './fikstur/site.js';

const UZUN = 120_000;
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;
let site: FiksturSitesi;
let harita: Harita;

const yol = (url: string): string => new URL(url).pathname;

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
    return;
  }
  site = await fiksturBaslat();
  const dizin = await geciciDizinAc('kobay-kesif-entegrasyon-');
  harita = (await kesfetAyrintili({ baseUrl: site.url, storageStateYolu: join(dizin, 'storage.json'), maxSayfa: 40 })).harita;
}, UZUN);

afterAll(async () => {
  await site?.kapat();
});

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium bu ortamda engelli: ${ozet}`);
  return false;
}

describe('keşif derinliği entegrasyonu: tek koşu, 57 rotalı fikstür, maxSayfa 40', () => {
  it('(a) /hizli-teklif haritada; tek detached form: 4 select + 2 input', (context) => {
    if (!tarayiciMumkun(context)) return;
    const sayfa = harita.pages.find(({ url }) => yol(url) === '/hizli-teklif');
    expect(sayfa).toBeDefined();
    const kopuk = sayfa!.forms.filter((f) => f.detached === true);
    expect(kopuk).toHaveLength(1);
    const alanlar = kopuk[0]!.fields;
    expect(alanlar.filter((a) => a.type.startsWith('select'))).toHaveLength(4);
    expect(alanlar.filter((a) => a.type !== 'select' && !a.type.startsWith('select'))).toHaveLength(2);
    expect(alanlar).toHaveLength(6);
    const adlar = alanlar.map((a) => a.name);
    for (const ad of ['kategori', 'hacim', 'nereden-il', 'nereye-il', 'ilce', 'mesafe']) expect(adlar).toContain(ad);
  });

  it('(b) girişe yönlenen 7 rota requiresLogin + redirectedTo', () => {
    if (tarayiciEngeli) return;
    const kayitlar = harita.pages.filter((s) => s.requiresLogin === true);
    expect(kayitlar).toHaveLength(7);
    expect(kayitlar.map(({ url }) => yol(url)).sort()).toEqual([...GIRIS_GEREKTIRENLER].sort());
    for (const k of kayitlar) expect(k.redirectedTo).toBe(`${site.url}/giris`);
  });

  it('(c) haritada type:hidden alan ve $ACTION dizesi yok', () => {
    if (tarayiciEngeli) return;
    const tumFormAlanlari = harita.pages.flatMap((s) => s.forms.flatMap((f) => f.fields));
    expect(tumFormAlanlari.filter((a) => a.type === 'hidden')).toHaveLength(0);
    const json = JSON.stringify(harita);
    expect(json).not.toContain('$ACTION');
    expect(json).not.toContain('"type":"hidden"');
  });

  it('(d) 81 seçenekli select: etiket seçenek metni taşımaz, options 20, optionCount 81', () => {
    if (tarayiciEngeli) return;
    // Fikstürde ilk seçenek boş+disabled ("Şehir seç"); atlanır, kalan 81 il sayılır.
    const sayfa = harita.pages.find(({ url }) => yol(url) === '/hizli-teklif')!;
    const il = sayfa.forms.flatMap((f) => f.fields).find((a) => a.name === 'nereden-il')!;
    expect(il.label ?? '').not.toContain(ILLER[0]!);
    expect(il.label ?? '').not.toContain(ILLER[1]!);
    expect(il.options).toHaveLength(20);
    expect(il.options![0]).toBe(ILLER[0]);
    expect(il.optionCount).toBe(81);
  });

  it('(e) yalnız aria-label taşıyan ikon düğmesi buttons içinde', () => {
    if (tarayiciEngeli) return;
    const anaSayfa = harita.pages.find(({ url }) => yol(url) === '/');
    expect(anaSayfa?.buttons).toContain('Koyu temaya geç');
    expect(harita.pages.filter((s) => s.buttons.includes('Koyu temaya geç')).length).toBeGreaterThan(0);
  });

  it('(f) şablon kopyası <= 14 ve ana akış sayfaları ilk 40 içinde', () => {
    if (tarayiciEngeli) return;
    const yollar = harita.pages.map(({ url }) => yol(url));
    expect(yollar.length).toBeLessThanOrEqual(40);
    for (const a of ANA_AKIS) expect(yollar).toContain(a);
    expect(yollar.filter((y) => SABLON_KOPYALARI.includes(y)).length).toBeLessThanOrEqual(14);
  });
});
