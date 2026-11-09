import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { Kimlik } from '../../src/depo/index.js';
import { dugmeSec, type DugmeAdayi } from '../../src/kesif/giris.js';
import { girisFormuBul, girisiGonder } from '../../src/kesif/index.js';

/**
 * 0.8.0 Ş1 P1-1: gönder düğmesi `type="button"` olan giriş formu (Vikunja v2.7.1) ve gönder
 * düğmesi olmayan form (Enter). Yanlış düğmeye (parolayı göster, parolamı unuttum, başka kimlik
 * sağlayıcısı) asla basılmaz. Önce saf seçim kuralı, sonra gerçek Chromium + yerel sunucu.
 */

const g = (ad: string, ipucu = ''): DugmeAdayi => ({ gonderen: true, ad, ipucu });
const b = (ad: string, ipucu = ''): DugmeAdayi => ({ gonderen: false, ad, ipucu });

describe('dugmeSec (saf kural)', () => {
  it('Vikunja: göz düğmesi (type=button, "Show the password") atlanır, "Login" (type=button) seçilir', () => {
    expect(dugmeSec([b('Show the password', 'password-field-type-toggle'), b('Login', 'button is-primary')])).toBe(1);
  });

  it('gönderen düğme varsa eski davranış: ilk gönderen (adı olmasa da)', () => {
    expect(dugmeSec([g('→')])).toBe(0);
    expect(dugmeSec([b('Login'), g('Continue')])).toBe(1);
  });

  it('gönderenlerden adı giriş olan öne geçer', () => {
    expect(dugmeSec([g('Ask'), g('Sign in')])).toBe(1);
  });

  it('"Forgot password?" ve "Sign up" type=button hiç seçilmez; gönderen yoksa Enter', () => {
    expect(dugmeSec([b('Forgot password?'), b('Sign up')])).toBe('enter');
  });

  it('"Forgot login?" ret listesinde: giriş adı geçse de seçilmez', () => {
    expect(dugmeSec([b('Forgot login?'), b('Log in')])).toBe(1);
    expect(dugmeSec([b('Forgot login?')])).toBe('enter');
  });

  it('tur 3: "Continue with password" ve "Sign in with email" yerel giriştir, seçilir; "Sign in with Okta" seçilmez', () => {
    expect(dugmeSec([b('Continue with password')])).toBe(0);
    expect(dugmeSec([b('Sign in with email')])).toBe(0);
    expect(dugmeSec([b('Sign in with Okta'), b('Sign in with email')])).toBe(1);
  });

  it('B1: listede olmayan sağlayıcı ve tek oturum açma/bağlantı düğmeleri seçilmez, düz giriş seçilir', () => {
    expect(dugmeSec([b('Sign in with Authentik'), b('Sign in')])).toBe(1);
    expect(dugmeSec([g('Continue with Zitadel'), b('Log in')])).toBe(1);
    expect(dugmeSec([b('Continue with Bitbucket'), g('Continue')])).toBe(1);
    expect(dugmeSec([b('Email me a login link'), b('Log in')])).toBe(1);
    expect(dugmeSec([b('Use single sign-on'), b('Log in')])).toBe(1);
    expect(dugmeSec([g('Sign in using Authelia')])).toBeNull();
    expect(dugmeSec([b('Sign in via Kanidm')])).toBe('enter');
    // Yerel giriş kalır.
    expect(dugmeSec([b('Continue with password')])).toBe(0);
    expect(dugmeSec([b('Sign in with email')])).toBe(0);
    expect(dugmeSec([g('Sign in with your account')])).toBe(0);
  });

  it('"Sign in with Google" seçilmez, düz "Sign in" seçilir', () => {
    expect(dugmeSec([b('Sign in with Google'), b('Sign in')])).toBe(1);
    expect(dugmeSec([b('Sign in with Google')])).toBe('enter');
  });

  it('adsız göz düğmesi yapısal ipucundan tanınır (tipsiz button = gönderen)', () => {
    expect(dugmeSec([g('', 'btn password-eye'), g('Log in')])).toBe(1);
    expect(dugmeSec([g('', 'togglePassword'), b('Login')])).toBe(1);
  });

  it('gönderen düğmelerin hepsi yanlışsa Enter de yasak (Enter ilk gönderene basar): null', () => {
    expect(dugmeSec([g('', 'password-eye')])).toBeNull();
    expect(dugmeSec([g('Show password'), b('Forgot password?')])).toBeNull();
  });

  it('P2-4: adı giriş olan düğme, tanınmayan ilk gönderenden önce gelir', () => {
    expect(dugmeSec([g('Ask'), b('Login')])).toBe(1);
    expect(dugmeSec([g('Passwort vergessen'), b('Anmelden')])).toBe(1);
    expect(dugmeSec([g('Mot de passe oublié ?'), b('Connexion')])).toBe(1);
    // Giriş adı yoksa da yanlış gönderene basılmaz; Enter de ona basardı: giriş denenmez.
    expect(dugmeSec([g('Passwort vergessen')])).toBeNull();
  });

  it('düğmesiz form: Enter', () => {
    expect(dugmeSec([])).toBe('enter');
  });

  it('adı giriş olan düğmede sınıf ipucu ret sebebi değildir (hidden-xs, visible-lg)', () => {
    expect(dugmeSec([g('Log in', 'btn hidden-xs visible-lg')])).toBe(0);
  });

  it('Türkçe adlar: "Giriş yap" seçilir, "Şifremi unuttum" / "Parolayı göster" seçilmez', () => {
    expect(dugmeSec([b('Parolayı göster'), b('Şifremi unuttum'), b('Giriş yap')])).toBe(2);
  });

  it('adı giriş olmayan tip button düğme tahminle seçilmez: Enter', () => {
    expect(dugmeSec([b('Go!')])).toBe('enter');
  });
});

