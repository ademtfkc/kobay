import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Sayfa } from '../depo/index.js';
import { girisFormuBul } from './giris.js';
import { sayfaOzeti } from './sayfa-ozeti.js';

interface KuyrukOgesi { url: string; derinlik: number }

export interface GezginSecenekleri {
  baseUrl: string;
  maxSayfa: number;
  derinlik: number;
  sayfaZamanAsimiMs: number;
  ekranGoruntusuDizini?: string;
  ilkSayfalar?: Sayfa[];
  kalipBasinaSayfa?: number;
  /** Başlangıçla aynı derinlikte (0) kuyruğa giren ek adresler; başka kökendekiler atlanır. */
  tohumlar?: readonly string[];
  /** Sitemap'ten gelen adresler; derinlik 1 ile kuyruğa girer, kota ve tavan aynen işler. */
  siteHaritasiAdresleri?: readonly string[];
  /**
   * Girişsiz keşifte true: istenen adres başka bir giriş sayfasına (parola alanlı form)
   * yönlenirse istenen adres `requiresLogin` kaydıyla haritaya girer. Kimlikli keşifte false.
   */
  girisYonlendirmesiniIsaretle?: boolean;
}

// `\b` Türkçe harfleri (ç, ş, ı…) kelime karakteri saymaz; sınır elle yazılır: harf/rakam olmayan her şey.
const KELIME_ONCESI = '(?<![\\p{L}\\p{N}])';
const KELIME_SONRASI = '(?![\\p{L}\\p{N}])';
/** Kelime başında aranır: "Çıkışlar", "deleted" de yakalanır. */
const riskliKokler = ['çıkış', 'logout', 'sign out', 'oturumu kapat', 'delete', 'kaldır', 'remove'];
/** Tam kelime: kısa olduğu için "nasil", "Silivri", "silikon" içinde aranmaz. */
const riskliKelimeler = ['sil'];
const riskliBaglantiMetni = new RegExp(
  `${KELIME_ONCESI}(?:${riskliKokler.join('|')}|(?:${riskliKelimeler.join('|')})${KELIME_SONRASI})`,
  'u',
);

/** Yıkıcı veya oturumu kapatan bir bağlantının keşif kuyruğuna girmesini engeller. */
export function baglantiIzlenebilir(metin: string): boolean {
  // Türkçe (İ→i, I→ı) ve dilden bağımsız küçük harf ayrı denenir: "SİL", "ÇIKIŞ" ve "SIGN OUT" yakalanır.
  return ![metin.toLocaleLowerCase('tr-TR'), metin.toLowerCase()].some((aday) => riskliBaglantiMetni.test(aday));
}

