// Kobay bütünleşme testleri için bağımlılıksız, bellekte çalışan demo uygulaması.
// Kullanıcıya görünen her metin İngilizcedir; kod ve yorumlar depo diliyle Türkçedir.
// Doğrudan çalıştırma: node test/kobay-demo/sunucu.mjs <port> [--sso <authUrl> | --auth-for <appUrl>]
// Testler baslat(port) ile sunucuyu programatik olarak açıp kapatabilir.
//
// Ayrı giriş sitesi (SSO) kipi, iki sunucu:
// - Uygulama: baslat(port, { sso: authUrl }) — girişsiz istek auth sunucusunun /login'ine
//   yönlenir; /sso-callback?token=… oturum çerezini kurar ve / sayfasına döner.
// - Auth: baslatAuth(port, { appUrl }) — giriş formunu sunar, başarıda appUrl/sso-callback'e
//   yönlendirir. `donmez: true` ise uygulamaya dönmez, auth sitesinde /welcome'da kalır.
// Aynı siteyi aşmak için uygulama 127.0.0.1, auth localhost adıyla kullanılır (ikisi de
// 127.0.0.1'de dinler; localhost ile 127.0.0.1 farklı sitelerdir).
import { createServer } from 'node:http';

const varsayilanKayitlar = [
  { ad: 'First record', tutar: '10' },
  { ad: 'Second record', tutar: '20' },
  { ad: 'Third record', tutar: '30' },
];

function girisVar(istek) {
  return istek.headers.cookie?.split(';').some((cerez) => cerez.trim() === 'session=demo') ?? false;
}

function yonlendir(yanit, yol) {
  yanit.writeHead(302, { Location: yol });
  yanit.end();
}

function html(yanit, icerik) {
  const baslik = /<h1>(.*?)<\/h1>/.exec(icerik)?.[1] ?? 'Kobay Demo';
  yanit.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  yanit.end(`<!doctype html><html lang="en"><head><title>${baslik}</title></head><body>${icerik}</body></html>`);
}

function menu() {
  return '<nav><a href="/records">Records</a><a href="/new">New Record</a><a href="/logout">Logout</a></nav>';
}

function girisFormu() {
  return '<form action="/login" method="post"><label>Username <input name="username" type="text"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>';
}

/** SSO geri dönüşünde taşınan sabit belirteç; yalnız demo içindir. */
export const SSO_BELIRTECI = 'demo-sso-token';

function govdeOku(istek) {
  return new Promise((coz) => {
    let veri = '';
    istek.setEncoding('utf8');
    istek.on('data', (parca) => { veri += parca; });
    istek.on('end', () => coz(new URLSearchParams(veri)));
  });
}

/** Bellekte tutulan en çok istek kaydı; uzun süre açık kalan demo sunucusu belleği şişirmesin. */
export const EN_COK_ISTEK_KAYDI = 200;

/**
 * Gelen isteği (yöntem, yol, gövde) kaydeder; testler parolanın nereye gittiğine bakar.
 * En çok `EN_COK_ISTEK_KAYDI` kayıt tutulur, eskisi düşer (dizi yerinde kırpılır, başvuru aynı kalır).
 */
function kaydet(istekler, istek, govde = '') {
  istekler.push({ method: istek.method ?? '', path: istek.url ?? '', body: govde });
  if (istekler.length > EN_COK_ISTEK_KAYDI) istekler.splice(0, istekler.length - EN_COK_ISTEK_KAYDI);
}

function dinlet(sunucu, port, istekler) {
  return new Promise((coz, reddet) => {
    sunucu.once('error', reddet);
    sunucu.listen(port, '127.0.0.1', () => {
      sunucu.off('error', reddet);
      const adres = sunucu.address();
      if (adres === null || typeof adres === 'string') throw new Error('Sunucu adresi alınamadı');
      coz({
        url: `http://127.0.0.1:${adres.port}`,
        port: adres.port,
        istekler,
        kapat: () => new Promise((kapat) => sunucu.close(() => kapat())),
      });
    });
  });
}

/**
 * Ayrı giriş sitesi (SSO) kipi: demo / demo123 ile giriş, başarıda `appUrl/sso-callback`'e döner.
 * `donmez: true` ise giriş auth sitesinde biter (uygulamaya dönmeyen akış).
 */
