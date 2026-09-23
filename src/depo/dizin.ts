import {
  access, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import type {
  Harita,
  HataPaketi,
  Kimlik,
  KobayConfig,
  KosuSonucu,
  Oneri,
  TestKaydi,
} from './tipler.js';
import {
  HaritaSemasi,
  HataPaketiSemasi,
  KimlikSemasi,
  KobayConfigSemasi,
  KosuSonucuSemasi,
  OneriSemasi,
  TestKaydiSemasi,
} from './semalar.js';
import { DosyaYok, jsonOku, yazAtomik } from './dosya.js';

export class PaketYarim extends Error {
  constructor(testId: string) {
    super(`Hata paketi yarım: ${testId}`);
    this.name = 'PaketYarim';
  }
}

/** Depo içindeki test ve koşu yollarına yalnız üretilen kimlikler girebilir. */
export class GecersizKimlik extends Error {
  constructor(kimlik: string, tur: 'testId' | 'runId') {
    super(`Geçersiz ${tur}: ${kimlik}`);
    this.name = 'GecersizKimlik';
  }
}

/**
 * Sabit hata paketi çıkışı (`.kobay/failure-out/<testId>`) symlink üzerinden
 * depo dışını gösteriyor. Yerinde yenileme eskisini silerek çalıştığı için
 * böyle bir yolda hiç çalışmaz: kötü niyetli bir klon `.kobay/` içine dışarıyı
 * gösteren bir bağ koyup kök dışındaki klasörü sildiremesin.
 */
export class GuvensizCikisYolu extends Error {
  constructor(yol: string, sebep: string) {
    super(
      `Güvenli olmayan hata paketi çıkışı: ${yol} (${sebep}).`
      + ' `.kobay/failure-out` altındaki bağı kaldırın ya da `--out <klasör>` ile başka bir hedef verin.',
    );
    this.name = 'GuvensizCikisYolu';
  }
}

/**
 * Kimlik işlemi kesinleşme noktasına varamadı: kenara alınan dosya yerinde
 * değil ya da işlem işareti başka bir sürece geçmiş. Sessizce "başarılı"
 * denmez; kullanıcı hangi komutla durumu düzelteceğini görür.
 */
export class KimlikIslemiBozuldu extends Error {
  constructor(neden: string) {
    super(
      `Kimlik işlemi bozuldu: ${neden}.`
      + ' Aynı projede ikinci bir kobay süreci çalışmış olabilir;'
      + ' `kobay project get` ile hedefi doğrulayın, giriş gerekiyorsa'
      + ' `kobay project create --url <URL> --login --force` ile yeniden verin.',
    );
    this.name = 'KimlikIslemiBozuldu';
  }
}

/**
 * Yarım kalan bir kimlik işleminin geri alınması tamamlanamadı: config işlem
 * öncesi hâline yazılamadı ya da kenara alınan kopya asıl adına konamadı.
 * Hata yutulmaz — o an proje tutarsızdır (yeni config eski oturumun yanında)
 * ve yutulursa düzeltecek iz kalmaz. İşaret dosyası bilerek korunur: sonraki
 * kobay komutu aynı sırayla yeniden dener. Çıkış kodu motor hatasıdır (4):
 * kullanıcının komutunda değil, dosya sisteminde bir sorun var.
 */
export class KimlikGeriAlinamadi extends Error {
  constructor(neden: string, asilHata?: unknown) {
    super(
      `Kimlik işlemi geri alınamadı: ${neden}.`
      + ' Geri alma tamamlanamadı; `.kobay/.kimlik-islemi` işareti ve kenara alınan'
      + ' kopyalar korundu, sonraki kobay komutu geri almayı yeniden deneyecek.'
      + ' Nedenini (disk alanı, dosya izni, salt okunur dosya sistemi) düzeltip'
      + ' komutu yeniden çalıştırın.'
      + (asilHata === undefined
        ? ''
        : ` Geri almayı tetikleyen asıl hata: ${asilHata instanceof Error ? asilHata.message : String(asilHata)}.`),
    );
    this.name = 'KimlikGeriAlinamadi';
  }
}

/**
 * Aynı projede yürüyen bir kimlik işlemi varken ikinci bir komut kimliği
 * değiştirmeye kalktı. İşaret dosyası tek sahipli bir kilittir: ikinci komut
 * beklemez, reddedilir (çıkış 2 — kullanıcı komutu yeniden çalıştırır).
 */
export class KimlikIslemiYurumede extends Error {
  constructor(sahip?: { pid: number; baslatildi: string }) {
    super(
      'Başka bir kobay komutu bu projenin kimliğini değiştiriyor'
      + (sahip === undefined ? '' : ` (pid ${sahip.pid}, başlangıç ${sahip.baslatildi})`)
      + '; bitmesini bekleyip komutu yeniden çalıştırın.'
      + ' O süreç artık çalışmıyorsa işaret en geç 10 dakika içinde düşer;'
      + ' dilerseniz `.kobay/.kimlik-islemi` dosyasını elle silebilirsiniz.',
    );
    this.name = 'KimlikIslemiYurumede';
  }
}

const TEST_KIMLIGI = /^t_[a-z0-9]{8}$/;
const KOSU_KIMLIGI = /^r_\d{14}_[a-z0-9]{4}$/;
const PaketMetaSemasi = v.object({ snapshotId: v.string() });
/** Paketin hangi koşuyu gösterdiğini okumak için; paketin geri kalanı doğrulanmaz. */
const PaketKosuSemasi = v.object({ runId: v.string() });

/** Test başına `.kobay/runs/` altında saklanan koşu dizini sayısı; eskisi budanır. */
export const SAKLANAN_KOSU = 5;

/**
 * Eşzamanlı koşuların kanıtı silinmesin diye "taze" sayılan koşu penceresi:
 * bu süre içinde biten koşunun analizi daha başlamamış olabilir, budanmaz.
 */
export const TAZE_KOSU_MS = 10 * 60 * 1000;

/** `kosulariBuda` ayarları; hepsi isteğe bağlı. */
export type BudamaSecenekleri = {
  /** En yeni kaç koşu her hâlükârda kalsın (varsayılan `SAKLANAN_KOSU`). */
  sakla?: number;
  /** Kimliği burada olan koşu, listenin neresinde olursa olsun silinmez. */
  korunanlar?: Iterable<string>;
  /** Bu kadar milisaniye içinde biten koşu taze sayılır (varsayılan `TAZE_KOSU_MS`). */
  tazeMs?: number;
};

/** Zaman damgası okunamıyorsa koşu taze sayılır: kanıt kaybı disk israfından ağırdır. */
function kosuTazeMi(sonuc: KosuSonucu, esikMs: number): boolean {
  const zaman = Date.parse(sonuc.finishedAt);
  return Number.isNaN(zaman) || zaman >= esikMs;
}

/**
 * Bir testin varsayılan hata paketi çıkış klasörü. Sabittir: aynı test için her
 * `failure get` aynı yere yazar, yeni paket eskisini yerinde değiştirir.
 */
export function hataPaketiCikisYolu(projeKoku: string, testId: string): string {
  return resolve(projeKoku, '.kobay', 'failure-out', testId);
}

const GITIGNORE_SATIRLARI = [
  'credentials.json',
  'runs/',
  'storageState.json',
  // Yarım kalmış kimlik işleminden kalan kopya da parola taşır; git'e girmesin.
  '.eski-*',
  // Yürüyen kimlik işleminin işaret dosyası ve devralma kopyası; yalnız bu makineyi ilgilendirir.
  '.kimlik-islemi*',
  '*.log',
  'failure/',
  'failure-out/',
  'logs/',
  'tests/_fixture.ts',
  'test-results/',
  'playwright-report/',
  'blob-report/',
];

/**
 * Kobay'ın kendi yazdığı alt dizinler. Hepsi `.gitignore` bloğunda dışlanır ya
 * da boş kalabilir; bu yüzden klonlanan projede gelmezler ve her açılışta
 * yeniden kurulmaları gerekir.
 */
const KOBAY_ALT_DIZINLERI = ['plan', 'tests', 'runs', 'failure', 'failure-out', 'logs'] as const;

/** Hedef origin değişince geçersiz kılınan gizli dosyalar. */
const KIMLIK_DOSYALARI = ['credentials.json', 'storageState.json'] as const;

/**
 * Kenara alınan kimlik/oturum kopyasının adı: `.eski-<islemId>-<asıl ad>`.
 * Ad işlemin kimliğini taşır; kurtarma böylece yalnız kendi sahiplendiği
 * işlemin kalıntısını toparlar, başkasınınkine dokunmaz.
 */
const KENARA_ONEKI = '.eski-';
const KENARA_DESENI = /^\.eski-([0-9a-f-]{36})-(credentials\.json|storageState\.json)$/;

/**
 * Yürüyen kimlik işleminin işaret dosyası; tek sahipli kilittir. `O_EXCL` ile
 * oluşturulur: taze bir işaret varken ikinci komut kimliği değiştiremez
 * (`KimlikIslemiYurumede`). Kesinleştirme ve geri alma işareti yalnız geriye
 * kalıntı kalmadıysa siler; kalıntı kaldıysa işaret (kesinleşme durumuyla
 * birlikte) kurtarmaya bilgi taşısın diye yerinde bırakılır.
 */
const KIMLIK_ISARETI = '.kimlik-islemi';
/**
 * Bayat işareti devralırken kullanılan benzersiz ad. Devralma yarışını
 * `rename` kazananı belirler: bayat işaret bu ada taşınabilen tek süreç
 * kilidi alır, ötekiler reddedilir.
 */
const DEVIR_ONEKI = '.kimlik-islemi-devir-';
/**
 * İşaret bundan eskiyse sahipsiz sayılır. Gerçek bir işlem birkaç saniye sürer;
 * 10 dakika, süreci öldürülmüş ya da asılmış bir işlemin kalıntısının sonsuza
 * dek beklememesi için konmuş üst sınırdır.
 */
const KIMLIK_ISARETI_TAZELIK_MS = 10 * 60 * 1000;

const KimlikIsaretiSemasi = v.object({
  pid: v.number(),
  islemId: v.string(),
  baslatildi: v.string(),
  /**
   * İşlem kesinleşme noktasını geçti mi? Kesinleşme anında (yedekler
   * doğrulandıktan hemen sonra, silmeden önce) atomik olarak `true` yazılır ve
   * yedekler silinemezse işaret yerinde bırakılır. Kurtarma bu bayrakla
   * kalıntının kesinleşme öncesine mi sonrasına mı ait olduğunu ayırt eder:
   * kesinleşmiş kalıntı geri konmaz, silinir. Eski sürümlerin yazdığı işarette
   * alan yoktur; `false` sayılır (bugünkü geri koyma davranışı).
   */
  committed: v.optional(v.boolean(), false),
  /**
   * İşlem başlamadan önceki config'in tam anlık görüntüsü. Kesinleşmemiş bayat
   * bir işlemin kurtarması artık "asıl dosya duruyor mu" sorusuna değil bu
   * kayda dayanır: önce config bu değere geri yazılır, sonra yedekler asıl
   * adlarına konur; yani işlem hiç olmamış gibi olur. Alan yoksa (eski bir
   * kobay sürümünün yazdığı işaret) geri koyma yapılmaz — eski oturumu yeni
   * config'in altına diriltmek, aynı hostun başka portuna çerez taşırdı.
   * Config sır taşımaz (baseUrl, docsPath, loginUrl, beyin ayarı); parola
   * yalnız `credentials.json`'dadır.
   */
  eskiConfig: v.optional(KobayConfigSemasi),
  /**
   * İşlemin sonunda `--login` ile yeni bir `credentials.json` yazılacak mıydı?
   * Kenara alınacak eski kimlik yokken çöken bir işlemin ardında kalan yeni
   * kimlik, tam geri almada silinir; yoksa yeni hedefin parolası eski config'in
   * altında kalırdı.
   */
  yeniKimlikYazilacak: v.optional(v.boolean(), false),
  /**
   * İşlemin kenara aldığı dosyaların asıl adları. Kenara alma biter bitmez,
   * kesinleşmeden önce diske iner ve bir daha değişmez: işlemin kalıcı
   * olgusudur. Geri alma "yeni yazılan `credentials.json` silinsin mi?"
   * kararını yalnız buna dayandırır (listede `credentials.json` varsa asla
   * silinmez). Eskiden karar o anki kopya listesinden çıkarılıyordu: ilk geri
   * alma denemesi kimlik kopyasını geri koyup sonraki adımda düştüğünde,
   * sonraki kurtarma kalan kopyalara bakıp "eski kimlik yokmuş" sanıyor ve
   * geri konmuş ORİJİNAL `credentials.json`'ı siliyordu. Alan yoksa (eski bir
   * kobay sürümünün yazdığı işaret ya da kenara alma ile bu yazım arasında
   * ölen süreç) güvenli taraf seçilir: silme yapılmaz, uyarılır.
   */
  kenaraAlinanlar: v.optional(v.array(v.string())),
});

type KimlikIsareti = v.InferOutput<typeof KimlikIsaretiSemasi>;

/**
 * İşaret hâlâ yürüyen bir işleme mi ait? Hem yazan sürecin yaşıyor olması hem
 * de işaretin 10 dakikadan yeni olması gerekir. Mutlak değer: saat geriye
 * alınmışsa gelecek tarihli işaret sonsuza dek taze kalmasın.
 */
function isaretTazeMi(isaret: KimlikIsareti): boolean {
  const yas = Date.now() - Date.parse(isaret.baslatildi);
  return Number.isFinite(yas)
    && Math.abs(yas) < KIMLIK_ISARETI_TAZELIK_MS
    && pidYasiyor(isaret.pid);
}

/**
 * Bu süreçte geri alınamadığı bilinen işlemlerin kimlikleri. İşaret dosyası
 * bilerek korunur, ama işlemi yürüten süreç (uzun yaşayan MCP sunucusu)
 * ayakta kaldığı için işaret 10 dakika boyunca "taze" görünür ve hem
 * kurtarmayı hem yeni işlemi kilitlerdi. Burada kayıtlı işaret yürüyen işlem
 * sayılmaz: sonraki komut geri almayı gerçekten yeniden dener.
 */
const geriAlinamayanIslemler = new Set<string>();

/** İşaret yürüyen bir işleme mi ait? Geri alınamadığı bilinen işlem sayılmaz. */
function isaretYuruyorMu(isaret: KimlikIsareti): boolean {
  return !geriAlinamayanIslemler.has(isaret.islemId) && isaretTazeMi(isaret);
}

/** Süreç hâlâ duruyor mu; EPERM "var ama başkasının" demektir. */
function pidYasiyor(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (hata: unknown) {
    return hataKodu(hata) === 'EPERM';
  }
}

const GITIGNORE_BASLANGICI = '# >>> kobay managed >>>';
const GITIGNORE_BITISI = '# <<< kobay managed <<<';
const GITIGNORE = `${GITIGNORE_BASLANGICI}\n${GITIGNORE_SATIRLARI.join('\n')}\n${GITIGNORE_BITISI}\n`;

/** Yazma hakkı olmayan dosya sisteminde komut düşmesin diye uyarıyla geçilen kodlar. */
const YAZILAMAZ_KODLARI = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EIO', 'EBUSY', 'ENOTDIR']);

/** Hata mesajı; kodu varsa kullanıcıya onu gösteririz (ENOSPC, EACCES…). */
function hataMetni(hata: unknown): string {
  return hataKodu(hata) ?? (hata instanceof Error ? hata.message : String(hata));
}

function hataKodu(hata: unknown): string | undefined {
  if (typeof hata === 'object' && hata !== null && 'code' in hata && typeof hata.code === 'string') {
    return hata.code;
  }
  return undefined;
}

function jsonYaz(veri: unknown): string {
  return `${JSON.stringify(veri, null, 2)}\n`;
}

async function gitignoreGuncelle(yol: string): Promise<void> {
  let mevcut: string;
  try {
    mevcut = await readFile(yol, 'utf8');
  } catch (hata: unknown) {
    if (hataKodu(hata) === 'ENOENT') {
      await yazAtomik(yol, GITIGNORE);
      return;
    }
    throw hata;
  }

  const satirlar = mevcut === '' ? [] : mevcut.split(/\r?\n/);
  if (mevcut.endsWith('\n')) satirlar.pop();
  const blokBaslangici = satirlar.indexOf(GITIGNORE_BASLANGICI);
  const blokBitisi = blokBaslangici === -1 ? -1 : satirlar.indexOf(GITIGNORE_BITISI, blokBaslangici + 1);
  const kullaniciSatirlari: string[] = [];
  for (const [sira, satir] of satirlar.entries()) {
    if (blokBaslangici !== -1 && blokBitisi !== -1 && sira >= blokBaslangici && sira <= blokBitisi) continue;
    if (satir === GITIGNORE_BASLANGICI || satir === GITIGNORE_BITISI || GITIGNORE_SATIRLARI.includes(satir)) continue;
    kullaniciSatirlari.push(satir);
  }
  const kullaniciIcerigi = kullaniciSatirlari.length === 0 ? '' : `${kullaniciSatirlari.join('\n')}\n`;
  const yeni = `${GITIGNORE}${kullaniciIcerigi}`;
  if (yeni !== mevcut) await yazAtomik(yol, yeni);
}

/**
 * Yönetilen bloğu `.kobay/.gitignore` ile senkronlar: blok yoksa ekler, eksik
 * satırı tamamlar, blok dışındaki kullanıcı satırlarını korur. İçerik zaten
 * aynıysa diske hiç dokunmaz. Salt okunur dosya sistemi ya da izin hatasında
 * komut düşmez; stderr'e tek satır uyarı yazılır.
 */
async function gitignoreSenkronla(yol: string): Promise<void> {
  try {
    await gitignoreGuncelle(yol);
  } catch (hata: unknown) {
    const kod = hataKodu(hata);
    if (kod === undefined || !YAZILAMAZ_KODLARI.has(kod)) throw hata;
    process.stderr.write(
      `[kobay] Uyarı: ${yol} güncellenemedi (${kod}); .kobay/ klasörünü git'e eklemeyin,`
      + ' hata demetlerinde oturum çerezi olabilir.\n',
    );
  }
}

async function yoksaNull<T>(islem: () => Promise<T>): Promise<T | null> {
  try {
    return await islem();
  } catch (hata) {
    if (hata instanceof DosyaYok) return null;
    throw hata;
  }
}

function guvenliAd(ad: string): void {
  if (basename(ad) !== ad || ad === '.' || ad === '..') {
    throw new Error('Ek dosya hedef adı yalnızca dosya adı olmalı');
  }
}

function kimlikDogrula(kimlik: string, tur: 'testId' | 'runId'): void {
  const desen = tur === 'testId' ? TEST_KIMLIGI : KOSU_KIMLIGI;
  if (!desen.test(kimlik)) throw new GecersizKimlik(kimlik, tur);
}

/** Çözümlenen yolun, beklenen depo alt dizininden dışarı çıkmadığını doğrular. */
function altYol(kok: string, ...parcalar: string[]): string {
  const cozulmusKok = resolve(kok);
  const cozulmusYol = resolve(cozulmusKok, ...parcalar);
  const fark = relative(cozulmusKok, cozulmusYol);
  if (fark === '' || fark === '..' || fark.startsWith(`..${sep}`) || isAbsolute(fark)) {
    throw new Error(`Yol depo alt dizininin dışında: ${cozulmusYol}`);
  }
  return cozulmusYol;
}

/**
 * Geri alınabilir kimlik/oturum geçersiz kılma işlemi. Dosyalar hemen silinmez,
 * `.kobay/` altında gizli bir ada taşınır: çağıran config'i (ve gerekiyorsa yeni
 * kimliği) yazdıktan sonra `kesinlestir`, arada bir adım düşerse `geriAl` çağırır.
 * Böylece config yazımı düşse bile kullanıcının parolası ve oturumu kaybolmaz.
 */
export interface KimlikIslemiBaglami {
  /**
   * İşlem başlamadan önceki config. Süreç kesinleşme noktasına varamadan
   * ölürse sonraki komutun kurtarması bunu geri yazar. Okunamıyorsa `null`
   * verilir: o zaman otomatik geri koyma yapılmaz, kalıntı uyarıyla bırakılır.
   */
  readonly eskiConfig: KobayConfig | null;
  /** `--login`: işlemin sonunda yeni bir `credentials.json` yazılacak mı? */
  readonly yeniKimlikYazilacak?: boolean;
}

/** `geriAl()` çağrısında işlemin nereye kadar ilerlediğini bildiren kayıt. */
export interface KimlikGeriAlma {
  /**
   * İşlem sırasında config yazılmış olabilir mi? `true` ise geri alma önce
   * işlem öncesi config'i geri yazar. Kenara alma daha bitmeden düşüldüyse
   * `false` bırakılır: config'e hiç dokunulmadığı için geri yazmak, düşmesi
   * hâlinde olmayan bir tutarsızlığı "geri alınamadı" diye raporlardı.
   */
  readonly configYazildi?: boolean;
  /**
   * `--login` yeni `credentials.json`'ı yazmış olabilir mi? İşlemin başında
   * kenara alınan bir eskisi yoksa geri alma yenisini siler; yoksa yeni
   * hedefin parolası eski config'in altında kalırdı. "Eskisi var mıydı"
   * sorusunun cevabı işlemin kendi kaydından gelir, o anki dosya
   * durumundan değil.
   */
  readonly yeniKimlikYazildi?: boolean;
  /** Geri almayı tetikleyen asıl hata; geri alma da düşerse mesajda korunur. */
  readonly asilHata?: unknown;
}

export interface KimlikIslemi {
  /** Kenara alınan dosya adları; kullanıcıya "geçersiz kılınan" diye gösterilir. */
  readonly adlar: string[];
  /**
   * İşlemi kesinleştirir. İki aşamalıdır ve kesinleşme noktası birincisinin
   * sonudur:
   * 1. Doğrulama: kenara alınanların hepsi hâlâ yerinde mi? Değilse
   *    `KimlikIslemiBozuldu` fırlatılır ve çağıran işlemi geri alabilir.
   *    Doğrulamanın son adımı, kesinleşmeyi diske yazmaktır: işaret dosyası
   *    `committed: true` ile tazelenir. Bu yazım düşerse de işlem doğrulama
   *    hatasıyla düşer; henüz hiçbir yedek silinmediği için geri alma güvenli.
   * 2. Temizlik: yedekler silinir. Bu aşama en-iyi-çabadır, hata fırlatmaz:
   *    silinemeyen kopya uyarıyla yerinde bırakılır ve kesinleşmiş işaret de
   *    yerinde kalır ki sonraki komutun kurtarması kalıntıyı geri koymak yerine
   *    silsin.
   */
  kesinlestir(): Promise<void>;
  /**
   * İşlem düştüğünde her şeyi işlem öncesi hâline döndürür: tek dayanıklı
   * yordam, kurtarmayla aynı sırayla (önce config, sonra kenara alınan
   * kopyalar, en sonunda `--login`'in yazdığı yeni kimlik). Hiçbir adım
   * yutulmaz — düşen adımda durulur, işaret silinmez ve `KimlikGeriAlinamadi`
   * fırlatılır; sonraki komutun kurtarması aynı sırayla yeniden dener.
   */
  geriAl(secenek?: KimlikGeriAlma): Promise<void>;
}

export class KobayDizini {
  readonly kok: string;
  readonly projeKoku: string;

  private constructor(projeKoku: string) {
    this.projeKoku = resolve(projeKoku);
    this.kok = join(this.projeKoku, '.kobay');
  }

  static async ac(projeKoku: string, config: KobayConfig): Promise<KobayDizini> {
    const dizin = new KobayDizini(projeKoku);
    await mkdir(dizin.kok, { recursive: true });
    await dizin.altDizinleriSagla();
    await gitignoreSenkronla(dizin.yol('.gitignore'));
    await dizin.configYaz(config);
    return dizin;
  }

  /**
   * Kobay'ın kendi yazdığı alt dizinleri her açılışta garanti eder. Bu dizinler
   * `.gitignore` bloğunda dışlandığı için repoyu klonlayan ikinci geliştiricide
   * ya da CI'da gelmez; eksikse düşen koşu hata paketini yazamaz. Yazma hakkı
   * olmayan dosya sisteminde komut düşmez, `.gitignore` senkronu gibi uyarılır.
   */
  private async altDizinleriSagla(): Promise<void> {
    try {
      await Promise.all(
        KOBAY_ALT_DIZINLERI.map(async (ad) => mkdir(this.yol(ad), { recursive: true })),
      );
    } catch (hata: unknown) {
      const kod = hataKodu(hata);
      if (kod === undefined || !YAZILAMAZ_KODLARI.has(kod)) throw hata;
      process.stderr.write(
        `[kobay] Uyarı: ${this.kok} altındaki çalışma dizinleri oluşturulamadı (${kod});`
        + ' koşu ve hata paketi yazımı başarısız olabilir.\n',
      );
    }
  }

  /**
   * Eski kobay sürümlerinin geçici Playwright config'i `.kobay/son-liste.json`
   * bırakıyordu: hiçbir yerde okunmayan, geliştirme makinesinin mutlak yollarını
   * taşıyan bayat bir dosya. Artık üretilmiyor; kalanı ilk komutta silinir.
   * Silme bu tek adla, `.kobay/` köküyle ve düz dosyayla sınırlıdır — symlink
   * ya da dizin görülürse dokunulmaz. Yazma hakkı olmayan dosya sisteminde
   * komut düşmez; dosya yerinde kalır, zararı yok.
   */
  private async bayatSonListeyiSil(): Promise<void> {
    const yol = this.yol('son-liste.json');
    try {
      if (!(await lstat(yol)).isFile()) return;
      await unlink(yol);
    } catch (hata: unknown) {
      const kod = hataKodu(hata);
      if (kod === 'ENOENT') return;
      if (kod === undefined || !YAZILAMAZ_KODLARI.has(kod)) throw hata;
    }
  }

  /**
   * Proje dizinini bulan tek nokta; bulduğu her `.kobay` için yönetilen
   * `.gitignore` bloğunu senkronlar ve kobay'ın yazdığı alt dizinleri
   * tamamlar. Eski projeler böylece `failure-out/`, `logs/` gibi sonradan
   * eklenen korumaları ilk komutta kazanır; klonlanmış projede git'e girmeyen
   * `failure/`, `runs/` gibi dizinler ilk komutta geri gelir; eski sürümlerin
   * bıraktığı bayat `son-liste.json` de burada silinir. Yarım kalmış bir
   * kimlik işleminin kenara aldığı dosya da burada toparlanır; kalıntı sessizce
   * beklemez.
   */
  static async bul(baslangic: string): Promise<KobayDizini | null> {
    let aday = resolve(baslangic);
    try {
      if ((await stat(aday)).isFile()) aday = dirname(aday);
    } catch {
      // Var olmayan başlangıç yolu da üst dizinlerine göre aranabilir.
    }

    while (true) {
      // stat dışındaki hata (izin, dolu disk) yutulmasın diye bulma ve hazırlama ayrı.
      let bulundu = false;
      try {
        bulundu = (await stat(join(aday, '.kobay'))).isDirectory();
      } catch {
        // Bu üst dizinde .kobay yok.
      }
      if (bulundu) {
        const dizin = new KobayDizini(aday);
        await gitignoreSenkronla(dizin.yol('.gitignore'));
        await dizin.altDizinleriSagla();
        await dizin.bayatSonListeyiSil();
        await dizin.kimlikKalintilariniTopladigindaUyar();
        return dizin;
      }
      const ust = dirname(aday);
      if (ust === aday) return null;
      aday = ust;
    }
  }

  yol(...parca: string[]): string {
    return join(this.kok, ...parca);
  }

  private testYolu(id: string, uzanti: '.json' | '.spec.ts'): string {
    kimlikDogrula(id, 'testId');
    return altYol(this.yol('tests'), `${id}${uzanti}`);
  }

  private kosuYolu(runId: string, ...parcalar: string[]): string {
    kimlikDogrula(runId, 'runId');
    return altYol(this.yol('runs'), runId, ...parcalar);
  }

  private hataPaketiYolu(testId: string): string {
    kimlikDogrula(testId, 'testId');
    return altYol(this.yol('failure'), testId);
  }

  configOku(): Promise<KobayConfig> {
    return jsonOku(this.yol('config.json'), KobayConfigSemasi);
  }

  async configYaz(config: KobayConfig): Promise<void> {
    await yazAtomik(this.yol('config.json'), jsonYaz(config));
  }

  kimlikOku(): Promise<Kimlik | null> {
    return yoksaNull(() => jsonOku(this.yol('credentials.json'), KimlikSemasi));
  }

  async kimlikYaz(kimlik: Kimlik): Promise<void> {
    await yazAtomik(this.yol('credentials.json'), jsonYaz(kimlik), 0o600);
  }

  /**
   * Yazılmış giriş bilgisini siler. Yalnız geri alma yolunda kullanılır: kenara
   * alınacak eski kimlik yokken düşen bir işlemin yazdığı yeni kimlik kalmasın.
   */
  async kimligiSil(): Promise<void> {
    await rm(this.yol('credentials.json'), { force: true });
  }

  /**
   * Kayıtlı giriş bilgisini ve oturum durumunu geçersiz kılmaya hazırlar (hedef
   * origin değiştiğinde). Dosyalar silinmez, `.eski-<islemId>-<ad>` geçici
   * adına taşınır; silme işi `kesinlestir`'e kalır. Dosya yoksa sessizce
   * geçilir. Taşıma yarıda düşerse o ana kadar taşınanlar hemen geri konur.
   *
   * Aynı projede taze bir kimlik işlemi yürüyorsa kilit alınamaz ve çağrı
   * `KimlikIslemiYurumede` ile reddedilir: beklemek yok, kullanıcı komutu
   * yeniden çalıştırır.
   *
   * `baglam`, işlem işaretine yazılan kayıttır: işlem düşerse sonraki komut
   * config'i ve dosyaları buradan geri alır. Çağıran, config'i değiştirmeden
   * ÖNCEKİ hâlini vermelidir.
   */
  async kimlikVeOturumuKenaraAl(baglam: KimlikIslemiBaglami): Promise<KimlikIslemi> {
    const islemId = randomUUID();
    const tasinan: Array<{ ad: string; gecici: string }> = [];
    /**
     * İşaret yalnız geriye kalıntı kalmadıysa silinir. Kalıntı duruyorsa işaret
     * yerinde bırakılır: kurtarma, kalıntının kesinleşmeden önceye mi sonraya
     * mı ait olduğunu ancak işaretteki `committed` alanından bilebilir.
     */
    const isaretiKapat = async (): Promise<void> => {
      for (const { gecici } of tasinan) {
        if (await access(gecici).then(() => true, () => false)) return;
      }
      await this.kimlikIsaretiniSil(islemId);
    };
    const geriAl = async (secenek: KimlikGeriAlma = {}): Promise<void> => {
      await this.kimlikIsleminiGeriAl({
        islemId,
        eskiConfig: secenek.configYazildi === true ? baglam.eskiConfig : null,
        kopyalar: tasinan.map(({ ad, gecici }) => ({ kaynak: gecici, asilAd: ad })),
        yeniKimlikYazildi: secenek.yeniKimlikYazildi === true,
        // İşlemin kalıcı olgusu. `kopyalar` geri alma ilerledikçe erir (geri
        // konan kopya artık yoktur); bu liste ise kenara almanın sonucudur ve
        // değişmez. Karar ondan değil bundan çıkar, böylece geri alma kaç kez
        // koşarsa koşsun aynı sonucu verir.
        eskiKimlikVardi: tasinan.some(({ ad }) => ad === 'credentials.json'),
        ...(secenek.asilHata === undefined ? {} : { asilHata: secenek.asilHata }),
      });
      await isaretiKapat();
    };

    // Kilit ilk renameden önce alınır: hem aradan geçen ikinci bir kobay süreci
    // kalıntıyı "sahipsiz" sanıp geri koymasın, hem de ikinci bir değiştirme
    // komutu aynı anda ilerleyemesin.
    await this.kimlikKilidiniEdin(islemId, baglam);
    try {
      for (const ad of KIMLIK_DOSYALARI) {
        const gecici = altYol(this.kok, `${KENARA_ONEKI}${islemId}-${ad}`);
        try {
          await rename(this.yol(ad), gecici);
        } catch (hata: unknown) {
          if (hataKodu(hata) === 'ENOENT') continue;
          throw hata;
        }
        tasinan.push({ ad, gecici });
      }
      // Kenara almanın sonucu kalıcı olgu olarak işarete iner: süreç buradan
      // sonra hangi adımda ölürse ölsün, kurtarma "eski kimlik var mıydı"
      // sorusunu o anki kopya listesinden tahmin etmek zorunda kalmaz. Yazım
      // düşerse işlem hiç başlamamış sayılır ve taşınanlar hemen geri konur.
      await this.kimlikIsaretineKenaraAlinanlariYaz(islemId, tasinan.map(({ ad }) => ad));
    } catch (hata) {
      // Config'e henüz dokunulmadı: yalnız taşınanlar geri konur.
      await geriAl({ asilHata: hata });
      throw hata;
    }

    return {
      adlar: tasinan.map(({ ad }) => ad),
      kesinlestir: async (): Promise<void> => {
        try {
          // 1. Doğrulama. Kenara alınan dosya hâlâ yerinde mi? Değilse (başka
          // bir süreç geri koymuşsa) silinecek bir şey yok demektir ve
          // "başarıyla geçersiz kılındı" demek yalan olur; açıkça düşülür.
          // Bütün yedeklerin yerinde olduğu an kesinleşme noktasıdır.
          for (const { ad, gecici } of tasinan) {
            const duruyor = await access(gecici).then(() => true, () => false);
            if (!duruyor) throw new KimlikIslemiBozuldu(`kenara alınan ${ad} yerinde yok`);
          }
          // 1b. Kesinleşme noktası diske yazılır: işaret atomik olarak
          // `committed: true` ile tazelenir. Bu yazım da doğrulama sayılır —
          // düşerse henüz hiçbir yedek silinmediği için geri alma güvenlidir.
          // Bayrak olmadan kurtarma, kesinleşmeden sonra silinemeyen bir
          // `storageState.json` yedeğini "yarım kalmış işlem" sanıp geri
          // koyuyordu: origin değişmiş, yeni oturum henüz yazılmamışken eski
          // hedefin çerezleri yenisine taşınıyordu.
          await this.kimlikIsaretiniKesinlestir(islemId);
          // 2. Temizlik; en-iyi-çaba. Burada fırlatmak veri siliyordu: ilk rm
          // tutup ikincisi düştüğünde çağıran geri almaya giriyor, ama ilk
          // yedek artık yok; geri alma hatası yutulduğu için eski giriş bilgisi
          // kalıcı olarak kayboluyordu. Kesinleşmeden sonra silme hatası işlemi
          // başarısız yapmaz: uyarılır, kalıntı yerinde bırakılır. Sonraki
          // komutta `bul()` kurtarması kalıntıyı ele alır — asıl dosya
          // yazılmışsa siler, yoksa geri koyar.
          for (const { ad, gecici } of tasinan) {
            try {
              await rm(gecici, { force: true });
            } catch (hata: unknown) {
              const sebep = hataKodu(hata) ?? (hata instanceof Error ? hata.message : String(hata));
              process.stderr.write(
                `[kobay] Uyarı: kenara alınan ${ad} kopyası silinemedi (${sebep});`
                + ` ${KENARA_ONEKI}${islemId}-${ad} yerinde bırakıldı,`
                + ' sonraki kobay komutu toparlayacak.\n',
              );
            }
          }
        } finally {
          await isaretiKapat();
        }
      },
      geriAl,
    };
  }

  private isaretYolu(): string {
    return this.yol(KIMLIK_ISARETI);
  }

  /**
   * Kimlik işleminin tek dayanıklı geri alma yordamı. Hem işlemin kendi
   * `geriAl()` çağrısı hem de bayat işaretin kurtarması buradan geçer; ikisi
   * aynı sırayı izler:
   *
   * 1. Config, işlem öncesi anlık görüntüye yazılır (kayıt yoksa atlanır).
   * 2. Kenara alınan kopyalar asıl adlarına konur.
   * 3. `--login` yeni kimliği yazdıysa ve işlemin başında kenara alınacak eski
   *    bir kimlik YOKSA yenisi silinir. Karar yalnız `eskiKimlikVardi` kalıcı
   *    olgusuna bakar; kalan kopyalardan çıkarım yapılmaz. Bu yüzden yordam
   *    tekrar-idempotenttir: ikinci koşuda "kopya artık yok" gözlemi kararı
   *    değiştirmez, geri konmuş orijinal kimlik silinmez.
   *
   * Hiçbir adımın hatası yutulmaz: düşen adımda durulur ve
   * `KimlikGeriAlinamadi` fırlatılır. Çağıran işareti silmediği için — ve
   * işlem bu süreçte "geri alınamadı" diye işaretlendiği için — sonraki komut
   * aynı sırayla yeniden dener. Eski davranışta 1. adımın hatası yutulup 2.
   * adım yine de çalışıyordu: yeni config ile eski oturum yan yana kalıyor,
   * üstelik durumu düzeltecek işaret siliniyordu.
   */
  private async kimlikIsleminiGeriAl(a: {
    islemId: string;
    /** İşlem öncesi config; `null` ise (okunamamış ya da hiç yazılmamış) config'e dokunulmaz. */
    eskiConfig: KobayConfig | null;
    /** Geri konacak kopyalar: kaynak tam yol, hedef asıl ad. */
    kopyalar: Array<{ kaynak: string; asilAd: string }>;
    yeniKimlikYazildi: boolean;
    /**
     * İşlemin başında kenara alınan dosyalar arasında `credentials.json` var
     * mıydı? `undefined` = kayıt yok (eski sürümün işareti ya da olgu diske
     * inmeden ölen süreç); o zaman silme yapılmaz, kullanıcı uyarılır.
     */
    eskiKimlikVardi: boolean | undefined;
    asilHata?: unknown;
  }): Promise<void> {
    const dus = (neden: string): never => {
      // Bu işlem artık yürümüyor ama işareti duruyor: sonraki komut kurtarmayı
      // taze işaret sanıp atlamasın.
      geriAlinamayanIslemler.add(a.islemId);
      throw new KimlikGeriAlinamadi(neden, a.asilHata);
    };

    if (a.eskiConfig !== null) {
      try {
        await this.configYaz(a.eskiConfig);
      } catch (hata: unknown) {
        dus(
          `config.json işlem öncesi hedefine (${a.eskiConfig.baseUrl}) geri yazılamadı`
          + ` (${hataMetni(hata)}); kenara alınan giriş bilgisi ve oturum bilerek geri konmadı`,
        );
      }
    }

    for (const { kaynak, asilAd } of a.kopyalar) {
      try {
        await rename(kaynak, this.yol(asilAd));
      } catch (hata: unknown) {
        // Başka bir kobay süreci aynı kopyayı çoktan geri koymuş olabilir.
        if (hataKodu(hata) === 'ENOENT') continue;
        dus(`${basename(kaynak)} kopyası ${asilAd} adına geri konamadı (${hataMetni(hata)})`);
      }
    }

    // Silme kararı yalnız kalıcı olguya dayanır. Kalan kopyalara bakmak
    // veri kaybettiriyordu: ilk geri alma denemesi `credentials.json`
    // kopyasını geri koyup sonraki adımda düştüğünde, ikinci deneme geriye
    // kalan kopyalarda kimlik göremiyor ve "kenara alınacak eskisi yokmuş"
    // diye geri konmuş ORİJİNAL dosyayı siliyordu.
    if (a.yeniKimlikYazildi && a.eskiKimlikVardi === undefined) {
      process.stderr.write(
        '[kobay] Uyarı: yarım kalan kimlik işleminin kaydında kenara alınan dosya listesi yok'
        + ' (eski bir kobay sürümünden kalma ya da kayıt diske inmeden süreç ölmüş);'
        + ' işlem sırasında yazılmış olabilecek credentials.json bilerek silinmedi.'
        + ' `kobay project get` ile hedefi denetleyin, giriş bilgisi yanlış hedefe aitse'
        + ' `kobay project create --url <URL> --login --force` ile yeniden verin.\n',
      );
    } else if (a.yeniKimlikYazildi && a.eskiKimlikVardi === false) {
      try {
        await rm(this.yol('credentials.json'), { force: true });
      } catch (hata: unknown) {
        dus(
          `işlem sırasında yazılan credentials.json silinemedi (${hataMetni(hata)});`
          + ' yeni hedefin parolası eski config\'in altında kalırdı',
        );
      }
    }
    geriAlinamayanIslemler.delete(a.islemId);
  }

  /**
   * İşareti yalnız yoksa oluşturur (`O_EXCL`). Atomik yazma (geçici dosya +
   * rename) burada kullanılamaz: rename var olan dosyanın üstüne yazar, yani
   * kilit olmaz. Dosya zaten varsa `false` döner.
   */
  private async kimlikIsaretiniOlustur(
    islemId: string,
    baglam: KimlikIslemiBaglami,
  ): Promise<boolean> {
    let tutamac;
    try {
      tutamac = await open(this.isaretYolu(), 'wx', 0o600);
    } catch (hata: unknown) {
      if (hataKodu(hata) === 'EEXIST') return false;
      throw hata;
    }
    try {
      await tutamac.writeFile(jsonYaz({
        pid: process.pid,
        islemId,
        baslatildi: new Date().toISOString(),
        // Geri alma kaydı işlemin ilk adımında, ilk rename'den önce diske iner:
        // çökme hangi adımda olursa olsun kurtarma eski hâli biliyor olur.
        ...(baglam.eskiConfig === null ? {} : { eskiConfig: baglam.eskiConfig }),
        ...(baglam.yeniKimlikYazilacak === true ? { yeniKimlikYazilacak: true } : {}),
      }));
    } finally {
      await tutamac.close();
    }
    return true;
  }

  /**
   * Kenara alma bittiğinde işlemin kalıcı olgusunu işarete ekler: hangi asıl
   * adlar kenara alındı. İşaret sahibi değişmeden atomik olarak yeniden
   * yazılır; öteki alanlar (`eskiConfig`, `yeniKimlikYazilacak`) korunur.
   *
   * İşaret kaybolmuş ya da başka bir işleme geçmişse kilidi kaybetmişiz
   * demektir: işlem bozuk sayılır, çağıran taşınanları hemen geri koyar.
   * Kayıt yazılamazsa da işlem sürdürülmez — kayıtsız devam etmek, sonraki
   * kurtarmayı yine "kopyalardan çıkarım" yapmak zorunda bırakırdı.
   */
  private async kimlikIsaretineKenaraAlinanlariYaz(
    islemId: string,
    adlar: string[],
  ): Promise<void> {
    const isaret = await this.kimlikIsaretiOku().catch(() => null);
    if (isaret === null || isaret.islemId !== islemId) {
      throw new KimlikIslemiBozuldu('işlem işareti kayboldu ya da başka bir sürece geçmiş');
    }
    await yazAtomik(this.isaretYolu(), jsonYaz({ ...isaret, kenaraAlinanlar: adlar }), 0o600);
  }

  /**
   * Kesinleşme noktasını diske yazar: işaret dosyası, sahibi değişmeden,
   * `committed: true` ile atomik olarak yeniden yazılır (`O_EXCL` yalnız
   * edinimde kullanılır; burada amaç kilidi almak değil, var olan kaydı
   * güncellemek). İşaret silinmişse kendi kaydımız yeniden konur; başka bir
   * işleme geçmişse kilidi kaybetmişiz demektir ve işlem bozuk sayılır.
   */
  private async kimlikIsaretiniKesinlestir(islemId: string): Promise<void> {
    const isaret = await this.kimlikIsaretiOku().catch(() => null);
    if (isaret !== null && isaret.islemId !== islemId) {
      throw new KimlikIslemiBozuldu('işlem işareti başka bir sürece geçmiş');
    }
    // Geri alma kaydı (`eskiConfig`, `yeniKimlikYazilacak`, `kenaraAlinanlar`)
    // bilerek düşürülür:
    // kesinleşmiş bir işlem bir daha geri alınmaz, kayıt yalnız yanlışlıkla
    // kullanılmaya açık kalırdı.
    await yazAtomik(this.isaretYolu(), jsonYaz({
      pid: isaret?.pid ?? process.pid,
      islemId,
      baslatildi: isaret?.baslatildi ?? new Date().toISOString(),
      committed: true,
    }), 0o600);
  }

  /**
   * Kesinleşmiş bir işlemin geriye bıraktığı yedekleri siler. Kesinleşmeden
   * sonra yedek artık geçersizdir: asıl dosya yerinde olsa da olmasa da geri
   * konmaz, çünkü geri koymak eski origin'in oturumunu yeni hedefin yanına
   * taşır.
   */
  private async kesinlesmisKalintilariSil(islemId: string): Promise<void> {
    for (const ad of KIMLIK_DOSYALARI) {
      await rm(altYol(this.kok, `${KENARA_ONEKI}${islemId}-${ad}`), { force: true });
    }
  }

  /**
   * Kimlik işlemi kilidini alır. Üç durum var:
   * - İşaret yok: `O_EXCL` ile oluşturulur, kilit bizimdir.
   * - İşaret taze: sahibi yürüyor, çağrı reddedilir.
   * - İşaret bayat (süreç ölmüş ya da 10 dk'dan eski) ya da okunamaz: devralma
   *   yarışını `rename` kazananı belirler. Bayat dosya benzersiz bir ada
   *   taşınabilen tek süreç devam eder; taşıma düşerse (ENOENT) başkası önce
   *   davranmıştır ve çağrı reddedilir.
   *
   * Devraldığımız dosyanın içeriği bizim bayat sandığımız işaretten başkaysa,
   * okuma ile rename arasında araya giren bir süreç kendi taze işaretini koymuş
   * demektir: dosya yerine konur ve çekiliriz.
   */
  private async kimlikKilidiniEdin(islemId: string, baglam: KimlikIslemiBaglami): Promise<void> {
    if (await this.kimlikIsaretiniOlustur(islemId, baglam)) return;

    const isaret = await this.kimlikIsaretiOku().catch(() => null);
    if (isaret !== null && isaretYuruyorMu(isaret)) {
      // Taze ama kesinleşmiş ve bu sürece ait işaret, yürüyen bir işlem değil:
      // kendi bitmiş işlemimizin silinemeyen yedeğinden kalan izdir (bir CLI
      // komutu biter bitmez süreç ölür, ama MCP sunucusu gibi uzun yaşayan bir
      // süreçte iz 10 dakika boyunca taze görünür ve sonraki değişikliği
      // kilitlerdi). Kalıntısını temizleyip kilidi devralırız. Başka bir sürece
      // ait taze işaret — kesinleşmiş olsa bile — o süreç hâlâ temizlik
      // yapıyor olabileceği için reddedilir.
      if (!isaret.committed || isaret.pid !== process.pid) throw new KimlikIslemiYurumede(isaret);
      await this.kesinlesmisKalintilariSil(isaret.islemId);
      await unlink(this.isaretYolu()).catch(() => undefined);
      if (!(await this.kimlikIsaretiniOlustur(islemId, baglam))) throw new KimlikIslemiYurumede();
      return;
    }

    // Bayat, kesinleşmemiş ve geri alma kaydı taşıyan işaret devralınamaz.
    // Devralma eski kaydı siler; geri konamamış yedek o anda sahipsiz kalır ve
    // hangi config'in altına ait olduğu bir daha bilinemez. Buraya gelindiyse
    // kurtarma (`bul()`) geri almayı deneyip düşmüştür: önce o düzeltilmeli.
    // Kesinleşmiş işaret (kalıntısı yalnız silinecek) ve `eskiConfig`'siz eski
    // sürüm işareti (geri koyma zaten yapılmıyor) devralınmaya devam eder.
    if (isaret !== null && !isaret.committed && isaret.eskiConfig !== undefined) {
      throw new KimlikGeriAlinamadi(
        'yarım kalmış bir kimlik işlemi duruyor, bu yüzden kimliği değiştiren'
        + ' yeni bir işlem başlatılamıyor',
      );
    }

    const devirYolu = altYol(this.kok, `${DEVIR_ONEKI}${islemId}`);
    try {
      await rename(this.isaretYolu(), devirYolu);
    } catch (hata: unknown) {
      if (hataKodu(hata) === 'ENOENT') throw new KimlikIslemiYurumede();
      throw hata;
    }
    const devralinan = await this.isaretOku(devirYolu).catch(() => null);
    if (devralinan !== null && devralinan.islemId !== isaret?.islemId) {
      await rename(devirYolu, this.isaretYolu()).catch(() => undefined);
      throw new KimlikIslemiYurumede(devralinan);
    }
    await rm(devirYolu, { force: true });
    if (!(await this.kimlikIsaretiniOlustur(islemId, baglam))) throw new KimlikIslemiYurumede();
  }

  /** Verilen işaret dosyasını okur; yoksa ya da okunamayacak biçimdeyse `null`. */
  private async isaretOku(yol: string): Promise<KimlikIsareti | null> {
    let ham: string;
    try {
      ham = await readFile(yol, 'utf8');
    } catch (hata: unknown) {
      if (hataKodu(hata) === 'ENOENT') return null;
      throw hata;
    }
    try {
      const sonuc = v.safeParse(KimlikIsaretiSemasi, JSON.parse(ham));
      return sonuc.success ? sonuc.output : null;
    } catch {
      return null;
    }
  }

  private kimlikIsaretiOku(): Promise<KimlikIsareti | null> {
    return this.isaretOku(this.isaretYolu());
  }

  /** İşareti yalnız sahibi siler: aynı projede ikinci bir işlem başladıysa onunki kalır. */
  private async kimlikIsaretiniSil(islemId?: string): Promise<void> {
    if (islemId !== undefined) {
      const isaret = await this.kimlikIsaretiOku().catch(() => null);
      if (isaret !== null && isaret.islemId !== islemId) return;
    }
    await unlink(this.isaretYolu()).catch(() => undefined);
  }

  /**
   * Yarım kalmış bir kimlik işleminden kalan `.eski-<islemId>-<ad>` dosyalarını
   * toparlar. Karar dosya varlığına değil işaretteki işlem kaydına dayanır.
   * Karar tablosu (işaret × kalıntı):
   *
   * - İşaret taze: hiçbir şeye dokunulmaz. Yoksa aynı projede paralel koşan
   *   ikinci bir kobay süreci, birincinin tam ortasındaki kenara almayı geri
   *   alır ve eski oturum yeni hedefin yanında kalırdı.
   * - İşaret bayat ve `committed: true`: işlem kesinleşme noktasını geçmiş,
   *   yalnız silme adımı düşmüştür. O `islemId`'nin kalıntıları asıl dosya
   *   yerinde olsa da olmasa da **silinir**. Geri koymak, hedef origin
   *   değiştikten sonra eski oturumu diriltirdi: `credentials.json` yoksa
   *   origin denetimi de çalışmaz ve `test run` bu `storageState.json`'ı
   *   doğrudan Playwright'a verip aynı hostun başka portuna çerez taşırdı.
   * - İşaret bayat, kesinleşmemiş ve `eskiConfig` taşıyor: işlem kesinleşme
   *   noktasına varamadan düşmüştür; yapılan iş **tam geri almadır**. Önce
   *   config anlık görüntüye geri yazılır (atomik), sonra o `islemId`'nin
   *   yedekleri asıl adlarına — var olan dosyanın üstüne — konur, en sonunda
   *   işaret silinir. Üstüne yazmak doğrudur: kilit yüzünden o dosyaları
   *   yalnız düşen işlemin kendisi (örneğin `--login` ile) yazmış olabilir ve
   *   işlem hiç olmamış sayılır. Sıra önemlidir; config hiçbir anda yanındaki
   *   kimlik/oturumdan başka bir hedefe ait kalmaz. Yedek geri konamazsa hata
   *   yükselir ve işaret yerinde bırakılır: sonraki komut yeniden dener.
   *   `--login` artığının silinip silinmeyeceği işaretteki `kenaraAlinanlar`
   *   kaydından okunur; kalan kalıntılardan çıkarım yapılmaz, yoksa önceki
   *   denemenin geri koyduğu orijinal kimlik "artık" sanılıp silinirdi. Kayıt
   *   yoksa silme yapılmaz, uyarılır.
   * - İşaret bayat, kesinleşmemiş ve `eskiConfig` yok (eski bir kobay
   *   sürümünün yazdığı işaret): kalıntının hangi config'in altına ait olduğu
   *   bilinemez. Geri konmaz, uyarıyla yerinde bırakılır; işaret yalnız kilit
   *   sonsuza dek kalmasın diye silinir.
   * - İşaretsiz kalıntı (elle bırakılmış ya da işareti silinmiş): hangi hedefe
   *   ait olduğu ve kesinleşip kesinleşmediği bilinemez. Geri konmaz —
   *   bilinmeyen bir oturumu diriltmek güvenlik riskidir. Silinmez de — içinde
   *   kullanıcının parolası olabilir. Dosya adı ve ne yapılacağı uyarıyla
   *   basılır, kalıntı yerinde bırakılır.
   */
  private async kimlikKalintilariniTopla(): Promise<void> {
    const isaret = await this.kimlikIsaretiOku();
    if (isaret !== null && isaretYuruyorMu(isaret)) return;
    // Okunamayan işaret kalıntı kararına bilgi taşıyamaz; sonraki komutları
    // yanıltmasın diye kaldırılır. Okunabilen bayat işaret, kararın kaynağıdır:
    // yalnız iş bittikten sonra silinir.
    if (isaret === null) await unlink(this.isaretYolu()).catch(() => undefined);

    let girdiler: string[];
    try {
      girdiler = await readdir(this.kok);
    } catch (hata: unknown) {
      if (hataKodu(hata) === 'ENOENT') return;
      throw hata;
    }

    // Araya giren bir süreç bayat kilidi devralmış (ya da kendi işaretini
    // koymuş) olabilir; o zaman kalıntılar onundur, dokunulmaz.
    const sonrakiIsaret = await this.kimlikIsaretiOku().catch(() => null);
    if ((sonrakiIsaret?.islemId ?? null) !== (isaret?.islemId ?? null)) return;

    for (const ad of girdiler) {
      // Devralma sırasında süreci ölen komutun bıraktığı kopya; kimseye lazım değil.
      if (ad.startsWith(DEVIR_ONEKI)) await rm(this.yol(ad), { force: true });
    }

    const kalintilar: Array<{ ad: string; kalintiId: string; asilAd: string }> = [];
    for (const ad of girdiler) {
      const eslesme = KENARA_DESENI.exec(ad);
      if (eslesme === null) continue;
      kalintilar.push({ ad, kalintiId: eslesme[1] as string, asilAd: eslesme[2] as string });
    }

    for (const { ad, kalintiId, asilAd } of kalintilar) {
      if (isaret !== null && kalintiId === isaret.islemId) continue;
      process.stderr.write(
        `[kobay] Uyarı: sahipsiz giriş bilgisi kopyası ${ad} duruyor;`
        + ' hangi hedefe ait olduğu bilinemediği için geri konmadı'
        + ' (eski bir oturumu diriltmek yanlış hedefe çerez taşıyabilir).'
        + ` İçeriği hâlâ gerekiyorsa elle ${asilAd} adına taşıyın, gerekmiyorsa dosyayı silin.\n`,
      );
    }
    if (isaret === null) return;
    const bizim = kalintilar.filter(({ kalintiId }) => kalintiId === isaret.islemId);

    if (isaret.committed) {
      // Kesinleşmiş işlemin kalıntısı geri konmaz; asıl dosya yoksa bile silinir.
      for (const { ad } of bizim) await rm(this.yol(ad), { force: true });
      await this.kimlikIsaretiniSil(isaret.islemId);
      return;
    }

    if (isaret.eskiConfig === undefined) {
      for (const { ad, asilAd } of bizim) {
        process.stderr.write(
          `[kobay] Uyarı: yarım kalmış kimlik işleminden kalan ${ad} duruyor;`
          + ' işlem kaydında işlem öncesi config yok (eski bir kobay sürümünden kalma),'
          + ' bu yüzden hangi hedefe ait olduğu bilinemedi ve geri konmadı.'
          + ` İçeriği hâlâ gerekiyorsa elle ${asilAd} adına taşıyın, gerekmiyorsa dosyayı silin.\n`,
        );
      }
      // Kalıntı yerinde kalır ama işaret gider: yoksa kilit sonsuza dek durur.
      await this.kimlikIsaretiniSil(isaret.islemId);
      return;
    }

    // Tam geri alma; işlemin kendi `geriAl()`'ıyla aynı yordam, aynı sıra.
    // Bir adım düşerse `KimlikGeriAlinamadi` yükselir: işaret ve kalıntı
    // yerinde kalır, `bul()` hata fırlatır ve komut durur. Eskiden hata
    // uyarıya çevriliyordu; aynı çağrıdaki `project update` bayat işareti
    // devralıp kaydını siliyor, geri konamayan yedek sahipsiz kalıyordu.
    await this.kimlikIsleminiGeriAl({
      islemId: isaret.islemId,
      eskiConfig: isaret.eskiConfig,
      kopyalar: bizim.map(({ ad, asilAd }) => ({ kaynak: this.yol(ad), asilAd })),
      yeniKimlikYazildi: isaret.yeniKimlikYazilacak,
      // Kalan kalıntılara değil işaretteki kalıcı olguya bakılır: önceki geri
      // alma denemesi kimlik kopyasını çoktan geri koymuş olabilir.
      eskiKimlikVardi: isaret.kenaraAlinanlar === undefined
        ? undefined
        : isaret.kenaraAlinanlar.includes('credentials.json'),
    });
    process.stderr.write(
      '[kobay] Uyarı: yarım kalmış bir hedef değişikliği geri alındı;'
      + ` config ${isaret.eskiConfig.baseUrl} hedefine döndü, kenara alınan giriş bilgisi`
      + ' ve oturum eski haline kondu. Değişikliği hâlâ istiyorsanız komutu yeniden çalıştırın.\n',
    );
    await this.kimlikIsaretiniSil(isaret.islemId);
  }

  /**
   * Kalıntı toplama komutu düşürmesin; yazılamayan dosya sisteminde uyarıyla
   * geçilir. Tek istisna yarım kalan bir işlemin geri alınamaması: o an proje
   * tutarsızdır (config bir hedefi, yanındaki oturum başkasını gösterir), bu
   * yüzden `project get` gibi salt okunur komutlar da durur. Devam etmek,
   * kullanıcıya yanlış hedefi doğruymuş gibi göstermek olurdu.
   */
  private async kimlikKalintilariniTopladigindaUyar(): Promise<void> {
    try {
      await this.kimlikKalintilariniTopla();
    } catch (hata: unknown) {
      // Geri alma hatası uyarıya çevrilmez. Bugün `KimlikGeriAlinamadi` bir
      // `code` taşımadığı için aşağıdaki dal da onu yükseltir; bu satır niyeti
      // sabitler: sarmalayan hataya sonradan bir kod iliştirilse bile yutulmaz.
      if (hata instanceof KimlikGeriAlinamadi) throw hata;
      const kod = hataKodu(hata);
      if (kod === undefined || !YAZILAMAZ_KODLARI.has(kod)) throw hata;
      process.stderr.write(
        `[kobay] Uyarı: ${this.kok} altındaki yarım kalan giriş bilgisi kopyası toparlanamadı (${kod});`
        + ' `kobay project get` ile hedefi, gerekiyorsa `--login --force` ile girişi denetleyin.\n',
      );
    }
  }

  /** Playwright oturum durumu için 0600 korumalı yazma noktası. */
  storageStateYolu(): string {
    return this.yol('storageState.json');
  }

  async storageStateYaz(icerik: string | Buffer): Promise<void> {
    await yazAtomik(this.storageStateYolu(), icerik, 0o600);
  }

  haritaOku(): Promise<Harita | null> {
    return yoksaNull(() => jsonOku(this.yol('harita.json'), HaritaSemasi));
  }

  async haritaYaz(harita: Harita): Promise<void> {
    await yazAtomik(this.yol('harita.json'), jsonYaz(harita));
  }

  onerileriOku(): Promise<Oneri[]> {
    return yoksaNull(() => jsonOku(this.yol('plan', 'onerileri.json'), v.array(OneriSemasi))).then((sonuc) => sonuc ?? []);
  }

  async onerileriYaz(oneriler: Oneri[]): Promise<void> {
    await yazAtomik(this.yol('plan', 'onerileri.json'), jsonYaz(oneriler));
  }

  testOku(id: string): Promise<TestKaydi> {
    return jsonOku(this.testYolu(id, '.json'), TestKaydiSemasi);
  }

  async testYaz(test: TestKaydi): Promise<void> {
    await yazAtomik(this.testYolu(test.id, '.json'), jsonYaz(test));
  }

  async testListele(): Promise<TestKaydi[]> {
    const dizin = this.yol('tests');
    try {
      const girdiler = await readdir(dizin, { withFileTypes: true });
      const testler = await Promise.all(
        girdiler
          .filter((girdi) => girdi.isFile() && girdi.name.endsWith('.json'))
          .map((girdi) => this.testOku(girdi.name.slice(0, -'.json'.length))),
      );
      return testler.sort((a, b) => a.id.localeCompare(b.id));
    } catch (hata: unknown) {
      if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') return [];
      throw hata;
    }
  }

  async testSil(id: string): Promise<void> {
    const testYolu = this.testYolu(id, '.json');
    const kodYolu = this.testYolu(id, '.spec.ts');
    await Promise.all([
      unlink(testYolu).catch((hata: unknown) => {
        if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') return;
        throw hata;
      }),
      unlink(kodYolu).catch((hata: unknown) => {
        if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') return;
        throw hata;
      }),
    ]);
  }

  kodYolu(id: string): string {
    return this.testYolu(id, '.spec.ts');
  }

  async kodOku(id: string): Promise<string | null> {
    try {
      return await readFile(this.kodYolu(id), 'utf8');
    } catch (hata: unknown) {
      if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') return null;
      throw hata;
    }
  }

  async kodYaz(id: string, kod: string): Promise<void> {
    await yazAtomik(this.kodYolu(id), kod);
  }

  async kosuDizini(runId: string): Promise<string> {
    const yol = this.kosuYolu(runId);
    await mkdir(yol, { recursive: true });
    return yol;
  }

  async kosuSonucuYaz(sonuc: KosuSonucu): Promise<void> {
    kimlikDogrula(sonuc.testId, 'testId');
    await yazAtomik(this.kosuYolu(sonuc.runId, 'result.json'), jsonYaz(sonuc));
  }

  kosuSonucuOku(runId: string): Promise<KosuSonucu> {
    return jsonOku(this.kosuYolu(runId, 'result.json'), KosuSonucuSemasi);
  }

  async kosuListele(testId: string): Promise<KosuSonucu[]> {
    kimlikDogrula(testId, 'testId');
    const kok = this.yol('runs');
    try {
      const girdiler = await readdir(kok, { withFileTypes: true });
      const sonuclar = await Promise.all(
        girdiler
          .filter((girdi) => girdi.isDirectory() && KOSU_KIMLIGI.test(girdi.name))
          .map(async (girdi) => yoksaNull(() => this.kosuSonucuOku(girdi.name))),
      );
      return sonuclar
        .filter((sonuc): sonuc is KosuSonucu => sonuc !== null && sonuc.testId === testId)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    } catch (hata: unknown) {
      if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') return [];
      throw hata;
    }
  }

  async hataPaketiYaz(
    paket: HataPaketi,
    ekDosyalar: Array<{ kaynak: string; hedefAd: string }>,
  ): Promise<string> {
    kimlikDogrula(paket.testId, 'testId');
    kimlikDogrula(paket.runId, 'runId');
    kimlikDogrula(paket.result.testId, 'testId');
    kimlikDogrula(paket.result.runId, 'runId');

    const hataKoku = this.yol('failure');
    const paketDizini = this.hataPaketiYolu(paket.testId);
    const rastgele = randomUUID();
    const geciciDizin = altYol(hataKoku, `.tmp-${paket.testId}-${rastgele}`);
    const partialYolu = altYol(geciciDizin, '.partial');
    // Üst dizin silinmiş ya da hiç gelmemiş olabilir; recursive:false yalnız
    // geçici dizinin benzersizliğini korumak için, üstü kendimiz açıyoruz.
    await mkdir(hataKoku, { recursive: true });
    await mkdir(geciciDizin, { recursive: false });
    await yazAtomik(partialYolu, '');

    for (const ek of ekDosyalar) {
      guvenliAd(ek.hedefAd);
      await yazAtomik(altYol(geciciDizin, ek.hedefAd), await readFile(ek.kaynak));
    }
    await yazAtomik(altYol(geciciDizin, 'failure.json'), jsonYaz(paket));
    await yazAtomik(altYol(geciciDizin, 'code.ts'), paket.code);
    await yazAtomik(altYol(geciciDizin, 'steps.json'), jsonYaz(paket.steps));
    await yazAtomik(altYol(geciciDizin, 'meta.json'), jsonYaz({
      snapshotId: paket.snapshotId,
      testId: paket.testId,
      runId: paket.runId,
      yazildi: new Date().toISOString(),
    }));
    await unlink(partialYolu);

    const eskiDizinler: string[] = [];
    for (let deneme = 0; deneme < 10; deneme += 1) {
      const eskiDizin = altYol(hataKoku, `.eski-${paket.testId}-${randomUUID()}`);
      try {
        await rename(paketDizini, eskiDizin);
        eskiDizinler.push(eskiDizin);
      } catch (hata: unknown) {
        if (!(typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT')) throw hata;
      }

      try {
        await rename(geciciDizin, paketDizini);
        await Promise.all(eskiDizinler.map((yol) => rm(yol, { recursive: true, force: true })));
        return paketDizini;
      } catch (hata: unknown) {
        if (typeof hata === 'object' && hata !== null && 'code' in hata && (hata.code === 'EEXIST' || hata.code === 'ENOTEMPTY')) {
          continue;
        }
        const geriYuklenecek = eskiDizinler.at(-1);
        if (geriYuklenecek !== undefined) await rename(geriYuklenecek, paketDizini).catch(() => undefined);
        throw hata;
      }
    }
    throw new Error(`Hata paketi yayımlanamadı: ${paket.testId}`);
  }

  async hataPaketiOku(testId: string): Promise<HataPaketi> {
    const paketDizini = this.hataPaketiYolu(testId);
    try {
      await access(join(paketDizini, '.partial'));
      throw new PaketYarim(testId);
    } catch (hata) {
      if (hata instanceof PaketYarim) throw hata;
      if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code !== 'ENOENT') throw hata;
    }
    return jsonOku(join(paketDizini, 'failure.json'), HataPaketiSemasi);
  }

  /**
   * Yayımlanmış paketin dosyalarını boş bir klasöre kopyalar. Kopya sırasında
   * paket yeniden yazıldıysa (snapshotId değiştiyse) yarım kopya kabul edilmez.
   */
  private async paketDosyalariniKopyala(testId: string, hedef: string): Promise<void> {
    const kaynak = this.hataPaketiYolu(testId);
    const oncekiMeta = await jsonOku(join(kaynak, 'meta.json'), PaketMetaSemasi);
    for (const girdi of await readdir(kaynak, { withFileTypes: true })) {
      if (!girdi.isFile()) continue;
      await yazAtomik(join(hedef, girdi.name), await readFile(join(kaynak, girdi.name)));
    }
    const sonrakiMeta = await jsonOku(join(kaynak, 'meta.json'), PaketMetaSemasi);
    if (oncekiMeta.snapshotId !== sonrakiMeta.snapshotId) {
      throw new Error(`Hata paketi kopyalanırken değişti: ${testId}`);
    }
  }

  /**
   * Varsayılan çıkış klasörüne (`.kobay/failure-out/<testId>`) yazar: önce
   * geçici klasöre kopyalar, sonra eskisini kenara alıp yenisini yerine koyar.
   * Böylece aynı testin yeni paketi eskisini eksiksiz değiştirir; kopya yarıda
   * kalırsa var olan klasöre dokunulmamış olur.
   */
  private async hataPaketiniYerineKoy(testId: string, hedef: string): Promise<void> {
    const cikisKoku = await this.varsayilanCikisiDogrula(hedef);
    const geciciDizin = altYol(cikisKoku, `.tmp-${testId}-${randomUUID()}`);
    await mkdir(geciciDizin, { recursive: false });
    try {
      await this.paketDosyalariniKopyala(testId, geciciDizin);
    } catch (hata: unknown) {
      await rm(geciciDizin, { recursive: true, force: true });
      throw hata;
    }

    const eskiDizinler: string[] = [];
    for (let deneme = 0; deneme < 10; deneme += 1) {
      const eskiDizin = altYol(cikisKoku, `.eski-${testId}-${randomUUID()}`);
      try {
        await rename(hedef, eskiDizin);
        eskiDizinler.push(eskiDizin);
      } catch (hata: unknown) {
        if (hataKodu(hata) !== 'ENOENT') throw hata;
      }

      try {
        await rename(geciciDizin, hedef);
      } catch (hata: unknown) {
        const kod = hataKodu(hata);
        if (kod === 'EEXIST' || kod === 'ENOTEMPTY') continue;
        const geriYuklenecek = eskiDizinler.at(-1);
        if (geriYuklenecek !== undefined) await rename(geriYuklenecek, hedef).catch(() => undefined);
        await rm(geciciDizin, { recursive: true, force: true });
        throw hata;
      }
      // Denetim ile taşıma arasında yol symlink'e çevrilmiş olabilir: `rm` hangi
      // klasörleri sileceğini bilmeden çalışmasın, önce yol yeniden doğrulanır.
      // Doğrulama düşerse eskiler silinmez; iz kalır ama dışarısı silinmez.
      await this.varsayilanCikisiDogrula(hedef);
      await Promise.all(eskiDizinler.map((yol) => rm(yol, { recursive: true, force: true })));
      return;
    }
    await rm(geciciDizin, { recursive: true, force: true });
    throw new Error(`Hata paketi kopyalanamadı: ${testId}`);
  }

  /**
   * Sabit çıkış yolunun (`.kobay/failure-out/<testId>`) gerçekten depo içinde
   * olduğunu doğrular ve çıkış kökünü döndürür. Yerinde yenileme eskisini
   * `rm -r` ile sildiği için, yolun üç bileşeni (`.kobay`, `failure-out`,
   * `<testId>`) tek tek `lstat` ile denetlenir: biri symlink ise ya da çıkış
   * kökünün gerçek yolu `.kobay` altına düşmüyorsa reddedilir. Proje kökünün
   * üstündeki symlink'ler (macOS'ta `/var` → `/private/var`) sorun değildir;
   * karşılaştırma `.kobay`'ın gerçek yoluna göre yapılır.
   */
  private async varsayilanCikisiDogrula(hedef: string): Promise<string> {
    const kobayDurumu = await lstat(this.kok);
    if (kobayDurumu.isSymbolicLink() || !kobayDurumu.isDirectory()) {
      throw new GuvensizCikisYolu(this.kok, '.kobay bir dizin değil ya da symlink');
    }

    const cikisKoku = this.yol('failure-out');
    await mkdir(cikisKoku).catch((hata: unknown) => {
      if (hataKodu(hata) !== 'EEXIST') throw hata;
    });
    const cikisDurumu = await lstat(cikisKoku);
    if (cikisDurumu.isSymbolicLink() || !cikisDurumu.isDirectory()) {
      throw new GuvensizCikisYolu(cikisKoku, 'failure-out bir dizin değil ya da symlink');
    }
    const gercekCikis = await realpath(cikisKoku);
    if (gercekCikis !== join(await realpath(this.kok), 'failure-out')) {
      throw new GuvensizCikisYolu(cikisKoku, 'gerçek yolu .kobay altında değil');
    }

    const hedefDurumu = await lstat(hedef).catch((hata: unknown) => {
      if (hataKodu(hata) === 'ENOENT') return null;
      throw hata;
    });
    if (hedefDurumu !== null && hedefDurumu.isSymbolicLink()) {
      throw new GuvensizCikisYolu(hedef, 'hedef klasör symlink');
    }
    if (hedefDurumu !== null && await realpath(hedef) !== join(gercekCikis, basename(hedef))) {
      throw new GuvensizCikisYolu(hedef, 'gerçek yolu .kobay/failure-out altında değil');
    }
    return cikisKoku;
  }

  /**
   * Yayımlanmış hata paketini hedef klasöre kopyalar. Hedef, testin varsayılan
   * çıkış klasörüyse (`.kobay/failure-out/<testId>`) içerik güvenle üzerine
   * yazılır: eski paketten kalıntı kalmaz. Kullanıcının verdiği başka bir
   * klasör var olamaz; oradaki dosyaları ezmeyiz.
   */
  async hataPaketiKopyala(testId: string, hedefKlasor: string): Promise<void> {
    kimlikDogrula(testId, 'testId');
    await this.hataPaketiOku(testId);
    const hedef = resolve(hedefKlasor);
    if (hedef === hataPaketiCikisYolu(this.projeKoku, testId)) {
      await this.hataPaketiniYerineKoy(testId, hedef);
      return;
    }

    try {
      await lstat(hedef);
      throw new Error(`Hedef klasör zaten var: ${hedefKlasor}`);
    } catch (hata: unknown) {
      if (hata instanceof Error && hata.message.startsWith('Hedef klasör zaten var:')) throw hata;
      if (hataKodu(hata) !== 'ENOENT') throw hata;
    }

    await mkdir(dirname(hedef), { recursive: true });
    await mkdir(hedef, { recursive: false });
    await this.paketDosyalariniKopyala(testId, hedef);
  }

  /** Yayımlanmış paketin gösterdiği koşu; paket yoksa ya da okunamıyorsa undefined. */
  private async paketinKosusu(testId: string): Promise<string | undefined> {
    try {
      const paket = await jsonOku(join(this.hataPaketiYolu(testId), 'failure.json'), PaketKosuSemasi);
      return paket.runId;
    } catch {
      return undefined;
    }
  }

  /**
   * Bir testin koşu dizinlerini budar: en yeni `sakla` tanesi, `korunanlar`
   * kümesindekiler, son `tazeMs` içinde bitenler ve yayımlanmış hata paketinin
   * gösterdiği koşu kalır, gerisi silinir. Yalnız `.kobay/runs/` altında ve
   * koşu kimliği desenine uyan, bu teste ait `result.json` taşıyan dizinler
   * silinir; yarım kalmış ya da başka teste ait dizine dokunulmaz.
   *
   * Eşzamanlı koşulara karşı iki kural: karar tek bir liste anlık görüntüsü
   * üzerinde verilir (araya giren koşu adaya dönüşemez) ve her aday silinmeden
   * hemen önce `result.json` yeniden okunur (arada bitmişse kanıtı kalır).
   *
   * Silinen koşuların kimliklerini döndürür.
   */
  async kosulariBuda(testId: string, secenekler: BudamaSecenekleri = {}): Promise<string[]> {
    kimlikDogrula(testId, 'testId');
    const { sakla = SAKLANAN_KOSU, korunanlar, tazeMs = TAZE_KOSU_MS } = secenekler;
    // Liste bir kez okunur: budama boyunca karar hep bu anlık görüntüye göre verilir.
    const kosular = await this.kosuListele(testId);
    if (kosular.length <= sakla) return [];

    const korunan = new Set<string>(korunanlar ?? []);
    for (const kosu of kosular.slice(-sakla)) korunan.add(kosu.runId);
    const paketKosusu = await this.paketinKosusu(testId);
    if (paketKosusu !== undefined) korunan.add(paketKosusu);

    const silinen: string[] = [];
    for (const kosu of kosular) {
      if (korunan.has(kosu.runId) || kosuTazeMi(kosu, Date.now() - tazeMs)) continue;
      // Silmeden hemen önce son bir kez bak: aday, liste alındıktan sonra bitmiş
      // ya da result.json'unu kaybetmiş olabilir; ikisinde de dizine dokunma.
      const guncel = await yoksaNull(() => this.kosuSonucuOku(kosu.runId));
      if (guncel === null || guncel.testId !== testId) continue;
      if (kosuTazeMi(guncel, Date.now() - tazeMs)) continue;
      await rm(this.kosuYolu(kosu.runId), { recursive: true, force: true });
      silinen.push(kosu.runId);
    }
    return silinen;
  }
}
