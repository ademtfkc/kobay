import { lstat, rm } from 'node:fs/promises';
import type { BrowserContext, Locator, Page, Request, Response } from '@playwright/test';
import { authOriginNormallestir, yazAtomik, type Kimlik } from '../depo/index.js';
import type { GirisFormu } from './giris.js';
import {
  authOriginIpucu,
  CredentialLeakBlockedError,
  girisKorumasiKur,
  izinliKumedeMi,
  GIRIS_SAYFA_ICI_MS,
  girisKorumasiBul,
  izinliMetni,
  kimlikIzleri,
  LoginBlockedRequestsError,
  metniGizle,
  sinirli,
  type GirisKorumasi,
  yabanciBelgeHatasi,
  yabanciCerceveler,
  zamanAsimiMi,
} from './giris-korumasi.js';

/**
 * Ayrı giriş sitesi (SSO) için kullanıcıya gösterilen yol; "desteklenmiyor" cümlesinin yerini aldı.
 * Liste yalnız kullanıcının CLI'dan, kimliği yeniden girerken verdiği origin'lerle genişler.
 */
export const SSO_IPUCU = 'If login runs on a separate auth site (SSO), allow its exact origin with'
  + ' `kobay project update --login --auth-origin <origin>`.';

/**
 * Giriş başarılı sayıldıktan sonra `baseUrl` origin'ine dönüş için beklenen en uzun süre.
 * Auth origin listesi boş olsa da geçerli: giriş her zaman uygulamanın origin'inde bitmeli.
 */
export const GIRIS_DONUS_BEKLEME_MS = 10_000;

/**
 * Gönder düğmesine tıklamanın (Playwright'ın tıklanabilirlik beklemesi dahil) en uzun süresi.
 * Düğme kilitliyse (disabled, aria-disabled, üstü kapalı; ör. captcha çözülmeden açılmayan
 * giriş) Playwright'ın 30 sn'lik varsayılanı yerine bu süre sonunda anlaşılır hata verilir.
 */
export const GIRIS_TIKLAMA_BEKLEME_MS = 15_000;

/**
 * Ret yolunda (URL değişmedi) ana çerçevenin `load` olayı için beklenen en uzun süre; giriş
 * penceresi açıkken, ağ durulmasından sonra. Aynı adrese dönen ret yanıtının gövdesi geç
 * tamamlanırsa (yavaş sunucu, yavaş makine) uyarı okuması belge yüklenmeden yapılır ve boş ya
 * da eksik gelir; okuma `GIRIS_SAYFA_ICI_MS` içinde biter ama gerekçe kaybolur (ölçüm: 6 sn
 * geç biten gövdede bekleme yokken giriş ~4,2 sn'de mesajsız döndü). Uyarıyı dolduran satır
 * içi script'ler `load`'dan önce çalışır. Belge zaten yüklüyse (JavaScript ile ret, donan ama
 * yüklenmiş sayfa) hemen döner; hiç bitmeyen yanıtta ret yoluna en çok bu kadar ekler.
 */
export const GIRIS_RET_YUKLEME_MS = 5_000;

/**
 * Kullanıcı adı ve parola alanını doldurmanın en uzun süresi: Playwright'ın varsayılanıyla aynı
 * 30 sn, açıkça yazılı. Alanları geç açılan sağlıklı giriş sayfaları bunu kullanır; donmuş
 * sayfada doldurma bu süre sonunda ham Playwright hatasıyla biter (bilinen sınır, backlog A3 (h)).
 */
export const GIRIS_DOLDURMA_MS = 30_000;

/** Parolanın yazılabileceği ve gönderilebileceği origin kümesi: önce `baseUrl` origin'i, sonra auth origin'ler. */
export function izinliOriginler(hedefOrigin: string, authOrigins: readonly string[] = []): string[] {
  return [hedefOrigin, ...authOrigins.filter((origin) => origin !== hedefOrigin)];
}

/**
 * Kimlik bilgilerinin yalnız hedef uygulamanın kendi origin'ine ya da kullanıcının açıkça
 * onayladığı auth origin'lerden birine gönderilmesini sağlar.
 */
export function loginUrlDogrula(baseUrl: string, loginUrl: string | undefined, authOrigins: readonly string[] = []): void {
  if (loginUrl === undefined) return;
  let baseOrigin: string;
  let loginOrigin: string;
  try {
    baseOrigin = new URL(baseUrl).origin;
    loginOrigin = new URL(loginUrl).origin;
  } catch {
    throw new Error('baseUrl and loginUrl must be valid URLs');
  }
  if (baseOrigin === loginOrigin || authOrigins.includes(loginOrigin)) return;
  if (authOrigins.length === 0) {
    throw new Error(`loginUrl must be on the same origin as baseUrl. ${SSO_IPUCU}`);
  }
  throw new Error(
    `loginUrl must be on the same origin as baseUrl or on one of the auth origins (allowed: ${
      izinliOriginler(baseOrigin, authOrigins).join(', ')})`,
  );
}

/**
 * Giriş sayfası hedefin origin'inde değilse ya da formun gönderim hedefi hedefin sitesinde
 * değilse fırlatılır; kimlik bilgisi alanlara hiç yazılmamıştır.
 */
export class LoginFormOriginError extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'LoginFormOriginError';
  }
}

/**
 * Giriş tamamlandı görünüyor ama tarayıcı `baseUrl` origin'ine dönmedi (auth sitesinde kaldı,
 * üçüncü bir origin'e indi ya da döndükten sonra gecikmeli yönlendirmeyle ayrıldı). Auth origin
 * listesi boşken de geçerli. Parola sızıntısı değil, akış tamamlanmadı; oturum yazılmaz, keşif başlamaz.
 */
export class LoginDidNotReturnError extends LoginFormOriginError {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'LoginDidNotReturnError';
  }
}

/**
 * Gönder düğmesine tıklama `GIRIS_TIKLAMA_BEKLEME_MS` içinde tamamlanmadı (düğme kilitli ya da
 * başka bir sebep). Mesaj düğmenin durumunu ve giriş penceresinde kesilen istekleri anlatır;
 * oturum yazılmaz, keşif başlamaz. Giriş hatası sınıfındadır (CLI'da çıkış kodu 5).
 */
export class LoginSubmitTimeoutError extends LoginFormOriginError {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'LoginSubmitTimeoutError';
  }
}

/** Kayıtlı kimlik ile hedef origin uyuşmadığında fırlatılır; parola hiç yazılmamıştır. */
export class CredentialOriginError extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'CredentialOriginError';
  }
}

/** Normal biçime çevrilmiş, sıralı küme; geçersiz öğe varsa null (karşılaştırma uyuşmaz sayılır). */
function normalKume(liste: readonly string[] | undefined): string[] | null {
  try {
    return [...new Set((liste ?? []).map((origin) => authOriginNormallestir(origin)))].sort();
  } catch {
    return null;
  }
}

