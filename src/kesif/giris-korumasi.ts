import type { BrowserContext, Frame, Page, Request, Route, WebSocketRoute } from '@playwright/test';
import type { Kimlik } from '../depo/index.js';

/**
 * Parola sayfaya yazıldıktan sonra JavaScript'in (fetch, XHR, sendBeacon, img, açılır
 * pencere, WebSocket) onu başka SİTEYE göndermesine karşı ağ katmanı koruması.
 *
 * İzinli küme (`izinliKumedeMi`): `baseUrl` origin'inin SİTESİ ve kullanıcının `--login` ile
 * onayladığı auth origin'ler (SSO) yalnız TAM origin olarak. `https://yourco.okta.com`
 * listedeyken `evilco.okta.com` ya da `yourco.okta.com:444` yabancıdır.
 *
 * `baseUrl` için "aynı site": origin'in kendisi ya da aynı şema + aynı kayıtlı alan adı
 * (`app.example.com` ↔ `api.example.com`), port serbest. localhost, IP ve tek etiketli adlarda
 * şema + ana makine adı eşitliği (port serbest: `localhost:5173` ↔ `localhost:8080`; ama
 * `localhost` ↔ `127.0.0.1` farklı). Kiracıya ayrılmış barındırma alanlarında (`amazonaws.com`,
 * `cloudfront.net`, bölgesel `run.app`) tam origin eşitliği. Bkz. `ayniSiteMi`, `ayniSiteOriginMi`.
 *
 * Süre: keşif bağlamının ilk sayfasından önce kurulur (WebSocket yönlendirmesi yalnız sonra
 * açılan belgelere işler) ve bağlam (BrowserContext) kapanana kadar kalır. Üç evre:
 *
 * 0. Pencere öncesi: yalnız parolayı görünür biçimde taşıyan siteler-arası istek kesilir.
 * 1. Giriş penceresi (`pencereyiAc` → parola yazılır, gönderilir, URL değişir, ≤2 sn ağ
 *    durulması → `denetle`) ve 2. giriş sonrası (`denetle` → bağlam kapanışı) birlikte
 *    "kimlikli evre"dir: parola bu bağlama girdi, sayfa JS'i onu okuyup kodlamış olabilir.
 *    İzinli küme dışına HİÇBİR istek gitmez:
 *    - parola taşıyan istek kesilir ve sızıntı sayılır (pencerede giriş, sonra keşif reddedilir);
 *    - belge navigasyonu (ana çerçeve, iframe, popup), yazma (GET/HEAD/OPTIONS dışı yöntem,
 *      sendBeacon) ve GET/HEAD/OPTIONS alt kaynak kesilir;
 *    - yeni WebSocket sunucuya hiç bağlanmaz; pencere öncesinde açılmış WebSocket'in mesajı ve
 *      kapanış kodu/nedeni yabancıya iletilmez.
 *    Parola görünmeyen kesimler bilgi amaçlıdır: pencerede giriş başarısızsa belge ve yazma
 *    kesimi giriş hatası olur, yalnız okuma kesimi hata değil ipucudur (`kesimNotu`); keşif
 *    başarılıysa `sonDenetim` stderr'e tek uyarı satırı yazar.
 *    Pencereye özgü ek kurallar: pencere açılırken bitmemiş yabancı belge isteği varsa parola
 *    yazılmadan reddedilir, pencere içinde yine de yabancı origin'e commit eden çerçeve sızıntı
 *    sayılır (`framenavigated`; açılır pencerenin `page` olayından önce commit olan ilk belgesi
 *    o anki URL'den okunur).
 *
 * Engellenemeyen yol: izinli bir uç HTTP yönlendirmesiyle (301/302/303/307/308) başka siteye
 * yönlendirirse Chromium ikinci ayağı (belge ya da alt kaynak) route'a uğratmaz. kobay bunu kimlikli
 * evrede `request` olayında yalnız TESPİT EDER; istek karşı sunucuya ulaşmıştır. Pencerede belge
 * yönlendirmesi girişi reddettirir (0.4.0); belge olmayan ayak (ör. avatar → S3) yalnız uyarıda
 * "reached … via redirect during/after login" diye sayılır. Ayakta parola açıkça görünüyorsa
 * sızıntı kuralı yine işler. Service worker istekleri
 * route'a uğramadığı için kimlikli keşif bağlamı `serviceWorkers: 'block'` ile açılır
 * (bkz. `kesfet`, `sayfayiYenile`).
 */
export class CredentialLeakBlockedError extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'CredentialLeakBlockedError';
  }
}

/**
 * Giriş tamamlanmadığında pencerede kesilen yabancı belge ya da yazmayı açıklayan ret
 * (`denetle(false)`). Sızıntı değil, açıklamadır; `CredentialLeakBlockedError` olarak kalır
 * (adı ve çıkış kodu aynı). Ayrı alt sınıf, gönder tıklaması zaman aşımında bu açıklamanın
 * düğme durumuyla tek hatada birleştirilebilmesi içindir; gerçek sızıntı hatası birleştirilmez.
 */
export class LoginBlockedRequestsError extends CredentialLeakBlockedError {}

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

/**
 * Çerez ve depolama (localStorage) değerleri bundan kısaysa çıktı maskesine girmez: `1`, `en`,
 * `true`, `dark` gibi bayraklar sır değildir ve kobay'ın kendi metnini bozar. Oturum belirteçleri uzundur.
 */
