import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as v from 'valibot';
import { yazAtomik, type BeyinAyari } from '../depo/index.js';
import { BrainRuntimeError, BrainError, type BeyinIstegi } from './index.js';

export const VARSAYILAN_ZAMAN_ASIMI_SN = 180;
export const VARSAYILAN_CLAUDE_BUTCESI_USD = 1;
export const VARSAYILAN_BEYIN_CAGRISI = 100;
export const VARSAYILAN_TOPLAM_MALIYET_USD = 5;
export const VARSAYILAN_OPENROUTER_MAX_TOKENS = 4096;

export interface BeyinKullanimi {
  maliyetUsd?: number;
  turSayisi?: number;
  hataMi?: boolean;
}

export interface HamBeyinYaniti extends BeyinKullanimi {
  ham: string;
}

export interface BeyinRezervasyonu {
  readonly kimlik: number;
  readonly azamiMaliyetUsd: number;
}

function pozitifAyar(
  env: NodeJS.ProcessEnv,
  ortamAdi: string,
  ayarDegeri: number | undefined,
  varsayilan: number,
  tamSayi = false,
): number {
  const ham = env[ortamAdi];
  const deger = ham === undefined || ham === '' ? (ayarDegeri ?? varsayilan) : Number(ham);
  if (!Number.isFinite(deger) || deger <= 0 || (tamSayi && !Number.isInteger(deger))) {
    throw new BrainRuntimeError(
      'config_error',
      `${ortamAdi} must be a positive ${tamSayi ? 'integer' : 'number'}.`,
    );
  }
  return deger;
}

interface ButcePolitikasi {
  claudeCagriButcesiUsd: number;
  azamiCagri: number;
  azamiMaliyetUsd: number;
  openRouterMaxTokens: number;
}

function politikaOku(ayar: BeyinAyari, env: NodeJS.ProcessEnv): ButcePolitikasi {
  return {
    claudeCagriButcesiUsd: pozitifAyar(
      env, 'KOBAY_MAX_BUDGET_USD', ayar.maxBudgetUsd, VARSAYILAN_CLAUDE_BUTCESI_USD,
    ),
    azamiCagri: pozitifAyar(
      env, 'KOBAY_MAX_BRAIN_CALLS', ayar.maxCalls, VARSAYILAN_BEYIN_CAGRISI, true,
    ),
    azamiMaliyetUsd: pozitifAyar(
      env, 'KOBAY_MAX_TOTAL_COST_USD', ayar.maxTotalCostUsd, VARSAYILAN_TOPLAM_MALIYET_USD,
    ),
    openRouterMaxTokens: pozitifAyar(
      env, 'KOBAY_OPENROUTER_MAX_TOKENS', ayar.maxTokens, VARSAYILAN_OPENROUTER_MAX_TOKENS, true,
    ),
  };
}

/** Tavana takılan ajana kararı insana bıraktıran ortak not. */
export function insanOnayiNotu(ayarlar: string): string {
  return 'Ask the user for approval before continuing; do not change the setting yourself. '
    + `Only the user can raise the limit (${ayarlar}); inside the same kobay process a limit can only go down, `
    + 'a raise takes effect in a new kobay process (for example once the MCP server restarts).';
}

/**
 * Süreçteki bütün adaptör denemelerinin TEK harcama sayacı. Farklı politikalar
 * görülürse sayaç sıfırlanmaz; her sınır için en katı değer uygulanır.
 */
export class BeyinButcesi {
  private claudeCagriButcesiUsd: number;
  private azamiCagri: number;
  private azamiMaliyetUsd: number;
  private openRouterMaxTokensDegeri: number;
  private cagriSayisi = 0;
  private toplamMaliyetUsd = 0;
  private siradakiRezervasyon = 1;
  private readonly rezervasyonlar = new Map<number, number>();

  constructor(ayar: BeyinAyari, env: NodeJS.ProcessEnv) {
    const politika = politikaOku(ayar, env);
    this.claudeCagriButcesiUsd = politika.claudeCagriButcesiUsd;
    this.azamiCagri = politika.azamiCagri;
    this.azamiMaliyetUsd = politika.azamiMaliyetUsd;
    this.openRouterMaxTokensDegeri = politika.openRouterMaxTokens;
  }

  get openRouterMaxTokens(): number {
    return this.openRouterMaxTokensDegeri;
  }

