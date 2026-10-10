import type { Writable } from 'node:stream';
import { metindekiKimligiGizle } from '../depo/adres.js';
import type { KomutSonucu } from './komut.js';

export interface CiktiZarfi {
  ok: boolean;
  exitCode: number;
  data?: unknown;
  error?: { code: string; message: string };
  /** Yalnız komut beyin çağrısı yaptıysa; `costUsd` maliyeti bilinmeyen çağrı varsa `null`. */
  brain?: BeyinOzeti;
}

/** Komutun beyin (LLM) kullanımı: çağrı sayısı ve sağlayıcının bildirdiği toplam maliyet. */
export interface BeyinOzeti {
  calls: number;
  costUsd: number | null;
}

function hataMi(veri: unknown): veri is { error: { code: string; message: string } } {
  if (typeof veri !== 'object' || veri === null || !('error' in veri)) return false;
  const hata = veri.error;
  return typeof hata === 'object' && hata !== null && 'code' in hata && 'message' in hata;
}

export function ciktiZarfi(sonuc: KomutSonucu): CiktiZarfi {
  if (sonuc.exitCode !== 0) {
    if (hataMi(sonuc.json)) return { ok: false, exitCode: sonuc.exitCode, error: sonuc.json.error };
    return { ok: false, exitCode: sonuc.exitCode, data: sonuc.json };
  }
  return { ok: true, exitCode: sonuc.exitCode, data: sonuc.json };
}

/** İç içe dizi hücrelerinde sayının yanına yazılan birim; bilinmeyen alan "item" olur. */
const DIZI_BIRIMLERI: Record<string, string> = {
  planSteps: 'step',
  steps: 'step',
  evidence: 'evidence item',
  pages: 'page',
  links: 'link',
  forms: 'form',
  fields: 'form field',
  buttons: 'button',
  headings: 'heading',
  menu: 'menu item',
  proposals: 'proposal',
  dropped: 'proposal',
  tests: 'test',
  runs: 'run',
};

/** Sayı + birim; İngilizcede 1 dışındaki sayılarda birim çoğullanır. */
function birimliSayi(sayi: number, birim: string): string {
  return `${sayi} ${birim}${sayi === 1 ? '' : 's'}`;
}

/** Nesne hücresinde önce okunur bir alan aranır; yoksa kısa JSON basılır. */
const OZET_ALANLARI = ['description', 'title', 'name', 'message', 'kind', 'id'];

const HUCRE_SINIRI = 60;

function kisalt(metin: string, sinir = HUCRE_SINIRI): string {
  const tek = metin.replace(/\s+/g, ' ').trim();
  return tek.length <= sinir ? tek : `${tek.slice(0, sinir - 1)}…`;
}

function nesneOzeti(deger: Record<string, unknown>): string {
  for (const alan of OZET_ALANLARI) {
    const ic = deger[alan];
    if (typeof ic === 'string' && ic.trim() !== '') return kisalt(ic);
    if (typeof ic === 'number' || typeof ic === 'boolean') return String(ic);
  }
  return kisalt(JSON.stringify(deger));
}

/**
 * Tablo hücresini insan okunur tek satıra indirir: nesne dizileri "6 steps",
 * ilkel diziler virgülle, nesneler tek alanlık özetle basılır. Böylece hiçbir
 * hücrede `[object Object]` görünmez.
 */
export function hucreMetni(anahtar: string, deger: unknown): string {
  if (deger === null || deger === undefined) return '';
  if (Array.isArray(deger)) {
    const birim = DIZI_BIRIMLERI[anahtar] ?? 'item';
    if (deger.length === 0) return birimliSayi(0, birim);
    if (deger.every((oge) => typeof oge !== 'object' || oge === null)) {
      return kisalt(deger.map((oge) => String(oge ?? '')).join(', '));
    }
    return birimliSayi(deger.length, birim);
  }
  if (typeof deger === 'object') return nesneOzeti(deger as Record<string, unknown>);
  return kisalt(String(deger));
}

function insanCiktisi(veri: unknown): string {
  if (Array.isArray(veri)) {
    if (veri.length === 0) return '';
    return `${veri.map((satir) => {
      if (typeof satir !== 'object' || satir === null) return String(satir);
      return Object.entries(satir as Record<string, unknown>)
        .map(([anahtar, deger]) => hucreMetni(anahtar, deger))
        .join('\t');
    }).join('\n')}\n`;
  }
  if (typeof veri === 'string') return `${veri}\n`;
  if (veri === undefined) return '';
  return `${JSON.stringify(veri, null, 2)}\n`;
}

