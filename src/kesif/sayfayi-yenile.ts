import { access } from 'node:fs/promises';
import { chromium, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { authOriginleriDogrula, type Harita, type Kimlik, type OturumDurumu, type Sayfa } from '../depo/index.js';
import { DURULMA, istekIzle, PageNotRespondingError, sayfaDurulsun, sinirli } from './gezgin.js';
import { girisFormuBul } from './giris.js';
import {
  girisKorumasiBul,
  girisKorumasiKur,
  girisKorumasiSonDenetim,
  haritaMaskesi,
  oturumKorumasiKur,
  oturumMetinMaskesi,
} from './giris-korumasi.js';
import { oturumDegerleri, oturumGirdileri } from './oturum-dosyasi.js';
import {
  girisiGonder,
  girisSayfaMesajiNotu,
  izinliOriginler,
  kimlikOriginDogrula,
  loginUrlDogrula,
  oturumDurumunuSil,
  oturumDurumunuYaz,
  type GirisSonucu,
} from './oturum.js';
import { sayfaMetinleriniGizle, sayfaOzeti } from './sayfa-ozeti.js';

export interface SayfaYenilemeSecenekleri {
  baseUrl: string;
  /** Yenilenecek sayfanın adresi; göreli verilirse `baseUrl` ile çözülür. */
  url: string;
  storageStateYolu: string;
  kimlik?: Kimlik;
  loginUrl?: string;
  /** Ayrı giriş (SSO) origin'leri; bkz. `KesifSecenekleri.authOrigins`. */
  authOrigins?: readonly string[];
  sayfaZamanAsimiMs?: number;
  /**
   * Doğrulanmış içe alınan oturum. Verilirse tarayıcıya dosya yolu DEĞİL bu nesne verilir (diskteki
   * dosya arada değişse de maskelenen oturumla kullanılan oturum aynı kalır); değerleri yenilenen
   * sayfa özetinden maskelenir.
   */
  oturum?: OturumDurumu;
}

/**
 * `src/analiz/index.ts` içindeki `urlYolu` ile aynı mantık: yalnız pathname.
 * Analiz modülü bu şeridin dokunma listesinde olduğu için üç satır tekrarlandı.
 */
function urlYolu(adres: string, baseUrl: string): string | null {
  try {
    return new URL(adres, baseUrl).pathname;
  } catch {
    return null;
  }
}

function dosyaVarMi(yol: string): Promise<boolean> {
  return access(yol).then(() => true).catch(() => false);
}

/**
 * Tek bir sayfayı var olan oturumla açıp yeniden özetler. Oturum düşmüşse
 * (istenen yol yerine giriş ekranına yönlenildiyse) kimlik varsa yeniden giriş
 * yapar ve storageState'i günceller. Sayfa yine açılamıyorsa hata verir; yanlış
 * sayfanın özeti haritaya yazılmaz.
 */
export async function sayfayiYenile(secenekler: SayfaYenilemeSecenekleri): Promise<Sayfa> {
  const authOrigins = authOriginleriDogrula(secenekler.baseUrl, secenekler.authOrigins ?? []);
  const hedefOrigin = new URL(secenekler.baseUrl).origin;
  loginUrlDogrula(secenekler.baseUrl, secenekler.loginUrl, authOrigins);
  // Tarayıcı açılmadan: başka origin'e (ya da başka auth origin kümesine) ait kimlikle hiçbir sayfaya gidilmez.
  if (secenekler.kimlik !== undefined) kimlikOriginDogrula(secenekler.kimlik, hedefOrigin, authOrigins);
  const hedef = new URL(secenekler.url, secenekler.baseUrl).href;
  const beklenenYol = new URL(hedef).pathname;
  const sayfaZamanAsimiMs = secenekler.sayfaZamanAsimiMs ?? 15_000;
  const tarayici = await chromium.launch({ headless: true });
  const oturum = secenekler.oturum;
  const oturumVar = oturum === undefined && await dosyaVarMi(secenekler.storageStateYolu);
  // Service worker istekleri context.route'a uğramaz; giriş korumasının dışında kalmasın diye
  // kimlik verildiğinde kapalı. Kimliksiz yenilemede koruma yok, worker'lar çalışır.
  let context: BrowserContext | undefined;
  let sayfa: Page;
  try {
    context = await tarayici.newContext({
      // İçe alınan oturumda da kimlikli bağlam: service worker'lar route'a uğramaz, kapalı.
      serviceWorkers: secenekler.kimlik !== undefined || oturum !== undefined ? 'block' : 'allow',
      ...(oturum !== undefined
        ? { storageState: { cookies: oturum.cookies, origins: oturum.origins } }
        : oturumVar ? { storageState: secenekler.storageStateYolu } : {}),
    });
    // WebSocket yönlendirmesi yalnız sonra açılan belgelere işler; koruma ilk sayfadan önce kurulur.
    if (secenekler.kimlik !== undefined) {
      await girisKorumasiKur(context, secenekler.kimlik, izinliOriginler(hedefOrigin, authOrigins));
    } else if (oturum !== undefined) {
      // Keşifteki gibi: içe alınan oturumla yenileme ilk istekten kimlikli evrede (bkz. `oturumKorumasiKur`).
      await oturumKorumasiKur(context, hedefOrigin, authOrigins, oturumGirdileri(oturum));
    }
    sayfa = await context.newPage();
  } catch (hata: unknown) {
    // Kurulum hatasında (ör. Chromium'un reddettiği oturum dosyası) tarayıcı kapanır, süreç asılı kalmaz.
    await context?.close().catch(() => undefined);
    await tarayici.close().catch(() => undefined);
    if (hata instanceof Error && oturum !== undefined) {
      hata.message = oturumMetinMaskesi(oturumGirdileri(oturum))(hata.message);
    }
    throw hata;
  }
  let giris: GirisSonucu | undefined;
  const izleyici = istekIzle(sayfa);
  // Keşifle aynı tavanlı durulma (bkz. `DURULMA`); yalnız hedef kökenindeki belgede beklenir.
  const durulsun = async (): Promise<void> => {
    await sayfaDurulsun(sayfa, izleyici, DURULMA.sayfaTavaniMs, hedefOrigin);
  };

  // Giriş yalnız yönlendirme olduğunda denenir; hedef sayfadaki bir parola
  // alanı (örn. "şifre değiştir" formu) giriş sanılmasın.
  // Ayrı giriş sitesine (SSO) yönlendirmede yol aynı olsa da origin farklıdır; o da yönlendirmedir.
  const kokenDisi = (adres: string): boolean => {
    try {
      return new URL(adres).origin !== hedefOrigin;
    } catch {
      return true;
    }
  };
  const yerindeMi = (): boolean => {
    const adres = new URL(sayfa.url());
    return adres.origin === hedefOrigin && adres.pathname === beklenenYol;
  };
  /** Son `goto(hedef)` sunucu yönlendirmesiyle başka yola vardıysa true (0.7.0'daki gibi reddedilir). */
  let sunucuYonlendirdi = false;
  const hedefeGit = async (): Promise<void> => {
    await sayfa.goto(hedef, { waitUntil: 'domcontentloaded', timeout: sayfaZamanAsimiMs });
    sunucuYonlendirdi = !yerindeMi();
    // SPA'nın istemci yönlendirmesi (ör. girişe) ancak çizimden sonra görünür.
    await durulsun();
  };

  try {
    await hedefeGit();

    // Aynı kökende ve YALNIZ çizimden sonra (istemci tarafında) başka yola yönlenme, varılan sayfada
    // giriş formu yoksa uygulama içidir (SPA rotası `/projects/2` → `/projects/2/9`); keşif de böyle
    // kaydeder, kabul edilir. Sunucu yönlendirmesi (yol jeton taşıyabilir) ve giriş formu reddedilir.
    const kabulEdilir = async (): Promise<boolean> => {
      if (yerindeMi()) return true;
      if (sunucuYonlendirdi || new URL(sayfa.url()).origin !== hedefOrigin) return false;
      return await sinirli(girisFormuBul(sayfa), sayfaZamanAsimiMs, 'login form check') === null;
    };
    if (secenekler.kimlik !== undefined && !(await kabulEdilir())) {
      if (secenekler.loginUrl !== undefined) {
        await sayfa.goto(secenekler.loginUrl, { waitUntil: 'domcontentloaded', timeout: sayfaZamanAsimiMs });
      }
      const form = await girisFormuBul(sayfa);
      if (form) {
        giris = await girisiGonder(sayfa, form, secenekler.kimlik, hedefOrigin, authOrigins);
        // Reddedilen girişin durumu (parolayı depolamaya koymuş olabilir) diske yazılmaz.
        // Reddedildiyse önceki (bayat) oturum dosyası da kaldırılır.
        if (giris.basarili) await oturumDurumunuYaz(context, secenekler.storageStateYolu);
        else await oturumDurumunuSil(secenekler.storageStateYolu);
        await hedefeGit();
      }
    }

    // Başka kökene yönlenmede oturum suçlanmaz; varılan adres (jeton taşıyabilir) yazılmaz.
    const baskaKoken = (): Error =>
      new Error(`Page could not be refreshed: asked for ${beklenenYol}, the page moved to another origin`);
    const varilan = new URL(sayfa.url());
    if (!(await kabulEdilir())) {
      if (varilan.origin !== hedefOrigin) throw baskaKoken();
      // Yeniden giriş reddedildiyse sayfanın gösterdiği uyarı (maskeli, etiketli) mesaja eklenir.
      const not = giris?.basarili === false ? girisSayfaMesajiNotu(giris.sayfaMesaji) : '';
      throw new Error(
        `Page could not be refreshed: asked for ${beklenenYol}, got ${varilan.pathname} (the session may have expired)${not === '' ? '' : `.${not}`}`,
      );
    }
    const maske = haritaMaskesi(oturum === undefined ? [] : oturumDegerleri(oturum), secenekler.kimlik?.password);
    // Özet penceresinde ana çerçevede yabancı kökenli bir belge bir kez bile yerleştiyse (sonra hedefe
    // dönse de) özet reddedilir: son URL'ye bakmak A → yabancı → A dönüşünü kaçırır. Kapalı güvenli:
    // bu pencerede sessiz SSO dönüşü de yenilemeyi düşürür.
    let yabanciGoruldu = false;
    let belgeDegisti: () => void = () => undefined;
    const belgeDegisimi = new Promise<void>((coz) => { belgeDegisti = coz; });
    const gezinmeyiDinle = (cerceve: Frame): void => {
      if (cerceve !== sayfa.mainFrame()) return;
      if (kokenDisi(cerceve.url())) yabanciGoruldu = true;
      belgeDegisti();
    };
    const yabanciyaGecti = (): boolean => yabanciGoruldu || kokenDisi(sayfa.url());
    sayfa.on('framenavigated', gezinmeyiDinle);
    try {
      let hamOzet: Sayfa;
      try {
        // Ana iş parçacığı kilitlenen sayfa yenilemeyi asılı bırakmaz.
        hamOzet = await sinirli(sayfaOzeti(sayfa, hedefOrigin), sayfaZamanAsimiMs, 'page summary');
      } catch (hata: unknown) {
        // Durulmadan sonra gelen istemci yönlendirmesi özeti yarıda keserse Playwright "Execution context
        // was destroyed" verir; bu hata `sayfa.url()` yeni belgeye geçmeden birkaç ms önce gelir. Yeni
        // belgenin yerleşmesi (tavanlı) beklenir, karar yine köken denetimine gider.
        if (!(hata instanceof PageNotRespondingError)) {
          let zamanlayici: NodeJS.Timeout | undefined;
          await Promise.race([belgeDegisimi, new Promise<void>((coz) => { zamanlayici = setTimeout(coz, DURULMA.iptalTavaniMs); })]);
          clearTimeout(zamanlayici);
        }
        if (yabanciyaGecti()) throw baskaKoken();
        throw hata;
      }
      const ozet = maske.bos ? hamOzet : sayfaMetinleriniGizle(hamOzet, maske);
      await girisKorumasiSonDenetim(context);
      // Dönüşten hemen önce: özet sırasında ya da sonra başka kökene geçildiyse özet atılır (keşifteki gibi).
      if (yabanciyaGecti()) throw baskaKoken();
      return ozet;
    } finally {
      sayfa.off('framenavigated', gezinmeyiDinle);
    }
  } catch (hata: unknown) {
    // Çalışma hatası (ör. `/login/<jeton>` yoluna yönlenme mesajı) da oturum değerlerinden arınır.
    if (oturum !== undefined && hata instanceof Error) {
      const koruma = girisKorumasiBul(context);
      const metin = oturumMetinMaskesi(oturumGirdileri(oturum))(hata.message);
      hata.message = koruma === undefined ? metin : koruma.metniGizle(metin);
    }
    throw hata;
  } finally {
    izleyici.birak();
    await context.close();
    await tarayici.close();
  }
}

/** Haritada verilen adrese yol eşleşmesiyle karşılık gelen sayfanın sırası; yoksa -1. */
function sayfaSirasi(harita: Harita, istenenUrl: string): number {
  const istenenYol = urlYolu(istenenUrl, harita.baseUrl);
  if (istenenYol === null) return -1;
  return harita.pages.findIndex((sayfa) => urlYolu(sayfa.url, harita.baseUrl) === istenenYol);
}

/** Haritadaki sayfayı yol eşleşmesiyle bulur; yoksa null. Tarayıcı gerekmez. */
export function haritadaSayfaBul(harita: Harita, istenenUrl: string): Sayfa | null {
  return harita.pages[sayfaSirasi(harita, istenenUrl)] ?? null;
}

/**
 * Haritadaki tek sayfayı yerinde değiştirir; diğer sayfalara dokunmaz.
 * Eşleşme yol (pathname) üzerinden yapılır, analiz tarafındaki kıyasla aynı.
 * Sayfa haritada yoksa null döner.
 */
export function haritadaSayfayiDegistir(
  harita: Harita,
  istenenUrl: string,
  yeniSayfa: Sayfa,
): { harita: Harita; eskiSayfa: Sayfa } | null {
  const sira = sayfaSirasi(harita, istenenUrl);
  const eskiSayfa = harita.pages[sira];
  if (sira < 0 || eskiSayfa === undefined) return null;

  const sayfalar = [...harita.pages];
  sayfalar[sira] = yeniSayfa;
  return {
    harita: { ...harita, pages: sayfalar, exploredAt: new Date().toISOString() },
    eskiSayfa,
  };
}
