import type { BrowserContext, Request, Route, WebSocketRoute } from '@playwright/test';
import type { Kimlik } from '../depo/index.js';

/**
 * Parola sayfaya yazıldıktan sonra JavaScript'in (fetch, XHR, sendBeacon, img, açılır
 * pencere, WebSocket) onu başka SİTEYE göndermesine karşı ağ katmanı koruması.
 *
 * "Aynı site": `baseUrl` origin'i ya da aynı şema + aynı kayıtlı alan adı
 * (`app.example.com` ↔ `api.example.com`), port serbest. localhost, IP ve tek etiketli adlarda
 * şema + ana makine adı eşitliği (port serbest: `localhost:5173` ↔ `localhost:8080`; ama
 * `localhost` ↔ `127.0.0.1` farklı). Kiracıya ayrılmış barındırma alanlarında (`amazonaws.com`,
 * `cloudfront.net`, bölgesel `run.app`) tam origin eşitliği. Bkz. `ayniSiteMi`, `ayniSiteOriginMi`.
 *
 * Süre: keşif bağlamının ilk sayfasından önce kurulur (WebSocket yönlendirmesi yalnız sonra
 * açılan belgelere işler) ve bağlam (BrowserContext) kapanana kadar kalır. İki evre:
 *
 * 1. Giriş penceresi (`pencereyiAc` → parola yazılır, gönderilir, URL değişir, ≤2 sn ağ
 *    durulması → `denetle`). Siteler-arası:
 *    - parola taşıyan istek kesilir, giriş reddedilir;
 *    - yazma (POST/PUT/PATCH/DELETE, sendBeacon) kesilir: parola kodlanıp gizlenmiş olabilir.
 *      Parola görünmüyorsa bilgi amaçlıdır; giriş başarılıysa hata yok, başarısızsa nedeni söylenir;
 *    - yeni WebSocket sunucuya hiç bağlanmaz, açık WebSocket'in mesajı iletilmez.
 * 2. Giriş sonrası (ve pencere açılmadan önce): yalnız parolayı görünür biçimde taşıyan
 *    siteler-arası istek / WebSocket adresi / WebSocket mesajı kesilir ve keşif reddedilir
 *    (`sonDenetim`). Siteler-arası yazmalar ve WebSocket'ler serbesttir: uygulamanın kendi
 *    API'si keşfi bozmasın. Kodlanmış parola bu evrede yakalanmaz.
 *
 * Engellenemeyen yol: aynı origin'deki uç 307/308 ile başka siteye yönlendirirse Chromium
 * gövdeyi kendisi yeniden gönderir ve yönlendirilmiş ayak route'a uğramaz. kobay bunu yalnız
 * TESPİT EDER ve girişi reddeder; istek karşı sunucuya ulaşmış olur. Service worker istekleri
 * route'a uğramadığı için kimlikli keşif bağlamı `serviceWorkers: 'block'` ile açılır
 * (bkz. `kesfet`, `sayfayiYenile`).
 */
export class CredentialLeakBlockedError extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'CredentialLeakBlockedError';
  }
}

const GUVENLI_YONTEMLER = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Bundan kısa parolada içerik araması yapılmaz: 1-3 karakter rastgele isteklerde de geçer. */
const EN_KISA_ARANAN_PAROLA = 4;

/**
 * Yalnız sayfanın AYARLAYAMADIĞI başlıklar aranmaz (Fetch "forbidden header names" + Chromium'un
 * sayfaya bırakmadığı `user-agent`): değerlerini tarayıcı üretir, parola "gzip" ya da "Mozilla"
 * iken sıradan bir CDN GET'i sızıntı sanılmasın. JavaScript'in yazabildiği her başlık aranır:
 * `accept`, `content-type`, `accept-language`, `range`, `cache-control`, `if-*`, `priority`,
 * özel başlıklar. `cookie` ve `referer` da aranır: sayfa `document.cookie` ya da `history`
 * ile parolayı oraya taşıyabilir.
 */
const ARANMAYAN_BASLIKLAR = new Set([
  'accept-charset', 'accept-encoding',
  'connection', 'content-length', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'set-cookie',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'via', 'user-agent',
]);
const ARANMAYAN_ONEKLER = ['proxy-', 'sec-', 'access-control-request-'];

