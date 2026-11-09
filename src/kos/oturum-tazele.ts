import { access, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { authOriginleriDogrula, type Kimlik, type KobayConfig, type KobayDizini, type OturumDurumu } from '../depo/index.js';
import { girisFormuBul } from '../kesif/giris.js';
import {
  girisKorumasiBul,
  girisKorumasiKur,
  girisKorumasiSonDenetim,
  oturumKorumasiKur,
  yabanciCerceveler,
} from '../kesif/giris-korumasi.js';
import {
  iceAlinanOturumuOku,
  oturumDosyasiOku,
  oturumDurumunuCoz,
  oturumGirdileri,
  oturumKokenleriniDenetle,
} from '../kesif/oturum-dosyasi.js';
import {
  girisiGonder,
  girisSayfaMesajiNotu,
  hizSiniriOnerisi,
  izinliOriginler,
  kimlikOriginDogrula,
  loginUrlDogrula,
  oturumDurumunuSil,
  oturumDurumunuYaz,
} from '../kesif/oturum.js';

/**
 * Koşu öncesi ve sonrası oturum yoklaması (0.8.0 Ş1 P1-2).
 *
 * Koşucu oturumu yalnız `.kobay/storageState.json`'dan okur. Kısa ömürlü erişim jetonu ve tek
 * kullanımlık yenileme çerezi olan uygulamada (Vikunja: 600 sn, döner çerez) dosya bir süre sonra
 * ölür ve önceden geçen testler giriş ekranına düşer.
 *
 * - Kayıtlı kimlik (`--login`) varsa her koşudan önce dosya yoklanır. Yoklama bağlamı yüklü
 *   oturumun değerleriyle İLK istekten kimlikli korumadadır (`oturumKorumasiKur`: izinli küme
 *   dışına hiçbir istek gitmez, oturum değeri taşıyan yabancı istek sızıntıdır). Uygulama giriş
 *   ekranı göstermiyorsa, açılır pencere ya da yabancı çerçeve yoksa ve kökenler izinliyse
 *   yoklamanın (belki dönmüş) oturumu dosyaya geri yazılır; aksi halde temiz bağlamda keşifle aynı
 *   kurallarla (parola koruması) yeniden giriş yapılır ve giriş sonrası hâlâ giriş ekranındaysa
 *   (PRG ret: `/login?error=...`) ret sayılır.
 * - Yalnız projenin kendi `.kobay/storageState.json` yolu yenilenir; başka yol salt okunurdur.
 * - İçe alınan oturum (`--session-file`) YENİLENMEZ (bilinen sınır): kobay onu yazmaz.
 * - Düşen koşudan sonra: fixture testin KENDİ bağlamıyla (dönmüş son oturumla) uygulamayı açıp giriş
 *   ekranı gördüyse (`session-check.json`) ve diskteki oturum da (korumalı) giriş ekranına düşüyorsa
 *   koşu `env` + kurtarma komutuyla sonuçsuz sayılır. İkisinden biri tutmazsa koşu `failed` kalır.
 * - Aynı süreçteki eşzamanlı koşuların (MCP) hazırlığı sıraya girer; ayrı süreçler için kilit yok
 *   (backlog).
 */

/** Yoklamada sayfanın oturmasını (SPA'nın jeton yenileme + yönlendirmesi) beklemenin tavanı. */
export const OTURUM_YOKLAMA_AG_MS = 5_000;
/** Yoklama ve yeniden girişte tek sayfa açılışının tavanı. */
export const OTURUM_SAYFA_MS = 15_000;
/** Fixture'ın düşen testten sonra yazdığı, sır taşımayan iz (bkz. `fixture.ts`). */
export const OTURUM_IZI_DOSYASI = 'session-check.json';

export type KosuOncesiOturum =
  | { tur: 'yok' }
  | { tur: 'gecerli' }
  | { tur: 'yenilendi' }
  | { tur: 'hata'; mesaj: string };

function dosyaVarMi(yol: string): Promise<boolean> {
  return access(yol).then(() => true).catch(() => false);
}

/**
 * Açık sayfa giriş ekranı mı: uygulama origin'inden çıkmış (ayrı giriş sitesi), `loginUrl`
 * yolunda ya da sayfada parola alanı var. Oturum açıkken ana sayfada parola alanı beklenmez.
 */
export async function girisEkranindaMi(sayfa: Page, hedefOrigin: string, loginUrl?: string): Promise<boolean> {
  const adres = new URL(sayfa.url());
  if (adres.origin !== hedefOrigin) return true;
  if (loginUrl !== undefined && new URL(loginUrl).pathname === adres.pathname) return true;
  return await sayfa.locator('input[type="password"]').count().catch(() => 0) > 0;
}

/** `baseUrl`'i açar, ağın durulmasını (tavanlı) bekler ve giriş ekranında mı diye bakar. */
async function yokla(sayfa: Page, baseUrl: string, loginUrl: string | undefined): Promise<boolean> {
  await sayfa.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: OTURUM_SAYFA_MS });
  await sayfa.waitForLoadState('networkidle', { timeout: OTURUM_YOKLAMA_AG_MS }).catch(() => undefined);
  return girisEkranindaMi(sayfa, new URL(baseUrl).origin, loginUrl);
}

