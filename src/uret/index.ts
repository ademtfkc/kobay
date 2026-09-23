// uret modülü — sözleşme: docs/2026-09-17-kobay-plan.md
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Beyin } from '../beyin/index.js';
import type { Harita, TestKaydi } from '../depo/index.js';
import { yazAtomik } from '../depo/index.js';
import { fixtureYenidenAktarimMetni } from '../kos/calisma-alani.js';
import { testSureciOrtami } from '../kos/ortam.js';
import { kullaniciIstemi, sistemIstemi } from './istem.js';
import { KodYanitiSemasi } from './sema.js';

export { kullaniciIstemi, sistemIstemi } from './istem.js';
export { KodYanitiSemasi } from './sema.js';

interface UretimAyari {
  projeKoku: string;
  kobayKoku: string;
  maxTur?: number;
  logDizini?: string;
}

interface KodDogrulamaSonucu {
  ok: boolean;
  hata?: string;
}

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');
const PLAYWRIGHT_LISTE_ARGUMANLARI = ['test', '--list', '--config'];

/** Eski sürümlerin geçici config'ine koyduğu, hiçbir yerde okunmayan reporter satırı. */
const ESKI_REPORTER_SATIRI = "  reporter: [['json', { outputFile: 'son-liste.json' }]],";

/**
 * `--list` yalnız çıkış koduna bakar; hiçbir yerde okunmayan bir rapor dosyası
 * üretmeye gerek yok. Eski sürüm burada `son-liste.json` yazdırıyordu: kimsenin
 * okumadığı, içinde geliştirme makinesinin mutlak yolları duran bayat bir dosya.
 *
 * `eskiReporter` yalnız göç denetimi içindir: eski şablonun **birebir** çıktısını
 * üretir, böylece "bu dosyayı kobay yazdı, kullanıcı dokunmadı" sorusu tek
 * kaynaktan yanıtlanır.
 */
function geciciPlaywrightConfig(eskiReporter = false): string {
  return [
    'export default {',
    "  testDir: 'tests',",
    ...(eskiReporter ? [ESKI_REPORTER_SATIRI] : []),
    '  use: { baseURL: process.env.KOBAY_BASE_URL },',
    '  timeout: 120000,',
    '  fullyParallel: false,',
    '  workers: 1,',
    '};',
    '',
  ].join('\n');
}

function alintiIcinKac(metin: string): string {
  return metin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function jsDizesiniOku(kod: string, baslangic: number): { deger: string; sonraki: number } | null {
  const tirnak = kod[baslangic];
  if (tirnak !== "'" && tirnak !== '"' && tirnak !== '`') return null;

  let deger = '';
  for (let i = baslangic + 1; i < kod.length; i += 1) {
    const karakter = kod[i];
    if (karakter === undefined) return null;
    if (karakter === tirnak) return { deger, sonraki: i + 1 };
    if (karakter !== '\\') {
      deger += karakter;
      continue;
    }
    const kacisli = kod[i + 1];
    if (kacisli === undefined) return null;
    i += 1;
    switch (kacisli) {
      case 'n': deger += '\n'; break;
      case 'r': deger += '\r'; break;
      case 't': deger += '\t'; break;
      case '\\': deger += '\\'; break;
      case "'": deger += "'"; break;
      case '"': deger += '"'; break;
      case '`': deger += '`'; break;
      default: deger += kacisli; break;
    }
  }
  return null;
}

function bosluklariNormallestir(metin: string): string {
  return metin.replace(/\s+/g, ' ').trim();
}

const YASAKLI_KOD_DESENLERI: Array<{ desen: RegExp; ad: string }> = [
  { desen: /\bimport\s*(?:\/\*[\s\S]*?\*\/\s*)?\(/, ad: 'dynamic import()' },
  { desen: /\brequire\b/, ad: 'require' },
  { desen: /\barguments\b/, ad: 'arguments (access to the module wrapper)' },
  { desen: /\bgetBuiltinModule\b/, ad: 'getBuiltinModule()' },
  { desen: /\bprocess\b/, ad: 'process access' },
  { desen: /\b(?:globalThis|global)\b/, ad: 'global object access' },
  { desen: /\bReflect\s*(?:\.|\?\.|\[)/, ad: 'indirect access through Reflect' },
  { desen: /\b(?:eval|Function)\b/, ad: 'eval/Function execution' },
  { desen: /\bconstructor\b/, ad: 'running code through constructor' },
];

/**
 * Yalnız serbest tanımlayıcı olarak yasak adlar. Özellik adı (`x.module`), nesne anahtarı
 * (`{ fs: 1 }`) ve kodun kendi `const`/`let` bağlamasıyla gölgelenmiş kullanım serbesttir.
 */
const SERBEST_YASAKLI_ADLAR = new Map<string, string>([
  ...['module', 'exports', '__dirname', '__filename'].map((ad) => [ad, 'Node module environment access'] as const),
  ...['child_process', 'fs', 'worker_threads', 'cluster', 'vm', 'repl', 'inspector']
    .map((ad) => [ad, 'Node system module access'] as const),
]);
const MODUL_BILDIRIMLERI = new Set(['import', 'export']);
const UNICODE_KACISI_DESENI = /\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]{1,6}\})/;

