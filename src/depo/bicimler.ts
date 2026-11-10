import * as v from 'valibot';
import { ESKI_YOLLAR, yolluEsle } from './anahtar-gocu.js';
import {
  HaritaSemasi,
  HataPaketiSemasi,
  KimlikSemasi,
  KobayConfigSemasi,
  KosuSonucuSemasi,
  OneriSemasi,
  TestKaydiSemasi,
} from './semalar.js';
import type { SurumGocu, SurumluBicim } from './surum.js';
import type { Harita, HataPaketi, Kimlik, KobayConfig, KosuSonucu, Oneri, TestKaydi } from './tipler.js';

/**
 * `.kobay/` içindeki sürümlü JSON dosyalarının biçimleri (0.9.0 spec, D1).
 *
 * Sürüm 0: `schemaVersion` alanı olmayan her dosya (0.1–0.8). Sürüm 1: 0.9.0.
 * 0→1 adımı bugüne kadarki ad göçlerini toplar: 0.1'in Türkçe alan adları
 * (yol-duyarlı `yolluEsle`: yalnız 0.1'in yazdığı yerlerde; bilinmeyen alt
 * nesnelere dokunulmaz) ve `plan/proposals.json`'ın dizi kökünün `{ items }`
 * nesnesine taşınması. 0.2–0.8 dosyalarında Türkçe ad yoktur; adım onlarda
 * yalnız sürümü damgalar.
 *
 * Şemalardaki `kalicidanEsle` okuma toleransı (0.2'den beri) bilerek yerinde
 * kalır: eşleme tekrar uygulanınca değişmez, ve kaldırmak bugün çalışan bir
 * okumayı (ör. elle `beyin` yazılmış güncel sürümlü config) kırardı. Diske
 * yazılan göç bu dosyadaki 0→1 adımıdır.
 *
 * Kapsam dışı (sürümlenmez): storageState.json ve pw-report.json (Playwright
 * biçimi), kilit/işaret dosyaları, steps/console/network.json (kanıt),
 * son-liste.json, report/.
 */

const ayni: SurumGocu = (veri) => veri;

/** `config.json` — 0.1'in `beyin` alanı `brain` olur. */
export const CONFIG_BICIMI: SurumluBicim<KobayConfig> = { sema: KobayConfigSemasi, gocler: [yolluEsle(ESKI_YOLLAR.config)] };

/** `credentials.json` (0600) — 0.1'in `kullanici`/`parola` alanları. */
export const KIMLIK_BICIMI: SurumluBicim<Kimlik> = { sema: KimlikSemasi, gocler: [yolluEsle(ESKI_YOLLAR.kimlik)] };

/** `map.json` — 0.1'in Türkçe harita alanları. */
export const HARITA_BICIMI: SurumluBicim<Harita> = { sema: HaritaSemasi, gocler: [yolluEsle(ESKI_YOLLAR.harita)] };

/** `plan/proposals.json` gövdesi: sürüm 1'de kök `{ schemaVersion, items }`. */
export interface OneriDosyasi {
  items: Oneri[];
}

/**
 * Sürüm 0'ın kökü öneri dizisidir. Dizi olmayan sürümsüz kök olduğu gibi
 * şemaya gider ve orada düşer (bozuk dosya). 0.1 de önerileri İngilizce
 * alan adlarıyla yazıyordu; ad eşlemesi gerekmez.
 */
const oneriDizisiniSar: SurumGocu = (veri) => (Array.isArray(veri) ? { items: veri } : veri);

export const ONERI_BICIMI: SurumluBicim<OneriDosyasi> = {
  sema: v.object({ items: v.array(OneriSemasi) }),
  gocler: [oneriDizisiniSar],
};

/** `tests/<id>.json` — 0.1'den beri alan adları İngilizce. */
export const TEST_BICIMI: SurumluBicim<TestKaydi> = { sema: TestKaydiSemasi, gocler: [ayni] };

/** `runs/<runId>/result.json`. */
export const KOSU_BICIMI: SurumluBicim<KosuSonucu> = { sema: KosuSonucuSemasi, gocler: [ayni] };

/** `failure/<id>/failure.json` — 0.1'in `haritaFarki` ve fark alanları. */
export const HATA_PAKETI_BICIMI: SurumluBicim<HataPaketi> = { sema: HataPaketiSemasi, gocler: [yolluEsle(ESKI_YOLLAR.hataPaketi)] };

/** `failure/<id>/meta.json` gövdesi. */
export interface PaketMeta {
  snapshotId: string;
  testId: string;
  runId: string;
  writtenAt: string;
}

/** `failure/<id>/meta.json` — 0.1'in `yazildi` alanı `writtenAt` olur. */
export const PAKET_META_BICIMI: SurumluBicim<PaketMeta> = {
  sema: v.object({ snapshotId: v.string(), testId: v.string(), runId: v.string(), writtenAt: v.string() }),
  gocler: [yolluEsle(ESKI_YOLLAR.meta)],
};

/** Bir biçimin şemasını değiştirip göçlerini koruyan kısa yol (yalnız bazı alanları okuyanlar için). */
export function bicimDaralt<T>(bicim: SurumluBicim<unknown>, sema: v.GenericSchema<unknown, T>): SurumluBicim<T> {
  return { sema, gocler: bicim.gocler };
}
