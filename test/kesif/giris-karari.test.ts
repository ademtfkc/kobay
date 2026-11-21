import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { explore, projectCreate } from '../../src/cli/komutlar/index.js';
import { girisKorumasiKur } from '../../src/kesif/giris-korumasi.js';
import { girisFormuBul, girisiGonder, LoginNotVerifiedError, sayfayiYenile } from '../../src/kesif/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * 0.9.2 B: giriş kararı. Yanlış kimlikle giriş isteği (ve ona bağlı yönlendirme zinciri, fetch/XHR
 * dahil) 4xx/5xx aldıysa "URL değişti → başarı" yolu kapanır: `explore` exit 5 ("could not be
 * verified"), harita yazılmaz (`loggedIn:true` yok), oturum dosyası kaydedilmez. 429 kendi mesajını
 * korur; aynı URL'de kalan 200/422 + bant reddi eski mesajla biter; başarılı girişten sonra gelen
 * asset/analitik 403/500 karara girmez. Her durum gerçek CLI komutu (`projectCreate` + `explore`)
 * ve gerçek Chromium ile koşar; çıkış kodu, `loggedIn` ve oturum kaydı birlikte doğrulanır.
 */

const KULLANICI = 'b-kullanici@ornek.test';
const PAROLA = 'b-yanlis-parola-97531';
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;
let sunucu: Server | undefined;
let port = 0;
let app = '';
let sso = '';

function form(eylem: string, ek = ''): string {
  return `<form action="${eylem}" method="post"><input type="text" name="k"><input type="password" name="p">`
    + `<button type="submit">Log in</button></form>${ek}`;
}

function sayfa(baslik: string, govde = ''): string {
  return `<!doctype html><html><head><title>${baslik}</title></head><body><h1>${baslik}</h1>${govde}</body></html>`;
}

function html(yanit: ServerResponse, kod: number, govde: string, basliklar: Record<string, string> = {}): void {
  yanit.writeHead(kod, { 'content-type': 'text/html; charset=utf-8', ...basliklar });
  yanit.end(govde);
}

function yonlendir(yanit: ServerResponse, adres: string, basliklar: Record<string, string> = {}): void {
  yanit.writeHead(302, { location: adres, ...basliklar });
  yanit.end();
}

const CEREZ = { 'set-cookie': 'sid=ok; Path=/; HttpOnly' };
/** `GIRIS_ISTEGI_BEKLEME_MS` (5 sn) + ağ durulması (2 sn) tavanını aşan gecikme. */
const YANITSIZ_MS = 9_000;
/**
 * Aynı adreste karar anı: URL bütçesi (5 sn) + ağ durulması (2 sn) + giriş isteği tavanı (5 sn).
 * Bu gecikme tavanı aşar: karar anında giriş isteği hâlâ yanıtsızdır.
 */
const SABIT_YANITSIZ_MS = 16_000;
/** Eski (önceden geçerli) oturum dosyası: doğrulanamayan girişte bayt bayt kalmalı. */
const ESKI_OTURUM = JSON.stringify({
  cookies: [{ name: 'eski', value: 'SENTINEL-eski-oturum-31337', domain: '127.0.0.1', path: '/', expires: -1,
    httpOnly: false, secure: false, sameSite: 'Lax' }],
  origins: [],
});
const ozet = (metin: string): string => createHash('sha256').update(metin).digest('hex');

/** Gönderimi engelleyip parolayı fetch ile yollayan giriş sayfası; `sonra` yanıt geldikten sonra çalışır. */
function fetchSayfasi(uc: string, sonra: string, once = ''): string {
  return sayfa('Sign in', `<div role="alert" id="u"></div>${form(uc)}<script>const f=document.querySelector('form');`
    + 'f.addEventListener(\'submit\',async(e)=>{e.preventDefault();'
    + `${once}const r=await fetch('${uc}',{method:'POST',headers:{'content-type':'application/json'},`
    + 'body:JSON.stringify({k:f.k.value,p:f.p.value})});'
    + `${sonra}});</script>`);
}

/**
 * Aynı adreste kalan SPA girişi: 2xx'te `/`'a gider, 4xx'te uyarı bandı yazar, ağ hatasında (iptal
 * dahil) "Network error" uyarısı yazar. `iptal`: parolalı fetch 300 ms sonra iptal edilir.
 */
function sabitSayfa(uc: string, iptal: boolean, cift = false): string {
  return sayfa('Sign in', `<div role="alert" id="u"></div>${form(uc)}<script>const f=document.querySelector('form');`
    + 'f.addEventListener(\'submit\',async(e)=>{e.preventDefault();const u=document.getElementById(\'u\');'
    + `const c=new AbortController();${iptal ? 'setTimeout(()=>c.abort(),300);' : ''}`
    + (cift ? `fetch('${uc}?ikinci=1',{method:'POST',body:JSON.stringify({p:f.p.value})}).catch(()=>undefined);` : '')
    + `try{const r=await fetch('${uc}',{method:'POST',headers:{'content-type':'application/json'},`
    + 'body:JSON.stringify({k:f.k.value,p:f.p.value}),signal:c.signal});'
    + 'if(r.ok)location.href=\'/\';else u.textContent=\'Invalid username or password.\';}'
    + 'catch{u.textContent=\'Network error. Try again.\';}});</script>');
}

/** Senaryo: GET `/<ad>/login` giriş sayfası, POST davranışı aşağıda. */
function yonet(istek: IncomingMessage, yanit: ServerResponse): void {
  const adres = new URL(istek.url ?? '/', 'http://x');
  const yol = adres.pathname;
  const post = istek.method === 'POST';
  const cerezli = (istek.headers.cookie ?? '').includes('sid=ok');
  if (yol === '/') {
    html(yanit, 200, cerezli ? sayfa('Dashboard') : sayfa('Welcome'));
    return;
  }
  // `test refresh` hedefi: çerezsiz istek girişe yönlenir.
  if (yol === '/korumali') {
    if (cerezli) html(yanit, 200, sayfa('Records'));
    else yonlendir(yanit, '/p401/login');
    return;
  }
  const [, ad = '', parca = ''] = yol.split('/');
  // Giriş sayfaları (GET).
  if (!post && parca === 'login') {
    if (ad === 'fetch-basari') {
      html(yanit, 200, fetchSayfasi('/fetch-basari/api', 'if(r.ok)location.href=\'/\';'));
    } else if (ad === 'fetch-ret') {
      html(yanit, 200, fetchSayfasi('/fetch-ret/api',
        'if(!r.ok)document.getElementById(\'u\').textContent=\'Wrong password (fetch)\';'));
    } else if (ad === 'fetch-ret-gez') {
      html(yanit, 200, fetchSayfasi('/fetch-ret-gez/api', 'history.pushState({},\'\',\'/fetch-ret-gez/home\');'));
    } else if (ad === 'iptal') {
      // SPA rotayı değiştirir, parolalı fetch'i 300 ms sonra iptal eder (sunucu 3 sn sonra 200 verirdi).
      html(yanit, 200, sayfa('Sign in', `${form('/iptal/api')}<script>const f=document.querySelector('form');`
        + 'f.addEventListener(\'submit\',(e)=>{e.preventDefault();const c=new AbortController();'
        + 'history.pushState({},\'\',\'/iptal/home\');'
        + 'fetch(\'/iptal/api\',{method:\'POST\',body:JSON.stringify({k:f.k.value,p:f.p.value}),signal:c.signal})'
        + '.catch(()=>undefined);setTimeout(()=>c.abort(),300);});</script>'));
    } else if (ad === 'yanitsiz') {
      // Giriş isteğinin 401'i karar tavanından (2 sn durulma + 5 sn) sonra gelir.
      html(yanit, 200, fetchSayfasi('/yanitsiz/api', '', 'history.pushState({},\'\',\'/yanitsiz/home\');'));
    } else if (ad === 'yavas-ok') {
      // Sağlıklı yavaş yol: 200 + çerez tavandan önce gelir.
      html(yanit, 200, fetchSayfasi('/yavas-ok/api', '', 'history.pushState({},\'\',\'/yavas-ok/home\');'));
    } else if (ad === 'geciken') {
      // SPA, yanıtı beklemeden rotayı değiştirir; giriş isteğinin 401'i sonra gelir.
      html(yanit, 200, fetchSayfasi('/geciken/api', '', 'history.pushState({},\'\',\'/geciken/home\');'));
    } else if (ad.startsWith('sabit-')) {
      // P2-1: adresi değişmeyen SPA (fetch ile giriş, pushState yok). Ağ hatasında sayfa kendi
      // uyarısını gösterir: bu metin kimlik reddi değildir.
      html(yanit, 200, sabitSayfa(`/${ad}/api`, ad === 'sabit-iptal', ad === 'sabit-cift'));
    } else if (ad === 'sso-basari' || ad === 'sso-cb-hata' || ad === 'sso-mfa') {
      html(yanit, 200, sayfa('Sign in', form(`${sso}/${ad}/idp`)));
    } else if (ad === 'eski-cerez') {
      html(yanit, 200, sayfa('Sign in', form('/eski-cerez/post')), CEREZ);
    } else if (ad === 'bant' || ad === 'bant-422' || ad.startsWith('ayni-')) {
      html(yanit, 200, sayfa('Sign in', form(`/${ad}/login`)));
    } else {
      html(yanit, 200, sayfa('Sign in', form(`/${ad}/post`)));
    }
    return;
  }
  switch (`${istek.method ?? ''} /${ad}/${parca}`) {
    // Rapordaki 4 durum: yanlış parola + 401 formsuz; 200 + bant (kontrol); doğru parola 302 (kontrol).
    case 'POST /p401/post': html(yanit, 401, sayfa('Dashboard', '<p>Unauthorized</p>')); return;
    case 'POST /bant/login':
      html(yanit, 200, sayfa('Sign in', `<div role="alert">Invalid username or password.</div>${form('/bant/login')}`)); return;
    case 'POST /bant-422/login':
      html(yanit, 422, sayfa('Sign in', `<div role="alert">Please check your input.</div>${form('/bant-422/login')}`)); return;
    // Aynı adrese POST (Django/Laravel/Devise varsayılanı), bantlı ya da bantsız hata durumu.
    case 'POST /ayni-500/login': html(yanit, 500, sayfa('Server error')); return;
    case 'POST /ayni-403/login': html(yanit, 403, sayfa('Request blocked')); return;
    case 'POST /ayni-403-bant/login':
      html(yanit, 403, sayfa('Sign in', `<div role="alert">Your account is locked.</div>${form('/ayni-403-bant/login')}`)); return;
    case 'POST /ayni-401/login': html(yanit, 401, sayfa('Sign in', form('/ayni-401/login'))); return;
    case 'POST /dogru/post': yonlendir(yanit, '/', CEREZ); return;
    // 401 → JavaScript yönlendirmesi: çerezli (gerçek oturum) ve çerezsiz (anonim).
    case 'POST /js-oturum/post':
      html(yanit, 401, sayfa('Redirecting', '<script>location.href=\'/\';</script>'), CEREZ); return;
    case 'POST /js-anonim/post': html(yanit, 401, sayfa('Redirecting', '<script>location.href=\'/\';</script>')); return;
    // Başarılı girişten sonra asset ve analitik 403/500.
    case 'POST /varlik/post': yonlendir(yanit, '/varlik/home', CEREZ); return;
    case 'GET /varlik/home':
      html(yanit, 200, sayfa('Home', '<img src="/varlik/a.png"><script>fetch(\'/varlik/analytics\',{method:\'POST\','
        + 'body:\'{"e":"view"}\'});</script>'));
      return;
    case 'GET /varlik/a.png': yanit.writeHead(403); yanit.end(); return;
    case 'POST /varlik/analytics': yanit.writeHead(500); yanit.end(); return;
    // Giriş uç noktasında 403/422/429/500 (URL değişir, formsuz sayfa).
    case 'POST /u403/post': html(yanit, 403, sayfa('Forbidden')); return;
    case 'POST /u422/post': html(yanit, 422, sayfa('Unprocessable')); return;
    case 'POST /u500/post': html(yanit, 500, sayfa('Server error')); return;
    case 'POST /u429/post': html(yanit, 429, sayfa('Too Many Requests'), { 'retry-after': '30' }); return;
    // Eski çerez: giriş sayfası çerezi GET'te koydu; POST 401.
    case 'POST /eski-cerez/post': html(yanit, 401, sayfa('Dashboard')); return;
    // Ağ hatası: giriş isteğinin bağlantısı yanıtsız kopar.
    case 'POST /ag/post': istek.socket.destroy(); return;
    // fetch/XHR.
    case 'POST /fetch-basari/api': yanit.writeHead(200, { 'content-type': 'application/json', ...CEREZ }); yanit.end('{}'); return;
    case 'POST /fetch-ret/api':
    case 'POST /fetch-ret-gez/api': yanit.writeHead(401, { 'content-type': 'application/json' }); yanit.end('{}'); return;
    case 'POST /geciken/api':
      setTimeout(() => { yanit.writeHead(401, { 'content-type': 'application/json' }); yanit.end('{}'); }, 1_500);
      return;
    case 'POST /iptal/api':
      setTimeout(() => { yanit.writeHead(200, { 'content-type': 'application/json', ...CEREZ }); yanit.end('{}'); }, 3_000);
      return;
    case 'GET /iptal/home': html(yanit, 200, sayfa('Home')); return;
    // Kontrol: başarılı girişten sonra parolasız istek iptal edilir.
    case 'POST /iptal-ok/post': yonlendir(yanit, '/iptal-ok/home', CEREZ); return;
    case 'GET /iptal-ok/home':
      html(yanit, 200, sayfa('Home', '<script>const c=new AbortController();'
        + 'fetch(\'/iptal-ok/yavas\',{method:\'POST\',body:\'{"e":"view"}\',signal:c.signal}).catch(()=>undefined);'
        + 'setTimeout(()=>c.abort(),100);</script>'));
      return;
    case 'POST /iptal-ok/yavas':
      setTimeout(() => { yanit.writeHead(200); yanit.end(); }, 3_000);
      return;
    // P2-1: aynı adreste giriş isteği yanıtsız kalır, düşer ya da iptal edilir; kontrol: 401 ve yavaş 200.
    case 'POST /sabit-yanitsiz/api':
      setTimeout(() => { yanit.writeHead(401, { 'content-type': 'application/json' }); yanit.end('{}'); }, SABIT_YANITSIZ_MS);
      return;
    case 'POST /sabit-dustu/api': istek.socket.destroy(); return;
    case 'POST /sabit-iptal/api':
      setTimeout(() => { yanit.writeHead(401, { 'content-type': 'application/json' }); yanit.end('{}'); }, 3_000);
      return;
    // Aynı parolayı taşıyan ikinci istek yanıtsız kalır; ilki 401 alır (yanıt alan ret kazanır).
    case 'POST /sabit-cift/api':
      if (adres.searchParams.has('ikinci')) {
        setTimeout(() => { yanit.writeHead(204); yanit.end(); }, SABIT_YANITSIZ_MS);
        return;
      }
      yanit.writeHead(401, { 'content-type': 'application/json' }); yanit.end('{}');
      return;
    case 'POST /sabit-401/api': yanit.writeHead(401, { 'content-type': 'application/json' }); yanit.end('{}'); return;
    case 'POST /sabit-yavas/api':
      setTimeout(() => { yanit.writeHead(200, { 'content-type': 'application/json', ...CEREZ }); yanit.end('{}'); }, 3_000);
      return;
    case 'POST /yanitsiz/api':
      setTimeout(() => { yanit.writeHead(401, { 'content-type': 'application/json' }); yanit.end('{}'); }, YANITSIZ_MS);
      return;
    case 'POST /yavas-ok/api':
      setTimeout(() => { yanit.writeHead(200, { 'content-type': 'application/json', ...CEREZ }); yanit.end('{}'); }, 3_000);
      return;
    // Karar sonrası ret testi: başarılı form girişi; korumanın `bekle`si içinde parolalı POST 401 alır.
    case 'POST /karar-sonra/api': yanit.writeHead(401); yanit.end(); return;
    case 'GET /yanitsiz/home':
    case 'GET /yavas-ok/home':
    case 'GET /fetch-ret-gez/home':
    case 'GET /geciken/home': html(yanit, 200, sayfa('Home')); return;
    // Çok origin'li SSO: form `localhost` (auth origin) üzerine gönderir.
    case 'POST /sso-basari/idp': yonlendir(yanit, `${app}/sso-basari/cb`); return;
    case 'GET /sso-basari/cb': yonlendir(yanit, '/', CEREZ); return;
    case 'POST /sso-cb-hata/idp': yonlendir(yanit, `${app}/sso-cb-hata/cb`); return;
    case 'GET /sso-cb-hata/cb': html(yanit, 500, sayfa('Callback failed')); return;
    case 'POST /sso-mfa/idp': yonlendir(yanit, `${sso}/sso-mfa/mfa`); return;
    case 'GET /sso-mfa/mfa': html(yanit, 200, sayfa('Enter code', '<form><input name="otp"></form>')); return;
    default:
      yanit.writeHead(404);
      yanit.end();
  }
}

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
    return;
  }
  sunucu = createServer((istek, yanit) => {
    istek.resume();
    istek.on('end', () => { yonet(istek, yanit); });
  });
  port = await new Promise<number>((coz, reddet) => {
    sunucu?.once('error', reddet);
    sunucu?.listen(0, '127.0.0.1', () => {
      const adres = sunucu?.address();
      coz(typeof adres === 'object' && adres !== null ? adres.port : 0);
    });
  });
  app = `http://127.0.0.1:${port}`;
  sso = `http://localhost:${port}`;
});

