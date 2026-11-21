/**
 * URL sorgu değerlerini ve fragment'i metinden çıkarır (spec 2026-11-13 A). OAuth `code`/`state`,
 * dönen `sid`, imzalı bağlantının `signature`'ı ya da `id` gibi her değer sır olabilir: genel bir
 * "zararsız anahtar" listesi yok, anahtar adından bağımsız HER değer `[redacted]` olur. Anahtar
 * adları, boş değerler ve sıra korunur: `?code=abc&state=&x=1#t=2` → `?code=[redacted]&state=&x=[redacted]#t=[redacted]`.
 *
 * Tanınan biçimler:
 * - Mutlak adres (`https://…`, `ws://…`, kodlanmış `https%3A%2F%2F…`): `?`'den sonraki her parça ve
 *   fragment maskelenir (anahtarsız parça `?abc` de değer sayılır).
 * - Göreli adres (`/cb?code=…`, `cb?code=…`): `?`'den hemen sonra `ad=` geliyorsa sorgu sayılır;
 *   fragment yalnız `#ad=…` biçimindeyse maskelenir (`div#main` seçicisi, `#section` çapası kalır).
 * - Ayraçlar düz ve kodlanmış hâlleriyle: `?`/`%3F`, `=`/`%3D`, `&`/`&amp;`/`%26`, `#`/`%23`.
 *   İç içe yönlendirme (`?next=https%3A%2F%2Fx%2Fcb%3Fcode%3D…`) dıştaki değerle birlikte gider.
 *
 * Değer boşlukta, tırnakta, `<>`, ters eğik çizgi (JSON kaçışı `\"`, `\n`) ve ters tırnakta biter;
 * sondaki noktalama (`.,;:!?)]}`) cümleye aittir, maskelenmeden kalır. Zaten `[redacted]` olan
 * değer olduğu gibi kalır: işlev iki kez uygulandığında sonuç değişmez.
 */

const MASKE = '[redacted]';
/**
 * Yalnız testler: tarama döngülerinin attığı adım sayısı (karmaşıklık gerilemesi duvar saatiyle değil
 * sayaçla ölçülür; CI'da süre testleri kararsız). Üretimde okunmaz.
 */
