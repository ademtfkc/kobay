import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import type { Kimlik } from '../depo/index.js';
import type { GirisFormu } from './giris.js';
import { ayniSiteOriginMi, girisKorumasiKur } from './giris-korumasi.js';

/** Kimlik bilgilerinin yalnız hedef uygulamanın kendi origin'ine gönderilmesini sağlar. */
export function loginUrlDogrula(baseUrl: string, loginUrl: string | undefined): void {
  if (loginUrl === undefined) return;
  let baseOrigin: string;
  let loginOrigin: string;
  try {
    baseOrigin = new URL(baseUrl).origin;
    loginOrigin = new URL(loginUrl).origin;
  } catch {
    throw new Error('baseUrl and loginUrl must be valid URLs');
  }
  if (baseOrigin !== loginOrigin) {
    throw new Error('loginUrl must be on the same origin as baseUrl');
  }
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

/** Kayıtlı kimlik ile hedef origin uyuşmadığında fırlatılır; parola hiç yazılmamıştır. */
export class CredentialOriginError extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'CredentialOriginError';
  }
}

/**
 * Kayıtlı kimliğin, verildiği origin'den başka bir hedefe yazılmasını engeller.
 * Origin'i bilinmeyen (eski biçim) kimlik de reddedilir: nereye ait olduğu
 * kanıtlanamayan parola hiçbir forma yazılmaz.
 */
export function kimlikOriginDogrula(kimlik: Kimlik, hedefOrigin: string): void {
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
}

/**
 * Giriş formunu doldurup gönderir ve URL değişimini bekler.
 * `kesfet` ile `sayfayiYenile` aynı girişi iki kez yazmasın diye burada.
 */
export async function girisiGonder(
  sayfa: Page,
  form: GirisFormu,
  kimlik: Kimlik,
  izinliOrigin: string,
  urlBeklemeMs = 5_000,
): Promise<boolean> {
  kimlikOriginDogrula(kimlik, izinliOrigin);
  // loginUrl doğru olsa bile uygulama başka adrese yönlendirmiş olabilir. Parolanın YAZILDIĞI
  // sayfa tam origin ister (sayfanın betiği parolayı okur; kimlik de bu origin'e verilmiştir).
  // Parolanın GİTTİĞİ yer ise ağ korumasıyla aynı kural: form hedefi aynı sitede olabilir
  // (app.example.com → api.example.com), başka sitede olamaz.
  const sayfaOrigin = new URL(sayfa.url()).origin;
  if (sayfaOrigin !== izinliOrigin) {
    throw new LoginFormOriginError(
      `The login page is on a different origin (${sayfaOrigin}); credentials are only typed on ${izinliOrigin}.`,
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
  if (!ayniSiteOriginMi(hedefAdres.href, izinliOrigin)) {
    throw new LoginFormOriginError(
      `The login form submits to a different site (${hedefAdres.origin}); `
        + `credentials are only sent to the site of ${izinliOrigin}. `
        + 'A separate auth site (SSO) is not supported. Locally, ports may differ but the host name must match (localhost and 127.0.0.1 are different sites).',
    );
  }
  // Form hedefi doğru olsa da sayfadaki JavaScript parolayı fetch/XHR/beacon/WebSocket ile başka
  // siteye gönderebilir; parola alana yazılmadan önce ağ koruması kurulur. Koruma burada
  // KALDIRILMAZ: bağlam kapanana kadar (giriş sonrası keşif boyunca) kalır. Keşfin sonunda
  // `girisKorumasiSonDenetim` çağrılmalı. WebSocket kesimi yalnız koruma kurulduktan sonra açılan
  // belgelere işlediği için çağıran (kesfet, sayfayiYenile) korumayı ilk sayfadan önce kurar;
  // burada kurulu olanı alırız.
  const koruma = await girisKorumasiKur(sayfa.context(), kimlik, izinliOrigin);
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
  const girisBasarili = await urlDegisimi;
  // Yeni sayfanın açılışta attığı istekler de denetlensin diye ağın durulması beklenir;
  // ağ hiç durulmayan uygulamada en fazla iki saniye. Sonraki istekleri koruma yine keser.
  await sayfa.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
  koruma.denetle(girisBasarili);
  return girisBasarili;
}

/** Oturum durumunu 0600 izinle yazar; dizini gerekirse açar. */
export async function oturumDurumunuYaz(context: BrowserContext, storageStateYolu: string): Promise<void> {
  await mkdir(dirname(storageStateYolu), { recursive: true });
  await context.storageState({ path: storageStateYolu });
  await chmod(storageStateYolu, 0o600);
}
