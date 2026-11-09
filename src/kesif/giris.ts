import type { Locator, Page } from '@playwright/test';

export interface GirisFormu {
  kullaniciAlani: Locator;
  parolaAlani: Locator;
  /**
   * Tıklanacak gönder düğmesi. `null`: formda gönder düğmesi (submit) hiç yok ve giriş adlı bir
   * düğme de bulunamadı; giriş parola alanında Enter ile gönderilir.
   */
  gonderDugmesi: Locator | null;
}

/** Formdaki düğme adayları; sıra belge sırasıdır (Playwright CSS listesi belge sırasında döner). */
const DUGME_SECICI = 'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]';

/** Bir düğme adayının seçimde kullanılan, sayfadan okunmuş özeti. */
export interface DugmeAdayi {
  /** Gönderen (submit) düğme mi: `button[type=submit]`, tipsiz `button`, `input[type=submit|image]`. */
  gonderen: boolean;
  /** Erişilebilir ada yakın metin: aria-label, aria-labelledby, görünür yazı, value, title. */
  ad: string;
  /** Yalnız ret için bakılan yapısal ipuçları: id, class, name, aria-controls, data-* değerleri. */
  ipucu: string;
}

/**
 * Giriş düğmesi adları (harf sınırıyla; `u` bayrağı Türkçe harfleri harf sayar). Yalnız tip
 * `button` olan (formu kendiliğinden göndermeyen) düğmeler için gerekir: onlarda ad tek kanıttır.
 */
const GIRIS_ADI = /(?<!\p{L})(?:log\s?-?\s?in|log\s?-?\s?on|sign\s?-?\s?in|sign\s?-?\s?on|submit|continue|next|enter|anmelden|einloggen|connexion|se connecter|iniciar sesi[oó]n|entrar|accedi|accedere|inloggen|giri[şs]( yap)?|oturum a[çc])(?!\p{L})/iu;

/**
 * Tıklanmayacak düğmeler: parola göster/gizle, parolamı unuttum, kayıt, iptal, dil/sunucu
 * değiştir ve başka kimlik sağlayıcısıyla giriş ("Sign in with Google": sağlayıcı adıyla; tek
 * başına "with" ret değildir, "Continue with password" / "Sign in with email" yerel giriştir).
 * Ret, giriş adından önce gelir: "Forgot login?" giriş sayılmaz.
 */
const YANLIS_DUGME = /(?<!\p{L})(?:forgot\w*|reset|recover\w*|show|hide|reveal|toggle|visib\w*|eye|peek|unmask|mask|register|sign\s?-?\s?up|create|cancel|back|clear|change|switch|language|lang|help|google|github|gitlab|microsoft|apple|facebook|twitter|linkedin|okta|azure|keycloak|auth0|slack|discord|sso|single\s?-?\s?sign\s?-?\s?on|(?:log\s?-?\s?in|sign\s?-?\s?in)\s+link|email\s+me|saml|oidc|openid|passkey|webauthn|magic|unuttum|göster|gizle|kayıt|kaydol|iptal|vazgeç|vergessen|oubli\w*|olvid\w*|registrieren|abbrechen)(?!\p{L})/iu;

/**
 * Başka bir yolla giriş: "with/using/via/through <X>". X parola, e-posta, kullanıcı adı ya da
 * hesap değilse (ör. "Sign in with Authentik", "Continue with Zitadel") düğme bir kimlik
 * sağlayıcısıdır: listede adı olmasa da yanlış sayılır. "Continue with password" ve
 * "Sign in with email" yerel giriştir, kalır.
 */
const BASKA_YOLLA = /(?<!\p{L})(?:with|using|via|through)\s+(?!(?:your\s+|my\s+|an?\s+|the\s+)?(?:password|passcode|e-?mail|username|user\s?name|account|credentials|login)(?!\p{L}))\p{L}/iu;

/**
 * Yapısal ipucunda (class, id…) ret: kelime sınırı yerine parça (`password-eye`, `togglePassword`,
 * Material `visibility` ikonu). Yalnız adı giriş olmayan düğmeye uygulanır: `hidden-xs` ya da
 * `visible-lg` sınıflı "Log in" düğmesi yanlış sayılmasın.
 */
const YANLIS_IPUCU = /eye|toggle|reveal|show-?pass|hide-?pass|visibility|peek|unmask|forgot|reset|register|sign-?up|oauth|sso/i;

/**
 * Formdaki düğmelerden tıklanacağı seçer; dönen değer aday sırasındaki indeks, `'enter'` ya da
 * `null` (giriş denenmez).
 *
 * Adaylar formun içindeki ve `form="<id>"` ile forma bağlı (formun dışındaki) düğmelerdir.
 *
 * 1. Yanlış düğme (adı ret listesinde ya da "with/using/via <sağlayıcı>"; adı giriş değilse
 *    yapısal ipucu da) hiç seçilmez. Liste bilinen adları kapsar; her dilde her adı tanımaz, bu
 *    yüzden giriş adı önce gelir.
 * 2. Adı giriş olan gönderen düğme.
 * 3. Adı giriş olan tip `button` düğme (Vikunja: `<button type="button">Login`). Tanınmayan bir
 *    gönderenden önce gelir: `type=submit "Passwort vergessen"` + `type=button "Anmelden"`.
 * 4. İlk (yanlış olmayan) gönderen düğme (eski davranış: ikon düğme, "→").
 * 5. Forma bağlı gönderen düğme HİÇ yoksa Enter. Gönderen düğme var ama hepsi yanlışsa Enter de
 *    yasak: tarayıcı Enter'da formun ilk gönderen düğmesine (ör. tipsiz göz düğmesi) basar.
 */
