import { normalUrl } from './gezgin.js';

/** Tek bir sitemap dosyasından okunacak en çok bayt; aşan kısım kesilir (yarım kalan `<loc>` alınmaz). */
export const SITEMAP_BAYT_TAVANI = 1024 * 1024;
/** Kuyruğa girecek en çok sitemap adresi (aynı köken, tekilleştirilmiş). */
export const SITEMAP_ADRES_TAVANI = 500;
/** Sitemap index'inden okunacak en çok alt sitemap; iç içe index izlenmez. */
export const SITEMAP_ALT_DOSYA_TAVANI = 20;

export interface SiteHaritasi {
  /** Okunan kök sitemap adresi (`<köken>/sitemap.xml`). */
  url: string;
  /** Aynı kökenli, sorgusuz, tekil adresler; en çok `SITEMAP_ADRES_TAVANI`. */
  adresler: string[];
}

/** Tohum adresi `baseUrl` ile aynı kökende değil ya da geçerli http(s) adresi değil. */
export class SeedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedUrlError';
  }
}

/** Tohum adreslerini normalleştirir; başka köken ya da geçersiz adres `SeedUrlError` fırlatır. */
export function tohumlariDogrula(baseUrl: string, tohumlar: readonly string[]): string[] {
  const koken = new URL(baseUrl).origin;
  const sonuc: string[] = [];
  for (const tohum of tohumlar) {
    const url = normalUrl(tohum);
    if (url === null) throw new SeedUrlError('Seed must be a valid http(s) URL');
    const tohumKokeni = new URL(url).origin;
    if (tohumKokeni !== koken) {
      throw new SeedUrlError(`Seed URL must be on the same origin as the project URL (${koken}); got ${tohumKokeni}`);
    }
    if (!sonuc.includes(url)) sonuc.push(url);
  }
  return sonuc;
}

function xmlCoz(metin: string): string {
  return metin
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

const LOC_ACILIS = /<([\w-]+:)?loc>/g;

/**
 * `<loc>` değerlerini çıkarır. Sitemap biçimi düz ve sabit (urlset/sitemapindex > loc);
 * ad alanı, iç içe yapı ya da DTD gerekmediği için XML ayrıştırıcı bağımlılığı eklenmedi.
 * Tarama doğrusaldır: her açılıştan sonra en yakın kapanış aranır; kapanış yoksa tarama biter
 * (kapanışsız çok sayıda `<loc>` karesel süre harcatamaz).
 */
export function locDegerleri(xml: string): string[] {
  const sonuc: string[] = [];
  const acilis = new RegExp(LOC_ACILIS.source, 'g');
  for (let eslesme = acilis.exec(xml); eslesme !== null; eslesme = acilis.exec(xml)) {
    const bas = eslesme.index + eslesme[0].length;
    const kapanis = `</${eslesme[1] ?? ''}loc>`;
    const son = xml.indexOf(kapanis, bas);
    if (son < 0) break;
    sonuc.push(xmlCoz(xml.slice(bas, son)));
    acilis.lastIndex = son + kapanis.length;
  }
  return sonuc;
}

function indeksMi(xml: string): boolean {
  return /<(?:[\w-]+:)?sitemapindex[\s>]/.test(xml);
}

/** Yalnız 200 ve aynı kökendeki yanıtı, bayt tavanına kadar okur; yönlendirme izlenmez. */
async function dosyaOku(adres: string, sinyal: AbortSignal): Promise<string | null> {
  try {
    const yanit = await fetch(adres, { redirect: 'manual', signal: sinyal });
    if (yanit.status !== 200 || yanit.body === null) {
      await yanit.body?.cancel();
      return null;
    }
    const okuyucu = yanit.body.getReader();
    const parcalar: Uint8Array[] = [];
    let boy = 0;
    while (boy < SITEMAP_BAYT_TAVANI) {
      const { done, value } = await okuyucu.read();
      if (done) break;
      parcalar.push(value);
      boy += value.byteLength;
    }
    await okuyucu.cancel();
    const birlesik = new Uint8Array(Math.min(boy, SITEMAP_BAYT_TAVANI));
    let konum = 0;
    for (const parca of parcalar) {
      const kalan = birlesik.length - konum;
      if (kalan <= 0) break;
      birlesik.set(parca.subarray(0, kalan), konum);
      konum += Math.min(parca.byteLength, kalan);
    }
    return new TextDecoder().decode(birlesik);
  } catch {
    // Sitemap isteğe bağlı bir ipucudur; okunamaması keşfi durdurmaz.
    return null;
  }
}

/**
 * `<köken>/sitemap.xml`'i okur; sitemap index ise aynı kökendeki alt sitemap'leri (bir seviye)
 * okur. Başka kökenli adresler atılır, sorgu dizisi düşer, adresler tekilleşir ve
 * `SITEMAP_ADRES_TAVANI`'nda kesilir. Dosya yoksa, XML değilse ya da okunamazsa null.
 * `robots.txt` okunmaz. `zamanAsimiMs` bütün okumanın toplam süre sınırıdır.
 */
export async function siteHaritasiOku(koken: string, zamanAsimiMs: number): Promise<SiteHaritasi | null> {
  const kokAdres = `${new URL(koken).origin}/sitemap.xml`;
  // Tek süre sınırı bütün okumaya (index + alt dosyalar) uygulanır; keşfi bir sayfa süresinden fazla bekletmez.
  const sinyal = AbortSignal.timeout(zamanAsimiMs);
  const kok = await dosyaOku(kokAdres, sinyal);
  // SPA'lar bilinmeyen yola 200 + HTML döner: urlset/sitemapindex yoksa sitemap yok sayılır.
  if (kok === null || !(indeksMi(kok) || /<(?:[\w-]+:)?urlset[\s>]/.test(kok))) return null;
  const adresler: string[] = [];
  const ekle = (hamlar: readonly string[]): void => {
    for (const ham of hamlar) {
      if (adresler.length >= SITEMAP_ADRES_TAVANI) return;
      const url = normalUrl(ham);
      if (url !== null && new URL(url).origin === new URL(koken).origin && !adresler.includes(url)) adresler.push(url);
    }
  };
  if (indeksMi(kok)) {
    const altlar = locDegerleri(kok)
      .map(normalUrlSorgulu)
      .filter((url): url is string => url !== null && new URL(url).origin === new URL(koken).origin)
      .slice(0, SITEMAP_ALT_DOSYA_TAVANI);
    for (const alt of altlar) {
      if (adresler.length >= SITEMAP_ADRES_TAVANI) break;
      const xml = await dosyaOku(alt, sinyal);
      if (xml !== null && !indeksMi(xml)) ekle(locDegerleri(xml));
    }
  } else {
    ekle(locDegerleri(kok));
  }
  return { url: kokAdres, adresler };
}

/** Alt sitemap adresi: sorgu korunur (bazı siteler `?page=2` ile böler), parça atılır. */
function normalUrlSorgulu(adres: string): string | null {
  try {
    const url = new URL(adres);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