function hataMetni(hata: unknown, context: BrowserContext | undefined): string {
  const ham = hata instanceof Error ? hata.message : String(hata);
  const koruma = context === undefined ? undefined : girisKorumasiBul(context);
  return (koruma === undefined ? ham : koruma.metniGizle(ham)).split('\n')[0] ?? '';
}

/** Hız sınırında önerilen komut: test kimliği biliniyorsa onun rerun'ı. */
function yenidenKosKomutu(testId: string | undefined): string {
  return testId === undefined ? '`kobay test run`' : `\`kobay test rerun ${testId}\``;
}

const KIMLIK_YOLU = 'Check them with `kobay explore` (it shows the login error) or re-enter them with `kobay project update --login`.';

/** Aynı süreçteki oturum hazırlıklarını (yokla → giriş → yaz/sil) sıraya koyar; yol başına bir zincir. */
const siralar = new Map<string, Promise<unknown>>();
function sirayla<T>(anahtar: string, is: () => Promise<T>): Promise<T> {
  const onceki = siralar.get(anahtar) ?? Promise.resolve();
  const sonuc = onceki.catch(() => undefined).then(is);
  const kuyruk = sonuc.catch(() => undefined);
  siralar.set(anahtar, kuyruk);
  void kuyruk.then(() => { if (siralar.get(anahtar) === kuyruk) siralar.delete(anahtar); });
  return sonuc;
}

/**
 * Diskteki oturum dosyasını korumalı yoklama için okur: sınırlı okuma, şema ve köken kuralı
 * (içe alınan oturumla aynı). Uymuyorsa null: yoklama yapılmaz.
 */
async function diskOturumu(yol: string, baseUrl: string, authOrigins: readonly string[]): Promise<OturumDurumu | null> {
  try {
    const durum = oturumDurumunuCoz(await oturumDosyasiOku(yol));
    oturumKokenleriniDenetle(durum, baseUrl, authOrigins);
    return durum;
  } catch {
    return null;
  }
}

/**
 * Yüklü oturumla korumalı bağlam açar: değerler ilk istekten kimlikli evrede korunur, service
 * worker kapalı, açılır pencereler kapatılır ve sayılır (geri yazımı engeller).
 */
async function korumaliOturumBaglami(
  tarayici: Browser,
  durum: OturumDurumu,
  hedefOrigin: string,
  authOrigins: readonly string[],
): Promise<{ context: BrowserContext; sayfa: Page; acilirSayisi: () => number }> {
  const context = await tarayici.newContext({
    serviceWorkers: 'block',
    storageState: { cookies: durum.cookies, origins: durum.origins },
  });
  await oturumKorumasiKur(context, hedefOrigin, authOrigins, oturumGirdileri(durum));
  const sayfa = await context.newPage();
  let acilir = 0;
  context.on('page', (yeni) => { acilir += 1; void yeni.close().catch(() => undefined); });
  return { context, sayfa, acilirSayisi: () => acilir };
}

/**
 * Temiz bağlamda (eski çerezler olmadan) keşifle aynı yoldan giriş: koruma ilk sayfadan önce,
 * service worker kapalı, giriş yalnız uygulamaya dönünce başarılı. Giriş sonrası sayfa hâlâ giriş
 * ekranıysa (PRG ret) başarısızdır. Oturum yalnız başarılı girişte ve son denetimden SONRA
 * yazılır; reddedilen girişte dosya silinir.
 */