export function dugmeSec(adaylar: readonly DugmeAdayi[]): number | 'enter' | null {
  const girisAdiMi = (aday: DugmeAdayi): boolean => GIRIS_ADI.test(aday.ad);
  const yanlisMi = (aday: DugmeAdayi): boolean => YANLIS_DUGME.test(aday.ad) || BASKA_YOLLA.test(aday.ad)
    || (!girisAdiMi(aday) && YANLIS_IPUCU.test(aday.ipucu));
  const uygun = adaylar.map((aday, indeks) => ({ aday, indeks })).filter(({ aday }) => !yanlisMi(aday));
  const secilen = uygun.find(({ aday }) => aday.gonderen && girisAdiMi(aday))
    ?? uygun.find(({ aday }) => !aday.gonderen && girisAdiMi(aday))
    ?? uygun.find(({ aday }) => aday.gonderen);
  if (secilen !== undefined) return secilen.indeks;
  return adaylar.some((aday) => aday.gonderen) ? null : 'enter';
}

/** Sayfada (tarayıcıda) bir düğme adayının özetini okur. */
async function adayOku(dugme: Locator): Promise<DugmeAdayi | null> {
  return dugme.evaluate((oge) => {
    const el = oge as HTMLElement;
    const etiket = el.tagName.toLowerCase();
    const tip = (el.getAttribute('type') ?? '').toLowerCase();
    const gonderen = etiket === 'button'
      ? tip === '' || tip === 'submit'
      : etiket === 'input' && (tip === 'submit' || tip === 'image');
    const etiketli = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    const deger = el instanceof HTMLInputElement ? el.value : '';
    const ad = [el.getAttribute('aria-label') ?? '', etiketli, el.innerText, deger, el.getAttribute('alt') ?? '', el.getAttribute('title') ?? '']
      .join(' ').replace(/\s+/g, ' ').trim();
    const veri = Array.from(el.attributes).filter((oznitelik) => oznitelik.name.startsWith('data-'))
      .map((oznitelik) => `${oznitelik.name} ${oznitelik.value}`);
    const ipucu = [el.id, el.getAttribute('class') ?? '', el.getAttribute('name') ?? '', el.getAttribute('aria-controls') ?? '', ...veri]
      .join(' ');
    return { gonderen, ad, ipucu };
  }, undefined, { timeout: 2_000 }).catch(() => null);
}

/** Parola alanının bulunduğu formdaki kullanıcı ve gönder alanlarını bulur. */
export async function girisFormuBul(sayfa: Page): Promise<GirisFormu | null> {
  const parolaAlani = sayfa.locator('input[type="password"]').first();
  if (await parolaAlani.count() === 0) return null;

  const form = parolaAlani.locator('xpath=ancestor::form[1]');
  if (await form.count() === 0) return null;

  const kullaniciAlani = form
    .locator('input[type="email"], input[type="text"], input:not([type]), textarea')
    .first();
  if (await kullaniciAlani.count() === 0) return null;

  // Forma bağlı düğmeler: içindekiler (başka forma `form=` ile bağlananlar hariç) ve dışarıdan
  // `form="<id>"` ile bağlananlar. Tarayıcı Enter'da bunların ilk gönderenine basar.
  const tumu = sayfa.locator(DUGME_SECICI);
  const uyeler = await tumu.evaluateAll((ogeler) => {
    const parola = document.querySelector('input[type="password"]') as HTMLInputElement | null;
    const hedef = parola?.form ?? null;
    return ogeler.map((oge) => {
      if (hedef === null) return false;
      if (oge instanceof HTMLButtonElement || oge instanceof HTMLInputElement) return oge.form === hedef;
      return hedef.contains(oge);
    });
  }).catch(() => null);
  if (uyeler === null) return null;
  const hepsi = await tumu.all();
  if (hepsi.length !== uyeler.length) return null;
  const dugmeler = hepsi.filter((_dugme, sira) => uyeler[sira] === true);
  const adaylar: DugmeAdayi[] = [];
  for (const dugme of dugmeler) {
    const aday = await adayOku(dugme);
    // Okunamayan düğme (sayfa o an değişti) emniyetli tarafta: gönderen ve yanlış sayılır, hiç seçilmez
    // ve Enter'ı da kapatır (formun ilk gönderen düğmesi o olabilir).
    adaylar.push(aday ?? { gonderen: true, ad: '', ipucu: 'eye' });
  }
  const secim = dugmeSec(adaylar);
  if (secim === null) return null;
  if (secim === 'enter') return { kullaniciAlani, parolaAlani, gonderDugmesi: null };
  const gonderDugmesi = dugmeler[secim];
  return gonderDugmesi === undefined ? null : { kullaniciAlani, parolaAlani, gonderDugmesi };
}
