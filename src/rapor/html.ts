import { gizliDegerleriMaskele } from '../beyin/ortak.js';
import { metindekiKimligiGizle } from '../depo/adres.js';
import type { FailureKind, Oncelik, Verdict } from '../depo/index.js';
import { dikkatGerekenMi, duzeltmeIstemi, hepsiniDuzeltIstemi, type IstemBaglami } from './istem.js';

/**
 * HTML koşu raporunun şablonu. Güvenlik sözleşmesi (spec §6):
 * - Şablona giren HER dinamik değer `html` etiketinden geçer; etiket değeri önce
 *   `gizliDegerleriMaskele`, sonra `htmlKacis` ile işler. Ham dize birleştirme
 *   yolu yoktur: işlenmiş parça yalnız `GuvenliHtml` olarak taşınır ve onu
 *   yalnız `html` etiketi üretir.
 * - Sayfada betik, olay özniteliği, iframe/object/embed yok; CSP her şeyi kapatır,
 *   yalnız aynı klasördeki görüntülere ve satır içi stile izin verir.
 */

/** `html` etiketinin ürettiği, artık kaçışlanmış HTML parçası. */
export class GuvenliHtml {
  readonly #metin: string;

  constructor(metin: string, anahtar: symbol) {
    if (anahtar !== URETICI) throw new Error('GuvenliHtml is only created by the html tag');
    this.#metin = metin;
  }

  toString(): string {
    return this.#metin;
  }
}

const URETICI = Symbol('html');

