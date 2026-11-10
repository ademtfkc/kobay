import type { Writable } from 'node:stream';
import { metindekiKimligiGizle } from '../depo/adres.js';

/**
 * Makine okunur uyarı (JSON zarfı ve MCP yanıtının `warnings` alanı). Kodlar genel yüzeydir:
 * `DEPRECATED` eski bir ad (bayrak, ileride ortam değişkeni) kullanıldı; `UNKNOWN_FIELD` MCP
 * aracı tanımadığı bir alanı yok saydı.
 */
export interface Uyari {
  code: 'DEPRECATED' | 'UNKNOWN_FIELD';
  message: string;
  /** DEPRECATED: eski adın yerine kullanılacak ad. */
  replacement?: string;
  /** UNKNOWN_FIELD: yok sayılan alanın adı. */
  field?: string;
}

/** Eski adların en erken kalkacağı sürüm (0.9.0 spec, Karar 3). */
export const KALDIRMA_SURUMU = '2.0';

/**
 * Eski ad uyarısı. Bayrak (`--base-url`) için de ortam değişkeni adı için de aynı biçim:
 * `<eski> is deprecated, use <yeni> (removal: 2.0)`.
 */
export function eskiAdUyarisi(eski: string, yeni: string): Uyari {
  return {
    code: 'DEPRECATED',
    message: `${eski} is deprecated, use ${yeni} (removal: ${KALDIRMA_SURUMU})`,
    replacement: yeni,
  };
}

/** Yanıt boyu girdiyle büyümesin: en çok bu kadar alan tek tek listelenir, kalanı tek özet uyarıdır. */
export const BILINMEYEN_ALAN_SINIRI = 10;
/** Listelenen alan adı bu uzunlukta kesilir (sonuna `…`). */
export const ALAN_ADI_SINIRI = 64;

function alanAdiKisalt(alan: string): string {
  return alan.length <= ALAN_ADI_SINIRI ? alan : `${alan.slice(0, ALAN_ADI_SINIRI - 1)}…`;
}

export function bilinmeyenAlanUyarisi(alan: string): Uyari {
  const ad = alanAdiKisalt(alan);
  return { code: 'UNKNOWN_FIELD', message: `Unknown field ${JSON.stringify(ad)} was ignored`, field: ad };
}

/**
 * Bilinmeyen alanların uyarıları, boyu sabit bir üst sınırla: ilk `BILINMEYEN_ALAN_SINIRI` alan
 * (adları kısaltılmış) ayrı uyarı, kalanlar tek `and N more` uyarısı (`field` yok).
 */
export function bilinmeyenAlanUyarilari(alanlar: readonly string[]): Uyari[] {
  const listelenen = alanlar.slice(0, BILINMEYEN_ALAN_SINIRI).map(bilinmeyenAlanUyarisi);
  const kalan = alanlar.length - listelenen.length;
  if (kalan <= 0) return listelenen;
  return [...listelenen, {
    code: 'UNKNOWN_FIELD',
    message: `and ${kalan} more unknown field${kalan === 1 ? '' : 's'} were ignored`,
  }];
}

/** stderr'e yazılan tek satır (sonunda satır sonu yok). */
export function uyariSatiri(uyari: Uyari): string {
  return `kobay: warning: ${uyari.message}`;
}

/** Süreç başına bir kez: aynı satır ikinci kez stderr'e yazılmaz (zarfa ise her komutta girer). */
const yazilanSatirlar = new Set<string>();

export function uyarilariYaz(uyarilar: readonly Uyari[] | undefined, stderr: Writable = process.stderr): void {
  for (const uyari of uyarilar ?? []) {
    const satir = uyariSatiri(uyari);
    if (yazilanSatirlar.has(satir)) continue;
    yazilanSatirlar.add(satir);
    stderr.write(`${metindekiKimligiGizle(satir)}\n`);
  }
}

/** Yalnız testler: aynı süreçte koşan ayrı CLI çağrılarını yeni süreç gibi başlatır. */
export function yazilanUyarilariSifirla(): void {
  yazilanSatirlar.clear();
}