const REGEX_ONCESI_ANAHTARLAR = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const KONTROL_ANAHTARLARI = new Set(['if', 'while', 'for', 'with', 'catch', 'switch']);
/** Ardından gelen `{` kesinlikle deyim bloğu açan anahtar sözcükler. */
const BLOK_ANAHTARLARI = new Set(['else', 'try', 'finally', 'do']);

/** `/` işaretinin önceki belirtece göre anlamı: regex başlatır, bölmedir ya da güvenle kestirilemez. */
type BoluAnlami = 'regex' | 'bolme' | 'belirsiz';

/** `{` ... `}` türü: deyim bloğu, ok fonksiyonu gövdesi ya da ayırt edilemeyen (nesne olabilir). */
type SusluTuru = 'blok' | 'ok' | 'belirsiz';

interface Tanimlayici {
  ad: string;
  konum: number;
  /** `x.ad` / `x?.ad` biçiminde özellik adı. */
  ozellik: boolean;
  /** `{ ad: …` ya da `, ad: …` biçiminde nesne anahtarı. */
  anahtar: boolean;
  /** `const ad` / `let ad` bağlaması. */
  bildirim: boolean;
  /** Belirtecin içinde durduğu açık süslü kapsamların kimlikleri (dıştan içe). */
  kapsamlar: number[];
}

interface CalistirilabilirKod {
  kod: string;
  belirsiz: boolean;
  tanimlayicilar: Tanimlayici[];
  bildirimler: Map<number, Set<string>>;
}

/**
 * Yorumları, dize ve regex literal metinlerini görünmez kılar; template ${...} ifadelerini
 * çalıştırılabilir kod olarak korur. Regex ile bölmeyi ayıramadığı bir `/` görürse
 * `belirsiz: true` döner; çağıran bunu ret sebebi sayar (kaçış gizlenmesin diye).
 * Ayrıca tanımlayıcıları konum/bağlam bilgisiyle ve `const`/`let` bağlamalarını kapsamıyla toplar.
 */
