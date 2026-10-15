import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { authOriginleriDogrula, type Harita, type Kimlik, type OturumDurumu, type Sayfa } from '../depo/index.js';
import { girisFormuBul } from './giris.js';
import { gez } from './gezgin.js';
import {
  girisKorumasiBul,
  girisKorumasiKur,
  girisKorumasiSonDenetim,
  oturumKorumasiKur,
  haritaMaskesi,
  oturumMetinMaskesi,
} from './giris-korumasi.js';
import { oturumDegerleri, oturumGirdileri, oturumKokenleriniDenetle } from './oturum-dosyasi.js';
import {
  girisiGonder,
  izinliOriginler,
  kimlikOriginDogrula,
  loginUrlDogrula,
  oturumDurumunuSil,
  oturumDurumunuYaz,
  type GirisSayfaMesaji,
  type GirisSonucu,
} from './oturum.js';
import { sayfaMetinleriniGizle, sayfaOzeti } from './sayfa-ozeti.js';
import { siteHaritasiOku, tohumlariDogrula, type SiteHaritasi } from './sitemap.js';

export interface KesifSecenekleri {
  baseUrl: string;
  kimlik?: Kimlik;
  loginUrl?: string;
  /**
   * Ayrı giriş (SSO) origin'leri; config'teki liste. Parola yalnız `baseUrl` origin'ine ve
   * bunlara gidebilir; kimlikteki listeyle birebir aynı olmalı. Keşif (BFS) yine yalnız
   * `baseUrl` origin'inde gezer.
   */
  authOrigins?: readonly string[];
  maxSayfa?: number;
  derinlik?: number;
  sayfaZamanAsimiMs?: number;
  storageStateYolu: string;
  ekranGoruntusuDizini?: string;
  /** Başlangıç adresiyle birlikte gezilecek aynı kökenli adresler (`--seed`); başka köken `SeedUrlError`. */
  tohumlar?: readonly string[];
  /** Varsayılan true: `<köken>/sitemap.xml` (ve index) okunur, adresler derinlik 1 ile kuyruğa girer. */
  siteHaritasi?: boolean;
  /**
   * İçe alınan oturum (`--session-file`, bkz. `oturum-dosyasi.ts`). Verilirse giriş yapılmaz:
   * bağlam bu oturumla açılır, koruma ilk istekten önce kimlikli evrede kurulur, harita
   * `loggedIn: true` ve `sessionSource: 'imported'` taşır, `storageStateYolu`'na yazılmaz
   * (içe alınan dosya olduğu gibi kalır). `kimlik` ile birlikte verilemez.
   */
  oturum?: OturumDurumu;
}

/**
 * Keşif sonucu. `girisSayfaMesaji` giriş reddedildiğinde sayfanın gösterdiği uyarıdır; haritanın
 * parçası değildir (diske yazılmaz), yalnız giriş hatası mesajına eklenir.
 */
export interface KesifSonucu {
  harita: Harita;
  girisSayfaMesaji?: GirisSayfaMesaji;
}

/** Uygulamayı güvenli bağlantılarla gezip test üretimine uygun bir harita çıkarır. */
export async function kesfet(secenekler: KesifSecenekleri): Promise<Harita> {
  return (await kesfetAyrintili(secenekler)).harita;
}

