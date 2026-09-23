import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { Harita, Sayfa } from '../../src/depo/index.js';
import { haritadaSayfaBul, haritadaSayfayiDegistir, kesfet, sayfayiYenile } from '../../src/kesif/index.js';
import { baslat } from '../kobay-demo/sunucu.mjs';

let demo: { url: string; kapat: () => Promise<void> };
let engel: unknown;

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
    demo = await baslat(0);
  } catch (hata) {
    engel = hata;
  }
});
afterAll(async () => { if (demo) await demo.kapat(); });

function e2eMumkun(context: TestContext): boolean {
  if (!engel) return true;
  context.skip(`Gerçek Chromium E2E bu ortamda engelli: ${String(engel).split('\n')[0] ?? ''}`);
  return false;
}

async function girisliHarita(): Promise<{ harita: Harita; storageStateYolu: string }> {
  const dizin = await mkdtemp(join(tmpdir(), 'kobay-yenile-'));
  const storageStateYolu = join(dizin, 'storage.json');
  const harita = await kesfet({
    baseUrl: demo.url,
    loginUrl: `${demo.url}/giris`,
    kimlik: { kullanici: 'demo', parola: 'demo123', origin: new URL(demo.url).origin },
    storageStateYolu,
  });
  return { harita, storageStateYolu };
}

/** Haritadaki bir sayfayı bayatlatır: ürün "Cariler" olarak yeniden adlandırılmış gibi. */
function bayatlat(harita: Harita, yol: string): Harita {
  return {
    ...harita,
    sayfalar: harita.sayfalar.map((sayfa) => (new URL(sayfa.url).pathname === yol
      ? {
        ...sayfa,
        baslik: 'Cariler',
        basliklar: ['Cariler'],
        dugmeler: ['Kaldır'],
      }
      : sayfa)),
  };
}

describe('sayfayiYenile', () => {
  it('yenilemede farklı origin loginUrl ile kimlik göndermeden reddeder', async () => {
    const dizin = await mkdtemp(join(tmpdir(), 'kobay-yenile-origin-'));
    await expect(sayfayiYenile({
      baseUrl: 'http://uygulama.test',
      url: '/liste',
      storageStateYolu: join(dizin, 'storage.json'),
      loginUrl: 'https://kimlik.test/giris',
      kimlik: { kullanici: 'demo', parola: 'gizli' },
    })).rejects.toThrow('aynı origin');
  });

  it('tek sayfayı gerçek tarayıcıyla yeniler, haritadaki diğer sayfalara dokunmaz', async (context) => {
    if (!e2eMumkun(context)) return;
    const { harita, storageStateYolu } = await girisliHarita();
    const bayat = bayatlat(harita, '/liste');
    const digerleriOnce = bayat.sayfalar
      .filter((sayfa) => new URL(sayfa.url).pathname !== '/liste')
      .map((sayfa) => JSON.stringify(sayfa));

    const yeniSayfa = await sayfayiYenile({ baseUrl: demo.url, url: '/liste', storageStateYolu });
    const sonuc = haritadaSayfayiDegistir(bayat, '/liste', yeniSayfa);

    expect(sonuc).not.toBeNull();
    expect(yeniSayfa.baslik).toBe('Kayıt Listesi');
    expect(yeniSayfa.basliklar).toContain('Kayıt Listesi');
    expect(yeniSayfa.dugmeler).toContain('Sil');
    expect(sonuc?.eskiSayfa.baslik).toBe('Cariler');

    const guncel = sonuc?.harita as Harita;
    expect(guncel.sayfalar).toHaveLength(bayat.sayfalar.length);
    expect(guncel.sayfalar.map((sayfa) => new URL(sayfa.url).pathname))
      .toEqual(['/giris', '/', '/liste', '/yeni']);
    expect(guncel.sayfalar[2]?.baslik).toBe('Kayıt Listesi');
    expect(guncel.sayfalar
      .filter((sayfa) => new URL(sayfa.url).pathname !== '/liste')
      .map((sayfa) => JSON.stringify(sayfa))).toEqual(digerleriOnce);
    expect(guncel.baseUrl).toBe(bayat.baseUrl);
    expect(guncel.girisYapildi).toBe(bayat.girisYapildi);
  });

  it('oturum yokken kimlikle yeniden giriş yapıp istenen sayfayı döndürür', async (context) => {
    if (!e2eMumkun(context)) return;
    const dizin = await mkdtemp(join(tmpdir(), 'kobay-yenile-oturumsuz-'));
    const storageStateYolu = join(dizin, 'storage.json');

    const yeniSayfa = await sayfayiYenile({
      baseUrl: demo.url,
      url: '/liste',
      storageStateYolu,
      loginUrl: `${demo.url}/giris`,
      kimlik: { kullanici: 'demo', parola: 'demo123', origin: new URL(demo.url).origin },
    });

    expect(new URL(yeniSayfa.url).pathname).toBe('/liste');
    expect(yeniSayfa.baslik).toBe('Kayıt Listesi');
  });

  it('oturum yok ve kimlik yoksa yanlış sayfanın özetini döndürmez', async (context) => {
    if (!e2eMumkun(context)) return;
    const dizin = await mkdtemp(join(tmpdir(), 'kobay-yenile-yetkisiz-'));

    await expect(sayfayiYenile({
      baseUrl: demo.url,
      url: '/liste',
      storageStateYolu: join(dizin, 'storage.json'),
    })).rejects.toThrow(/Sayfa yenilenemedi/);
  });
});

describe('haritadaSayfayiDegistir', () => {
  const sayfa = (url: string, baslik: string): Sayfa => ({
    url, baslik, basliklar: [baslik], linkler: [], formlar: [], dugmeler: [], menu: [],
  });
  const harita: Harita = {
    baseUrl: 'http://uygulama.test',
    girisYapildi: true,
    kesifTarihi: '2026-09-17T00:00:00.000Z',
    sayfalar: [
      sayfa('http://uygulama.test/', 'Ana'),
      sayfa('http://uygulama.test/cariler', 'Cariler'),
    ],
  };

  it('göreli URL’yi yol eşleşmesiyle bulur', () => {
    expect(haritadaSayfaBul(harita, '/cariler')?.baslik).toBe('Cariler');
    expect(haritadaSayfaBul(harita, 'http://uygulama.test/cariler')?.baslik).toBe('Cariler');
  });

  it('haritada olmayan sayfa için null döner ve haritayı değiştirmez', () => {
    expect(haritadaSayfaBul(harita, '/faturalar')).toBeNull();
    expect(haritadaSayfayiDegistir(harita, '/faturalar', sayfa('http://uygulama.test/faturalar', 'Faturalar')))
      .toBeNull();
    expect(harita.sayfalar).toHaveLength(2);
  });

  it('değiştirilen haritayı yeni nesne olarak döndürür, kesifTarihi’ni günceller', () => {
    const sonuc = haritadaSayfayiDegistir(harita, '/cariler', sayfa('http://uygulama.test/cariler', 'Müşteriler'));
    expect(sonuc?.harita.sayfalar[1]?.baslik).toBe('Müşteriler');
    expect(sonuc?.harita.kesifTarihi).not.toBe(harita.kesifTarihi);
    expect(harita.sayfalar[1]?.baslik).toBe('Cariler');
  });
});
