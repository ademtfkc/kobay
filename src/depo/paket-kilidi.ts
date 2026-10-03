import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { guvenliKokuBul, taniEkle, type YolReddi } from './paket-yolu.js';

/**
 * Aynı test kimliğinin hata paketini (`failure/<testId>`) ya da çıkış kopyasını
 * (`failure-out/<testId>`) yazan kobay çağrılarını tek tek geçiren kilit.
 *
 * Kilit, doğrulanmış gerçek kökün içinde `.lock-<testId>` dosyasıdır ve kimlik
 * işlemi işaretiyle (`.credentials-txn`) aynı protokolü izler: `O_EXCL` ile
 * yaratılır; gövdesi sahibin pid'i, benzersiz sahiplik işareti (`token`) ve
 * başlangıç anıdır; bayat kilit benzersiz bir ada taşınarak devralınır ve son
 * sözü yine `O_EXCL` söyler. Kilit altında ortak hedef başka bir kobay yazıcısı
 * tarafından taşınmaz; yayım öncesi ve sonrası yol denetimleri hareketli bir
 * hedefe bakmaz.
 */

/** Bekleme sınırı ve bayatlık eşikleri; testler kısaltabilsin diye nesne. */
export const PAKET_KILIDI = {
  /** Kilit bu süre içinde alınamazsa `BundleLockTimeout`. */
  beklemeMs: 15_000,
  /**
   * Gövdesi okunamayan kilit bu süreden gençse yeni yaratılmış (henüz
   * yazılmamış) sayılır ve beklenir; daha eskiyse yarım kalmış kilittir.
   */
  yazimPayiMs: 5_000,
};

const ILK_BEKLEME_MS = 5;
const AZAMI_BEKLEME_MS = 100;

/**
 * `O_EXCL` açılışının "ad şu an meşgul" anlamına gelebilen kodları. Windows'ta
 * silinmekte olan (delete-pending) bir kilit adı, kalkana dek `EPERM`/`EACCES`
 * verir; antivirüs ya da dizinleyici `EBUSY` verebilir. Bunlar kilidi almak
 * sayılmaz: bekleme sınırı içinde yeniden denenir, sınır dolunca özgün kodla
 * hata verilir.
 */
const MESGUL_KODLARI = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Bu süreçte tutulan kilitlerin işaretleri. Uzun yaşayan bir MCP sunucusunda
 * kendi pid'imizle yazılmış ama burada kaydı olmayan kilit, bırakılamamış
 * eski bir çağrının kalıntısıdır: pid yaşadığı için 10 dakika taze görünür
 * ve sonraki çağrıyı kilitlerdi. Kimlik işlemindeki `geriAlinamayanIslemler`
 * ile aynı çözüm.
 */
const tutulanKilitler = new Set<string>();

export class BundleLockTimeout extends Error {
  readonly code: string | undefined;

  constructor(yol: string, sahip: KilitGovdesi | null, sonHata: unknown) {
    const kod = hataKodu(sonHata);
    super(
      `Timed out waiting for the failure bundle lock: ${yol}`
      + (sahip === null ? '' : ` (held by pid ${sahip.pid} since ${sahip.startedAt})`)
      + (typeof kod === 'string' ? ` (last error: ${kod})` : '')
      + '. Another kobay command may still be writing this bundle; try again when it finishes.'
      + ` If no kobay command is running for this test (the process id may have been reused), delete ${yol} and try again.`,
      sonHata === undefined ? undefined : { cause: sonHata },
    );
    this.name = 'BundleLockTimeout';
    this.code = typeof kod === 'string' ? kod : undefined;
  }
}

/**
 * Kilit artık bu çağrının değil (çökme sonrası devralma yarışında başka bir
 * yazıcıya geçmiş). Geri dönüşü olmayan adımdan önce görüldü: o adım atılmadı,
 * kendi geçici klasörü temizlendi, başkasının kilidine dokunulmadı.
 */
export class BundleLockLost extends Error {
  constructor(yol: string, sebep: string) {
    super(
      `The failure bundle lock ${yol} no longer belongs to this command (${sebep});`
      + ' nothing further was published or deleted. Run the analysis again.',
    );
    this.name = 'BundleLockLost';
  }
}

/**
 * Bayat kilidi devralırken araya giren başka bir yazıcının taze kilidi kenara
 * taşındı ve üstüne yazmadan yerine konamadı. Silinmez: `takeoverPath`'te durur
 * ve sahibi bir sonraki doğrulamada kilidi kaybettiğini görüp güvenle düşer.
 */