export const EN_KISA_GIZLI_DEGER = 8;
/** Kullanıcı adı/parola biçimi bundan kısaysa metinde aranıp değiştirilmez (sıradan sözcükleri bozar); bkz. `metniGizle`. */
const EN_KISA_DEGISTIRILEN = 4;

/** Değerin çıktıda görünebileceği biçimleri: ham, URL-kodlu, form-kodlu, JSON kaçışlı. */
function degerBicimleri(deger: string): string[] {
  const bicimler = [deger, encodeURIComponent(deger), new URLSearchParams({ p: deger }).toString().slice(2),
    JSON.stringify(deger).slice(1, -1)];
  try {
    bicimler.push(decodeURIComponent(deger));
  } catch {
    // Yüzde kodlaması bozuk değer: ham biçim yeter.
  }
  return bicimler;
}

/**
 * Çıktı maskesinin kimlik envanteri: kullanıcı adı ve parola, HER uzunlukta (ağ sızıntısı
 * eşiği `EN_KISA_ARANAN_PAROLA` burada uygulanmaz), olası kodlanmış biçimleriyle.
 */
export function kimlikIzleri(kimlik: Kimlik): string[] {
  const izler = new Set<string>([...degerBicimleri(kimlik.username), ...degerBicimleri(kimlik.password)]);
  // Tarayıcının innerText'i boşlukları sadeleştirir (baştaki/sondakini atar, art arda olanı teke
  // indirir); sayfa metninde kimliğin bu biçimi ve boşluksuz biçimi de maskelensin.
  for (const deger of [kimlik.username, kimlik.password]) {
    const sade = deger.replace(/\s+/g, ' ').trim();
    const bosluksuz = deger.replace(/\s+/g, '');
    for (const bicim of [sade, bosluksuz]) if (bicim !== deger) degerBicimleri(bicim).forEach((iz) => izler.add(iz));
  }
  // Kullanıcı adının base64 biçimi parolanınkiyle simetrik (sayfa uyarısı onu kodlu gösterebilir).
  if (kimlik.username !== '') izler.add(Buffer.from(kimlik.username, 'utf8').toString('base64').replace(/=+$/, ''));
  if (kimlik.password !== '') {
    izler.add(Buffer.from(kimlik.password, 'utf8').toString('base64').replace(/=+$/, ''));
    izler.add(Buffer.from(`${kimlik.username}:${kimlik.password}`, 'utf8').toString('base64').replace(/=+$/, ''));
  }
  izler.delete('');
  return [...izler];
}

/** Envanterdeki en çok biçim sayısı; aşılırsa envanter eksik sayılır (sayfa alanları `[withheld]`). */
export const EN_COK_GIZLI_BICIM = 256;
/** Bundan uzun çerez/depolama değeri bütün olarak envantere girmez (JSON ise yaprakları yine bakılır). */
export const EN_UZUN_GIZLI_DEGER = 1_024;
/** Maske kendisi hata verirse mesajın yerine geçen metin; ham mesaj asla basılmaz. */
export const GIZLI_HATA_METNI = 'Login error (details withheld to protect credentials).';

/**
 * Kullanıcı bilgisi (`user:pass@`) taşımayan mutlak adres mi (`scheme://host…`)? Böyle değerler
 * (ör. localStorage'da `{"api":"http://localhost:47518"}`) sır sayılmaz: yoksa kesim notundaki
 * origin ve `--auth-origin` önerisi maskelenir, kullanıcı çözüm yolunu göremez.
 */
function sirsizAdresMi(deger: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(deger)) return false;
  try {
    const adres = new URL(deger);
    return adres.username === '' && adres.password === '';
  } catch {
    return false;
  }
}

/**
 * Çerez/depolama değerinin maskeye girecek biçimleri (JSON ise içindeki uzun metin yaprakları da).
 * Kısa değerler (`EN_KISA_GIZLI_DEGER`), çok uzun değerler (`EN_UZUN_GIZLI_DEGER`) ve kullanıcı
 * bilgisiz mutlak adresler girmez.
 */
export function depoDegeriIzleri(deger: string): string[] {
  const adaylar = [deger];
  try {
    const yapraklar = (veri: unknown): void => {
      if (typeof veri === 'string') adaylar.push(veri);
      else if (Array.isArray(veri)) veri.forEach(yapraklar);
      else if (typeof veri === 'object' && veri !== null) Object.values(veri).forEach(yapraklar);
    };
    yapraklar(JSON.parse(deger));
  } catch {
    // JSON değil.
  }
  const uygun = (metin: string): boolean => metin.length >= EN_KISA_GIZLI_DEGER && !sirsizAdresMi(metin);
  return adaylar.filter((aday) => aday.length <= EN_UZUN_GIZLI_DEGER && uygun(aday)).flatMap(degerBicimleri)
    .filter(uygun);
}