/**
 * Kayıtlı kimliğin, verildiği origin'den (ve onaylanan auth origin kümesinden) başka bir
 * hedefe yazılmasını engeller. Origin'i bilinmeyen (eski biçim) kimlik de reddedilir:
 * nereye ait olduğu kanıtlanamayan parola hiçbir forma yazılmaz. Kimlikte auth origin
 * listesi yoksa boş küme sayılır; config'teki listeyle birebir aynı olmalıdır.
 */
export function kimlikOriginDogrula(kimlik: Kimlik, hedefOrigin: string, authOrigins: readonly string[] = []): void {
  if (kimlik.origin === undefined) {
    throw new CredentialOriginError(
      'It is unknown which address the saved credentials were given for (legacy format); the password was not sent.',
    );
  }
  if (kimlik.origin !== hedefOrigin) {
    throw new CredentialOriginError(
      `The saved credentials were given for ${kimlik.origin}, the target is ${hedefOrigin}; the password was not sent.`,
    );
  }
  const kayitli = normalKume(kimlik.authOrigins);
  const istenen = normalKume(authOrigins);
  if (kayitli === null || istenen === null || kayitli.join('\n') !== istenen.join('\n')) {
    const yaz = (liste: readonly string[] | undefined): string => (
      liste === undefined || liste.length === 0 ? 'none' : liste.join(', ')
    );
    throw new CredentialOriginError(
      'The saved credentials belong to a different set of auth origins'
        + ` (saved with: ${yaz(kimlik.authOrigins)}; config: ${yaz(authOrigins)}); the password was not sent.`,
    );
  }
}

/**
 * Giriş reddedildiğinde (URL değişmedi) sayfanın gösterdiği uyarı. `alinti`: maskelenmiş,
 * çitlenmiş, kırpılmış sayfa metni. `gizlendi`: metin vardı ama envanter eksik ya da maske hata
 * verdi, metnin kendisi hiç taşınmaz (fail-closed). Diske yazılmaz; yalnız mesaja girer.
 */
export type GirisSayfaMesaji = { tur: 'alinti'; metin: string } | { tur: 'gizlendi' };

/**
 * Gönderimden sonra uygulama hız sınırıyla (HTTP 429) yanıt verdi (0.8.0 P2-3). Yalnız HTTP
 * durumundan gelir, sayfa metninden asla: ret sayfasının "Too Many Requests" yazması bunu
 * üretmez. `retryAfterSn`: yanıtın `Retry-After` başlığı (saniye; okunamazsa yok).
 */
export interface GirisHizSiniri {
  retryAfterSn?: number;
}

/**
 * `girisiGonder` sonucu: giriş tamamlandı mı, tamamlanmadıysa sayfanın gösterdiği uyarı (varsa).
 * `hizSiniri`: gönderimden sonra izinli kümeye giden GET/HEAD/OPTIONS dışı bir istek (giriş
 * isteği) 429 aldı. Çağıran yalnız başarısız girişte kullanır: kimlik reddi sayılmaz.
 */
export interface GirisSonucu {
  basarili: boolean;
  sayfaMesaji?: GirisSayfaMesaji;
  hizSiniri?: GirisHizSiniri;
}

/** `Retry-After` başlığının kabul edilen en büyük değeri (sn); üstü ya da okunamayanı yok sayılır. */
export const RETRY_AFTER_TAVANI_SN = 86_400;

/** `Retry-After`: saniye ya da HTTP tarihi. Uygulamanın başlığıdır; yalnız sayıya çevrilir. */
export function retryAfterCoz(deger: string | undefined, simdiMs = Date.now()): number | undefined {
  if (deger === undefined) return undefined;
  const metin = deger.trim();
  let sn: number;
  if (/^\d{1,6}$/.test(metin)) sn = Number(metin);
  else {
    const zaman = Date.parse(metin);
    if (!Number.isFinite(zaman) || !/[a-z]/i.test(metin)) return undefined;
    sn = Math.max(0, Math.ceil((zaman - simdiMs) / 1000));
  }
  return sn <= RETRY_AFTER_TAVANI_SN ? sn : undefined;
}

/**
 * Hız sınırı mesajının öneri cümlesi; `komut` yeniden çalıştırılacak komut (backtick'li).
 * `Retry-After: 0` ya da geçmiş tarih: uygulama hemen yeniden denemeye izin veriyor.
 */
export function hizSiniriOnerisi(hiz: GirisHizSiniri, komut: string): string {
  if (hiz.retryAfterSn === 0) return `The app's Retry-After allows a retry now: run ${komut}.`;
  return `Wait ${hizBeklemesi(hiz)}, then run ${komut}.`;
}

function hizBeklemesi(hiz: GirisHizSiniri): string {
  return hiz.retryAfterSn === undefined ? 'about a minute' : `about ${hiz.retryAfterSn} s (the app's Retry-After)`;
}

/**
 * Giriş 429'dan sonra başka bir hatayla bittiğinde (ör. SSO origin'inde kaldı) hatanın sonuna
 * eklenen not (başında boşluk). Hatanın sınıfı ve önceliği değişmez; sızıntı hatalarına eklenmez.
 */
export function hizSiniriNotu(hiz: GirisHizSiniri): string {
  const sonra = hiz.retryAfterSn === 0 ? 'the app allows a retry now' : `wait ${hizBeklemesi(hiz)} before trying again`;
  return ` The app also answered the login request with HTTP 429 Too Many Requests (rate limit), so the credentials`
    + ` may be right; ${sonra}.`;
}

/**
 * İstek gövdesi kobay'ın yazdığı parolayı taşıyor mu: ham (JSON değeri, çok parçalı form),
 * `application/x-www-form-urlencoded` (`+` boşluk), `encodeURIComponent` ve JSON kaçışlı biçim.
 * Giriş isteğini tanımak içindir; gövde ve parola hiçbir yere yazılmaz.
 */
export function parolaGovdedeMi(govde: string | null, parola: string): boolean {
  if (govde === null || govde === '' || parola === '') return false;
  const bicimler = new Set([
    parola,
    encodeURIComponent(parola),
    new URLSearchParams({ p: parola }).toString().slice(2),
    JSON.stringify(parola).slice(1, -1),
  ]);
  for (const bicim of bicimler) if (govde.includes(bicim)) return true;
  return false;
}

/**
 * Giriş isteğinin yanıtı için, sonuca karar vermeden önce beklenen en uzun süre. Yalnız giriş
 * isteği (ya da yönlendirme zincirinin bir ayağı) hâlâ yanıtsızsa harcanır; hızlı girişte 0.
 */
