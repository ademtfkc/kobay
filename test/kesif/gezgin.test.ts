import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/kesif/sayfa-ozeti.js', () => ({ sayfaOzeti: vi.fn() }));

import { baglantiIzlenebilir, gez, slugOnekleriBul, SLUG_ESIGI, urlKalibi } from '../../src/kesif/gezgin.js';
import { sayfaOzeti } from '../../src/kesif/sayfa-ozeti.js';

const sayfaOzetiSahte = vi.mocked(sayfaOzeti);

describe('baglantiIzlenebilir', () => {
  it.each(['Çıkış', 'LOGOUT', 'Sil kaydı', 'remove item'])('yıkıcı bağlantıyı reddeder: %s', (metin) => {
    expect(baglantiIzlenebilir(metin)).toBe(false);
  });

  it('normal bağlantıyı kabul eder', () => {
    expect(baglantiIzlenebilir('New Record')).toBe(true);
  });
});

describe('URL kalıbı kotası', () => {
  it('sayısal ve UUID-benzeri parçaları aynı kalıba indirger', () => {
    expect(urlKalibi('https://uygulama.test/cariler/31')).toBe('/cariler/:id');
    expect(urlKalibi('https://uygulama.test/cariler/550e8400-e29b-41d4-a716-446655440000')).toBe('/cariler/:id');
  });

  it('aynı kalıptan yalnız iki, farklı kalıplardan ikişer sayfayı gezer', async () => {
    const baglantilar: Record<string, Array<{ href: string; metin: string }>> = {
      'https://uygulama.test/': [
        ...Array.from({ length: 10 }, (_deger, sira) => ({ href: `https://uygulama.test/x/${sira + 1}`, metin: 'Kayıt' })),
        { href: 'https://uygulama.test/y/1', metin: 'Diğer kayıt' },
        { href: 'https://uygulama.test/y/2', metin: 'Diğer kayıt' },
      ],
    };
    let etkinUrl = '';
    const gezilen: string[] = [];
    const sayfa = {
      goto: vi.fn(async (url: string) => {
        etkinUrl = url;
        gezilen.push(url);
      }),
      locator: vi.fn(() => ({
        evaluateAll: async (isleyici: (elemanlar: unknown[]) => unknown) => isleyici(baglantilar[etkinUrl] ?? []),
      })),
    } as unknown as Page;
    sayfaOzetiSahte.mockImplementation(async () => ({
      url: etkinUrl, title: '', headings: [], links: [], forms: [], buttons: [], menu: [],
    }));

    await gez(sayfa, {
      baseUrl: 'https://uygulama.test/', maxSayfa: 20, derinlik: 1, sayfaZamanAsimiMs: 1,
    });

    expect(gezilen.filter((url) => url.startsWith('https://uygulama.test/x/'))).toHaveLength(2);
    expect(gezilen.filter((url) => url.startsWith('https://uygulama.test/y/'))).toHaveLength(2);
  });
});

const T = 'https://uygulama.test';
const yollar = (onek: string, adlar: string[]) => adlar.map((ad) => `${onek}/${ad}`);
const sehirler = ['istanbul', 'ankara', 'izmir', 'bursa', 'adana', 'konya', 'mersin', 'van'];

/** Arkadaşın sitesi biçiminde korpus. */
const korpus = [
  '/', '/iletisim', '/hizli-teklif', '/giris', '/hakkimizda',
  ...yollar('/sehir', sehirler),
  ...yollar('/hizmet', ['a', 'b', 'c', 'd', 'e', 'f']),
  ...yollar('/blog', ['y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7', 'y8']),
  ...yollar('/yardim', ['sss', 'destek']),
  ...yollar('/tasiyicilar', ['x', 'y']),
  '/talep/123', '/talep/456',
];