  /** Yeni görülen politikayı mevcut sayaca katar: her sınırda en katı değer kalır, harcama korunur. */
  politikaEkle(ayar: BeyinAyari, env: NodeJS.ProcessEnv): void {
    const politika = politikaOku(ayar, env);
    this.claudeCagriButcesiUsd = Math.min(this.claudeCagriButcesiUsd, politika.claudeCagriButcesiUsd);
    this.azamiCagri = Math.min(this.azamiCagri, politika.azamiCagri);
    this.azamiMaliyetUsd = Math.min(this.azamiMaliyetUsd, politika.azamiMaliyetUsd);
    this.openRouterMaxTokensDegeri = Math.min(this.openRouterMaxTokensDegeri, politika.openRouterMaxTokens);
  }

  private rezerveMaliyetUsd(): number {
    let toplam = 0;
    for (const maliyet of this.rezervasyonlar.values()) toplam += maliyet;
    return toplam;
  }

  private kalanMaliyetUsd(): number {
    return this.azamiMaliyetUsd - this.toplamMaliyetUsd - this.rezerveMaliyetUsd();
  }

  cagriBaslat(azamiMaliyetUsd = 0): BeyinRezervasyonu {
    if (!Number.isFinite(azamiMaliyetUsd) || azamiMaliyetUsd < 0) {
      throw new BrainRuntimeError('config_error', 'The call cost reservation must be a finite, non-negative number.');
    }
    if (this.cagriSayisi >= this.azamiCagri) {
      throw new BrainRuntimeError(
        'call_cap',
        `Brain call limit reached (${this.azamiCagri}). `
          + insanOnayiNotu('KOBAY_MAX_BRAIN_CALLS or brain.maxCalls'),
      );
    }
    const kalan = this.kalanMaliyetUsd();
    if (azamiMaliyetUsd > kalan || kalan <= 0) {
      throw new BrainRuntimeError(
        'cost_cap',
        `Cost limit reached: ${Math.max(0, kalan).toFixed(4)} USD left for the known and reserved total; `
          + `the call needs up to ${azamiMaliyetUsd.toFixed(4)} USD. Limit ${this.azamiMaliyetUsd.toFixed(4)} USD. `
          + insanOnayiNotu('KOBAY_MAX_TOTAL_COST_USD or brain.maxTotalCostUsd'),
      );
    }
    this.cagriSayisi += 1;
    const rezervasyon = { kimlik: this.siradakiRezervasyon, azamiMaliyetUsd };
    this.siradakiRezervasyon += 1;
    this.rezervasyonlar.set(rezervasyon.kimlik, azamiMaliyetUsd);
    return rezervasyon;
  }

  claudeCagrisiBaslat(): BeyinRezervasyonu {
    return this.cagriBaslat(Math.min(this.claudeCagriButcesiUsd, Math.max(0, this.kalanMaliyetUsd())));
  }

  cagriTamamla(rezervasyon: BeyinRezervasyonu, maliyetUsd: number | undefined): void {
    const ayrilan = this.rezervasyonlar.get(rezervasyon.kimlik);
    if (ayrilan === undefined) return;
    this.rezervasyonlar.delete(rezervasyon.kimlik);
    if (maliyetUsd === undefined || !Number.isFinite(maliyetUsd) || maliyetUsd < 0) {
      this.toplamMaliyetUsd += ayrilan;
      throw new BrainRuntimeError(
        'cost_unknown',
        `The provider did not report the actual cost; the ${ayrilan.toFixed(4)} USD reservation was counted as spent. `
          + 'No new call was made. Check the provider usage records.',
      );
    }
    this.toplamMaliyetUsd += maliyetUsd;
    if (maliyetUsd > ayrilan + Number.EPSILON || this.toplamMaliyetUsd > this.azamiMaliyetUsd + Number.EPSILON) {
      throw new BrainRuntimeError(
        'cost_cap',
        `Cost limit reached: the actual cost ${maliyetUsd.toFixed(4)} USD exceeded the ${ayrilan.toFixed(4)} USD reservation; `
          + `known total ${this.toplamMaliyetUsd.toFixed(4)} USD. `
          + insanOnayiNotu('KOBAY_MAX_TOTAL_COST_USD or brain.maxTotalCostUsd'),
      );
    }
  }