function basligiAra(ad: string): boolean {
  const kucuk = ad.toLowerCase();
  return !ARANMAYAN_BASLIKLAR.has(kucuk) && !ARANMAYAN_ONEKLER.some((onek) => kucuk.startsWith(onek));
}

/** Parolanın bir istekte görünebileceği yaygın biçimleri. */
export function parolaIzleri(kimlik: Kimlik): string[] {
  const parola = kimlik.password;
  if (parola.length < EN_KISA_ARANAN_PAROLA) return [];
  const izler = new Set<string>([
    parola,
    encodeURIComponent(parola),
    new URLSearchParams({ p: parola }).toString().slice(2),
    JSON.stringify(parola).slice(1, -1),
    Buffer.from(parola, 'utf8').toString('base64').replace(/=+$/, ''),
    Buffer.from(`${kimlik.username}:${parola}`, 'utf8').toString('base64').replace(/=+$/, ''),
  ]);
  return [...izler];
}

/**
 * Barındırma platformlarının kiracıya ayrılmış alanları: an approximation of the Public Suffix
 * List (PSL kütüphanesi yok); extend when a platform is reported. Tek yer burası.
 * - `sonek`: her alt alan ayrı sitedir; kayıtlı alan adı = sonek + bir etiket
 *   (`me.github.io` ↔ `you.github.io` farklı, `x.a.run.app` ↔ `y.a.run.app` farklı).
 * - `tam`: altındaki her şey TAM ORİGİN eşitliği ister (S3 kovası, execute-api, CloudFront,
 *   bölgesel Cloud Run adresi `svc-123.us-central1.run.app`); aynı hesabın iki adresi bile
 *   farklı site sayılır, fazladan kesme olur ama başka kiracıya parola gitmez.
 * En uzun eşleşen giriş karar verir (`a.run.app` sonektir, `run.app`'in geri kalanı tam).
 */
const BARINDIRMA_ALANLARI = new Map<string, 'sonek' | 'tam'>([
  // Üç etiketli sonekler.
  ['a.run.app', 'sonek'], ['app.github.dev', 'sonek'], ['up.railway.app', 'sonek'],
  // İki etiketli sonekler.
  ['github.io', 'sonek'], ['gitlab.io', 'sonek'], ['github.dev', 'sonek'], ['vercel.app', 'sonek'],
  ['netlify.app', 'sonek'], ['herokuapp.com', 'sonek'], ['pages.dev', 'sonek'], ['workers.dev', 'sonek'],
  ['web.app', 'sonek'], ['firebaseapp.com', 'sonek'], ['cloudfunctions.net', 'sonek'], ['appspot.com', 'sonek'],
  ['azurewebsites.net', 'sonek'], ['azurestaticapps.net', 'sonek'], ['azurecontainerapps.io', 'sonek'],
  ['onrender.com', 'sonek'], ['fly.dev', 'sonek'], ['blogspot.com', 'sonek'], ['glitch.me', 'sonek'],
  ['ngrok.io', 'sonek'], ['ngrok.app', 'sonek'], ['ngrok-free.app', 'sonek'], ['ngrok-free.dev', 'sonek'],
  ['lovable.app', 'sonek'], ['surge.sh', 'sonek'], ['deno.dev', 'sonek'], ['repl.co', 'sonek'],
  ['replit.app', 'sonek'], ['replit.dev', 'sonek'], ['csb.app', 'sonek'], ['gitpod.io', 'sonek'],
  ['ondigitalocean.app', 'sonek'], ['koyeb.app', 'sonek'], ['elasticbeanstalk.com', 'sonek'],
  ['trycloudflare.com', 'sonek'], ['loca.lt', 'sonek'], ['serveo.net', 'sonek'],
  // Kiracıya ayrılmış bütün alan: tam origin.
  ['amazonaws.com', 'tam'], ['cloudfront.net', 'tam'], ['run.app', 'tam'],
]);
/**
 * Ülke kodlu TLD'lerde (iki harf) bu ikinci düzey etiketler de iki etiketli sonek sayılır:
 * `shop.com.tr` ↔ `bank.com.tr` aynı site sanılmasın.
 */