export function baslatAuth(port, { appUrl, donmez = false }) {
  const istekler = [];
  const sunucu = createServer(async (istek, yanit) => {
    const url = new URL(istek.url ?? '/', 'http://localhost');
    if (url.pathname === '/login' && istek.method === 'POST') {
      const ham = await new Promise((coz) => {
        let veri = '';
        istek.setEncoding('utf8');
        istek.on('data', (parca) => { veri += parca; });
        istek.on('end', () => coz(veri));
      });
      kaydet(istekler, istek, ham);
      const form = new URLSearchParams(ham);
      if (form.get('username') === 'demo' && form.get('password') === 'demo123') {
        const hedef = donmez ? '/welcome' : `${appUrl}/sso-callback?token=${SSO_BELIRTECI}`;
        yanit.writeHead(302, { Location: hedef, 'Set-Cookie': 'auth_session=1; Path=/; HttpOnly' });
        yanit.end();
      } else {
        html(yanit, `<h1>Sign in</h1><p>Invalid username or password</p>${girisFormu()}`);
      }
      return;
    }
    kaydet(istekler, istek);
    if (url.pathname === '/login') {
      html(yanit, `<h1>Sign in</h1>${girisFormu()}`);
      return;
    }
    if (url.pathname === '/welcome') {
      html(yanit, '<h1>Signed in</h1><p>You are signed in to the auth site.</p>');
      return;
    }
    yanit.writeHead(404);
    yanit.end('Not found');
  });
  return dinlet(sunucu, port, istekler);
}

export function baslat(port, { sso } = {}) {
  const kayitlar = varsayilanKayitlar.map((kayit) => ({ ...kayit }));
  const istekler = [];
  const sunucu = createServer(async (istek, yanit) => {
    const url = new URL(istek.url ?? '/', 'http://localhost');
    const girisli = girisVar(istek);
    kaydet(istekler, istek);

    if (sso !== undefined) {
      // SSO kipi: giriş auth sitesinde; uygulama yalnız geri dönüşü karşılar.
      if (url.pathname === '/sso-callback') {
        if (url.searchParams.get('token') !== SSO_BELIRTECI) {
          yanit.writeHead(403);
          yanit.end('Invalid token');
          return;
        }
        yanit.writeHead(302, { Location: '/', 'Set-Cookie': 'session=demo; Path=/; HttpOnly' });
        yanit.end();
        return;
      }
      if (url.pathname === '/login' || (!girisli && url.pathname !== '/logout')) {
        return yonlendir(yanit, `${sso}/login`);
      }
    }

    if (url.pathname === '/login' && istek.method === 'GET') {
      html(yanit, `<h1>Login</h1>${girisFormu()}`);
      return;
    }
    if (url.pathname === '/login' && istek.method === 'POST') {
      const form = await govdeOku(istek);
      if (form.get('username') === 'demo' && form.get('password') === 'demo123') {
        yanit.writeHead(302, { Location: '/', 'Set-Cookie': 'session=demo; Path=/; HttpOnly' });
        yanit.end();
      } else {
        html(yanit, `<h1>Login</h1><p>Invalid username or password</p>${girisFormu()}`);
      }
      return;
    }
    if (!girisli) return yonlendir(yanit, '/login');
    if (url.pathname === '/') {
      html(yanit, `${menu()}<h1>Dashboard</h1><p>Welcome to the demo application.</p>`);
      return;
    }
    if (url.pathname === '/records' && istek.method === 'GET') {
      const satirlar = kayitlar.map((kayit, sira) => `<tr><td>${kayit.ad}</td><td>${kayit.tutar}</td><td><form action="/records/delete" method="post"><input type="hidden" name="index" value="${sira}"><button type="submit">Delete</button></form></td></tr>`).join('');
      html(yanit, `${menu()}<h1>Record List</h1><table><thead><tr><th>Name</th><th>Amount</th><th>Action</th></tr></thead><tbody>${satirlar}</tbody></table>`);
      return;
    }
    if (url.pathname === '/records/delete' && istek.method === 'POST') {
      const form = await govdeOku(istek);
      const sira = Number(form.get('index'));
      if (Number.isInteger(sira)) kayitlar.splice(sira, 1);
      return yonlendir(yanit, '/records');
    }
    if (url.pathname === '/new' && istek.method === 'GET') {
      html(yanit, `${menu()}<h1>New Record</h1><form action="/new" method="post"><label>Name <input name="name" type="text" placeholder="Record name"></label><label>Amount <input name="amount" type="number"></label><button type="submit">Save</button></form>`);
      return;
    }
    if (url.pathname === '/new' && istek.method === 'POST') {
      const form = await govdeOku(istek);
      kayitlar.push({ ad: String(form.get('name') ?? ''), tutar: String(form.get('amount') ?? '') });
      return yonlendir(yanit, '/records');
    }
    if (url.pathname === '/logout') {
      yanit.writeHead(302, { Location: '/login', 'Set-Cookie': 'session=; Path=/; Max-Age=0' });
      yanit.end();
      return;
    }
    yanit.writeHead(404);
    yanit.end('Not found');
  });

  return dinlet(sunucu, port, istekler);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port)) throw new Error('Port zorunludur');
  const secenek = (ad) => {
    const sira = process.argv.indexOf(ad);
    return sira < 0 ? undefined : process.argv[sira + 1];
  };
  const authIcin = secenek('--auth-for');
  const sso = secenek('--sso');
  if (authIcin !== undefined) await baslatAuth(port, { appUrl: authIcin });
  else await baslat(port, sso === undefined ? {} : { sso });
}
