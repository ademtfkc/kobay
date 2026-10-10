import type { RaporSayimlari, RaporTesti } from './html.js';
import { dikkatGerekenMi, guvenilmezBlok } from './istem.js';

/**
 * `kobay test report --summary`: PR yorumuna ve iş özetine hazır GitHub-flavored
 * Markdown. Yalnız metin; ekran görüntüsü, DOM ve mutlak yol yok.
 *
 * Güvenlik modeli `istem.ts` ile aynı: iskelet (başlıklar, tablo çizgileri,
 * `<details>` etiketleri, sabit cümleler) hiçbir maskeden geçmez; güvenilmez
 * her değer (test adı) iskelete girmeden önce kendi başına `temizle`'den geçer,
 * sonra bulunduğu yere göre kaçışlanır. İstemler `istem.ts`'den değer değer
 * temizlenmiş gelir; burada yalnız içerikten uzun bir çitle sarılır. Bütün
 * metne ikinci maske uygulanmaz.
 */

/** Sticky PR yorumunu bulma anahtarı; özetin ilk satırı. */
export const OZET_ISARETI = '<!-- kobay-report -->';

/** GitHub yorum sınırı 65.536; altında pay bırakılır. */
export const OZET_SINIRI = 60_000;

export const VARSAYILAN_ISTEM_SAYISI = 5;

/** Tablodaki test adı üst sınırı (temizlendikten sonra, karakter). */
const AD_SINIRI = 120;

export interface OzetGirdisi {
  testler: readonly RaporTesti[];
  counts: RaporSayimlari;
  surum: string;
  /** Dikkat isteyen her test için, değer değer temizlenmiş istem (rapor sırasıyla). */
  fixPrompts: ReadonlyArray<{ id: string; prompt: string }>;
  fixAllPrompt?: string;
  /** Tek bir güvenilmez değer için sır maskesi + yol yer tutucusu. */
  temizle: (metin: string) => string;
  maxIstem?: number;
  /** Toplam karakter sınırı; varsayılan `OZET_SINIRI` (testler küçük sınır verebilir). */
  sinir?: number;
  /** Yalnız test için: özet her kurulduğunda (sığma denemesi) bir kez çağrılır. */
  kurulumIzleyici?: () => void;
}

/** Satır sonlarını boşluğa çevirip uzun değeri kısaltır. */
function tekSatir(metin: string, sinir: number): string {
  const tek = metin.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  return tek.length <= sinir ? tek : `${tek.slice(0, sinir - 1)}…`;
}

