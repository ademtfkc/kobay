import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import {
  CredentialLeakBlockedError,
  girisFormuBul,
  girisiGonder,
  LoginDidNotReturnError,
} from '../../src/kesif/index.js';

/**
 * Karar 6 (giriş sonunda `baseUrl` origin'ine dönüş), gerçek Chromium ile ve kısa dönüş
 * süresiyle doğrudan `girisiGonder` üzerinden. Uygulama `127.0.0.1`, auth sitesi `localhost`,
 * üçüncü origin `kotu.localhost` (üçü de 127.0.0.1'de dinler, üçü ayrı site).
 */

const PAROLA = 'donus-parola-123';
const DONUS_MS = 1_000;
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;
let tarayici: Browser | undefined;
const sunucular: Server[] = [];
let appOrigin = '';
let authOrigin = '';
let ucuncuOrigin = '';

function html(icerik: string): string {
  return `<!doctype html><html><body>${icerik}</body></html>`;
}

const FORM = '<form action="/giris" method="post"><input type="text" name="k"><input type="password" name="p">'
  + '<button type="submit">Log in</button></form>';

async function dinle(isle: (yol: string, yontem: string) => { kod: number; basliklar?: Record<string, string>; govde?: string }): Promise<number> {
  const sunucu = createServer((istek, yanit) => {
    istek.resume();
    istek.on('end', () => {
      const cevap = isle(new URL(istek.url ?? '/', 'http://x').pathname, istek.method ?? 'GET');
      yanit.writeHead(cevap.kod, { 'content-type': 'text/html', ...cevap.basliklar });
      yanit.end(cevap.govde ?? '');
    });
  });
  sunucular.push(sunucu);
  return new Promise((coz, reddet) => {
    const hata = (neden: Error): void => { reddet(neden); };
    sunucu.once('error', hata);
    sunucu.listen(0, '127.0.0.1', () => {
      sunucu.off('error', hata);
      const adres = sunucu.address();
      coz(typeof adres === 'object' && adres !== null ? adres.port : 0);
    });
  });
}

beforeAll(async () => {
  try {
    tarayici = await chromium.launch({ headless: true });
  } catch (hata) {
    tarayiciEngeli = hata;
    return;
  }
  try {
    ucuncuOrigin = `http://kotu.localhost:${await dinle(() => ({ kod: 200, govde: html('<h1>Elsewhere</h1>') }))}`;
    appOrigin = `http://127.0.0.1:${await dinle((yol, yontem) => {
      // Liste boş: giriş uygulamada, ama başarı sonrası üçüncü origin'e yönlendirir.
      if (yol === '/giris' && yontem === 'POST') return { kod: 302, basliklar: { location: `${ucuncuOrigin}/hos-geldin` } };
      // SSO dönüşü uygulamaya iner, ardından gecikmeli JavaScript yönlendirmesiyle üçüncü origin'e kaçar.
      if (yol === '/donus-kacak') {
        return { kod: 200, govde: html(`<h1>Back</h1><script>setTimeout(()=>{location.href=${JSON.stringify(`${ucuncuOrigin}/kacak`)};},300);</script>`) };
      }
      if (yol === '/login') return { kod: 200, govde: html(FORM) };
      return { kod: 200, govde: html('<h1>App</h1>') };
    })}`;
    authOrigin = `http://localhost:${await dinle((yol, yontem) => {
      if (yol === '/ucuncu/giris' && yontem === 'POST') return { kod: 302, basliklar: { location: `${ucuncuOrigin}/sso-son` } };
      // Bir süre auth sitesinde "yönlendiriliyor" sayfası, sonra uygulamaya dönüş.
      if (yol === '/gecikmeli/giris' && yontem === 'POST') {
        return { kod: 200, govde: html(`<p>Redirecting</p><script>setTimeout(()=>{location.href=${JSON.stringify(`${appOrigin}/donus-kacak`)};},1500);</script>`) };
      }
      if (yol.endsWith('/login')) return { kod: 200, govde: html(FORM.replace('action="/giris"', `action="${yol.replace('/login', '/giris')}"`)) };
      return { kod: 404 };
    })}`;
  } catch (hata) {
    tarayiciEngeli = hata;
  }
});

afterAll(async () => {
  await tarayici?.close();
  await Promise.all(sunucular.filter((sunucu) => sunucu.listening)
    .map((sunucu) => new Promise((coz) => { sunucu.close(coz); })));
});

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium bu ortamda engelli: ${ozet}`);
  return false;
}

/** Verilen giriş sayfasında girişi dener; `girisiGonder`in fırlattığını (ya da sonucu) döner. */
async function girisDene(loginUrl: string, authOrigins: string[], donusMs = DONUS_MS): Promise<unknown> {
  if (tarayici === undefined) throw new Error('tarayıcı yok');
  const context = await tarayici.newContext({ serviceWorkers: 'block' });
  try {
    const sayfa = await context.newPage();
    await sayfa.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    const form = await girisFormuBul(sayfa);
    if (form === null) throw new Error('form yok');
    const kimlik = { username: 'demo', password: PAROLA, origin: appOrigin, ...(authOrigins.length === 0 ? {} : { authOrigins }) };
    return await girisiGonder(sayfa, form, kimlik, appOrigin, authOrigins, 5_000, donusMs)
      .then((sonuc) => sonuc, (hata: unknown) => hata);
  } finally {
    await context.close();
  }
}

describe('giriş sonunda uygulamanın origin\'ine dönüş şartı (karar 6)', () => {
  it('auth origin listesi boşken yabancı origin\'e inen giriş LoginDidNotReturnError', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene(`${appOrigin}/login`, []);
    expect(sonuc).toBeInstanceOf(LoginDidNotReturnError);
    expect(String(sonuc)).toContain(`ended on ${ucuncuOrigin}, expected ${appOrigin}`);
  });

  it('auth sitesi uygulama yerine üçüncü bir origin\'e yönlendirirse LoginDidNotReturnError', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const sonuc = await girisDene(`${authOrigin}/ucuncu/login`, [authOrigin]);
    expect(sonuc).toBeInstanceOf(LoginDidNotReturnError);
    expect(String(sonuc)).toContain(`ended on ${ucuncuOrigin}`);
  });

  it('uygulamaya döndükten sonra gecikmeli yabancı navigasyon kesilir ve origin adıyla reddedilir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    // Dönüş süresi auth sitesindeki 1,5 sn beklemeden uzun: dönüş gerçekleşir, sonra kaçış olur.
    const sonuc = await girisDene(`${authOrigin}/gecikmeli/login`, [authOrigin], 5_000);
    expect(sonuc).toBeInstanceOf(CredentialLeakBlockedError);
    expect(String(sonuc)).toContain(`blocked 1 cross-origin document load during login: ${ucuncuOrigin}`);
    expect(String(sonuc)).not.toContain('ended on null');
  });
});
