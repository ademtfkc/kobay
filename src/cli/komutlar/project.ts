import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  KobayDizini,
  type BeyinAyari,
  type Kimlik,
  type KimlikIslemi,
  type KobayConfig,
} from '../../depo/index.js';
import { loginUrlDogrula } from '../../kesif/oturum.js';
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

function urlDogrula(url: string): void {
  try {
    new URL(url);
  } catch {
    throw new UsageError(`Invalid URL: ${url}`);
  }
}

type BeyinGirdisi = Partial<BeyinAyari>;

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
  yeniBaseUrl: string,
): Promise<KimlikIslemi | null> {
  const yeniOrigin = new URL(yeniBaseUrl).origin;
  const kimlik = await dizin.kimlikOku().catch(() => undefined);
  if (kimlik !== null && kimlik !== undefined && kimlik.origin === yeniOrigin) return null;
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
  return '; the target origin changed, so the saved credentials and session were deleted —'
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
    `Target: ${a.config.baseUrl}`,
    `Brain: ${a.config.brain.adaptor}${beyinAyrintisi.length === 0 ? '' : ` (${beyinAyrintisi.join(', ')})`}`,
    ...(a.config.loginUrl === undefined ? [] : [`Login page: ${a.config.loginUrl}`]),
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
    urlDogrula(a.url);
    if (a.loginUrl !== undefined) {
      urlDogrula(a.loginUrl);
      try {
        loginUrlDogrula(a.url, a.loginUrl);
      } catch (hata) {
        throw new UsageError(hata instanceof Error ? hata.message : String(hata));
      }
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
    };
    // --force yalnız config’i yeniden yazar; harita, test ve koşu verisine dokunmaz.
    const dizin = mevcut ?? await KobayDizini.ac(a.cwd, config);
    const yeniKimlik = a.login === undefined ? undefined : { ...a.login, origin: new URL(a.url).origin };
    let silinen: string[] = [];
    if (mevcut === null) {
      if (yeniKimlik !== undefined) await dizin.kimlikYaz(yeniKimlik);
    } else {
      // İşlem gibi: eski giriş bilgisi/oturumu önce kenara alınır, config ve yeni
      // kimlik yazıldıktan sonra silinir. Arada bir adım düşerse hepsi geri gelir.
      const islem = a.login === undefined
        ? await yabanciKimligiKenaraAl(mevcut, eskiConfig, a.url)
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
}): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    if (a.url === undefined && a.docs === undefined && a.loginUrl === undefined && a.beyin === undefined) {
      throw new UsageError(
        'No field to update; pass --base-url, --login-url, --docs-path, or --brain/--model/--effort',
      );
    }
    if (a.url !== undefined) urlDogrula(a.url);
    if (a.loginUrl !== undefined) urlDogrula(a.loginUrl);
    if (a.docs !== undefined) await belgeYoluDenetle(dizin.projeKoku, a.docs, 'docsPath');
    const mevcut = await dizin.configOku();
    const config: KobayConfig = {
      ...mevcut,
      ...(a.url === undefined ? {} : { baseUrl: a.url }),
      ...(a.docs === undefined ? {} : { docsPath: a.docs }),
      ...(a.loginUrl === undefined ? {} : { loginUrl: a.loginUrl }),
      // Beyin alanları tek tek birleşir: verilmeyen alan (tavanlar dahil) mevcut ayarda kalır.
      brain: beyinBirlestir(mevcut.brain, a.beyin),
    };
    try {
      loginUrlDogrula(config.baseUrl, config.loginUrl);
    } catch (hata) {
      throw new UsageError(hata instanceof Error ? hata.message : String(hata));
    }
    // İşlem gibi: eski origin'in giriş bilgisi/oturumu önce kenara alınır, yeni
    // hedef yazıldıktan sonra silinir. Config yazımı düşerse ikisi de geri gelir.
    const islem = a.url === undefined ? null : await yabanciKimligiKenaraAl(dizin, mevcut, config.baseUrl);
    try {
      await dizin.configYaz(config);
      // Kesinleştirmenin yalnız doğrulama aşaması buraya hata taşır: kenara
      // alınan dosya yerinde değilse yeni config kalıcı olmaz, eski hedef
      // atomik olarak geri yazılır. Kesinleşmeden sonraki silme hatası işlemi
      // düşürmez; kalıntı uyarıyla bırakılır, sonraki komut toparlar.
      await islem?.kesinlestir();
    } catch (hata) {
      // Geri alma tek dayanıklı yordamda: önce config, sonra kenara alınan
      // kopyalar. Config geri yazımı düşerse kopyalar geri KONMAZ, işaret
      // korunur ve komut açık bir geri alma hatasıyla durur; sonraki komutun
      // kurtarması aynı sırayla yeniden dener.
      if (islem === null) {
        await dizin.configYaz(mevcut).catch(() => undefined);
      } else {
        await islem.geriAl({ configYazildi: true, asilHata: hata });
      }
      throw hata;
    }
    const silinen = islem?.adlar ?? [];
    return basariliMetin(
      { root: dizin.kok, config, ...(silinen.length === 0 ? {} : { invalidated: silinen }) },
      projeOzeti({
        baslik: 'Project updated',
        kok: dizin.kok,
        config,
        silinen,
        // Hedef değiştiyse eski harita yanlıştır; önce yeniden keşif gerekir.
        sonraki: a.url === undefined ? 'kobay project get' : 'kobay explore',
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