  /**
   * Başlamış ama başarısız biten çağrı (zaman aşımı, sıfır dışı çıkış, ağ hatası):
   * sağlayıcı faturalamış olabilir, rezervasyon iade edilmez. Gerçek maliyet
   * okunabildiyse onunla uzlaşılır; okunamadıysa rezervasyonun tamamı harcanmış sayılır.
   */
  cagriHarcandi(rezervasyon: BeyinRezervasyonu, maliyetUsd?: number): void {
    const ayrilan = this.rezervasyonlar.get(rezervasyon.kimlik);
    if (ayrilan === undefined) return;
    this.rezervasyonlar.delete(rezervasyon.kimlik);
    const bilinen = maliyetUsd !== undefined && Number.isFinite(maliyetUsd) && maliyetUsd >= 0;
    this.toplamMaliyetUsd += bilinen ? maliyetUsd : ayrilan;
  }

  /** Yalnız çağrı hiç başlamadıysa (süreç spawn edilemedi, dosya yok) rezervasyonu iade eder. */
  cagriIptal(rezervasyon: BeyinRezervasyonu): void {
    this.rezervasyonlar.delete(rezervasyon.kimlik);
  }
}

export function istemOlustur(istek: BeyinIstegi, semaHatasi?: string): string {
  const tekrar = semaHatasi === undefined
    ? ''
    : `\n\nThe previous answer did not match the schema: ${semaHatasi}. Fix the answer.`;
  return `${istek.sistem}\n\n${istek.kullanici}\n\nReturn JSON only, no commentary.${tekrar}`;
}