/** Sorgu ve parçayı atar; http(s) dışı ya da geçersiz adres için null. */
export function normalUrl(adres: string): string | null {
  try {
    const url = new URL(adres);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Bir üst yolun altında en az bu kadar farklı isimli alt segment görülürse o segment `:slug` olur. */
export const SLUG_ESIGI = 5;

const sayisalSegment = /^\d+$/;
const uuidBenzeriSegment = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

function idSegmenti(parca: string): boolean {
  let cozulmus = parca;
  try {
    cozulmus = decodeURIComponent(parca);
  } catch {
    // Çözülemeyen yüzde-kodu ham haliyle kalır.
  }
  return sayisalSegment.test(cozulmus) || uuidBenzeriSegment.test(cozulmus);
}

/** Boş segmentler (baştaki ve sondaki eğik çizgi) olduğu gibi kalır; kök hiçbir zaman slug üstü olmaz. */
function kalipParcalari(parcalar: readonly string[], slugOnekleri: ReadonlySet<string>): string[] {
  const sonuc: string[] = [];
  for (const parca of parcalar) {
    if (parca === '') sonuc.push(parca);
    else if (idSegmenti(parca)) sonuc.push(':id');
    else sonuc.push(slugOnekleri.has(sonuc.join('/')) ? ':slug' : parca);
  }
  return sonuc;
}

/**
 * Yol listesinden slug üst yollarını bulur: kök olmayan bir üst yolun altında en az
 * `SLUG_ESIGI` farklı (sayı/UUID olmayan) doğrudan alt segment görülürse o üst yol
 * döner (`/sehir`). Seviye seviye ilerler; üst yol kalıbı önceki seviyelerin
 * `:id`/`:slug` sonucunu içerir (`/sehir/:slug/...`). Keşif ve plan aynı kuralı kullanır.
 */
export function slugOnekleriBul(yollar: Iterable<string>): Set<string> {
  const parcaListesi = [...new Set(yollar)].map((yol) => yol.split('/').filter((parca) => parca !== ''));
  const slugOnekleri = new Set<string>();
  for (let seviye = 1; parcaListesi.some((parcalar) => parcalar.length > seviye); seviye++) {
    const altlar = new Map<string, Set<string>>();
    for (const parcalar of parcaListesi) {
      const parca = parcalar[seviye];
      if (parca === undefined || idSegmenti(parca)) continue;
      const ust = kalipParcalari(['', ...parcalar.slice(0, seviye)], slugOnekleri).join('/');
      const kume = altlar.get(ust) ?? new Set<string>();
      kume.add(parca);
      altlar.set(ust, kume);
    }
    for (const [ust, kume] of altlar) if (kume.size >= SLUG_ESIGI) slugOnekleri.add(ust);
  }
  return slugOnekleri;
}

/**
 * Sayısal ve UUID-benzeri yol parçalarını `:id`, slug üst yollarının (bkz. `slugOnekleriBul`)
 * altındakileri `:slug` yapar; tekrar eden sayfaları sınırlamak için.
 */
export function urlKalibi(adres: string, slugOnekleri: ReadonlySet<string> = new Set()): string | null {
  const url = normalUrl(adres);
  if (url === null) return null;
  const yol = kalipParcalari(new URL(url).pathname.split('/'), slugOnekleri).join('/');
  // Plan tarafıyla aynı normalleştirme: kök dışında sondaki eğik çizgi yok sayılır.
  return yol.replace(/\/+$/, '') || '/';
}

async function izlenebilirLinkler(sayfa: Page, koken: string): Promise<string[]> {
  const baglantilar = await sayfa.locator('a[href]').evaluateAll((elemanlar) =>
    elemanlar.map((eleman) => {
      const baglanti = eleman as HTMLAnchorElement;
      return { href: baglanti.href, metin: baglanti.textContent ?? '' };
    }),
  );
  const sonuc: string[] = [];
  for (const baglanti of baglantilar) {
    if (!baglantiIzlenebilir(baglanti.metin)) continue;
    const url = normalUrl(baglanti.href);
    if (url && new URL(url).origin === koken && !sonuc.includes(url)) sonuc.push(url);
  }
  return sonuc;
}

/**
 * Ertelenenler arasından sıradaki adresi seçer: grubu (desen) en küçük olan önce, eşitlikte
 * görülme sırası. Grup boyu = desende görülen toplam farklı adres sayısı; küçük grup
 * büyük olasılıkla işlevsel sayfalardır, büyük grup içerik kopyasıdır. Seçileni listeden çıkarır.
 */
function kucukGrupluErtelenen(
  ertelenenler: KuyrukOgesi[],
  bilinenYollar: ReadonlySet<string>,
  slugOnekleri: ReadonlySet<string>,
  koken: string,
): KuyrukOgesi | undefined {
  const grupBoylari = new Map<string, number>();
  for (const yol of bilinenYollar) {
    const kalip = urlKalibi(new URL(yol, koken).href, slugOnekleri);
    if (kalip !== null) grupBoylari.set(kalip, (grupBoylari.get(kalip) ?? 0) + 1);
  }
  let secilen = -1;
  let secilenBoy = Infinity;
  ertelenenler.forEach((aday, sira) => {
    const kalip = urlKalibi(aday.url, slugOnekleri);
    const boy = kalip === null ? Infinity : (grupBoylari.get(kalip) ?? 0);
    if (boy < secilenBoy) {
      secilen = sira;
      secilenBoy = boy;
    }
  });
  return secilen < 0 ? ertelenenler.shift() : ertelenenler.splice(secilen, 1)[0];
}

/** Tekilleştirme anahtarı: kök dışında sondaki eğik çizgi yok sayılır (`/a` ile `/a/` tek sayfa). */
function tekilAnahtar(adres: string): string {
  try {
    const url = new URL(adres);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return adres;
  }
}

/** Kalıp `:slug` ya da `:id` içeriyorsa şablon kopyasıdır; içermiyorsa tekil sayfadır. */
function desenliKalip(kalip: string): boolean {
  return kalip.split('/').some((parca) => parca === ':slug' || parca === ':id');
}

/**
 * Kuyruktan sıradaki öğeyi çıkarır: önce kuyruk sırasıyla ilk tekil (desen dışı) adres,
 * tekil kalmadıysa kuyruğun başı. Böylece şablon kopyaları bütçeyi tekil sayfalardan önce
 * tüketmez; kota kararı yine çekildiği anda verilir.
 */
function tekilOncelikliCek(kuyruk: KuyrukOgesi[], slugOnekleri: ReadonlySet<string>): KuyrukOgesi | undefined {
  const sira = kuyruk.findIndex((oge) => {
    const kalip = urlKalibi(oge.url, slugOnekleri);
    return kalip !== null && !desenliKalip(kalip);
  });
  return kuyruk.splice(Math.max(sira, 0), 1)[0];
}

/**
 * Sayfanın şu anki belgesi başka kökendeyse o kökeni döner (http(s) değilse boş metin);
 * aynı kökendeyse null. Belgenin içeriğine dokunmaz, yalnız adresine bakar.
 */
function yabanciKoken(sayfa: Page, koken: string): string | null {
  const adres = normalUrl(sayfa.url());
  if (adres === null) return '';
  const varilan = new URL(adres).origin;
  return varilan === koken ? null : varilan;
}

/** Girişe yönlenen adresin harita kaydı: içerik yok, yalnız istenen adres ve varılan giriş sayfası. */
function girisGerektirenSayfa(istenen: string, varilan: string): Sayfa {
  return {
    url: istenen,
    title: '',
    headings: [],
    links: [],
    forms: [],
    buttons: [],
    menu: [],
    requiresLogin: true,
    redirectedTo: varilan,
  };
}

/**
 * Aynı kökende, yalnızca güvenli bağlantıları gezer. Sıra: tekil sayfalar, sonra desen
 * başına kota kadar şablon kopyası, bütçe kalırsa ertelenen kopyalar (küçük grup önce).
 */
export async function gez(sayfa: Page, secenekler: GezginSecenekleri): Promise<Sayfa[]> {
  const baslangic = normalUrl(secenekler.baseUrl);
  if (!baslangic) throw new Error('baseUrl must be a valid http(s) address');
  const koken = new URL(baslangic).origin;
  const sayfalar = [...(secenekler.ilkSayfalar ?? [])].slice(0, secenekler.maxSayfa);
  const gorulen = new Set(sayfalar.map(({ url }) => tekilAnahtar(url)));
  const kuyruk: KuyrukOgesi[] = [];
  const kuyrugaEkle = (adres: string, derinlik: number): void => {
    const url = normalUrl(adres);
    if (url === null || new URL(url).origin !== koken) return;
    const anahtar = tekilAnahtar(url);
    if (gorulen.has(anahtar) || kuyruk.some((aday) => tekilAnahtar(aday.url) === anahtar)) return;
    kuyruk.push({ url, derinlik });
  };
  kuyrugaEkle(baslangic, 0);
  for (const tohum of secenekler.tohumlar ?? []) kuyrugaEkle(tohum, 0);
  for (const adres of secenekler.siteHaritasiAdresleri ?? []) kuyrugaEkle(adres, 1);
  // `:slug` desenlerinde kota aşan kardeşler atılmaz, görülme sırasıyla burada beklerler;
  // ana kuyruk bitince bütçe kalırsa gezilirler. `:id` desenlerinde kota aşımı atılır.
  const ertelenenler: KuyrukOgesi[] = [];
  const kalipBasinaSayfa = secenekler.kalipBasinaSayfa ?? 2;
  // Ziyaret edilmeye karar verilen adresler; kalıp sayıları güncel slug kümesiyle bunlardan hesaplanır.
  const secilenler: string[] = sayfalar.map(({ url }) => url);
  // Tohum ve sitemap adresleri de baştan slug kümesini besler.
  const bilinenYollar = new Set<string>([
    ...kuyruk.map(({ url }) => new URL(url).pathname),
    ...sayfalar.map(({ url }) => new URL(url).pathname),
  ]);
  let slugOnekleri = slugOnekleriBul(bilinenYollar);

  if (secenekler.ekranGoruntusuDizini) await mkdir(secenekler.ekranGoruntusuDizini, { recursive: true });

  while ((kuyruk.length > 0 || ertelenenler.length > 0) && sayfalar.length < secenekler.maxSayfa) {
    const ertelenmisMi = kuyruk.length === 0;
    const oge = ertelenmisMi
      ? kucukGrupluErtelenen(ertelenenler, bilinenYollar, slugOnekleri, koken)
      : tekilOncelikliCek(kuyruk, slugOnekleri);
    if (!oge || gorulen.has(tekilAnahtar(oge.url))) continue;

    // Ziyaret kararı kuyruktan çekildiği anda, güncel slug kümesiyle verilir.
    const kalip = urlKalibi(oge.url, slugOnekleri);
    if (kalip === null) continue;
    if (!ertelenmisMi) {
      const kalipSayisi = secilenler.filter((url) => urlKalibi(url, slugOnekleri) === kalip).length;
      if (kalipSayisi >= kalipBasinaSayfa) {
        if (kalip.includes(':slug') && !ertelenenler.some((aday) => aday.url === oge.url)) ertelenenler.push(oge);
        continue;
      }
    }
    secilenler.push(oge.url);

    try {
      await sayfa.goto(oge.url, { waitUntil: 'domcontentloaded', timeout: secenekler.sayfaZamanAsimiMs });
      // Köken sınırı (tespit): yönlendirmeyi tarayıcı izler; varılan belge başka kökendeyse ondan
      // hiçbir şey okunmaz (özet, ekran görüntüsü, bağlantı yok). Kimliksiz keşifte istenen adres
      // kimlik kapısı sayılır ve yalnız hedef kökeniyle kaydedilir (yol/sorgu jeton taşıyabilir).
      const disKoken = yabanciKoken(sayfa, koken);
      if (disKoken !== null) {
        gorulen.add(tekilAnahtar(oge.url));
        if (secenekler.girisYonlendirmesiniIsaretle === true && disKoken !== '') {
          sayfalar.push(girisGerektirenSayfa(oge.url, disKoken));
        }
        continue;
      }
      if (secenekler.girisYonlendirmesiniIsaretle === true) {
        // Yol desenine güvenilmez: varılan sayfada parola alanlı giriş formu aranır.
        const varilan = normalUrl(sayfa.url());
        if (varilan !== null && tekilAnahtar(varilan) !== tekilAnahtar(oge.url) && await girisFormuBul(sayfa) !== null) {
          // Tekilleştirme istenen adrese göre: aynı giriş sayfasına yönlenen 7 adres 7 kayıt.
          gorulen.add(tekilAnahtar(oge.url));
          sayfalar.push(girisGerektirenSayfa(oge.url, varilan));
          // Varılan giriş sayfası bir kez normal gezilir; başka kökendeyse (SSO) hiç gezilmez.
          if (new URL(varilan).origin !== koken || gorulen.has(tekilAnahtar(varilan))) continue;
          if (sayfalar.length >= secenekler.maxSayfa) continue;
        }
      }
      const ozet = await sayfaOzeti(sayfa, koken);
      // Özet sırasında meta/JS yönlendirmesiyle başka kökene geçildiyse özet atılır.
      if (yabanciKoken(sayfa, koken) !== null) continue;
      if (gorulen.has(tekilAnahtar(ozet.url))) continue;
      gorulen.add(tekilAnahtar(ozet.url));
      sayfalar.push(ozet);
      if (secenekler.ekranGoruntusuDizini) {
        await sayfa.screenshot({ path: join(secenekler.ekranGoruntusuDizini, `sayfa-${sayfalar.length}.png`) });
      }
      if (oge.derinlik >= secenekler.derinlik || yabanciKoken(sayfa, koken) !== null) continue;
      const linkler = await izlenebilirLinkler(sayfa, koken);
      // Ziyaret kararından ÖNCE topluca say: ziyaret edilmeyecek bağlantılar da slug kümesini besler.
      for (const url of linkler) bilinenYollar.add(new URL(url).pathname);
      slugOnekleri = slugOnekleriBul(bilinenYollar);
      for (const url of linkler) kuyrugaEkle(url, oge.derinlik + 1);
    } catch {
      // Ulaşılamayan bir sayfa keşfi durdurmaz; diğer kuyruk öğeleri sürer.
    }
  }
  return sayfalar;
}
