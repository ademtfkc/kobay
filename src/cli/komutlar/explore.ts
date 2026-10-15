import { basariliMetin, komutCalistir, type KomutSonucu } from '../komut.js';
import { adresKimligiGizle } from '../../depo/index.js';
import { resolve } from 'node:path';
import { dizinBul, kesfiYenile, type KesifAyari } from './ortak.js';

/** Özette listelenecek en fazla sayfa; gerisi "… +N more" olarak toplanır. */
const OZETTE_SAYFA_SINIRI = 8;

/** Sayfa adresini hedefe göre kısaltır: `http://x/cariler` → `/cariler`. */
function kisaYol(url: string, baseUrl: string): string {
  return url.startsWith(baseUrl) ? (url.slice(baseUrl.length) || '/') : adresKimligiGizle(url);
}

/**
 * `oturumDosyasi` (`--session-file`) yalnız CLI'dan gelir; MCP `explore` aracı geçmez (ajan keyfi
 * dosya yolu vermesin). Göreli yol `cwd`'ye göre çözülür.
 */
export async function explore(a: { cwd: string; oturumDosyasi?: string } & KesifAyari): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    const ayar: KesifAyari = {
      ...(a.tohumlar === undefined ? {} : { tohumlar: a.tohumlar }),
      ...(a.siteHaritasi === undefined ? {} : { siteHaritasi: a.siteHaritasi }),
      ...(a.maxSayfa === undefined ? {} : { maxSayfa: a.maxSayfa }),
      ...(a.derinlik === undefined ? {} : { derinlik: a.derinlik }),
    };
    const harita = await kesfiYenile(
      dizin,
      ayar,
      a.oturumDosyasi === undefined ? undefined : resolve(a.cwd, a.oturumDosyasi),
    );
    // İnsan modunda haritanın tamamı (sayfa sayısı kadar nesne) basılmaz:
    // sayfa sayısı, harita dosyası ve kısa sayfa listesi yeter. `--output json`
    // aynı haritayı verir.
    const yollar = harita.pages.map((sayfa) => kisaYol(sayfa.url, harita.baseUrl));
    const gosterilen = yollar.slice(0, OZETTE_SAYFA_SINIRI).join(', ');
    const artan = yollar.length - OZETTE_SAYFA_SINIRI;
    const metin = [
      `${harita.pages.length} page${harita.pages.length === 1 ? '' : 's'} explored`
      + `${harita.sessionSource === 'imported' ? ' (logged in, imported session)' : harita.loggedIn ? ' (logged in)' : ''}`,
      `Map: ${dizin.yol('map.json')}`,
      ...(yollar.length === 0 ? [] : [`Pages: ${gosterilen}${artan > 0 ? `, … +${artan} more` : ''}`]),
      'Next: kobay test plan generate',
    ].join('\n');
    return basariliMetin(harita, metin);
  });
}
