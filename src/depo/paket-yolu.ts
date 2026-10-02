import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

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
 * `failure-out` için kullanılan disiplinin aynısı: yolun üç bileşeni (`.kobay`,
 * `failure`, `<testId>`) tek tek `lstat` ile denetlenir; biri symlink ise ya da
 * gerçek yolu `.kobay` altına düşmüyorsa reddedilir. Henüz var olmayan
 * bileşenler sorun değildir (yazıcı onları kendisi açar). Proje kökünün
 * üstündeki symlink'ler (macOS'ta `/var` → `/private/var`) karşılaştırmayı
 * bozmaz; kıyas `.kobay`'ın gerçek yoluna göre yapılır.
 */
export async function hataPaketiYolunuDenetle(dizin: PaketDizini, testId: string): Promise<void> {
  const kobayDurumu = await lstat(dizin.kok);
  if (kobayDurumu.isSymbolicLink() || !kobayDurumu.isDirectory()) {
    throw new UnsafeBundlePath(dizin.kok, '.kobay is not a directory, or is a symlink');
  }
  const gercekKobay = await realpath(dizin.kok);

  const hataKoku = dizin.yol('failure');
  const kokDurumu = await varsaLstat(hataKoku);
  if (kokDurumu === null) return;
  if (kokDurumu.isSymbolicLink() || !kokDurumu.isDirectory()) {
    throw new UnsafeBundlePath(hataKoku, 'failure is not a directory, or is a symlink');
  }
  const gercekKok = await realpath(hataKoku);
  if (gercekKok !== join(gercekKobay, 'failure')) {
    throw new UnsafeBundlePath(hataKoku, 'its real path is not under .kobay');
  }

  const hedef = join(hataKoku, testId);
  // Aynı testId için eşzamanlı başka bir yazıcı, `lstat` ile `realpath`
  // arasında paketi `.stale-*` adına taşıyabilir; o an hedef yoktur ve
  // `realpath` ENOENT verir. Yok olan hedef symlink değildir: yol baştan
  // (`lstat` ile) yeniden bakılır. Yerine symlink gelmişse yine reddedilir.
  for (let deneme = 0; deneme < 3; deneme += 1) {
    const hedefDurumu = await varsaLstat(hedef);
    if (hedefDurumu === null) return;
    if (hedefDurumu.isSymbolicLink()) {
      throw new UnsafeBundlePath(hedef, 'the bundle directory is a symlink');
    }
    let gercekHedef: string;
    try {
      gercekHedef = await realpath(hedef);
    } catch (hata: unknown) {
      if (hataKodu(hata) === 'ENOENT') continue;
      throw hata;
    }
    if (gercekHedef !== join(gercekKok, testId)) {
      throw new UnsafeBundlePath(hedef, 'its real path is not under .kobay/failure');
    }
    return;
  }
  throw new UnsafeBundlePath(hedef, 'it kept changing while being checked');
}
