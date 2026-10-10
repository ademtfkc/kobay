import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  KobayDizini,
  SchemaError,
  adresKimligiGizle,
  authOriginleriDogrula,
  type BeyinAyari,
  type Kimlik,
  type KimlikIslemi,
  type KobayConfig,
} from '../../depo/index.js';
import { kimlikOriginDogrula, loginUrlDogrula } from '../../kesif/oturum.js';
import { UsageError, basarili, basariliMetin, komutCalistir, type KomutSonucu } from '../komut.js';
import { belgeYoluDenetle, dizinBul } from './ortak.js';

function beyinAyariMi(deger: unknown): deger is BeyinAyari {
  if (typeof deger !== 'object' || deger === null || !('adaptor' in deger)) return false;
  const ayar = deger as Record<string, unknown>;
  return ['claude', 'codex', 'openrouter', 'sahte'].includes(String(ayar.adaptor))
    && (ayar.model === undefined || typeof ayar.model === 'string')
    && (ayar.effort === undefined || typeof ayar.effort === 'string');
}

async function varsayilanBeyinOku(): Promise<BeyinAyari> {
  try {
    const veri = JSON.parse(await readFile(join(homedir(), '.kobay', 'config.json'), 'utf8')) as unknown;
    if (typeof veri === 'object' && veri !== null) {
      // 0.1 küresel ayarı `beyin` yazıyordu; okuma toleransı kalıcı dosyalardaki gibi.
      const kayit = veri as Record<string, unknown>;
      const ayar = kayit.brain ?? kayit.beyin;
      if (beyinAyariMi(ayar)) return ayar;
    }
    throw new UsageError('The global Kobay config is invalid; run `kobay setup` again');
  } catch (hata: unknown) {
    if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') return { adaptor: 'claude' };
    if (hata instanceof SyntaxError) {
      throw new UsageError('The global Kobay config is not valid JSON; run `kobay setup` again');
    }
    throw hata;
  }
}

const URL_IPUCU = 'Use an http:// or https:// URL, e.g. http://localhost:3000';

/**
 * Hedef ve giriş adresi yalnız http(s) olabilir. `new URL()` tek başına yetmez:
 * `localhost:3000` şemasız yazımı `localhost:` şemalı geçerli URL sayılır,
 * `ftp://` de geçer; ikisi de sonra yanıltıcı "not reachable" hatasına döner.
 */
function urlDogrula(url: string): void {
  // Ham değer config'e ve çıktıya aynen yazılır; ayrıştırıcının sessizce
  // attığı satır sonu/tab ya da boşluk saklanan değeri bozmasın.
  if ([...url].some((harf) => harf <= ' ' || harf === '\u007f')) {
    throw new UsageError(`Invalid URL: ${JSON.stringify(adresKimligiGizle(url))}. ${URL_IPUCU}`);
  }
  let protokol: string;
  try {
    protokol = new URL(url).protocol;
  } catch {
    throw new UsageError(`Invalid URL: ${adresKimligiGizle(url)}. ${URL_IPUCU}`);
  }
  // `http:example.com` ve `http:/example.com` de `http:` ayrışır; ham yazım `//` taşımalı.
  if ((protokol !== 'http:' && protokol !== 'https:') || !/^https?:\/\//i.test(url)) {
    throw new UsageError(`Unsupported URL scheme: ${adresKimligiGizle(url)}. ${URL_IPUCU}`);
  }
}

type BeyinGirdisi = Partial<BeyinAyari>;

/** Auth origin listesini denetler; hatayı kullanıcı hatasına çevirir. */
function authOriginleriAl(baseUrl: string, girdiler: readonly string[]): string[] {
  try {
    return authOriginleriDogrula(baseUrl, girdiler);
  } catch (hata) {
    throw new UsageError(hata instanceof Error ? hata.message : String(hata));
  }
}

/** loginUrl yalnız baseUrl origin'inde ya da onaylanan auth origin'lerden birinde olabilir. */
function loginUrlDenetle(baseUrl: string, loginUrl: string | undefined, authOrigins: readonly string[]): void {
  try {
    loginUrlDogrula(baseUrl, loginUrl, authOrigins);
  } catch (hata) {
    throw new UsageError(hata instanceof Error ? hata.message : String(hata));
  }
}

