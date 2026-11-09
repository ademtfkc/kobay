import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Request } from '@playwright/test';
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
  /** Keşif boyunca toplam durulma beklemesi; varsayılan `DURULMA.toplamTavanMs`. 0: bekleme yok. */
  toplamDurulmaTavaniMs?: number;
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

/**
 * Sayfa durulma beklemesinin tavanları. Keşif `domcontentloaded` ile kaydeder; tek sayfa
 * uygulaması (SPA) o anda henüz çizilmemiştir. Bekleme: DOM `sessizMs` boyunca değişmez VE
 * kısa ömürlü istek kalmaz. `uzunIstekMs`'den eski istek (long-poll, akış) sakinliği engellemez.
 * Hiç durulmayan sayfa `sayfaTavaniMs`'de bırakılır; keşif boyunca toplam bekleme `toplamTavanMs`'i
 * aşmaz (aşınca bekleme kapanır, eski davranış). Bekleme yalnız gözlemdir: tıklama, yazma yok.
 */
export const DURULMA = {
  sessizMs: 150,
  sayfaTavaniMs: 3_000,
  toplamTavanMs: 30_000,
  uzunIstekMs: 1_500,
  yoklamaMs: 25,
  /** Süre dolunca sayfadaki gözlemciyi söken çağrının tavanı (ana iş parçacığı kilitli olabilir). */
  iptalTavaniMs: 500,
} as const;

/**
 * Sayfaya yapılan bir çağrıyı süreyle sınırlar: süre dolarsa hata fırlatır (çağrı arka planda
 * kalır, sonucu yok sayılır). Ana iş parçacığı kilitlenen sayfa keşfi/yenilemeyi asılı bırakmaz.
 */
export class PageNotRespondingError extends Error {
  constructor(ms: number, ne: string) {
    super(`Page did not respond within ${ms} ms (${ne})`);
    this.name = 'PageNotRespondingError';
  }
}

export async function sinirli<T>(is: Promise<T>, ms: number, ne: string): Promise<T> {
  let zamanlayici: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      is,
      new Promise<never>((_coz, reddet) => {
        zamanlayici = setTimeout(() => reddet(new PageNotRespondingError(ms, ne)), ms);
      }),
    ]);
  } finally {
    clearTimeout(zamanlayici);
  }
}

/** Bitmesi beklenmeyen istek türleri: sakinlik hesabına hiç girmez. */
const SUREKLI_ISTEK_TURLERI = new Set(['eventsource', 'websocket', 'media']);

export interface IstekIzleyici {
  /** Şu an süren ve `uzunIstekMs`'den genç istek sayısı. */
  kisaBekleyen(): number;
  /** Sayılan bir isteğin son başladığı ya da bittiği an (Date.now); hiç yoksa 0. */
  sonEtkinlik(): number;
  /** Dinleyicileri kaldırır. */
  birak(): void;
}

/** Sayfanın ağ isteklerini sayar (yalnız olay dinler; isteğe dokunmaz). */
export function istekIzle(sayfa: Page): IstekIzleyici {
  const bekleyen = new Map<Request, number>();
  let sonEtkinlik = 0;
  const basla = (istek: Request): void => {
    // Ana çerçevede yeni belge gezinmesi başladı: önceki belgenin (asılı ya da yarıda kalan) istekleri
    // bir daha bitiş olayı vermeyebilir; sayılmaya devam etselerdi sonraki sayfanın beklemesini uzatırlardı.
    if (istek.isNavigationRequest() && istek.frame() === sayfa.mainFrame()) bekleyen.clear();
    if (SUREKLI_ISTEK_TURLERI.has(istek.resourceType())) return;
    sonEtkinlik = Date.now();
    bekleyen.set(istek, sonEtkinlik);
  };
  const bitir = (istek: Request): void => {
    if (bekleyen.delete(istek)) sonEtkinlik = Date.now();
  };
  sayfa.on('request', basla);
  sayfa.on('requestfinished', bitir);
  sayfa.on('requestfailed', bitir);
  return {
    kisaBekleyen: () => {
      const simdi = Date.now();
      let sayi = 0;
      for (const baslangic of bekleyen.values()) if (simdi - baslangic < DURULMA.uzunIstekMs) sayi++;
      return sayi;
    },
    sonEtkinlik: () => sonEtkinlik,
    birak: () => {
      sayfa.off('request', basla);
      sayfa.off('requestfinished', bitir);
      sayfa.off('requestfailed', bitir);
      bekleyen.clear();
    },
  };
}

