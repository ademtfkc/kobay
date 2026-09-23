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
  | 'timeout'
  | 'cli_missing'
  | 'schema'
  | 'empty_response'
  | 'network'
  | 'key_missing';

export type BeyinCalismaHataSebebi =
  | 'cli_error'
  | 'call_cap'
  | 'cost_cap'
  | 'cost_unknown'
  | 'config_error';

/** CLI ve harcama korumaları; eski BrainError switch sözleşmesini genişletmez. */
export class BrainRuntimeError extends Error {
  readonly sebep: BeyinCalismaHataSebebi;
  readonly detay?: string;

  constructor(sebep: BeyinCalismaHataSebebi, detay?: string) {
    super(`Brain error: ${sebep}${detay === undefined || detay === '' ? '' : ` — ${detay}`}`);
    this.name = 'BrainRuntimeError';
    this.sebep = sebep;
    if (detay !== undefined) this.detay = detay;
  }
}

export class BrainError extends Error {
  readonly sebep: BeyinHataSebebi;
  readonly ham?: string;

  constructor(sebep: BeyinHataSebebi, ham?: string) {
    super(`Brain error: ${sebep}`);
    this.name = 'BrainError';
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