describe('slug kalıbı', () => {
  it('eşik sabiti 5 ve kümeyi yalnız üst yollar için bulur', () => {
    expect(SLUG_ESIGI).toBe(5);
    expect([...slugOnekleriBul(korpus)].sort()).toEqual(['/blog', '/hizmet', '/sehir']);
  });

  it('korpusta isimli adresleri :slug, sayıları :id yapar; kök ve eşik altı kalır', () => {
    const slug = slugOnekleriBul(korpus);
    const k = (yol: string) => urlKalibi(`${T}${yol}`, slug);
    expect(k('/sehir/istanbul')).toBe('/sehir/:slug');
    expect(k('/hizmet/a')).toBe('/hizmet/:slug');
    expect(k('/blog/y3')).toBe('/blog/:slug');
    expect(k('/')).toBe('/');
    expect(k('/iletisim')).toBe('/iletisim');
    expect(k('/hizli-teklif')).toBe('/hizli-teklif');
    expect(k('/giris')).toBe('/giris');
    expect(k('/hakkimizda')).toBe('/hakkimizda');
    expect(k('/yardim/sss')).toBe('/yardim/sss');
    expect(k('/tasiyicilar/x')).toBe('/tasiyicilar/x');
    expect(k('/talep/123')).toBe('/talep/:id');
    expect(k('/sehir')).toBe('/sehir');
  });

  it('kökün altındaki çok sayıda segment toplanmaz', () => {
    const kok = Array.from({ length: 12 }, (_d, i) => `/sayfa-${i}`);
    expect(slugOnekleriBul(kok).size).toBe(0);
  });

  it('4 alt segmentli üst yol eşik altındadır; 5. segment kümeyi tetikler', () => {
    expect(slugOnekleriBul(yollar('/p', ['a', 'b', 'c', 'd'])).size).toBe(0);
    expect([...slugOnekleriBul(yollar('/p', ['a', 'b', 'c', 'd', 'e']))]).toEqual(['/p']);
  });

  it('sayı/UUID alt segmentler eşiğe sayılmaz', () => {
    expect(slugOnekleriBul(yollar('/p', ['1', '2', '3', '4', '5', 'a', 'b'])).size).toBe(0);
  });

  it('eski davranış: slug kümesi yokken yalnız sayı/UUID değişir', () => {
    expect(urlKalibi(`${T}/sehir/istanbul`)).toBe('/sehir/istanbul');
    expect(urlKalibi(`${T}/cariler/0123456789abcdef0123456789abcdef`)).toBe('/cariler/:id');
  });

  it('daha derin yol: /sehir/:slug/kadikoy ve slug son segment olmayabilir', () => {
    const slug = slugOnekleriBul([...korpus, '/sehir/istanbul/kadikoy', '/sehir/ankara/cankaya']);
    expect(urlKalibi(`${T}/sehir/istanbul/kadikoy`, slug)).toBe('/sehir/:slug/kadikoy');
  });

  it('tek sayfada 20 şehir bağlantısı varken desenden en çok kalipBasinaSayfa sayfa gezilir, kök sayfalar tamamen gezilir', async () => {
    const baglanti = (yol: string) => ({ href: `${T}${yol}`, metin: 'Bağlantı' });
    const ana = [
      ...['/iletisim', '/hizli-teklif', '/giris', '/hakkimizda'].map(baglanti),
      ...Array.from({ length: 20 }, (_d, i) => baglanti(`/sehir/il-${i}`)),
    ];
    let etkinUrl = '';
    const gezilen: string[] = [];
    const sayfa = {
      goto: vi.fn(async (url: string) => { etkinUrl = url; gezilen.push(url); }),
      locator: vi.fn(() => ({
        evaluateAll: async (isleyici: (elemanlar: unknown[]) => unknown) =>
          isleyici(etkinUrl === `${T}/` ? ana : []),
      })),
    } as unknown as Page;
    sayfaOzetiSahte.mockImplementation(async () => ({
      url: etkinUrl, title: '', headings: [], links: [], forms: [], buttons: [], menu: [],
    }));

    await gez(sayfa, { baseUrl: `${T}/`, maxSayfa: 7, derinlik: 1, sayfaZamanAsimiMs: 1 });

    expect(gezilen.filter((url) => url.startsWith(`${T}/sehir/`))).toHaveLength(2);
    for (const yol of ['/iletisim', '/hizli-teklif', '/giris', '/hakkimizda']) {
      expect(gezilen).toContain(`${T}${yol}`);
    }
  });
});

/** Sahte site: yol -> o sayfadaki bağlantı yolları. Gezilen adresleri sırayla döner. */
async function gezSahte(site: Record<string, string[]>, maxSayfa: number, derinlik = 2): Promise<string[]> {
  let etkinUrl = '';
  const gezilen: string[] = [];
  const sayfa = {
    goto: vi.fn(async (url: string) => { etkinUrl = url; gezilen.push(url); }),
    locator: vi.fn(() => ({
      evaluateAll: async (isleyici: (elemanlar: unknown[]) => unknown) =>
        isleyici((site[new URL(etkinUrl).pathname] ?? []).map((yol) => ({ href: `${T}${yol}`, metin: 'Bağlantı' }))),
    })),
  } as unknown as Page;
  sayfaOzetiSahte.mockImplementation(async () => ({
    url: etkinUrl, title: '', headings: [], links: [], forms: [], buttons: [], menu: [],
  }));
  await gez(sayfa, { baseUrl: `${T}/`, maxSayfa, derinlik, sayfaZamanAsimiMs: 1 });
  return gezilen.map((url) => new URL(url).pathname);
}

