import type { KobayDizini } from '../../depo/index.js';
// Doğrudan modülden (ortak.ts gibi): keşif modülünü taklit eden testlerde de oturum okuması gerçek kalır.
import { iceAlinanOturumuOku, SessionFileError } from '../../kesif/oturum-dosyasi.js';

/**
 * Elle plan (`test create`) ve plan yenileme (`test refresh`) için ortak karar: oturum kobay'ın
 * giriş adımıyla ya da içe alınan oturumla açılıyor mu? Kayıtlı kimlik (`credentials.json`) VEYA
 * içe alınmış işaretli `storageState.json` varsa evet. Kimliksiz keşfin yazdığı işaretsiz
 * storageState giriş sayılmaz (eski davranış sürer).
 *
 * İçe alınmış dosya artık geçersizse (elle bozulmuş, kökeni değişmiş) emniyetli taraf seçilir:
 * giriş yapılandırılmış sayılır. Bu yalnız gerçek-kimlik adımını reddeder; başka şeyi durdurmaz.
 */
export async function girisYapilandirildiMi(dizin: KobayDizini): Promise<boolean> {
  if ((await dizin.kimlikOku()) !== null) return true;
  const config = await dizin.configOku();
  try {
    return (await iceAlinanOturumuOku(dizin.storageStateYolu(), config.baseUrl, config.authOrigins ?? [])) !== null;
  } catch (hata: unknown) {
    if (hata instanceof SessionFileError) return true;
    throw hata;
  }
}
