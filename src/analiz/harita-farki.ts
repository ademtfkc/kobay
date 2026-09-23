import { chromium } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
import type { HaritaFarki, Sayfa } from '../depo/index.js';
import { sayfaOzeti } from '../kesif/sayfa-ozeti.js';

/** Kaydedilmiş DOM yüklenirken beklenecek en uzun süre; ağ engellendiği için bu sınıra düşülmemeli. */
const DOM_ZAMAN_ASIMI_MS = 10_000;

function metniNormallestir(metin: string): string {
  return metin.replace(/\s+/g, ' ').trim();
}

/** Kimlik karşılaştırması için boşluk ve büyük/küçük harf duyarsız biçim. */
function kimlikNormallestir(metin: string): string {
  return metniNormallestir(metin).toLocaleLowerCase('tr');
}

function benzersiz(metinler: string[]): string[] {
  return [...new Set(metinler.map(metniNormallestir).filter(Boolean))];
}

function formAlanlari(sayfa: Sayfa): string[] {
  return benzersiz(sayfa.formlar.flatMap((form) => form.alanlar.map((alan) => {
    const ad = metniNormallestir(alan.ad);
    if (ad) return ad;
    const etiket = metniNormallestir(alan.etiket ?? '');
    return etiket || metniNormallestir(alan.placeholder ?? '');
  })));
}

function diziFarki(sol: string[], sag: string[]): string[] {
  const sagKumesi = new Set(sag);
  return sol.filter((deger) => !sagKumesi.has(deger));
}

function girisEkraniGibiMi(sayfa: Sayfa, basliklar: string[]): boolean {
  const metin = [sayfa.baslik, ...basliklar].map(kimlikNormallestir).join(' ');
  return /(?:^|\s)(?:giriş(?: yap)?|oturum aç|log[ -]?in|sign[ -]?in)(?:\s|$)/i.test(metin);
}

/**
 * Keşifle güncel özetin aynı sayfayı gösterip göstermediğine karar verir.
 * Aynı <title> güçlü sinyaldir; title ile tek görünür başlığın birlikte yeniden
 * adlandırılması da kimliği korur. Başlık bilgisi yoksa keşifteki h1/h2/h3
 * başlıklarından en az birinin kalmış olması beklenir.
 */
function sayfaKimliginiDogrula(
  kesif: Sayfa,
  simdi: Sayfa,
  kesifBasliklari: string[],
  simdikiBasliklar: string[],
  gorunurFarklar: {
    eklenenBasliklar: string[];
    silinenBasliklar: string[];
    eklenenDugmeler: string[];
    silinenDugmeler: string[];
    eklenenFormAlanlari: string[];
    silinenFormAlanlari: string[];
  },
): boolean {
  const kesifBaslik = kimlikNormallestir(kesif.baslik);
  const simdikiBaslik = kimlikNormallestir(simdi.baslik);
  if (kesifBaslik !== '' && simdikiBaslik !== '') {
    if (kesifBaslik === simdikiBaslik) return true;
    // <title> ile tek görünür başlık birlikte yeniden adlandırılmışsa sayfa aynı
    // kabul edilir. Düğme/form değişimi de varsa giriş ekranı gibi başka bir
    // sayfaya geçilmiş olabileceğinden bu istisna uygulanmaz.
    return !girisEkraniGibiMi(simdi, simdikiBasliklar)
      && gorunurFarklar.silinenBasliklar.length === 1
      && gorunurFarklar.eklenenBasliklar.length === 1
      && gorunurFarklar.silinenDugmeler.length === 0
      && gorunurFarklar.eklenenDugmeler.length === 0
      && gorunurFarklar.silinenFormAlanlari.length === 0
      && gorunurFarklar.eklenenFormAlanlari.length === 0;
  }
  if (kesifBasliklari.length === 0) return true;
  const simdikiKumesi = new Set(simdikiBasliklar.map(kimlikNormallestir));
  return kesifBasliklari.some((baslik) => simdikiKumesi.has(kimlikNormallestir(baslik)));
}

/** Keşif özetiyle güncel özeti, kararsız link ve menü verilerini dışarıda bırakarak karşılaştırır. */
export function haritaFarkiHesapla(kesif: Sayfa, simdi: Sayfa): HaritaFarki {
  const kesifBasliklari = benzersiz(kesif.basliklar);
  const simdikiBasliklar = benzersiz(simdi.basliklar);
  const kesifDugmeleri = benzersiz(kesif.dugmeler);
  const simdikiDugmeler = benzersiz(simdi.dugmeler);
  const kesifFormAlanlari = formAlanlari(kesif);
  const simdikiFormAlanlari = formAlanlari(simdi);
  const gorunurFarklar = {
    eklenenBasliklar: diziFarki(simdikiBasliklar, kesifBasliklari),
    silinenBasliklar: diziFarki(kesifBasliklari, simdikiBasliklar),
    eklenenDugmeler: diziFarki(simdikiDugmeler, kesifDugmeleri),
    silinenDugmeler: diziFarki(kesifDugmeleri, simdikiDugmeler),
    eklenenFormAlanlari: diziFarki(simdikiFormAlanlari, kesifFormAlanlari),
    silinenFormAlanlari: diziFarki(kesifFormAlanlari, simdikiFormAlanlari),
  };
  const fark: Omit<HaritaFarki, 'degisti'> = {
    url: kesif.url,
    ...gorunurFarklar,
    sayfaKimligiUyusuyor: sayfaKimliginiDogrula(
      kesif,
      simdi,
      kesifBasliklari,
      simdikiBasliklar,
      gorunurFarklar,
    ),
  };
  const sayfaBasligiDegisti = kimlikNormallestir(kesif.baslik) !== kimlikNormallestir(simdi.baslik);

  return {
    ...fark,
    degisti: sayfaBasligiDegisti
      || Object.values(gorunurFarklar).some((deger) => deger.length > 0),
  };
}

/**
 * Kaydedilmiş DOM'u keşifle aynı Playwright özetleyicisi üzerinden geçirir.
 * Ağ tamamen engellenir: kaydedilmiş DOM'daki mutlak img/link/iframe adresleri
 * gerçek uygulamaya istek atmasın, uygulama kapalıysa fark hesabı bloklanmasın.
 */
export async function domHaritaFarkiOlustur(html: string, kesif: Sayfa, koken: string): Promise<HaritaFarki> {
  let tarayici: Browser | undefined;
  let baglam: BrowserContext | undefined;
  try {
    tarayici = await chromium.launch({ headless: true });
    baglam = await tarayici.newContext({ javaScriptEnabled: false });
    await baglam.route('**/*', (yol) => { void yol.abort(); });
    const sayfa = await baglam.newPage();
    sayfa.setDefaultTimeout(DOM_ZAMAN_ASIMI_MS);
    await sayfa.setContent(html, { waitUntil: 'domcontentloaded', timeout: DOM_ZAMAN_ASIMI_MS });
    const simdi = await sayfaOzeti(sayfa, koken);
    return haritaFarkiHesapla(kesif, { ...simdi, url: kesif.url });
  } finally {
    await baglam?.close().catch(() => undefined);
    await tarayici?.close().catch(() => undefined);
  }
}