export const urlMaskeSayaci = { adim: 0 };
/** Adresin bittiği karakterler. */
const BITIS = /[\s"'<>\\`]/;
const SONDAKI_NOKTALAMA_KARAKTERI = /[.,;:!?)\]}]/;
/** Kırpılmış gövde bir ayraçla bitiyor mu (son üç karakter yeter: `%3D`). */
const SON_AYRAC = /(?:[=&#]|%3D|%26|%23)$/i;
/** Göreli sorgu ilk parçası `ad=` (ya da `ad%3D`) olmalı; `x?.y` gibi kod parçaları sorgu sayılmaz. */
const GORELI_ILK_PARCA = /[A-Za-z0-9_\-[\]~+%][A-Za-z0-9_\-[\]~+%.]*(?:=|%3D)/iy;
/** Mutlak adresin kullanıcı bilgisi (`http://kullanıcı:parola@host`). */
// Açgözlü: host'tan önceki SON `@`'ye kadar (`u:p@ss@host`); `/?#` ve bitiş karakteri authority'yi bitirir.
const KULLANICI_BILGISI = /\b([a-z][a-z0-9+.-]*:\/\/)[^/?#\s"'<>\\`]+@/gi;
const MUTLAK_SEMA_TUMU = /(?:[a-z][a-z0-9+.-]*:\/\/|%3A%2F%2F)/gi;

type Ayrac = { metin: string; tur: 'ayir' | 'esit' | 'fragment' };

/** `i` konumunda bir ayraç varsa onu döndürür. */
function ayracOku(metin: string, i: number): Ayrac | null {
  const k = metin[i];
  if (k === '&') return { metin: metin.startsWith('&amp;', i) ? '&amp;' : '&', tur: 'ayir' };
  if (k === '=') return { metin: '=', tur: 'esit' };
  if (k === '#') return { metin: '#', tur: 'fragment' };
  if (k === '%') {
    const kod = metin.slice(i, i + 3).toUpperCase();
    if (kod === '%26') return { metin: metin.slice(i, i + 3), tur: 'ayir' };
    if (kod === '%3D') return { metin: metin.slice(i, i + 3), tur: 'esit' };
    if (kod === '%23') return { metin: metin.slice(i, i + 3), tur: 'fragment' };
  }
  return null;
}

/**
 * Bölüt (iki adres bitiş karakteri arasındaki parça) sınırları, tek geçişte (doğrusal; kör kabul P2-1:
 * aday başına geri/ileri tarama küçültülmüş CSS'te karesel çalışıyordu):
 * - `bas[i]`: `i`'nin bölütünün başı, `son[i]`: bölütün sonu (ilk bitiş karakteri ya da metin sonu),
 * - `kirpik[j]`: bölüt sonu `j` için sondaki noktalama kırpılmış son,
 * - `semaSonu[b]`: başı `b` olan bölütteki ilk şema eşleşmesinin (`scheme://`, `%3A%2F%2F`) bittiği yer.
 */
interface Bolutler {
  bas: Int32Array;
  son: Int32Array;
  kirpik: Int32Array;
  semaSonu: Map<number, number>;
}

function bolutleriHesapla(metin: string): Bolutler {
  const n = metin.length;
  const bas = new Int32Array(n + 1);
  const son = new Int32Array(n + 1);
  const kirpik = new Int32Array(n + 1);
  let b = 0;
  for (let i = 0; i <= n; i += 1) {
    urlMaskeSayaci.adim += 1;
    if (i > 0 && BITIS.test(metin[i - 1] ?? '')) b = i;
    bas[i] = b;
  }
  let e = n;
  for (let i = n; i >= 0; i -= 1) {
    urlMaskeSayaci.adim += 1;
    if (i < n && BITIS.test(metin[i] ?? '')) e = i;
    son[i] = e;
  }
  let k = 0;
  for (let j = 0; j <= n; j += 1) {
    urlMaskeSayaci.adim += 1;
    // `kirpik[j]`: `j`'den geriye noktalama olmayan ilk konum + 1 (bölüt başında durur).
    k = j > 0 && SONDAKI_NOKTALAMA_KARAKTERI.test(metin[j - 1] ?? '') && bas[j] !== j ? kirpik[j - 1] ?? 0 : j;
    kirpik[j] = Math.max(k, bas[j] ?? 0);
  }
  const semaSonu = new Map<number, number>();
  for (const eslesme of metin.matchAll(MUTLAK_SEMA_TUMU)) {
    urlMaskeSayaci.adim += 1;
    const basi = bas[eslesme.index] ?? 0;
    if (!semaSonu.has(basi)) semaSonu.set(basi, eslesme.index + eslesme[0].length);
  }
  return { bas, son, kirpik, semaSonu };
}

/** `i`'den başlayan sorgu gövdesinin bittiği yer: bölüt sonu, sondaki noktalama hariç. */
function govdeSonu(metin: string, i: number, b: Bolutler): number {
  const j = b.son[i] ?? metin.length;
  const kirpik = Math.max(b.kirpik[j] ?? j, i);
  if (kirpik === j) return j;
  // Kırpma bir değeri bütünüyle yiyorsa (`?token=!!!!`, `#!!!!`) noktalama değerin kendisidir.
  if (kirpik === i || SON_AYRAC.test(metin.slice(Math.max(i, kirpik - 3), kirpik))) return j;
  // Kırpma bir maskenin kapanışını (`[redacted]` → `[redacted`) yediyse geri verilir.
  if (metin[kirpik] === ']' && metin.startsWith(MASKE, kirpik + 1 - MASKE.length) && kirpik + 1 - MASKE.length >= i) return kirpik + 1;
  return kirpik;
}

/** Boş değer boş kalır, geri kalan her değer (zaten maskeli olan dahil) `[redacted]` olur. */
function degerMaskesi(deger: string): string {
  return deger === '' ? '' : MASKE;
}

/**
 * `ad=değer` dizisini maskeler (`=` taşımayan parça bütünüyle değer sayılır); fragment ayracına
 * gelince durur ve konumunu döndürür.
 */
function parcalariMaskele(metin: string, bas: number, son: number): { cikti: string; konum: number } {
  let cikti = '';
  let i = bas;
  let parca = '';
  let esitGorulDu = false;
  const parcaBitir = (): void => {
    cikti += degerMaskesi(parca);
    parca = '';
  };
  while (i < son) {
    urlMaskeSayaci.adim += 1;
    const ayrac = ayracOku(metin, i);
    if (ayrac === null) {
      parca += metin[i];
      i += 1;
      continue;
    }
    if (ayrac.tur === 'esit' && !esitGorulDu) {
      // Anahtar adı korunur.
      cikti += parca + ayrac.metin;
      parca = '';
      esitGorulDu = true;
    } else if (ayrac.tur === 'esit') {
      parca += ayrac.metin;
    } else if (ayrac.tur === 'ayir') {
      parcaBitir();
      cikti += ayrac.metin;
      esitGorulDu = false;
    } else {
      parcaBitir();
      return { cikti, konum: i };
    }
    i += ayrac.metin.length;
  }
  parcaBitir();
  return { cikti, konum: son };
}

/** Fragment gövdesi: `ad=` biçimindeyse parça parça, değilse bütünüyle maskelenir. */
function fragmentMaskele(govde: string): string {
  if (govde === '' || govde === MASKE) return govde;
  if (/=|%3D/i.test(govde)) return parcalariMaskele(govde, 0, govde.length).cikti;
  return MASKE;
}

/** `i` konumundaki ayracın ait olduğu adres parçası mutlak mı (bölütte `i`'den önce şema var mı)? */
function mutlakMi(i: number, b: Bolutler): boolean {
  const semaSonu = b.semaSonu.get(b.bas[i] ?? 0);
  return semaSonu !== undefined && semaSonu <= i;
}

/** Ayraçtan önce adres karakteri var mı (`a ? b` ya da satır başı sorgu değil). */
function adrestenSonraMi(metin: string, i: number): boolean {
  const onceki = metin[i - 1];
  return onceki !== undefined && !BITIS.test(onceki);
}

/**
 * Metindeki her URL'nin sorgu değerlerini, fragment'ini ve mutlak adresin kullanıcı bilgisini
 * (`http://[redacted]@host`) `[redacted]` yapar (bkz. dosya başı).
 * Adres içermeyen metin aynen döner.
 */
export function urlSorgulariniGizle(girdi: string): string {
  // Mutlak adresin kullanıcı bilgisi de gider (network.json/console.json yalnız bu yardımcıdan geçer).
  const metin = girdi.includes('@') ? girdi.replace(KULLANICI_BILGISI, '$1[redacted]@') : girdi;
  if (!/[?#%]/.test(metin)) return metin;
  const bolutler = bolutleriHesapla(metin);
  let cikti = '';
  let i = 0;
  const adaylar = /\?|%3F|#|%23/gi;
  while (i < metin.length) {
    adaylar.lastIndex = i;
    const eslesme = adaylar.exec(metin);
    if (eslesme === null) break;
    urlMaskeSayaci.adim += 1;
    const konum = eslesme.index;
    const ayrac = eslesme[0];
    const sonrasi = konum + ayrac.length;
    const adresten = adrestenSonraMi(metin, konum);
    const mutlak = adresten && mutlakMi(konum, bolutler);
    const son = govdeSonu(metin, sonrasi, bolutler);
    // Göreli sorgu/fragment: hemen ardından `ad=` (yapışkan desen; gövdenin ötesine taşamaz, `=` noktalama değil).
    GORELI_ILK_PARCA.lastIndex = sonrasi;
    const goreli = adresten && son > sonrasi && GORELI_ILK_PARCA.test(metin);
    const fragmentMi = ayrac === '#' || ayrac.toUpperCase() === '%23';
    if (!(mutlak || goreli) || son === sonrasi) {
      cikti += metin.slice(i, sonrasi);
      i = sonrasi;
      continue;
    }
    cikti += metin.slice(i, sonrasi);
    if (fragmentMi) {
      cikti += fragmentMaskele(metin.slice(sonrasi, son));
      i = son;
      continue;
    }
    const sorgu = parcalariMaskele(metin, sonrasi, son);
    cikti += sorgu.cikti;
    if (sorgu.konum < son) {
      const fragmentAyraci = ayracOku(metin, sorgu.konum);
      const fragmentBasi = sorgu.konum + (fragmentAyraci?.metin.length ?? 1);
      cikti += metin.slice(sorgu.konum, fragmentBasi) + fragmentMaskele(metin.slice(fragmentBasi, son));
    }
    i = son;
  }
  return cikti + metin.slice(i);
}

/** JSON benzeri değerin bütün dizelerini (anahtarlar dahil) `urlSorgulariniGizle`den geçirir. */
export function degerdekiUrlSorgulariniGizle<T>(deger: T): T {
  const gez = (d: unknown): unknown => {
    if (typeof d === 'string') return urlSorgulariniGizle(d);
    if (Array.isArray(d)) return d.map(gez);
    if (typeof d === 'object' && d !== null) {
      return Object.fromEntries(Object.entries(d).map(([ad, alt]) => [urlSorgulariniGizle(ad), gez(alt)]));
    }
    return d;
  };
  return gez(deger) as T;
}