/**
 * Parolanın gidebileceği küme yalnız kullanıcı kimliği yeniden girerken genişler/değişir:
 * `--auth-origin` ve `--clear-auth-origins` `--login` olmadan reddedilir.
 */
function authOriginBayraklariniDenetle(a: { login?: Kimlik; authOrigins?: readonly string[]; clearAuthOrigins?: boolean }): void {
  const listeVar = a.authOrigins !== undefined && a.authOrigins.length > 0;
  if (listeVar && a.clearAuthOrigins === true) {
    throw new UsageError('--auth-origin and --clear-auth-origins cannot be used together');
  }
  if (a.login !== undefined) return;
  if (listeVar) {
    throw new UsageError(
      '--auth-origin requires --login: the list of sites that may receive the password is only changed'
      + ' while you re-enter the credentials',
    );
  }
  if (a.clearAuthOrigins === true) throw new UsageError('--clear-auth-origins requires --login');
}

/** Kimlik yeni config'in hedefine ve auth origin kümesine birebir bağlı mı? */
function kimlikConfigeUyarMi(kimlik: Kimlik, config: KobayConfig): boolean {
  try {
    kimlikOriginDogrula(kimlik, new URL(config.baseUrl).origin, config.authOrigins ?? []);
    return true;
  } catch {
    return false;
  }
}

/** Auth origin listesini yeniden vermenin iki açık yolu; her ipucu bunu önerir (çıplak `--login` değil). */
const LISTEYI_YENIDEN_VER = 'give the full list again with `kobay project update --login --auth-origin <origin>`'
  + ' (repeat --auth-origin for each separate login site), or remove it with'
  + ' `kobay project update --login --clear-auth-origins`';

/**
 * `update --login` auth origin listesi verilmeden çağrıldı: config'teki liste ANCAK kayıtlı kimliğin
 * kilitlediği listeyle birebir aynıysa korunur (değişiklik yok demektir). Kimlik yoksa, okunamıyorsa
 * ya da liste kilitten farklıysa (ör. `config.json` elle büyütüldüyse) liste sorgusuz benimsenmez:
 * parolanın gidebileceği yer yalnız kullanıcının komut satırında açıkça verdiği listeyle değişir.
 */
async function korunanListeyiDenetle(dizin: KobayDizini, mevcut: KobayConfig): Promise<void> {
  const liste = mevcut.authOrigins ?? [];
  if (liste.length === 0) return;
  const kimlik = await dizin.kimlikOku().catch(() => null);
  if (kimlik !== null && kimlikConfigeUyarMi(kimlik, mevcut)) return;
  throw new UsageError(
    `--login without --auth-origin keeps the auth origin list only if the saved credentials already approved it;`
    + ` config.json lists ${liste.join(', ')}, which ${kimlik === null ? 'no saved credentials approve' : 'the saved credentials did not approve'}.`
    + ` Nothing was changed; ${LISTEYI_YENIDEN_VER}`,
  );
}

/** Kimlik dosyasına yazılacak kayıt: origin kilidi + onaylanan auth origin'ler. */
function kimlikKaydi(giris: Kimlik, config: KobayConfig): Kimlik {
  return {
    username: giris.username,
    password: giris.password,
    origin: new URL(config.baseUrl).origin,
    ...(config.authOrigins === undefined || config.authOrigins.length === 0 ? {} : { authOrigins: [...config.authOrigins] }),
  };
}

/** Mevcut beyin ayarının tüm alanlarını (tavanlar dahil) korur; yalnız verilen alanlar üstüne yazılır. */
function beyinBirlestir(mevcut: BeyinAyari, verilen: BeyinGirdisi | undefined): BeyinAyari {
  const sonuc: BeyinAyari = { ...mevcut };
  for (const [anahtar, deger] of Object.entries(verilen ?? {})) {
    if (deger !== undefined) Object.assign(sonuc, { [anahtar]: deger });
  }
  return sonuc;
}