function calistirilabilirKod(kod: string): CalistirilabilirKod {
  const sonuc = Array.from({ length: kod.length }, () => ' ');
  let belirsiz = false;
  const tanimlayicilar: Tanimlayici[] = [];
  const bildirimler = new Map<number, Set<string>>();
  // Açık süslü kapsamlar; 0 kök kapsamdır. Her kapsamda o kapsam içinde açık parantez sayısı tutulur.
  const kapsamlar: Array<{ kimlik: number; parantez: number }> = [{ kimlik: 0, parantez: 0 }];
  let kapsamSayaci = 0;

  function dizeyiAtla(baslangic: number, tirnak: "'" | '"'): number {
    let i = baslangic + 1;
    while (i < kod.length) {
      if (kod[i] === '\\') i += 2;
      else if (kod[i] === tirnak) return i + 1;
      else i += 1;
    }
    return i;
  }

  function regexiAtla(baslangic: number): number {
    let i = baslangic + 1;
    let sinifta = false;
    while (i < kod.length && kod[i] !== '\n') {
      const karakter = kod[i];
      if (karakter === '\\') {
        i += 2;
      } else if (karakter === '[') {
        sinifta = true;
        i += 1;
      } else if (karakter === ']') {
        sinifta = false;
        i += 1;
      } else if (karakter === '/' && !sinifta) {
        i += 1;
        while (i < kod.length && /[a-z]/i.test(kod[i] ?? '')) i += 1;
        return i;
      } else {
        i += 1;
      }
    }
    // Satır sonunda kapanmayan regex geçerli değildir; ne olduğunu kestiremeyiz.
    belirsiz = true;
    return i;
  }

  function sablonuTara(baslangic: number): number {
    let i = baslangic + 1;
    while (i < kod.length) {
      if (kod[i] === '\\') {
        i += 2;
      } else if (kod[i] === '`') {
        return i + 1;
      } else if (kod[i] === '$' && kod[i + 1] === '{') {
        sonuc[i] = '$';
        sonuc[i + 1] = '{';
        i = koduTara(i + 2, true);
      } else {
        i += 1;
      }
    }
    return i;
  }

  /** `baslangic`tan sonraki ilk boşluk olmayan karakter `:` (ama `::` değil) mi? */
  function ardindanIkiNokta(baslangic: number): boolean {
    let k = baslangic;
    while (k < kod.length && /\s/.test(kod[k] ?? '')) k += 1;
    return kod[k] === ':' && kod[k + 1] !== ':';
  }

  function koduTara(baslangic: number, sablonIfadesi: boolean): number {
    let i = baslangic;
    let bolu: BoluAnlami = 'regex';
    let sonKelime = '';
    let noktadanSonra = false;
    // Son anlamlı belirteç: noktalama karakteri, '=>' ya da kelime/dize/regex için 'deger'.
    // Şablon ifadesi bir ifade bağlamında başlar; kök kod deyim bağlamında.
    let sonIsaret = sablonIfadesi ? '(' : ';';
    let kontroldenCikis = false;
    let bildirimAnahtari = false;
    const parantezler: boolean[] = [];
    const susluler: SusluTuru[] = [];
    while (i < kod.length) {
      const karakter = kod[i] ?? ' ';
      const sonraki = kod[i + 1];
      if (karakter === "'" || karakter === '"') {
        i = dizeyiAtla(i, karakter);
        bolu = 'bolme';
        sonKelime = '';
        noktadanSonra = false;
        sonIsaret = 'deger';
        kontroldenCikis = false;
        bildirimAnahtari = false;
      } else if (karakter === '`') {
        i = sablonuTara(i);
        bolu = 'bolme';
        sonKelime = '';
        noktadanSonra = false;
        sonIsaret = 'deger';
        kontroldenCikis = false;
        bildirimAnahtari = false;
      } else if (karakter === '/' && sonraki === '/') {
        i += 2;
        while (i < kod.length && kod[i] !== '\n') i += 1;
      } else if (karakter === '/' && sonraki === '*') {
        i += 2;
        while (i < kod.length && !(kod[i] === '*' && kod[i + 1] === '/')) i += 1;
        i = Math.min(kod.length, i + 2);
      } else if (karakter === '/' && bolu !== 'bolme') {
        if (bolu === 'belirsiz') belirsiz = true;
        i = regexiAtla(i);
        bolu = 'bolme';
        sonKelime = '';
        noktadanSonra = false;
        sonIsaret = 'deger';
        kontroldenCikis = false;
        bildirimAnahtari = false;
      } else if (sablonIfadesi && karakter === '}' && susluler.length === 0) {
        sonuc[i] = karakter;
        return i + 1;
      } else if (/\s/.test(karakter)) {
        sonuc[i] = karakter;
        i += 1;
      } else if (/[\w$\\]/.test(karakter) || karakter.charCodeAt(0) > 0x7f) {
        let j = i;
        while (j < kod.length && (/[\w$\\]/.test(kod[j] ?? '') || (kod[j] ?? '').charCodeAt(0) > 0x7f)) {
          sonuc[j] = kod[j] ?? ' ';
          j += 1;
        }
        const kelime = kod.slice(i, j);
        const anahtar = !noktadanSonra;
        const kapsam = kapsamlar[kapsamlar.length - 1];
        const bildirim = anahtar && bildirimAnahtari && kapsam !== undefined && kapsam.parantez === 0;
        if (bildirim && kapsam !== undefined) {
          const adlar = bildirimler.get(kapsam.kimlik) ?? new Set<string>();
          adlar.add(kelime);
          bildirimler.set(kapsam.kimlik, adlar);
        }
        tanimlayicilar.push({
          ad: kelime,
          konum: i,
          ozellik: noktadanSonra,
          anahtar: !noktadanSonra && (sonIsaret === '{' || sonIsaret === ',') && ardindanIkiNokta(j),
          bildirim,
          kapsamlar: kapsamlar.map((k) => k.kimlik),
        });
        bolu = anahtar && REGEX_ONCESI_ANAHTARLAR.has(kelime) ? 'regex' : 'bolme';
        // TypeScript `declare const x` çalışma anında bağlama üretmez; gölgeleme sayılmaz.
        bildirimAnahtari = anahtar && (kelime === 'const' || kelime === 'let') && sonKelime !== 'declare';
        // `for await (...)` koşul parantezi de kontrol parantezidir.
        sonKelime = anahtar ? (kelime === 'await' && sonKelime === 'for' ? 'for' : kelime) : '';
        noktadanSonra = false;
        sonIsaret = 'deger';
        kontroldenCikis = false;
        i = j;
      } else if ((karakter === '+' || karakter === '-') && sonraki === karakter) {
        sonuc[i] = karakter;
        sonuc[i + 1] = karakter;
        // Önek mi sonek mi, bir sonraki `/` için güvenle bilinemez.
        bolu = bolu === 'bolme' ? 'belirsiz' : 'regex';
        sonKelime = '';
        noktadanSonra = false;
        sonIsaret = karakter;
        kontroldenCikis = false;
        bildirimAnahtari = false;
        i += 2;
      } else {
        sonuc[i] = karakter;
        let yeniKontroldenCikis = false;
        let yeniIsaret = karakter;
        const kapsam = kapsamlar[kapsamlar.length - 1];
        if (karakter === '(') {
          parantezler.push(KONTROL_ANAHTARLARI.has(sonKelime));
          if (kapsam !== undefined) kapsam.parantez += 1;
          bolu = 'regex';
        } else if (karakter === ')') {
          yeniKontroldenCikis = parantezler.pop() === true;
          if (kapsam !== undefined && kapsam.parantez > 0) kapsam.parantez -= 1;
          bolu = yeniKontroldenCikis ? 'regex' : 'bolme';
        } else if (karakter === ']') {
          bolu = 'bolme';
        } else if (karakter === '{') {
          let tur: SusluTuru = 'belirsiz';
          if (sonIsaret === '=>') tur = 'ok';
          else if (kontroldenCikis || BLOK_ANAHTARLARI.has(sonKelime)) tur = 'blok';
          else if (sonIsaret === ';' || sonIsaret === '{' || sonIsaret === '}') tur = 'blok';
          susluler.push(tur);
          kapsamSayaci += 1;
          kapsamlar.push({ kimlik: kapsamSayaci, parantez: 0 });
          bolu = 'regex';
        } else if (karakter === '}') {
          const tur = susluler.pop();
          if (kapsamlar.length > 1) kapsamlar.pop();
          // Deyim bloğundan sonra yeni deyim başlar: `/` regex'tir. Ok gövdesinin ardından `/`
          // ya söz dizimi hatasıdır ya da satır sonu ile yeni deyimdir. Nesne olabilecekte belirsiz.
          bolu = tur === 'blok' || tur === 'ok' ? 'regex' : 'belirsiz';
        } else if (karakter === '>' && sonIsaret === '=' && kod[i - 1] === '=') {
          yeniIsaret = '=>';
          bolu = 'regex';
        } else {
          bolu = 'regex';
        }
        // `...x` yayma/kalan sözdizimidir, özellik erişimi değildir.
        noktadanSonra = karakter === '.' && kod[i - 1] !== '.' && sonraki !== '.';
        sonKelime = '';
        sonIsaret = yeniIsaret;
        kontroldenCikis = yeniKontroldenCikis;
        bildirimAnahtari = false;
        i += 1;
      }
    }
    return i;
  }

  koduTara(0, false);
  return { kod: sonuc.join(''), belirsiz, tanimlayicilar, bildirimler };
}

