// Keşif derinliği (spec 2026-10-13 §0 b, f + B3): 57 rotalı fikstürde gerçek Chromium ile.
// Sayfa özeti ayrıntılarına (form dışı alanlar, select seçenekleri, aria-label düğmeler,
// gizli alanlar) bilerek bağlanmaz; onlar Ş1'in ve entegrasyon kabulünün işi.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { Harita } from '../../src/depo/index.js';
import {
  kesfet,
  SITEMAP_ALT_DOSYA_TAVANI,
  SITEMAP_ADRES_TAVANI,
  SITEMAP_BAYT_TAVANI,
  siteHaritasiOku,
} from '../../src/kesif/index.js';
import { locDegerleri } from '../../src/kesif/sitemap.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';
import {
  ANA_AKIS,
  BAGLANTISIZ,
  DIS_YONLENDIRMELER,
  fiksturBaslat,
  GIRIS_BILGISI,
  GIRIS_GEREKTIRENLER,
  ILLER,
  ROTALAR,
  SABLON_KOPYALARI,
  TAKMA_AD,
  TEKIL_SAYFALAR,
  YALNIZ_SITEMAP,
  YIKICI_BAGLANTI,
  type FiksturSitesi,
} from './fikstur/site.js';

const UZUN = 120_000;
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
  }
}, UZUN);

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium bu ortamda engelli: ${ozet}`);
  return false;
}

async function kesfetFikstur(site: FiksturSitesi, ek: Partial<Parameters<typeof kesfet>[0]> = {}): Promise<Harita> {
  const dizin = await geciciDizinAc('kobay-kesif-derinligi-');
  return kesfet({ baseUrl: site.url, storageStateYolu: join(dizin, 'storage.json'), ...ek });
}

const yol = (url: string): string => new URL(url).pathname;

describe('fikstür', () => {
  it('57 rota, rapordaki yapı: 8 şehir + 6 hizmet + 8 blog, 7 girişe yönlenen, 81 il', () => {
    expect(ROTALAR).toHaveLength(57);
    expect(new Set(ROTALAR).size).toBe(57);
    expect(SABLON_KOPYALARI).toHaveLength(22);
    expect(GIRIS_GEREKTIRENLER).toHaveLength(7);
    expect(ILLER).toHaveLength(81);
  });
});

describe('40 sayfa tavanında keşif derinliği (gerçek Chromium)', () => {
  let site: FiksturSitesi;
  let harita: Harita;
  let siteHaritasiz: FiksturSitesi;
  let haritaSiteHaritasiz: Harita;

  beforeAll(async () => {
    if (tarayiciEngeli) return;
    site = await fiksturBaslat();
    siteHaritasiz = await fiksturBaslat();
    harita = await kesfetFikstur(site);
    haritaSiteHaritasiz = await kesfetFikstur(siteHaritasiz, { siteHaritasi: false });
  }, UZUN);
  afterAll(async () => {
    await site?.kapat();
    await siteHaritasiz?.kapat();
  });

  it('(b) girişe yönlenen 7 rota istenen adresiyle requiresLogin kaydı; giriş sayfası bir kez normal', (context) => {
    if (!tarayiciMumkun(context)) return;
    for (const h of [harita, haritaSiteHaritasiz]) {
      const kayitlar = h.pages.filter((sayfa) => sayfa.requiresLogin === true);
      expect(kayitlar.map(({ url }) => yol(url)).sort()).toEqual([...GIRIS_GEREKTIRENLER].sort());
      for (const kayit of kayitlar) {
        expect(kayit).toMatchObject({ redirectedTo: `${new URL(kayit.url).origin}/giris`, forms: [], buttons: [], links: [] });
      }
      const girisSayfalari = h.pages.filter((sayfa) => yol(sayfa.url) === '/giris');
      expect(girisSayfalari).toHaveLength(1);
      expect(girisSayfalari[0]?.requiresLogin).toBeUndefined();
      expect(girisSayfalari[0]?.forms.length).toBeGreaterThan(0);
      // Giriş dışı yönlendirme işaretlenmez.
      expect(h.pages.some((sayfa) => yol(sayfa.url) === TAKMA_AD.eski)).toBe(false);
    }
  });

  it('(b) yönlenen adres bir kez istenir: aynı adres tekrar tekrar gezilmez', (context) => {
    if (!tarayiciMumkun(context)) return;
    for (const g of GIRIS_GEREKTIRENLER) {
      expect(siteHaritasiz.istekler.filter((satir) => satir === `GET ${g}`)).toHaveLength(1);
    }
  });

  it('(f) tavan 40 (requiresLogin dahil), şablon kopyaları kota ile sınırlı, ana akış ve tekil sayfalar içeride', (context) => {
    if (!tarayiciMumkun(context)) return;
    for (const h of [harita, haritaSiteHaritasiz]) {
      const yollar = h.pages.map(({ url }) => yol(url));
      expect(yollar).toHaveLength(40);
      for (const anaAkis of ANA_AKIS) expect(yollar).toContain(anaAkis);
      for (const tekil of TEKIL_SAYFALAR) expect(yollar).toContain(tekil);
      // Önceki sürüm aynı fikstürde 21/40 kopya gezdi (ölçüm: ana döngü raporu).
      expect(yollar.filter((y) => SABLON_KOPYALARI.includes(y)).length).toBeLessThanOrEqual(14);
    }
  });

  it('(f) sıra: tekil sayfaların hepsi ilk şablon kopyasından önce gezilir', (context) => {
    if (!tarayiciMumkun(context)) return;
    for (const h of [harita, haritaSiteHaritasiz]) {
      const yollar = h.pages.map(({ url }) => yol(url));
      const ilkKopya = yollar.findIndex((y) => SABLON_KOPYALARI.includes(y));
      const sonTekil = Math.max(...TEKIL_SAYFALAR.map((y) => yollar.indexOf(y)));
      expect(ilkKopya).toBeGreaterThan(sonTekil);
    }
  });

  it('sitemap: yalnız sitemap\'te olan sayfalar haritada, harita sitemap izini taşır; kapalıyken yok ve istenmez', (context) => {
    if (!tarayiciMumkun(context)) return;
    const yollar = harita.pages.map(({ url }) => yol(url));
    for (const y of YALNIZ_SITEMAP) expect(yollar).toContain(y);
    // 42 bağlantılı + 2 yalnız-sitemap; başka köken atıldı, sorgulu kopya tekilleşti.
    expect(harita.sitemap).toEqual({ url: `${site.url}/sitemap.xml`, urlCount: 44 });
    expect(harita.seeds).toBeUndefined();

    const kapali = haritaSiteHaritasiz.pages.map(({ url }) => yol(url));
    for (const y of YALNIZ_SITEMAP) expect(kapali).not.toContain(y);
    expect(haritaSiteHaritasiz.sitemap).toBeUndefined();
    expect(siteHaritasiz.istekler.some((satir) => satir.includes('sitemap'))).toBe(false);
  });

  it('robots.txt okunmaz, yıkıcı bağlantı ve bağlantısız rotalar istenmez', (context) => {
    if (!tarayiciMumkun(context)) return;
    for (const s of [site, siteHaritasiz]) {
      expect(s.istekler.some((satir) => satir.includes('robots.txt'))).toBe(false);
      expect(s.istekler.some((satir) => satir.startsWith(`GET ${YIKICI_BAGLANTI}`))).toBe(false);
      for (const b of BAGLANTISIZ) expect(s.istekler).not.toContain(`GET ${b}`);
    }
  });
});

describe('tohum adresi ve kimlikli keşif (gerçek Chromium)', () => {
  it('tohum aynı kökende kuyruğa girer, haritada seeds izi kalır; girişe yönlenirse requiresLogin', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const site = await fiksturBaslat({ sitemap: 'yok' });
    try {
      const harita = await kesfetFikstur(site, { tohumlar: [`${site.url}/kit`, `${site.url}/admin#x`], maxSayfa: 5, derinlik: 0 });
      expect(harita.seeds).toEqual([`${site.url}/kit`, `${site.url}/admin`]);
      expect(harita.sitemap).toBeUndefined();
      const yollar = harita.pages.map(({ url }) => yol(url));
      expect(yollar).toContain('/kit');
      expect(harita.pages.find(({ url }) => yol(url) === '/admin')).toMatchObject({ requiresLogin: true });
    } finally {
      await site.kapat();
    }
  }, UZUN);

  it('başka kökenli tohum tarayıcı açılmadan reddedilir', async () => {
    const dizin = await geciciDizinAc('kobay-kesif-derinligi-');
    await expect(kesfet({
      baseUrl: 'http://127.0.0.1:9', storageStateYolu: join(dizin, 's.json'), tohumlar: ['http://127.0.0.2:9/x'],
    })).rejects.toThrow('same origin');
  });

  it('kimlikli keşifte işaret düşer: girişe yönlenen rotalar normal gezilir, rol kapısındaki sayfa işaretlenmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const site = await fiksturBaslat({ sitemap: 'yok' });
    try {
      const harita = await kesfetFikstur(site, {
        loginUrl: `${site.url}/giris`,
        kimlik: { ...GIRIS_BILGISI, origin: site.url },
        tohumlar: [`${site.url}/admin`],
        maxSayfa: 60,
      });
      expect(harita.loggedIn).toBe(true);
      expect(harita.pages.filter((sayfa) => sayfa.requiresLogin === true)).toEqual([]);
      const yollar = harita.pages.map(({ url }) => yol(url));
      for (const g of GIRIS_GEREKTIRENLER) expect(yollar).toContain(g);
      expect(yollar).not.toContain('/admin');
    } finally {
      await site.kapat();
    }
  }, UZUN);
});