/** Doğrudan stderr'e düşen uyarılar da insan çıktısı gibi adres kimliğinden arındırılır. */
export function uyariYaz(metin: string, stderr: Writable = process.stderr): void {
  stderr.write(metindekiKimligiGizle(metin));
}

const MIKRO = 1_000_000;

/**
 * Maliyeti tamsayı mikro-dolara çevirir (bütçe defteri de 6 ondalığa kuantize eder). Sonlu ve ≥ 0 olmayan ya da
 * tamsayı aritmetiğinin güvenli aralığını aşan değer (NaN, Infinity, negatif, 1e21) için null: maliyet bilinmiyor.
 */
function mikroDolar(deger: number): number | null {
  if (!Number.isFinite(deger) || deger < 0) return null;
  const mikro = Math.round(deger * MIKRO);
  return Number.isSafeInteger(mikro + MIKRO) ? mikro : null;
}

/** Tamsayı mikro-doları `basamak` ondalığa yarım-yukarı yuvarlar; yalnız tamsayı aritmetiği, kayan nokta bölmesi yok. */
function mikroMetni(mikro: number, basamak: number): string {
  const adim = 10 ** (6 - basamak);
  const kaydirilmis = mikro + adim / 2;
  const adet = (kaydirilmis - (kaydirilmis % adim)) / adim;
  const olcek = 10 ** basamak;
  const kesir = adet % olcek;
  return `${(adet - kesir) / olcek}.${String(kesir).padStart(basamak, '0')}`;
}

/** Dolar tutarı: 0 → `0.00`; sentin altı (0 < x < 0.01) → 4 ondalık (`0.0040`); kalanı 2 ondalık. Geçersizse null. */
function dolarMetni(deger: number): string | null {
  const mikro = mikroDolar(deger);
  if (mikro === null) return null;
  if (deger > 0 && mikro < MIKRO / 100) {
    const ince = mikroMetni(mikro, 4);
    // 0.009996 dört ondalıkta 0.0100 olur: sent eşiğine yuvarlanan değer iki ondalıkla yazılır.
    if (ince !== '0.0100') return ince;
  }
  return mikroMetni(mikro, 2);
}

/** Maliyet bilinmiyor sayılır: sağlayıcı bildirmedi (null) ya da değer geçersiz (NaN, Infinity, negatif, aşırı büyük). */
function gecerliMaliyet(costUsd: number | null): number | null {
  return costUsd === null || mikroDolar(costUsd) === null ? null : costUsd;
}

/** İnsan modunun stderr satırı: `Brain: 7 calls, $1.10` ya da `Brain: 7 calls, cost unknown`. */
export function beyinSatiri(beyin: BeyinOzeti): string {
  const maliyet = beyin.costUsd === null ? null : dolarMetni(beyin.costUsd);
  return `Brain: ${birimliSayi(beyin.calls, 'call')}, ${maliyet === null ? 'cost unknown' : `$${maliyet}`}`;
}

export function ciktiYaz(
  sonuc: KomutSonucu,
  json: boolean,
  stdout: Writable = process.stdout,
  stderr: Writable = process.stderr,
  beyin?: BeyinOzeti,
): void {
  if (json) {
    const zarf = ciktiZarfi(sonuc);
    const brain = beyin === undefined ? undefined : { calls: beyin.calls, costUsd: gecerliMaliyet(beyin.costUsd) };
    stdout.write(`${JSON.stringify(brain === undefined ? zarf : { ...zarf, brain })}\n`);
    return;
  }
  insanCiktisiYaz(sonuc, stdout, stderr);
  if (beyin !== undefined) stderr.write(`${beyinSatiri(beyin)}\n`);
}

function insanCiktisiYaz(sonuc: KomutSonucu, stdout: Writable, stderr: Writable): void {
  // İnsan modunda basılan her metin (hata mesajı ve kayıt dökümü dahil) adres kimliğinden arındırılır;
  // `--output json` yukarıda aynen çıkar, makine sözleşmesi değişmez.
  if (sonuc.metin !== undefined) {
    if (sonuc.exitCode === 0) stdout.write(`${metindekiKimligiGizle(sonuc.metin)}\n`);
    else stderr.write(`${metindekiKimligiGizle(sonuc.metin)}\n`);
    return;
  }
  if (sonuc.mesaj !== undefined) stderr.write(`${metindekiKimligiGizle(sonuc.mesaj)}\n`);
  if (sonuc.exitCode === 0) stdout.write(metindekiKimligiGizle(insanCiktisi(sonuc.json)));
}
