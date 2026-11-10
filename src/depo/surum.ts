import { readFile } from 'node:fs/promises';
import * as v from 'valibot';
import { FileNotFound, SchemaError } from './dosya.js';

/**
 * `.kobay/` JSON dosyalarının sürümlü biçimi (0.9.0 spec, Katman B).
 *
 * Her sürümlenen dosya kökünde `schemaVersion` taşır. Alanı olmayan dosya
 * (0.1–0.8'in yazdığı her dosya) sürüm 0 sayılır. Okuma tek yoldan geçer:
 * sürüm okunur, eksik göç adımları sırayla BELLEKTE uygulanır, sonra şema
 * doğrular. Yazım her zaman güncel sürümü damgalar.
 *
 * Sürüm dosyanın zarfıdır, gövdesi değil: okuyucu sürümü ham veriden alır,
 * yazıcı (`surumluMetin`) damgalar. Şemalar gövdeyi doğrular ve `v.object`
 * olduğu için `schemaVersion`'ı çıktıya taşımaz; damga böylece hiçbir okuma →
 * değiştirme → yazma zincirinde unutulamaz.
 */

/** Dosya kökündeki sürüm alanının adı. */
export const SURUM_ALANI = 'schemaVersion';

/** Bir sürümden bir sonrakine geçiren saf dönüşüm; girdiyi değiştirmez. */
export type SurumGocu = (veri: unknown) => unknown;

/**
 * Sürümlenen bir dosyanın biçimi. Güncel sürüm `gocler.length`'tir:
 * `gocler[i]` sürüm i'den i+1'e geçirir. Yeni bir biçim değişikliği diziye
 * yeni bir adım ekler; eski adımlar asla değişmez.
 */
export interface SurumluBicim<T> {
  readonly sema: v.GenericSchema<unknown, T>;
  readonly gocler: readonly SurumGocu[];
}

/**
 * Not: depo modülü üretilen Playwright fixture'ından da yüklenir (CommonJS
 * yükleyici); bu yüzden burada `import.meta` kullanılmaz, kobay sürümü mesaja
 * yazılmaz.
 *
 * Dosya bu kobay'ın tanıdığından daha yeni bir sürümle yazılmış. Okunmaz,
 * göç edilmez, üstüne yazılmaz (0.9.0 Karar 4): eski kobay yeni alanları
 * bilmeden okursa sessizce atar, yazarsa yeni sürümün verisini siler.
 *
 * `SchemaError`'dan türer ki CLI ve MCP onu kullanım hatası (çıkış 2) sayıp
 * `error.code` olarak bu sınıfın adını döndürsün; ayrı bir eşleme gerekmez.
 */
export class SchemaVersionTooNew extends SchemaError {
  readonly dosya: string;
  readonly surum: number;
  readonly desteklenen: number;

  constructor(dosya: string, surum: number, desteklenen: number) {
    super([`${dosya}: schemaVersion ${surum} is newer than this kobay supports (${desteklenen})`]);
    this.name = 'SchemaVersionTooNew';
    this.message = `${dosya} was written by a newer kobay (schemaVersion ${surum});`
      + ` this kobay reads schemaVersion ${desteklenen} at most.`
      + ' Upgrade kobay (npm install -g @ademtfkc/kobay@latest) and run the command again; the file was not changed.';
    this.dosya = dosya;
    this.surum = surum;
    this.desteklenen = desteklenen;
  }
}

function duzNesneMi(deger: unknown): deger is Record<string, unknown> {
  return typeof deger === 'object' && deger !== null && !Array.isArray(deger);
}

/** Nesnenin sürüm alanı atılmış sığ kopyası; gövde böylece sürüm alanının yerini belirlemez. */
function surumAlaniniAt(nesne: object): Record<string, unknown> {
  const kopya: Record<string, unknown> = { ...nesne };
  delete kopya[SURUM_ALANI];
  return kopya;
}

/** Bicimin güncel (yazılan) sürümü. */
export function guncelSurum(bicim: SurumluBicim<unknown>): number {
  return bicim.gocler.length;
}