/**
 * Hedef origin'i değişen projede giriş bilgisini ve oturum durumunu geçersiz
 * kılmaya hazırlar: parola ve çerezler yeni origin'e taşınmaz. Kayıtlı kimlik
 * zaten yeni origin'e bağlıysa dokunulmaz (`null` döner). Dosyalar silinmez,
 * kenara alınır; çağıran config'i yazdıktan sonra işlemi kesinleştirir.
 *
 * `eskiConfig` işlem işaretine yazılır: süreç config'i yazdıktan sonra ölürse
 * sonraki komutun kurtarması hem config'i hem dosyaları bu kayıttan geri alır.
 * Okunamamışsa `null` geçilir; o zaman otomatik geri koyma yapılmaz.
 */
async function yabanciKimligiKenaraAl(
  dizin: KobayDizini,
  eskiConfig: KobayConfig | null,
  yeniConfig: KobayConfig,
): Promise<KimlikIslemi | null> {
  const yeniOrigin = new URL(yeniConfig.baseUrl).origin;
  const kimlik = await dizin.kimlikOku().catch(() => undefined);
  // Auth origin kümesi de kilidin parçası: küme değiştiyse kimlik yeni config'e taşınmaz.
  if (kimlik !== null && kimlik !== undefined && kimlikConfigeUyarMi(kimlik, yeniConfig)) return null;
  let eskiOrigin: string | undefined;
  try {
    eskiOrigin = eskiConfig === null ? undefined : new URL(eskiConfig.baseUrl).origin;
  } catch {
    eskiOrigin = undefined;
  }
  // Kimlik yoksa ve origin değişmediyse korunacak/silinecek bir şey yok.
  if (kimlik === null && eskiOrigin === yeniOrigin) return null;
  return dizin.kimlikVeOturumuKenaraAl({ eskiConfig });
}

function silinmeNotu(silinen: string[]): string {
  if (!silinen.includes('credentials.json')) return '';
  return '; the target origin or the auth origins changed, so the saved credentials and session were deleted —'
    + ' if login is needed, re-enter them with `kobay project create --url <URL> --login --force`';
}

/**
 * İnsan modunda config dökümü yerine basılan özet. Kimliği taşıyan alanlar
 * (proje yolu, hedef, beyin, giriş/belge yolu) tek tek satıra yazılır; JSON
 * modu (`--output json`) aynı gövdeyi eksiksiz verir.
 */
function projeOzeti(a: {
  baslik: string;
  kok: string;
  config: KobayConfig;
  silinen: string[];
  ekSatirlar?: string[];
  sonraki: string;
}): string {
  const beyinAyrintisi = [
    ...(a.config.brain.model === undefined ? [] : [`model: ${a.config.brain.model}`]),
    ...(a.config.brain.effort === undefined ? [] : [`effort: ${a.config.brain.effort}`]),
  ];
  return [
    `${a.baslik}: ${a.kok}`,
    `Target: ${adresKimligiGizle(a.config.baseUrl)}`,
    `Brain: ${a.config.brain.adaptor}${beyinAyrintisi.length === 0 ? '' : ` (${beyinAyrintisi.join(', ')})`}`,
    ...(a.config.loginUrl === undefined ? [] : [`Login page: ${adresKimligiGizle(a.config.loginUrl)}`]),
    ...(a.config.authOrigins === undefined ? [] : [`Auth origins: ${a.config.authOrigins.join(', ')}`]),
    ...(a.config.docsPath === undefined ? [] : [`Document: ${a.config.docsPath}`]),
    ...(a.ekSatirlar ?? []),
    ...(a.silinen.length === 0 ? [] : [`Invalidated: ${a.silinen.join(', ')}${silinmeNotu(a.silinen)}`]),
    `Next: ${a.sonraki}`,
  ].join('\n');
}