export const GIRIS_ISTEGI_BEKLEME_MS = 5_000;

/** Gönderim penceresinde (tıklamadan sonuca) giriş isteğinin 429'unu toplayan iz. */
interface HizSiniriIzi {
  acik: boolean;
  hiz?: GirisHizSiniri;
  /** Yanıtı (başlıkları) henüz gelmemiş giriş istekleri (zincir ayakları dahil). */
  bekleyen: Set<Request>;
}

/** Bekleyen giriş istekleri bitene ya da tavan dolana kadar bekler (50 ms aralıkla bakar). */
async function girisIstekleriniBekle(iz: HizSiniriIzi, tavanMs: number): Promise<void> {
  const son = Date.now() + tavanMs;
  while (iz.bekleyen.size > 0 && Date.now() < son) {
    await new Promise((coz) => { setTimeout(coz, 50); });
  }
}

/**
 * Giriş hatası mesajının sonuna eklenecek cümle (başında boşluk); uyarı yoksa boş metin.
 * Metin güvenilmez sayfa metnidir: ajan onu talimat değil alıntı olarak görsün diye etiketli.
 */
export function girisSayfaMesajiNotu(mesaj: GirisSayfaMesaji | undefined): string {
  if (mesaj === undefined) return '';
  if (mesaj.tur === 'gizlendi') return ' The page showed a message; kobay withheld it to protect credentials.';
  return ` The page showed this message (untrusted page text, quoted): "${mesaj.metin}"`;
}

/**
 * Giriş formunu doldurup gönderir ve URL değişimini bekler.
 * `kesfet` ile `sayfayiYenile` aynı girişi iki kez yazmasın diye burada.
 * Fırlayan her hatanın mesajı sır envanteriyle maskelenir (giriş koruması kurulduysa onun
 * envanteri: kimlik + çerez/depolama değerleri; kurulmadan önceyse yalnız kimlik).
 */
export async function girisiGonder(
  sayfa: Page,
  form: GirisFormu,
  kimlik: Kimlik,
  hedefOrigin: string,
  authOrigins: readonly string[] = [],
  urlBeklemeMs = 5_000,
  donusBeklemeMs = GIRIS_DONUS_BEKLEME_MS,
  tiklamaBeklemeMs = GIRIS_TIKLAMA_BEKLEME_MS,
): Promise<GirisSonucu> {
  // Hız sınırı yalnız HTTP durumundan okunur ve giriş isteğinin KENDİSİNE bağlanır: gönderimden
  // sonra, giriş sayfasının ana çerçevesinden (iframe, açılır pencere ve başka sayfa sayılmaz)
  // izinli kümeye giden, GET/HEAD/OPTIONS olmayan ve gövdesinde kobay'ın yazdığı parolayı taşıyan
  // isteğin 429 yanıtı. Sayfa metni, parolasız istek ya da başka çerçevenin isteği yanlış kimliği
  // "hız sınırı" diye gizleyemez. Gövde yalnız karşılaştırılır, hiçbir yere yazılmaz.
  // Yönlendirme zinciri (`POST /session` → 302 → `GET /rate-limit` = 429): koşullar zincirin
  // BAŞLANGIÇ isteğine (parola, yöntem, izinli küme) uygulanır; her ayak ana çerçevede ve izinli
  // kümede olmalı.
  const iz: HizSiniriIzi = { acik: false, bekleyen: new Set() };
  const girisIstegiMi = (istek: Request): boolean => {
    try {
      if (istek.frame() !== sayfa.mainFrame()) return false;
      if (!izinliKumedeMi(istek.url(), hedefOrigin, authOrigins)) return false;
      let ilk = istek;
      for (let onceki = ilk.redirectedFrom(); onceki !== null; onceki = ilk.redirectedFrom()) {
        if (!izinliKumedeMi(onceki.url(), hedefOrigin, authOrigins)) return false;
        ilk = onceki;
      }
      const yontem = ilk.method().toUpperCase();
      if (yontem === 'GET' || yontem === 'HEAD' || yontem === 'OPTIONS') return false;
      return parolaGovdedeMi(ilk.postData(), kimlik.password);
    } catch {
      // Çerçevesi ya da gövdesi okunamayan istek giriş isteği sayılmaz.
      return false;
    }
  };
  const istekBasladi = (istek: Request): void => {
    if (iz.acik && girisIstegiMi(istek)) iz.bekleyen.add(istek);
  };
  const istekBitti = (istek: Request): void => { iz.bekleyen.delete(istek); };
  const dinle = (yanit: Response): void => {
    // Yanıt başlıkları geldi: durum belli, gövdenin bitmesi beklenmez (bitmeyen ret gövdesi).
    iz.bekleyen.delete(yanit.request());
    if (!iz.acik || yanit.status() !== 429 || !girisIstegiMi(yanit.request())) return;
    const sn = retryAfterCoz(yanit.headers()['retry-after']);
    if (iz.hiz === undefined || (sn !== undefined && (iz.hiz.retryAfterSn ?? -1) < sn)) {
      iz.hiz = sn === undefined ? {} : { retryAfterSn: sn };
    }
  };
  sayfa.on('request', istekBasladi);
  sayfa.on('requestfinished', istekBitti);
  sayfa.on('requestfailed', istekBitti);
  sayfa.on('response', dinle);
  try {
    const sonuc = await girisiGonderIc(sayfa, form, kimlik, hedefOrigin, authOrigins, urlBeklemeMs, donusBeklemeMs, tiklamaBeklemeMs, iz);
    // İç karardan sonra gelen 429 da girişi başarısız yapar (her iki çağıran için).
    return iz.hiz === undefined ? sonuc : { ...sonuc, basarili: false, hizSiniri: iz.hiz };
  } catch (hata: unknown) {
    if (hata instanceof Error) {
      // 429'dan sonra gelen hata (ör. dönüş yok) kendi sınıfıyla kalır; 429 bilgisi nota girer.
      // Sızıntı/kesim hataları (CredentialLeakBlockedError ailesi) not almaz: öncelikleri ve
      // anlamları "belki yalnız hız sınırı" diye yumuşamasın.
      if (iz.hiz !== undefined && !(hata instanceof CredentialLeakBlockedError)) hata.message += hizSiniriNotu(iz.hiz);
      const koruma = girisKorumasiBul(sayfa.context());
      hata.message = koruma === undefined ? metniGizle(hata.message, kimlikIzleri(kimlik)) : koruma.metniGizle(hata.message);
    }
    throw hata;
  } finally {
    sayfa.off('request', istekBasladi);
    sayfa.off('requestfinished', istekBitti);
    sayfa.off('requestfailed', istekBitti);
    sayfa.off('response', dinle);
  }
}

