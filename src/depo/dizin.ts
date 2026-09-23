import {
  access, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink,
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
import { FileNotFound, jsonOku, yazAtomik } from './dosya.js';
import { eskiAnahtarVarMi, eskiIsaretineEsle, kalicidanEsle } from './anahtar-gocu.js';

export class BundleIncomplete extends Error {
  constructor(testId: string) {
    super(`Failure bundle incomplete: ${testId}`);
    this.name = 'BundleIncomplete';
  }
}

/** Depo içindeki test ve koşu yollarına yalnız üretilen kimlikler girebilir. */
export class InvalidId extends Error {
  constructor(kimlik: string, tur: 'testId' | 'runId') {
    super(`Invalid ${tur}: ${kimlik}`);
    this.name = 'InvalidId';
  }
}

/**
 * Sabit hata paketi çıkışı (`.kobay/failure-out/<testId>`) symlink üzerinden
 * depo dışını gösteriyor. Yerinde yenileme eskisini silerek çalıştığı için
 * böyle bir yolda hiç çalışmaz: kötü niyetli bir klon `.kobay/` içine dışarıyı
 * gösteren bir bağ koyup kök dışındaki klasörü sildiremesin.
 */
export class UnsafeOutputPath extends Error {
  constructor(yol: string, sebep: string) {
    super(
      `Unsafe failure bundle output path: ${yol} (${sebep}).`
      + ' Remove the link under `.kobay/failure-out`, or point somewhere else with `--out <dir>`.',
    );
    this.name = 'UnsafeOutputPath';
  }
}

/**
 * Kimlik işlemi kesinleşme noktasına varamadı: kenara alınan dosya yerinde
 * değil ya da işlem işareti başka bir sürece geçmiş. Sessizce "başarılı"
 * denmez; kullanıcı hangi komutla durumu düzelteceğini görür.
 */
export class CredentialsTxnCorrupt extends Error {
  constructor(neden: string) {
    super(
      `Credentials transaction broke: ${neden}.`
      + ' A second kobay process may have run in the same project;'
      + ' verify the target with `kobay project get`, and if a login is needed,'
      + ' set it again with `kobay project create --url <URL> --login --force`.',
    );
    this.name = 'CredentialsTxnCorrupt';
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
export class CredentialsRollbackFailed extends Error {
  constructor(neden: string, asilHata?: unknown) {
    super(
      `Credentials transaction could not be rolled back: ${neden}.`
      + ' The rollback did not finish; the `.kobay/.credentials-txn` and `.kobay/.kimlik-islemi`'
      + ' markers and the set-aside copies were kept,'
      + ' and the next kobay command will retry the rollback.'
      + ' Fix the cause (disk space, file permissions, read-only file system) and'
      + ' run the command again.'
      + (asilHata === undefined
        ? ''
        : ` Original error that triggered the rollback: ${asilHata instanceof Error ? asilHata.message : String(asilHata)}.`),
    );
    this.name = 'CredentialsRollbackFailed';
  }
}

/**
 * Aynı projede yürüyen bir kimlik işlemi varken ikinci bir komut kimliği
 * değiştirmeye kalktı. İşaret dosyası tek sahipli bir kilittir: ikinci komut
 * beklemez, reddedilir (çıkış 2 — kullanıcı komutu yeniden çalıştırır).
 */
export class CredentialsTxnInProgress extends Error {
  constructor(sahip?: { pid: number; startedAt: string }) {
    super(
      'Another kobay command is changing this project\'s credentials'
      + (sahip === undefined ? '' : ` (pid ${sahip.pid}, started ${sahip.startedAt})`)
      + '; wait for it to finish, then run the command again.'
      + ' If that process is no longer running, the marker expires within 10 minutes at the latest;'
      + ' you can also delete `.kobay/.credentials-txn` and `.kobay/.kimlik-islemi` by hand'
      + ' (during the 0.1 compatibility window a transaction holds both names).',
    );
    this.name = 'CredentialsTxnInProgress';
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
  // 0.1'in `.eski-*` öneki de listede kalır: eski projelerdeki kalıntı da dışlansın.
  '.stale-*',
  '.eski-*',
  // Yürüyen kimlik işleminin işaret dosyası ve devralma kopyası; yalnız bu makineyi ilgilendirir.
  '.credentials-txn*',
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

/** Keşif haritası ve öneri listesi; 0.1'de Türkçe adlıydı, açılışta yeniden adlandırılır. */
const HARITA_DOSYASI = 'map.json';
const ONERI_DOSYASI = ['plan', 'proposals.json'] as const;
/**
 * 0.1 adları. Yalnız göçte değil OKUMADA da lazım: göç yazılamayan bir dosya
 * sisteminde düşerse okuma yolu bu adlara düşer, yoksa kullanıcının haritası
 * sessizce yok olurdu.
 */
const ESKI_HARITA_DOSYASI = 'harita.json';
const ESKI_ONERI_DOSYASI = ['plan', 'onerileri.json'] as const;
const YENIDEN_ADLANDIRILANLAR: ReadonlyArray<{ eski: readonly string[]; yeni: readonly string[] }> = [
  { eski: [ESKI_HARITA_DOSYASI], yeni: [HARITA_DOSYASI] },
  { eski: [...ESKI_ONERI_DOSYASI], yeni: [...ONERI_DOSYASI] },
];

/**
 * Alan adları yerinde göç eden dosyalar. Ad değişmez, yalnız içerik yeni
 * anahtarlarla yeniden yazılır; böylece ilk komuttan sonra diskte tek sözleşme
 * kalır. Sıra önemsiz — harita ve öneriler bu adımdan önce yeni adlarına taşınır.
 */
const ALAN_GOCU_DOSYALARI: ReadonlyArray<{ ad: readonly string[]; mod?: number }> = [
  { ad: ['config.json'] },
  { ad: ['credentials.json'], mod: 0o600 },
  { ad: [HARITA_DOSYASI] },
  { ad: [...ONERI_DOSYASI] },
];

/**
 * Kenara alınan kimlik/oturum kopyasının adı: `.stale-<txnId>-<asıl ad>`.
 * Ad işlemin kimliğini taşır; kurtarma böylece yalnız kendi sahiplendiği
 * işlemin kalıntısını toparlar, başkasınınkine dokunmaz. 0.1'in `.eski-`
 * öneki yeniden adlandırılmaz, yalnız kurtarmada tanınır.
 */
const KENARA_ONEKI = '.stale-';
const ESKI_KENARA_ONEKI = '.eski-';
const KENARA_ONEKLERI = [KENARA_ONEKI, ESKI_KENARA_ONEKI] as const;
const KENARA_DESENI = /^\.(?:stale|eski)-([0-9a-f-]{36})-(credentials\.json|storageState\.json)$/;

/**
 * Yürüyen kimlik işleminin işaret dosyası; tek sahipli kilittir. `O_EXCL` ile
 * oluşturulur: taze bir işaret varken ikinci komut kimliği değiştiremez
 * (`CredentialsTxnInProgress`). Kesinleştirme ve geri alma işareti yalnız geriye
 * kalıntı kalmadıysa siler; kalıntı kaldıysa işaret (kesinleşme durumuyla
 * birlikte) kurtarmaya bilgi taşısın diye yerinde bırakılır.
 */
const KIMLIK_ISARETI = '.credentials-txn';
/** 0.1'in işaret adı; yeni işlem yazmaz, kurtarma ve kilit tanır. */
const ESKI_KIMLIK_ISARETI = '.kimlik-islemi';
/**
 * Bayat işareti devralırken kullanılan benzersiz ad. Devralma yarışını
 * `rename` kazananı belirler: bayat işaret bu ada taşınabilen tek süreç
 * kilidi alır, ötekiler reddedilir.
 */
const DEVIR_ONEKI = '.credentials-txn-takeover-';
const ESKI_DEVIR_ONEKI = '.kimlik-islemi-devir-';
const DEVIR_ONEKLERI = [DEVIR_ONEKI, ESKI_DEVIR_ONEKI] as const;
/**
 * İşaret bundan eskiyse sahipsiz sayılır. Gerçek bir işlem birkaç saniye sürer;
 * 10 dakika, süreci öldürülmüş ya da asılmış bir işlemin kalıntısının sonsuza
 * dek beklememesi için konmuş üst sınırdır.
 */
const KIMLIK_ISARETI_TAZELIK_MS = 10 * 60 * 1000;

const KimlikIsaretiGovdesi = v.object({
  pid: v.number(),
  txnId: v.string(),
  startedAt: v.string(),
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
   * Config sır taşımaz (baseUrl, docsPath, loginUrl, brain ayarı); parola
   * yalnız `credentials.json`'dadır.
   */
  previousConfig: v.optional(KobayConfigSemasi),
  /**
   * İşlemin sonunda `--login` ile yeni bir `credentials.json` yazılacak mıydı?
   * Kenara alınacak eski kimlik yokken çöken bir işlemin ardında kalan yeni
   * kimlik, tam geri almada silinir; yoksa yeni hedefin parolası eski config'in
   * altında kalırdı.
   */
  willWriteNewCredentials: v.optional(v.boolean(), false),
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
  setAside: v.optional(v.array(v.string())),
});

/** 0.1'in Türkçe alan adlarıyla yazılmış işaret dosyası da okunabilmeli; yoksa yarım işlem kurtarılamaz. */
const KimlikIsaretiSemasi = v.pipe(v.unknown(), v.transform(kalicidanEsle), KimlikIsaretiGovdesi);

type KimlikIsareti = v.InferOutput<typeof KimlikIsaretiGovdesi>;

/**
 * İşaret hâlâ yürüyen bir işleme mi ait? Hem yazan sürecin yaşıyor olması hem
 * de işaretin 10 dakikadan yeni olması gerekir. Mutlak değer: saat geriye
 * alınmışsa gelecek tarihli işaret sonsuza dek taze kalmasın.
 */
function isaretTazeMi(isaret: KimlikIsareti): boolean {
  const yas = Date.now() - Date.parse(isaret.startedAt);
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
  return !geriAlinamayanIslemler.has(isaret.txnId) && isaretTazeMi(isaret);
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

/**
 * Sert bağın (`link`) desteklenmediği dosya sistemlerinin verdiği kodlar.
 * Göç yayımı `link` üzerinden yapılır; bu kodlarda körlemesine `rename`'e
 * düşmek yerine "hedef yoksa taşı" yoluna geçilir.
 */
const LINK_DESTEKLENMIYOR = new Set(['EPERM', 'EXDEV', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP']);

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
      `[kobay] Warning: ${yol} could not be updated (${kod}); do not add the .kobay/ directory to git,`
      + ' failure bundles may contain session cookies.\n',
    );
  }
}

/** Yol duruyor mu? `access` hatası "yok" sayılır; kilit kararı için yeter. */
function dosyaDuruyorMu(yol: string): Promise<boolean> {
  return access(yol).then(() => true, () => false);
}

async function yoksaNull<T>(islem: () => Promise<T>): Promise<T | null> {
  try {
    return await islem();
  } catch (hata) {
    if (hata instanceof FileNotFound) return null;
    throw hata;
  }
}

function guvenliAd(ad: string): void {
  if (basename(ad) !== ad || ad === '.' || ad === '..') {
    throw new Error('Attachment target must be a bare file name');
  }
}

function kimlikDogrula(kimlik: string, tur: 'testId' | 'runId'): void {
  const desen = tur === 'testId' ? TEST_KIMLIGI : KOSU_KIMLIGI;
  if (!desen.test(kimlik)) throw new InvalidId(kimlik, tur);
}

/** Çözümlenen yolun, beklenen depo alt dizininden dışarı çıkmadığını doğrular. */
function altYol(kok: string, ...parcalar: string[]): string {
  const cozulmusKok = resolve(kok);
  const cozulmusYol = resolve(cozulmusKok, ...parcalar);
  const fark = relative(cozulmusKok, cozulmusYol);
  if (fark === '' || fark === '..' || fark.startsWith(`..${sep}`) || isAbsolute(fark)) {
    throw new Error(`Path is outside the store subdirectory: ${cozulmusYol}`);
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
   *    `CredentialsTxnCorrupt` fırlatılır ve çağıran işlemi geri alabilir.
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
   * yutulmaz — düşen adımda durulur, işaret silinmez ve `CredentialsRollbackFailed`
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
    await dizin.eskiSurumdenGocur();
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
        `[kobay] Warning: the working directories under ${this.kok} could not be created (${kod});`
        + ' writing runs and failure bundles may fail.\n',
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
   * 0.1'den kalan dosya adlarını tek yönlü olarak yerine oturtur:
   * `harita.json` → `map.json`, `plan/onerileri.json` → `plan/proposals.json`.
   *
   * Yayım `link` + `unlink` ile yapılır, `rename` ile DEĞİL. `rename` hedefin
   * üstüne yazar: "hedef var mı" kontrolü ile taşıma arasında araya giren bir
   * süreç yeni `map.json`'ı yazarsa bayat 0.1 dosyası onu eziyordu. `link`
   * hedef doluyken `EEXIST` verir; o zaman kaynağa dokunulmaz, yeni dosya
   * korunur. Kaynak yoksa (`ENOENT`) sessizce geçilir.
   *
   * Sert bağ desteklemeyen dosya sistemlerinde (`EPERM`/`EXDEV`/`ENOSYS`)
   * körlemesine `rename`'e düşülmez; yalnız "hedef yoksa taşı" denenir. O
   * yolda kontrol ile taşıma arasındaki pencere açık kalır — bu, sert bağsız
   * dosya sistemleriyle sınırlı bilinçli bir kalıntıdır.
   *
   * Yazma hakkı olmayan dosya sisteminde komut düşmez: tek satır uyarı yazılır
   * ve okuma yolu eski ada düşer (`eskiAdaDuserekOku`), yani veri görünmez olmaz.
   */
  private async eskiDosyaAdlariniTasi(): Promise<void> {
    for (const { eski, yeni } of YENIDEN_ADLANDIRILANLAR) {
      const kaynak = this.yol(...eski);
      const hedef = this.yol(...yeni);
      try {
        try {
          await link(kaynak, hedef);
        } catch (hata: unknown) {
          if (!LINK_DESTEKLENMIYOR.has(hataKodu(hata) ?? '')) throw hata;
          if (await dosyaDuruyorMu(hedef)) continue;
          await rename(kaynak, hedef);
        }
      } catch (hata: unknown) {
        const kod = hataKodu(hata);
        if (kod === 'ENOENT' || kod === 'EEXIST' || kod === 'ENOTEMPTY') continue;
        if (kod === undefined || !YAZILAMAZ_KODLARI.has(kod)) throw hata;
        process.stderr.write(
          `[kobay] Warning: could not migrate ${eski.join('/')} to ${yeni.join('/')} (${kod});`
          + ' reading the old file; fix permissions.\n',
        );
        continue;
      }
      // Bağ kuruldu: iki ad da aynı içeriği gösteriyor, eski adı bırakabiliriz.
      // (Yedek yol `rename` ile taşıdıysa kaynak zaten yok; ENOENT yutulur.)
      await unlink(kaynak).catch(() => undefined);
    }
  }

  /**
   * `config.json` ve `credentials.json`'ı yerinde yeni alan adlarına çevirir.
   * Okuma zaten eski adları da kabul ediyor; bu adım dosyanın kendisini de
   * tekilleştirir, böylece kullanıcı diskte tek bir sözleşme görür. Bozuk JSON'a
   * dokunulmaz (şema hatasını kullanıcı görsün), eski anahtar yoksa disk hiç
   * yazılmaz. `credentials.json` 0600 ile yeniden yazılır.
   */
  private async alanAdlariniGocur(): Promise<void> {
    for (const { ad, mod } of ALAN_GOCU_DOSYALARI) {
      const yol = this.yol(...ad);
      let ham: string;
      try {
        ham = await readFile(yol, 'utf8');
      } catch (hata: unknown) {
        if (hataKodu(hata) === 'ENOENT') continue;
        throw hata;
      }
      let veri: unknown;
      try {
        veri = JSON.parse(ham) as unknown;
      } catch {
        continue;
      }
      if (!eskiAnahtarVarMi(veri)) continue;
      try {
        await yazAtomik(yol, jsonYaz(kalicidanEsle(veri)), mod);
      } catch (hata: unknown) {
        const kod = hataKodu(hata);
        if (kod === undefined || !YAZILAMAZ_KODLARI.has(kod)) throw hata;
        return;
      }
    }
  }

  /** Açılış kancasının göç adımı: önce ad, sonra içerik. */
  private async eskiSurumdenGocur(): Promise<void> {
    await this.eskiDosyaAdlariniTasi();
    await this.alanAdlariniGocur();
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
        // Göç en sonda: kurtarmanın geri koyduğu `credentials.json` de eski
        // alan adlarını taşıyor olabilir, o da bu adımda yenisine çevrilsin.
        await dizin.eskiSurumdenGocur();
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
   * origin değiştiğinde). Dosyalar silinmez, `.stale-<txnId>-<ad>` geçici
   * adına taşınır; silme işi `kesinlestir`'e kalır. Dosya yoksa sessizce
   * geçilir. Taşıma yarıda düşerse o ana kadar taşınanlar hemen geri konur.
   *
   * Aynı projede taze bir kimlik işlemi yürüyorsa kilit alınamaz ve çağrı
   * `CredentialsTxnInProgress` ile reddedilir: beklemek yok, kullanıcı komutu
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
            if (!duruyor) throw new CredentialsTxnCorrupt(`the set-aside ${ad} is not in place`);
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
                `[kobay] Warning: the set-aside copy of ${ad} could not be deleted (${sebep});`
                + ` ${KENARA_ONEKI}${islemId}-${ad} was left in place,`
                + ' the next kobay command will clean it up.\n',
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
   * İşaretin iki adı, yeni ad önce. Uyumluluk döneminde (0.1 ile 0.2 aynı
   * projede koşabilir) kilit İKİ dosyayla birden tutulur: 0.2 ikisini de
   * `O_EXCL` ile yaratır, ikisini de birlikte günceller ve ikisini de birlikte
   * siler. Böylece 0.1 süreci — yalnız `.kimlik-islemi`'ni tanır — eski adda
   * takılır, 0.2 süreci de 0.1'in bıraktığı işareti görür. Gövdeler aynı değil:
   * eski ad 0.1'in Türkçe şemasıyla yazılır (bkz. `isaretGovdeleri`).
   */
  private isaretYollari(): readonly [string, string] {
    return [this.yol(KIMLIK_ISARETI), this.yol(ESKI_KIMLIK_ISARETI)];
  }

  /**
   * Aynı kaydın iki yüzü, `isaretYollari()` ile aynı sırada: yeni ad İngilizce
   * şemayla, 0.1'in adı 0.1'in Türkçe şemasıyla.
   *
   * İki dosyaya aynı İngilizce gövdeyi yazmak kilidi sahte yapıyordu: 0.1
   * `.kimlik-islemi`'yi kendi Türkçe şemasıyla doğrular, İngilizce gövdeyi
   * geçersiz sayıp siler ve kendi işlemini başlatırdı. Yani iki süreç aynı anda
   * kimlik değiştirebiliyordu. Bilgi aynı, yalnız alan adları eski.
   */
  private isaretGovdeleri(kayit: Record<string, unknown>): readonly [string, string] {
    return [jsonYaz(kayit), jsonYaz(eskiIsaretineEsle(kayit))];
  }

  /**
   * İşaret kaydını iki ada da atomik olarak yazar; her ad kendi şemasıyla.
   * Kilit bizdeyse iki dosya da bizimdir ve aynı işlemi anlatmalıdır. Yeni ad
   * önce yazılır: yazım düşerse eski ad da değişmemiş olur, yani ikisi de işlem
   * öncesi hâlinde kalır.
   */
  private async isaretGovdesiniYaz(kayit: Record<string, unknown>): Promise<void> {
    const govdeler = this.isaretGovdeleri(kayit);
    const yollar = this.isaretYollari();
    for (const [sira, yol] of yollar.entries()) {
      await yazAtomik(yol, govdeler[sira] as string, 0o600);
    }
  }

  /** Verilen işaret dosyalarını siler; hata yutulur (kilit zaten elimizde değil). */
  private async isaretleriKaldir(yollar: readonly string[]): Promise<void> {
    for (const yol of yollar) await unlink(yol).catch(() => undefined);
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
   * `CredentialsRollbackFailed` fırlatılır. Çağıran işareti silmediği için — ve
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
      throw new CredentialsRollbackFailed(neden, a.asilHata);
    };

    if (a.eskiConfig !== null) {
      try {
        await this.configYaz(a.eskiConfig);
      } catch (hata: unknown) {
        dus(
          `config.json could not be written back to its pre-transaction target (${a.eskiConfig.baseUrl})`
          + ` (${hataMetni(hata)}); the set-aside credentials and session were deliberately not restored`,
        );
      }
    }

    for (const { kaynak, asilAd } of a.kopyalar) {
      try {
        await rename(kaynak, this.yol(asilAd));
      } catch (hata: unknown) {
        // Başka bir kobay süreci aynı kopyayı çoktan geri koymuş olabilir.
        if (hataKodu(hata) === 'ENOENT') continue;
        dus(`the copy ${basename(kaynak)} could not be restored as ${asilAd} (${hataMetni(hata)})`);
      }
    }

    // Silme kararı yalnız kalıcı olguya dayanır. Kalan kopyalara bakmak
    // veri kaybettiriyordu: ilk geri alma denemesi `credentials.json`
    // kopyasını geri koyup sonraki adımda düştüğünde, ikinci deneme geriye
    // kalan kopyalarda kimlik göremiyor ve "kenara alınacak eskisi yokmuş"
    // diye geri konmuş ORİJİNAL dosyayı siliyordu.
    if (a.yeniKimlikYazildi && a.eskiKimlikVardi === undefined) {
      process.stderr.write(
        '[kobay] Warning: the unfinished credentials transaction record has no set-aside file list'
        + ' (left over from an older kobay version, or the process died before the record reached disk);'
        + ' a credentials.json that may have been written during the transaction was deliberately kept.'
        + ' Check the target with `kobay project get`; if the credentials belong to the wrong target,'
        + ' set them again with `kobay project create --url <URL> --login --force`.\n',
      );
    } else if (a.yeniKimlikYazildi && a.eskiKimlikVardi === false) {
      try {
        await rm(this.yol('credentials.json'), { force: true });
      } catch (hata: unknown) {
        dus(
          `the credentials.json written during the transaction could not be deleted (${hataMetni(hata)});`
          + ' the new target\'s password would have stayed under the old config',
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
    const govdeler = this.isaretGovdeleri({
      pid: process.pid,
      txnId: islemId,
      startedAt: new Date().toISOString(),
      // Geri alma kaydı işlemin ilk adımında, ilk rename'den önce diske iner:
      // çökme hangi adımda olursa olsun kurtarma eski hâli biliyor olur.
      ...(baglam.eskiConfig === null ? {} : { previousConfig: baglam.eskiConfig }),
      ...(baglam.yeniKimlikYazilacak === true ? { willWriteNewCredentials: true } : {}),
    });
    // İKİ ad da `O_EXCL` ile yaratılır. Eskiden yalnız "eski ad duruyor mu"
    // diye bakılıp yenisi yaratılıyordu: kontrol ile yaratma arasında 0.1
    // süreci kendi işaretini koyabiliyor ve iki sahip doğuyordu. Şimdi kazanan
    // her iki dosyayı da yaratabilen tek süreçtir; ikincisi `EEXIST` verirse
    // birincisi silinip çekiliriz.
    const alinan: string[] = [];
    for (const [sira, yol] of this.isaretYollari().entries()) {
      let tutamac;
      try {
        tutamac = await open(yol, 'wx', 0o600);
      } catch (hata: unknown) {
        await this.isaretleriKaldir(alinan);
        if (hataKodu(hata) === 'EEXIST') return false;
        throw hata;
      }
      try {
        await tutamac.writeFile(govdeler[sira] as string);
      } finally {
        await tutamac.close();
      }
      alinan.push(yol);
    }
    return true;
  }

  /**
   * Kenara alma bittiğinde işlemin kalıcı olgusunu işarete ekler: hangi asıl
   * adlar kenara alındı. İşaret sahibi değişmeden atomik olarak yeniden
   * yazılır; öteki alanlar (`previousConfig`, `willWriteNewCredentials`) korunur.
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
    if (isaret === null || isaret.txnId !== islemId) {
      throw new CredentialsTxnCorrupt('the transaction marker disappeared or moved to another process');
    }
    await this.isaretGovdesiniYaz({ ...isaret, setAside: adlar });
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
    if (isaret !== null && isaret.txnId !== islemId) {
      throw new CredentialsTxnCorrupt('the transaction marker moved to another process');
    }
    // Geri alma kaydı (`previousConfig`, `willWriteNewCredentials`, `setAside`)
    // bilerek düşürülür:
    // kesinleşmiş bir işlem bir daha geri alınmaz, kayıt yalnız yanlışlıkla
    // kullanılmaya açık kalırdı.
    await this.isaretGovdesiniYaz({
      pid: isaret?.pid ?? process.pid,
      txnId: islemId,
      startedAt: isaret?.startedAt ?? new Date().toISOString(),
      committed: true,
    });
  }

  /**
   * Kesinleşmiş bir işlemin geriye bıraktığı yedekleri siler. Kesinleşmeden
   * sonra yedek artık geçersizdir: asıl dosya yerinde olsa da olmasa da geri
   * konmaz, çünkü geri koymak eski origin'in oturumunu yeni hedefin yanına
   * taşır.
   */
  private async kesinlesmisKalintilariSil(islemId: string): Promise<void> {
    for (const ad of KIMLIK_DOSYALARI) {
      for (const onek of KENARA_ONEKLERI) {
        await rm(altYol(this.kok, `${onek}${islemId}-${ad}`), { force: true });
      }
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
      if (!isaret.committed || isaret.pid !== process.pid) throw new CredentialsTxnInProgress(isaret);
      await this.kesinlesmisKalintilariSil(isaret.txnId);
      // İki ad da bizimdir; ikisi de kaldırılır, yoksa eski ad kilidi sürdürürdü.
      await this.isaretleriKaldir(this.isaretYollari());
      if (!(await this.kimlikIsaretiniOlustur(islemId, baglam))) throw new CredentialsTxnInProgress();
      return;
    }

    // Bayat, kesinleşmemiş ve geri alma kaydı taşıyan işaret devralınamaz.
    // Devralma eski kaydı siler; geri konamamış yedek o anda sahipsiz kalır ve
    // hangi config'in altına ait olduğu bir daha bilinemez. Buraya gelindiyse
    // kurtarma (`bul()`) geri almayı deneyip düşmüştür: önce o düzeltilmeli.
    // Kesinleşmiş işaret (kalıntısı yalnız silinecek) ve `eskiConfig`'siz eski
    // sürüm işareti (geri koyma zaten yapılmıyor) devralınmaya devam eder.
    if (isaret !== null && !isaret.committed && isaret.previousConfig !== undefined) {
      throw new CredentialsRollbackFailed(
        'an unfinished credentials transaction is still pending, so a new transaction that'
        + ' changes credentials cannot be started',
      );
    }

    // Devralma iki adı birden kapsar: yalnız birini almak, öteki adla koşan bir
    // sürecin kilidi elinde tutmasına izin verirdi. Son söz yine
    // `kimlikIsaretiniOlustur`'un iki dosyalık `O_EXCL`indedir — devralma
    // yarışını kaybeden süreç orada takılır.
    const [yeniIsaretYolu, eskiIsaretYolu] = this.isaretYollari();
    const adaylar: Array<{ yol: string; devir: string }> = [];
    for (const { yol, ek } of [{ yol: yeniIsaretYolu, ek: '' }, { yol: eskiIsaretYolu, ek: '-legacy' }]) {
      if (await dosyaDuruyorMu(yol)) adaylar.push({ yol, devir: altYol(this.kok, `${DEVIR_ONEKI}${islemId}${ek}`) });
    }
    const alinan: Array<{ yol: string; devir: string }> = [];
    const isaretleriYerineKoy = async (): Promise<void> => {
      for (const { yol, devir } of alinan) await rename(devir, yol).catch(() => undefined);
    };
    for (const aday of adaylar) {
      try {
        await rename(aday.yol, aday.devir);
      } catch (hata: unknown) {
        // Araya giren süreç bu adı çoktan almış; ötekini alabildiysek sürebiliriz.
        if (hataKodu(hata) === 'ENOENT') continue;
        await isaretleriYerineKoy();
        throw hata;
      }
      alinan.push(aday);
    }
    const ilkAlinan = alinan[0];
    if (ilkAlinan === undefined) throw new CredentialsTxnInProgress();
    const devralinan = await this.isaretOku(ilkAlinan.devir).catch(() => null);
    if (devralinan !== null && devralinan.txnId !== isaret?.txnId) {
      await isaretleriYerineKoy();
      throw new CredentialsTxnInProgress(devralinan);
    }
    for (const { devir } of alinan) await rm(devir, { force: true });
    if (!(await this.kimlikIsaretiniOlustur(islemId, baglam))) throw new CredentialsTxnInProgress();
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

  /**
   * İşaret kaydı. Uyumluluk döneminde iki ad da okunur; normalde ikisi aynı
   * işlemi anlatır. Ayrıldılarsa (biri 0.1, öteki 0.2 süreci tarafından
   * bırakılmış) taze başlangıçlı olan esas alınır ve kullanıcı uyarılır:
   * sessizce birini seçmek, öteki işlemin kalıntısını sahipsiz bırakırdı.
   */
  private async kimlikIsaretiOku(): Promise<KimlikIsareti | null> {
    const [yeniYol, eskiYol] = this.isaretYollari();
    const yeni = await this.isaretOku(yeniYol);
    const eski = await this.isaretOku(eskiYol);
    if (yeni === null) return eski;
    if (eski === null) return yeni;
    if (yeni.txnId === eski.txnId) return yeni;
    const yeniZaman = Date.parse(yeni.startedAt);
    const eskiZaman = Date.parse(eski.startedAt);
    const eskiDahaTaze = Number.isFinite(eskiZaman)
      && (!Number.isFinite(yeniZaman) || eskiZaman > yeniZaman);
    const secilen = eskiDahaTaze ? eski : yeni;
    process.stderr.write(
      `[kobay] Warning: the two credentials transaction markers disagree`
      + ` (${KIMLIK_ISARETI} says ${yeni.txnId}, ${ESKI_KIMLIK_ISARETI} says ${eski.txnId});`
      + ` the newer one (${secilen.txnId}) is used.`
      + ' This usually means an older kobay (0.1) ran in the same project;'
      + ' let that command finish, or remove its marker by hand.\n',
    );
    return secilen;
  }

  /** İşareti yalnız sahibi siler: aynı projede ikinci bir işlem başladıysa onunki kalır. */
  private async kimlikIsaretiniSil(islemId?: string): Promise<void> {
    if (islemId !== undefined) {
      const isaret = await this.kimlikIsaretiOku().catch(() => null);
      if (isaret !== null && isaret.txnId !== islemId) return;
    }
    // İki ad da silinir: eski sürümün bıraktığı işaret geride kalıp kilidi
    // sonsuza dek tutmasın.
    await unlink(this.isaretYolu()).catch(() => undefined);
    await unlink(this.yol(ESKI_KIMLIK_ISARETI)).catch(() => undefined);
  }

  /**
   * Yarım kalmış bir kimlik işleminden kalan `.stale-<txnId>-<ad>` dosyalarını
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
   * - İşaret bayat, kesinleşmemiş ve `previousConfig` taşıyor: işlem kesinleşme
   *   noktasına varamadan düşmüştür; yapılan iş **tam geri almadır**. Önce
   *   config anlık görüntüye geri yazılır (atomik), sonra o `islemId`'nin
   *   yedekleri asıl adlarına — var olan dosyanın üstüne — konur, en sonunda
   *   işaret silinir. Üstüne yazmak doğrudur: kilit yüzünden o dosyaları
   *   yalnız düşen işlemin kendisi (örneğin `--login` ile) yazmış olabilir ve
   *   işlem hiç olmamış sayılır. Sıra önemlidir; config hiçbir anda yanındaki
   *   kimlik/oturumdan başka bir hedefe ait kalmaz. Yedek geri konamazsa hata
   *   yükselir ve işaret yerinde bırakılır: sonraki komut yeniden dener.
   *   `--login` artığının silinip silinmeyeceği işaretteki `setAside`
   *   kaydından okunur; kalan kalıntılardan çıkarım yapılmaz, yoksa önceki
   *   denemenin geri koyduğu orijinal kimlik "artık" sanılıp silinirdi. Kayıt
   *   yoksa silme yapılmaz, uyarılır.
   * - İşaret bayat, kesinleşmemiş ve `previousConfig` yok (eski bir kobay
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
    if (isaret === null) await this.kimlikIsaretiniSil();

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
    if ((sonrakiIsaret?.txnId ?? null) !== (isaret?.txnId ?? null)) return;

    for (const ad of girdiler) {
      // Devralma sırasında süreci ölen komutun bıraktığı kopya; kimseye lazım değil.
      if (DEVIR_ONEKLERI.some((onek) => ad.startsWith(onek))) await rm(this.yol(ad), { force: true });
    }

    const kalintilar: Array<{ ad: string; kalintiId: string; asilAd: string }> = [];
    for (const ad of girdiler) {
      const eslesme = KENARA_DESENI.exec(ad);
      if (eslesme === null) continue;
      kalintilar.push({ ad, kalintiId: eslesme[1] as string, asilAd: eslesme[2] as string });
    }

    for (const { ad, kalintiId, asilAd } of kalintilar) {
      if (isaret !== null && kalintiId === isaret.txnId) continue;
      process.stderr.write(
        `[kobay] Warning: an orphaned credentials copy ${ad} is still around;`
        + ' it was not restored because its target could not be determined'
        + ' (reviving an old session can carry cookies to the wrong target).'
        + ` If you still need its contents, move it to ${asilAd} by hand; otherwise delete the file.\n`,
      );
    }
    if (isaret === null) return;
    const bizim = kalintilar.filter(({ kalintiId }) => kalintiId === isaret.txnId);

    if (isaret.committed) {
      // Kesinleşmiş işlemin kalıntısı geri konmaz; asıl dosya yoksa bile silinir.
      for (const { ad } of bizim) await rm(this.yol(ad), { force: true });
      await this.kimlikIsaretiniSil(isaret.txnId);
      return;
    }

    if (isaret.previousConfig === undefined) {
      for (const { ad, asilAd } of bizim) {
        process.stderr.write(
          `[kobay] Warning: ${ad}, left over from an unfinished credentials transaction, is still around;`
          + ' the transaction record has no pre-transaction config (left over from an older kobay version),'
          + ' so its target could not be determined and it was not restored.'
          + ` If you still need its contents, move it to ${asilAd} by hand; otherwise delete the file.\n`,
        );
      }
      // Kalıntı yerinde kalır ama işaret gider: yoksa kilit sonsuza dek durur.
      await this.kimlikIsaretiniSil(isaret.txnId);
      return;
    }

    // Tam geri alma; işlemin kendi `geriAl()`'ıyla aynı yordam, aynı sıra.
    // Bir adım düşerse `CredentialsRollbackFailed` yükselir: işaret ve kalıntı
    // yerinde kalır, `bul()` hata fırlatır ve komut durur. Eskiden hata
    // uyarıya çevriliyordu; aynı çağrıdaki `project update` bayat işareti
    // devralıp kaydını siliyor, geri konamayan yedek sahipsiz kalıyordu.
    await this.kimlikIsleminiGeriAl({
      islemId: isaret.txnId,
      eskiConfig: isaret.previousConfig,
      kopyalar: bizim.map(({ ad, asilAd }) => ({ kaynak: this.yol(ad), asilAd })),
      yeniKimlikYazildi: isaret.willWriteNewCredentials,
      // Kalan kalıntılara değil işaretteki kalıcı olguya bakılır: önceki geri
      // alma denemesi kimlik kopyasını çoktan geri koymuş olabilir.
      eskiKimlikVardi: isaret.setAside === undefined
        ? undefined
        : isaret.setAside.includes('credentials.json'),
    });
    process.stderr.write(
      '[kobay] Warning: an unfinished target change was rolled back;'
      + ` config went back to the target ${isaret.previousConfig.baseUrl}, and the set-aside credentials`
      + ' and session were restored. If you still want the change, run the command again.\n',
    );
    await this.kimlikIsaretiniSil(isaret.txnId);
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
      // Geri alma hatası uyarıya çevrilmez. Bugün `CredentialsRollbackFailed` bir
      // `code` taşımadığı için aşağıdaki dal da onu yükseltir; bu satır niyeti
      // sabitler: sarmalayan hataya sonradan bir kod iliştirilse bile yutulmaz.
      if (hata instanceof CredentialsRollbackFailed) throw hata;
      const kod = hataKodu(hata);
      if (kod === undefined || !YAZILAMAZ_KODLARI.has(kod)) throw hata;
      process.stderr.write(
        `[kobay] Warning: a leftover credentials copy under ${this.kok} could not be cleaned up (${kod});`
        + ' check the target with `kobay project get`, and the login with `--login --force` if needed.\n',
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

  /**
   * Yeni ad yoksa 0.1'in adını okur. Göç normalde ilk komutta biter; ama
   * yazma hakkı olmayan bir `.kobay`'da (salt okunur kopya, izinleri bozulmuş
   * dizin) göç düşer ve dosya eski adında kalır. Okuma eski ada düşmeseydi
   * kullanıcının haritası/önerileri sessizce yok olurdu. Şemalar iki alan adı
   * düzenini de kabul ettiği için ek çeviri gerekmez.
   */
  private async eskiAdaDuserekOku<T>(
    yeni: readonly string[],
    eski: readonly string[],
    sema: v.GenericSchema<unknown, T>,
  ): Promise<T | null> {
    const sonuc = await yoksaNull(() => jsonOku(this.yol(...yeni), sema));
    if (sonuc !== null) return sonuc;
    return yoksaNull(() => jsonOku(this.yol(...eski), sema));
  }

  haritaOku(): Promise<Harita | null> {
    return this.eskiAdaDuserekOku([HARITA_DOSYASI], [ESKI_HARITA_DOSYASI], HaritaSemasi);
  }

  async haritaYaz(harita: Harita): Promise<void> {
    await yazAtomik(this.yol(HARITA_DOSYASI), jsonYaz(harita));
  }

  onerileriOku(): Promise<Oneri[]> {
    return this
      .eskiAdaDuserekOku([...ONERI_DOSYASI], [...ESKI_ONERI_DOSYASI], v.array(OneriSemasi))
      .then((sonuc) => sonuc ?? []);
  }

  async onerileriYaz(oneriler: Oneri[]): Promise<void> {
    await yazAtomik(this.yol(...ONERI_DOSYASI), jsonYaz(oneriler));
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
      writtenAt: new Date().toISOString(),
    }));
    await unlink(partialYolu);

    const eskiDizinler: string[] = [];
    for (let deneme = 0; deneme < 10; deneme += 1) {
      const eskiDizin = altYol(hataKoku, `.stale-${paket.testId}-${randomUUID()}`);
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
    throw new Error(`Failure bundle could not be published: ${paket.testId}`);
  }

  async hataPaketiOku(testId: string): Promise<HataPaketi> {
    const paketDizini = this.hataPaketiYolu(testId);
    try {
      await access(join(paketDizini, '.partial'));
      throw new BundleIncomplete(testId);
    } catch (hata) {
      if (hata instanceof BundleIncomplete) throw hata;
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
      throw new Error(`Failure bundle changed while being copied: ${testId}`);
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
      const eskiDizin = altYol(cikisKoku, `.stale-${testId}-${randomUUID()}`);
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
    throw new Error(`Failure bundle could not be copied: ${testId}`);
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
      throw new UnsafeOutputPath(this.kok, '.kobay is not a directory, or is a symlink');
    }

    const cikisKoku = this.yol('failure-out');
    await mkdir(cikisKoku).catch((hata: unknown) => {
      if (hataKodu(hata) !== 'EEXIST') throw hata;
    });
    const cikisDurumu = await lstat(cikisKoku);
    if (cikisDurumu.isSymbolicLink() || !cikisDurumu.isDirectory()) {
      throw new UnsafeOutputPath(cikisKoku, 'failure-out is not a directory, or is a symlink');
    }
    const gercekCikis = await realpath(cikisKoku);
    if (gercekCikis !== join(await realpath(this.kok), 'failure-out')) {
      throw new UnsafeOutputPath(cikisKoku, 'its real path is not under .kobay');
    }

    const hedefDurumu = await lstat(hedef).catch((hata: unknown) => {
      if (hataKodu(hata) === 'ENOENT') return null;
      throw hata;
    });
    if (hedefDurumu !== null && hedefDurumu.isSymbolicLink()) {
      throw new UnsafeOutputPath(hedef, 'the destination directory is a symlink');
    }
    if (hedefDurumu !== null && await realpath(hedef) !== join(gercekCikis, basename(hedef))) {
      throw new UnsafeOutputPath(hedef, 'its real path is not under .kobay/failure-out');
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
      throw new Error(`Destination directory already exists: ${hedefKlasor}`);
    } catch (hata: unknown) {
      if (hata instanceof Error && hata.message.startsWith('Destination directory already exists:')) throw hata;
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
