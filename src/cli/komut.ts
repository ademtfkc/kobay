import { McpRegistryUnreadable } from '../beceri/index.js';
import { BrainError } from '../beyin/index.js';
import {
  FileNotFound,
  InvalidId,
  UnsafeOutputPath,
  CredentialsRollbackFailed,
  CredentialsTxnInProgress,
  BundleIncomplete,
  SchemaError,
} from '../depo/index.js';
import { CIKIS, type CikisKodu } from './cikis.js';

export interface KomutSonucu {
  exitCode: number;
  json: unknown;
  mesaj?: string;
  /** İnsan modunda stdout'a yazılan tek çıktı; verilmişse json dökümü basılmaz. */
  metin?: string;
}

export class UsageError extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'UsageError';
  }
}

export class PermissionError extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'PermissionError';
  }
}

/** Hedef uygulama ayakta değil; exit 3 (HEDEF_YOK) ile ayrı sınıflanır. */
export class TargetUnreachableError extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'TargetUnreachableError';
  }
}

export function basarili(json: unknown, mesaj?: string): KomutSonucu {
  return { exitCode: CIKIS.GECTI, json, ...(mesaj === undefined ? {} : { mesaj }) };
}

/** İnsan modunda yalnız verilen metni basar; JSON modunda yalnız json çıkar. */
export function basariliMetin(json: unknown, metin: string): KomutSonucu {
  return { exitCode: CIKIS.GECTI, json, metin };
}

/** Beyin hata kodlarını (`cli_yok`, `sema`…) eyleme yönlendiren İngilizce mesaja çevirir. */
function beyinMesaji(hata: BrainError): string {
  switch (hata.sebep) {
    case 'cli_missing':
      return 'Brain CLI not found on PATH; check it with `kobay doctor`,'
        + ' or pick another brain with `kobay setup --brain codex`';
    case 'timeout':
      return 'The brain did not answer in time; run the command again or'
        + ' pick a faster model with `kobay project update --model <model>`';
    case 'schema':
      return 'The brain did not return the expected JSON schema; check the latest brain log under'
        + ' `.kobay/logs/` and run the command again';
    case 'empty_response':
      return 'The brain returned an empty answer; check the latest brain log under'
        + ' `.kobay/logs/` and run the command again';
    case 'network':
      return 'The brain could not be reached (network error); check the connection and run the command again';
    case 'key_missing':
      return 'OPENROUTER_API_KEY is not set; set the key in the environment or'
        + ' switch the brain with `kobay setup --brain claude`';
  }
}

export function hataBilgisi(hata: unknown): { code: string; message: string } {
  if (hata instanceof BrainError) return { code: hata.name, message: beyinMesaji(hata) };
  if (hata instanceof Error) return { code: hata.name, message: hata.message };
  return { code: 'UnknownError', message: 'Unknown error' };
}

export function hataCikisKodu(hata: unknown, varsayilan: CikisKodu = CIKIS.MOTOR): CikisKodu {
  if (
    hata instanceof UsageError || hata instanceof InvalidId || hata instanceof FileNotFound
    || hata instanceof SchemaError
    // Kullanıcının düzeltmesi gereken bir yol sorunu: motor arızası değil.
    || hata instanceof UnsafeOutputPath
    // Kullanıcının elindeki `.mcp.json` bozuk; kobay'ın arızası değil.
    || hata instanceof McpRegistryUnreadable
    // Aynı projede ikinci bir değiştirme komutu: kobay arızası değil, çağrı
    // sırası sorunu. Kullanıcı öteki komutun bitmesini bekleyip yeniden dener.
    || hata instanceof CredentialsTxnInProgress
  ) {
    return CIKIS.KULLANIM;
  }
  if (hata instanceof TargetUnreachableError) return CIKIS.HEDEF_YOK;
  if (hata instanceof PermissionError) return CIKIS.YETKI;
  // Geri alma tamamlanamadı: kullanıcının komutunda değil, dosya sisteminde
  // sorun var. Varsayılana bırakılamaz; `test run` gibi komutlar varsayılanı
  // DUSTU (1) veriyor ve tutarsız proje "test düştü" diye görünürdü.
  if (hata instanceof BrainError || hata instanceof BundleIncomplete || hata instanceof CredentialsRollbackFailed) {
    return CIKIS.MOTOR;
  }
  return varsayilan;
}

export function basarisiz(hata: unknown, varsayilan?: CikisKodu): KomutSonucu {
  const bilgi = hataBilgisi(hata);
  return { exitCode: hataCikisKodu(hata, varsayilan), json: { error: bilgi }, mesaj: bilgi.message };
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