const KULLANICI = 'p11-kullanici@ornek.test';
const PAROLA = 'p11-parola-97531';
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;
let tarayici: Browser | undefined;
let sunucu: Server | undefined;
let appOrigin = '';
/** Sunucuya gelen istek yolları (yanlış düğme tıklanırsa `/forgot`, `/goz` görünür). */
const istekler: string[] = [];
/** POST /api/login gövdeleri. */
const girisler: string[] = [];

const BETIK = `<script>
  const gonder = (via) => fetch('/api/login', { method: 'POST', body: JSON.stringify({
    u: document.querySelector('#u').value, p: document.querySelector('#p').value, via }) })
    .then((y) => { if (y.ok) location.href = '/panel'; });
  document.querySelectorAll('[data-giris]').forEach((d) => d.addEventListener('click', () => gonder('click')));
  document.querySelector('#p').addEventListener('keyup', (e) => { if (e.key === 'Enter') gonder('enter'); });
  document.querySelectorAll('[data-tuzak]').forEach((d) => d.addEventListener('click', () => {
    fetch(d.dataset.tuzak); location.href = d.dataset.tuzak; }));
</script>`;

/** Sayfalar: SPA girişi (fetch + location), tuzak düğmeler tıklanırsa kendi yollarına gider. */
const SAYFALAR: Record<string, string> = {
  // Vikunja v2.7.1 biçimi: göz düğmesi formda, giriş düğmesi type=button.
  '/vikunja': '<form id="loginform"><input id="u" type="text"><input id="p" type="password">'
    + '<button type="button" class="password-field-type-toggle" aria-label="Show the password" data-tuzak="/goz">o</button>'
    + '<button type="button" class="button is-primary" data-giris><span>Login</span></button></form>',
  // Parolamı unuttum (type=button) giriş düğmesinden ÖNCE; tıklanırsa URL değişir ve giriş "başarılı" sanılırdı.
  '/unuttum': '<form><input id="u" type="text"><input id="p" type="password">'
    + '<button type="button" data-tuzak="/forgot">Forgot password?</button>'
    + '<button type="button" data-tuzak="/sso">Sign in with Google</button>'
    + '<button type="button" data-giris>Sign in</button></form>',
  // Düğmesiz form: Enter.
  '/enter': '<form><input id="u" type="text"><input id="p" type="password"></form>',
  // Tipsiz (gönderen) göz düğmesi tek düğme: Enter ona basardı; giriş denenmez.
  '/yalniz-goz': '<form onsubmit="event.preventDefault()"><input id="u" type="text"><input id="p" type="password">'
    + '<button class="password-eye" data-tuzak="/goz"></button></form>',
  // P2-3: giriş düğmesi formun DIŞINDA, `form="lf"` ile bağlı.
  '/disarida': '<form id="lf"><input id="u" type="text"><input id="p" type="password">'
    + '<button type="button" aria-label="Show password" data-tuzak="/goz">o</button></form>'
    + '<button type="button" form="lf" data-giris>Log in</button>',
  // P2-3: formun tek gönderen düğmesi dışarıdaki göz düğmesi; Enter ona basardı.
  '/disarida-goz': '<form id="lf" onsubmit="event.preventDefault()"><input id="u" type="text"><input id="p" type="password"></form>'
    + '<button form="lf" class="password-eye" data-tuzak="/goz"></button>',
  // P2-4: tanınmayan dilde ilk gönderen "Passwort vergessen", sonra tip button "Anmelden".
  '/almanca': '<form onsubmit="event.preventDefault()"><input id="u" type="text"><input id="p" type="password">'
    + '<button type="submit" data-tuzak="/forgot">Passwort vergessen</button>'
    + '<button type="button" data-giris>Anmelden</button></form>',
};

