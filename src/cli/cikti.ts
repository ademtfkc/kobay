import type { Writable } from 'node:stream';
import type { KomutSonucu } from './komut.js';

export interface CiktiZarfi {
  ok: boolean;
  exitCode: number;
  data?: unknown;
  error?: { code: string; message: string };
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

export function ciktiYaz(
  sonuc: KomutSonucu,
  json: boolean,
  stdout: Writable = process.stdout,
  stderr: Writable = process.stderr,
): void {
  if (json) {
    stdout.write(`${JSON.stringify(ciktiZarfi(sonuc))}\n`);
    return;
  }
  if (sonuc.metin !== undefined) {
    if (sonuc.exitCode === 0) stdout.write(`${sonuc.metin}\n`);
    else stderr.write(`${sonuc.metin}\n`);
    return;
  }
  if (sonuc.mesaj !== undefined) stderr.write(`${sonuc.mesaj}\n`);
  if (sonuc.exitCode === 0) stdout.write(insanCiktisi(sonuc.json));
}