const KACIS_TABLOSU: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Raporun TEK HTML kaçış yardımcısı: `& < > " '` karakterlerini varlığa çevirir. */
export function htmlKacis(metin: string): string {
  return metin.replace(/[&<>"']/g, (karakter) => KACIS_TABLOSU[karakter] ?? karakter);
}

export interface YerelKok {
  yol: string;
  yerTutucu: string;
}

function regexKacis(metin: string): string {
  return metin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Harf duyarsız dosya sistemi varsayılan olan platformlar (macOS APFS/HFS+, Windows NTFS). */
const HARF_DUYARSIZ = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Metindeki yerel kökleri (proje kökü, ev dizini) kararlı yer tutucularla
 * değiştirir: `/Users/alice/app/x.ts` → `[project]/x.ts`. Kökteki her ayraç
 * `/` ya da `\` dizisiyle eşleşir: düz Windows yolu, JSON-kaçışlı yol
 * (`C:\\Users\\…`) ve karışık ayraç (`C:/Users/alice\proj`) yakalanır.
 * `harfDuyarsiz` (varsayılan: macOS ve Windows) ile `/users/ALICE` de eşleşir.
 * Uzun kök önce işlenir ki ev dizini içindeki proje `~/app` değil `[project]`
 * olsun. Kısa ya da kök dizin (`/`, `C:\`) atlanır: metni bozmasın.
 * Sır maskesinden SONRA çalışır (bkz. `degeriIsle`).
 */
export function yerelYollariGizle(
  metin: string,
  kokler: readonly YerelKok[],
  harfDuyarsiz: boolean = HARF_DUYARSIZ,
): string {
  const adaylar = kokler
    .map((kok) => ({ temiz: kok.yol.replace(/[\\/]+$/, ''), yerTutucu: kok.yerTutucu }))
    .filter((kok) => kok.temiz.length >= 4 && !/^[A-Za-z]:$/.test(kok.temiz))
    .sort((a, b) => b.temiz.length - a.temiz.length);
  let sonuc = metin;
  for (const aday of adaylar) {
    const govde = aday.temiz.split(/[\\/]+/).map(regexKacis).join('[\\\\/]+');
    const suruculu = /^[A-Za-z]:/.test(aday.temiz);
    // Kökün devamı ayraç, satır sonu ya da yol dışı karakter olmalı: `/home/al` `/home/alice`'i yemesin.
    const desen = new RegExp(`${govde}(?=$|[^A-Za-z0-9._-])`, harfDuyarsiz || suruculu ? 'gi' : 'g');
    sonuc = sonuc.replace(desen, aday.yerTutucu);
  }
  return sonuc;
}

/** `raporHtml` çalışırken geçerli yerel kökler; render eşzamanlıdır, başka yerde kullanılmaz. */
let etkinKokler: readonly YerelKok[] = [];

function degeriIsle(deger: unknown): string {
  if (deger instanceof GuvenliHtml) return deger.toString();
  if (Array.isArray(deger)) return deger.map(degeriIsle).join('');
  if (deger === undefined || deger === null || deger === false) return '';
  return htmlKacis(metniTemizle(String(deger), etkinKokler));
}

/**
 * Bilinen kökler (proje, kobay kurulumu, ev dizini) dışında kalan mutlak dosya
 * yolları. Yalnız dosya sistemi kökü olduğu belli ilk bileşenler eşlenir:
 * `/records/new` gibi bir URL yolu ya da uygulama rotası hata metninde anlamlıdır
 * ve dosya yolundan ayırt edilemez, o yüzden genel `/a/b` deseni KULLANILMAZ.
 * Yol bir sınırdan (satır başı, boşluk, tırnak, parantez, `=`, `,`, `[`, `<`, `:`,
 * `file://`) başlamalı: `cwd:/opt/x` eşleşir; `https://host/opt/x` içindeki `/opt/x`
 * host'a bitişik, `://` sonrası ise kök adı değil host gelir, eşleşmez.
 * Bilinen ödünleşim: sistem kökü adıyla başlayan uygulama rotaları (`Expected URL
 * /opt/x`) da maskelenir.
 * Windows'ta sürücü harfli yol (`C:\…`, `D:/…`) eşlenir. Son bileşen (dosya adı,
 * `:satır:sütun` eki dahil) korunur: `/opt/hostedtoolcache/x/fixture.js:4:2` →
 * `[path]/fixture.js:4:2`.
 */
const POSIX_KOKLERI = 'Users|home|opt|usr|var|tmp|private|etc|root|srv|mnt|media|Volumes|Library|System'
  + '|Applications|snap|nix|proc|run|workspace|github|__w|builds|data|azp|runner|w';
const YOL_BILESENI = '[^\\s/\\\\:"\'`()<>|*?]+';
const MUTLAK_YOL = new RegExp(
  `(^|[\\s"'\`(=,\\[<:]|file://)((?:/(?:${POSIX_KOKLERI})|[A-Za-z]:)(?:[\\\\/]+${YOL_BILESENI})*[\\\\/]+)(${YOL_BILESENI})`,
  'g',
);

export function mutlakYollariGizle(metin: string): string {
  return metin.replace(MUTLAK_YOL, (_tum, sinir: string, _dizin: string, son: string) => `${sinir}[path]/${son}`);
}

/**
 * HTML dışı çıktı (JSON'daki istemler, Markdown özet) için aynı temizlik,
 * kaçışsız. Sıra önemli: önce sır maskesi (tam değer eşleşmesi bozulmasın),
 * sonra serbest metindeki adreslerin kullanıcı bilgisi (`http://u:p@host` →
 * `http://[redacted]@host`), sonra bilinen kökler, en son kalan mutlak yollar.
 */
export function metniTemizle(metin: string, kokler: readonly YerelKok[]): string {
  return mutlakYollariGizle(yerelYollariGizle(metindekiKimligiGizle(gizliDegerleriMaskele(metin)), kokler));
}

/**
 * Şablon etiketi: sabit parçalar olduğu gibi, her `${değer}` maskelenip
 * kaçışlanarak birleşir. İç içe `html` parçaları ve dizileri bir daha işlenmez.
 */
export function html(parcalar: TemplateStringsArray, ...degerler: unknown[]): GuvenliHtml {
  let sonuc = parcalar[0] ?? '';
  for (const [sira, deger] of degerler.entries()) {
    sonuc += degeriIsle(deger) + (parcalar[sira + 1] ?? '');
  }
  return new GuvenliHtml(sonuc, URETICI);
}

export type RaporVerdict = Verdict | 'not_run';

export interface RaporAdimi {
  index: number;
  description?: string;
  type?: 'action' | 'assertion';
  status?: 'passed' | 'failed' | 'skipped';
  durationMs?: number;
  /** Rapor klasörüne göre görüntü yolu; yalnız `assets/<runId>/step-<n>.png` biçiminde kurulur. */
  screenshot?: string;
  errorMessage?: string;
}

export interface RaporHataAnalizi {
  rootCauseHypothesis: string;
  recommendedFixTarget: { kind: string; reference: string; rationale: string };
  evidence: Array<{ kind: string; stepIndex: number; summary: string }>;
}

export interface RaporTesti {
  id: string;
  name: string;
  priority: Oncelik;
  verdict: RaporVerdict;
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  failureKind?: FailureKind;
  errorMessage?: string;
  steps: RaporAdimi[];
  failure?: RaporHataAnalizi;
  code?: string;
  /** Test kaydının şu anki kod sürümü. */
  codeVersion?: number;
  /** Raporlanan koşunun kullandığı kod sürümü. */
  runCodeVersion?: number;
  /** Görünür not (ör. koşu kaydı okunamadı). */
  note?: string;
  /** Koşunun düşen adımı (result.json `failedStepIndex`). */
  failedStepIndex?: number;
}

export interface RaporSayimlari {
  passed: number;
  failed: number;
  blocked: number;
  inconclusive: number;
  notRun: number;
}

export interface RaporVerisi {
  baseUrl: string;
  generatedAt: string;
  version: string;
  tests: RaporTesti[];
  counts: RaporSayimlari;
}

/** Süreyi kısa İngilizce biçimde verir: `850 ms`, `4.2 s`, `2 min 5 s`. */
export function sureMetni(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const saniye = ms / 1000;
  if (saniye < 60) return `${saniye.toFixed(1)} s`;
  const dakika = Math.floor(saniye / 60);
  return `${dakika} min ${Math.round(saniye - dakika * 60)} s`;
}

const VERDICT_ETIKETI: Readonly<Record<RaporVerdict, string>> = {
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  inconclusive: 'Inconclusive',
  not_run: 'Not run',
};

type Durum = RaporVerdict | 'skipped';

/** Durum ikonları: satır içi SVG (CSP altında serbest), yalnız sabit işaretleme. */
function ikon(durum: Durum | 'none'): GuvenliHtml {
  switch (durum) {
    case 'passed':
      return html`<svg class="ikon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case 'failed':
      return html`<svg class="ikon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" fill="none" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    case 'blocked':
      return html`<svg class="ikon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M4.6 8h6.8" fill="none" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    case 'inconclusive':
      return html`<svg class="ikon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" fill="none" stroke-width="1.6" stroke-linecap="round"/><circle class="nokta" cx="8" cy="11.7" r=".9"/></svg>`;
    case 'skipped':
    case 'not_run':
      return html`<svg class="ikon ikon-bos" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke-width="1.6" stroke-dasharray="2.4 2.2"/></svg>`;
    case 'none':
      return html``;
  }
}

function durumRozeti(durum: Durum | undefined): GuvenliHtml {
  if (durum === undefined) return html`<span class="silik">–</span>`;
  const etiket = durum === 'skipped' ? 'Skipped' : VERDICT_ETIKETI[durum];
  return html`<span class="rozet rozet-${durum}">${ikon(durum)}${etiket}</span>`;
}

const LOGO = html`<svg class="logo" viewBox="0 0 40 32" aria-hidden="true"><path class="logo-govde" d="M6 22c0-8 7-14 16-14 7 0 12 4 13 10 .4 2-.6 3.6-2.4 4.3L31 23c-1.2 3.4-5 5-9.5 5H12c-3.6 0-6-2.4-6-6z"/><path class="logo-kulak" d="M12.5 11.5c-1.6-2.8.2-5.4 3-4.6 1.2.4 1.8 1.6 1.6 2.8"/><circle class="logo-goz" cx="27" cy="15.5" r="1.6"/><circle class="logo-burun" cx="34.2" cy="18.6" r="1.1"/></svg>`;

/** Adım şeridi: her adım bir hücre, sonucuna göre boyanır; düşen hücre işaretli. */
function adimSeridi(test: RaporTesti, ozetli = false): GuvenliHtml {
  if (test.steps.length === 0) return html``;
  const say = (durum: string): number => test.steps.filter((adim) => adim.status === durum).length;
  const parcalar = [
    `${test.steps.length} ${test.steps.length === 1 ? 'step' : 'steps'}`,
    ...(['passed', 'failed', 'skipped'] as const).filter((durum) => say(durum) > 0).map((durum) => `${say(durum)} ${durum}`),
  ];
  const serit = html`<ol class="serit" aria-label="Step outcomes">${test.steps.map((adim) => {
    const durum = adim.status ?? 'none';
    const etiket = adim.status === undefined ? 'no result' : adim.status;
    return html`<li class="hucre hucre-${durum}" title="Step ${adim.index}: ${etiket}"><span class="gizli-metin">Step ${adim.index}: ${etiket}</span></li>`;
  })}</ol>`;
  return ozetli ? html`<div class="serit-kap">${serit}<p class="serit-ozet">${parcalar.join(' · ')}</p></div>` : serit;
}

function adimOgesi(adim: RaporAdimi): GuvenliHtml {
  const gorsel = adim.screenshot === undefined
    ? html``
    : html`<a class="kare" href="${adim.screenshot}"><img src="${adim.screenshot}" alt="Screenshot after step ${adim.index}" loading="lazy" width="320" height="200"><span class="kare-etiket">Step ${adim.index} · open full size</span></a>`;
  return html`<li class="adim adim-${adim.status ?? 'none'}">
<span class="adim-no" aria-hidden="true">${adim.index}</span>
<div class="adim-govde">
<p class="adim-metin"><span class="gizli-metin">Step ${adim.index}: </span>${adim.description ?? 'No description'}</p>
<p class="adim-meta">${durumRozeti(adim.status)}${adim.type === undefined ? html`` : html`<span class="etiket-kucuk">${adim.type}</span>`}${adim.durationMs === undefined ? html`` : html`<span class="veri">${sureMetni(adim.durationMs)}</span>`}</p>
${adim.errorMessage === undefined ? html`` : html`<pre class="adim-hatasi">${adim.errorMessage}</pre>`}
</div>
${gorsel}
</li>`;
}

function adimListesi(test: RaporTesti): GuvenliHtml {
  if (test.steps.length === 0) return html`<p class="bos">No steps recorded for this run.</p>`;
  return html`<ol class="adimlar">${test.steps.map(adimOgesi)}</ol>`;
}

function hataAnalizi(analiz: RaporHataAnalizi): GuvenliHtml {
  const hedef = analiz.recommendedFixTarget;
  return html`<section class="analiz" aria-label="Failure analysis">
<h3 class="bolum-basligi">Failure analysis</h3>
<p class="uzun">${analiz.rootCauseHypothesis}</p>
<dl class="hedef">
<div><dt>Fix target</dt><dd><span class="etiket-kucuk">${hedef.kind}</span> <code>${hedef.reference}</code></dd></div>
<div><dt>Why</dt><dd>${hedef.rationale}</dd></div>
</dl>
${analiz.evidence.length === 0 ? html`` : html`<p class="alt-baslik">Evidence</p><ul class="kanitlar">${analiz.evidence.map((kanit) => html`<li><span class="etiket-kucuk">${kanit.kind}</span><span class="veri">step ${kanit.stepIndex}</span> ${kanit.summary}</li>`)}</ul>`}
</section>`;
}

/** Yapıştırmaya hazır istem kutusu: betik yok; tek tıkla tümü seçilir (`user-select: all`). */
/**
 * İstem metninin HTML'e TEK yolu: yalnız kaçış. İstem `istem.ts`'de değer değer
 * temizlenmiş olarak gelir; bütün metne yeniden maske uygulamak, desenlerin
 * değer sınırını aşıp iskeleti (çit, etiket, adımlar) yutmasına yol açardı.
 */
function istemHtml(temizIstem: string): GuvenliHtml {
  return new GuvenliHtml(htmlKacis(temizIstem), URETICI);
}

/** Kararlı, okunaklı UTC zamanı: `2026-10-05 22:27 UTC`; tam ISO `datetime`/`title`'da kalır. */
export function zamanMetni(iso: string): string {
  const an = new Date(iso);
  if (Number.isNaN(an.getTime())) return iso;
  return `${an.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function zaman(iso: string): GuvenliHtml {
  return html`<time datetime="${iso}" title="${iso}">${zamanMetni(iso)}</time>`;
}

function istemKutusu(baslik: string, aciklama: string, istem: string, kimlik: string): GuvenliHtml {
  return html`<section class="istem-kutusu" aria-label="${baslik}">
<div class="istem-basi">
<svg class="ikon istem-ikon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5l3.5 3.5-3.5 3.5M8 12h5.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div><h3 class="istem-basligi">${baslik}</h3><p class="istem-aciklama">${aciklama}</p></div>
</div>
<pre class="istem" id="${kimlik}" tabindex="0">${istemHtml(istem)}</pre>
<p class="ipucu">Click the prompt to select all of it, then copy (⌘C or Ctrl+C).</p>
</section>`;
}

function ozellikler(test: RaporTesti): GuvenliHtml {
  return html`<dl class="ozellikler">
<div><dt>Test ID</dt><dd><code>${test.id}</code></dd></div>
<div><dt>Priority</dt><dd>${test.priority}</dd></div>
${test.failureKind === undefined ? html`` : html`<div><dt>Failure kind</dt><dd><code>${test.failureKind}</code></dd></div>`}
${test.durationMs === undefined ? html`` : html`<div><dt>Duration</dt><dd class="veri">${sureMetni(test.durationMs)}</dd></div>`}
${test.runId === undefined ? html`` : html`<div><dt>Run ID</dt><dd><code>${test.runId}</code></dd></div>`}
${test.startedAt === undefined ? html`` : html`<div><dt>Started</dt><dd class="veri">${zaman(test.startedAt)}</dd></div>`}
</dl>`;
}

function kodBlogu(test: RaporTesti): GuvenliHtml {
  if (test.code === undefined) return html``;
  const surumNotu = test.codeVersion !== undefined && test.runCodeVersion !== undefined && test.codeVersion !== test.runCodeVersion
    ? html`<p class="not" role="note">This is the current code (version ${test.codeVersion}); the reported run used version ${test.runCodeVersion}.</p>`
    : html``;
  return html`<details class="kod-blogu"><summary>Generated code</summary>${surumNotu}<pre><code>${test.code}</code></pre></details>`;
}

/**
 * Koşunun hata metni. Düşen adım zaten kendi hatasını gösteriyorsa tam çıktı
 * kapalı `<details>` içinde durur; yoksa açık blok.
 */
function hataBlogu(test: RaporTesti): GuvenliHtml {
  if (test.errorMessage === undefined) return html``;
  const adimdaVar = test.steps.some((adim) => adim.status === 'failed' && adim.errorMessage !== undefined);
  if (adimdaVar) {
    return html`<details class="kod-blogu"><summary>Full error output</summary><pre class="hata">${test.errorMessage}</pre></details>`;
  }
  return html`<h3 class="bolum-basligi">Error</h3><pre class="hata">${test.errorMessage}</pre>`;
}

function testIcerigi(test: RaporTesti, baglam: IstemBaglami): GuvenliHtml {
  return html`${ozellikler(test)}
${test.note === undefined ? html`` : html`<p class="not" role="note">${test.note}</p>`}
${test.failure === undefined ? html`` : hataAnalizi(test.failure)}
${dikkatGerekenMi(test) ? istemKutusu('Fix with your coding agent', 'Paste this into Claude Code, Codex or Cursor, opened in this project.', duzeltmeIstemi(test, baglam), `prompt-${test.id}`) : html``}
${test.failure === undefined ? hataBlogu(test) : html``}
<h3 class="bolum-basligi">Steps</h3>
${adimListesi(test)}
${test.failure === undefined ? html`` : hataBlogu(test)}
${kodBlogu(test)}`;
}

/** Dikkat isteyen test: açık kart. */
function dikkatKarti(test: RaporTesti, baglam: IstemBaglami): GuvenliHtml {
  return html`<article class="kart kart-${test.verdict}" id="test-${test.id}">
<header class="kart-basi">
${durumRozeti(test.verdict)}
<h2 class="kart-basligi">${test.name}</h2>
</header>
${adimSeridi(test, true)}
${testIcerigi(test, baglam)}
</article>`;
}

/** Geçen test: kapalı `<details>`, özet satırında şerit ve süre. */
function gecenKart(test: RaporTesti, baglam: IstemBaglami): GuvenliHtml {
  return html`<details class="kart kart-passed kart-kapali" id="test-${test.id}">
<summary class="kart-ozet">
${durumRozeti(test.verdict)}
<span class="kart-basligi">${test.name}</span>
<span class="ozet-sag">${adimSeridi(test)}<span class="veri">${test.durationMs === undefined ? '' : sureMetni(test.durationMs)}</span></span>
</summary>
${testIcerigi(test, baglam)}
</details>`;
}

function kosmayanSatir(test: RaporTesti): GuvenliHtml {
  return html`<li class="kosmayan" id="test-${test.id}">${durumRozeti('not_run')}<span class="kosmayan-ad">${test.name}</span><code>${test.id}</code><span class="silik">Run it with <code>kobay test run ${test.id}</code></span></li>`;
}

function anaCumle(veri: RaporVerisi): { baslik: string; alt: string } {
  const c = veri.counts;
  const kosan = c.passed + c.failed + c.blocked + c.inconclusive;
  const test = (n: number): string => (n === 1 ? 'test' : 'tests');
  if (veri.tests.length === 0) return { baslik: 'No tests selected', alt: 'Select tests by ID or pass --all.' };
  if (kosan === 0) return { baslik: 'Nothing has run yet', alt: `${c.notRun} ${test(c.notRun)} without a run on disk.` };
  const dikkat = c.failed + c.blocked + c.inconclusive;
  const ekler = [
    ...(c.blocked > 0 ? [`${c.blocked} blocked`] : []),
    ...(c.inconclusive > 0 ? [`${c.inconclusive} inconclusive`] : []),
    ...(c.notRun > 0 ? [`${c.notRun} not run`] : []),
  ];
  if (dikkat === 0) {
    return {
      baslik: kosan === 1 ? 'The test passed' : `All ${kosan} tests passed`,
      alt: ekler.length === 0 ? 'Nothing needs attention.' : `${ekler.join(', ')}.`,
    };
  }
  const baslik = c.failed > 0
    ? `${c.failed} of ${kosan} ${test(kosan)} failed`
    : `${dikkat} of ${kosan} ${test(kosan)} need attention`;
  return { baslik, alt: ekler.length === 0 ? `${c.passed} passed.` : `${c.passed} passed, ${ekler.join(', ')}.` };
}

function kosuCubugu(veri: RaporVerisi): GuvenliHtml {
  const c = veri.counts;
  const dilimler: Array<[RaporVerdict, number]> = [
    ['failed', c.failed], ['blocked', c.blocked], ['inconclusive', c.inconclusive], ['passed', c.passed], ['not_run', c.notRun],
  ];
  return html`<div class="cubuk" role="img" aria-label="${c.passed} passed, ${c.failed} failed, ${c.blocked} blocked, ${c.inconclusive} inconclusive, ${c.notRun} not run">${dilimler
    .filter(([, sayi]) => sayi > 0)
    .map(([durum, sayi]) => html`<span class="dilim dilim-${durum}" style="flex-grow: ${sayi}"></span>`)}</div>
<ul class="sayimlar">${dilimler.map(([durum, sayi]) => html`<li class="sayim sayim-${durum}${sayi === 0 ? ' sayim-sifir' : ''}">${ikon(durum)}<strong>${sayi}</strong><span>${VERDICT_ETIKETI[durum].toLowerCase()}</span></li>`)}</ul>`;
}

const STIL = `
:root {
  color-scheme: light dark;
  --zemin: #eef1f4; --yuzey: #fbfcfd; --yuzey-2: #f4f6f8; --metin: #17212b; --silik: #5b6875; --cizgi: #d6dce3;
  --zencefil: #b9661a; --zencefil-zemin: #fbefe2; --vurgu: #1f5fa8;
  --gecti: #176a41; --gecti-zemin: #e2f2e9; --dustu: #c2362b; --dustu-zemin: #fbe6e3;
  --engel: #9a5c00; --engel-zemin: #f8ecd6; --belirsiz: #6b5ba8; --belirsiz-zemin: #ece8f7;
  --bos: #56626e; --bos-zemin: #e7ebef; --uyari-zemin: #fff4d9; --uyari-cizgi: #e3c372;
  --golge: 0 1px 2px rgba(23, 33, 43, .06), 0 4px 16px rgba(23, 33, 43, .05);
  --goruntu: ui-rounded, "SF Pro Rounded", "Nunito", system-ui, -apple-system, "Segoe UI", sans-serif;
  --govde: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --zemin: #0f1419; --yuzey: #161d24; --yuzey-2: #1b232b; --metin: #e6ebf0; --silik: #93a1ae; --cizgi: #27323c;
    --zencefil: #e39a4f; --zencefil-zemin: #2b2118; --vurgu: #7fb2f0;
    --gecti: #4cc38a; --gecti-zemin: #15291f; --dustu: #f07368; --dustu-zemin: #33191a;
    --engel: #e0a84a; --engel-zemin: #2f2514; --belirsiz: #a99be6; --belirsiz-zemin: #231f36;
    --bos: #939faa; --bos-zemin: #1f272f; --uyari-zemin: #2d2613; --uyari-cizgi: #6e5a22;
    --golge: 0 1px 2px rgba(0, 0, 0, .3), 0 6px 20px rgba(0, 0, 0, .25);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--zemin); color: var(--metin); font: 16px/1.55 var(--govde); }
.sayfa { max-width: 1040px; margin: 0 auto; padding: 24px 16px 64px; }
a { color: var(--vurgu); }
a:focus-visible, summary:focus-visible, .istem:focus-visible { outline: 2px solid var(--vurgu); outline-offset: 2px; }
code, .veri { font-family: var(--mono); font-size: .86em; }
code { overflow-wrap: anywhere; }
.veri { color: var(--silik); font-variant-numeric: tabular-nums; white-space: nowrap; }
.silik, .bos { color: var(--silik); }
.gizli-metin { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.ikon { width: 1em; height: 1em; flex: none; fill: currentColor; stroke: currentColor; vertical-align: -.14em; }
.ikon path { stroke: var(--yuzey); }
.ikon-bos, .istem-ikon { fill: none; }
.ikon-bos circle { fill: none; }
.istem-ikon path { stroke: currentColor; }
.ikon .nokta { stroke: none; fill: var(--yuzey); }

/* Üst bant */
.marka { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: space-between; margin-bottom: 28px; }
.marka-sol { display: flex; align-items: center; gap: 10px; }
.logo { width: 40px; height: 32px; }
.logo-govde { fill: var(--zencefil); }
.logo-kulak { fill: none; stroke: var(--zencefil); stroke-width: 2.4; stroke-linecap: round; }
.logo-goz { fill: var(--yuzey); }
.logo-burun { fill: var(--metin); opacity: .55; }
.marka-adi { font-family: var(--goruntu); font-weight: 700; font-size: 1.15rem; letter-spacing: -.01em; }
.marka-adi span { color: var(--silik); font-weight: 500; }
.marka-sag { color: var(--silik); font-size: .85rem; }

/* Özet */
.ozet { background: var(--yuzey); border: 1px solid var(--cizgi); border-radius: 14px; box-shadow: var(--golge); padding: 24px 20px 20px; }
.ozet h1 { font-family: var(--goruntu); font-weight: 800; font-size: clamp(1.9rem, 6vw, 2.9rem); line-height: 1.08; letter-spacing: -.025em; margin: 0; }
.ozet-alt { margin: 8px 0 20px; color: var(--silik); font-size: 1.05rem; }
.cubuk { display: flex; gap: 3px; height: 14px; border-radius: 7px; overflow: hidden; background: var(--bos-zemin); }
.dilim { display: block; min-width: 6px; }
.dilim-passed { background: var(--gecti); } .dilim-failed { background: var(--dustu); } .dilim-blocked { background: var(--engel); }
.dilim-inconclusive { background: var(--belirsiz); } .dilim-not_run { background: var(--bos); opacity: .55; }
.sayimlar { display: flex; flex-wrap: wrap; gap: 6px 18px; list-style: none; margin: 14px 0 0; padding: 0; }
.sayim { display: flex; align-items: center; gap: 6px; font-size: .92rem; color: var(--silik); }
.sayim strong { font-family: var(--goruntu); font-size: 1.25rem; font-weight: 750; color: var(--metin); font-variant-numeric: tabular-nums; }
.sayim-passed .ikon { color: var(--gecti); } .sayim-failed .ikon { color: var(--dustu); } .sayim-blocked .ikon { color: var(--engel); }
.sayim-inconclusive .ikon { color: var(--belirsiz); } .sayim-not_run .ikon { color: var(--bos); }
.sayim-sifir { opacity: .5; }
.olcumler { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px 20px; margin: 20px 0 0; padding: 16px 0 0; border-top: 1px solid var(--cizgi); }
.olcumler div { min-width: 0; }
.olcumler dt { font-size: .78rem; color: var(--silik); text-transform: uppercase; letter-spacing: .06em; }
.olcumler dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.olcumler .veri { white-space: normal; }
.olcumler .buyuk { font-family: var(--goruntu); font-weight: 750; font-size: 1.35rem; }
.uyari { display: flex; gap: 10px; align-items: flex-start; background: var(--uyari-zemin); border: 1px solid var(--uyari-cizgi); border-radius: 10px; padding: 12px 14px; margin: 16px 0 0; font-size: .93rem; }
.uyari .ikon { margin-top: .2em; color: var(--engel); }

/* Bölümler */
.bolum { margin-top: 40px; }
.bolum-ust { display: flex; align-items: baseline; gap: 10px; margin: 0 0 14px; }
.bolum-ust h2 { font-family: var(--goruntu); font-size: 1.35rem; font-weight: 750; letter-spacing: -.01em; margin: 0; }
.bolum-ust span { color: var(--silik); font-family: var(--mono); font-size: .85rem; }
.bolum-basligi { font-size: .8rem; text-transform: uppercase; letter-spacing: .07em; color: var(--silik); margin: 24px 0 10px; font-weight: 650; }

/* Kartlar */
.kart { position: relative; background: var(--yuzey); border: 1px solid var(--cizgi); border-radius: 14px; box-shadow: var(--golge); padding: 20px; margin: 0 0 16px; overflow: hidden; }
.kart::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 5px; background: var(--bos); }
.kart-failed::before { background: var(--dustu); } .kart-passed::before { background: var(--gecti); }
.kart-blocked::before { background: var(--engel); } .kart-inconclusive::before { background: var(--belirsiz); }
.kart-basi { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.kart-basligi { font-family: var(--goruntu); font-size: 1.3rem; font-weight: 750; line-height: 1.25; letter-spacing: -.01em; margin: 0; overflow-wrap: anywhere; }
.kart-kapali { padding: 0; }
.kart-ozet { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; padding: 14px 20px; cursor: pointer; list-style: none; }
.kart-ozet::-webkit-details-marker { display: none; }
.kart-ozet .kart-basligi { font-size: 1.02rem; flex: 1 1 200px; min-width: 0; }
.kart-ozet::after { content: "Show"; font-size: .8rem; color: var(--vurgu); }
.kart-kapali[open] > .kart-ozet::after { content: "Hide"; }
.kart-kapali[open] > .kart-ozet { border-bottom: 1px solid var(--cizgi); }
.kart-kapali > :not(summary) { margin-left: 20px; margin-right: 20px; }
.kart-kapali[open] { padding-bottom: 20px; }
.ozet-sag { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ozet-sag .serit { margin: 0; max-width: 220px; }

.rozet { display: inline-flex; align-items: center; gap: 5px; font-size: .78rem; font-weight: 650; padding: 3px 9px 3px 6px; border-radius: 999px; white-space: nowrap; }
.rozet-passed { color: var(--gecti); background: var(--gecti-zemin); }
.rozet-failed { color: var(--dustu); background: var(--dustu-zemin); }
.rozet-blocked { color: var(--engel); background: var(--engel-zemin); }
.rozet-inconclusive { color: var(--belirsiz); background: var(--belirsiz-zemin); }
.rozet-not_run, .rozet-skipped { color: var(--bos); background: var(--bos-zemin); }

/* İmza: adım şeridi */
.serit { display: flex; flex-wrap: wrap; gap: 4px; list-style: none; padding: 0; margin: 0; }
.serit-kap { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin: 16px 0 4px; }
.serit-kap .hucre { width: 36px; height: 16px; border-radius: 4px; }
.serit-kap .hucre-failed { width: 52px; }
.serit-ozet { margin: 0; font-family: var(--mono); font-size: .78rem; color: var(--silik); }
.hucre { width: 18px; height: 8px; border-radius: 3px; background: var(--bos-zemin); border: 1px solid var(--cizgi); }
.hucre-passed { background: var(--gecti); border-color: var(--gecti); }
.hucre-failed { background: var(--dustu); border-color: var(--dustu); width: 28px; box-shadow: 0 0 0 2px var(--dustu-zemin); }
.hucre-skipped { background: transparent; border-style: dashed; border-color: var(--bos); }
.alt-baslik { margin: 16px 0 6px; font-size: .8rem; color: var(--silik); font-weight: 650; }

.ozellikler { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 16px 0 0; }
.ozellikler div { min-width: 0; }
.ozellikler dt { font-size: .75rem; color: var(--silik); text-transform: uppercase; letter-spacing: .06em; }
.ozellikler dd { margin: 1px 0 0; overflow-wrap: anywhere; }

pre { margin: 0; padding: 12px 14px; background: var(--yuzey-2); border: 1px solid var(--cizgi); border-radius: 10px; overflow-x: auto; max-width: 100%; font-family: var(--mono); font-size: .82rem; line-height: 1.55; }
pre.hata { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dustu); border-color: color-mix(in srgb, var(--dustu) 35%, var(--cizgi)); }
.not { background: var(--bos-zemin); border-radius: 10px; padding: 10px 14px; margin: 14px 0; font-size: .93rem; }

.analiz { margin-top: 8px; }
.uzun { margin: 0; max-width: 72ch; overflow-wrap: anywhere; white-space: pre-wrap; }
.hedef { margin: 14px 0 0; display: grid; gap: 8px; }
.hedef div { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 12px; }
.hedef dt { color: var(--silik); font-size: .85rem; padding-top: .1em; }
.hedef dd { margin: 0; overflow-wrap: anywhere; }
.kanitlar { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 6px; }
.kanitlar li { overflow-wrap: anywhere; font-size: .93rem; }
.kanitlar .veri { margin: 0 6px; }
.etiket-kucuk { display: inline-block; font-family: var(--mono); font-size: .72rem; padding: 1px 6px; border-radius: 5px; background: var(--yuzey-2); border: 1px solid var(--cizgi); color: var(--silik); }

/* Ajan istemi */
.istem-kutusu { margin: 22px 0 0; border: 1px solid color-mix(in srgb, var(--zencefil) 45%, var(--cizgi)); background: var(--zencefil-zemin); border-radius: 12px; padding: 16px; }
.istem-basi { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
.istem-ikon { width: 30px; height: 30px; padding: 6px; border-radius: 8px; background: var(--zencefil); color: var(--yuzey); flex: none; }
.istem-basligi { font-family: var(--goruntu); font-size: 1.08rem; font-weight: 750; margin: 0; }
.istem-aciklama { margin: 2px 0 0; color: var(--silik); font-size: .9rem; }
.istem { white-space: pre-wrap; overflow-wrap: anywhere; user-select: all; -webkit-user-select: all; cursor: text; max-height: 30em; overflow-y: auto; background: var(--yuzey); color: var(--metin); }
.ipucu { margin: 8px 0 0; font-size: .8rem; color: var(--silik); }

/* Adım zaman çizelgesi */
.adimlar { list-style: none; margin: 0; padding: 0; position: relative; }
.adim { position: relative; display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 4px 14px; padding: 0 0 18px; }
.adim::before { content: ""; position: absolute; left: 14px; top: 28px; bottom: 0; width: 2px; background: var(--cizgi); }
.adim:last-child::before { display: none; }
.adim-no { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-family: var(--mono); font-size: .8rem; font-weight: 650; background: var(--bos-zemin); color: var(--silik); position: relative; }
.adim-passed .adim-no { background: var(--gecti-zemin); color: var(--gecti); }
.adim-failed .adim-no { background: var(--dustu); color: var(--yuzey); }
.adim-govde { min-width: 0; }
.adim-metin { margin: 3px 0 4px; overflow-wrap: anywhere; }
.adim-failed .adim-metin { font-weight: 650; }
.adim-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0; }
.adim-hatasi { margin-top: 8px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dustu); font-size: .76rem; }
.kare { display: block; width: 200px; text-decoration: none; color: var(--silik); }
.kare img { display: block; width: 100%; height: auto; aspect-ratio: 16 / 10; object-fit: cover; object-position: top left; border: 1px solid var(--cizgi); border-radius: 8px; background: var(--yuzey-2); }
.kare:hover img { border-color: var(--vurgu); }
.kare-etiket { display: block; font-size: .72rem; margin-top: 4px; }

.kod-blogu { margin-top: 20px; }
.kod-blogu summary { cursor: pointer; font-weight: 650; font-size: .92rem; }
.kod-blogu pre, .kod-blogu .not { margin-top: 10px; }

.kosmayanlar { list-style: none; margin: 0; padding: 0; background: var(--yuzey); border: 1px solid var(--cizgi); border-radius: 14px; }
.kosmayan { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 12px 16px; border-bottom: 1px solid var(--cizgi); }
.kosmayan:last-child { border-bottom: 0; }
.kosmayan-ad { font-weight: 600; overflow-wrap: anywhere; }

.alt { color: var(--silik); font-size: .82rem; margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--cizgi); }

@media (max-width: 640px) {
  .ozet { padding: 20px 16px 16px; }
  .kart { padding: 16px 14px 16px 18px; }
  .kart-ozet { padding: 12px 14px 12px 18px; }
  .kart-kapali > :not(summary) { margin-left: 18px; margin-right: 14px; }
  .adim { grid-template-columns: 30px minmax(0, 1fr); }
  .kare { grid-column: 2; width: 100%; max-width: 320px; }
  .hedef div { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .ozet-sag .serit { display: none; }
}
@media print {
  :root { color-scheme: light; --zemin: #fff; --yuzey: #fff; --golge: none; }
  body { font-size: 11pt; }
  .sayfa { max-width: none; padding: 0; }
  .kart, .adim, .istem-kutusu { break-inside: avoid; }
  .ipucu { display: none; }
  .istem { max-height: none; overflow: visible; }
  details::details-content { content-visibility: visible; display: block; }
  a { color: inherit; text-decoration: none; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/** Raporun tam `index.html` metni. */
export function raporHtml(veri: RaporVerisi, kokler: readonly YerelKok[] = []): string {
  etkinKokler = kokler;
  try {
    return raporGovdesi(veri);
  } finally {
    etkinKokler = [];
  }
}

function raporGovdesi(veri: RaporVerisi): string {
  const kokler = etkinKokler;
  const baglam: IstemBaglami = { baseUrl: veri.baseUrl, temizle: (metin) => metniTemizle(metin, kokler) };
  const sira: Record<string, number> = { failed: 0, blocked: 1, inconclusive: 2 };
  const dikkat = veri.tests.filter(dikkatGerekenMi).sort((a, b) => (sira[a.verdict] ?? 3) - (sira[b.verdict] ?? 3));
  const gecen = veri.tests.filter((test) => test.verdict === 'passed');
  const kosmayan = veri.tests.filter((test) => test.verdict === 'not_run');
  const kosan = veri.tests.length - kosmayan.length;
  const toplamSure = veri.tests.reduce((toplam, test) => toplam + (test.durationMs ?? 0), 0);
  const oran = kosan === 0 ? '–' : `${Math.round((veri.counts.passed / kosan) * 100)}%`;
  const { baslik, alt } = anaCumle(veri);
  const hepsi = hepsiniDuzeltIstemi(veri.tests, baglam);

  const govde = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'">
<meta name="referrer" content="no-referrer">
<title>${baslik} · kobay run report</title>
<style>${new GuvenliHtml(STIL, URETICI)}</style>
</head>
<body>
<div class="sayfa">
<header class="marka">
<div class="marka-sol">${LOGO}<span class="marka-adi">kobay <span>run report</span></span></div>
<div class="marka-sag">kobay ${veri.version} · <span class="veri">${zaman(veri.generatedAt)}</span></div>
</header>
<section class="ozet" aria-label="Summary">
<h1>${baslik}</h1>
<p class="ozet-alt">${alt}</p>
${kosuCubugu(veri)}
<dl class="olcumler">
<div><dt>Pass rate</dt><dd class="buyuk">${oran}</dd></div>
<div><dt>Total run time</dt><dd class="buyuk">${kosan === 0 ? '–' : sureMetni(toplamSure)}</dd></div>
<div><dt>Base URL</dt><dd><code>${veri.baseUrl}</code></dd></div>
<div><dt>Generated</dt><dd class="veri">${zaman(veri.generatedAt)}</dd></div>
</dl>
<p class="uyari" role="note"><svg class="ikon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l7 12.6H1z" stroke-linejoin="round" stroke-width="1.2"/><path d="M8 6v3.6M8 11.6v.2" fill="none" stroke-width="1.6" stroke-linecap="round"/></svg><span><strong>Screenshots are not redacted.</strong> They may show any data your app displayed during the run. Do not share this report publicly before reviewing them.</span></p>
</section>
${hepsi === null ? html`` : html`<section class="bolum">${istemKutusu('Fix all failures with your coding agent', `One prompt for all ${dikkat.length} tests that need attention. Paste it into Claude Code, Codex or Cursor, opened in this project.`, hepsi, 'prompt-all')}</section>`}
${veri.tests.length === 0
    ? html`<p class="bos bolum">No tests were selected. Create tests with <code>kobay test plan generate</code>, run them with <code>kobay test run --all</code>, then run <code>kobay test report --all</code> again.</p>`
    : html``}
${dikkat.length === 0 ? html`` : html`<section class="bolum" aria-label="Needs attention"><div class="bolum-ust"><h2>Needs attention</h2><span>${dikkat.length}</span></div>${dikkat.map((test) => dikkatKarti(test, baglam))}</section>`}
${gecen.length === 0 ? html`` : html`<section class="bolum" aria-label="Passed"><div class="bolum-ust"><h2>Passed</h2><span>${gecen.length}</span></div>${gecen.map((test) => gecenKart(test, baglam))}</section>`}
${kosmayan.length === 0 ? html`` : html`<section class="bolum" aria-label="Not run"><div class="bolum-ust"><h2>Not run</h2><span>${kosmayan.length}</span></div><ul class="kosmayanlar">${kosmayan.map(kosmayanSatir)}</ul></section>`}
<footer class="alt">Generated by kobay ${veri.version}. This folder is self-contained: move index.html together with assets/. Regenerate it with <code>kobay test report --all</code>.</footer>
</div>
</body>
</html>
`;
  return govde.toString();
}