/** Metin içindeki ilk dengeli JSON nesnesini veya dizisini bulur. */
export function ilkJsonBlogu(metin: string): string | null {
  const cit = /```(?:json)?\s*([\s\S]*?)```/i.exec(metin);
  const kaynak = cit?.[1] ?? metin;
  const baslangic = kaynak.search(/{|\[/);
  if (baslangic === -1) return null;

  const acilis = kaynak[baslangic];
  if (acilis === undefined) return null;
  const kapanis = acilis === '{' ? '}' : ']';
  let derinlik = 0;
  let dizgede = false;
  let kacis = false;

  for (let i = baslangic; i < kaynak.length; i += 1) {
    const karakter = kaynak[i];
    if (karakter === undefined) continue;
    if (dizgede) {
      if (kacis) kacis = false;
      else if (karakter === '\\') kacis = true;
      else if (karakter === '"') dizgede = false;
      continue;
    }
    if (karakter === '"') {
      dizgede = true;
    } else if (karakter === acilis) {
      derinlik += 1;
    } else if (karakter === kapanis) {
      derinlik -= 1;
      if (derinlik === 0) return kaynak.slice(baslangic, i + 1);
    }
  }
  return null;
}

/** Kapanışı eksik (kesilmiş) JSON metnini, açık kalan parantezleri sırayla kapatarak tamamlar; dizge içinde kesilmişse null. */
export function eksikKapanislariTamamla(metin: string): string | null {
  const cit = /```(?:json)?\s*([\s\S]*?)```/i.exec(metin);
  const kaynak = (cit?.[1] ?? metin).trimEnd();
  const baslangic = kaynak.search(/{|\[/);
  if (baslangic === -1) return null;
  const yigin: string[] = [];
  let dizgede = false;
  let kacis = false;
  for (let i = baslangic; i < kaynak.length; i += 1) {
    const karakter = kaynak[i];
    if (karakter === undefined) continue;
    if (dizgede) {
      if (kacis) kacis = false;
      else if (karakter === '\\') kacis = true;
      else if (karakter === '"') dizgede = false;
      continue;
    }
    if (karakter === '"') dizgede = true;
    else if (karakter === '{') yigin.push('}');
    else if (karakter === '[') yigin.push(']');
    else if (karakter === '}' || karakter === ']') {
      if (yigin.pop() !== karakter) return null;
      if (yigin.length === 0) return kaynak.slice(baslangic, i + 1);
    }
  }
  if (dizgede || yigin.length === 0) return null;
  const govde = kaynak.slice(baslangic).replace(/,\s*$/, '');
  return govde + yigin.reverse().join('');
}

function issueYolu(issue: v.BaseIssue<unknown>): string {
  if (issue.path === undefined || issue.path.length === 0) return '$';
  return issue.path.reduce((yol, parca) => (
    typeof parca.key === 'number' ? `${yol}[${parca.key}]` : `${yol}.${String(parca.key)}`
  ), '$').replace(/^\$\./, '');
}

function semaSorununuVer(ham: string, sema: v.GenericSchema): { ok: true; veri: unknown } | { ok: false; hata: string } {
  const blok = ilkJsonBlogu(ham) ?? eksikKapanislariTamamla(ham);
  if (blok === null) return { ok: false, hata: 'No JSON block was found in the answer.' };
  let ayrisilmis: unknown;
  try {
    ayrisilmis = JSON.parse(blok) as unknown;
  } catch {
    return { ok: false, hata: 'The JSON could not be parsed.' };
  }
  const sonuc = v.safeParse(sema, ayrisilmis);
  if (sonuc.success) return { ok: true, veri: sonuc.output };
  const hata = sonuc.issues.slice(0, 5).map((issue) => `${issueYolu(issue)}: ${issue.message}`).join('; ');
  return { ok: false, hata: hata || 'Schema validation failed.' };
}

export async function semaylaSor<T>(
  istek: BeyinIstegi,
  cagir: (istem: string) => Promise<HamBeyinYaniti>,
): Promise<{ json: T; ham: string } & BeyinKullanimi> {
  let semaHatasi: string | undefined;
  let sonHam = '';
  let toplamMaliyetUsd: number | undefined;
  let toplamTurSayisi: number | undefined;
  let hataMi: boolean | undefined;
  for (let deneme = 0; deneme < 2; deneme += 1) {
    const istem = istemOlustur(istek, semaHatasi);
    const yanit = await cagir(istem);
    sonHam = yanit.ham;
    if (yanit.maliyetUsd !== undefined) toplamMaliyetUsd = (toplamMaliyetUsd ?? 0) + yanit.maliyetUsd;
    if (yanit.turSayisi !== undefined) toplamTurSayisi = (toplamTurSayisi ?? 0) + yanit.turSayisi;
    if (yanit.hataMi !== undefined) hataMi = (hataMi ?? false) || yanit.hataMi;
    const sonuc = semaSorununuVer(sonHam, istek.sema);
    if (sonuc.ok) {
      return {
        json: sonuc.veri as T,
        ham: sonHam,
        ...(toplamMaliyetUsd === undefined ? {} : { maliyetUsd: toplamMaliyetUsd }),
        ...(toplamTurSayisi === undefined ? {} : { turSayisi: toplamTurSayisi }),
        ...(hataMi === undefined ? {} : { hataMi }),
      };
    }
    semaHatasi = sonuc.hata;
    if (deneme === 0) await beyinGunluguYaz(istek.logDizini, istek.gorev, istem, sonHam, yanit);
  }
  throw new BrainError('schema', sonHam);
}

export async function beyinGunluguYaz(
  dizin: string | undefined,
  gorev: string,
  istem: string,
  ham: string,
  kullanim?: BeyinKullanimi,
): Promise<void> {
  if (dizin === undefined) return;
  const guvenliGorev = gorev.replace(/[^a-zA-Z0-9_-]/g, '-');
  let sayi = 1;
  try {
    const dosyalar = await readdir(dizin);
    const eslesme = new RegExp(`^beyin-${guvenliGorev}-(\\d+)\\.log$`);
    for (const dosya of dosyalar) {
      const bulunan = eslesme.exec(dosya)?.[1];
      if (bulunan !== undefined) sayi = Math.max(sayi, Number(bulunan) + 1);
    }
  } catch (hata: unknown) {
    if (!(typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT')) throw hata;
  }
  const ek = kullanim === undefined ? '' : `\n--- kullanim ---\n${JSON.stringify(kullanim)}`;
  await yazAtomik(`${dizin}/beyin-${guvenliGorev}-${sayi}.log`, `${istem}\n---\n${ham}${ek}`);
}

const GIZLI_AD_DESENI = String.raw`(?:parola|password|token|secret|authorization|api[_ -]?key)`;
const TIRNAKLI_JSON_DESENI = new RegExp(String.raw`("${GIZLI_AD_DESENI}"\s*:\s*")[^"]*(")`, 'gi');
const ANAHTAR_DEGER_DESENI = new RegExp(String.raw`((?:${GIZLI_AD_DESENI})\s*[:=]\s*["']?)([^\s,;"']+)(["']?)`, 'gi');
const BEARER_DESENI = /\b(Bearer\s+)[A-Za-z0-9._-]+/gi;
const BASIC_DESENI = /\b(Basic\s+)[A-Za-z0-9+/=]+/gi;
const URL_GIZLI_PARAMETRE_DESENI = /([?&](?:token|api[_-]?key|password|parola|secret)=)[^&#\s]+/gi;

export function gizliDegerleriMaskele(metin: string): string {
  return metin
    .replace(TIRNAKLI_JSON_DESENI, '$1[redacted]$2')
    .replace(BEARER_DESENI, '$1[redacted]')
    .replace(BASIC_DESENI, '$1[redacted]')
    .replace(URL_GIZLI_PARAMETRE_DESENI, '$1[redacted]')
    .replace(ANAHTAR_DEGER_DESENI, '$1[redacted]$3');
}

const baslamayanSurecHatalari = new WeakSet<object>();

/** Hata, süreç hiç başlatılamadan (spawn öncesi) mı oluştu? Yalnız bu durumda rezervasyon iade edilebilir. */
export function surecBaslamadiMi(hata: unknown): boolean {
  return typeof hata === 'object' && hata !== null && baslamayanSurecHatalari.has(hata);
}

export interface KomutSonucu {
  stdout: string;
  stderr: string;
  kod: number | null;
  zamanAsimi: boolean;
}

export function cliCikisHatasi(kod: number | null, stderr: string): BrainRuntimeError {
  const guvenliStderr = gizliDegerleriMaskele(stderr).slice(0, 500).trim();
  return new BrainRuntimeError(
    'cli_error',
    `CLI exited with code ${kod ?? 'unknown'}${guvenliStderr === '' ? '.' : `: ${guvenliStderr}`}`,
  );
}

/**
 * Süreci çalıştırır; sıfır dışı çıkış ve zaman aşımında da stdout'u döndürür ki
 * çağıran gerçek maliyeti okuyabilsin. Yalnız süreç başlatılamazsa reddeder.
 */
export async function komutSonucu(
  komut: string,
  argumanlar: string[],
  secenekler: { girdi?: string; env: NodeJS.ProcessEnv; cwd?: string; zamanAsimiSn?: number },
): Promise<KomutSonucu> {
  const zamanAsimiMs = (secenekler.zamanAsimiSn ?? VARSAYILAN_ZAMAN_ASIMI_SN) * 1000;
  return new Promise((coz, red) => {
    const surec = spawn(komut, argumanlar, {
      cwd: secenekler.cwd,
      env: secenekler.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let basladi = false;
    let stdout = '';
    let stderr = '';
    let zamanAsimi = false;
    const zamanlayici = setTimeout(() => {
      zamanAsimi = true;
      surec.kill('SIGTERM');
    }, zamanAsimiMs);

    surec.once('spawn', () => { basladi = true; });
    surec.stdout.setEncoding('utf8');
    surec.stderr.setEncoding('utf8');
    surec.stdout.on('data', (parca: string) => { stdout += parca; });
    surec.stderr.on('data', (parca: string) => { stderr += parca; });
    surec.stdin.on('error', () => { /* süreç erken kapandıysa EPIPE; sonuç close ile gelir */ });
    surec.once('error', (hata: NodeJS.ErrnoException) => {
      clearTimeout(zamanlayici);
      const hataNesnesi: Error = hata.code === 'ENOENT' ? new BrainError('cli_missing') : hata;
      if (!basladi) baslamayanSurecHatalari.add(hataNesnesi);
      red(hataNesnesi);
    });
    surec.once('close', (kod) => {
      clearTimeout(zamanlayici);
      coz({ stdout, stderr, kod, zamanAsimi });
    });
    surec.stdin.end(secenekler.girdi);
  });
}

/** Eski sözleşme: sıfır dışı çıkış cli_hatasi, zaman aşımı zaman_asimi olarak reddedilir. */
export async function komutCalistir(
  komut: string,
  argumanlar: string[],
  secenekler: { girdi?: string; env: NodeJS.ProcessEnv; cwd?: string; zamanAsimiSn?: number },
): Promise<{ stdout: string; stderr: string }> {
  const sonuc = await komutSonucu(komut, argumanlar, secenekler);
  if (sonuc.zamanAsimi) throw new BrainError('timeout');
  if (sonuc.kod !== 0) throw cliCikisHatasi(sonuc.kod, sonuc.stderr);
  return { stdout: sonuc.stdout, stderr: sonuc.stderr };
}