function bekle(ms: number): Promise<void> {
  return new Promise((coz) => setTimeout(coz, Math.max(0, ms)));
}

/**
 * Tarayıcıda koşar: DOM `sessiz` ms değişmeyince true, `tavan` ms dolunca false döner.
 * Sayfa `setInterval`/`MutationObserver`'ı bozsa da Node tarafındaki süre sınırı bağlar.
 */
export function domSessizlik(
  { sessiz, tavan, koken, anahtar }: { sessiz: number; tavan: number; koken: string; anahtar: string },
): Promise<boolean> {
  // Belge başka kökendeyse (Node denetimiyle evaluate arasında yönlenmiş) hiçbir şey kurulmaz.
  if (location.origin !== koken) return Promise.resolve(false);
  return new Promise((coz) => {
    const bas = performance.now();
    let son = bas;
    let bitti = false;
    // Kapanış işlevi ve kaynak tutucu her şeyden önce tanımlı: sayfa setInterval'i geri çağrıyı
    // eşzamanlı çalıştıracak biçimde bozsa da (TDZ yok) ya da kurulum yarıda fırlatsa da kapanır.
    const kaynak: { gozcu?: MutationObserver; zamanlayici?: ReturnType<typeof setInterval> } = {};
    const bitir = (sonuc: boolean): void => {
      if (bitti) return;
      bitti = true;
      try { if (kaynak.zamanlayici !== undefined) clearInterval(kaynak.zamanlayici); } catch { /* sayfa bozmuş */ }
      try { kaynak.gozcu?.disconnect(); } catch { /* sayfa bozmuş */ }
      try { Reflect.deleteProperty(window, anahtar); } catch { /* sayfa bozmuş */ }
      coz(sonuc);
    };
    try {
      // İptal kaydı gözlemciden ÖNCE: kurulamazsa (sayfa engellediyse) hiçbir gözlemci bağlanmaz.
      // Node tarafı süre sınırını kazanırsa gözlemciyi bununla söker.
      Object.defineProperty(window, anahtar, { value: () => bitir(false), configurable: true });
      kaynak.gozcu = new MutationObserver(() => { son = performance.now(); });
      kaynak.gozcu.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      kaynak.zamanlayici = setInterval(() => {
        const simdi = performance.now();
        if (simdi - son >= sessiz || simdi - bas >= tavan) bitir(simdi - son >= sessiz);
      }, 25);
      // Geri çağrı eşzamanlı çalışıp bitirdiyse, sonradan dönen zamanlayıcı da durur.
      if (bitti) clearInterval(kaynak.zamanlayici);
    } catch {
      bitir(false);
    }
  });
}

/** Tarayıcıda koşar: `domSessizlik`'in bıraktığı iptal işlevini çağırır; yabancı belgede hiçbir şey yapmaz. */
export function domSessizlikIptal({ anahtar, koken }: { anahtar: string; koken: string }): void {
  if (location.origin !== koken) return;
  const iptal: unknown = Reflect.get(window, anahtar);
  if (typeof iptal === 'function') iptal();
}

/** Her bekleme turuna özgü iptal anahtarı: sayfa önceden tanımlayıp çakıştıramaz. */
function iptalAnahtari(): string {
  return `__kobayDurulma_${randomUUID().replaceAll('-', '')}`;
}

function kokenIcinde(sayfa: Page, koken: string): boolean {
  try {
    return new URL(sayfa.url()).origin === koken;
  } catch {
    return false;
  }
}