/** HTML bağlamı (`<summary>` içi): ham HTML bloğunda Markdown işlenmez, varlık kaçışı yeter. */
function htmlKacisi(metin: string): string {
  return metin
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Tablo hücresi: HTML varlık kaçışı (`<`, `>`, `&`), hücreyi bölen `|` ve
 * bağlantı/vurgu/kod üreten Markdown işaretleri ters bölüyle kaçışlanır.
 */
export function hucreKacisi(metin: string): string {
  return htmlKacisi(metin).replace(/[\\`*_[\]()|~!#]/g, (isaret) => `\\${isaret}`);
}

function sayiTablosu(c: RaporSayimlari): string[] {
  return [
    '| passed | failed | blocked | inconclusive | not run |',
    '|---:|---:|---:|---:|---:|',
    `| ${c.passed} | ${c.failed} | ${c.blocked} | ${c.inconclusive} | ${c.notRun} |`,
  ];
}

/**
 * "N of M test(s) need(s) attention": isim çoğulu toplama, fiil uyumu dikkat
 * sayısına göre (`1 of 1 test needs`, `1 of 3 tests needs`, `2 of 3 tests need`).
 * HTML raporu ve Markdown özeti aynı cümleyi buradan alır.
 */
export function dikkatCumlesi(dikkat: number, toplam: number): string {
  return `${dikkat} of ${toplam} test${toplam === 1 ? '' : 's'} need${dikkat === 1 ? 's' : ''} attention`;
}

function durumSatiri(testler: readonly RaporTesti[], c: RaporSayimlari): string {
  const dikkat = c.failed + c.blocked + c.inconclusive;
  if (testler.length === 0) return 'No tests were selected.';
  if (dikkat > 0) return `**${dikkatCumlesi(dikkat, testler.length)}.**`;
  if (c.notRun > 0) return `${c.passed} passed, ${c.notRun} not run.`;
  return `All ${testler.length} test${testler.length === 1 ? '' : 's'} passed.`;
}

function testTablosu(testler: readonly RaporTesti[], temizle: (metin: string) => string, adSiniri = AD_SINIRI): string[] {
  return [
    '| ID | Name | Verdict | Failure kind |',
    '|---|---|---|---|',
    ...testler.map((test) => {
      // Kimlik desen doğrulamalı, verdict ve failureKind sabit kümeden; yine de kaçışlanır.
      const ad = hucreKacisi(tekSatir(temizle(test.name), adSiniri));
      const verdict = test.verdict === 'not_run' ? 'not run' : test.verdict;
      return `| ${hucreKacisi(test.id)} | ${ad} | ${hucreKacisi(verdict)} | ${hucreKacisi(test.failureKind ?? '-')} |`;
    }),
  ];
}

function istemBlogu(baslik: string, istem: string): string {
  // `<details>` satırı ham HTML bloğu; boş satırdan sonraki çitli blok Markdown'dır ve
  // çit içerikteki en uzun backtick dizisinden uzun: içerik çitten de `</details>`'tan da kaçamaz.
  return ['<details>', `<summary>${baslik}</summary>`, '', guvenilmezBlok(istem), '', '</details>'].join('\n');
}

function dahaFazlaSatiri(sayi: number): string {
  return `${sayi} more failing test${sayi === 1 ? '' : 's'} — see the report artifact.`;
}

/**
 * Özet Markdown'ı. Sıra: işaret, başlık + sayı tablosu, test tablosu, en çok
 * `maxIstem` istem, kalanlar için tek satır, `fixAllPrompt`, alt satır. Uzunluk
 * `sinir`'i aşarsa önce `fixAllPrompt`, sonra sondan başlayarak istemler düşer
 * ve "truncated" notu eklenir. Tablo düşmez; tek başına sınırı aşarsa önce ad
 * hücresi kısalır (60 → 30 → 16), yine sığmazsa satırlar sondan kesilir ve
 * "Table truncated: N rows omitted" yazılır. Arama ikili: kurulum sayısı log n.
 */
export function ozetMarkdown(g: OzetGirdisi): string {
  const sinir = g.sinir ?? OZET_SINIRI;
  const maxIstem = Math.max(0, g.maxIstem ?? VARSAYILAN_ISTEM_SAYISI);
  const adlar = new Map(g.testler.map((test) => [test.id, test.name]));
  const dikkatSayisi = g.testler.filter(dikkatGerekenMi).length;

  const bas = [
    OZET_ISARETI,
    '## kobay test report',
    '',
    durumSatiri(g.testler, g.counts),
    '',
    ...sayiTablosu(g.counts),
    '',
  ].join('\n');
  const alt = [
    '---',
    `Generated by kobay ${hucreKacisi(g.surum)}. Screenshots and step evidence are not included here;`
      + ' they are in the HTML report artifact of this workflow run.',
  ].join('\n');

  const istemBloklari = g.fixPrompts.map((istem) => istemBlogu(
    `Fix with your coding agent — ${htmlKacisi(istem.id)} ${htmlKacisi(tekSatir(g.temizle(adlar.get(istem.id) ?? ''), AD_SINIRI))}`,
    istem.prompt,
  ));
  const hepsiBlogu = g.fixAllPrompt === undefined
    ? undefined
    : istemBlogu(`Fix all ${dikkatSayisi} tests that need attention with your coding agent`, g.fixAllPrompt);

  const kur = (tablo: string[], istemSayisi: number, hepsi: boolean, kesildi: boolean): string => {
    g.kurulumIzleyici?.();
    const parcalar = [bas, tablo.join('\n')];
    const secilen = istemBloklari.slice(0, istemSayisi);
    if (secilen.length > 0) parcalar.push(secilen.join('\n\n'));
    const kalan = istemBloklari.length - secilen.length;
    if (kalan > 0) parcalar.push(dahaFazlaSatiri(kalan));
    if (hepsi && hepsiBlogu !== undefined) parcalar.push(hepsiBlogu);
    if (kesildi) parcalar.push('_This summary was truncated to fit the size limit of a pull request comment._');
    parcalar.push(alt);
    return `${parcalar.join('\n\n')}\n`;
  };

  const tamTablo = testTablosu(g.testler, g.temizle);
  const istemSayisi = Math.min(maxIstem, istemBloklari.length);
  const ilk = kur(tamTablo, istemSayisi, true, false);
  if (ilk.length <= sinir) return ilk;

  /** `uzunluk(n)` n'de artan; sınıra sığan en büyük n (0..ust), yoksa -1. İkili arama: log n kurulum. */
  const sigan = (ust: number, uzunluk: (n: number) => number): number => {
    let alt = 0;
    let bulunan = -1;
    let tavan = ust;
    while (alt <= tavan) {
      const orta = Math.floor((alt + tavan) / 2);
      if (uzunluk(orta) <= sinir) {
        bulunan = orta;
        alt = orta + 1;
      } else {
        tavan = orta - 1;
      }
    }
    return bulunan;
  };

  // Önce hepsini düzelt istemi düşer, sonra sondan başlayarak tekil istemler.
  const istemler = sigan(istemSayisi, (n) => kur(tamTablo, n, false, true).length);
  if (istemler >= 0) return kur(tamTablo, istemler, false, true);

  // Tablo tek başına sınırı aşıyor: önce ad hücresi kısalır, yine sığmazsa satırlar
  // sondan kesilir ve kaç satırın atlandığı açıkça yazılır.
  for (const adSiniri of [60, 30, 16]) {
    const tablo = testTablosu(g.testler, g.temizle, adSiniri);
    const metin = kur(tablo, 0, false, true);
    if (metin.length <= sinir) return metin;
  }
  const kisa = testTablosu(g.testler, g.temizle, 16);
  const basliklar = kisa.slice(0, 2);
  const satirlar = kisa.slice(2);
  const kesik = (n: number): string => {
    const atlanan = satirlar.length - n;
    return kur([...basliklar, ...satirlar.slice(0, n), '',
      `Table truncated: ${atlanan} row${atlanan === 1 ? '' : 's'} omitted — see the report artifact.`], 0, false, true);
  };
  return kesik(Math.max(0, sigan(satirlar.length, (n) => kesik(n).length)));
}
