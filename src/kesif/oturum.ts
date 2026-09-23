import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import type { Kimlik } from '../depo/index.js';
import type { GirisFormu } from './giris.js';

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
  // loginUrl doğru olsa bile uygulama başka origin'e yönlendirmiş olabilir;
  // kimlik bilgisi yalnız hedefin kendi origin'indeki forma ve o origin'e giden gönderime yazılır.
  const sayfaOrigin = new URL(sayfa.url()).origin;
  const formHedefi = await form.parolaAlani.evaluate((alan) => {
    const girdi = alan as HTMLInputElement;
    const dugme = girdi.form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])') as
      HTMLButtonElement | null | undefined;
    // formAction, öznitelik yoksa sayfa adresini döner; yalnız öznitelik varsa formun hedefini ezer.
    if (dugme?.hasAttribute('formaction') === true) return dugme.formAction;
    return girdi.form?.action ?? document.location.href;
  });
  const hedefOrigin = new URL(formHedefi, sayfa.url()).origin;
  if (sayfaOrigin !== izinliOrigin || hedefOrigin !== izinliOrigin) {
    throw new Error(
      `The login form is on a different origin (${sayfaOrigin === izinliOrigin ? hedefOrigin : sayfaOrigin}); `
        + `credentials are only sent to ${izinliOrigin}.`,
    );
  }
  await form.kullaniciAlani.fill(kimlik.username);
  await form.parolaAlani.fill(kimlik.password);
  const oncekiUrl = sayfa.url();
  const urlDegisimi = sayfa.waitForURL((url) => url.href !== oncekiUrl, { timeout: urlBeklemeMs })
    .then(() => true)
    .catch(() => false);
  await form.gonderDugmesi.click();
  return urlDegisimi;
}

/** Oturum durumunu 0600 izinle yazar; dizini gerekirse açar. */
export async function oturumDurumunuYaz(context: BrowserContext, storageStateYolu: string): Promise<void> {
  await mkdir(dirname(storageStateYolu), { recursive: true });
  await context.storageState({ path: storageStateYolu });
  await chmod(storageStateYolu, 0o600);
}
