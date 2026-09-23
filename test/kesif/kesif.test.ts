import { createServer, type Server } from 'node:http';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { girisFormuBul, kesfet } from '../../src/kesif/index.js';
import { baslat } from '../kobay-demo/sunucu.mjs';

let demo: { url: string; kapat: () => Promise<void> };
let e2eEngeli: unknown;
let tarayiciEngeli: unknown;

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
  }
  try {
    demo = await baslat(0);
  } catch (hata) {
    e2eEngeli = hata;
  }
});
afterAll(async () => { if (demo) await demo.kapat(); });

async function geciciDizin(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kobay-kesif-'));
}

/** KOBAY_TEST_KATI=1 verildiğinde atlama yasak: engel hata sayılır. */
const kati = process.env.KOBAY_TEST_KATI === '1';

function engelleAtla(context: TestContext, engel: unknown, baslik: string): false {
  const ozet = String(engel).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_KATI=1: ${baslik} atlanamaz: ${ozet}`);
  context.skip(`${baslik}: ${ozet}`);
  return false;
}

function e2eMumkun(context: TestContext): boolean {
  const engel = tarayiciEngeli ?? e2eEngeli;
  if (!engel) return true;
  return engelleAtla(context, engel, 'Gerçek Chromium E2E bu ortamda engelli');
}

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  return engelleAtla(context, tarayiciEngeli, 'Gerçek Chromium bu ortamda engelli');
}

describe('kesfet', () => {
  it('farklı origin loginUrl ile kimlik göndermeden reddeder', async () => {
    const dizin = await geciciDizin();
    await expect(kesfet({
      baseUrl: 'http://uygulama.test',
      loginUrl: 'https://kimlik.test/giris',
      kimlik: { kullanici: 'demo', parola: 'gizli' },
      storageStateYolu: join(dizin, 'storage.json'),
    })).rejects.toThrow('aynı origin');
  });

  it('yönlendirme veya form hedefi başka origin ise parolayı oraya göndermez', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const gelenGovdeler: string[] = [];
    const dinle = (sunucu: Server): Promise<string> => new Promise((coz) => {
      sunucu.listen(0, '127.0.0.1', () => {
        const adres = sunucu.address();
        coz(`http://127.0.0.1:${typeof adres === 'object' && adres !== null ? adres.port : 0}`);
      });
    });
    const yabanci = createServer((istek, yanit) => {
      let govde = '';
      istek.on('data', (parca: Buffer) => { govde += parca.toString(); });
      istek.on('end', () => {
        if (istek.method === 'POST') gelenGovdeler.push(govde);
        yanit.writeHead(200, { 'content-type': 'text/html' });
        yanit.end('<form action="/topla" method="post"><input type="text" name="k"><input type="password" name="p"><button type="submit">Gir</button></form>');
      });
    });
    const yabanciUrl = await dinle(yabanci);
    const hedef = createServer((istek, yanit) => {
      if (istek.url === '/yonlendir') {
        yanit.writeHead(302, { location: `${yabanciUrl}/giris` });
        yanit.end();
        return;
      }
      yanit.writeHead(200, { 'content-type': 'text/html' });
      yanit.end(`<form action="${yabanciUrl}/topla" method="post"><input type="text" name="k"><input type="password" name="p"><button type="submit">Gir</button></form>`);
    });
    const hedefUrl = await dinle(hedef);
    try {
      const dizin = await geciciDizin();
      for (const loginUrl of [`${hedefUrl}/yonlendir`, `${hedefUrl}/giris`]) {
        await expect(kesfet({
          baseUrl: hedefUrl,
          loginUrl,
          kimlik: { kullanici: 'demo', parola: 'sizmamali-parola', origin: new URL(hedefUrl).origin },
          storageStateYolu: join(dizin, 'storage.json'),
          maxSayfa: 1,
          sayfaZamanAsimiMs: 5_000,
        })).rejects.toThrow('farklı origin');
      }
      expect(gelenGovdeler).toEqual([]);
    } finally {
      await Promise.all([
        new Promise((coz) => { yabanci.close(coz); }),
        new Promise((coz) => { hedef.close(coz); }),
      ]);
    }
  });

  it('kayıtlı kimlik başka origin için ya da origin\'siz ise parolayı hiçbir forma yazmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const istekler: string[] = [];
    const sunucu = createServer((istek, yanit) => {
      let govde = '';
      istek.on('data', (parca: Buffer) => { govde += parca.toString(); });
      istek.on('end', () => {
        istekler.push(`${istek.method ?? ''} ${istek.url ?? ''} ${govde}`);
        if (istek.method === 'POST') { yanit.writeHead(302, { location: '/panel' }); yanit.end(); return; }
        yanit.writeHead(200, { 'content-type': 'text/html' });
        yanit.end('<form action="/giris" method="post"><input type="text" name="k"><input type="password" name="p"><button type="submit">Gir</button></form>');
      });
    });
    const url = await new Promise<string>((coz) => {
      sunucu.listen(0, '127.0.0.1', () => {
        const adres = sunucu.address();
        coz(`http://127.0.0.1:${typeof adres === 'object' && adres !== null ? adres.port : 0}`);
      });
    });
    try {
      const dizin = await geciciDizin();
      for (const origin of ['http://mesru.test', undefined]) {
        await expect(kesfet({
          baseUrl: url,
          kimlik: { kullanici: 'demo', parola: 'sizmamali-parola', ...(origin === undefined ? {} : { origin }) },
          storageStateYolu: join(dizin, 'storage.json'),
          maxSayfa: 1,
          sayfaZamanAsimiMs: 5_000,
        })).rejects.toThrow('parola gönderilmedi');
      }
      expect(istekler.join('\n')).not.toContain('sizmamali-parola');
      expect(istekler.filter((satir) => satir.startsWith('POST'))).toEqual([]);
    } finally {
      await new Promise((coz) => { sunucu.close(coz); });
    }
  });

  it('giriş yapar, güvenli sayfaları BFS ile haritalar ve state iznini daraltır', async (context) => {
    if (!e2eMumkun(context)) return;
    const dizin = await geciciDizin();
    const state = join(dizin, 'storage.json');
    const harita = await kesfet({
      baseUrl: demo.url,
      loginUrl: `${demo.url}/giris`,
      kimlik: { kullanici: 'demo', parola: 'demo123', origin: new URL(demo.url).origin },
      storageStateYolu: state,
    });

    expect(harita.girisYapildi).toBe(true);
    expect(harita.sayfalar.map(({ url }) => new URL(url).pathname)).toEqual(['/giris', '/', '/liste', '/yeni']);
    expect(harita.sayfalar.some(({ url }) => new URL(url).pathname === '/cikis')).toBe(false);
    expect(harita.sayfalar.find(({ url }) => new URL(url).pathname === '/yeni')?.formlar[0]?.alanlar.map(({ ad }) => ad))
      .toEqual(['ad', 'tutar']);
    expect((await stat(state)).mode & 0o777).toBe(0o600);
  });

  it('giriş bilgisi yokken giriş ekranında kalır', async (context) => {
    if (!e2eMumkun(context)) return;
    const dizin = await geciciDizin();
    const harita = await kesfet({ baseUrl: demo.url, storageStateYolu: join(dizin, 'storage.json') });

    expect(harita.girisYapildi).toBe(false);
    expect(harita.sayfalar).toHaveLength(1);
    expect(new URL(harita.sayfalar[0]?.url ?? '').pathname).toBe('/giris');
  });

  it('maxSayfa sınırında yalnız bir sayfa döner', async (context) => {
    if (!e2eMumkun(context)) return;
    const dizin = await geciciDizin();
    const harita = await kesfet({
      baseUrl: demo.url,
      loginUrl: `${demo.url}/giris`,
      kimlik: { kullanici: 'demo', parola: 'demo123', origin: new URL(demo.url).origin },
      maxSayfa: 1,
      storageStateYolu: join(dizin, 'storage.json'),
    });
    expect(harita.sayfalar).toHaveLength(1);
  });
});

describe('girisFormuBul', () => {
  it('parola alanı olmayan sayfada null döner', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const tarayici = await chromium.launch({ headless: true });
    const sayfa = await tarayici.newPage();
    try {
      await sayfa.setContent('<form><input type="text"><button type="submit">Gönder</button></form>');
      await expect(girisFormuBul(sayfa)).resolves.toBeNull();
    } finally {
      await tarayici.close();
    }
  });
});