describe('slug kalıbı: kuyruk, erteleme, normalleştirme', () => {
  it('farklı sayfalardan tek tek gelen şehirlerden ana sırada en çok 2 gezilir', async () => {
    const harfler = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const site: Record<string, string[]> = {
      '/': [...harfler.map((h) => `/hub-${h}`), '/iletisim'],
      ...Object.fromEntries(harfler.map((h) => [`/hub-${h}`, h === 'g' ? [`/sehir/${h}`, '/son'] : [`/sehir/${h}`]])),
    };
    // Bütçe: kök + iletişim + 7 hub + 2 şehir + /son. Bayat kuyrukta 7 şehir /son'dan önce gezilirdi.
    const gezilen = await gezSahte(site, 12);
    expect(gezilen.filter((yol) => yol.startsWith('/sehir/'))).toHaveLength(2);
    expect(gezilen).toContain('/son');
  });

  it('işlevsel alt sayfalar atılmaz, ertelenir: eşsiz sayfalardan sonra hepsi gezilir', async () => {
    const admin = ['kullanicilar', 'raporlar', 'talepler', 'kategoriler', 'dogrulama', 'bildirimler', 'anlasmazlik'];
    const site: Record<string, string[]> = {
      '/': [...admin.map((a) => `/admin/${a}`), '/iletisim', '/giris', '/hakkimizda'],
    };
    const bol = await gezSahte(site, 40);
    for (const a of admin) expect(bol).toContain(`/admin/${a}`);
    const sonEssiz = Math.max(...['/iletisim', '/giris', '/hakkimizda'].map((y) => bol.indexOf(y)));
    const ilkErtelenen = bol.findIndex((yol, sira) => sira > 2 && yol.startsWith('/admin/') && bol.slice(0, sira).filter((y) => y.startsWith('/admin/')).length >= 2);
    expect(ilkErtelenen).toBeGreaterThan(sonEssiz);
    // kısıtlı bütçe: kök + 3 eşsiz + 2 admin
    const dar = await gezSahte(site, 6);
    expect(dar).toEqual(expect.arrayContaining(['/iletisim', '/giris', '/hakkimizda']));
    expect(dar.filter((yol) => yol.startsWith('/admin/'))).toHaveLength(2);
  });

  it(':id deseninde kota aşımı hâlâ atılır (ertelenmez)', async () => {
    const site: Record<string, string[]> = { '/': ['/talep/1', '/talep/2', '/talep/3', '/talep/4'] };
    const gezilen = await gezSahte(site, 40);
    expect(gezilen.filter((yol) => yol.startsWith('/talep/'))).toHaveLength(2);
  });

  it('yüzde-kodlu sayılar :id olur', () => {
    const slug = slugOnekleriBul(['%31', '%32', '%33', '%34', '%35'].map((s) => `/siparis/${s}`));
    expect(slug.size).toBe(0);
    expect(urlKalibi(`${T}/siparis/%31`)).toBe('/siparis/:id');
    expect(urlKalibi(`${T}/siparis/%E0%A4%A`)).toBe('/siparis/%E0%A4%A');
  });

  it('sondaki eğik çizgi kalıbı ayırmaz; kök korunur', async () => {
    const slug = slugOnekleriBul(yollar('/sehir', sehirler));
    expect(urlKalibi(`${T}/sehir/a/`, slug)).toBe('/sehir/:slug');
    expect(urlKalibi(`${T}/`)).toBe('/');
    const site: Record<string, string[]> = {
      '/': ['/sehir/a', '/sehir/a/', '/sehir/b/', '/sehir/c', '/sehir/d/', '/sehir/e', '/sehir/f/', '/iletisim'],
    };
    // Bütçe: kök + 2 şehir + iletişim. Tek kota varsa iletişim bütçeye girer.
    const gezilen = await gezSahte(site, 4);
    expect(gezilen.filter((yol) => yol.startsWith('/sehir/'))).toHaveLength(2);
    expect(gezilen).toContain('/iletisim');
  });
});