async function girisiGonderIc(
  sayfa: Page,
  form: GirisFormu,
  kimlik: Kimlik,
  hedefOrigin: string,
  authOrigins: readonly string[],
  urlBeklemeMs: number,
  donusBeklemeMs: number,
  tiklamaBeklemeMs: number,
  hizIzi: HizSiniriIzi,
): Promise<GirisSonucu> {
  kimlikOriginDogrula(kimlik, hedefOrigin, authOrigins);
  const izinli = izinliOriginler(hedefOrigin, authOrigins);
  const ssoIpucu = authOrigins.length === 0 ? ` ${SSO_IPUCU}` : '';
  // loginUrl doğru olsa bile uygulama başka adrese yönlendirmiş olabilir. Parolanın YAZILDIĞI
  // sayfa tam origin ister (sayfanın betiği parolayı okur; kimlik de bu origin'lere verilmiştir).
  // Parolanın GİTTİĞİ yer ise ağ korumasıyla aynı kural (`izinliKumedeMi`): form hedefi
  // `baseUrl` origin'inin sitesinde (app.example.com → api.example.com) ya da TAM olarak bir
  // auth origin'de olabilir; auth origin'in alt alanı ya da başka portu olamaz.
  const sayfaOrigin = new URL(sayfa.url()).origin;
  if (!izinli.includes(sayfaOrigin)) {
    throw new LoginFormOriginError(
      `The login page is on a different origin (${sayfaOrigin}); credentials are only typed on ${izinli.join(', ')}.${ssoIpucu}`,
    );
  }
  // Form hedefi seçilen düğmeden okunur: `formaction` yalnız gönderen (submit) düğmede formun
  // hedefini ezer. Tip `button` olan düğme ve Enter (yalnız gönderen düğmesi olmayan formda) formun
  // kendi hedefine gider; betiğin attığı istekleri ağ koruması denetler.
  const formHedefi = await sinirli((form.gonderDugmesi ?? form.parolaAlani).evaluate((oge) => {
    // Enter yolunda öğe parola alanının kendisidir (gönderen değil): formun hedefi okunur.
    const dugme = oge as HTMLButtonElement | HTMLInputElement;
    const hedefForm = dugme.form;
    const gonderen = dugme instanceof HTMLButtonElement
      ? dugme.type === 'submit'
      : dugme.type === 'submit' || dugme.type === 'image';
    // formAction, öznitelik yoksa sayfa adresini döner; yalnız öznitelik varsa formun hedefini ezer.
    if (gonderen && dugme.hasAttribute('formaction')) return dugme.formAction;
    return hedefForm?.action ?? document.location.href;
  }), tiklamaBeklemeMs);
  // Sınır tıklama bütçesiyle aynı: bu okuma akışı keser (parola yazılmaz), o an meşgul olan
  // sağlıklı sayfa düşmesin. Envanter ve düğme durumu okumaları 2 sn kalır, yalnız `[withheld]`e düşer.
  if (zamanAsimiMi(formHedefi)) {
    throw new LoginFormOriginError(
      `The login page did not respond within ${Math.round(tiklamaBeklemeMs / 1000)} s, so kobay could not check where the form`
        + ' submits; the password was not typed.',
    );
  }
  const hedefAdres = new URL(formHedefi, sayfa.url());
  if (!izinliKumedeMi(hedefAdres.href, hedefOrigin, authOrigins)) {
    throw new LoginFormOriginError(
      `The login form submits to a different site (${hedefAdres.origin}); `
        + `credentials are only sent to ${izinliMetni(hedefOrigin, authOrigins)}. `
        + 'Locally, ports may differ but the host name must match (localhost and 127.0.0.1 are different sites).'
        + ssoIpucu,
    );
  }
  // Gönderimden önceki form kapsayıcısı metni (ret sonrası yeni gelen satırlar uyarı sayılır).
  // Alanlar doldurulmadan alınır: yavaş okuma parolayı yazılmış halde bekletmesin.
  const oncekiSatirlar = await kapsayiciSatirlari(form.parolaAlani);
  // Form hedefi doğru olsa da sayfadaki JavaScript parolayı fetch/XHR/beacon/WebSocket ile başka
  // siteye gönderebilir; parola alana yazılmadan önce ağ koruması kurulur. Koruma burada
  // KALDIRILMAZ: bağlam kapanana kadar (giriş sonrası keşif boyunca) kalır. Keşfin sonunda
  // `girisKorumasiSonDenetim` çağrılmalı. WebSocket kesimi yalnız koruma kurulduktan sonra açılan
  // belgelere işlediği için çağıran (kesfet, sayfayiYenile) korumayı ilk sayfadan önce kurar;
  // burada kurulu olanı alırız.
  const koruma = await girisKorumasiKur(sayfa.context(), kimlik, izinli);
  // `pencereyiAc` kimlikli evreyi başlatır (bağlam kapanana kadar sürer): siteler-arası yazma,
  // belge, WebSocket ve GET dahil izinli küme dışına hiçbir istek gitmez.
  // `denetle` giriş penceresini kapatır; pencereye özgü ret kuralları orada biter.
  // Belge denetimi: ana çerçeve hâlâ denetlenen izinli origin'de mi, yabancı çerçeve/pencere var mı.
  // Yazmadan hemen önce yeniden yapılır: ilk denetimle `pencereyiAc` arasındaki `await`'lerde commit
  // olan yabancı belge (pencere açıkken commit olan ise `framenavigated` kuralına düşer) kaçmasın.
  const belgeyiDenetle = (): void => {
    const simdikiOrigin = new URL(sayfa.url()).origin;
    if (simdikiOrigin !== sayfaOrigin) {
      throw new LoginFormOriginError(
        `The login page moved to ${simdikiOrigin} before the credentials were typed; the password was not typed.${ssoIpucu}`,
      );
    }
    const yabanciCerceveOriginleri = yabanciCerceveler(
      sayfa.context().pages().flatMap((baglamSayfasi) => baglamSayfasi.frames().map((cerceve) => cerceve.url())),
      hedefOrigin,
      authOrigins,
    );
    if (yabanciCerceveOriginleri.length > 0) {
      const origin = yabanciCerceveOriginleri[0] as string;
      throw yabanciBelgeHatasi(origin);
    }
  };
  belgeyiDenetle();
  // Çıktı maskesi: parola yazılmadan önceki çerez ve depolama değerleri (sayfa sonra silebilir).
  await envantereEkle(sayfa, koruma);
  koruma.pencereyiAc();
  belgeyiDenetle();
  await form.kullaniciAlani.fill(kimlik.username, { timeout: GIRIS_DOLDURMA_MS });
  belgeyiDenetle();
  await form.parolaAlani.fill(kimlik.password, { timeout: GIRIS_DOLDURMA_MS });
  await envantereEkle(sayfa, koruma);
  const oncekiUrl = sayfa.url();
  // Bekleyici tıklamadan önce başlar (hızlı yönlendirme kaçmasın) ama URL bütçesi tıklama
  // bittiğinde başlar: kilitli düğme geç açılıp gönderim başarılı olursa giriş yanlışlıkla
  // başarısız sayılmasın. Bekleyicinin kendi tavanı iki bütçenin toplamıdır.
  const urlDegisimi = sayfa.waitForURL((url) => url.href !== oncekiUrl, { timeout: tiklamaBeklemeMs + urlBeklemeMs })
    .then(() => true)
    .catch(() => false);
  // Hız sınırı izi gönderimle başlar: gönderimden önceki istekler giriş isteği değildir.
  hizIzi.acik = true;
  try {
    // Gönder düğmesi yoksa (bkz. `girisFormuBul`) form parola alanında Enter ile gönderilir.
    if (form.gonderDugmesi === null) await form.parolaAlani.press('Enter', { timeout: tiklamaBeklemeMs });
    else await form.gonderDugmesi.click({ timeout: tiklamaBeklemeMs });
  } catch (hata: unknown) {
    if (!(hata instanceof Error) || hata.name !== 'TimeoutError') throw hata;
    throw await tiklamaZamanAsimiHatasi(sayfa, form.gonderDugmesi ?? form.parolaAlani, koruma, hata, tiklamaBeklemeMs);
  }
  let zamanlayici: ReturnType<typeof setTimeout> | undefined;
  const urlSuresi = new Promise<boolean>((coz) => { zamanlayici = setTimeout(() => { coz(false); }, urlBeklemeMs); });
  const urlDegisti = await Promise.race([urlDegisimi, urlSuresi]) || sayfa.url() !== oncekiUrl;
  clearTimeout(zamanlayici);
  // Yeni sayfanın açılışta attığı istekler de denetlensin diye ağın durulması beklenir;
  // ağ hiç durulmayan uygulamada en fazla iki saniye. Sonraki istekleri koruma yine keser.
  await sayfa.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
  // URL değişmediyse (ret) aynı adrese dönen ret belgesi yüklensin: ağ durulmasının 2 sn tavanı
  // `load`'dan önce dolabilir. Giriş penceresi açıkken beklenir ki belgenin geç yüklenen
  // kısmının yaptığı her şey (ör. yabancıya 302 olan gezinme) pencere kuralıyla denetlensin.
  if (!urlDegisti) await sayfa.waitForLoadState('load', { timeout: GIRIS_RET_YUKLEME_MS }).catch(() => undefined);
  // Giriş, uygulamanın origin'ine dönünce tamamlanmış sayılır (ayrı giriş sitesi olsun olmasın;
  // liste boşken yabancı origin'e inen giriş de tamamlanmamıştır). Dönüş beklenirken giriş
  // penceresi açık kalır (sıkı kural sürer).
  const uygulamadaMi = (): boolean => new URL(sayfa.url()).origin === hedefOrigin;
  let donulmeyenOrigin: string | null = null;
  if (urlDegisti && !uygulamadaMi()) {
    const dondu = await sayfa.waitForURL((url) => url.origin === hedefOrigin, { timeout: donusBeklemeMs })
      .then(() => true)
      .catch(() => false);
    if (dondu) {
      await sayfa.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
    } else {
      donulmeyenOrigin = new URL(sayfa.url()).origin;
    }
  }
  // Dönüşten sonraki ağ durulmasında gecikmeli meta-refresh ya da JavaScript yönlendirmesi
  // sayfayı uygulamadan çıkarmış olabilir. `denetle`den önce başarısız sayılır ki kesilen
  // yabancı ana-çerçeve origin'i chrome-error sayfasının `null` origin'inden önce bildirilsin.
  if (urlDegisti && donulmeyenOrigin === null && !uygulamadaMi()) donulmeyenOrigin = new URL(sayfa.url()).origin;
  // Erken URL değişimi (SPA `pushState`) giriş isteğinin yanıtını beklemez: karar vermeden önce
  // hâlâ yanıtsız giriş isteği varsa tavanlı beklenir (geç 429 kaçmasın).
  await girisIstekleriniBekle(hizIzi, GIRIS_ISTEGI_BEKLEME_MS);
  // Giriş isteğinin kendisi 429 aldıysa URL değişse de (form `action` 429 sayfasına gitti) giriş
  // başarılı sayılmaz: oturum yazılmaz, ret yolu (hız sınırı) çalışır.
  const girisBasarili = urlDegisti && donulmeyenOrigin === null && hizIzi.hiz === undefined;
  // Tarayıcıya bir gidiş-dönüş (en iyi çaba): tarayıcının bu yanıttan önce yaydığı istek/commit
  // olayları (pencere sonunda başlamış bir yönlendirme ayağı dahil) aynı sıralı bağlantıdan önce
  // gelir ve `denetle` evreyi kapatmadan işlenir. Playwright'ın kendi içinde ertelediği olaylar
  // için kesin sıra garantisi yoktur; bu bekleme yarışı daraltır, kanıtlanmış bir kapı değildir.
  await sayfa.context().cookies().catch(() => undefined);
  // Sızıntı varsa önce o bildirilir: dönüş hatası daha ağır bir nedeni örtmesin.
  await koruma.bekle();
  const kesilemeyenBelgeYondirmeleri = koruma.denetle(girisBasarili);
  if (donulmeyenOrigin !== null) {
    const belgeNotu = kesilemeyenBelgeYondirmeleri.length === 0
      ? ''
      : ` During login, kobay detected ${kesilemeyenBelgeYondirmeleri.length} cross-origin document redirect`
        + `${kesilemeyenBelgeYondirmeleri.length === 1 ? '' : 's'} that Chromium did not expose to the route guard: `
        + `${[...new Set(kesilemeyenBelgeYondirmeleri)].slice(0, 3).join(', ')}.`;
    throw new LoginDidNotReturnError(
      `Login did not return to the app origin (ended on ${donulmeyenOrigin}, expected ${hedefOrigin}`
        + ` within ${Math.round(donusBeklemeMs / 1000)} s); the session was not saved.`
        + belgeNotu
        + ' Check the credentials and that login redirects back to the app.'
        + koruma.kesimNotu(),
    );
  }
  if (kesilemeyenBelgeYondirmeleri.length > 0) throw yonlendirmeRetHatasi(kesilemeyenBelgeYondirmeleri);
  // URL değişmediyse giriş büyük olasılıkla sunucuda reddedildi; sayfanın gerekçesi okunur.
  const sayfaMesaji = urlDegisti ? undefined : await girisSayfaMesaji(sayfa, koruma, oncekiSatirlar);
  return sayfaMesaji === undefined ? { basarili: girisBasarili } : { basarili: girisBasarili, sayfaMesaji };
}

