import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { authOriginleriDogrula, type Harita, type Kimlik, type Sayfa } from '../depo/index.js';
import { girisFormuBul } from './giris.js';
import { gez } from './gezgin.js';
import { girisKorumasiKur, girisKorumasiSonDenetim } from './giris-korumasi.js';
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
import { sayfaOzeti } from './sayfa-ozeti.js';

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
  // Tarayıcı açılmadan: başka origin'e (ya da başka auth origin kümesine) ait kimlikle hiçbir sayfaya gidilmez.
  if (secenekler.kimlik !== undefined) kimlikOriginDogrula(secenekler.kimlik, hedefOrigin, authOrigins);
  const tarayici = await chromium.launch({ headless: true });
  // Service worker istekleri context.route'a uğramaz; giriş korumasının dışında kalmasın diye
  // kimlik verildiğinde kapalı. Kimliksiz keşifte koruma yok, worker'lar çalışır.
  const context = await tarayici.newContext({ serviceWorkers: secenekler.kimlik !== undefined ? 'block' : 'allow' });
  // WebSocket yönlendirmesi yalnız sonra açılan belgelere işler; koruma ilk sayfadan önce kurulur.
  if (secenekler.kimlik !== undefined) {
    await girisKorumasiKur(context, secenekler.kimlik, izinliOriginler(hedefOrigin, authOrigins));
  }
  const sayfa = await context.newPage();
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
    // oturumu silmesin.
    if (secenekler.kimlik === undefined || girisYapildi) {
      await oturumDurumunuYaz(context, secenekler.storageStateYolu);
    } else if (giris?.basarili === false) {
      await oturumDurumunuSil(secenekler.storageStateYolu);
    }

    const pages = await gez(sayfa, {
      baseUrl: secenekler.baseUrl,
      maxSayfa,
      derinlik,
      sayfaZamanAsimiMs,
      ilkSayfalar,
      ...(secenekler.ekranGoruntusuDizini
        ? { ekranGoruntusuDizini: secenekler.ekranGoruntusuDizini }
        : {}),
    });
    // Giriş koruması keşif boyunca kurulu kaldı; giriş sonrası bir sayfa parolayı
    // başka origin'e göndermeye çalıştıysa harita dönmez.
    girisKorumasiSonDenetim(context);
    const harita: Harita = {
      baseUrl: secenekler.baseUrl,
      loggedIn: girisYapildi,
      pages,
      exploredAt: new Date().toISOString(),
    };
    return girisSayfaMesaji === undefined ? { harita } : { harita, girisSayfaMesaji };
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
  haritadaSayfaBul,
  haritadaSayfayiDegistir,
  sayfayiYenile,
  type SayfaYenilemeSecenekleri,
} from './sayfayi-yenile.js';