export class BundleLockConflict extends Error {
  readonly takeoverPath: string;

  constructor(yol: string, devir: string, sebep: unknown) {
    super(
      `Another kobay command took the failure bundle lock ${yol} while a stale lock was being taken over;`
      + ` its lock could not be put back and is kept at ${devir}. Run the analysis again.`,
      { cause: sebep },
    );
    this.name = 'BundleLockConflict';
    this.takeoverPath = devir;
  }
}

/** Alınmış kilit: geri dönüşü olmayan adımlardan önce `dogrula`, sonunda `birak`. */
export interface PaketKilidi {
  readonly yol: string;
  /** Kilit hâlâ bu çağrının işaretini taşıyor mu; taşımıyorsa `BundleLockLost`. */
  dogrula(): Promise<void>;
  birak(): Promise<void>;
}

interface KilitGovdesi {
  pid: number;
  token: string;
  startedAt: string;
}

function hataKodu(hata: unknown): unknown {
  return typeof hata === 'object' && hata !== null && 'code' in hata ? hata.code : undefined;
}

function mesgulMu(hata: unknown): boolean {
  const kod = hataKodu(hata);
  return typeof kod === 'string' && MESGUL_KODLARI.has(kod);
}

function bekle(ms: number): Promise<void> {
  return new Promise((coz) => setTimeout(coz, ms));
}

/** Süreç hâlâ duruyor mu; EPERM "var ama başkasının" demektir. */
export function pidYasiyor(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (hata: unknown) {
    return hataKodu(hata) === 'EPERM';
  }
}

function govdeyiAyristir(ham: string): KilitGovdesi | null {
  try {
    const veri = JSON.parse(ham) as unknown;
    if (typeof veri !== 'object' || veri === null) return null;
    const { pid, token, startedAt } = veri as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof token !== 'string' || typeof startedAt !== 'string') return null;
    return { pid, token, startedAt };
  } catch {
    return null;
  }
}

/**
 * Kilit sahipsiz mi? Yalnız üç durumda: sahibinin süreci ölmüş; bu sürecin
 * pid'iyle yazılmış ama işareti bu süreçte tutulmuyor (uzun yaşayan MCP'nin
 * bırakılamamış kalıntısı); ya da gövdesi okunamıyor ve yazım payından eski.
 * Yaşayan bir sahibin kilidi ne kadar eski olursa olsun devralınmaz: yavaş
 * disk ya da askıdan dönen süreç iki sahip doğururdu. Bekleyen taraf sınırda
 * `BundleLockTimeout` alır. Gövdeli kilitte saat farkına bakılmaz.
 */
function bayatMi(govde: KilitGovdesi | null, mtimeMs: number): boolean {
  if (govde === null) return Date.now() - mtimeMs >= PAKET_KILIDI.yazimPayiMs;
  if (govde.pid === process.pid) return !tutulanKilitler.has(govde.token);
  return !pidYasiyor(govde.pid);
}

function isaretiTasiyor(ham: string, token: string): boolean {
  return govdeyiAyristir(ham)?.token === token;
}

/**
 * Kilit adındaki girdi sıradan bir dosya mı? Değilse (symlink, dizin, başka
 * tür) reddedilir; içine yazılmaz, silinmez, taşınmaz.
 *
 * Kilit adının `realpath`'ine bilerek bakılmaz: rakipler bu sabit adı sürekli
 * taşır (bırakma, devralma) ve Windows'ta libuv'nin `realpath`'i taşınan bir
 * dosya için EBADF ya da başka/bozuk bir yol döndürebilir (CI 37138702502).
 * Gerek de yoktur: kök `guvenliKokuBul` ile doğrulanmıştır (symlink değil,
 * gerçek yolu `.kobay`'ın doğrudan altında) ve `lstat` symlink olmadığını
 * söyleyen bir girdi o kökün doğrudan çocuğudur. Var olan kilide hiç yazılmaz
 * (yalnız `O_EXCL` ile yaratılır), bu yüzden dışarıyı gösteren sert bağ da
 * dışarıya yazdıramaz; taşımak ya da silmek yalnız o adı etkiler.
 */
async function kilitYolunuDenetle(yol: string, reddet: YolReddi): Promise<'yok' | 'var'> {
  let durum;
  try {
    durum = await lstat(yol);
  } catch (hata: unknown) {
    if (hataKodu(hata) === 'ENOENT') return 'yok';
    throw hata;
  }
  if (durum.isSymbolicLink() || !durum.isFile()) {
    throw reddet(yol, 'the bundle lock is not a regular file, or is a symlink');
  }
  return 'var';
}

