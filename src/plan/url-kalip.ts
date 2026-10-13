import type { Harita } from '../depo/index.js';
import { slugOnekleriBul, urlKalibi } from '../kesif/gezgin.js';

/**
 * Sorgu ve hash'i atar, sondaki eğik çizgiyi temizler; yalnız yolu bırakır.
 * `javascript:`/`mailto:` gibi sayfa olmayan şemalar için null döner.
 */
export function yoluNormallestir(url: string, baseUrl: string): string | null {
  try {
    const cozulmus = new URL(url, baseUrl);
    if (cozulmus.protocol !== 'http:' && cozulmus.protocol !== 'https:') return null;
    const yol = cozulmus.pathname;
    return yol.length > 1 ? yol.replace(/\/+$/, '') : yol;
  } catch {
    return null;
  }
}

/**
 * URL'yi deterministik yol kalıbına çevirir: sayısal ve UUID-benzeri segmentler
 * `:id` olur (`/cariler/36` → `/cariler/:id`); `slugOnekleri` verilirse o üst yolların
 * altındaki isimli segment `:slug` olur (`/sehir/istanbul` → `/sehir/:slug`). Segment
 * kuralı keşif tarafındaki `urlKalibi` ile aynıdır; tek fark yolun önce normalleştirilmesi (sondaki eğik
 * çizgi `/urunler/` ile `/urunler`i ayrı kalıp yapmasın diye). Saf fonksiyon,
 * tarayıcı gerekmez.
 */
export function yolKalibi(
  url: string,
  baseUrl: string,
  slugOnekleri: ReadonlySet<string> = new Set(),
): string | null {
  const yol = yoluNormallestir(url, baseUrl);
  // yol null değilse URL zaten bir kez çözüldü; ikinci çözüm de kesin başarılı.
  if (yol === null) return null;
  return urlKalibi(new URL(yol, baseUrl).href, slugOnekleri);
}

/**
 * Haritadaki sayfa adreslerinden ve bu sayfaların bağlantılarından (aynı kökende)
 * slug üst yollarını bulur. Keşif yalnız birkaç örnek sayfayı ziyaret ettiği için
 * kümeyi görülen bağlantılar da besler.
 */
export function haritaSlugOnekleri(harita: Harita): Set<string> {
  const koken = new URL(harita.baseUrl).origin;
  const yollar = new Set<string>();
  for (const sayfa of harita.pages) {
    for (const adres of [sayfa.url, ...sayfa.links]) {
      const yol = yoluNormallestir(adres, harita.baseUrl);
      if (yol === null) continue;
      if (new URL(adres, harita.baseUrl).origin === koken) yollar.add(yol);
    }
  }
  return slugOnekleriBul(yollar);
}

/** Haritadaki sayfalardan benzersiz yol kalıplarını çıkarır. */
export function haritaYolKaliplari(harita: Harita): string[] {
  const slugOnekleri = haritaSlugOnekleri(harita);
  const kaliplar = new Set<string>();
  for (const sayfa of harita.pages) {
    const kalip = yolKalibi(sayfa.url, harita.baseUrl, slugOnekleri);
    if (kalip !== null) kaliplar.add(kalip);
  }
  return [...kaliplar].sort();
}

export interface UrlKarari {
  kabul: boolean;
  /** `yol`: haritada birebir var · `kalip`: kalıba uyuyor · `yok`: ikisi de değil. */
  tur: 'yol' | 'kalip' | 'yok';
  /** Öneri URL'sinden çıkarılan kalıp; URL ayrıştırılamazsa null. */
  kalip: string | null;
}

/**
 * Öneri URL'sini önce haritadaki tam yollarla, olmazsa haritadan çıkarılan yol
 * kalıplarıyla karşılaştırır. Böylece haritada olmayan ama bilinen bir kalıba
 * uyan `/cariler/999999` gibi hata-durumu önerileri (404 / boş kayıt) hayatta
 * kalır; `/faturalar` gibi tamamen yeni bir yol yine düşürülür.
 */
export function oneriUrlKarari(
  onerininUrlsi: string,
  harita: Harita,
  kaliplar: readonly string[] = haritaYolKaliplari(harita),
): UrlKarari {
  const yol = yoluNormallestir(onerininUrlsi, harita.baseUrl);
  if (yol === null) return { kabul: false, tur: 'yok', kalip: null };

  const kalip = yolKalibi(onerininUrlsi, harita.baseUrl, haritaSlugOnekleri(harita));
  const tamEslesme = harita.pages.some(
    (sayfa) => yoluNormallestir(sayfa.url, harita.baseUrl) === yol,
  );
  if (tamEslesme) return { kabul: true, tur: 'yol', kalip };
  if (kalip !== null && kaliplar.includes(kalip)) return { kabul: true, tur: 'kalip', kalip };
  return { kabul: false, tur: 'yok', kalip };
}