/**
 * Sayfanın çizilmesini tavanlı bekler (bkz. `DURULMA`). Durulduysa true, tavan dolduysa false.
 * Hata fırlatmaz: gezinme sırasında bağlam yok olursa döngü yeni belgeyle sürer. Belge `koken`
 * dışına geçtiyse bekleme hemen biter; yabancı belgede hiçbir kobay kodu çalışmaz.
 */
export async function sayfaDurulsun(
  sayfa: Page, izleyici: IstekIzleyici, tavanMs: number, koken: string,
): Promise<boolean> {
  const son = Date.now() + tavanMs;
  while (Date.now() < son) {
    if (!kokenIcinde(sayfa, koken)) return false;
    const kalan = son - Date.now();
    let domSakin = false;
    let zamanlayici: NodeJS.Timeout | undefined;
    let sureDoldu = false;
    const anahtar = iptalAnahtari();
    try {
      domSakin = await Promise.race([
        sayfa.evaluate(domSessizlik, { sessiz: DURULMA.sessizMs, tavan: kalan, koken, anahtar }),
        new Promise<boolean>((coz) => {
          zamanlayici = setTimeout(() => { sureDoldu = true; coz(false); }, kalan + DURULMA.yoklamaMs);
        }),
      ]);
    } catch {
      // Belge değişti (istemci yönlendirmesi): döngü başındaki köken denetiminden sonra yeniden bekle.
      await bekle(DURULMA.yoklamaMs);
      continue;
    } finally {
      // Bekleyen zamanlayıcı süreci açık tutmasın (keşif bitince CLI hemen çıksın).
      clearTimeout(zamanlayici);
    }
    if (sureDoldu) {
      // Sayfadaki gözlemci kendi zamanlayıcısıyla bitmedi: dışarıdan sök. Köken iki kez denetlenir:
      // burada ve (arada yönlenme olduysa) sayfa içinde, iptal işlevi aranmadan önce.
      // Çağrı süreyle sınırlı: ana iş parçacığı kilitliyse beklemeden çıkılır.
      if (kokenIcinde(sayfa, koken)) {
        await sinirli(sayfa.evaluate(domSessizlikIptal, { anahtar, koken }), DURULMA.iptalTavaniMs, 'cancel')
          .catch(() => undefined);
      }
      return false;
    }
    if (!domSakin) return false;
    // Ağ, DOM sessizlik penceresi boyunca da sakin kalmalı: son istek pencere içinde bittiyse
    // (çizim ondan sonra gelebilir) sessizlik yeniden ölçülür.
    if (izleyici.kisaBekleyen() === 0 && Date.now() - izleyici.sonEtkinlik() >= DURULMA.sessizMs) return true;
    while (izleyici.kisaBekleyen() > 0 && Date.now() < son) {
      // Belge başka kökene geçtiyse onun isteklerini beklemenin anlamı yok.
      if (!kokenIcinde(sayfa, koken)) return false;
      await bekle(DURULMA.yoklamaMs);
    }
  }
  return false;
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

  let kalanDurulmaMs = secenekler.toplamDurulmaTavaniMs ?? DURULMA.toplamTavanMs;
  /** Sayfadan her okuma (özet, bağlantılar, giriş formu, ekran görüntüsü) bu süreyle sınırlı. */
  const okumaTavani = secenekler.sayfaZamanAsimiMs;
  // Bekleme kapalıysa (0) sayfaya dinleyici bile takılmaz.
  const izleyici = kalanDurulmaMs > 0 ? istekIzle(sayfa) : undefined;
  /** Varılan belge başka kökendeyse kaydını işler ve true döner (bkz. köken sınırı). */
  const disKokendeMi = (oge: KuyrukOgesi): boolean => {
    const disKoken = yabanciKoken(sayfa, koken);
    if (disKoken === null) return false;
    gorulen.add(tekilAnahtar(oge.url));
    if (secenekler.girisYonlendirmesiniIsaretle === true && disKoken !== '') {
      sayfalar.push(girisGerektirenSayfa(oge.url, disKoken));
    }
    return true;
  };

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
      if (disKokendeMi(oge)) continue;
      // SPA'nın çizilmesi tavanlı beklenir; yalnız kendi kökenimizdeki belgede. Bekleme sırasında
      // istemci yönlendirmesi başka kökene geçirdiyse aynı köken sınırı işler.
      const tavan = Math.min(DURULMA.sayfaTavaniMs, kalanDurulmaMs);
      if (izleyici !== undefined && tavan > 0) {
        const bas = Date.now();
        await sayfaDurulsun(sayfa, izleyici, tavan, koken);
        kalanDurulmaMs -= Date.now() - bas;
        if (disKokendeMi(oge)) continue;
      }
      if (secenekler.girisYonlendirmesiniIsaretle === true) {
        // Yol desenine güvenilmez: varılan sayfada parola alanlı giriş formu aranır.
        const varilan = normalUrl(sayfa.url());
        if (varilan !== null && tekilAnahtar(varilan) !== tekilAnahtar(oge.url)
          && await sinirli(girisFormuBul(sayfa), okumaTavani, 'login form check') !== null) {
          // Tekilleştirme istenen adrese göre: aynı giriş sayfasına yönlenen 7 adres 7 kayıt.
          gorulen.add(tekilAnahtar(oge.url));
          sayfalar.push(girisGerektirenSayfa(oge.url, varilan));
          // Varılan giriş sayfası bir kez normal gezilir; başka kökendeyse (SSO) hiç gezilmez.
          if (new URL(varilan).origin !== koken || gorulen.has(tekilAnahtar(varilan))) continue;
          if (sayfalar.length >= secenekler.maxSayfa) continue;
        }
      }
      // Sayfadan okuma süreyle sınırlı (sayfa başına zaman aşımı): ana iş parçacığı kilitlenen sayfa
      // keşfi asılı bırakmaz; süre dolarsa sayfa ulaşılamayan sayfa gibi atlanır.
      const ozet = await sinirli(sayfaOzeti(sayfa, koken), okumaTavani, 'page summary');
      // Özet sırasında meta/JS yönlendirmesiyle başka kökene geçildiyse özet atılır.
      if (yabanciKoken(sayfa, koken) !== null) continue;
      // İstemci yönlendirmesinde (`/projects/2` → `/projects/2/9`) istenen adres de görüldü sayılır.
      const zatenGorulen = gorulen.has(tekilAnahtar(ozet.url));
      gorulen.add(tekilAnahtar(oge.url));
      if (zatenGorulen) continue;
      gorulen.add(tekilAnahtar(ozet.url));
      sayfalar.push(ozet);
      if (secenekler.ekranGoruntusuDizini) {
        await sayfa.screenshot({ path: join(secenekler.ekranGoruntusuDizini, `sayfa-${sayfalar.length}.png`), timeout: okumaTavani });
      }
      if (oge.derinlik >= secenekler.derinlik || yabanciKoken(sayfa, koken) !== null) continue;
      const linkler = await sinirli(izlenebilirLinkler(sayfa, koken), okumaTavani, 'links');
      // Ziyaret kararından ÖNCE topluca say: ziyaret edilmeyecek bağlantılar da slug kümesini besler.
      for (const url of linkler) bilinenYollar.add(new URL(url).pathname);
      slugOnekleri = slugOnekleriBul(bilinenYollar);
      for (const url of linkler) kuyrugaEkle(url, oge.derinlik + 1);
    } catch (hata: unknown) {
      // Okuma süre sınırını aştıysa sekmenin ana iş parçacığı kilitlidir; kilitli sekme başka adrese de
      // gidemez (her goto zaman aşımına düşer). Keşif o ana kadar toplananla biter.
      if (hata instanceof PageNotRespondingError) break;
      // Ulaşılamayan bir sayfa keşfi durdurmaz; diğer kuyruk öğeleri sürer.
    }
  }
  izleyici?.birak();
  return sayfalar;
}