/**
 * `.kobay/<ad>/.lock-<testId>` kilidini alır ve bırakma işlevini döndürür.
 * `testId` çağıran tarafından doğrulanmış olmalıdır. Kök her denemede yeniden
 * doğrulanır; kilit adındaki symlink `O_EXCL`'de `EEXIST` verir ve
 * `kilitYolunuDenetle` onu reddeder — asla takip edilip yazılmaz.
 */
export async function paketKilidiniAl(secenek: {
  kobayKoku: string;
  ad: string;
  testId: string;
  reddet: YolReddi;
}): Promise<PaketKilidi> {
  const kok = join(secenek.kobayKoku, secenek.ad);
  const yol = join(kok, `.lock-${secenek.testId}`);
  const bitis = Date.now() + PAKET_KILIDI.beklemeMs;
  let bekleme = ILK_BEKLEME_MS;
  let sonHata: unknown;
  let sonSahip: KilitGovdesi | null = null;

  for (;;) {
    const gercekKok = await guvenliKokuBul(secenek.kobayKoku, secenek.ad, secenek.reddet);
    if (gercekKok === null) throw secenek.reddet(kok, `${secenek.ad} vanished while taking the bundle lock`);

    const token = randomUUID();
    const govde = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() });
    let tutamac;
    try {
      tutamac = await open(yol, 'wx', 0o600);
    } catch (hata: unknown) {
      if (hataKodu(hata) === 'EEXIST') {
        sonHata = undefined;
        const durum = await kilitYolunuDenetle(yol, secenek.reddet).catch((denetimHatasi: unknown) => {
          if (mesgulMu(denetimHatasi)) return 'mesgul' as const;
          throw denetimHatasi;
        });
        if (durum === 'var') {
          const sonuc = await kilidiIncele(yol, kok, secenek.testId);
          // Devralındı: hemen `O_EXCL`'e dönülür (son söz onun). Süre yine sınırlı.
          if (sonuc === 'devralindi' && Date.now() < bitis) continue;
          if (sonuc !== 'devralindi' && sonuc !== 'yok') sonSahip = sonuc;
        }
        // "Yok" da beklemeyle yeniden denenir: kilit hep görünüp kayboluyorsa döngü
        // boşa dönmesin, bekleme sınırı işlesin.
      } else if (mesgulMu(hata)) {
        sonHata = hata;
      } else {
        throw hata;
      }
      if (Date.now() >= bitis) throw new BundleLockTimeout(yol, sonSahip, sonHata);
      await bekle(bekleme + Math.floor(Math.random() * bekleme));
      bekleme = Math.min(bekleme * 2, AZAMI_BEKLEME_MS);
      continue;
    }

    // İşaret, gövde diske inmeden ÖNCE kaydedilir: aynı süreçteki bir rakip
    // gövdeyi okuyup bizim pid'imizi görürse, kayıtsız işaret onu "bırakılmamış
    // kalıntı" sanıp kilidi devralmaya iterdi. Yazma, kapatma ve doğrulama tek
    // blokta: hangisi düşerse düşsün dosya (hâlâ bizimse) kaldırılır ve işaret
    // kayıttan düşer; aksi hâlde aynı süreçte süresiz bir kilit kalırdı.
    tutulanKilitler.add(token);
    const acilisAni = Date.now();
    let yazildi = false;
    let teslimEdildi = false;
    try {
      const kimlik = await govdeyiYazVeKapat(tutamac, govde);
      yazildi = true;
      // Kök arada symlink'e çevrilmişse dosya dışarıda yaratılmış olabilir: kökün
      // gerçek yolu (rakiplerin taşımadığı kararlı bir yol) yeniden çözülür ve
      // ilkiyle aynı olmalı.
      const sonrakiKok = await guvenliKokuBul(secenek.kobayKoku, secenek.ad, secenek.reddet);
      if (sonrakiKok !== gercekKok) {
        throw taniEkle(
          secenek.reddet(kok, 'its real path changed while taking the bundle lock'),
          gercekKok,
          gercekKok,
          sonrakiKok ?? '(missing)',
        );
      }
      // Sabit addaki girdi, `O_EXCL` ile açtığımız dosyanın kendisi olmalı
      // (aynı aygıt ve dosya kimliği). Değilse kilit taşınmış ya da yerine başka
      // bir dosya gelmiş: alınmış sayılmaz.
      if (await kilitYolunuDenetle(yol, secenek.reddet) !== 'var') {
        throw new BundleLockLost(yol, 'it was moved away right after it was taken');
      }
      const simdiki = await lstat(yol, { bigint: true });
      if (simdiki.dev !== kimlik.dev || simdiki.ino !== kimlik.ino) {
        throw new BundleLockLost(yol, 'another file replaced it right after it was taken');
      }
      // Sabit addaki dosya bizim işaretimizi taşımalı. Gövde yazımı uzun takıldıysa
      // bir rakip boş kilidimizi devralıp kendi kilidini koymuş olabilir; o zaman
      // yazdığımız gövde taşınmış dosyaya gitmiştir. Kilit alınmış sayılmaz.
      await sahiplikDogrula(yol, token);
      teslimEdildi = true;
      return {
        yol,
        dogrula: () => sahiplikDogrula(yol, token),
        birak: () => kilidiBirak(yol, kok, secenek.testId, token, (ham) => isaretiTasiyor(ham, token)),
      };
    } catch (hata: unknown) {
      // Yalnız kesin bizim olan dosya kaldırılır: gövde tam yazıldıysa birebir
      // aynısı; yazım yarıda kaldıysa boş olmayan bir baş parçası; boşsa ancak
      // yazım payı dolmadan (rakipler boş kilidi o süre devralmaz).
      await kilidiBirak(yol, kok, secenek.testId, token, (ham) => {
        if (yazildi) return ham === govde;
        if (ham.length > 0) return govde.startsWith(ham);
        return Date.now() - acilisAni < PAKET_KILIDI.yazimPayiMs;
      });
      throw hata;
    } finally {
      if (!teslimEdildi) tutulanKilitler.delete(token);
    }
  }
}