async function yenidenGir(
  tarayici: Browser,
  kimlik: Kimlik,
  config: KobayConfig,
  baseUrl: string,
  authOrigins: readonly string[],
  storageStateYolu: string,
  oturumVardi: boolean,
  testId: string | undefined,
): Promise<KosuOncesiOturum> {
  const hedefOrigin = new URL(baseUrl).origin;
  // İlk koşuda (oturum dosyası yok) "kayıtlı oturum" yoktur; mesaj buna göre başlar.
  const bas = oturumVardi ? 'The saved session no longer works and logging in again' : 'Logging in before the run';
  let context: BrowserContext | undefined;
  try {
    context = await tarayici.newContext({ serviceWorkers: 'block' });
    await girisKorumasiKur(context, kimlik, izinliOriginler(hedefOrigin, authOrigins));
    const sayfa = await context.newPage();
    await sayfa.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: OTURUM_SAYFA_MS });
    if (config.loginUrl !== undefined) {
      await sayfa.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: OTURUM_SAYFA_MS });
    }
    let form = await girisFormuBul(sayfa);
    if (form === null) {
      // SPA giriş formu yönlendirmeden sonra çizilebilir; bir kez, tavanlı bekleyip yeniden bakılır.
      await sayfa.waitForLoadState('networkidle', { timeout: OTURUM_YOKLAMA_AG_MS }).catch(() => undefined);
      form = await girisFormuBul(sayfa);
    }
    if (form === null) {
      return {
        tur: 'hata',
        mesaj: `${bas} found no login form (nothing was typed).`
          + ' Set the login page with `kobay project update --login-url <URL>`, or import a session with'
          + ' `kobay project create --url <URL> --session-file <file> --force`.',
      };
    }
    const formYolu = new URL(sayfa.url()).pathname;
    const giris = await girisiGonder(sayfa, form, kimlik, hedefOrigin, authOrigins);
    // URL değişti diye giriş tamam sayılmaz: ret sayfasına yönlenen (PRG `/login?error=bad`) giriş
    // de URL değiştirir. Ret: sayfa oturduktan sonra giriş formunun yolunda (ya da `loginUrl`
    // yolunda) ve orada yine bir giriş formu var. Başka yoldaki parola alanı (zorunlu
    // `/account/change-password`) ret değildir.
    let girisEkraninda = false;
    if (giris.basarili) {
      await sayfa.waitForLoadState('networkidle', { timeout: OTURUM_YOKLAMA_AG_MS }).catch(() => undefined);
      const yol = new URL(sayfa.url()).pathname;
      const girisYolu = yol === formYolu || (config.loginUrl !== undefined && new URL(config.loginUrl).pathname === yol);
      girisEkraninda = girisYolu && await girisFormuBul(sayfa) !== null;
    }
    if ((!giris.basarili || girisEkraninda) && giris.hizSiniri !== undefined) {
      // P2-3: uygulama giriş isteğini hız sınırıyla (HTTP 429, sayfa metni değil) reddetti. Kimlik
      // yanlış sayılmaz: oturum dosyası ve kimlik silinmez (ret yolundaki silme kimlik reddi
      // içindir; koşu yine durur, dosya sonraki koşuda yeniden yoklanır). Otomatik yeniden deneme
      // yok: bekleme sınırın bütçesini yine tüketir.
      return {
        tur: 'hata',
        mesaj: `${bas} was refused by the app's rate limit (HTTP 429 Too Many Requests); this does not mean the saved`
          + ' credentials are wrong, and kobay kept them and the session file.'
          + ` ${hizSiniriOnerisi(giris.hizSiniri, yenidenKosKomutu(testId))}`,
      };
    }
    if (!giris.basarili || girisEkraninda) {
      await oturumDurumunuSil(storageStateYolu);
      return {
        tur: 'hata',
        mesaj: `${bas} with the saved credentials failed.${girisSayfaMesajiNotu(giris.sayfaMesaji)}`
          + ` ${KIMLIK_YOLU}`,
      };
    }
    await girisKorumasiSonDenetim(context);
    await oturumDurumunuYaz(context, storageStateYolu);
    return { tur: 'yenilendi' };
  } catch (hata: unknown) {
    // Hata kendi kurtarma komutunu söylüyorsa (kilitli düğme → `--session-file`) çelişen ikinci
    // öneri eklenmez.
    const metin = hataMetni(hata, context);
    return { tur: 'hata', mesaj: `${bas} failed: ${metin}${/`kobay /.test(metin) ? '' : ` ${KIMLIK_YOLU}`}` };
  } finally {
    await context?.close().catch(() => undefined);
  }
}

/**
 * Yüklü oturum geçerli mi; geçerliyse bağlamın son oturumunu dosyaya geri yazar. Geri yazım ancak
 * giriş ekranı yoksa, açılır pencere ya da yabancı çerçeve açılmadıysa, koruma sızıntı görmediyse
 * ve yazılacak durumun kökenleri izinliyse yapılır. `true`: geçerli ve yazıldı.
 */
async function yoklaVeGeriYaz(
  tarayici: Browser,
  durum: OturumDurumu,
  config: KobayConfig,
  baseUrl: string,
  authOrigins: readonly string[],
  storageStateYolu: string,
): Promise<boolean> {
  const hedefOrigin = new URL(baseUrl).origin;
  const { context, sayfa, acilirSayisi } = await korumaliOturumBaglami(tarayici, durum, hedefOrigin, authOrigins);
  try {
    if (await yokla(sayfa, baseUrl, config.loginUrl)) return false;
    const cerceveler = context.pages().flatMap((acik) => acik.frames().map((cerceve) => cerceve.url()));
    if (acilirSayisi() > 0 || yabanciCerceveler(cerceveler, hedefOrigin, authOrigins).length > 0) return false;
    await girisKorumasiSonDenetim(context);
    // Sayfa kapanınca durum değişmez; okunan ve yazılan durum aynıdır.
    await sayfa.close();
    const son = await context.storageState();
    // Yalnız alan adı ve origin okunur; Playwright'ın tipi şemanın alt kümesidir.
    oturumKokenleriniDenetle(son as unknown as OturumDurumu, baseUrl, authOrigins);
    await oturumDurumunuYaz(context, storageStateYolu);
    return true;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Kayıtlı kimlikli projede koşudan önce oturumu hazırlar. Kimlik yoksa (içe alınan oturum ya da
 * kimliksiz keşif) ya da yol projenin kendi oturum dosyası değilse hiçbir şey yapmaz: `{ tur: 'yok' }`.
 */
export async function kosuOncesiOturum(
  dizin: KobayDizini,
  baseUrl: string,
  storageStateYolu: string,
  testId?: string,
): Promise<KosuOncesiOturum> {
  if (resolve(storageStateYolu) !== resolve(dizin.storageStateYolu())) return { tur: 'yok' };
  const kimlik = await dizin.kimlikOku().catch(() => null);
  if (kimlik === null) return { tur: 'yok' };
  let config: KobayConfig;
  let authOrigins: readonly string[];
  try {
    config = await dizin.configOku();
    authOrigins = authOriginleriDogrula(baseUrl, config.authOrigins ?? []);
    loginUrlDogrula(baseUrl, config.loginUrl, authOrigins);
    // Tarayıcı açılmadan: başka origin'e ait kimlikle hiçbir sayfaya gidilmez.
    kimlikOriginDogrula(kimlik, new URL(baseUrl).origin, authOrigins);
  } catch (hata: unknown) {
    return { tur: 'hata', mesaj: `The saved credentials cannot be used for this run: ${hataMetni(hata, undefined)}` };
  }
  return sirayla(resolve(storageStateYolu), async () => {
    const tarayici = await chromium.launch({ headless: true });
    try {
      const dosyaVar = await dosyaVarMi(storageStateYolu);
      const durum = dosyaVar ? await diskOturumu(storageStateYolu, baseUrl, authOrigins) : null;
      if (durum !== null) {
        try {
          if (await yoklaVeGeriYaz(tarayici, durum, config, baseUrl, authOrigins, storageStateYolu)) return { tur: 'gecerli' };
        } catch {
          // Yoklama (sızıntı, köken, sayfa hatası) geri yazımı engeller; temiz bağlamda yeniden giriş denenir.
        }
      }
      return await yenidenGir(tarayici, kimlik, config, baseUrl, authOrigins, storageStateYolu, dosyaVar, testId);
    } finally {
      await tarayici.close().catch(() => undefined);
    }
  });
}

/** `session-check.json`'ın en büyük boyu (bayt); fixture `{"loginPage":true}\n` yazar. */
export const OTURUM_IZI_TAVANI_BAYT = 64;

/**
 * Fixture'ın izi: test kendi (son) oturumuyla uygulamayı açtığında giriş ekranı gördü mü? Dosya
 * koşu klasöründedir ve üretilen test de oraya yazabilir: boyu tavanlı, düzenli dosya, şeması tam
 * (`{ "loginPage": true }`, başka alan yok) olmalı. Uymayan her şey "kanıt yok" sayılır, koşu
 * `failed` kalır. Kalan sınır: geçerli biçimde yazılmış sahte iz, diskteki oturum da ölüyse
 * düşüşü `env`'e çevirir (backlog).
 */
async function testOturumuDustuMu(kosuDizini: string): Promise<boolean> {
  try {
    const yol = join(kosuDizini, OTURUM_IZI_DOSYASI);
    const bilgi = await lstat(yol);
    if (!bilgi.isFile() || bilgi.size > OTURUM_IZI_TAVANI_BAYT) return false;
    const veri = JSON.parse(await readFile(yol, 'utf8')) as unknown;
    if (typeof veri !== 'object' || veri === null || Array.isArray(veri)) return false;
    const anahtarlar = Object.keys(veri);
    return anahtarlar.length === 1 && anahtarlar[0] === 'loginPage' && (veri as { loginPage: unknown }).loginPage === true;
  } catch {
    return false;
  }
}

/** Oturum düşüşü mesajları; ilk satır CLI satırında görünür, tek satırdır. */
export function oturumDususuMesaji(kaynak: 'login' | 'imported', testId: string): string {
  return kaynak === 'imported'
    ? 'The imported session no longer works: with it the app now shows its login page, so this run says nothing about'
      + ' the app. kobay does not refresh imported sessions. Import a fresh one with'
      + ` \`kobay explore --session-file <file>\`, then run \`kobay test rerun ${testId}\`.`
    : 'The saved login session stopped working during this run: with it the app now shows its login page, so this run'
      + ' says nothing about the app. kobay logs in again with the saved credentials before the next run:'
      + ` run \`kobay test rerun ${testId}\`. If it happens again, the test itself may end the session (logout, password change).`;
}

