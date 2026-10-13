import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { authOriginNormallestir, type Kimlik } from '../depo/index.js';
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

/** `girisiGonder` sonucu: giriş tamamlandı mı, tamamlanmadıysa sayfanın gösterdiği uyarı (varsa). */
export interface GirisSonucu {
  basarili: boolean;
  sayfaMesaji?: GirisSayfaMesaji;
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
  try {
    return await girisiGonderIc(sayfa, form, kimlik, hedefOrigin, authOrigins, urlBeklemeMs, donusBeklemeMs, tiklamaBeklemeMs);
  } catch (hata: unknown) {
    if (hata instanceof Error) {
      const koruma = girisKorumasiBul(sayfa.context());
      hata.message = koruma === undefined ? metniGizle(hata.message, kimlikIzleri(kimlik)) : koruma.metniGizle(hata.message);
    }
    throw hata;
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
  const formHedefi = await sinirli(form.parolaAlani.evaluate((alan) => {
    const girdi = alan as HTMLInputElement;
    const dugme = girdi.form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])') as
      HTMLButtonElement | null | undefined;
    // formAction, öznitelik yoksa sayfa adresini döner; yalnız öznitelik varsa formun hedefini ezer.
    if (dugme?.hasAttribute('formaction') === true) return dugme.formAction;
    return girdi.form?.action ?? document.location.href;
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
  const yabanciCerceveOriginleri = yabanciCerceveler(
    sayfa.context().pages().flatMap((baglamSayfasi) => baglamSayfasi.frames().map((cerceve) => cerceve.url())),
    hedefOrigin,
    authOrigins,
  );
  if (yabanciCerceveOriginleri.length > 0) {
    const origin = yabanciCerceveOriginleri[0] as string;
    throw yabanciBelgeHatasi(origin);
  }
  // Çıktı maskesi: parola yazılmadan önceki çerez ve depolama değerleri (sayfa sonra silebilir).
  await envantereEkle(sayfa, koruma);
  koruma.pencereyiAc();
  await form.kullaniciAlani.fill(kimlik.username, { timeout: GIRIS_DOLDURMA_MS });
  await form.parolaAlani.fill(kimlik.password, { timeout: GIRIS_DOLDURMA_MS });
  await envantereEkle(sayfa, koruma);
  const oncekiUrl = sayfa.url();
  // Bekleyici tıklamadan önce başlar (hızlı yönlendirme kaçmasın) ama URL bütçesi tıklama
  // bittiğinde başlar: kilitli düğme geç açılıp gönderim başarılı olursa giriş yanlışlıkla
  // başarısız sayılmasın. Bekleyicinin kendi tavanı iki bütçenin toplamıdır.
  const urlDegisimi = sayfa.waitForURL((url) => url.href !== oncekiUrl, { timeout: tiklamaBeklemeMs + urlBeklemeMs })
    .then(() => true)
    .catch(() => false);
  try {
    await form.gonderDugmesi.click({ timeout: tiklamaBeklemeMs });
  } catch (hata: unknown) {
    if (!(hata instanceof Error) || hata.name !== 'TimeoutError') throw hata;
    throw await tiklamaZamanAsimiHatasi(sayfa, form.gonderDugmesi, koruma, hata, tiklamaBeklemeMs);
  }
  let zamanlayici: ReturnType<typeof setTimeout> | undefined;
  const urlSuresi = new Promise<boolean>((coz) => { zamanlayici = setTimeout(() => { coz(false); }, urlBeklemeMs); });
  const urlDegisti = await Promise.race([urlDegisimi, urlSuresi]) || sayfa.url() !== oncekiUrl;
  clearTimeout(zamanlayici);
  // Yeni sayfanın açılışta attığı istekler de denetlensin diye ağın durulması beklenir;
  // ağ hiç durulmayan uygulamada en fazla iki saniye. Sonraki istekleri koruma yine keser.
  await sayfa.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
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
  const girisBasarili = urlDegisti && donulmeyenOrigin === null;
  // Tarayıcıya bir gidiş-dönüş (en iyi çaba): tarayıcının bu yanıttan önce yaydığı istek/commit
  // olayları (pencere sonunda başlamış bir yönlendirme ayağı dahil) aynı sıralı bağlantıdan önce
  // gelir ve `denetle` evreyi kapatmadan işlenir. Playwright'ın kendi içinde ertelediği olaylar
  // için kesin sıra garantisi yoktur; bu bekleme yarışı daraltır, kanıtlanmış bir kapı değildir.
  await sayfa.context().cookies().catch(() => undefined);
  // Sızıntı varsa önce o bildirilir: dönüş hatası daha ağır bir nedeni örtmesin.
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
      : ` The button is not locked (enabled, visible, not covered), so something else kept the click from completing.${baslik}`;
  }
  const ozet = playwrightOzeti(hata);
  const playwright = ` Playwright: ${ozet.ilk}${ozet.son === undefined ? '' : ` (last step: ${alanMetni(koruma, ozet.son, 160)})`}`;

  let yonlendirmeler: readonly string[];
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

/** Oturum durumunu 0600 izinle yazar; dizini gerekirse açar. */
export async function oturumDurumunuYaz(context: BrowserContext, storageStateYolu: string): Promise<void> {
  await mkdir(dirname(storageStateYolu), { recursive: true });
  await context.storageState({ path: storageStateYolu });
  await chmod(storageStateYolu, 0o600);
}