/** `kesfet` ile aynı; ayrıca giriş reddedildiyse sayfanın uyarısını döner. */
export async function kesfetAyrintili(secenekler: KesifSecenekleri): Promise<KesifSonucu> {
  const authOrigins = authOriginleriDogrula(secenekler.baseUrl, secenekler.authOrigins ?? []);
  const hedefOrigin = new URL(secenekler.baseUrl).origin;
  loginUrlDogrula(secenekler.baseUrl, secenekler.loginUrl, authOrigins);
  const tohumlar = tohumlariDogrula(secenekler.baseUrl, secenekler.tohumlar ?? []);
  // Tarayıcı açılmadan: başka origin'e (ya da başka auth origin kümesine) ait kimlikle hiçbir sayfaya gidilmez.
  if (secenekler.kimlik !== undefined) kimlikOriginDogrula(secenekler.kimlik, hedefOrigin, authOrigins);
  const oturum = secenekler.oturum;
  if (oturum !== undefined) {
    if (secenekler.kimlik !== undefined) throw new Error('An imported session and saved credentials cannot be used together');
    // Çağıran doğruladı; tarayıcı açılmadan bir kez daha (yabancı kökenli çerez bağlama hiç girmez).
    oturumKokenleriniDenetle(oturum, secenekler.baseUrl, authOrigins);
  }
  const korumali = secenekler.kimlik !== undefined || oturum !== undefined;
  // Kurulum hatasında (ör. Chromium'un reddettiği çerez) tarayıcı kapanır ki süreç asılı kalmasın;
  // içe alınan oturumda hata metni oturum değerlerinden arınır.
  const kurulumHatasi = (hata: unknown): unknown => {
    if (oturum !== undefined && hata instanceof Error) hata.message = oturumMetinMaskesi(oturumGirdileri(oturum))(hata.message);
    return hata;
  };
  const tarayici = await chromium.launch({ headless: true });
  let context: BrowserContext | undefined;
  let sayfa: Page;
  try {
    // Service worker istekleri context.route'a uğramaz; giriş korumasının dışında kalmasın diye
    // kimlikli bağlamda (kimlik ya da içe alınan oturum) kapalı. Kimliksiz keşifte koruma yok, worker'lar çalışır.
    context = await tarayici.newContext({
      serviceWorkers: korumali ? 'block' : 'allow',
      ...(oturum === undefined ? {} : { storageState: { cookies: oturum.cookies, origins: oturum.origins } }),
    });
    // WebSocket yönlendirmesi yalnız sonra açılan belgelere işler; koruma ilk sayfadan önce kurulur.
    if (secenekler.kimlik !== undefined) {
      await girisKorumasiKur(context, secenekler.kimlik, izinliOriginler(hedefOrigin, authOrigins));
    } else if (oturum !== undefined) {
      await oturumKorumasiKur(context, hedefOrigin, authOrigins, oturumGirdileri(oturum));
    }
    sayfa = await context.newPage();
  } catch (hata: unknown) {
    await context?.close().catch(() => undefined);
    await tarayici.close().catch(() => undefined);
    throw kurulumHatasi(hata);
  }
  // Keşif boyunca açılan pencereler (popup) hemen kapatılır: ilk belgeleri gezginin köken
  // denetiminden geçmez. Kimlikli keşifte giriş adımı giriş korumasının alanıdır; dinleyici
  // girişten sonra kurulur, o sırada açılmış pencerelere dokunulmaz. İçe alınan oturumda
  // giriş adımı yoktur, dinleyici baştan kurulur.
  const pencereKapat = (yeni: Page): void => { void yeni.close().catch(() => undefined); };
  if (secenekler.kimlik === undefined) context.on('page', pencereKapat);
  const maxSayfa = secenekler.maxSayfa ?? 40;
  const derinlik = secenekler.derinlik ?? 3;
  const sayfaZamanAsimiMs = secenekler.sayfaZamanAsimiMs ?? 15_000;
  let girisYapildi = false;
  /** Giriş denendiyse sonucu; form bulunamadıysa undefined. */
  let giris: GirisSonucu | undefined;
  let girisSayfaMesaji: GirisSayfaMesaji | undefined;
  const ilkSayfalar: Sayfa[] = [];

  try {
    await sayfa.goto(secenekler.baseUrl, { waitUntil: 'domcontentloaded', timeout: sayfaZamanAsimiMs });
    if (secenekler.kimlik) {
      if (secenekler.loginUrl) {
        await sayfa.goto(secenekler.loginUrl, { waitUntil: 'domcontentloaded', timeout: sayfaZamanAsimiMs });
      }
      const form = await girisFormuBul(sayfa);
      if (form) {
        // Haritaya yalnız uygulamanın kendi origin'indeki sayfalar girer: ayrı giriş sitesindeki
        // (SSO) form sayfası test hedefi değildir.
        if (new URL(sayfa.url()).origin === hedefOrigin) {
          ilkSayfalar.push(await sayfaOzeti(sayfa, hedefOrigin));
          if (secenekler.ekranGoruntusuDizini) {
            await mkdir(secenekler.ekranGoruntusuDizini, { recursive: true });
            await sayfa.screenshot({ path: `${secenekler.ekranGoruntusuDizini}/sayfa-1.png` });
          }
        }
        giris = await girisiGonder(sayfa, form, secenekler.kimlik, hedefOrigin, authOrigins);
        girisYapildi = giris.basarili;
        girisSayfaMesaji = giris.sayfaMesaji;
      }
    }

    // Kimlik verildiyse oturum yalnız giriş tamamlandıysa yazılır: reddedilen girişte sayfa
    // parolayı çereze/localStorage'a koymuş olabilir, o durum diske düşmesin.
    // Reddedilen girişte önceki oturum dosyası da kalmaz (koşucu onu kullanırdı). Form hiç
    // bulunamadıysa (giriş denenmedi) dosyaya dokunulmaz: geçici algılama hatası geçerli
    // oturumu silmesin. İçe alınan oturumda dosya kullanıcının içe aldığı haliyle kalır.
    if (oturum === undefined) {
      if (secenekler.kimlik === undefined || girisYapildi) {
        await oturumDurumunuYaz(context, secenekler.storageStateYolu);
      } else if (giris?.basarili === false) {
        await oturumDurumunuSil(secenekler.storageStateYolu);
      }
    }

    const siteHaritasi: SiteHaritasi | null = secenekler.siteHaritasi === false
      ? null
      : await siteHaritasiOku(hedefOrigin, sayfaZamanAsimiMs);
    if (secenekler.kimlik !== undefined) context.on('page', pencereKapat);
    const pages = await gez(sayfa, {
      baseUrl: secenekler.baseUrl,
      maxSayfa,
      derinlik,
      sayfaZamanAsimiMs,
      ilkSayfalar,
      tohumlar,
      siteHaritasiAdresleri: siteHaritasi?.adresler ?? [],
      // Kimlikli keşifte girişe yönlenen sayfa işaretlenmez; oturum açıkken normal gezilir.
      // İçe alınan oturumda işaretlenir: oturum geçerliyse yönlenme olmaz, olursa oturum
      // düşmüş demektir; kayıt bunu gösterir, CLI uyarır.
      girisYonlendirmesiniIsaretle: !girisYapildi,
      ...(secenekler.ekranGoruntusuDizini
        ? { ekranGoruntusuDizini: secenekler.ekranGoruntusuDizini }
        : {}),
    });
    context.off('page', pencereKapat);
    // Giriş koruması keşif boyunca kurulu kaldı; giriş sonrası bir sayfa parolayı
    // başka origin'e göndermeye çalıştıysa harita dönmez.
    await girisKorumasiSonDenetim(context);
    const sessionSource = oturum !== undefined ? 'imported' : girisYapildi ? 'login' : undefined;
    // Haritaya giren her sayfa metni içe alınan oturumun değerlerinden ve parolanın izlerinden arınır;
    // yapısal adresler geçerli kalır (bkz. `sayfaMetinleriniGizle`).
    const maske = haritaMaskesi(oturum === undefined ? [] : oturumDegerleri(oturum), secenekler.kimlik?.password);
    const harita: Harita = {
      baseUrl: secenekler.baseUrl,
      loggedIn: girisYapildi || oturum !== undefined,
      pages: maske.bos ? pages : pages.map((sayfa) => sayfaMetinleriniGizle(sayfa, maske)),
      exploredAt: new Date().toISOString(),
      ...(tohumlar.length === 0 ? {} : { seeds: tohumlar }),
      ...(siteHaritasi === null ? {} : { sitemap: { url: siteHaritasi.url, urlCount: siteHaritasi.adresler.length } }),
      ...(sessionSource === undefined ? {} : { sessionSource }),
    };
    return girisSayfaMesaji === undefined ? { harita } : { harita, girisSayfaMesaji };
  } catch (hata: unknown) {
    // İçe alınan oturumda her hata mesajı (Playwright'ınki dahil) oturum değerlerine göre maskelenir.
    const koruma = oturum === undefined ? undefined : girisKorumasiBul(context);
    if (koruma !== undefined && hata instanceof Error) hata.message = koruma.metniGizle(hata.message);
    throw hata;
  } finally {
    await context.close();
    await tarayici.close();
  }
}