/** Sayfanın uyarı bölgeleri (spec A6 §2 a). */
const UYARI_SECICI = '[role~="alert"], [role~="status"], [aria-live="assertive"], [aria-live="polite"]';
/** Tek uyarı parçasının ve birleşik metnin en uzun hali (kırpma maskeden sonra). */
export const SAYFA_MESAJI_PARCA = 160;
export const SAYFA_MESAJI_TOPLAM = 200;
/**
 * Tarayıcıda toplanan uyarı bölgesi tavanı: eşleşen düğüm sayısı ve toplam metin uzunluğu.
 * Aşılırsa metin taşınmaz (`gizlendi`); iç içelik denetimi en çok bu kadar düğümle çalışır.
 */
export const UYARI_EN_COK_OGE = 50;
export const UYARI_EN_COK_KARAKTER = 4_096;
/** Form kapsayıcısının (fark yolu) en uzun metni; aşılırsa fark yolu kapanır (metin yok). */
const KAPSAYICI_EN_COK_KARAKTER = 32_768;

/**
 * Parola alanının formunu saran kapsayıcının (formun ebeveyni) görünür metin satırları.
 * Okunamazsa (sayfa donmuş, alan yok) ya da metin tavanı aşarsa null. Gönderimden önce ve
 * sonra okunur; aradaki fark düz `<p>` uyarısını yakalar.
 */