/**
 * Gövdeyi yazar ve tutamacı kapatır. İkisi de düşerse ikisi birlikte görünür
 * (`AggregateError`, `code` yazma hatasının kodu); kapatma hatası yazma
 * hatasını gizlemez.
 */
async function govdeyiYazVeKapat(tutamac: FileHandle, govde: string): Promise<{ dev: bigint; ino: bigint }> {
  let yazmaHatasi: unknown;
  let kimlik: { dev: bigint; ino: bigint } | undefined;
  try {
    await tutamac.writeFile(govde);
    // Açtığımız dosyanın kimliği tutamaçtan okunur: ad taşınsa da bu bizimdir.
    const durum = await tutamac.stat({ bigint: true });
    kimlik = { dev: durum.dev, ino: durum.ino };
  } catch (hata: unknown) {
    yazmaHatasi = hata;
  }
  try {
    await tutamac.close();
  } catch (kapatmaHatasi: unknown) {
    if (yazmaHatasi === undefined) throw kapatmaHatasi;
    throw Object.assign(
      new AggregateError(
        [yazmaHatasi, kapatmaHatasi],
        `Writing the failure bundle lock failed (${String(hataKodu(yazmaHatasi) ?? yazmaHatasi)})`
        + ` and closing it also failed (${String(hataKodu(kapatmaHatasi) ?? kapatmaHatasi)})`,
      ),
      { code: hataKodu(yazmaHatasi) },
    );
  }
  if (yazmaHatasi !== undefined || kimlik === undefined) throw yazmaHatasi;
  return kimlik;
}

/**
 * Kilit hâlâ bizim mi? Geri dönüşü olmayan adımlardan (hedefe yayım, eski
 * klasörleri silme) hemen önce çağrılır. Okunamayan, başka işaretli ya da
 * kaybolmuş kilit `BundleLockLost` olur: fail-closed.
 */
async function sahiplikDogrula(yol: string, token: string): Promise<void> {
  let ham: string;
  try {
    if (!(await lstat(yol)).isFile()) throw new BundleLockLost(yol, 'the lock is no longer a regular file');
    ham = await readFile(yol, 'utf8');
  } catch (hata: unknown) {
    if (hata instanceof BundleLockLost) throw hata;
    throw Object.assign(new BundleLockLost(yol, `the lock could not be read: ${String(hataKodu(hata) ?? hata)}`), { cause: hata });
  }
  if (!isaretiTasiyor(ham, token)) throw new BundleLockLost(yol, 'it carries another owner\'s mark');
}

/**
 * Var olan kilide bakar: taze ise sahibini döndürür (beklenir), bayatsa
 * devralmayı dener. Devralma, kimlik işaretindeki gibi bayat dosyayı benzersiz
 * bir ada taşıyarak yapılır; taşınan dosya bayat sandığımızdan başkaysa (arada
 * başka bir süreç kendi kilidini koymuşsa) yerine konur — üstüne yazmayan
 * `link` ile — ve devralma sayılmaz.
 */