function hizKesiciMesaji(sebep: string): string {
  return `Code rejected by the speed bump (this is not a security boundary): ${sebep}`;
}

/** `atla`dan önceki kısım (izinli fixture importu) modül bildirimi denetiminden muaftır. */
function yasakliKodHatasi(kod: string, atla: number): string | null {
  const { kod: calistirilabilir, belirsiz, tanimlayicilar, bildirimler } = calistirilabilirKod(kod);
  if (belirsiz) {
    return hizKesiciMesaji('could not tell whether `/` starts a regex or is a division; assign the regex to a variable, or put the division in parentheses.');
  }
  if (UNICODE_KACISI_DESENI.test(calistirilabilir)) {
    return hizKesiciMesaji('Unicode escapes are not allowed in executable code; use only the Playwright page/test/expect APIs.');
  }
  const yasak = YASAKLI_KOD_DESENLERI.find(({ desen }) => desen.test(calistirilabilir));
  if (yasak !== undefined) {
    return hizKesiciMesaji(`${yasak.ad} is not allowed; use only the Playwright page/test/expect APIs.`);
  }
  for (const t of tanimlayicilar) {
    if (t.ozellik || t.anahtar) continue;
    if (MODUL_BILDIRIMLERI.has(t.ad) && t.konum >= atla) {
      return hizKesiciMesaji(`no ${t.ad} declaration is allowed apart from the fixture import; only the permitted import on the first line.`);
    }
    const ad = SERBEST_YASAKLI_ADLAR.get(t.ad);
    if (ad === undefined || t.bildirim) continue;
    const golgeli = t.kapsamlar.some((kapsam) => bildirimler.get(kapsam)?.has(t.ad) === true);
    if (!golgeli) return hizKesiciMesaji(`${ad} is not allowed; use only the Playwright page/test/expect APIs.`);
  }
  return null;
}