async function kapsayiciSatirlari(parolaAlani: Locator): Promise<string[] | null> {
  const satirlar = await sinirli(parolaAlani.evaluate((oge, enCok) => {
    const alan = oge as HTMLInputElement;
    const kap = alan.form?.parentElement ?? alan.parentElement;
    if (kap === null) return [];
    const metin = kap.innerText;
    if (metin.length > enCok) return null;
    return metin.split('\n').map((satir) => satir.trim()).filter(Boolean);
  }, KAPSAYICI_EN_COK_KARAKTER, { timeout: 1_000 }), GIRIS_SAYFA_ICI_MS).catch(() => null);
  return satirlar === null || zamanAsimiMi(satirlar) ? null : satirlar;
}

/** Sayfadan toplanan ham uyarı parçaları; `tasma`: tarayıcı tarafı tavanı aşıldı. */
interface HamParcalar {
  tasma: boolean;
  metinler: string[];
}

/**
 * Sayfadaki ret gerekçesinin ham parçaları: önce görünür uyarı bölgeleri (formu kapsayan
 * düzen sarmalayıcıları ve iç içe tekrarlar hariç; düğüm ve metin tavanlı), yoksa kapsayıcıda
 * gönderimden sonra beliren satırlar. Kırpma ve maske burada yapılmaz.
 */