const GENEL_IKINCI_DUZEY = new Set([
  'co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'gen', 'ne', 'or', 'go', 'mil', 'nic', 'ltd', 'plc',
  'nom', 'web', 'biz', 'info', 'bel', 'av', 'bbs', 'k12', 'tv', 'me',
]);

function ipMi(host: string): boolean {
  return host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function normalAd(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

/** Adın en uzun eşleşen barındırma girişi (ad kendisi ya da `.giriş` ile bitiyorsa); yoksa null. */
function barindirmaGirisi(ad: string): { sonek: string; tur: 'sonek' | 'tam' } | null {
  const etiketler = ad.split('.');
  for (let i = 0; i < etiketler.length; i += 1) {
    const aday = etiketler.slice(i).join('.');
    const tur = BARINDIRMA_ALANLARI.get(aday);
    if (tur !== undefined) return { sonek: aday, tur };
  }
  return null;
}

/** Ad kiracıya ayrılmış bir barındırma alanında mı (`amazonaws.com` gibi)? Öyleyse tam origin gerekir. */
export function tamOriginIsterMi(host: string): boolean {
  return barindirmaGirisi(normalAd(host))?.tur === 'tam';
}

/**
 * Kayıtlı alan adını yaklaşık hesaplar: barındırma sonekinde sonek + bir etiket; ülke kodlu
 * genel ikinci düzeyde son üç; aksi halde son iki etiket.
 * IP, `localhost`, tek etiketli ad, kamu sonekinin kendisi ve `tam` alanlarda null.
 */
export function kayitliAlanAdi(host: string): string | null {
  const ad = normalAd(host);
  if (ad === '' || ipMi(ad) || ad === 'localhost') return null;
  const etiketler = ad.split('.');
  if (etiketler.length < 2) return null;
  const giris = barindirmaGirisi(ad);
  if (giris !== null) {
    if (giris.tur === 'tam') return null;
    const sonekEtiket = giris.sonek.split('.').length;
    // Adın kendisi sonek (ör. `github.io`): kayıtlı alan adı yok.
    if (etiketler.length <= sonekEtiket) return null;
    return etiketler.slice(-(sonekEtiket + 1)).join('.');
  }
  const [ikinci, tld] = etiketler.slice(-2) as [string, string];
  if (tld.length === 2 && GENEL_IKINCI_DUZEY.has(ikinci)) {
    // Adın kendisi kamu soneki (ör. `co.uk`): tam eşitlik iste.
    if (etiketler.length < 3) return null;
    return etiketler.slice(-3).join('.');
  }
  return etiketler.slice(-2).join('.');
}

/**
 * İki ana makine adı aynı sitede mi (port yok sayılır)? Birebir aynı ad her zaman aynı site;
 * IP/localhost/tek etiket/`tam` alanlarda yalnız birebir eşitlik, diğerlerinde kayıtlı alan adı.
 */
export function ayniSiteMi(hostA: string, hostB: string): boolean {
  const a = normalAd(hostA);
  const b = normalAd(hostB);
  if (a === b) return true;
  const kayitliA = kayitliAlanAdi(a);
  return kayitliA !== null && kayitliA === kayitliAlanAdi(b);
}

/** ws→http, wss→https; karşılaştırma için http(s) URL'ye çevirir. Desteklenmeyen şemada null. */
function httpAdres(url: string): URL | null {
  try {
    const adres = new URL(url);
    if (adres.protocol === 'ws:') adres.protocol = 'http:';
    else if (adres.protocol === 'wss:') adres.protocol = 'https:';
    if (adres.protocol !== 'http:' && adres.protocol !== 'https:') return null;
    return adres;
  } catch {
    return null;
  }
}

/**
 * İstek adresi izinli origin ile aynı sitede mi? Şema eşit olmalı, port serbest (tarayıcıların
 * same-site kuralı). IP/localhost/tek etiketli adlarda ana makine adı birebir eşit olmalı
 * (`localhost:5173` → `localhost:8080` aynı site, `localhost` → `127.0.0.1` değil); kiracıya
 * ayrılmış barındırma alanlarında (`amazonaws.com` …) tam origin; diğerlerinde kayıtlı alan adı.
 */
export function ayniSiteOriginMi(url: string, izinliOrigin: string): boolean {
  const adres = httpAdres(url);
  const izinli = httpAdres(izinliOrigin);
  if (adres === null || izinli === null) return false;
  if (adres.origin === izinli.origin) return true;
  if (adres.protocol !== izinli.protocol) return false;
  if (tamOriginIsterMi(adres.hostname) || tamOriginIsterMi(izinli.hostname)) return false;
  return ayniSiteMi(adres.hostname, izinli.hostname);
}

function parolaTasiyorMu(istek: Request, izler: string[]): boolean {
  if (izler.length === 0) return false;
  const govde = istek.postDataBuffer()?.toString('utf8') ?? '';
  const basliklar = Object.entries(istek.headers())
    .filter(([ad]) => basligiAra(ad))
    .map(([, deger]) => deger)
    .join('\n');
  return metinParolaTasiyorMu(`${istek.url()}\n${basliklar}\n${govde}`, izler);
}

function metinParolaTasiyorMu(metin: string, izler: string[]): boolean {
  if (izler.length === 0) return false;
  let cozulmus = metin;
  try { cozulmus = decodeURIComponent(metin.replace(/\+/g, ' ')); } catch { /* bozuk kodlama: ham metinle yetin */ }
  return izler.some((iz) => metin.includes(iz) || cozulmus.includes(iz));
}

export interface GirisKorumasi {
  /** Parola alana yazılmadan hemen önce çağrılır: giriş penceresi başlar (sıkı kural). */
  pencereyiAc(): void;
  /**
   * Giriş penceresi (gönderim + URL değişimi + kısa ağ durulması) bitince çağrılır;
   * pencereyi kapatır (gevşek kural) ve sızıntı ya da açıklanması gereken engel varsa fırlatır.
   */
  denetle(girisBasarili: boolean): void;
  /** Keşif bitip sonuç dönmeden önce çağrılır; giriş sonrası bir sızıntı denendiyse fırlatır. */
  sonDenetim(): void;
}

type Evre = 'serbest' | 'pencere';

const korumalar = new WeakMap<BrowserContext, GirisKorumasi>();

function kokenAdi(url: string): string {
  return httpAdres(url)?.origin ?? url;
}

function sizintiHatasi(sizanOriginler: Set<string>, izinliOrigin: string, sonra: boolean): CredentialLeakBlockedError {
  return new CredentialLeakBlockedError(
    `The ${sonra ? 'app tried, after login,' : 'login page tried'} to send the credentials to a different site `
      + `(${[...sizanOriginler].join(', ')}); credentials are only sent to ${izinliOrigin} and its own site. `
      + `${sonra ? 'Exploration' : 'Login'} was stopped. `
      + 'A separate auth site (SSO) is not supported. Locally, ports may differ but the host name must match (localhost and 127.0.0.1 are different sites).',
  );
}

/**
 * Bağlamdaki tüm sayfaların (açılır pencereler dahil) isteklerini ve WebSocket'lerini
 * izinli siteye göre süzer. Kaldırılmaz: bağlam kapanınca kendiliğinden biter.
 * Aynı bağlama ikinci kez çağrılırsa var olan korumayı döndürür.
 */
export async function girisKorumasiKur(
  context: BrowserContext,
  kimlik: Kimlik,
  izinliOrigin: string,
): Promise<GirisKorumasi> {
  const varOlan = korumalar.get(context);
  if (varOlan !== undefined) return varOlan;
  const izler = parolaIzleri(kimlik);
  const sizanOriginler = new Set<string>();
  /** Giriş penceresinde kesilen, parola görünmeyen siteler-arası yazmalar (bilgi amaçlı). */
  const kesilenYazmalar = new Set<string>();
  let evre: Evre = 'serbest';
  const yabanciMi = (url: string): boolean => !ayniSiteOriginMi(url, izinliOrigin);

  const yakala = async (route: Route, istek: Request): Promise<void> => {
    const url = istek.url();
    if (httpAdres(url) === null || !yabanciMi(url)) {
      await route.fallback();
      return;
    }
    if (parolaTasiyorMu(istek, izler)) {
      sizanOriginler.add(kokenAdi(url));
      await route.abort('blockedbyclient');
      return;
    }
    if (evre === 'pencere' && !GUVENLI_YONTEMLER.has(istek.method().toUpperCase())) {
      kesilenYazmalar.add(`${istek.method()} ${kokenAdi(url)}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.fallback();
  };
  // Yönlendirmenin (ör. 307/308) sonraki ayağı route'a uğramaz: KESİLEMEZ, istek karşı
  // sunucuya ulaşır. Burada yalnız görülür ve giriş/keşif reddedilir (tespit + ret, engel değil).
  const izle = (istek: Request): void => {
    if (istek.redirectedFrom() === null) return;
    const url = istek.url();
    if (httpAdres(url) !== null && yabanciMi(url) && parolaTasiyorMu(istek, izler)) sizanOriginler.add(kokenAdi(url));
  };
  // Siteler-arası WebSocket. Adreste parola varsa hiç bağlanmaz ve sızıntı sayılır. Giriş
  // penceresinde açılan sunucuya hiç bağlanmaz (connectToServer çağrılmaz, sayfa `open`
  // görmeden 1008 ile kapanır). Aksi halde bağlanır; sayfanın gönderdiği her mesaj denetlenir:
  // parola görünüyorsa iletilmez (sızıntı), giriş penceresi sürerken hiçbir mesaj iletilmez.
  const wsYakala = (ws: WebSocketRoute): void => {
    const origin = kokenAdi(ws.url());
    const kapat = (): void => {
      void ws.close({ code: 1008, reason: 'kobay: cross-site WebSocket blocked' }).catch(() => undefined);
    };
    if (metinParolaTasiyorMu(ws.url(), izler)) {
      sizanOriginler.add(origin);
      kapat();
      return;
    }
    if (evre === 'pencere') {
      kesilenYazmalar.add(`WebSocket ${origin}`);
      kapat();
      return;
    }
    const sunucu = ws.connectToServer();
    ws.onMessage((mesaj) => {
      const metin = typeof mesaj === 'string' ? mesaj : mesaj.toString('utf8');
      if (metinParolaTasiyorMu(metin, izler)) {
        sizanOriginler.add(origin);
        return;
      }
      if (evre === 'pencere') {
        kesilenYazmalar.add(`WebSocket ${origin}`);
        return;
      }
      sunucu.send(mesaj);
    });
  };

  await context.route('**', yakala);
  await context.routeWebSocket((url) => yabanciMi(url.href), wsYakala);
  context.on('request', izle);

  const koruma: GirisKorumasi = {
    pencereyiAc() {
      evre = 'pencere';
    },
    denetle(girisBasarili) {
      evre = 'serbest';
      if (sizanOriginler.size > 0) throw sizintiHatasi(sizanOriginler, izinliOrigin, false);
      if (!girisBasarili && kesilenYazmalar.size > 0) {
        throw new CredentialLeakBlockedError(
          `Login did not complete: during login the page tried to write to a different site `
            + `(${[...kesilenYazmalar].join(', ')}) and kobay blocked it; credentials are only sent to ${izinliOrigin} `
            + 'and its own site. A separate auth site (SSO) is not supported. Locally, ports may differ but the host name must match (localhost and 127.0.0.1 are different sites).',
        );
      }
    },
    sonDenetim() {
      // denetle sızıntıda zaten fırlattığı için buraya gelen her kayıt giriş penceresi dışındadır.
      if (sizanOriginler.size > 0) throw sizintiHatasi(sizanOriginler, izinliOrigin, true);
    },
  };
  korumalar.set(context, koruma);
  return koruma;
}

/** Bağlamda giriş koruması kurulduysa son denetimi yapar; kurulmadıysa (giriş yoksa) bir şey yapmaz. */
export function girisKorumasiSonDenetim(context: BrowserContext): void {
  korumalar.get(context)?.sonDenetim();
}
