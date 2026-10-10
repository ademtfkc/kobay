import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { authOriginNormallestir, type Kimlik } from '../depo/index.js';
import type { GirisFormu } from './giris.js';
import { girisKorumasiKur, izinliKumedeMi, izinliMetni } from './giris-korumasi.js';

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
 * Giriş formunu doldurup gönderir ve URL değişimini bekler.
 * `kesfet` ile `sayfayiYenile` aynı girişi iki kez yazmasın diye burada.
 */
export async function girisiGonder(
  sayfa: Page,
  form: GirisFormu,
  kimlik: Kimlik,
  hedefOrigin: string,
  authOrigins: readonly string[] = [],
  urlBeklemeMs = 5_000,
  donusBeklemeMs = GIRIS_DONUS_BEKLEME_MS,
): Promise<boolean> {
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
  const formHedefi = await form.parolaAlani.evaluate((alan) => {
    const girdi = alan as HTMLInputElement;
    const dugme = girdi.form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])') as
      HTMLButtonElement | null | undefined;
    // formAction, öznitelik yoksa sayfa adresini döner; yalnız öznitelik varsa formun hedefini ezer.
    if (dugme?.hasAttribute('formaction') === true) return dugme.formAction;
    return girdi.form?.action ?? document.location.href;
  });
  const hedefAdres = new URL(formHedefi, sayfa.url());
  if (!izinliKumedeMi(hedefAdres.href, hedefOrigin, authOrigins)) {
    throw new LoginFormOriginError(
      `The login form submits to a different site (${hedefAdres.origin}); `
        + `credentials are only sent to ${izinliMetni(hedefOrigin, authOrigins)}. `
        + 'Locally, ports may differ but the host name must match (localhost and 127.0.0.1 are different sites).'
        + ssoIpucu,
    );
  }
  // Form hedefi doğru olsa da sayfadaki JavaScript parolayı fetch/XHR/beacon/WebSocket ile başka
  // siteye gönderebilir; parola alana yazılmadan önce ağ koruması kurulur. Koruma burada
  // KALDIRILMAZ: bağlam kapanana kadar (giriş sonrası keşif boyunca) kalır. Keşfin sonunda
  // `girisKorumasiSonDenetim` çağrılmalı. WebSocket kesimi yalnız koruma kurulduktan sonra açılan
  // belgelere işlediği için çağıran (kesfet, sayfayiYenile) korumayı ilk sayfadan önce kurar;
  // burada kurulu olanı alırız.
  const koruma = await girisKorumasiKur(sayfa.context(), kimlik, izinli);
  // Giriş penceresi: parola sayfadayken siteler-arası yazma ve yeni WebSocket de kesilir;
  // `denetle` pencereyi kapatır, sonrasında yalnız parolayı taşıyan istek kesilir.
  koruma.pencereyiAc();
  await form.kullaniciAlani.fill(kimlik.username);
  await form.parolaAlani.fill(kimlik.password);
  const oncekiUrl = sayfa.url();
  const urlDegisimi = sayfa.waitForURL((url) => url.href !== oncekiUrl, { timeout: urlBeklemeMs })
    .then(() => true)
    .catch(() => false);
  await form.gonderDugmesi.click();
  const urlDegisti = await urlDegisimi;
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
  const girisBasarili = urlDegisti && donulmeyenOrigin === null;
  // Sızıntı varsa önce o bildirilir: dönüş hatası daha ağır bir nedeni örtmesin.
  koruma.denetle(girisBasarili);
  // Dönüşten sonraki ağ durulmasında gecikmeli meta-refresh ya da JavaScript yönlendirmesi
  // sayfayı uygulamadan çıkarmış olabilir: origin bir kez daha doğrulanır.
  if (urlDegisti && donulmeyenOrigin === null && !uygulamadaMi()) donulmeyenOrigin = new URL(sayfa.url()).origin;
  if (donulmeyenOrigin !== null) {
    throw new LoginDidNotReturnError(
      `Login did not return to the app origin (ended on ${donulmeyenOrigin}, expected ${hedefOrigin}`
        + ` within ${Math.round(donusBeklemeMs / 1000)} s); the session was not saved.`
        + ' Check the credentials and that login redirects back to the app.',
    );
  }
  return girisBasarili;
}

/** Oturum durumunu 0600 izinle yazar; dizini gerekirse açar. */
export async function oturumDurumunuYaz(context: BrowserContext, storageStateYolu: string): Promise<void> {
  await mkdir(dirname(storageStateYolu), { recursive: true });
  await context.storageState({ path: storageStateYolu });
  await chmod(storageStateYolu, 0o600);
}
