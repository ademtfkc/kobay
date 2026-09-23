import type * as v from 'valibot';
import type { BeyinAyari } from '../depo/index.js';
import { ClaudeBeyni } from './claude.js';
import { CodexBeyni } from './codex.js';
import { OpenRouterBeyni } from './openrouter.js';
import { BeyinButcesi } from './ortak.js';
import { SahteBeyin } from './sahte.js';

export interface BeyinIstegi {
  gorev: string;
  sistem: string;
  kullanici: string;
  sema: v.GenericSchema;
  zamanAsimiSn?: number;
  logDizini?: string;
}

export interface BeyinYaniti<T> {
  json: T;
  ham: string;
  sureMs: number;
  adaptor: string;
  maliyetUsd?: number;
  turSayisi?: number;
  hataMi?: boolean;
}

export interface Beyin {
  readonly ad: string;
  sor<T>(istek: BeyinIstegi): Promise<BeyinYaniti<T>>;
}

export type BeyinHataSebebi =
  | 'zaman_asimi'
  | 'cli_yok'
  | 'sema'
  | 'bos_yanit'
  | 'ag'
  | 'anahtar_yok';

export type BeyinCalismaHataSebebi =
  | 'cli_hatasi'
  | 'cagri_tavani'
  | 'maliyet_tavani'
  | 'maliyet_bilinmiyor'
  | 'ayar_hatasi';

/** CLI ve harcama korumaları; eski BeyinHatasi switch sözleşmesini genişletmez. */
export class BeyinCalismaHatasi extends Error {
  readonly sebep: BeyinCalismaHataSebebi;
  readonly detay?: string;

  constructor(sebep: BeyinCalismaHataSebebi, detay?: string) {
    super(`Beyin hatası: ${sebep}${detay === undefined || detay === '' ? '' : ` — ${detay}`}`);
    this.name = 'BeyinCalismaHatasi';
    this.sebep = sebep;
    if (detay !== undefined) this.detay = detay;
  }
}

export class BeyinHatasi extends Error {
  readonly sebep: BeyinHataSebebi;
  readonly ham?: string;

  constructor(sebep: BeyinHataSebebi, ham?: string) {
    super(`Beyin hatası: ${sebep}`);
    this.name = 'BeyinHatasi';
    this.sebep = sebep;
    if (ham !== undefined) this.ham = ham;
  }
}

/**
 * Süreç başına TEK harcama sayacı. Üretimde her çağıran `process.env` geçirir, yani süreçte tek
 * defter vardır. Politika (tavan) değişince sayaç sıfırlanmaz; en katı sınırlar birleşir. Farklı
 * env nesnesi yalnız testlerde yalıtım için kullanılır.
 */
const surecButceleri = new WeakMap<NodeJS.ProcessEnv, BeyinButcesi>();

export function beyinOlustur(ayar: BeyinAyari, env: NodeJS.ProcessEnv = process.env): Beyin {
  let butce = surecButceleri.get(env);
  if (butce === undefined) {
    butce = new BeyinButcesi(ayar, env);
    surecButceleri.set(env, butce);
  } else {
    butce.politikaEkle(ayar, env);
  }
  switch (ayar.adaptor) {
    case 'claude':
      return new ClaudeBeyni(ayar, env, butce);
    case 'codex':
      return new CodexBeyni(ayar, env, butce);
    case 'openrouter':
      return new OpenRouterBeyni(ayar, env, butce);
    case 'sahte':
      return new SahteBeyin(env, butce);
  }
}