beforeAll(async () => {
  try {
    tarayici = await chromium.launch({ headless: true });
  } catch (hata: unknown) {
    tarayiciEngeli = hata;
    return;
  }
  sunucu = createServer((istek, yanit) => {
    const yol = new URL(istek.url ?? '/', 'http://x').pathname;
    istekler.push(yol);
    if (istek.method === 'POST' && yol === '/api/login') {
      let govde = '';
      istek.on('data', (parca: Buffer) => { govde += parca.toString(); });
      istek.on('end', () => { girisler.push(govde); yanit.writeHead(200).end('{}'); });
      return;
    }
    const icerik = SAYFALAR[yol];
    yanit.writeHead(200, { 'content-type': 'text/html' });
    yanit.end(`<!doctype html><html><body><h1>${yol}</h1>${icerik ?? ''}${icerik === undefined ? '' : BETIK}</body></html>`);
  });
  await new Promise<void>((coz) => { sunucu?.listen(0, '127.0.0.1', () => { coz(); }); });
  const adres = sunucu.address();
  if (adres === null || typeof adres === 'string') throw new Error('sunucu adresi yok');
  appOrigin = `http://127.0.0.1:${adres.port}`;
});

afterAll(async () => {
  await tarayici?.close();
  if (sunucu?.listening) await new Promise((coz) => { sunucu?.close(coz); });
});

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium bu ortamda engelli: ${ozet}`);
  return false;
}

/** Sayfada formu bulur ve girişi dener; form bulunamazsa `'form yok'`. Son URL'yi de döner. */
async function girisDene(yol: string): Promise<{ basarili: boolean | 'form yok'; sonUrl: string; hata?: string }> {
  if (tarayici === undefined) throw new Error('tarayıcı yok');
  istekler.length = 0;
  girisler.length = 0;
  const context = await tarayici.newContext({ serviceWorkers: 'block' });
  try {
    const kimlik: Kimlik = { username: KULLANICI, password: PAROLA, origin: appOrigin };
    const sekme = await context.newPage();
    await sekme.goto(`${appOrigin}${yol}`, { waitUntil: 'domcontentloaded' });
    const form = await girisFormuBul(sekme);
    if (form === null) return { basarili: 'form yok', sonUrl: sekme.url() };
    try {
      const sonuc = await girisiGonder(sekme, form, kimlik, appOrigin, [], 2_000, 2_000, 5_000);
      return { basarili: sonuc.basarili, sonUrl: sekme.url() };
    } catch (hata: unknown) {
      return { basarili: false, sonUrl: sekme.url(), hata: hata instanceof Error ? hata.message : String(hata) };
    }
  } finally {
    await context.close();
  }
}

describe('P1-1: type=button ve Enter ile giriş (gerçek Chromium)', () => {
  it('Vikunja biçimi: "Login" (type=button) tıklanır, göz düğmesi tıklanmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene('/vikunja');
    expect(sonuc).toEqual({ basarili: true, sonUrl: `${appOrigin}/panel` });
    expect(girisler).toEqual([JSON.stringify({ u: KULLANICI, p: PAROLA, via: 'click' })]);
    expect(istekler).not.toContain('/goz');
  });

  it('"Forgot password?" ve "Sign in with Google" önce gelse de tıklanmaz; "Sign in" tıklanır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene('/unuttum');
    expect(sonuc).toEqual({ basarili: true, sonUrl: `${appOrigin}/panel` });
    expect(girisler).toHaveLength(1);
    expect(istekler).not.toContain('/forgot');
    expect(istekler).not.toContain('/sso');
  });

  it('düğmesiz formda parola alanında Enter ile giriş', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene('/enter');
    expect(sonuc).toEqual({ basarili: true, sonUrl: `${appOrigin}/panel` });
    expect(girisler).toEqual([JSON.stringify({ u: KULLANICI, p: PAROLA, via: 'enter' })]);
  });

  it('P2-3: formun dışındaki form="lf" giriş düğmesi tıklanır (Enter değil)', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene('/disarida');
    expect(sonuc).toEqual({ basarili: true, sonUrl: `${appOrigin}/panel` });
    expect(girisler).toEqual([JSON.stringify({ u: KULLANICI, p: PAROLA, via: 'click' })]);
    expect(istekler).not.toContain('/goz');
  });

  it('P2-3: tek gönderen düğmesi dışarıdaki form="lf" göz düğmesiyse giriş denenmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene('/disarida-goz');
    expect(sonuc.basarili).toBe('form yok');
    expect(istekler).not.toContain('/goz');
    expect(girisler).toHaveLength(0);
  });

  it('P2-4: "Passwort vergessen" (submit) tıklanmaz, "Anmelden" (button) tıklanır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene('/almanca');
    expect(sonuc).toEqual({ basarili: true, sonUrl: `${appOrigin}/panel` });
    expect(istekler).not.toContain('/forgot');
  });

  it('tek düğmesi göz olan formda giriş denenmez (Enter göz düğmesine basardı)', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene('/yalniz-goz');
    expect(sonuc.basarili).toBe('form yok');
    expect(istekler).not.toContain('/goz');
    expect(girisler).toHaveLength(0);
  });
});