/**
 * Düşen koşudan sonra: oturum düştü mü? İki kanıt birden gerekir: (1) fixture testin kendi
 * bağlamıyla giriş ekranı gördü (dönmüş son oturum; testin bellekteki oturumu canlıysa gerçek
 * hata saklanmaz), (2) diskteki oturum da korumalı yoklamada giriş ekranına düşüyor. Dosyaya
 * yazmaz, giriş yapmaz. Sonuç: düşüşün kaynağı ya da null (koşu `failed` kalır).
 */
export async function kosuSonrasiOturumDustuMu(
  dizin: KobayDizini,
  baseUrl: string,
  storageStateYolu: string,
  kosuDizini: string,
): Promise<'login' | 'imported' | null> {
  if (!(await testOturumuDustuMu(kosuDizini))) return null;
  if (!(await dosyaVarMi(storageStateYolu))) return null;
  let tarayici: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    const [config, kimlik] = await Promise.all([dizin.configOku(), dizin.kimlikOku().catch(() => null)]);
    const authOrigins = authOriginleriDogrula(baseUrl, config.authOrigins ?? []);
    let durum: OturumDurumu | null;
    if (kimlik === null) {
      durum = await iceAlinanOturumuOku(storageStateYolu, baseUrl, authOrigins);
    } else {
      kimlikOriginDogrula(kimlik, new URL(baseUrl).origin, authOrigins);
      durum = await diskOturumu(storageStateYolu, baseUrl, authOrigins);
    }
    if (durum === null) return null;
    tarayici = await chromium.launch({ headless: true });
    const acik = await korumaliOturumBaglami(tarayici, durum, new URL(baseUrl).origin, authOrigins);
    context = acik.context;
    const dustu = await yokla(acik.sayfa, baseUrl, config.loginUrl);
    await girisKorumasiSonDenetim(context);
    if (!dustu) return null;
    return kimlik === null ? 'imported' : 'login';
  } catch {
    // Yoklama en iyi çabadır: anlaşılamazsa koşunun kendi sonucu aynen kalır.
    return null;
  } finally {
    await context?.close().catch(() => undefined);
    await tarayici?.close().catch(() => undefined);
  }
}
