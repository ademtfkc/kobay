import { lstat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * `.kobay/failure/<testId>` yolu depo dışını gösteriyor. Paket yazıcı eski
 * paketi kenara alıp `rm -r` ile sildiği için, kötü niyetli bir klon `.kobay`
 * ya da `failure` yerine dışarıyı gösteren bir bağ koyup kök dışındaki bir
 * klasörü sildiremesin: böyle bir yolda hiç yazılmaz.
 */
export class UnsafeBundlePath extends Error {
  constructor(yol: string, sebep: string) {
    super(
      `Unsafe failure bundle path: ${yol} (${sebep}).`
      + ' Remove the link under `.kobay/failure` and run the analysis again.',
    );
    this.name = 'UnsafeBundlePath';
  }
}

/**
 * Denetimin ihtiyaç duyduğu en küçük dizin yüzü. `KobayDizini` doğrudan
 * içe aktarılmıyor: `dizin.ts` bu modülü kullandığı için döngü oluşmasın.
 */
export interface PaketDizini {
  readonly kok: string;
  yol(...parcalar: string[]): string;
}

function hataKodu(hata: unknown): unknown {
  return typeof hata === 'object' && hata !== null && 'code' in hata ? hata.code : undefined;
}

async function varsaLstat(yol: string) {
  return lstat(yol).catch((hata: unknown) => {
    if (hataKodu(hata) === 'ENOENT') return null;
    throw hata;
  });
}

/**
 * Bir yolu reddederken atılacak hata; `failure` için `UnsafeBundlePath`,
 * `failure-out` için `UnsafeOutputPath` verilir.
 */
export type YolReddi = (yol: string, sebep: string) => Error;

/**
 * `realpath`'in "hedef az önce yer değiştirdi" anlamına gelen hata kodları;
 * yalnız `kokCocugunuDenetle` içinde, yalnız `realpath` için yeniden bakış başlatır.
 * - ENOENT: `lstat` ile `realpath` arasında hedef kenara alındı.
 * - EBADF: Windows'ta libuv `realpath`'i bir tutamak açıp
 *   `GetFinalPathNameByHandleW`'yi iki kez çağırarak yapar; iki çağrı arasında
 *   klasör daha uzun `.stale-*` adına taşınır ya da silinirse libuv kendisi
 *   ERROR_INVALID_HANDLE koyar, bu da EBADF olur. Yola verilen `realpath`
 *   kullanıcının bir tutamağını kullanmaz; EBADF başka bir şey anlatmaz.
 * EPERM/EACCES/EBUSY gibi kodlar bilerek yok: kalıcı bir izin ya da kilit
 * sorunu yeniden bakışla gizlenmesin, özgün hatayla düşsün.
 */
const HAREKETLI_HEDEF_KODLARI: ReadonlySet<string> = new Set(['ENOENT', 'EBADF']);

/** Hedef sürekli yer değiştirirken kaç kez baştan bakılacağı; dolunca kabul değil hata. */
const YENIDEN_BAKIS = 10;

/**
 * `.kobay/<ad>` kökünü denetler ve gerçek yolunu döndürür: `.kobay` ve kök
 * symlink olmayan birer dizin olmalı, kökün gerçek yolu `.kobay`'ın gerçek
 * yolunun doğrudan altına düşmeli. Kök yoksa `null` döner.
 */
export async function guvenliKokuBul(kobayKoku: string, ad: string, reddet: YolReddi): Promise<string | null> {
  const kobayDurumu = await lstat(kobayKoku);
  if (kobayDurumu.isSymbolicLink() || !kobayDurumu.isDirectory()) {
    throw reddet(kobayKoku, '.kobay is not a directory, or is a symlink');
  }
  const gercekKobay = await realpath(kobayKoku);
  const kok = join(kobayKoku, ad);
  const kokDurumu = await varsaLstat(kok);
  if (kokDurumu === null) return null;
  if (kokDurumu.isSymbolicLink() || !kokDurumu.isDirectory()) {
    throw reddet(kok, `${ad} is not a directory, or is a symlink`);
  }
  const gercekKok = await realpath(kok);
  if (gercekKok !== join(gercekKobay, ad)) {
    throw taniEkle(reddet(kok, 'its real path is not under .kobay'), gercekKobay, join(gercekKobay, ad), gercekKok);
  }
  return gercekKok;
}

/**
 * Kök dışı ret için tanı: davranışı değiştirmez, yalnız hata nesnesine eklenir
 * (`details`). Yollar sır taşımaz; JSON biçiminde basıldığında NUL ya da
 * kırpılmış karakterler, kısa/uzun ad (`RUNNER~1`) ve büyük-küçük harf farkı
 * görünür. Windows'ta libuv'nin `realpath` sonucu bozuk dönerse ayırt edilsin.
 */
export function realpathTanisi(gercekKok: string, beklenen: string, gercekHedef: string): Record<string, unknown> {
  return {
    gercekKok,
    beklenen,
    gercekHedef,
    gercekHedefUstu: dirname(gercekHedef),
    uzunluklar: { gercekKok: gercekKok.length, beklenen: beklenen.length, gercekHedef: gercekHedef.length },
    platform: process.platform,
    node: process.versions.node,
    uv: process.versions.uv,
  };
}

/**
 * Kök dışı reddine tanı ekler: `details` nesnesi ve mesajın sonuna kısa bir
 * özet (JSON dizgisi olarak: NUL, kırpılma, `RUNNER~1` gibi kısa ad ve harf
 * farkı görünsün). Ret kararını değiştirmez; CI günlüğünde mesaj her zaman
 * basıldığı için neden oradan okunabilir.
 */
export function taniEkle(hata: Error, gercekKok: string, beklenen: string, gercek: string): Error {
  const ozet = ` [real root ${JSON.stringify(gercekKok)}, expected ${JSON.stringify(beklenen)},`
    + ` resolved ${JSON.stringify(gercek)} (${beklenen.length}/${gercek.length} chars)]`;
  const ilkSatir = `${hata.name}: ${hata.message}`;
  hata.message += ozet;
  if (typeof hata.stack === 'string' && hata.stack.startsWith(ilkSatir)) {
    hata.stack = `${ilkSatir}${ozet}${hata.stack.slice(ilkSatir.length)}`;
  }
  return Object.assign(hata, { details: realpathTanisi(gercekKok, beklenen, gercek) });
}

/**
 * Kökün altındaki sabit `<ad>` yolunu denetler: yoksa sorun değil; symlink ise
 * ya da gerçek yolu `gercekKok`'un doğrudan `<ad>` çocuğu değilse reddedilir.
 *
 * Aynı ad için eşzamanlı başka bir yazıcı, `lstat` ile `realpath` arasında
 * klasörü `.stale-*` adına taşıyabilir. O zaman `realpath` ya ENOENT verir, ya
 * (açık tutamaktan yol okuyan sistemlerde) taşınan klasörün yeni, kardeş adını
 * döndürür, ya da Windows'ta EBADF verir (bkz. `HAREKETLI_HEDEF_KODLARI`).
 * Hiçbiri başarı sayılmaz: yalnız yol baştan `lstat` ile yeniden denetlenir,
 * symlink denetimi her turda tekrarlanır. Kökün doğrudan çocuğu olmayan her
 * sonuç derhal reddedilir. Deneme sınırı dolarsa hata verilir: son tur bir
 * `realpath` hatasıyla bittiyse o özgün hata (kodu korunarak) fırlatılır.
 */
export async function kokCocugunuDenetle(secenek: {
  kok: string;
  gercekKok: string;
  ad: string;
  reddet: YolReddi;
  symlinkSebebi: string;
  disaridaSebebi: string;
}): Promise<void> {
  const hedef = join(secenek.kok, secenek.ad);
  const beklenen = join(secenek.gercekKok, secenek.ad);
  let sonHata: unknown;
  for (let deneme = 0; deneme < YENIDEN_BAKIS; deneme += 1) {
    const hedefDurumu = await varsaLstat(hedef);
    if (hedefDurumu === null) return;
    if (hedefDurumu.isSymbolicLink()) throw secenek.reddet(hedef, secenek.symlinkSebebi);
    let gercekHedef: string;
    try {
      gercekHedef = await realpath(hedef);
    } catch (hata: unknown) {
      const kod = hataKodu(hata);
      if (typeof kod === 'string' && HAREKETLI_HEDEF_KODLARI.has(kod)) {
        sonHata = hata;
        continue;
      }
      throw hata;
    }
    sonHata = undefined;
    if (gercekHedef === beklenen) return;
    if (dirname(gercekHedef) === secenek.gercekKok) continue;
    throw taniEkle(secenek.reddet(hedef, secenek.disaridaSebebi), secenek.gercekKok, beklenen, gercekHedef);
  }
  if (sonHata !== undefined) throw sonHata;
  throw secenek.reddet(hedef, 'it kept changing while being checked');
}

/**
 * Yayımlarken kenara alınan eski klasörleri siler. Sabit hedef yolu yerine
 * silinecek yolların kendisi doğrulanır: önce `.kobay/<ad>` kökü, sonra her
 * yol için symlink olmayan bir dizin olduğu ve gerçek yolunun kökün doğrudan
 * çocuğu olduğu. Biri bile tutmazsa hiçbiri silinmez. Bu adlar yazıcıya özgü
 * (rastgele) olduğundan başka yazıcı onları taşımaz; yok olmuşsa (budama
 * silmiş ya da geri konmuşsa) atlanır.
 */
export async function eskiDizinleriSil(secenek: {
  kobayKoku: string;
  ad: string;
  yollar: readonly string[];
  reddet: YolReddi;
}): Promise<void> {
  if (secenek.yollar.length === 0) return;
  const kok = join(secenek.kobayKoku, secenek.ad);
  const gercekKok = await guvenliKokuBul(secenek.kobayKoku, secenek.ad, secenek.reddet);
  if (gercekKok === null) return;
  const silinecekler: string[] = [];
  for (const yol of secenek.yollar) {
    if (dirname(yol) !== kok) throw secenek.reddet(yol, `it is not directly under .kobay/${secenek.ad}`);
    const durum = await varsaLstat(yol);
    if (durum === null) continue;
    if (durum.isSymbolicLink() || !durum.isDirectory()) {
      throw secenek.reddet(yol, 'the set-aside folder is not a directory, or is a symlink');
    }
    let gercek: string;
    try {
      gercek = await realpath(yol);
    } catch (hata: unknown) {
      if (hataKodu(hata) === 'ENOENT') continue;
      throw hata;
    }
    if (gercek !== join(gercekKok, basename(yol))) {
      throw taniEkle(
        secenek.reddet(yol, `its real path is not under .kobay/${secenek.ad}`),
        gercekKok,
        join(gercekKok, basename(yol)),
        gercek,
      );
    }
    silinecekler.push(yol);
  }
  await Promise.all(silinecekler.map((yol) => rm(yol, { recursive: true, force: true })));
}

/**
 * `failure-out` için kullanılan disiplinin aynısı: yolun üç bileşeni (`.kobay`,
 * `failure`, `<testId>`) tek tek `lstat` ile denetlenir; biri symlink ise ya da
 * gerçek yolu `.kobay` altına düşmüyorsa reddedilir. Henüz var olmayan
 * bileşenler sorun değildir (yazıcı onları kendisi açar). Proje kökünün
 * üstündeki symlink'ler (macOS'ta `/var` → `/private/var`) karşılaştırmayı
 * bozmaz; kıyas `.kobay`'ın gerçek yoluna göre yapılır.
 */
export async function hataPaketiYolunuDenetle(dizin: PaketDizini, testId: string): Promise<void> {
  const reddet: YolReddi = (yol, sebep) => new UnsafeBundlePath(yol, sebep);
  const gercekKok = await guvenliKokuBul(dizin.kok, 'failure', reddet);
  if (gercekKok === null) return;
  await kokCocugunuDenetle({
    kok: dizin.yol('failure'),
    gercekKok,
    ad: testId,
    reddet,
    symlinkSebebi: 'the bundle directory is a symlink',
    disaridaSebebi: 'its real path is not under .kobay/failure',
  });
}