describe('köken sınırı: tespit (gerçek Chromium)', () => {
  it('köken dışına 302 veren bağlantı ve sitemap adresi: dış belge okunmaz, kayıtta yalnız köken', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const dis = await esnekSunucu((_yol, _koken, yanit) => {
      yanit.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      yanit.end('<title>Dis Portal</title><h1>Dis baslik</h1><a href="/dis-baglanti">dis</a>'
        + '<form><input name="dis-alan"><button>Dis dugme</button></form>');
    });
    const site = await fiksturBaslat({ disYonlendirme: dis.url });
    try {
      const harita = await kesfetFikstur(site, { maxSayfa: 80 });
      // Tarayıcı yönlendirmeyi izler: dışa giden yalnız yönlendirme ayağı, dış sayfanın bağlantıları istenmez.
      expect(dis.istekler.length).toBeGreaterThan(0);
      expect(dis.istekler.length).toBeLessThanOrEqual(Object.values(DIS_YONLENDIRMELER).length);
      expect(dis.istekler.every((satir) => satir === '/hedef?jeton=gizli')).toBe(true);
      for (const y of Object.values(DIS_YONLENDIRMELER)) {
        expect(harita.pages.find(({ url }) => yol(url) === y)).toMatchObject({
          requiresLogin: true, redirectedTo: dis.url, forms: [], links: [], buttons: [],
        });
      }
      const metin = JSON.stringify(harita);
      for (const iz of ['jeton', 'Dis Portal', 'Dis baslik', 'dis-baglanti', 'dis-alan', 'Dis dugme', '/hedef']) {
        expect(metin).not.toContain(iz);
      }
      expect(harita.pages.every(({ url }) => url.startsWith(site.url))).toBe(true);
    } finally {
      await site.kapat();
      await dis.kapat();
    }
  }, UZUN);

  it('gezinti sırasında açılan pencere hemen kapatılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const site = await esnekSunucu((yol, _koken, yanit) => {
      yanit.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (yol === '/') {
        yanit.end('<h1>Ana</h1><script>window.open("/acilan")</script><a href="/yavas">yavas</a>');
      } else if (yol === '/acilan') {
        yanit.end('<h1>Popup</h1><script>setTimeout(() => fetch("/popup-yasadi"), 800)</script>');
      } else if (yol === '/yavas') {
        // Keşif bu sayfada 2 sn bekler: popup açık kalsaydı bu sürede /popup-yasadi isterdi.
        setTimeout(() => yanit.end('<h1>Yavas</h1>'), 2_000);
      } else {
        yanit.end('<h1>Diger</h1>');
      }
    });
    try {
      const harita = await kesfetFikstur(
        { url: site.url, istekler: [], kapat: site.kapat },
        { siteHaritasi: false, maxSayfa: 3 },
      );
      expect(harita.pages.map(({ url }) => yol(url))).toEqual(['/', '/yavas']);
      expect(site.istekler).not.toContain('/popup-yasadi');
    } finally {
      await site.kapat();
    }
  }, UZUN);
});

