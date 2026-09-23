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
    loginUrl: `${demo.url}/login`,
    kimlik: { username: 'demo', password: 'demo123', origin: new URL(demo.url).origin },
    storageStateYolu,
  });
  return { harita, storageStateYolu };
}

/** Haritadaki bir sayfayı bayatlatır: ürün "Cariler" olarak yeniden adlandırılmış gibi. */
function bayatlat(harita: Harita, yol: string): Harita {
  return {
    ...harita,
    pages: harita.pages.map((sayfa) => (new URL(sayfa.url).pathname === yol
      ? {
        ...sayfa,
        title: 'Cariler',
        headings: ['Cariler'],
        buttons: ['Kaldır'],
      }
      : sayfa)),
  };
}

describe('sayfayiYenile', () => {
  it('yenilemede farklı origin loginUrl ile kimlik göndermeden reddeder', async () => {
    const dizin = await mkdtemp(join(tmpdir(), 'kobay-yenile-origin-'));
    await expect(sayfayiYenile({
      baseUrl: 'http://uygulama.test',
      url: '/records',
      storageStateYolu: join(dizin, 'storage.json'),
      loginUrl: 'https://kimlik.test/giris',
      kimlik: { username: 'demo', password: 'gizli' },
    })).rejects.toThrow('same origin as baseUrl');
  });

  it('tek sayfayı gerçek tarayıcıyla yeniler, haritadaki diğer sayfalara dokunmaz', async (context) => {
    if (!e2eMumkun(context)) return;
    const { harita, storageStateYolu } = await girisliHarita();
    const bayat = bayatlat(harita, '/records');
    const digerleriOnce = bayat.pages
      .filter((sayfa) => new URL(sayfa.url).pathname !== '/records')
      .map((sayfa) => JSON.stringify(sayfa));

    const yeniSayfa = await sayfayiYenile({ baseUrl: demo.url, url: '/records', storageStateYolu });
    const sonuc = haritadaSayfayiDegistir(bayat, '/records', yeniSayfa);

    expect(sonuc).not.toBeNull();
    expect(yeniSayfa.title).toBe('Record List');
    expect(yeniSayfa.headings).toContain('Record List');
    expect(yeniSayfa.buttons).toContain('Delete');
    expect(sonuc?.eskiSayfa.title).toBe('Cariler');

    const guncel = sonuc?.harita as Harita;
    expect(guncel.pages).toHaveLength(bayat.pages.length);
    expect(guncel.pages.map((sayfa) => new URL(sayfa.url).pathname))
      .toEqual(['/login', '/', '/records', '/new']);
    expect(guncel.pages[2]?.title).toBe('Record List');
    expect(guncel.pages
      .filter((sayfa) => new URL(sayfa.url).pathname !== '/records')
      .map((sayfa) => JSON.stringify(sayfa))).toEqual(digerleriOnce);
    expect(guncel.baseUrl).toBe(bayat.baseUrl);
    expect(guncel.loggedIn).toBe(bayat.loggedIn);
  });

  it('oturum yokken kimlikle yeniden giriş yapıp istenen sayfayı döndürür', async (context) => {
    if (!e2eMumkun(context)) return;
    const dizin = await mkdtemp(join(tmpdir(), 'kobay-yenile-oturumsuz-'));
    const storageStateYolu = join(dizin, 'storage.json');

    const yeniSayfa = await sayfayiYenile({
      baseUrl: demo.url,
      url: '/records',
      storageStateYolu,
      loginUrl: `${demo.url}/login`,
      kimlik: { username: 'demo', password: 'demo123', origin: new URL(demo.url).origin },
    });

    expect(new URL(yeniSayfa.url).pathname).toBe('/records');
    expect(yeniSayfa.title).toBe('Record List');
  });

  it('oturum yok ve kimlik yoksa yanlış sayfanın özetini döndürmez', async (context) => {
    if (!e2eMumkun(context)) return;
    const dizin = await mkdtemp(join(tmpdir(), 'kobay-yenile-yetkisiz-'));

    await expect(sayfayiYenile({
      baseUrl: demo.url,
      url: '/records',
      storageStateYolu: join(dizin, 'storage.json'),
    })).rejects.toThrow(/Page could not be refreshed/);
  });
});

describe('haritadaSayfayiDegistir', () => {
  const sayfa = (url: string, title: string): Sayfa => ({
    url, title, headings: [title], links: [], forms: [], buttons: [], menu: [],
  });
  const harita: Harita = {
    baseUrl: 'http://uygulama.test',
    loggedIn: true,
    exploredAt: '2026-09-17T00:00:00.000Z',
    pages: [
      sayfa('http://uygulama.test/', 'Ana'),
      sayfa('http://uygulama.test/cariler', 'Cariler'),
    ],
  };

  it('göreli URL’yi yol eşleşmesiyle bulur', () => {
    expect(haritadaSayfaBul(harita, '/cariler')?.title).toBe('Cariler');
    expect(haritadaSayfaBul(harita, 'http://uygulama.test/cariler')?.title).toBe('Cariler');
  });

  it('haritada olmayan sayfa için null döner ve haritayı değiştirmez', () => {
    expect(haritadaSayfaBul(harita, '/faturalar')).toBeNull();
    expect(haritadaSayfayiDegistir(harita, '/faturalar', sayfa('http://uygulama.test/faturalar', 'Faturalar')))
      .toBeNull();
    expect(harita.pages).toHaveLength(2);
  });

  it('değiştirilen haritayı yeni nesne olarak döndürür, exploredAt’ni günceller', () => {
    const sonuc = haritadaSayfayiDegistir(harita, '/cariler', sayfa('http://uygulama.test/cariler', 'Müşteriler'));
    expect(sonuc?.harita.pages[1]?.title).toBe('Müşteriler');
    expect(sonuc?.harita.exploredAt).not.toBe(harita.exploredAt);
    expect(harita.pages[1]?.title).toBe('Cariler');
  });
});
