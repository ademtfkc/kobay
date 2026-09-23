// Kobay bütünleşme testleri için bağımlılıksız, bellekte çalışan demo uygulaması.
// Doğrudan çalıştırma: node test/kobay-demo/sunucu.mjs <port>
// Testler baslat(port) ile sunucuyu programatik olarak açıp kapatabilir.
import { createServer } from 'node:http';

const varsayilanKayitlar = [
  { ad: 'Birinci kayıt', tutar: '10' },
  { ad: 'İkinci kayıt', tutar: '20' },
  { ad: 'Üçüncü kayıt', tutar: '30' },
];

function girisVar(istek) {
  return istek.headers.cookie?.split(';').some((cerez) => cerez.trim() === 'oturum=demo') ?? false;
}

function yonlendir(yanit, yol) {
  yanit.writeHead(302, { Location: yol });
  yanit.end();
}

function html(yanit, icerik) {
  const baslik = /<h1>(.*?)<\/h1>/.exec(icerik)?.[1] ?? 'Kobay Demo';
  yanit.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  yanit.end(`<!doctype html><html lang="tr"><head><title>${baslik}</title></head><body>${icerik}</body></html>`);
}

function menu() {
  return '<nav><a href="/liste">Liste</a><a href="/yeni">Yeni Kayıt</a><a href="/cikis">Çıkış</a></nav>';
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

    if (url.pathname === '/giris' && istek.method === 'GET') {
      html(yanit, '<h1>Giriş</h1><form action="/giris" method="post"><label>Kullanıcı <input name="kullanici" type="text"></label><label>Parola <input name="parola" type="password"></label><button type="submit">Giriş yap</button></form>');
      return;
    }
    if (url.pathname === '/giris' && istek.method === 'POST') {
      const form = await govdeOku(istek);
      if (form.get('kullanici') === 'demo' && form.get('parola') === 'demo123') {
        yanit.writeHead(302, { Location: '/', 'Set-Cookie': 'oturum=demo; Path=/; HttpOnly' });
        yanit.end();
      } else {
        html(yanit, '<h1>Giriş</h1><p>Giriş bilgileri hatalı</p><form action="/giris" method="post"><label>Kullanıcı <input name="kullanici" type="text"></label><label>Parola <input name="parola" type="password"></label><button type="submit">Giriş yap</button></form>');
      }
      return;
    }
    if (!girisli) return yonlendir(yanit, '/giris');
    if (url.pathname === '/') {
      html(yanit, `${menu()}<h1>Kontrol Paneli</h1><p>Demo uygulamasına hoş geldiniz.</p>`);
      return;
    }
    if (url.pathname === '/liste' && istek.method === 'GET') {
      const satirlar = kayitlar.map((kayit, sira) => `<tr><td>${kayit.ad}</td><td>${kayit.tutar}</td><td><form action="/liste/sil" method="post"><input type="hidden" name="sira" value="${sira}"><button type="submit">Sil</button></form></td></tr>`).join('');
      html(yanit, `${menu()}<h1>Kayıt Listesi</h1><table><thead><tr><th>Ad</th><th>Tutar</th><th>İşlem</th></tr></thead><tbody>${satirlar}</tbody></table>`);
      return;
    }
    if (url.pathname === '/liste/sil' && istek.method === 'POST') {
      const form = await govdeOku(istek);
      const sira = Number(form.get('sira'));
      if (Number.isInteger(sira)) kayitlar.splice(sira, 1);
      return yonlendir(yanit, '/liste');
    }
    if (url.pathname === '/yeni' && istek.method === 'GET') {
      html(yanit, `${menu()}<h1>Yeni Kayıt</h1><form action="/yeni" method="post"><label>Ad <input name="ad" type="text" placeholder="Kayıt adı"></label><label>Tutar <input name="tutar" type="number"></label><button type="submit">Kaydet</button></form>`);
      return;
    }
    if (url.pathname === '/yeni' && istek.method === 'POST') {
      const form = await govdeOku(istek);
      kayitlar.push({ ad: String(form.get('ad') ?? ''), tutar: String(form.get('tutar') ?? '') });
      return yonlendir(yanit, '/liste');
    }
    if (url.pathname === '/cikis') {
      yanit.writeHead(302, { Location: '/giris', 'Set-Cookie': 'oturum=; Path=/; Max-Age=0' });
      yanit.end();
      return;
    }
    yanit.writeHead(404);
    yanit.end('Bulunamadı');
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
