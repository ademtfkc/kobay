import { McpKaydiOkunamadi } from '../beceri/index.js';
import { BeyinHatasi } from '../beyin/index.js';
import {
  DosyaYok,
  GecersizKimlik,
  GuvensizCikisYolu,
  KimlikGeriAlinamadi,
  KimlikIslemiYurumede,
  PaketYarim,
  SemaHatasi,
} from '../depo/index.js';
import { CIKIS, type CikisKodu } from './cikis.js';

export interface KomutSonucu {
  exitCode: number;
  json: unknown;
  mesaj?: string;
  /** İnsan modunda stdout'a yazılan tek çıktı; verilmişse json dökümü basılmaz. */
  metin?: string;
}

export class KullanimHatasi extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'KullanimHatasi';
  }
}

export class YetkiHatasi extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'YetkiHatasi';
  }
}

/** Hedef uygulama ayakta değil; exit 3 (HEDEF_YOK) ile ayrı sınıflanır. */
export class HedefYokHatasi extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'HedefYokHatasi';
  }
}

export function basarili(json: unknown, mesaj?: string): KomutSonucu {
  return { exitCode: CIKIS.GECTI, json, ...(mesaj === undefined ? {} : { mesaj }) };
}

/** İnsan modunda yalnız verilen metni basar; JSON modunda yalnız json çıkar. */
export function basariliMetin(json: unknown, metin: string): KomutSonucu {
  return { exitCode: CIKIS.GECTI, json, metin };
}

/** Beyin hata kodlarını (`cli_yok`, `sema`…) eyleme yönlendiren Türkçe mesaja çevirir. */
function beyinMesaji(hata: BeyinHatasi): string {
  switch (hata.sebep) {
    case 'cli_yok':
      return 'Beyin CLI’si PATH içinde bulunamadı; `kobay doctor` ile denetleyin,'
        + ' `kobay setup --beyin codex` ile başka bir beyin seçin';
    case 'zaman_asimi':
      return 'Beyin zamanında yanıt vermedi; komutu yeniden çalıştırın veya'
        + ' `kobay project update --model <model>` ile daha hızlı bir model seçin';
    case 'sema':
      return 'Beyin beklenen JSON şemasını döndürmedi; `.kobay/logs/` altındaki son beyin günlüğüne bakıp'
        + ' komutu yeniden çalıştırın';
    case 'bos_yanit':
      return 'Beyin boş yanıt döndürdü; `.kobay/logs/` altındaki son beyin günlüğüne bakıp'
        + ' komutu yeniden çalıştırın';
    case 'ag':
      return 'Beyne ulaşılamadı (ağ hatası); bağlantıyı denetleyip komutu yeniden çalıştırın';
    case 'anahtar_yok':
      return 'OPENROUTER_API_KEY tanımlı değil; anahtarı ortamda tanımlayın veya'
        + ' `kobay setup --beyin claude` ile beyni değiştirin';
  }
}

export function hataBilgisi(hata: unknown): { kod: string; mesaj: string } {
  if (hata instanceof BeyinHatasi) return { kod: hata.name, mesaj: beyinMesaji(hata) };
  if (hata instanceof Error) return { kod: hata.name, mesaj: hata.message };
  return { kod: 'BilinmeyenHata', mesaj: 'Bilinmeyen hata' };
}

export function hataCikisKodu(hata: unknown, varsayilan: CikisKodu = CIKIS.MOTOR): CikisKodu {
  if (
    hata instanceof KullanimHatasi || hata instanceof GecersizKimlik || hata instanceof DosyaYok
    || hata instanceof SemaHatasi
    // Kullanıcının düzeltmesi gereken bir yol sorunu: motor arızası değil.
    || hata instanceof GuvensizCikisYolu
    // Kullanıcının elindeki `.mcp.json` bozuk; kobay'ın arızası değil.
    || hata instanceof McpKaydiOkunamadi
    // Aynı projede ikinci bir değiştirme komutu: kobay arızası değil, çağrı
    // sırası sorunu. Kullanıcı öteki komutun bitmesini bekleyip yeniden dener.
    || hata instanceof KimlikIslemiYurumede
  ) {
    return CIKIS.KULLANIM;
  }
  if (hata instanceof HedefYokHatasi) return CIKIS.HEDEF_YOK;
  if (hata instanceof YetkiHatasi) return CIKIS.YETKI;
  // Geri alma tamamlanamadı: kullanıcının komutunda değil, dosya sisteminde
  // sorun var. Varsayılana bırakılamaz; `test run` gibi komutlar varsayılanı
  // DUSTU (1) veriyor ve tutarsız proje "test düştü" diye görünürdü.
  if (hata instanceof BeyinHatasi || hata instanceof PaketYarim || hata instanceof KimlikGeriAlinamadi) {
    return CIKIS.MOTOR;
  }
  return varsayilan;
}

export function basarisiz(hata: unknown, varsayilan?: CikisKodu): KomutSonucu {
  const bilgi = hataBilgisi(hata);
  return { exitCode: hataCikisKodu(hata, varsayilan), json: { hata: bilgi }, mesaj: bilgi.mesaj };
}

export async function komutCalistir(
  islem: () => Promise<KomutSonucu>,
  varsayilan?: CikisKodu,
): Promise<KomutSonucu> {
  try {
    return await islem();
  } catch (hata: unknown) {
    return basarisiz(hata, varsayilan);
  }
}