/**
 * Ham verinin sürümü: alan yoksa (ya da kök nesne değilse, ör. eski dizi
 * kökü) 0. Alan varsa negatif olmayan bir tamsayı olmalı; değilse dosya
 * bozuk sayılır (`SchemaError`).
 */
export function dosyaSurumu(veri: unknown, dosya: string): number {
  if (!duzNesneMi(veri) || !Object.hasOwn(veri, SURUM_ALANI)) return 0;
  const surum = veri[SURUM_ALANI];
  if (typeof surum !== 'number' || !Number.isSafeInteger(surum) || surum < 0) {
    throw new SchemaError([`${dosya}: ${SURUM_ALANI} must be a non-negative integer`]);
  }
  return surum;
}

/** Daha yeni sürümse `SchemaVersionTooNew` fırlatır; değilse sürümü döner. */
export function surumuDenetle(veri: unknown, bicim: SurumluBicim<unknown>, dosya: string): number {
  const surum = dosyaSurumu(veri, dosya);
  const guncel = guncelSurum(bicim);
  if (surum > guncel) throw new SchemaVersionTooNew(dosya, surum, guncel);
  return surum;
}

/**
 * Ham veriyi güncel sürüme göç ettirir (yalnız bellekte) ve sürüm alanını
 * güncel değerle bırakır. Şema doğrulaması yapılmaz; `surumluCoz` yapar.
 */
export function guncelSurumeGocur(veri: unknown, bicim: SurumluBicim<unknown>, dosya: string): {
  veri: unknown;
  surum: number;
} {
  const surum = surumuDenetle(veri, bicim, dosya);
  let sonuc = veri;
  for (let sira = surum; sira < bicim.gocler.length; sira += 1) {
    sonuc = (bicim.gocler[sira] as SurumGocu)(sonuc);
  }
  if (duzNesneMi(sonuc)) sonuc = { [SURUM_ALANI]: guncelSurum(bicim), ...surumAlaniniAt(sonuc) };
  return { veri: sonuc, surum };
}

function sorunlariMetneCevir(issues: readonly v.BaseIssue<unknown>[]): string[] {
  return issues.map((issue) => {
    const yol = issue.path?.map((parca) => String(parca.key)).join('.') ?? '$';
    return `${yol}: ${issue.message}`;
  });
}

/**
 * Tek okuyucunun saf çekirdeği: sürüm, göç, şema. `dosya` yalnız hata
 * mesajında görünür (ör. `.kobay/config.json`); mutlak yol verilmemeli.
 */
export function surumluCoz<T>(veri: unknown, bicim: SurumluBicim<T>, dosya: string): T {
  const { veri: guncel } = guncelSurumeGocur(veri, bicim, dosya);
  const sonuc = v.safeParse(bicim.sema, guncel);
  if (!sonuc.success) throw new SchemaError(sorunlariMetneCevir(sonuc.issues));
  return sonuc.output;
}

/** Diskteki sürümlü dosyayı okur; yoksa `FileNotFound`, bozuksa `SchemaError`. */
export async function surumluOku<T>(yol: string, bicim: SurumluBicim<T>, dosya: string): Promise<T> {
  let metin: string;
  try {
    metin = await readFile(yol, 'utf8');
  } catch (hata: unknown) {
    if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') {
      throw new FileNotFound(yol);
    }
    throw hata;
  }
  let veri: unknown;
  try {
    veri = JSON.parse(metin) as unknown;
  } catch {
    throw new SchemaError(['$: not valid JSON']);
  }
  return surumluCoz(veri, bicim, dosya);
}

/**
 * Yazılacak metin: kökte önce güncel `schemaVersion`, sonra gövde. Gövdede
 * eski bir sürüm alanı varsa atılır; yazım hep güncel sürümle yapılır.
 */
export function surumluMetin(bicim: SurumluBicim<unknown>, govde: object): string {
  return `${JSON.stringify({ [SURUM_ALANI]: guncelSurum(bicim), ...surumAlaniniAt(govde) }, null, 2)}\n`;
}
