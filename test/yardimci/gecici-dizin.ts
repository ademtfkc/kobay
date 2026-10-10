import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const acilanlar: string[] = [];

const BEKLE = (ms: number): Promise<void> => new Promise((coz) => { setTimeout(coz, ms); });

interface SilmeAraclari {
  rm: typeof rm;
  platform: NodeJS.Platform;
  bekle: (ms: number) => Promise<void>;
}

/**
 * Geçici dizini siler; Windows'taki EBUSY/EPERM için birkaç kez dener. Beş deneme de
 * düşerse win32 dışında son hatayı fırlatır (temizlik regresyonu görünsün); win32'de
 * yolu uyarı olarak yazar, kararsız dosya kilidi CI'ı kırmasın.
 */
export async function sil(
  yol: string,
  araclar: SilmeAraclari = { rm, platform: process.platform, bekle: BEKLE },
): Promise<void> {
  let sonHata: unknown;
  for (let deneme = 0; deneme < 5; deneme += 1) {
    try {
      await araclar.rm(yol, { recursive: true, force: true });
      return;
    } catch (hata) {
      sonHata = hata;
      if (deneme < 4) await araclar.bekle(100 * (deneme + 1));
    }
  }
  if (araclar.platform !== 'win32') throw sonHata;
  console.warn(`[test] Geçici dizin silinemedi: ${yol}`, sonHata);
}

/**
 * `mkdtemp(join(tmpdir(), onek))` yerine kullanılır: dizin test dosyası bitince silinir.
 * Modül test dosyasının içinde içe aktarıldığı için `afterAll` o dosyanın sonunda çalışır.
 */
export async function geciciDizinAc(onek: string): Promise<string> {
  const yol = await mkdtemp(join(tmpdir(), onek));
  acilanlar.push(yol);
  return yol;
}

afterAll(async () => {
  if (process.env['KOBAY_TEST_TEMIZLIK_KAPALI'] === '1') return; // yalnız kırma denemesi için
  const kuyruk = acilanlar.splice(0);
  await Promise.all(kuyruk.map(async (yol) => sil(yol)));
});