export async function projectCreate(a: {
  cwd: string;
  url: string;
  docs?: string;
  login?: Kimlik;
  loginUrl?: string;
  /** Ayrı giriş (SSO) origin'leri; yalnız `login` ile birlikte kabul edilir. MCP bu alanı geçmez. */
  authOrigins?: string[];
  /** Verilen alanlar; --force ile mevcut beyin ayarının üstüne yazılır, tavanlar korunur. */
  beyin?: BeyinGirdisi;
  force?: boolean;
}): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const mevcut = await KobayDizini.bul(a.cwd);
    if (mevcut !== null && a.force !== true) {
      throw new UsageError(
        'This project already exists; run `kobay project get` for details, `kobay project update` to change a field,'
        + ' or `kobay project create --force` to reset the config',
      );
    }
    authOriginBayraklariniDenetle(a);
    urlDogrula(a.url);
    const authOrigins = authOriginleriAl(a.url, a.authOrigins ?? []);
    if (a.loginUrl !== undefined) {
      urlDogrula(a.loginUrl);
      loginUrlDenetle(a.url, a.loginUrl, authOrigins);
    }
    const projeKoku = mevcut?.projeKoku ?? a.cwd;
    if (a.docs !== undefined) await belgeYoluDenetle(projeKoku, a.docs, 'docs');
    // --force: mevcut beyin ayarı (maliyet tavanları dahil) temel alınır; okunamıyorsa varsayılana düşülür.
    const eskiConfig = mevcut === null ? null : await mevcut.configOku().catch(() => null);
    const temelBeyin = eskiConfig?.brain
      ?? (a.beyin?.adaptor === undefined ? await varsayilanBeyinOku() : { adaptor: a.beyin.adaptor });
    const config: KobayConfig = {
      baseUrl: a.url,
      brain: beyinBirlestir(temelBeyin, a.beyin),
      ...(a.docs === undefined ? {} : { docsPath: a.docs }),
      ...(a.loginUrl === undefined ? {} : { loginUrl: a.loginUrl }),
      ...(authOrigins.length === 0 ? {} : { authOrigins }),
    };
    // --force yalnız config’i yeniden yazar; harita, test ve koşu verisine dokunmaz.
    const dizin = mevcut ?? await KobayDizini.ac(a.cwd, config);
    const yeniKimlik = a.login === undefined ? undefined : kimlikKaydi(a.login, config);
    let silinen: string[] = [];
    if (mevcut === null) {
      if (yeniKimlik !== undefined) await dizin.kimlikYaz(yeniKimlik);
    } else {
      // İşlem gibi: eski giriş bilgisi/oturumu önce kenara alınır, config ve yeni
      // kimlik yazıldıktan sonra silinir. Arada bir adım düşerse hepsi geri gelir.
      const islem = a.login === undefined
        ? await yabanciKimligiKenaraAl(mevcut, eskiConfig, config)
        : await mevcut.kimlikVeOturumuKenaraAl({ eskiConfig, yeniKimlikYazilacak: true });
      try {
        await mevcut.configYaz(config);
        if (yeniKimlik !== undefined) await mevcut.kimlikYaz(yeniKimlik);
        // Kesinleştirme de işlemin parçası, ama yalnız doğrulama aşaması:
        // kenara alınan dosya yerinde değilse komut hata dönüp yeni config'i
        // bırakmaz. Kesinleşmeden sonraki silme hatası işlemi düşürmez
        // (uyarılır, kalıntı sonraki komutta toparlanır) — yoksa yarım silinmiş
        // yedekle geri almaya girip eski giriş bilgisini kaybederdik.
        await islem?.kesinlestir();
      } catch (hata) {
        // Geri almanın bütün adımları (config, kenara alınan kopyalar, --login
        // ile yazılan yeni kimlik) tek dayanıklı yordamda: bir adım düşerse
        // sonrakine geçilmez, işaret korunur ve komut geri alma hatasıyla
        // durur. Eskiden config geri yazımının hatası yutuluyor, yedekler yine
        // de geri konuyor ve işaret siliniyordu: yeni config eski oturumun
        // yanında, düzeltecek iz olmadan kalıyordu.
        if (islem === null) {
          // Kenara alınan dosya yok (kimlik zaten yeni origin'e bağlı): geri
          // alınacak tek şey config ve atomik yazım düştüyse zaten değişmedi.
          if (eskiConfig !== null) await mevcut.configYaz(eskiConfig).catch(() => undefined);
        } else {
          await islem.geriAl({
            configYazildi: true,
            yeniKimlikYazildi: yeniKimlik !== undefined,
            asilHata: hata,
          });
        }
        throw hata;
      }
      // --login verildiyse kullanıcı yenisini koydu; "geçersiz kılındı" denmez.
      silinen = a.login === undefined ? islem?.adlar ?? [] : [];
    }
    return basariliMetin(
      { root: dizin.kok, config, ...(silinen.length === 0 ? {} : { invalidated: silinen }) },
      projeOzeti({
        baslik: mevcut === null ? 'Project created' : 'Project config overwritten',
        kok: dizin.kok,
        config,
        silinen,
        ...(a.login === undefined ? {} : { ekSatirlar: ['Credentials: saved'] }),
        sonraki: 'kobay explore',
      }),
    );
  });
}