describe('ertelenenlerin sırası: küçük grup önce', () => {
  const site: Record<string, string[]> = {
    '/': ['/sehirler', '/hizmetler', '/blog', '/kurumsal', '/panel'],
    '/sehirler': Array.from({ length: 81 }, (_d, i) => `/sehir/il-${i + 1}`),
    '/hizmetler': Array.from({ length: 6 }, (_d, i) => `/hizmet/h${i + 1}`),
    '/blog': Array.from({ length: 8 }, (_d, i) => `/yazi/b${i + 1}`),
    '/kurumsal': Array.from({ length: 15 }, (_d, i) => `/kurumsal-${i + 1}`),
    '/panel': ['kullanicilar', 'raporlar', 'talepler', 'kategoriler', 'dogrulama', 'bildirimler', 'anlasmazlik']
      .map((a) => `/panel/${a}`),
  };

  it('40 bütçede panelin 7 alt sayfası da gezilir, şehirlerden yalnız 2 örnek', async () => {
    const gezilen = await gezSahte(site, 40);
    expect(gezilen.filter((yol) => yol.startsWith('/panel/'))).toHaveLength(7);
    expect(gezilen.filter((yol) => yol.startsWith('/hizmet/'))).toHaveLength(6);
    expect(gezilen.filter((yol) => yol.startsWith('/sehir/'))).toHaveLength(2);
    expect(gezilen).toHaveLength(40);
  });
});

describe('ilk sayfalar ve sondaki eğik çizgi', () => {
  it('ilkSayfalar kota sayımına girer: 5 hazır şehir varken yeni şehir ana sırada gezilmez', async () => {
    const site: Record<string, string[]> = { '/': ['/sehir/f', '/sehir/g', '/iletisim'] };
    let etkinUrl = '';
    const gezilen: string[] = [];
    const sayfa = {
      goto: vi.fn(async (url: string) => { etkinUrl = url; gezilen.push(url); }),
      locator: vi.fn(() => ({
        evaluateAll: async (isleyici: (elemanlar: unknown[]) => unknown) =>
          isleyici((site[new URL(etkinUrl).pathname] ?? []).map((yol) => ({ href: `${T}${yol}`, metin: 'x' }))),
      })),
    } as unknown as Page;
    sayfaOzetiSahte.mockImplementation(async () => ({
      url: etkinUrl, title: '', headings: [], links: [], forms: [], buttons: [], menu: [],
    }));
    const ilk = ['a', 'b', 'c', 'd', 'e'].map((h) => ({
      url: `${T}/sehir/${h}`, title: '', headings: [], links: [], forms: [], buttons: [], menu: [],
    }));
    await gez(sayfa, { baseUrl: `${T}/`, maxSayfa: 7, derinlik: 1, sayfaZamanAsimiMs: 1, ilkSayfalar: ilk });
    const sehirGezilen = gezilen.filter((url) => url.includes('/sehir/'));
    expect(sehirGezilen).toHaveLength(0);
    expect(gezilen).toContain(`${T}/iletisim`);
  });

  it('/hakkimizda ve /hakkimizda/ tek sayfa olarak gezilir, ilk görülen biçim kalır', async () => {
    const gezilen = await gezSahteTam({ '/': ['/hakkimizda', '/hakkimizda/', '/iletisim/'] }, 10);
    expect(gezilen.filter((url) => url.includes('hakkimizda'))).toEqual([`${T}/hakkimizda`]);
    expect(gezilen).toContain(`${T}/iletisim/`);
  });
});

async function gezSahteTam(site: Record<string, string[]>, maxSayfa: number): Promise<string[]> {
  let etkinUrl = '';
  const gezilen: string[] = [];
  const sayfa = {
    goto: vi.fn(async (url: string) => { etkinUrl = url; gezilen.push(url); }),
    locator: vi.fn(() => ({
      evaluateAll: async (isleyici: (elemanlar: unknown[]) => unknown) =>
        isleyici((site[new URL(etkinUrl).pathname] ?? []).map((yol) => ({ href: `${T}${yol}`, metin: 'x' }))),
    })),
  } as unknown as Page;
  sayfaOzetiSahte.mockImplementation(async () => ({
    url: etkinUrl, title: '', headings: [], links: [], forms: [], buttons: [], menu: [],
  }));
  await gez(sayfa, { baseUrl: `${T}/`, maxSayfa, derinlik: 1, sayfaZamanAsimiMs: 1 });
  return gezilen;
}