export { girisFormuBul } from './giris.js';
export { CredentialLeakBlockedError } from './giris-korumasi.js';
export {
  girisiGonder,
  girisSayfaMesajiNotu,
  CredentialOriginError,
  GIRIS_DONUS_BEKLEME_MS,
  kimlikOriginDogrula,
  LoginDidNotReturnError,
  LoginFormOriginError,
  LoginSubmitTimeoutError,
  loginUrlDogrula,
  oturumDurumunuYaz,
  type GirisSayfaMesaji,
  type GirisSonucu,
} from './oturum.js';
export { sayfaOzeti } from './sayfa-ozeti.js';
export {
  iceAlinanOturumuOku,
  OTURUM_DOSYASI_TAVANI,
  oturumDosyasiniHazirla,
  SessionFileError,
} from './oturum-dosyasi.js';
export {
  SeedUrlError,
  SITEMAP_ADRES_TAVANI,
  SITEMAP_ALT_DOSYA_TAVANI,
  SITEMAP_BAYT_TAVANI,
  siteHaritasiOku,
  tohumlariDogrula,
} from './sitemap.js';
export {
  haritadaSayfaBul,
  haritadaSayfayiDegistir,
  sayfayiYenile,
  type SayfaYenilemeSecenekleri,
} from './sayfayi-yenile.js';