function kacisli(metin: string): string {
  return metin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Metindeki adresler (`http://…`, `ws://…`); yabancı origin'ler mesaja bu biçimde girer. */
const ADRES_DESENI = /\b[a-z][a-z0-9+.-]*:\/\/[^\s,;()"'<>]+/gi;

/**
 * Kullanıcıya gidecek metinden sırları çıkaran maske (bir girişin sır envanteri).
 * - 4+ karakterlik her sır biçimi (büyük/küçük harf duyarsız) `[redacted]` olur.
 * - Daha kısa sır kobay'ın kendi metninde de geçebileceği için metin genelinde değiştirilemez;
 *   yabancı kontrolündeki parçalar ayrı ele alınır: içinde kısa sır geçen adres `[redacted address]`
 *   olur, `alan: true` ise (sayfadan okunan düğme metni gibi) metnin tamamı `[withheld]` olur.
 * - Envanter eksikse (sayfa yanıt vermedi, tavan aşıldı) her boş olmayan alan `[withheld]` olur.
 * - Derlenmiş düzenli ifade envanter değişene kadar önbellekte kalır. Maske kendisi hata
 *   verirse ham metin dönmez: alan `[withheld]`, mesaj `GIZLI_HATA_METNI` olur.
 */
export class SirMaskesi {
  private readonly gizliler = new Set<string>();
  private eksik = false;
  private onbellek: { uzun: RegExp | null; kisalar: string[] } | null = null;

  /** `kimlikIzleri` tavana bakılmadan girer (birkaç biçim). */
  constructor(kimlikBicimleri: Iterable<string> = []) {
    for (const bicim of kimlikBicimleri) if (bicim !== '') this.gizliler.add(bicim);
  }

  /** Çerez/depolama değerlerini ekler; tavan aşılırsa envanter eksik sayılır. */
  depoEkle(degerler: Iterable<string>): void {
    for (const deger of degerler) {
      for (const iz of depoDegeriIzleri(deger)) {
        if (this.gizliler.has(iz)) continue;
        if (this.gizliler.size >= EN_COK_GIZLI_BICIM) {
          this.eksik = true;
          return;
        }
        this.gizliler.add(iz);
        this.onbellek = null;
      }
    }
  }

  eksikIsaretle(): void {
    this.eksik = true;
  }

  eksikMi(): boolean {
    return this.eksik;
  }

  gizle(metin: string, secenek: { alan?: boolean } = {}): string {
    try {
      return this.gizleIc(metin, secenek.alan === true);
    } catch {
      return secenek.alan === true ? '[withheld]' : GIZLI_HATA_METNI;
    }
  }

  private gizleIc(metin: string, alan: boolean): string {
    if (alan && this.eksik && metin.trim() !== '') return '[withheld]';
    if (this.onbellek === null) {
      const tekil = [...this.gizliler];
      const uzunlar = tekil.filter((gizli) => gizli.length >= EN_KISA_DEGISTIRILEN).sort((a, b) => b.length - a.length);
      this.onbellek = {
        uzun: uzunlar.length === 0 ? null : new RegExp(uzunlar.map(kacisli).join('|'), 'gi'),
        kisalar: tekil.filter((gizli) => gizli.length < EN_KISA_DEGISTIRILEN).map((gizli) => gizli.toLowerCase()),
      };
    }
    const { uzun, kisalar } = this.onbellek;
    const sonuc = uzun === null ? metin : metin.replace(uzun, '[redacted]');
    if (kisalar.length === 0) return sonuc;
    const kisaIceriyor = (parca: string): boolean => kisalar.some((kisa) => parca.toLowerCase().includes(kisa));
    if (alan) return kisaIceriyor(sonuc) ? '[withheld]' : sonuc;
    return sonuc.replace(ADRES_DESENI, (adres) => (kisaIceriyor(adres) ? '[redacted address]' : adres));
  }
}

/** Tek seferlik maske (`SirMaskesi`); koruma kurulmadan önceki hatalar için. */
export function metniGizle(metin: string, gizliler: Iterable<string>, secenek: { alan?: boolean } = {}): string {
  return new SirMaskesi(gizliler).gizle(metin, secenek);
}

const ZAMAN_ASIMI: unique symbol = Symbol('zaman-asimi');

/**
 * Sayfa-içi çağrıyı (evaluate, çerez okuma) en çok `ms` bekler; dolarsa `ZAMAN_ASIMI` döner.
 * JavaScript'i donmuş sayfada `page.evaluate`in kendi süresi yoktur; bekleyen söz sonradan
 * reddedilirse yutulur.
 */
export async function sinirli<T>(is: Promise<T>, ms: number): Promise<T | typeof ZAMAN_ASIMI> {
  is.catch(() => undefined);
  let zamanlayici: ReturnType<typeof setTimeout> | undefined;
  const sure = new Promise<typeof ZAMAN_ASIMI>((coz) => { zamanlayici = setTimeout(() => { coz(ZAMAN_ASIMI); }, ms); });
  try {
    return await Promise.race([is, sure]);
  } finally {
    clearTimeout(zamanlayici);
  }
}

export function zamanAsimiMi(deger: unknown): deger is typeof ZAMAN_ASIMI {
  return deger === ZAMAN_ASIMI;
}

/** Giriş yolundaki tek bir sayfa-içi okumanın (evaluate, çerez/depolama) en uzun süresi. */
export const GIRIS_SAYFA_ICI_MS = 2_000;

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
 * Parolanın gidebileceği küme kararı (form hedefi, ağ süzgeci, WebSocket ve son denetim için tek
 * kural): `baseUrl` origin'i aynı-site kuralıyla (`ayniSiteOriginMi`: alt alan ve port serbest),
 * auth origin'ler (SSO) yalnız TAM origin eşitliğiyle. `ws:`/`wss:` adresleri `http:`/`https:`
 * sayılır. `baseOrigin` verilmezse yalnız auth origin'ler izinlidir.
 */
export function izinliKumedeMi(url: string, baseOrigin: string | undefined, authOrigins: readonly string[]): boolean {
  if (baseOrigin !== undefined && ayniSiteOriginMi(url, baseOrigin)) return true;
  const adres = httpAdres(url);
  if (adres === null) return false;
  return authOrigins.some((origin) => httpAdres(origin)?.origin === adres.origin);
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
  /**
   * Parola alana yazılmadan hemen önce çağrılır: giriş penceresi ve kimlikli evre başlar.
   * Daha önce başlamış, henüz bitmemiş yabancı belge isteği varsa parola yazılmadan reddeder.
   */
  pencereyiAc(): void;
  /**
   * Giriş penceresinde kesilen yabancı okumaların (GET/HEAD/OPTIONS) ipucu; giriş başarısız
   * olduğunda var olan hata mesajının sonuna eklenir. Kesim yoksa boş metin.
   */
  kesimNotu(): string;
  /**
   * Giriş penceresi (gönderim + URL değişimi + kısa ağ durulması) bitince çağrılır;
   * pencereyi kapatır (kimlikli evre bağlam kapanana kadar sürer) ve sızıntı ya da
   * açıklanması gereken engel varsa fırlatır.
   */
  denetle(girisBasarili: boolean): readonly string[];
  /**
   * Keşif bitip sonuç dönmeden önce çağrılır; giriş sonrası bir sızıntı denendiyse fırlatır.
   * Kimlikli evrede parola görünmeyen kesim olduysa stderr'e tek uyarı satırı yazar.
   */
  sonDenetim(): void;
  /**
   * Kullanıcıya gidecek metni bu girişin sır envanterine göre maskeler (`metniGizle`):
   * kimlik (her uzunlukta), kurulumda yüklü oturumun çerez/localStorage değerleri ve
   * `gizlilereEkle` ile eklenenler. Koruma kendi hata ve uyarılarını zaten maskeler.
   */
  metniGizle(metin: string, secenek?: { alan?: boolean }): string;
  /** Çerez/depolama değerlerini envantere ekler (`EN_KISA_GIZLI_DEGER`'den kısalar girmez). */
  gizlilereEkle(degerler: Iterable<string>): void;
  /** Envanter okunamadı (sayfa yanıt vermedi): sayfadan alınan alanlar bundan sonra `[withheld]`. */
  envanterEksik(): void;
  envanterEksikMi(): boolean;
}

/** `once`: parola henüz yazılmadı; `pencere`: giriş penceresi; `sonra`: giriş sonrası (kimlikli). */
type Evre = 'once' | 'pencere' | 'sonra';

const korumalar = new WeakMap<BrowserContext, GirisKorumasi>();

function kokenAdi(url: string): string {
  return httpAdres(url)?.origin ?? url;
}

/**
 * Çerçeve adresinin taşıdığı ağ origin'i: http(s) adreste kendisi, `blob:<origin>/<uuid>`
 * adreste blob'u yaratan origin (blob o origin'in JS'iyle çalışır). `blob:null/...`,
 * `data:`, `about:blank`, `about:srcdoc` ve diğer şemalarda null: opaque ya da miras alınan
 * origin'dir, URL'den okunamaz.
 */
export function cerceveAgOrigini(url: string): string | null {
  if (url.startsWith('blob:')) {
    try {
      const origin = new URL(url).origin;
      return httpAdres(origin) === null ? null : origin;
    } catch {
      return null;
    }
  }
  return httpAdres(url)?.origin ?? null;
}

/**
 * Parola yazılmadan hemen önceki çerçevelerden izinli küme dışındaki http(s) origin'lerini
 * döndürür; `blob:` adres kendisini yaratan origin'e göre sınıflanır
 * (`blob:https://evil/...` yabancıdır). `about:blank`, `about:srcdoc`, `blob:null` ve
 * `data:` listeye girmez: URL'leri bir ağ origin'i taşımaz ve ağ çıkışları yine route'tan geçer.
 */
export function yabanciCerceveler(
  cerceveAdresleri: readonly string[],
  baseOrigin: string | undefined,
  authOrigins: readonly string[],
): string[] {
  const originler = cerceveAdresleri
    .map(cerceveAgOrigini)
    .filter((origin): origin is string => origin !== null && !izinliKumedeMi(origin, baseOrigin, authOrigins));
  return [...new Set(originler)];
}

/**
 * Yabancı origin(ler) için ortak `--auth-origin` ipucu; her mesajın son cümlesi olarak kullanılır.
 * Tam komut verilmez: `project update --auth-origin` kayıtlı listenin tamamını değiştirir.
 */
export function authOriginIpucu(originler: readonly string[]): string {
  const tekil = [...new Set(originler)];
  const bayraklar = tekil.map((origin) => `--auth-origin ${origin}`).join(' ');
  return tekil.length === 1
    ? `If this origin is part of your login flow, add it with ${bayraklar}`
    : `If these origins are part of your login flow, add them with ${bayraklar}`;
}

/**
 * Parola yazılmadan bulunan yabancı belge için ortak ret ve `--auth-origin` ipucu. Belge iframe,
 * açılır pencere ya da ana çerçeve navigasyonu olabilir; mesaj türden bağımsızdır.
 * `yukleniyor`: istek başlamış ama belge henüz commit olmamış (bekleyen istek listesi).
 */
export function yabanciBelgeHatasi(origin: string, durum: 'acik' | 'yukleniyor' = 'acik'): CredentialLeakBlockedError {
  const nerede = durum === 'acik'
    ? 'is loaded in the browser alongside the login page (in a frame or a popup)'
    : 'is still loading in the login window';
  return new CredentialLeakBlockedError(
    `Login refused: a document from ${origin} ${nerede}, which is outside the trusted set; `
      + `the password was not typed. ${authOriginIpucu([origin])}`,
  );
}

/** Kimlikli evre kesimlerinin `--auth-origin` ipucu (güven anlamı: parola o origin'e emanet edilir). */
function guvenIpucu(originler: readonly string[], cumleBasi = true): string {
  const tekil = [...new Set(originler)];
  const ekle = cumleBasi ? 'Add' : 'add';
  return tekil.length === 1
    ? `${ekle} --auth-origin ${tekil[0] ?? ''} if you trust it with the password`
    : `${ekle} --auth-origin <origin> for each origin you trust with the password`;
}

function orneklerMetni(originler: readonly string[]): string {
  const tekil = [...new Set(originler)];
  return `${tekil.slice(0, 3).join(', ')}${tekil.length > 3 ? ', ...' : ''}`;
}

function belgeYuklemeOzeti(eylem: 'blocked', originler: readonly string[]): string {
  const tekilOriginler = [...new Set(originler)];
  const ornekler = tekilOriginler.slice(0, 3).join(', ');
  const devam = tekilOriginler.length > 3 ? ', ...' : '';
  return `${eylem} ${originler.length} cross-origin document load${originler.length === 1 ? '' : 's'} during login: `
    + `${ornekler}${devam}`;
}

/**
 * Ayrı giriş sitesi (SSO) ipucu; `oturum.ts`'teki `SSO_IPUCU` ile aynı metin (döngüsel içe
 * aktarma olmasın diye burada da duruyor). Auth origin listesi varsa ipucu verilmez.
 */
const SSO_IPUCU = 'If login runs on a separate auth site (SSO), allow its exact origin with'
  + ' `kobay project update --login --auth-origin <origin>`.';

/** İzinli kümenin okunur metni: `baseUrl` origin'i sitesiyle, auth origin'ler tam origin olarak. */
export function izinliMetni(baseOrigin: string | undefined, authOrigins: readonly string[]): string {
  const parcalar = [
    ...(baseOrigin === undefined ? [] : [`${baseOrigin} and its own site`]),
    ...(authOrigins.length === 0 ? [] : [`exactly ${authOrigins.join(', ')} (exact origin only)`]),
  ];
  return parcalar.join(', and ');
}

function ipucuMetni(authOrigins: readonly string[]): string {
  return authOrigins.length === 0 ? ` ${SSO_IPUCU}` : '';
}

function sizintiHatasi(
  sizanOriginler: Set<string>,
  baseOrigin: string | undefined,
  authOrigins: readonly string[],
  sonra: boolean,
): CredentialLeakBlockedError {
  return new CredentialLeakBlockedError(
    `The ${sonra ? 'app tried, after login,' : 'login page tried'} to send the credentials to a different site `
      + `(${[...sizanOriginler].join(', ')}); credentials are only sent to ${izinliMetni(baseOrigin, authOrigins)}. `
      + `${sonra ? 'Exploration' : 'Login'} was stopped. `
      + 'Locally, ports may differ but the host name must match (localhost and 127.0.0.1 are different sites).'
      + ipucuMetni(authOrigins),
  );
}

/**
 * Koruma kümesi kimliğin onayladığı kümeyi aşamaz: her izinli origin ya kimliğin origin'i ya da
 * kimlik verilirken onaylanan auth origin'lerden biri olmalı. Çağıran yanlış küme geçse bile
 * parolanın gidebileceği yer sessizce büyümez; koruma hiç kurulmadan reddedilir.
 */
function kumeKimlikteOnayliMi(kimlik: Kimlik, izinliOriginler: readonly string[]): boolean {
  if (izinliOriginler.length === 0 || kimlik.origin === undefined) return false;
  const onayli = new Set([kimlik.origin, ...(kimlik.authOrigins ?? []).map((origin) => kokenAdi(origin))]);
  return izinliOriginler.every((origin) => onayli.has(origin));
}

/**
 * Bağlamdaki tüm sayfaların (açılır pencereler dahil) isteklerini ve WebSocket'lerini
 * izinli kümeye (baseUrl origin'inin sitesi + tam auth origin'ler, bkz. `izinliKumedeMi`) göre süzer. Kaldırılmaz: bağlam kapanınca kendiliğinden biter.
 * Aynı bağlama ikinci kez çağrılırsa var olan korumayı döndürür.
 */
export async function girisKorumasiKur(
  context: BrowserContext,
  kimlik: Kimlik,
  izinliOriginler: readonly string[],
): Promise<GirisKorumasi> {
  const varOlan = korumalar.get(context);
  if (varOlan !== undefined) return varOlan;
  if (!kumeKimlikteOnayliMi(kimlik, izinliOriginler)) {
    throw new CredentialLeakBlockedError(
      `The allowed origins (${izinliOriginler.join(', ') || 'none'}) were not approved when the credentials were saved;`
        + ' the password was not sent.',
    );
  }
  // Çıktı maskesinin envanteri. Yüklü oturumun (sayfayiYenile'de storageState) çerez ve
  // localStorage değerleri, sayfa onları silmeden ve yönlendirmeler kurulmadan önce okunur.
  const maske = new SirMaskesi(kimlikIzleri(kimlik));
  const yuklu = await sinirli(Promise.resolve().then(() => context.storageState()), GIRIS_SAYFA_ICI_MS)
    .catch(() => undefined);
  if (yuklu === undefined || zamanAsimiMi(yuklu)) {
    maske.eksikIsaretle();
  } else {
    maske.depoEkle(yuklu.cookies.map((cerez) => cerez.value));
    maske.depoEkle(yuklu.origins.flatMap((origin) => origin.localStorage.map((oge) => oge.value)));
  }
  const gizle = (metin: string): string => maske.gizle(metin);
  const hatayiGizle = <T>(hata: T): T => {
    if (hata instanceof Error) hata.message = gizle(hata.message);
    return hata;
  };
  // Kimliğin kendi origin'i (`baseUrl`) aynı-site kuralıyla, geri kalanlar (auth origin'ler) tam origin.
  const baseOrigin = izinliOriginler.find((origin) => origin === kimlik.origin);
  const authListesi = izinliOriginler.filter((origin) => origin !== kimlik.origin);
  const izler = parolaIzleri(kimlik);
  const sizanOriginler = new Set<string>();
  /** Giriş penceresinde kesilen, parola görünmeyen siteler-arası yazmalar (bilgi amaçlı). */
  const kesilenYazmalar = new Set<string>();
  /** Giriş penceresinde route tarafından kesilen yabancı belge yüklemeleri. */
  const kesilenBelgeler: string[] = [];
  /** Chromium route'a uğratmadığı için yalnız tespit edilen yabancı belge yönlendirmeleri. */
  const tespitEdilenBelgeYondirmeleri: string[] = [];
  /** Pencere öncesinde başlamış, cevabı/commit'i henüz bitmemiş yabancı belge istekleri. */
  const bekleyenYabanciBelgeler = new Map<Request, string>();
  /** Giriş penceresi açıkken gerçekten yabancı origin'e commit eden çerçeveler. */
  const commitOlanYabanciBelgeler: string[] = [];
  /** Giriş penceresinde kesilen yabancı okumalar (GET/HEAD/OPTIONS; bilgi amaçlı, `kesimNotu`). */
  const kesilenOkumalar: string[] = [];
  /**
   * Kimlikli evrede tespit edilen, belge olmayan yabancı yönlendirme ayakları: kesilemedi, karşı
   * sunucuya ulaştı. Girişi reddettirmez (meşru avatar → S3 gibi yönlendirmeler); uyarıda ayrı sayılır.
   * `pencere`: giriş sırasında, `sonra`: giriş sonrasında.
   */
  const yonlendirmeyleUlasan = {
    pencere: { sayi: 0, originler: [] as string[] },
    sonra: { sayi: 0, originler: [] as string[] },
  };
  /** `denetle`nin gördüğü giriş sonucu; uyarı metni "during"/"after login" buna göre seçilir. */
  let girisTamamlandi = false;
  /**
   * Kimlikli evrede parola görünmeden kesilen yabancı istekler (bilgi amaçlı, `sonDenetim` uyarısı).
   * Pencerede kesilen belge yüklemeleri `denetle`nin kendi uyarısında sayıldığı için buraya girmez.
   */
  let kimlikliKesimSayisi = 0;
  const kimlikliKesimOriginleri: string[] = [];
  let kimlikliUyariYazildi = false;
  const kimlikliKesim = (origin: string): void => {
    kimlikliKesimSayisi += 1;
    if (!kimlikliKesimOriginleri.includes(origin)) kimlikliKesimOriginleri.push(origin);
  };
  let evre: Evre = 'once';
  const yabanciMi = (url: string): boolean => !izinliKumedeMi(url, baseOrigin, authListesi);

  const yakala = async (route: Route, istek: Request): Promise<void> => {
    const url = istek.url();
    if (httpAdres(url) === null || !yabanciMi(url)) {
      await route.fallback();
      return;
    }
    const origin = kokenAdi(url);
    if (parolaTasiyorMu(istek, izler)) {
      sizanOriginler.add(origin);
      await route.abort('blockedbyclient');
      return;
    }
    if (evre === 'once') {
      await route.fallback();
      return;
    }
    // Kimlikli evre (pencere + giriş sonrası): parola bu bağlama yazıldı, yabancıya hiçbir istek gitmez.
    // Türler yalnız raporlama içindir.
    if (istek.isNavigationRequest()) {
      if (evre === 'pencere') kesilenBelgeler.push(origin);
      else kimlikliKesim(origin);
    } else if (!GUVENLI_YONTEMLER.has(istek.method().toUpperCase())) {
      if (evre === 'pencere') kesilenYazmalar.add(`${istek.method()} ${origin}`);
      kimlikliKesim(origin);
    } else {
      if (evre === 'pencere') kesilenOkumalar.push(origin);
      kimlikliKesim(origin);
    }
    await route.abort('blockedbyclient');
  };
  // Yönlendirmenin (302/307/308) sonraki ayağı Chromium'da route'a uğramıyor: KESİLEMEZ, istek
  // karşı sunucuya ulaşmıştır. `request` olayı ikinci ayağı görür; kimlikli evrede burada tespit
  // edilir (engel değil): pencerede belge ayağı girişi reddettirir, diğer ayaklar uyarıda ayrı sayılır.
  // Veri yönlendirmesinin eski parola tespiti de aynı dinleyicide kalır.
  const izle = (istek: Request): void => {
    const url = istek.url();
    if (httpAdres(url) === null || !yabanciMi(url)) return;
    const origin = kokenAdi(url);
    if (evre === 'once' && istek.isNavigationRequest()) {
      bekleyenYabanciBelgeler.set(istek, origin);
    }
    if (istek.redirectedFrom() !== null && evre === 'pencere' && istek.isNavigationRequest()) {
      tespitEdilenBelgeYondirmeleri.push(origin);
    } else if (istek.redirectedFrom() !== null && evre !== 'once') {
      const kova = yonlendirmeyleUlasan[evre];
      kova.sayi += 1;
      if (!kova.originler.includes(origin)) kova.originler.push(origin);
    }
    if (istek.redirectedFrom() !== null && parolaTasiyorMu(istek, izler)) sizanOriginler.add(origin);
  };
  const cercevesiOlmus = (istek: Request): boolean => {
    try {
      const cerceve = istek.frame();
      return cerceve.isDetached() || cerceve.page().isClosed();
    } catch {
      return false;
    }
  };
  const bekleyeniKapat = (istek: Request): void => {
    bekleyenYabanciBelgeler.delete(istek);
  };
  const cerceveCommitiniIzle = (cerceve: Frame): void => {
    if (evre !== 'pencere') return;
    const origin = cerceveAgOrigini(cerceve.url());
    if (origin !== null && yabanciMi(origin)) commitOlanYabanciBelgeler.push(origin);
  };
  const izlenenSayfalar = new WeakSet<Page>();
  const sayfayiIzle = (sayfa: Page): void => {
    if (izlenenSayfalar.has(sayfa)) return;
    izlenenSayfalar.add(sayfa);
    sayfa.on('framenavigated', cerceveCommitiniIzle);
    // Açılır pencerenin ilk belgesi `page` olayından önce commit olmuş olabilir; o commit için
    // `framenavigated` bu dinleyiciye hiç gelmez. Pencere evresindeyse mevcut URL'ler doğrudan
    // değerlendirilir (aynı origin iki kez kaydedilirse ret mesajında tekilleşir).
    if (evre === 'pencere') for (const cerceve of sayfa.frames()) cerceveCommitiniIzle(cerceve);
  };
  // Siteler-arası WebSocket. Adreste parola varsa hiç bağlanmaz ve sızıntı sayılır. Kimlikli
  // evrede (pencere + giriş sonrası) açılan sunucuya hiç bağlanmaz (connectToServer çağrılmaz,
  // sayfa `open` görmeden 1008 ile kapanır). Pencere öncesinde açılan bağlanır; sayfanın
  // gönderdiği her mesaj denetlenir: parola görünüyorsa iletilmez (sızıntı), kimlikli evrede
  // hiçbir mesaj iletilmez. Sayfa bağlantıyı kimlikli evrede kapatırsa sunucu tarafı kod ve
  // neden taşımadan kapatılır (kapanış nedeni de veri taşıyabilir).
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
    if (evre !== 'once') {
      if (evre === 'pencere') kesilenYazmalar.add(`WebSocket ${origin}`);
      kimlikliKesim(origin);
      kapat();
      return;
    }
    const sunucu = ws.connectToServer();
    let mesajKesildi = false;
    ws.onMessage((mesaj) => {
      const metin = typeof mesaj === 'string' ? mesaj : mesaj.toString('utf8');
      if (metinParolaTasiyorMu(metin, izler)) {
        sizanOriginler.add(origin);
        return;
      }
      if (evre !== 'once') {
        if (evre === 'pencere') kesilenYazmalar.add(`WebSocket ${origin}`);
        // Açık bağlantının her mesajı ayrı istek sayılmaz: bağlantı başına bir kesim.
        if (!mesajKesildi) kimlikliKesim(origin);
        mesajKesildi = true;
        return;
      }
      sunucu.send(mesaj);
    });
    ws.onClose((kod, neden) => {
      if (evre === 'once') {
        void sunucu.close({
          ...(kod === undefined ? {} : { code: kod }),
          ...(neden === undefined ? {} : { reason: neden }),
        }).catch(() => undefined);
      } else {
        void sunucu.close().catch(() => undefined);
      }
    });
  };

  await context.route('**', yakala);
  await context.routeWebSocket((url) => yabanciMi(url.href), wsYakala);
  context.on('request', izle);
  context.on('requestfinished', bekleyeniKapat);
  context.on('requestfailed', bekleyeniKapat);
  for (const sayfa of context.pages()) sayfayiIzle(sayfa);
  context.on('page', sayfayiIzle);

  const kesimNotu = (): string => {
    if (kesilenOkumalar.length === 0) return '';
    const originler = [...new Set(kesilenOkumalar)];
    return ` During login kobay blocked ${kesilenOkumalar.length} third-party request`
      + `${kesilenOkumalar.length === 1 ? '' : 's'} (${orneklerMetni(originler)}); ${guvenIpucu(originler, false)}.`;
  };

  // Asıl denetim; dışarıya `koruma` üzerinden, hata ve uyarıları maskelenmiş olarak açılır.
  const ic = {
    pencereyiAc() {
      evre = 'pencere';
      for (const [istek, origin] of bekleyenYabanciBelgeler) {
        // Bitiş olayını kaçırmış (çerçevesi kopmuş ya da sayfası kapanmış) eski kayıt parolayı
        // alamaz; yanlış ret vermesin. Çerçevesi henüz yoksa (popup'ın ilk isteği) kayıt geçerli kalır.
        if (cercevesiOlmus(istek)) {
          bekleyenYabanciBelgeler.delete(istek);
          continue;
        }
        throw yabanciBelgeHatasi(origin, 'yukleniyor');
      }
    },
    denetle(girisBasarili: boolean): readonly string[] {
      evre = 'sonra';
      if (sizanOriginler.size > 0) throw sizintiHatasi(sizanOriginler, baseOrigin, authListesi, false);
      const yonlendirmeOriginleri = new Set(tespitEdilenBelgeYondirmeleri);
      const tehlikeliCommitler = commitOlanYabanciBelgeler.filter((origin) => !yonlendirmeOriginleri.has(origin));
      if (tehlikeliCommitler.length > 0) {
        const originler = [...new Set(tehlikeliCommitler)];
        throw new CredentialLeakBlockedError(
          `Login refused: a document from ${originler.join(', ')} committed in the browser `
            + `during the login window; the login was stopped. ${authOriginIpucu(originler)}`,
        );
      }
      girisTamamlandi = girisBasarili;
      const not = girisBasarili ? '' : kesimNotu();
      if (!girisBasarili && kesilenBelgeler.length > 0) {
        throw new LoginBlockedRequestsError(
          `Login did not complete: ${belgeYuklemeOzeti('blocked', kesilenBelgeler)}; credentials are only sent to `
            + `${izinliMetni(baseOrigin, authListesi)}.${ipucuMetni(authListesi)}${not}`,
        );
      }
      if (!girisBasarili && kesilenYazmalar.size > 0) {
        throw new LoginBlockedRequestsError(
          `Login did not complete: during login the page tried to write to a different site `
            + `(${[...kesilenYazmalar].join(', ')}) and kobay blocked it; credentials are only sent to `
            + `${izinliMetni(baseOrigin, authListesi)}. `
            + 'Locally, ports may differ but the host name must match (localhost and 127.0.0.1 are different sites).'
            + ipucuMetni(authListesi) + not,
        );
      }
      if (girisBasarili && kesilenBelgeler.length > 0) {
        process.stderr.write(gizle(`[kobay] Warning: ${belgeYuklemeOzeti('blocked', kesilenBelgeler)}.\n`));
      }
      return [...tespitEdilenBelgeYondirmeleri];
    },
    sonDenetim() {
      // denetle sızıntıda zaten fırlattığı için buraya gelen her kayıt giriş penceresi dışındadır.
      if (sizanOriginler.size > 0) throw sizintiHatasi(sizanOriginler, baseOrigin, authListesi, true);
      const { pencere, sonra } = yonlendirmeyleUlasan;
      if ((kimlikliKesimSayisi > 0 || pencere.sayi > 0 || sonra.sayi > 0) && !kimlikliUyariYazildi) {
        kimlikliUyariYazildi = true;
        // Giriş tamamlanmadıysa her şey hâlâ "giriş sırasında"dır.
        const ne = girisTamamlandi ? 'after login' : 'during login';
        const parcalar: string[] = [];
        if (kimlikliKesimSayisi > 0) {
          parcalar.push(`blocked ${kimlikliKesimSayisi} third-party request${kimlikliKesimSayisi === 1 ? '' : 's'} `
            + `${ne} to protect the password: ${orneklerMetni(kimlikliKesimOriginleri)}`);
        }
        const yonlendirmeMetni = (sayi: number, originler: readonly string[], ne2: string): string => `${sayi} `
          + `request${sayi === 1 ? '' : 's'} reached ${orneklerMetni(originler)} via redirect ${ne2}`;
        if (!girisTamamlandi && pencere.sayi + sonra.sayi > 0) {
          parcalar.push(yonlendirmeMetni(pencere.sayi + sonra.sayi, [...pencere.originler, ...sonra.originler], ne));
        } else {
          if (pencere.sayi > 0) parcalar.push(yonlendirmeMetni(pencere.sayi, pencere.originler, 'during login'));
          if (sonra.sayi > 0) parcalar.push(yonlendirmeMetni(sonra.sayi, sonra.originler, 'after login'));
        }
        if (pencere.sayi > 0 || sonra.sayi > 0) {
          parcalar[parcalar.length - 1] += ' (Chromium does not let kobay block a redirected request)';
        }
        const tumu = [...new Set([...kimlikliKesimOriginleri, ...pencere.originler, ...sonra.originler])];
        process.stderr.write(gizle(`[kobay] Warning: ${parcalar.join('; ')}. ${guvenIpucu(tumu)}.\n`));
      }
    },
  };
  const koruma: GirisKorumasi = {
    pencereyiAc() {
      try {
        ic.pencereyiAc();
      } catch (hata: unknown) {
        throw hatayiGizle(hata);
      }
    },
    denetle(girisBasarili) {
      try {
        return ic.denetle(girisBasarili);
      } catch (hata: unknown) {
        throw hatayiGizle(hata);
      }
    },
    sonDenetim() {
      try {
        ic.sonDenetim();
      } catch (hata: unknown) {
        throw hatayiGizle(hata);
      }
    },
    kesimNotu: () => gizle(kesimNotu()),
    metniGizle: (metin, secenek) => maske.gizle(metin, secenek),
    gizlilereEkle: (degerler) => { maske.depoEkle(degerler); },
    envanterEksik: () => { maske.eksikIsaretle(); },
    envanterEksikMi: () => maske.eksikMi(),
  };
  korumalar.set(context, koruma);
  return koruma;
}

/** Bağlamda kurulu giriş korumasını döndürür (yoksa undefined); çıktı maskesine erişim için. */
export function girisKorumasiBul(context: BrowserContext): GirisKorumasi | undefined {
  return korumalar.get(context);
}

/** Bağlamda giriş koruması kurulduysa son denetimi yapar; kurulmadıysa (giriş yoksa) bir şey yapmaz. */
export function girisKorumasiSonDenetim(context: BrowserContext): void {
  korumalar.get(context)?.sonDenetim();
}
