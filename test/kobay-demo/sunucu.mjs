// Kobay bütünleşme testleri için bağımlılıksız, bellekte çalışan demo uygulaması.
// Kullanıcıya görünen her metin İngilizcedir; kod ve yorumlar depo diliyle Türkçedir.
// Doğrudan çalıştırma: node test/kobay-demo/sunucu.mjs <port>
// Testler baslat(port) ile sunucuyu programatik olarak açıp kapatabilir.
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

function govdeOku(istek) {
  return new Promise((coz) => {
    let veri = '';
    istek.setEncoding('utf8');
    istek.on('data', (parca) => { veri += parca; });
    istek.on('end', () => coz(new URLSearchParams(veri)));
  });
}

export function baslat(port) {
  const kayitlar = varsayilanKayitlar.map((kayit) => ({ ...kayit }));
  const sunucu = createServer(async (istek, yanit) => {
    const url = new URL(istek.url ?? '/', 'http://localhost');
    const girisli = girisVar(istek);

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

  return new Promise((coz, reddet) => {
    sunucu.once('error', reddet);
    sunucu.listen(port, '127.0.0.1', () => {
      sunucu.off('error', reddet);
      const adres = sunucu.address();
      if (adres === null || typeof adres === 'string') throw new Error('Sunucu adresi alınamadı');
      coz({
        url: `http://127.0.0.1:${adres.port}`,
        kapat: () => new Promise((kapat) => sunucu.close(() => kapat())),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port)) throw new Error('Port zorunludur');
  await baslat(port);
}