export async function projectUpdate(a: {
  cwd: string;
  url?: string;
  docs?: string;
  loginUrl?: string;
  beyin?: BeyinGirdisi;
  /** Kimliği yeniden girer; auth origin listesini yalnız bununla birlikte değiştirmek mümkündür. */
  login?: Kimlik;
  /** Ayrı giriş (SSO) origin'lerinin TAM listesi (eskisinin yerine geçer); `login` şart. MCP geçmez. */
  authOrigins?: string[];
  /** Auth origin listesini boşaltır; `login` şart. */
  clearAuthOrigins?: boolean;
}): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    authOriginBayraklariniDenetle(a);
    const dizin = await dizinBul(a.cwd);
    if (
      a.url === undefined && a.docs === undefined && a.loginUrl === undefined && a.beyin === undefined
      && a.login === undefined
    ) {
      throw new UsageError(
        'No field to update; pass --base-url, --login-url, --docs-path, --login, or --brain/--model/--effort',
      );
    }
    if (a.url !== undefined) urlDogrula(a.url);
    if (a.loginUrl !== undefined) urlDogrula(a.loginUrl);
    if (a.docs !== undefined) await belgeYoluDenetle(dizin.projeKoku, a.docs, 'docsPath');
    const mevcut = await dizin.configOku().catch((hata: unknown) => {
      // Bozuk config (ör. elle yazılmış geçersiz `authOrigins`) burada düzeltilemez: alanlar
      // okunamadan birleştirilmez. Kurtarma yolu config'i baştan yazan `create --force`.
      if (hata instanceof SchemaError) {
        throw new UsageError(
          `${hata.message}. .kobay/config.json is invalid, so \`project update\` cannot change it (nothing was changed).`
          + ' Reset the config and re-enter the credentials with'
          + ' `kobay project create --url <URL> --login --force` (add --auth-origin <origin> for each separate'
          + ' login site, and --login-url, --docs and --brain again if you use them)',
        );
      }
      throw hata;
    });
    const yeniBaseUrl = a.url ?? mevcut.baseUrl;
    // Kimlik yeni hedefin origin'ine kilitlenir; elle bozulmuş hedefle parola kaydedilmez.
    if (a.login !== undefined) urlDogrula(yeniBaseUrl);
    let originDegisti: boolean;
    try {
      originDegisti = new URL(yeniBaseUrl).origin !== new URL(mevcut.baseUrl).origin;
    } catch {
      originDegisti = true;
    }
    // Liste yalnız --login ile verilir ya da boşaltılır. Hedef origin değişirse eski liste eski
    // uygulamaya aittir, taşınmaz (daraltma: parolanın gidebileceği yer büyümez). Çıplak --login
    // listeyi yalnız kayıtlı kimliğin kilidiyle birebir aynıysa korur.
    const listeVerildi = a.authOrigins !== undefined && a.authOrigins.length > 0;
    const listeKorunur = !listeVerildi && a.clearAuthOrigins !== true && !originDegisti;
    if (listeKorunur && a.login !== undefined) await korunanListeyiDenetle(dizin, mevcut);
    const authOrigins = listeVerildi
      ? authOriginleriAl(yeniBaseUrl, a.authOrigins ?? [])
      : listeKorunur ? mevcut.authOrigins ?? [] : [];
    const mevcutAlanlar: KobayConfig = { ...mevcut };
    delete mevcutAlanlar.authOrigins;
    const config: KobayConfig = {
      ...mevcutAlanlar,
      ...(a.url === undefined ? {} : { baseUrl: a.url }),
      ...(a.docs === undefined ? {} : { docsPath: a.docs }),
      ...(a.loginUrl === undefined ? {} : { loginUrl: a.loginUrl }),
      ...(authOrigins.length === 0 ? {} : { authOrigins }),
      // Beyin alanları tek tek birleşir: verilmeyen alan (tavanlar dahil) mevcut ayarda kalır.
      brain: beyinBirlestir(mevcut.brain, a.beyin),
    };
    loginUrlDenetle(config.baseUrl, config.loginUrl, authOrigins);
    const yeniKimlik = a.login === undefined ? undefined : kimlikKaydi(a.login, config);
    // İşlem gibi: eski origin'in giriş bilgisi/oturumu önce kenara alınır, yeni
    // hedef yazıldıktan sonra silinir. Config yazımı düşerse ikisi de geri gelir.
    // --login: eski kimlik ve oturum her durumda kenara alınır, yenisi yazılır.
    const islem = yeniKimlik !== undefined
      ? await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: mevcut, yeniKimlikYazilacak: true })
      : a.url === undefined ? null : await yabanciKimligiKenaraAl(dizin, mevcut, config);
    try {
      await dizin.configYaz(config);
      if (yeniKimlik !== undefined) await dizin.kimlikYaz(yeniKimlik);
      // Kesinleştirmenin yalnız doğrulama aşaması buraya hata taşır: kenara
      // alınan dosya yerinde değilse yeni config kalıcı olmaz, eski hedef
      // atomik olarak geri yazılır. Kesinleşmeden sonraki silme hatası işlemi
      // düşürmez; kalıntı uyarıyla bırakılır, sonraki komut toparlar.
      await islem?.kesinlestir();
    } catch (hata) {
      // Geri alma tek dayanıklı yordamda: önce config, sonra kenara alınan
      // kopyalar, en sonda --login'in yazdığı yeni kimlik. Config geri yazımı
      // düşerse kopyalar geri KONMAZ, işaret korunur ve komut açık bir geri
      // alma hatasıyla durur; sonraki komutun kurtarması aynı sırayla yeniden dener.
      if (islem === null) {
        await dizin.configYaz(mevcut).catch(() => undefined);
      } else {
        await islem.geriAl({ configYazildi: true, yeniKimlikYazildi: yeniKimlik !== undefined, asilHata: hata });
      }
      throw hata;
    }
    // --login verildiyse kullanıcı yenisini koydu; "geçersiz kılındı" denmez.
    const silinen = yeniKimlik === undefined ? islem?.adlar ?? [] : [];
    const listeDustu = originDegisti && a.login === undefined && (mevcut.authOrigins?.length ?? 0) > 0;
    return basariliMetin(
      { root: dizin.kok, config, ...(silinen.length === 0 ? {} : { invalidated: silinen }) },
      projeOzeti({
        baslik: 'Project updated',
        kok: dizin.kok,
        config,
        silinen,
        ekSatirlar: [
          ...(yeniKimlik === undefined ? [] : ['Credentials: saved']),
          ...(listeDustu ? ['Auth origins: cleared because the target origin changed'] : []),
        ],
        // Hedef değiştiyse eski harita yanlıştır; önce yeniden keşif gerekir.
        sonraki: a.url === undefined && yeniKimlik === undefined ? 'kobay project get' : 'kobay explore',
      }),
    );
  });
}

export async function projectGet(a: { cwd: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    const [config, testler, harita] = await Promise.all([
      dizin.configOku(),
      dizin.testListele(),
      dizin.haritaOku(),
    ]);
    return basarili({ config, testCount: testler.length, hasMap: harita !== null });
  });
}
