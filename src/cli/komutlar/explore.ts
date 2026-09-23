import { basariliMetin, komutCalistir, type KomutSonucu } from '../komut.js';
import { dizinBul, kesfiYenile } from './ortak.js';

/** Özette listelenecek en fazla sayfa; gerisi "… +N more" olarak toplanır. */
const OZETTE_SAYFA_SINIRI = 8;

/** Sayfa adresini hedefe göre kısaltır: `http://x/cariler` → `/cariler`. */
function kisaYol(url: string, baseUrl: string): string {
  return url.startsWith(baseUrl) ? (url.slice(baseUrl.length) || '/') : url;
}

export async function explore(a: { cwd: string }): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const dizin = await dizinBul(a.cwd);
    const harita = await kesfiYenile(dizin);
    // İnsan modunda haritanın tamamı (sayfa sayısı kadar nesne) basılmaz:
    // sayfa sayısı, harita dosyası ve kısa sayfa listesi yeter. `--output json`
    // aynı haritayı verir.
    const yollar = harita.pages.map((sayfa) => kisaYol(sayfa.url, harita.baseUrl));
    const gosterilen = yollar.slice(0, OZETTE_SAYFA_SINIRI).join(', ');
    const artan = yollar.length - OZETTE_SAYFA_SINIRI;
    const metin = [
      `${harita.pages.length} page${harita.pages.length === 1 ? '' : 's'} explored`
      + `${harita.loggedIn ? ' (logged in)' : ''}`,
      `Map: ${dizin.yol('map.json')}`,
      ...(yollar.length === 0 ? [] : [`Pages: ${gosterilen}${artan > 0 ? `, … +${artan} more` : ''}`]),
      'Next: kobay test plan generate',
    ].join('\n');
    return basariliMetin(harita, metin);
  });
}