afterAll(async () => {
  if (sunucu?.listening) await new Promise((coz) => { sunucu?.close(coz); });
});

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium bu ortamda engelli: ${ozet}`);
  return false;
}

interface Kosu {
  exitCode: number;
  mesaj: string;
  loggedIn: unknown;
  harita: boolean;
  oturum: { cookies: Array<{ name: string; value: string }> } | null;
}

async function kos(ad: string, secenek: { sso?: boolean; eskiOturum?: string } = {}): Promise<Kosu & { oturumHam: string | null }> {
  const cwd = await geciciDizinAc('kobay-giris-karari-');
  await projectCreate({
    cwd,
    url: app,
    login: { username: KULLANICI, password: PAROLA },
    loginUrl: `${app}/${ad}/login`,
    ...(secenek.sso === true ? { authOrigins: [sso] } : {}),
    beyin: { adaptor: 'sahte' },
  });
  const oturumYolu = join(cwd, '.kobay', 'storageState.json');
  if (secenek.eskiOturum !== undefined) await writeFile(oturumYolu, secenek.eskiOturum);
  const sonuc = await explore({ cwd, maxSayfa: 2 });
  const haritaYolu = join(cwd, '.kobay', 'map.json');
  const varMi = async (yol: string): Promise<boolean> => access(yol).then(() => true, () => false);
  const json = sonuc.json as { loggedIn?: unknown; error?: { message?: string } } | undefined;
  const oturumHam = await varMi(oturumYolu) ? await readFile(oturumYolu, 'utf8') : null;
  return {
    oturumHam,
    exitCode: sonuc.exitCode,
    mesaj: json?.error?.message ?? JSON.stringify(sonuc.json),
    loggedIn: json?.loggedIn,
    harita: await varMi(haritaYolu),
    oturum: oturumHam === null ? null : JSON.parse(oturumHam) as Kosu['oturum'],
  };
}

const DOGRULANAMADI = 'Login could not be verified';

function dogrulanamadi(kosu: Kosu, durum: number): void {
  expect(kosu.exitCode).toBe(5);
  expect(kosu.loggedIn).toBeUndefined();
  expect(kosu.harita).toBe(false);
  expect(kosu.oturum).toBeNull();
  expect(kosu.mesaj).toContain(DOGRULANAMADI);
  expect(kosu.mesaj).toContain(`HTTP ${durum}`);
  expect(kosu.mesaj).not.toContain(PAROLA);
}

function basarili(kosu: Kosu): void {
  expect(kosu.exitCode).toBe(0);
  expect(kosu.loggedIn).toBe(true);
  expect(kosu.harita).toBe(true);
  expect(kosu.oturum?.cookies.map((c) => `${c.name}=${c.value}`)).toContain('sid=ok');
}

function reddedildi(kosu: Kosu, metin: string): void {
  expect(kosu.exitCode).toBe(5);
  expect(kosu.loggedIn).toBeUndefined();
  expect(kosu.harita).toBe(false);
  expect(kosu.oturum).toBeNull();
  expect(kosu.mesaj).toContain('Login failed; check the username, the password, and the login URL');
  expect(kosu.mesaj).toContain(metin);
}

describe('0.9.2 B: giriş kararı (gerçek CLI, gerçek Chromium)', { timeout: 60_000 }, () => {
  it('yanlış parola + 401 formsuz sayfa: doğrulanamadı, oturum yok', async (context) => {
    if (!tarayiciMumkun(context)) return;
    dogrulanamadi(await kos('p401'), 401);
  });

  it('kontrol: 200 + aynı URL + hata bandı reddi eski mesajla biter', async (context) => {
    if (!tarayiciMumkun(context)) return;
    reddedildi(await kos('bant'), 'Invalid username or password.');
  });

  it('kontrol: 422 + aynı URL + doğrulama bandı reddi eski mesajla biter (4xx gerekçeyi örtmez)', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos('bant-422');
    reddedildi(kosu, 'Please check your input.');
    expect(kosu.mesaj).not.toContain(DOGRULANAMADI);
  });

  it('kontrol: doğru parola, 302 → / başarılı, oturum kaydedilir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    basarili(await kos('dogru'));
  });

  it('401 → JavaScript yönlendirmesi (çerezli): muhafazakâr olarak doğrulanamadı', async (context) => {
    if (!tarayiciMumkun(context)) return;
    dogrulanamadi(await kos('js-oturum'), 401);
  });

  it('401 → JavaScript yönlendirmesi (anonim sayfa): doğrulanamadı', async (context) => {
    if (!tarayiciMumkun(context)) return;
    dogrulanamadi(await kos('js-anonim'), 401);
  });

  it('başarılı girişten sonra asset 403 ve analitik 500 karara girmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    basarili(await kos('varlik'));
  });

  it.each([[403, 'u403'], [422, 'u422'], [500, 'u500']])('giriş uç noktası %i (URL değişti): doğrulanamadı', async (durum, ad, context) => {
    if (!tarayiciMumkun(context)) return;
    dogrulanamadi(await kos(ad), durum);
  });

  it('giriş uç noktası 429: hız sınırı mesajı korunur', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos('u429');
    expect(kosu.exitCode).toBe(5);
    expect(kosu.harita).toBe(false);
    expect(kosu.oturum).toBeNull();
    expect(kosu.mesaj).toContain('HTTP 429');
    expect(kosu.mesaj).toContain('Wait about 30 s');
    expect(kosu.mesaj).not.toContain(DOGRULANAMADI);
  });

  // Bilinen sınır (README "Login compatibility"): 2xx/3xx ile biten zincir parola formlu sayfaya
  // inerse ret sayılmaz, çünkü zorunlu parola değiştirme sayfası da böyledir (test/kos/oturum-tazele
  // "tur 3", "B2"). Uygulama bilgisi olmadan ikisi ayrılamaz.
  it.todo('302 → girişe dönüş (/login?error, 200 + form): uygulama bilgisi olmadan ret sayılamaz');

  it('eski çerez (giriş sayfası GET\'te koydu) + 401: doğrulanamadı, çerez kaydedilmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    dogrulanamadi(await kos('eski-cerez'), 401);
  });

  it('ağ hatası: giriş isteği yanıtsız koparsa giriş başarılı sayılmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos('ag');
    expect(kosu.exitCode).toBe(5);
    expect(kosu.loggedIn).toBeUndefined();
    expect(kosu.harita).toBe(false);
    expect(kosu.oturum).toBeNull();
  });

  it('fetch başarı (aynı URL, 200 + çerez, sonra yönlendirme): başarılı', async (context) => {
    if (!tarayiciMumkun(context)) return;
    basarili(await kos('fetch-basari'));
  });

  it('fetch ret (aynı URL, 401 + bant): eski ret mesajı', async (context) => {
    if (!tarayiciMumkun(context)) return;
    reddedildi(await kos('fetch-ret'), 'Wrong password (fetch)');
  });

  it('fetch 401 + SPA rotası yine de değişir: doğrulanamadı', async (context) => {
    if (!tarayiciMumkun(context)) return;
    dogrulanamadi(await kos('fetch-ret-gez'), 401);
  });

  it('geciken yanıt: rota hemen değişir, giriş isteğinin 401\'i 1,5 sn sonra gelir: doğrulanamadı', async (context) => {
    if (!tarayiciMumkun(context)) return;
    dogrulanamadi(await kos('geciken'), 401);
  });

  it('SSO başarı (auth origin → 302 callback → /): başarılı', async (context) => {
    if (!tarayiciMumkun(context)) return;
    basarili(await kos('sso-basari', { sso: true }));
  });

  it('SSO callback hatası (zincirin son ayağı 500): doğrulanamadı', async (context) => {
    if (!tarayiciMumkun(context)) return;
    dogrulanamadi(await kos('sso-cb-hata', { sso: true }), 500);
  });

  it('test refresh: yeniden giriş 401 + formsuz sayfa: LoginNotVerifiedError, eski oturum dosyası bayt bayt kalır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const dizin = await geciciDizinAc('kobay-giris-karari-yenile-');
    const storageStateYolu = join(dizin, 'storage.json');
    await writeFile(storageStateYolu, ESKI_OTURUM);
    const hata = await sayfayiYenile({
      baseUrl: app,
      url: '/korumali',
      storageStateYolu,
      loginUrl: `${app}/p401/login`,
      kimlik: { username: KULLANICI, password: PAROLA, origin: app },
    }).then(() => null, (e: unknown) => e);
    expect(hata).toBeInstanceOf(LoginNotVerifiedError);
    expect((hata as Error).message).toContain(`${DOGRULANAMADI}: the login request got HTTP 401`);
    expect(ozet(await readFile(storageStateYolu, 'utf8'))).toBe(ozet(ESKI_OTURUM));
  });

  it('eski oturum + giriş 500 (doğrulanamadı): yeni oturum yazılmaz, eski dosya bayt bayt kalır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos('u500', { eskiOturum: ESKI_OTURUM });
    expect(kosu.exitCode).toBe(5);
    expect(kosu.mesaj).toContain(`${DOGRULANAMADI}: the login request got HTTP 500`);
    expect(kosu.harita).toBe(false);
    expect(kosu.oturumHam).not.toBeNull();
    expect(ozet(kosu.oturumHam ?? '')).toBe(ozet(ESKI_OTURUM));
  });

  it.each([[500, 'ayni-500'], [403, 'ayni-403']])('aynı adrese POST + %i, bantsız, eski oturum: doğrulanamadı, eski dosya bayt bayt kalır', async (durum, ad, context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos(ad, { eskiOturum: ESKI_OTURUM });
    expect(kosu.exitCode).toBe(5);
    expect(kosu.mesaj).toContain(`${DOGRULANAMADI}: the login request got HTTP ${durum}`);
    expect(kosu.mesaj).not.toContain('Login failed');
    expect(kosu.harita).toBe(false);
    expect(ozet(kosu.oturumHam ?? '')).toBe(ozet(ESKI_OTURUM));
  });

  it('kontrol: aynı adrese POST + 403 bantlı, eski oturum: kesin ret, eski dosya silinir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    reddedildi(await kos('ayni-403-bant', { eskiOturum: ESKI_OTURUM }), 'Your account is locked.');
  });

  it('kontrol: aynı adrese POST + 401 bantsız, eski oturum: kesin ret, eski dosya silinir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos('ayni-401', { eskiOturum: ESKI_OTURUM });
    expect(kosu.exitCode).toBe(5);
    expect(kosu.mesaj).toBe('Login failed; check the username, the password, and the login URL');
    expect(kosu.oturum).toBeNull();
  });

  it('kontrol: eski oturum + kesin ret (200 + bant): eski dosya silinir (davranış değişmedi)', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos('bant', { eskiOturum: ESKI_OTURUM });
    reddedildi(kosu, 'Invalid username or password.');
  });

  it('karar tavanında giriş isteği hâlâ yanıtsız (401 sonra gelir): doğrulanamadı, oturum yok', { timeout: 90_000 }, async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos('yanitsiz');
    expect(kosu.exitCode).toBe(5);
    expect(kosu.loggedIn).toBeUndefined();
    expect(kosu.harita).toBe(false);
    expect(kosu.oturum).toBeNull();
    expect(kosu.mesaj).toContain(`${DOGRULANAMADI}: the login request got no usable response`);
  });

  it('SPA rota değiştirir, parolalı giriş isteği iptal edilir: doğrulanamadı, oturum yok', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos('iptal');
    expect(kosu.exitCode).toBe(5);
    expect(kosu.loggedIn).toBeUndefined();
    expect(kosu.harita).toBe(false);
    expect(kosu.oturum).toBeNull();
    expect(kosu.mesaj).toContain(`${DOGRULANAMADI}: the login request got no usable response`);
  });

  it('kontrol: başarılı girişten sonra iptal edilen parolasız istek sonucu değiştirmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    basarili(await kos('iptal-ok'));
  });

  it('sağlıklı yavaş yol: giriş isteği 200 + çerezi tavandan önce (3 sn) alır: başarı korunur', async (context) => {
    if (!tarayiciMumkun(context)) return;
    basarili(await kos('yavas-ok'));
  });

  it('iç karar hesaplandıktan sonra gelen ret de başarıyı kapatır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const tarayici = await chromium.launch({ headless: true });
    try {
      const baglam = await tarayici.newContext({ serviceWorkers: 'block' });
      const kimlik = { username: KULLANICI, password: PAROLA, origin: app };
      const sekme = await baglam.newPage();
      const koruma = await girisKorumasiKur(baglam, kimlik, [app]);
      // `bekle` iç kararda `girisBasarili` hesaplandıktan sonra çağrılır: ret yanıtı tam o anda verilir.
      const asil = koruma.bekle.bind(koruma);
      let tetiklendi = false;
      koruma.bekle = async () => {
        if (!tetiklendi) {
          tetiklendi = true;
          const durum = await sekme.evaluate(async (p) => (await fetch('/karar-sonra/api', { method: 'POST', body: p })).status, PAROLA);
          expect(durum).toBe(401);
        }
        await asil();
      };
      await sekme.goto(`${app}/dogru/login`, { waitUntil: 'domcontentloaded' });
      const giris = await girisFormuBul(sekme);
      if (giris === null) throw new Error('form yok');
      const sonuc = await girisiGonder(sekme, giris, kimlik, app, [], 1_000, 1_000, 5_000);
      expect(tetiklendi).toBe(true);
      expect(sonuc).toEqual({ basarili: false, dogrulanamadi: { durum: 401 } });
    } finally {
      await tarayici.close();
    }
  });

  // P2-1: adres değişmeyen SPA'da (fetch ile giriş, pushState yok) yanıt almayan giriş isteği kimlik
  // reddi kanıtı değildir: doğrulanamadı, eski oturum dosyası bayt bayt kalır. Sayfanın ağ hatası
  // uyarısı ret gerekçesi sayılmaz.
  it.each([
    ['karar tavanında hâlâ yanıtsız', 'sabit-yanitsiz'],
    ['bağlantı yanıtsız düşer', 'sabit-dustu'],
    ['SPA parolalı isteği iptal eder', 'sabit-iptal'],
  ])('P2-1: aynı adres + giriş isteği %s: doğrulanamadı, eski oturum bayt bayt kalır', { timeout: 90_000 }, async (_ad, ad, context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos(ad, { eskiOturum: ESKI_OTURUM });
    expect(kosu.exitCode).toBe(5);
    expect(kosu.mesaj).toContain(`${DOGRULANAMADI}: the login request got no usable response`);
    expect(kosu.mesaj).not.toContain('Login failed');
    expect(kosu.mesaj).not.toContain('Network error');
    expect(kosu.mesaj).not.toContain(PAROLA);
    expect(kosu.loggedIn).toBeUndefined();
    expect(kosu.harita).toBe(false);
    expect(kosu.oturumHam).not.toBeNull();
    expect(ozet(kosu.oturumHam ?? '')).toBe(ozet(ESKI_OTURUM));
  });

  it('P2-1 kontrol: aynı adres + 401 yanıtı + bant, eski oturum: kesin ret, eski dosya silinir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos('sabit-401', { eskiOturum: ESKI_OTURUM });
    reddedildi(kosu, 'Invalid username or password.');
    expect(kosu.mesaj).not.toContain(DOGRULANAMADI);
  });

  it('P2-1 kontrol: aynı adres, bir giriş isteği 401 aldı, parolalı ikinci istek yanıtsız: kesin ret (yanıt alan kazanır)', { timeout: 90_000 }, async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos('sabit-cift', { eskiOturum: ESKI_OTURUM });
    reddedildi(kosu, 'Invalid username or password.');
    expect(kosu.mesaj).not.toContain(DOGRULANAMADI);
  });

  it('P2-1 kontrol: aynı adres + sağlıklı yavaş 200 (3 sn): başarılı, oturum yazılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    basarili(await kos('sabit-yavas', { eskiOturum: ESKI_OTURUM }));
  });

  it.todo('SSO girişe dönüş (callback yerine uygulamanın /login?error sayfası, 200): yukarıdaki sınırla aynı');

  it('SSO bitmemiş MFA (auth origin\'de kalır): uygulamaya dönmedi, oturum yok', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const kosu = await kos('sso-mfa', { sso: true });
    expect(kosu.exitCode).toBe(5);
    expect(kosu.harita).toBe(false);
    expect(kosu.oturum).toBeNull();
    expect(kosu.mesaj).toContain('Login did not return to the app origin');
  });
});