describe('sitemap okuyucu', () => {
  it('sitemap index: aynı kökendeki alt sitemap\'ler okunur, başka köken ve CDATA ele alınır', async () => {
    const site = await fiksturBaslat({ sitemap: 'indeks' });
    try {
      const sonuc = await siteHaritasiOku(site.url, 5_000);
      expect(sonuc?.url).toBe(`${site.url}/sitemap.xml`);
      expect(sonuc?.adresler).toHaveLength(44);
      expect(sonuc?.adresler).toContain(`${site.url}/kampanya`);
      expect(sonuc?.adresler).toContain(`${site.url}${SABLON_KOPYALARI[0] ?? ''}`);
      expect(sonuc?.adresler.every((a) => a.startsWith(site.url) && !a.includes('?'))).toBe(true);
      expect(site.istekler.filter((satir) => satir.includes('sitemap'))).toEqual([
        'GET /sitemap.xml', 'GET /sitemap-sayfalar.xml', 'GET /sitemap-icerik.xml',
      ]);
    } finally {
      await site.kapat();
    }
  });

  it('sitemap yoksa ya da XML değilse null', async () => {
    const site = await fiksturBaslat({ sitemap: 'yok' });
    try {
      expect(await siteHaritasiOku(site.url, 5_000)).toBeNull();
    } finally {
      await site.kapat();
    }
    const html = await sunucu((_yol) => '<!doctype html><html><body><a href="/x">x</a></body></html>');
    try {
      expect(await siteHaritasiOku(html.url, 5_000)).toBeNull();
    } finally {
      await html.kapat();
    }
  });

  it(`index'ten en çok ${SITEMAP_ALT_DOSYA_TAVANI} alt sitemap okunur`, async () => {
    const sunucu21 = await esnekSunucu((yol, koken, yanit) => {
      if (yol === '/sitemap.xml') {
        yanit.end(`<sitemapindex>${Array.from({ length: 21 }, (_d, i) => `<sitemap><loc>${koken}/c${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`);
        return;
      }
      yanit.end(`<urlset><url><loc>${koken}/s${yol.slice(2, -4)}</loc></url></urlset>`);
    });
    try {
      const sonuc = await siteHaritasiOku(sunucu21.url, 5_000);
      expect(sonuc?.adresler).toHaveLength(SITEMAP_ALT_DOSYA_TAVANI);
      expect(sunucu21.istekler).not.toContain('/c20.xml');
      expect(sunucu21.istekler).toHaveLength(1 + SITEMAP_ALT_DOSYA_TAVANI);
    } finally {
      await sunucu21.kapat();
    }
  });

  it('tek süre sınırı: takılan alt sitemap okumanın kalanını keser, sonraki alt dosya istenmez', async () => {
    const takilan = await esnekSunucu((yol, koken, yanit) => {
      if (yol === '/sitemap.xml') {
        yanit.end(`<sitemapindex>${['c0', 'c1', 'c2'].map((ad) => `<sitemap><loc>${koken}/${ad}.xml</loc></sitemap>`).join('')}</sitemapindex>`);
        return;
      }
      if (yol === '/c1.xml') return; // yanıt hiç gelmez
      yanit.end(`<urlset><url><loc>${koken}/${yol.slice(1, -4)}-sayfa</loc></url></urlset>`);
    });
    try {
      const sonuc = await siteHaritasiOku(takilan.url, 1_000);
      expect(sonuc?.adresler).toEqual([`${takilan.url}/c0-sayfa`]);
      expect(takilan.istekler).toEqual(['/sitemap.xml', '/c0.xml', '/c1.xml']);
    } finally {
      await takilan.kapat();
    }
  });

  it('tek süre sınırı: her alt dosya sınırın altında yanıt verse de toplam okuma tek sınırda kesilir', async () => {
    const yavasCocuk = await esnekSunucu((yol, koken, yanit) => {
      if (yol === '/sitemap.xml') {
        yanit.end(`<sitemapindex>${Array.from({ length: 20 }, (_d, i) => `<sitemap><loc>${koken}/c${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`);
        return;
      }
      // Her çocuk 400 ms sonra yanıt verir (sınır 1 sn): dosya başı sınır olsaydı 20'si de okunurdu.
      setTimeout(() => yanit.end(`<urlset><url><loc>${koken}/s${yol.slice(2, -4)}</loc></url></urlset>`), 400);
    });
    try {
      await siteHaritasiOku(yavasCocuk.url, 1_000);
      const cocukIstekleri = yavasCocuk.istekler.filter((satir) => satir !== '/sitemap.xml').length;
      expect(cocukIstekleri).toBeGreaterThanOrEqual(1);
      expect(cocukIstekleri).toBeLessThanOrEqual(6);
    } finally {
      await yavasCocuk.kapat();
    }
  });

  it('geçerli bir kayıttan sonra kapanışsız binlerce <loc> doğrusal taranır', { timeout: 5_000 }, () => {
    const govde = `<urlset><loc>http://x/ilk</loc>${'<loc>http://x/a'.repeat(70_000)}`;
    expect(govde.length).toBeGreaterThan(SITEMAP_BAYT_TAVANI * 0.9);
    expect(locDegerleri(govde)).toEqual(['http://x/ilk']);
    expect(locDegerleri('<urlset><sm:loc>http://x/a</sm:loc><loc>http://x/b</loc><loc>http://x/c')).toEqual(['http://x/a', 'http://x/b']);
  });

  it(`adres tavanı ${SITEMAP_ADRES_TAVANI}, bayt tavanı ${SITEMAP_BAYT_TAVANI}`, async () => {
    const cok = await sunucu((_yol, koken) => `<urlset>${Array.from({ length: 700 }, (_d, i) => `<url><loc>${koken}/s/${i}</loc></url>`).join('')}</urlset>`);
    try {
      const sonuc = await siteHaritasiOku(cok.url, 5_000);
      expect(sonuc?.adresler).toHaveLength(SITEMAP_ADRES_TAVANI);
      expect(sonuc?.adresler[0]).toBe(`${cok.url}/s/0`);
    } finally {
      await cok.kapat();
    }
    // Sonu gelmeyen dosya: ilk 1 MB'taki tam <loc> kayıtları okunur, okuma orada kesilir (bellek ve süre sınırı).
    const sonsuz = await sonsuzSunucu();
    try {
      expect((await siteHaritasiOku(sonsuz.url, 3_000))?.adresler).toEqual([`${sonsuz.url}/once`]);
    } finally {
      await sonsuz.kapat();
    }
  });
});

/** `/sitemap.xml` isteğine verilen gövdeyi dönen küçük sunucu. */
async function sunucu(govde: (yol: string, koken: string) => string): Promise<{ url: string; kapat: () => Promise<void> }> {
  const s: Server = createServer((istek, yanit) => {
    const koken = `http://${istek.headers.host ?? ''}`;
    if (istek.url !== '/sitemap.xml') {
      yanit.writeHead(404);
      yanit.end();
      return;
    }
    yanit.writeHead(200, { 'content-type': 'application/xml' });
    yanit.end(govde(istek.url, koken));
  });
  await new Promise<void>((coz) => s.listen(0, '127.0.0.1', () => coz()));
  return {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    kapat: () => new Promise<void>((coz) => { s.closeAllConnections(); s.close(() => coz()); }),
  };
}

/** `/sitemap.xml` gövdesini istemci bırakana kadar akıtan sunucu: başta bir kayıt, sonra bitmeyen yorum. */
async function sonsuzSunucu(): Promise<{ url: string; kapat: () => Promise<void> }> {
  const parca = 'x'.repeat(64 * 1024);
  const s: Server = createServer((istek, yanit) => {
    yanit.writeHead(200, { 'content-type': 'application/xml' });
    yanit.write(`<urlset><url><loc>http://${istek.headers.host ?? ''}/once</loc></url><!--`);
    const akit = (): void => {
      while (!yanit.destroyed && yanit.write(parca)) { /* tampon dolana kadar */ }
      if (!yanit.destroyed) yanit.once('drain', akit);
    };
    akit();
  });
  await new Promise<void>((coz) => s.listen(0, '127.0.0.1', () => coz()));
  return {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    kapat: () => new Promise<void>((coz) => { s.closeAllConnections(); s.close(() => coz()); }),
  };
}

/** Her isteği yol olarak kaydeden, yanıtı işleyiciye bırakan sunucu (işleyici yanıtlamazsa istek asılı kalır). */
async function esnekSunucu(
  isleyici: (yol: string, koken: string, yanit: import('node:http').ServerResponse) => void,
): Promise<{ url: string; istekler: string[]; kapat: () => Promise<void> }> {
  const istekler: string[] = [];
  const s: Server = createServer((istek, yanit) => {
    istekler.push(istek.url ?? '');
    isleyici(new URL(istek.url ?? '/', 'http://x').pathname, `http://${istek.headers.host ?? ''}`, yanit);
  });
  await new Promise<void>((coz) => s.listen(0, '127.0.0.1', () => coz()));
  return {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    istekler,
    kapat: () => new Promise<void>((coz) => { s.closeAllConnections(); s.close(() => coz()); }),
  };
}