async function kilidiIncele(yol: string, kok: string, testId: string): Promise<KilitGovdesi | 'devralindi' | 'yok'> {
  let ham: string;
  let mtimeMs: number;
  try {
    ham = await readFile(yol, 'utf8');
    mtimeMs = (await lstat(yol)).mtimeMs;
  } catch (hata: unknown) {
    if (hataKodu(hata) === 'ENOENT') return 'yok';
    if (mesgulMu(hata)) return { pid: 0, token: '', startedAt: 'unknown' };
    throw hata;
  }
  const govde = govdeyiAyristir(ham);
  if (!bayatMi(govde, mtimeMs)) return govde ?? { pid: 0, token: '', startedAt: 'unknown' };

  const devir = join(kok, `.lock-${testId}-takeover-${randomUUID()}`);
  try {
    await rename(yol, devir);
  } catch (hata: unknown) {
    if (hataKodu(hata) === 'ENOENT' || mesgulMu(hata)) return 'yok';
    throw hata;
  }
  const alinan = await readFile(devir, 'utf8').catch(() => null);
  if (alinan === ham) {
    // Gövdesi okunamayan kilit, gövdesini hâlâ yazmakta olan yavaş ama canlı bir
    // yazıcınınki olabilir: taşınan dosya silinmez, devralma adında kalır (o
    // yazıcı ilk doğrulamasında kilidi alamadığını görür). Gövdeli bayat kilit
    // (ölü süreç, bu sürecin kalıntısı) güvenle silinir.
    if (govde !== null) await rm(devir, { force: true });
    return 'devralindi';
  }
  // Okuma ile taşıma arasında başka bir yazıcı bayatı devralıp kendi taze
  // kilidini koymuş; onu taşıdık. Asla silinmez. Üstüne yazmayan `link` ile
  // yerine konur; konamazsa (ad yeniden dolmuş ya da sert bağ desteklenmiyor)
  // olduğu yerde bırakılır ve açık hata verilir. Sahibi bir sonraki
  // `dogrula`da kilidi kaybettiğini görür.
  try {
    await link(devir, yol);
  } catch (linkHatasi: unknown) {
    throw new BundleLockConflict(yol, devir, linkHatasi);
  }
  // Aynı dosyanın ikinci adı; kalkmazsa kilit yine yerindedir, artık ad budanır.
  await unlink(devir).catch(() => undefined);
  return 'yok';
}

/**
 * Kilidi bırakır. Önce okunur; bizim değilse hiç dokunulmaz. Bizimse önce
 * kendine özgü bir ada taşınır, taşınan dosya yeniden okunur ve yalnız hâlâ
 * bizimse silinir. Okuma ile taşıma arasında başka birinin kilidi gelmişse
 * (yalnız çökme sonrası devralma yarışında olabilir) silinmez, üstüne yazmayan
 * `link` ile yerine konur; konamazsa olduğu yerde bırakılıp uyarılır. Bırakma
 * hatası yayım sonucunu bozmaz; işaret yine kayıttan düşer.
 */
async function kilidiBirak(
  yol: string,
  kok: string,
  testId: string,
  token: string,
  bizimMi: (ham: string) => boolean,
): Promise<void> {
  try {
    const ham = await readFile(yol, 'utf8').catch((hata: unknown) => {
      if (hataKodu(hata) === 'ENOENT') return null;
      throw hata;
    });
    if (ham === null || !bizimMi(ham)) return;
    const mezar = join(kok, `.lock-${testId}-release-${randomUUID()}`);
    try {
      await rename(yol, mezar);
    } catch (hata: unknown) {
      if (hataKodu(hata) === 'ENOENT') return;
      throw hata;
    }
    const tasinan = await readFile(mezar, 'utf8').catch(() => null);
    if (tasinan !== null && bizimMi(tasinan)) {
      await unlink(mezar);
      return;
    }
    try {
      await link(mezar, yol);
      await unlink(mezar).catch(() => undefined);
    } catch {
      process.stderr.write(`[kobay] Warning: another command's failure bundle lock was moved to ${mezar} while releasing ours and could not be put back.\n`);
    }
  } catch (hata: unknown) {
    process.stderr.write(`[kobay] Warning: could not release the failure bundle lock ${yol} (${String(hataKodu(hata) ?? hata)}).\n`);
  } finally {
    tutulanKilitler.delete(token);
  }
}