function adimEslesmeleriniBul(kod: string): Array<{ sira: string; baslik: string }> {
  const sonuc: Array<{ sira: string; baslik: string }> = [];
  const cagrilar = /await\s+test\.step\(\s*/g;
  let cagri: RegExpExecArray | null;
  while ((cagri = cagrilar.exec(kod)) !== null) {
    const dizeBaslangici = cagri.index + cagri[0].length;
    const dize = jsDizesiniOku(kod, dizeBaslangici);
    if (dize === null) continue;
    const devam = kod.slice(dize.sonraki);
    if (!/^\s*,\s*async\s*\(\s*\)\s*=>/.test(devam)) continue;
    const baslik = /^(\d+):([\s\S]*)$/.exec(dize.deger);
    if (baslik !== null && baslik[1] !== undefined && baslik[2] !== undefined) {
      sonuc.push({ sira: baslik[1], baslik: baslik[2] });
    }
  }
  return sonuc;
}

const IZINLI_IMPORT = "import { test, expect } from './_fixture';";

export function statikHata(kod: string, test: TestKaydi, harita: Harita): string | null {
  const importSatirlari = kod.match(/^\s*import\b.*$/gm) ?? [];
  if (importSatirlari.length !== 1 || importSatirlari[0] !== IZINLI_IMPORT) {
    return `The code must start with \`${IZINLI_IMPORT}\`; no other import is allowed.`;
  }
  if (!kod.startsWith(IZINLI_IMPORT)) {
    return 'The code must start with the fixture import.';
  }

  const guvenlikHatasi = yasakliKodHatasi(kod, IZINLI_IMPORT.length);
  if (guvenlikHatasi !== null) return guvenlikHatasi;

  const testDeseni = new RegExp(
    `^test\\(\\s*(['"])${alintiIcinKac(test.name)}\\1\\s*,\\s*async\\s*\\(\\s*\\{\\s*page\\s*\\}\\s*\\)\\s*=>`,
    'm',
  );
  if (!testDeseni.test(kod)) {
    return `The single test must be written as test(${JSON.stringify(test.name)}, async ({ page }) => { … }).`;
  }
  // `/re/.test(x)` gibi özellik çağrıları test tanımı değildir; dize/yorum içerikleri de sayılmaz.
  const testCagrilari = calistirilabilirKod(kod).kod.match(/(?<!\.\s*)\btest\s*\(/g) ?? [];
  if (testCagrilari.length !== 1) return 'The code must contain exactly one test.';

  const adimEslesmeleri = adimEslesmeleriniBul(kod);
  if (adimEslesmeleri.length !== test.planSteps.length) {
    return `The code must contain ${test.planSteps.length} await test.step calls.`;
  }
  for (const [sira, planAdimi] of test.planSteps.entries()) {
    const eslesme = adimEslesmeleri[sira];
    if (eslesme === undefined || eslesme.sira !== String(sira) || bosluklariNormallestir(eslesme.baslik) !== bosluklariNormallestir(planAdimi.description)) {
      return `Step ${sira} must carry exactly the title '${sira}: ${planAdimi.description}'.`;
    }
  }

  if (/\bpage\.waitForTimeout\s*\(/.test(kod)) return 'page.waitForTimeout is not allowed.';

  const haritaYollari = new Set(harita.pages.map((sayfa) => new URL(sayfa.url).pathname));
  const gotoCagrilari = [...kod.matchAll(/\bpage\.goto\(\s*(['"])(.*?)\1/g)];
  const tumGotoCagrilari = kod.match(/\bpage\.goto\s*\(/g) ?? [];
  if (gotoCagrilari.length !== tumGotoCagrilari.length) {
    return 'page.goto may only be called with a literal URL string from the map.';
  }
  for (const eslesme of gotoCagrilari) {
    const hedef = eslesme[2];
    if (hedef === undefined) return 'The page.goto target could not be read.';
    let url: URL;
    try {
      url = new URL(hedef, harita.baseUrl);
    } catch {
      return `page.goto must receive a valid URL: ${hedef}`;
    }
    if (url.origin !== new URL(harita.baseUrl).origin || !haritaYollari.has(url.pathname)) {
      return `page.goto navigates to a path that is not in the map: ${hedef}`;
    }
  }
  return null;
}

/**
 * Geçici config yalnız yoksa yazılır: koşunun yazdığı kalıcı config (raporu,
 * trace'i, `outputDir`'i olan) üzerine yazılmamalı. Tek istisna eski kobay
 * sürümlerinin bıraktığı şablondur; o olduğu gibi duruyorsa yenisiyle
 * değiştirilir, yoksa proje her `--list`'te bayat `son-liste.json` dosyasını
 * yeniden üretirdi.
 *
 * Göç ölçütü içerik araması değil **birebir eşitliktir**: kullanıcı ya da
 * koşu config'i düzenlediyse dosya kobay'ın değildir, üzerine yazmak elle
 * eklenmiş ayarı (proje `use` seçenekleri, `projects`, `webServer`…) silerdi.
 * O durumda dokunulmaz, tek satır uyarı basılır; reporter satırını kaldırmak
 * kullanıcının kararıdır.
 */
async function geciciConfigSagla(configYolu: string): Promise<void> {
  let mevcut: string | null = null;
  try {
    mevcut = await readFile(configYolu, 'utf8');
  } catch (hata: unknown) {
    if (!(typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT')) throw hata;
  }
  if (mevcut === null || mevcut === geciciPlaywrightConfig(true)) {
    await yazAtomik(configYolu, geciciPlaywrightConfig());
    return;
  }
  if (mevcut.includes(ESKI_REPORTER_SATIRI.trim())) {
    process.stderr.write(
      `[kobay] Warning: ${configYolu} was edited by hand and still carries the unused \`son-liste.json\``
      + ' reporter; the file was left untouched, remove the reporter line by hand.\n',
    );
  }
}

export async function calismaAlaniHazirla(kobayKoku: string): Promise<{ configYolu: string; fixtureYolu: string }> {
  const configYolu = join(kobayKoku, 'playwright.config.ts');
  const fixtureYolu = join(kobayKoku, 'tests', '_fixture.ts');
  await Promise.all([
    geciciConfigSagla(configYolu),
    fixtureYenidenAktarimMetni().then(async (metin) => yazAtomik(fixtureYolu, metin)),
  ]);
  return { configYolu, fixtureYolu };
}

async function playwrightListele(specYolu: string, configYolu: string, cwd: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((coz) => {
    const surec = spawn(process.execPath, [PLAYWRIGHT_CLI, ...PLAYWRIGHT_LISTE_ARGUMANLARI, configYolu, specYolu], {
      cwd,
      // `--list` sırasında da üretilen kodun modül düzeyi çalışır; sırlar devredilmez.
      env: testSureciOrtami(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    surec.stderr.setEncoding('utf8');
    surec.stderr.on('data', (parca: string) => { stderr += parca; });
    surec.once('error', (hata: NodeJS.ErrnoException) => {
      coz({ ok: false, stderr: hata.message });
    });
    surec.once('close', (kod) => {
      coz({ ok: kod === 0, stderr });
    });
  });
}

/** Playwright'ın üretilen spec'i ayrıştırabildiğini kontrol eder. */
export async function kodDogrula(specYolu: string, kobayKoku: string): Promise<KodDogrulamaSonucu> {
  const { configYolu } = await calismaAlaniHazirla(kobayKoku);

  const sonuc = await playwrightListele(specYolu, configYolu, kobayKoku);
  if (sonuc.ok) return { ok: true };
  return { ok: false, hata: sonuc.stderr.slice(0, 2000) || 'Playwright parsing failed.' };
}

/** Beyinden Playwright kodu ister, sözleşme ve Playwright ayrıştırmasıyla doğrular. */
export async function kodUret(
  beyin: Beyin,
  test: TestKaydi,
  harita: Harita,
  s: UretimAyari,
): Promise<{ kod: string; denemeler: number }> {
  const maxTur = s.maxTur ?? 2;
  if (!Number.isInteger(maxTur) || maxTur < 1) throw new Error('maxTur must be at least 1.');

  const specYolu = join(s.kobayKoku, 'tests', `${test.id}.spec.ts`);
  let oncekiHata: string | undefined;
  for (let deneme = 1; deneme <= maxTur; deneme += 1) {
    const yanit = await beyin.sor<{ code: string; explanation?: string }>({
      gorev: `uret-${test.id}`,
      sistem: sistemIstemi(),
      kullanici: kullaniciIstemi(test, harita, oncekiHata),
      sema: KodYanitiSemasi,
      ...(s.logDizini === undefined ? {} : { logDizini: s.logDizini }),
    });
    const kod = yanit.json.code;
    const sozlesmeHatasi = statikHata(kod, test, harita);
    if (sozlesmeHatasi !== null) {
      oncekiHata = sozlesmeHatasi;
      continue;
    }

    await yazAtomik(specYolu, kod);
    const dogrulama = await kodDogrula(specYolu, s.kobayKoku);
    if (dogrulama.ok) return { kod, denemeler: deneme };
    oncekiHata = dogrulama.hata ?? 'Playwright could not parse the code.';
  }
  throw new Error(`Code generation failed: ${oncekiHata ?? 'Unknown validation error.'}`);
}