async function sayfaMesajiParcalari(sayfa: Page, onceki: string[] | null): Promise<HamParcalar> {
  const uyarilar = await sayfa.evaluate(({ secici, enCokOge, enCokKarakter }) => {
    const tum = document.querySelectorAll<HTMLElement>(secici);
    if (tum.length > enCokOge) return { tasma: true, metinler: [] };
    const parola = document.querySelector('input[type="password"]');
    const adaylar = Array.from(tum).filter((oge) => parola === null || !oge.contains(parola));
    const metinler: string[] = [];
    let toplam = 0;
    for (const oge of adaylar) {
      if (adaylar.some((diger) => diger !== oge && diger.contains(oge))) continue;
      // Görünürlükten önce ucuz ön denetim: dev bir düğümün innerText'i hiç hesaplanmasın.
      if ((oge.textContent ?? '').length > enCokKarakter) return { tasma: true, metinler: [] };
      if (!oge.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const metin = oge.innerText.trim();
      if (metin === '') continue;
      toplam += metin.length;
      if (toplam > enCokKarakter) return { tasma: true, metinler: [] };
      metinler.push(metin);
    }
    return { tasma: false, metinler };
  }, { secici: UYARI_SECICI, enCokOge: UYARI_EN_COK_OGE, enCokKarakter: UYARI_EN_COK_KARAKTER });
  if (uyarilar.tasma || uyarilar.metinler.length > 0) return uyarilar;
  if (onceki === null) return { tasma: false, metinler: [] };
  const sonraki = await kapsayiciSatirlari(sayfa.locator('input[type="password"]').first());
  if (sonraki === null) return { tasma: false, metinler: [] };
  const eski = new Set(onceki);
  return { tasma: false, metinler: sonraki.filter((satir) => !eski.has(satir)) };
}

/**
 * Sayfa metninin çiti: ANSI kaçışları ve kontrol/biçim karakterleri silinir, satır sonları
 * boşluk olur, boşluklar sadeleşir. Maskenin ARASINDA uygulanır (ham → maske → çit → maske):
 * ham biçimdeki sır (yumuşak tireli, sekmeli) da, kaçışla bölünmüş sır da yakalanır.
 */
export function sayfaMetniCitle(ham: string): string {
  return ham
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/[\r\n\t\f\v\u2028\u2029]/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Okunan ham parçalardan kullanıcıya gidecek uyarı:
 * 1. Her parça: maske (ham) → çit → maske; en çok 2 dolu parça.
 * 2. Maskeli parçaların birleşik (" ", "") ve boşluksuz biçimlerinde hâlâ bir sır geçiyorsa
 *    (parçalara ya da satırlara bölünmüş sır) metin taşınmaz.
 * 3. Düz çift tırnak tipografik U+201D olur (alıntı sayfa metniyle kapatılamasın); sonra kırpma: parça
 *    `SAYFA_MESAJI_PARCA`, toplam `SAYFA_MESAJI_TOPLAM`.
 * Envanter eksikse, tavan aşıldıysa ya da maske bir parçayı `[withheld]` yaptıysa (kısa sır,
 * maske hatası) metin hiç taşınmaz. Parça yoksa undefined.
 */
export function sayfaMesajiniKur(
  koruma: GirisKorumasi,
  hamParcalar: readonly string[],
  tasma = false,
): GirisSayfaMesaji | undefined {
  if (tasma) return { tur: 'gizlendi' };
  const parcalar = hamParcalar.filter((parca) => sayfaMetniCitle(parca) !== '').slice(0, 2);
  if (parcalar.length === 0) return undefined;
  try {
    if (koruma.envanterEksikMi()) return { tur: 'gizlendi' };
    const gizle = (metin: string): string => koruma.metniGizle(metin, { alan: true });
    const maskeli = parcalar.map((parca) => gizle(sayfaMetniCitle(gizle(parca))));
    if (maskeli.some((parca) => parca === '' || parca.includes('[withheld]'))) return { tur: 'gizlendi' };
    const birlesik = maskeli.join(' ');
    const bicimler = [birlesik, maskeli.join(''), birlesik.replace(/\s+/g, '')];
    if (bicimler.some((bicim) => gizle(bicim) !== bicim)) return { tur: 'gizlendi' };
    const kirp = (metin: string, uzunluk: number): string => (
      metin.length > uzunluk ? `${metin.slice(0, uzunluk - 3)}...` : metin
    );
    const metin = kirp(
      maskeli.map((parca) => kirp(parca.replaceAll('"', '\u201d'), SAYFA_MESAJI_PARCA)).join(' | '),
      SAYFA_MESAJI_TOPLAM,
    );
    // Son denetim: birleştirme (" | "), tırnak dönüşümü ve kırpma maskeden sonra metni değiştirdi;
    // tırnak içine girecek dizenin kendisi, çitli ve boşluksuz biçimi de sır taşımamalı.
    const sonBicimler = [metin, sayfaMetniCitle(metin), metin.replace(/\s+/g, '')];
    if (sonBicimler.some((bicim) => gizle(bicim) !== bicim)) return { tur: 'gizlendi' };
    // Mesaja eklenecek tam çerçeveli not: çevreleyen tırnaklarla alıntı (kısa sır dahil) ve
    // etiketle birlikte notun tamamı (uzun sır) da sır kurmamalı (ör. parola `foo"`, metin `foo`).
    const alintiCercevesi = `"${metin}"`;
    const not = girisSayfaMesajiNotu({ tur: 'alinti', metin });
    if (gizle(alintiCercevesi) !== alintiCercevesi || koruma.metniGizle(not) !== not) return { tur: 'gizlendi' };
    return { tur: 'alinti', metin };
  } catch {
    return { tur: 'gizlendi' };
  }
}

/**
 * Ret sonrası sayfa uyarısı. Okuma `GIRIS_SAYFA_ICI_MS` ile sınırlı; zaman aşımı ya da sayfa
 * hatası → undefined (mesaj değişmez, giriş sonucu etkilenmez). Metin bulunursa maskeden önce
 * çerez/depolama envanteri tazelenir (ret yanıtının kurduğu değerler de maskelensin).
 */
async function girisSayfaMesaji(
  sayfa: Page,
  koruma: GirisKorumasi,
  onceki: string[] | null,
): Promise<GirisSayfaMesaji | undefined> {
  const ham = await sinirli(sayfaMesajiParcalari(sayfa, onceki), GIRIS_SAYFA_ICI_MS).catch(() => null);
  if (ham === null || zamanAsimiMi(ham)) return undefined;
  if (ham.tasma) return { tur: 'gizlendi' };
  if (ham.metinler.every((parca) => sayfaMetniCitle(parca) === '')) return undefined;
  try {
    await envantereEkle(sayfa, koruma);
  } catch {
    return { tur: 'gizlendi' };
  }
  return sayfaMesajiniKur(koruma, ham.metinler);
}

function yonlendirmeRetHatasi(yonlendirmeler: readonly string[]): CredentialLeakBlockedError {
  const ornekOriginler = [...new Set(yonlendirmeler)].slice(0, 3);
  return new CredentialLeakBlockedError(
    `Login refused: kobay detected ${yonlendirmeler.length} cross-origin document redirect`
      + `${yonlendirmeler.length === 1 ? '' : 's'} during login that Chromium did not expose to `
      + `the route guard (${ornekOriginler.join(', ')}). ${authOriginIpucu(ornekOriginler)}`,
  );
}

/**
 * Gönder düğmesinin tıklama zaman aşımı anındaki durumu (sayfadan okunan HAM değerler; metinler
 * kırpılmadan gelir ki maske önce, kırpma sonra uygulansın ve uzun sırrın başı sızmasın).
 */
interface DugmeDurumu {
  /** `:disabled` (kendi `disabled` özniteliği ya da kapalı `fieldset` içinde). */
  disabled: boolean;
  /** Kendisi ya da bir atası `aria-disabled="true"`. */
  ariaDisabled: boolean;
  gorunur: boolean;
  /** Düğmenin ortasını kaplayan başka öğenin etiket adı ve kimliği; yoksa null. */
  ortulu: { etiket: string; id: string } | null;
  title: string;
  metin: string;
}

/** Düğme durumunu kısa sürede okur; okunamazsa (öğe yok, sayfa kapandı) null. */
async function dugmeDurumunuOku(dugme: Locator): Promise<DugmeDurumu | null> {
  // `evaluate`in `timeout`u yalnız öğeyi bulmayı sınırlar; donmuş sayfada değerlendirme hiç dönmez.
  return sinirli(dugme.evaluate((oge): DugmeDurumu => {
    const el = oge as HTMLElement;
    const kutu = el.getBoundingClientRect();
    const stil = getComputedStyle(el);
    const gorunur = kutu.width > 0 && kutu.height > 0 && stil.visibility !== 'hidden' && stil.display !== 'none';
    let ortulu: DugmeDurumu['ortulu'] = null;
    if (gorunur) {
      const ust = document.elementFromPoint(kutu.left + kutu.width / 2, kutu.top + kutu.height / 2);
      if (ust !== null && ust !== el && !el.contains(ust)) ortulu = { etiket: ust.tagName.toLowerCase(), id: ust.id };
    }
    return {
      disabled: el.matches(':disabled'),
      ariaDisabled: el.closest('[aria-disabled="true"]') !== null,
      gorunur,
      ortulu,
      title: el.getAttribute('title') ?? '',
      metin: el instanceof HTMLInputElement ? el.value : el.innerText,
    };
  }, undefined, { timeout: 1_000 }), GIRIS_SAYFA_ICI_MS).then((sonuc) => (zamanAsimiMi(sonuc) ? null : sonuc), () => null);
}

/**
 * Bağlamın çerez değerlerini ve sayfanın localStorage değerlerini maske envanterine ekler. Her
 * okuma `GIRIS_SAYFA_ICI_MS` ile sınırlı (donmuş sayfada `evaluate` hiç dönmez); okunamazsa
 * envanter eksik sayılır ve sayfadan alınan alanlar `[withheld]` olur. Envanter zaten eksikse
 * sayfaya bir daha sorulmaz.
 */
async function envantereEkle(sayfa: Page, koruma: GirisKorumasi): Promise<void> {
  if (koruma.envanterEksikMi()) return;
  const [cerezler, depo] = await Promise.all([
    sinirli(sayfa.context().cookies(), GIRIS_SAYFA_ICI_MS).catch(() => undefined),
    sinirli(sayfa.evaluate(() => {
      try {
        return Object.keys(localStorage).map((anahtar) => localStorage.getItem(anahtar) ?? '');
      } catch {
        return [];
      }
    }), GIRIS_SAYFA_ICI_MS).catch(() => undefined),
  ]);
  if (cerezler === undefined || zamanAsimiMi(cerezler) || depo === undefined || zamanAsimiMi(depo)) {
    koruma.envanterEksik();
  }
  if (cerezler !== undefined && !zamanAsimiMi(cerezler)) koruma.gizlilereEkle(cerezler.map((cerez) => cerez.value));
  if (depo !== undefined && !zamanAsimiMi(depo)) koruma.gizlilereEkle(depo);
}

/**
 * Sayfadan gelen alan metni (düğme yazısı, title, örten öğe, Playwright adımı): ÖNCE maske
 * (kısa sır geçiyorsa `[withheld]`), sonra boşluk sadeleştirme ve yine maske, EN SON kırpma.
 */
function alanMetni(koruma: GirisKorumasi, ham: string, uzunluk: number): string {
  const sade = koruma.metniGizle(koruma.metniGizle(ham, { alan: true }).replace(/\s+/g, ' ').trim(), { alan: true });
  return sade.length > uzunluk ? `${sade.slice(0, uzunluk - 3)}...` : sade;
}

/** Playwright zaman aşımı mesajının ilk satırı ve son anlamlı günlük adımı (ANSI renkleri temizlenmiş). */
function playwrightOzeti(hata: Error): { ilk: string; son: string | undefined } {
  // eslint-disable-next-line no-control-regex
  const satirlar = hata.message.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map((satir) => satir.trim()).filter(Boolean);
  const adimlar = satirlar.slice(1)
    .filter((satir) => satir.startsWith('- ') && !/^- (retrying click action|waiting \d+ms|waiting for )/.test(satir));
  return { ilk: (satirlar[0] ?? hata.name).replace(/\.$/, ''), son: adimlar.at(-1)?.slice(2) };
}

/**
 * Gönder tıklaması zaman aşımına uğradığında tek, anlaşılır hata kurar. Önce giriş korumasının
 * penceresi kapatılır: sızıntı ya da yabancı belge commit'i varsa o hata (daha ağır) aynen
 * fırlar; pencerede kesilen belge/yazma açıklaması düğme durumuyla birleştirilir. Mesajın
 * tamamı korumanın sır envanteriyle maskelenir.
 */
async function tiklamaZamanAsimiHatasi(
  sayfa: Page,
  dugme: Locator,
  koruma: GirisKorumasi,
  hata: Error,
  tiklamaBeklemeMs: number,
): Promise<Error> {
  const durum = await dugmeDurumunuOku(dugme);
  // Tarayıcıya bir gidiş-dönüş (girisiGonder'deki gibi); tıklama sırasında kurulan çerez ve
  // depolama değerleri de envantere girer.
  await envantereEkle(sayfa, koruma);

  const sure = Math.max(1, Math.round(tiklamaBeklemeMs / 1000));
  const yazi = durum === null ? '' : alanMetni(koruma, durum.metin, 60);
  const ad = yazi === '' ? '' : ` ("${yazi}")`;
  let mesaj = `Login could not be submitted: clicking the submit button${ad} did not complete within ${sure} s;`
    + ' the session was not saved.';
  if (durum === null) {
    mesaj += ' kobay could not read the button state.';
  } else {
    const kilitler: string[] = [];
    if (durum.disabled) kilitler.push('it is disabled');
    if (durum.ariaDisabled) kilitler.push('it is marked aria-disabled="true"');
    if (!durum.gorunur) kilitler.push('it is not visible');
    if (durum.ortulu !== null) {
      const id = durum.ortulu.id === '' ? '' : ` id="${alanMetni(koruma, durum.ortulu.id, 40)}"`;
      kilitler.push(`another element covers it (<${alanMetni(koruma, durum.ortulu.etiket, 20)}${id}>)`);
    }
    const title = alanMetni(koruma, durum.title, 120);
    const baslik = title === '' ? '' : ` Button title: "${title}".`;
    mesaj += kilitler.length > 0
      ? ` The button is locked: ${kilitler.join(', ')}.${baslik}`
        + ' Pages often keep login locked until a captcha or another human check passes; kobay cannot complete those.'
        + ' Log in in your own browser, save its Playwright storageState, and import it with'
        + ' `kobay project create --url <URL> --session-file <file> --force`.'
      : ` The button is not locked (enabled, visible, not covered), so something else kept the click from completing.${baslik}`;
  }
  const ozet = playwrightOzeti(hata);
  const playwright = ` Playwright: ${ozet.ilk}${ozet.son === undefined ? '' : ` (last step: ${alanMetni(koruma, ozet.son, 160)})`}`;

  let yonlendirmeler: readonly string[];
  await koruma.bekle();
  try {
    yonlendirmeler = koruma.denetle(false);
  } catch (denetimHatasi: unknown) {
    if (denetimHatasi instanceof LoginBlockedRequestsError) {
      return new LoginSubmitTimeoutError(koruma.metniGizle(`${mesaj} ${denetimHatasi.message}${playwright}`));
    }
    throw denetimHatasi;
  }
  if (yonlendirmeler.length > 0) return yonlendirmeRetHatasi(yonlendirmeler);
  return new LoginSubmitTimeoutError(koruma.metniGizle(`${mesaj}${koruma.kesimNotu()}${playwright}`));
}

/**
 * Giriş reddedilince önceki başarılı girişten kalan oturum dosyasını kaldırır: koşucu dosya
 * var diye onu (süresi geçmiş ya da başka kullanıcının oturumu) kullanmasın. Dosya yoksa sessiz.
 */
export async function oturumDurumunuSil(storageStateYolu: string): Promise<void> {
  await rm(storageStateYolu, { force: true });
}

/** Oturum dosyası sembolik bağ: kobay hedefinin üstüne yazmaz. */
export class StorageStateSymlinkError extends Error {
  constructor(yol: string) {
    super(`${yol} is a symbolic link; kobay does not write the session through it. Remove the link and run the command again.`);
    this.name = 'StorageStateSymlinkError';
  }
}

/**
 * Oturum durumunu 0600 izinle yazar; dizini gerekirse açar. Yol sembolik bağsa reddeder (depodan
 * gelen bir bağ kullanıcı dosyasını ezdirmesin); yazım geçici dosya + rename ile atomiktir.
 */
export async function oturumDurumunuYaz(context: BrowserContext, storageStateYolu: string): Promise<void> {
  const bilgi = await lstat(storageStateYolu).catch(() => null);
  if (bilgi?.isSymbolicLink() === true) throw new StorageStateSymlinkError(storageStateYolu);
  const durum = await context.storageState();
  await yazAtomik(storageStateYolu, JSON.stringify(durum, null, 2), 0o600);
}
