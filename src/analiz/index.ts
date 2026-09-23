import { access, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Beyin } from '../beyin/index.js';
import { gizliDegerleriMaskele } from '../beyin/ortak.js';
import type {
  AdimSonucu,
  HaritaFarki,
  HataAnalizi,
  HataPaketi,
  Kanit,
  KobayDizini,
  KosuSonucu,
  TestKaydi,
} from '../depo/index.js';
import { domHaritaFarkiOlustur } from './harita-farki.js';
import { analizKullaniciIstemiOlustur, analizSistemIstemiOlustur } from './istem.js';
import { BeyindenGelenHataAnaliziSemasi, type BeyindenGelenHataAnalizi } from './sema.js';

type KonsolKaydi = { tip: 'error' | 'warning'; metin: string; stepIndex?: number };
type AgKaydi = { url: string; method: string; status?: number; hata?: string; stepIndex?: number };

const KOBAY_IC_YOL_DESENI = /(?:^|[/\\])(?:node_modules[/\\])?kobay[/\\](?:src|dist)[/\\]/i;
const KOBAY_FIXTURE_YOL_DESENI = /(?:^|[/\\])(?:src|dist)[/\\]kos[/\\](?:fixture|fixture-sablonu)\.[cm]?[jt]s/i;

/** Playwright hata metninden Kobay'ın kendi stack frame'lerini çıkarır; kullanıcı test satırlarını korur. */
export function hataMesajiniTemizle(metin: string): string {
  const satirlar = metin.split(/\r?\n/);
  const kalan = satirlar.filter((satir) => {
    if (!/^\s*at\b/.test(satir)) return true;
    return !KOBAY_IC_YOL_DESENI.test(satir) && !KOBAY_FIXTURE_YOL_DESENI.test(satir);
  });
  const temiz = kalan.join('\n').trim();
  return temiz === '' ? 'An error occurred inside the Kobay test runner.' : temiz;
}

/**
 * Beynin metnine sızan iç JSON alan adlarını insan diline çevirir. 0.2'nin
 * İngilizce adları listenin başında; 0.1'in Türkçe adları (önbellekli istemle
 * gelebilir) arkada duruyor. `changed` tek başına sıradan bir İngilizce kelime
 * olduğu için yalnız `changed: true/false` biçiminde eşleşir — düz metindeki
 * "the button changed" cümlesi bozulmasın.
 */
const IC_ALAN_KARSILIKLARI: Array<[RegExp, string]> = [
  [/pageIdentityMatches\s*[:=]\s*false/gi, 'the current DOM does not match the page identity from explore'],
  [/pageIdentityMatches\s*[:=]\s*true/gi, 'the current DOM matches the page identity from explore'],
  [/changed\s*[:=]\s*false/gi, 'no visible element differences against the explore map'],
  [/changed\s*[:=]\s*true/gi, 'visible element differences against the explore map'],
  [/\bmapDiff\b/g, 'explore map comparison'],
  [/\bpageIdentityMatches\b/g, 'page identity check'],
  [/\baddedHeadings\b/g, 'newly visible headings'],
  [/\bremovedHeadings\b/g, 'headings that are no longer visible'],
  [/\baddedButtons\b/g, 'newly visible buttons'],
  [/\bremovedButtons\b/g, 'buttons that are no longer visible'],
  [/\baddedFormFields\b/g, 'newly visible form fields'],
  [/\bremovedFormFields\b/g, 'form fields that are no longer visible'],
  [/sayfaKimligiUyusuyor\s*[:=]\s*false/gi, 'the current DOM does not match the page identity from explore'],
  [/sayfaKimligiUyusuyor\s*[:=]\s*true/gi, 'the current DOM matches the page identity from explore'],
  [/degisti\s*[:=]\s*false/gi, 'no visible element differences against the explore map'],
  [/degisti\s*[:=]\s*true/gi, 'visible element differences against the explore map'],
  [/\bharitaFarki\b/g, 'explore map comparison'],
  [/\bsayfaKimligiUyusuyor\b/g, 'page identity check'],
  [/\bdegisti\b/g, 'page map change'],
  [/\beklenenBasliklar\b/g, 'newly visible headings'],
  [/\bsilinenBasliklar\b/g, 'headings that are no longer visible'],
  [/\beklenenDugmeler\b/g, 'newly visible buttons'],
  [/\bsilinenDugmeler\b/g, 'buttons that are no longer visible'],
  [/\beklenenFormAlanlari\b/g, 'newly visible form fields'],
  [/\bsilinenFormAlanlari\b/g, 'form fields that are no longer visible'],
];

function icAlanAdlariniTemizle(metin: string): string {
  return IC_ALAN_KARSILIKLARI.reduce(
    (sonuc, [desen, karsilik]) => sonuc.replace(desen, karsilik),
    metin,
  );
}

function kodDuzeltmeIpucuEkle(analiz: HataAnalizi, hataMetni: string): HataAnalizi {
  const temiz: HataAnalizi = {
    ...analiz,
    rootCauseHypothesis: icAlanAdlariniTemizle(analiz.rootCauseHypothesis),
    recommendedFixTarget: {
      ...analiz.recommendedFixTarget,
      reference: icAlanAdlariniTemizle(analiz.recommendedFixTarget.reference),
      rationale: icAlanAdlariniTemizle(analiz.recommendedFixTarget.rationale),
    },
    evidence: analiz.evidence.map((kanit) => ({
      ...kanit,
      summary: icAlanAdlariniTemizle(kanit.summary),
    })),
  };
  if (temiz.failureKind !== 'product_bug' || temiz.recommendedFixTarget.kind !== 'code') return temiz;
  if (/search the product (?:source )?code/i.test(temiz.recommendedFixTarget.rationale)) return temiz;
  const received = /Received(?: string)?:\s*(?:\n\s*)?([^\n]+)/i.exec(hataMetni)?.[1]?.trim();
  const aranacak = received === undefined || received === ''
    ? 'the "Received" value or text from the error message'
    : `the text ${received.slice(0, 160)} from the "Received" section of the error message`;
  return {
    ...temiz,
    recommendedFixTarget: {
      ...temiz.recommendedFixTarget,
      rationale: `${temiz.recommendedFixTarget.rationale} To find the source file, search the product code for ${aranacak}.`,
    },
  };
}

function dosyaVarMi(yol: string): Promise<boolean> {
  return access(yol).then(() => true).catch(() => false);
}

async function istegeBagliOku(yol: string): Promise<string | null> {
  try {
    return await readFile(yol, 'utf8');
  } catch (hata: unknown) {
    if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') return null;
    throw hata;
  }
}

function jsonDizisiOku<T>(metin: string | null): T[] {
  if (metin === null) return [];
  try {
    const veri: unknown = JSON.parse(metin);
    return Array.isArray(veri) ? veri as T[] : [];
  } catch {
    return [];
  }
}

function analizUyarisiYaz(mesaj: string): void {
  process.stderr.write(`[kobay analysis] ${mesaj}\n`);
}

function urlYolu(adres: string, baseUrl: string): string | null {
  try {
    return new URL(adres, baseUrl).pathname;
  } catch {
    return null;
  }
}

/**
 * Keşif haritasındaki sayfayı düşen adımın DOM'uyla kıyaslar.
 * Gelen DOM maskeli olmalıdır: fark bloğu hem isteme hem failure.json'a gidiyor.
 */
async function haritaFarkiHazirla(
  dizin: KobayDizini,
  test: TestKaydi,
  dom: string | null,
): Promise<HaritaFarki | undefined> {
  try {
    const harita = await dizin.haritaOku();
    if (harita === null) {
      analizUyarisiYaz('No explore map; map comparison skipped.');
      return undefined;
    }
    if (test.url === undefined) {
      analizUyarisiYaz(`Test has no URL (${test.id}); map comparison skipped.`);
      return undefined;
    }
    const testYolu = urlYolu(test.url, harita.baseUrl);
    const haritaSayfasi = testYolu === null
      ? undefined
      : harita.pages.find((sayfa) => urlYolu(sayfa.url, harita.baseUrl) === testYolu);
    if (haritaSayfasi === undefined) {
      analizUyarisiYaz(`Test page is not in the explore map (${test.url}); map comparison skipped.`);
      return undefined;
    }
    if (dom === null) {
      analizUyarisiYaz(`The failing step has no DOM file (${test.id}); map comparison skipped.`);
      return undefined;
    }
    return await domHaritaFarkiOlustur(dom, haritaSayfasi, new URL(harita.baseUrl).origin);
  } catch (hata) {
    analizUyarisiYaz(`Map comparison failed; continued with the plain analysis flow: ${String(hata).split('\n')[0] ?? 'unknown error'}`);
    return undefined;
  }
}

/** Üretilen kodda `await test.step('N: …')` bloğunu bulup yalnız o dilimi döndürür. */
export function dusenAdimKodunuBul(kod: string, stepIndex: number): string {
  if (stepIndex < 0) return '';
  const adimBaslangici = /await\s+test\.step\(\s*['"`](\d+):/g;
  let eslesme: RegExpExecArray | null;
  let baslangic = -1;
  while ((eslesme = adimBaslangici.exec(kod)) !== null) {
    if (Number(eslesme[1]) === stepIndex) {
      baslangic = eslesme.index;
      break;
    }
  }
  if (baslangic < 0) return '';
  const kalan = kod.slice(baslangic + 1);
  const sonraki = kalan.search(/await\s+test\.step\(\s*['"`]/);
  return sonraki < 0 ? kod.slice(baslangic) : kod.slice(baslangic, baslangic + 1 + sonraki);
}

/**
 * Yalnız yeniden adlandırmayı ürün değişimi sayar: aynı grupta tam 1 silinen ve
 * tam 1 eklenen öğe olmalı. Saf silme (0 eklenen) ve belirsiz durum (2+ eklenen)
 * beynin kararına bırakılır; silinen öğe gerçek bir ürün hatası olabilir.
 */
function urunDegisikligiEslesmesi(
  fark: HaritaFarki | undefined,
  stepIndex: number,
  hataMetni: string,
  kod: string,
): { eski: string; yeni: string } | null {
  if (fark === undefined) return null;
  const aranacak = [hataMetni, dusenAdimKodunuBul(kod, stepIndex)]
    .map((metin) => metin.replace(/\s+/g, ' ').trim());
  const gruplar = [
    { silinenler: fark.removedHeadings, eklenenler: fark.addedHeadings },
    { silinenler: fark.removedButtons, eklenenler: fark.addedButtons },
  ];
  for (const grup of gruplar) {
    if (grup.silinenler.length !== 1 || grup.eklenenler.length !== 1) continue;
    const eski = (grup.silinenler[0] ?? '').replace(/\s+/g, ' ').trim();
    const yeni = (grup.eklenenler[0] ?? '').replace(/\s+/g, ' ').trim();
    if (eski.length < 3 || yeni === '') continue;
    if (!aranacak.some((metin) => metin.includes(eski))) continue;
    return { eski, yeni };
  }
  return null;
}

/**
 * Beyin yeniden adlandırmayı kaçırdıysa yerel kıyasla düzeltir.
 * Sayfa kimliği tutmuyorsa (oturum düşmüş, giriş ekranına yönlenmiş) devreye girmez.
 */
function yerelHaritaEmniyeti(
  analiz: HataAnalizi,
  fark: HaritaFarki | undefined,
  stepIndex: number,
  hataMetni: string,
  kod: string,
): HataAnalizi {
  if (analiz.failureKind !== 'test_bug' && analiz.failureKind !== 'product_bug') return analiz;
  if (fark !== undefined && !fark.pageIdentityMatches) return analiz;
  const eslesme = urunDegisikligiEslesmesi(fark, stepIndex, hataMetni, kod);
  if (eslesme === null || fark === undefined) return analiz;
  return {
    ...analiz,
    rootCauseHypothesis: `Local map comparison: "${eslesme.eski}" was present during explore and is gone now. ${analiz.rootCauseHypothesis}`,
    failureKind: 'product_changed',
    recommendedFixTarget: {
      kind: 'code',
      reference: `${fark.url}: "${eslesme.eski}" → "${eslesme.yeni}"`,
      rationale: 'The explore map is stale; re-run explore and regenerate the test.',
    },
  };
}

function dusenAdimiBul(sonuc: KosuSonucu, adimlar: AdimSonucu[]): AdimSonucu {
  if (sonuc.failedStepIndex !== undefined) {
    return adimlar.find((adim) => adim.stepIndex === sonuc.failedStepIndex) ?? {
      stepIndex: sonuc.failedStepIndex,
      description: 'Unrecorded failing step',
      status: 'failed',
      durationMs: 0,
    };
  }
  return adimlar.filter((adim) => adim.status === 'failed').at(-1) ?? {
    stepIndex: -1,
    description: 'test setup',
    status: 'failed',
    durationMs: 0,
  };
}

function kanitYolu(kaynakDizini: string, kanit: BeyindenGelenHataAnalizi['evidence'][number]): string | null {
  switch (kanit.kind) {
    case 'screenshot':
      return join(kaynakDizini, `adim-${kanit.stepIndex}.png`);
    case 'snapshot':
      return join(kaynakDizini, `adim-${kanit.stepIndex}.html`);
    case 'console':
      return join(kaynakDizini, 'console.json');
    case 'network':
      return join(kaynakDizini, 'network.json');
    case 'log':
      return null;
  }
}

type KanitAdayi = { kanit: Kanit; kaynak: string };

/** Pakete giren kanıt sayısı sınırı; beyin şeması da 6 madde istiyor. */
const KANIT_SINIRI = 6;
const YEREL_KANIT_TANIMLARI = [
  { kind: 'screenshot', uzanti: 'png', summary: 'screenshot of the failing step' },
  { kind: 'snapshot', uzanti: 'html', summary: 'DOM snapshot of the failing step' },
] as const;

/** Düşen adımın png/html kanıtlarını toplar; beyin anmasa bile pakete girmeleri gerekir. */
async function yerelDusenAdimKanitlari(kosuDizini: string, stepIndex: number): Promise<KanitAdayi[]> {
  const adaylar: KanitAdayi[] = [];
  for (const tanim of YEREL_KANIT_TANIMLARI) {
    const hedefAd = `adim-${stepIndex}.${tanim.uzanti}`;
    const kaynak = join(kosuDizini, hedefAd);
    if (!(await dosyaVarMi(kaynak))) continue;
    adaylar.push({ kanit: { kind: tanim.kind, stepIndex, path: hedefAd, summary: tanim.summary }, kaynak });
  }
  return adaylar;
}

/**
 * Aynı `kind`+`path` çiftini tek maddede toplar: beyin aynı dosya için birden
 * çok madde yazdığında (gerçek koşuda `adim-0.html` dört kez) paket tekrar
 * dolmasın. Özetler "; " ile birleşir, ilk maddenin sırası korunur.
 */
export function kanitlariTekille(adaylar: KanitAdayi[]): KanitAdayi[] {
  const sirali: KanitAdayi[] = [];
  const siralar = new Map<string, number>();
  for (const aday of adaylar) {
    const anahtar = `${aday.kanit.kind}|${aday.kanit.path}`;
    const sira = siralar.get(anahtar);
    if (sira === undefined) {
      siralar.set(anahtar, sirali.length);
      sirali.push(aday);
      continue;
    }
    const mevcut = sirali[sira];
    if (mevcut === undefined) continue;
    const yeniOzet = aday.kanit.summary.trim();
    const ozetler = mevcut.kanit.summary.split('; ').map((ozet) => ozet.trim());
    if (yeniOzet === '' || ozetler.includes(yeniOzet)) continue;
    sirali[sira] = {
      ...mevcut,
      kanit: {
        ...mevcut.kanit,
        summary: mevcut.kanit.summary.trim() === ''
          ? yeniOzet
          : `${mevcut.kanit.summary.trim()}; ${yeniOzet}`,
      },
    };
  }
  return sirali;
}

/** Yerel zorunlu kanıtları ekler; sınır aşılırsa yerelden değil, beyninkilerden kırpar. */
function kanitlariBirlestir(beyinKanitlari: KanitAdayi[], yerelKanitlar: KanitAdayi[]): KanitAdayi[] {
  const korunan = [...beyinKanitlari];
  const eksikYereller = (): KanitAdayi[] => yerelKanitlar.filter(
    (aday) => !korunan.some((mevcut) => mevcut.kanit.path === aday.kanit.path),
  );
  while (korunan.length > 0 && korunan.length + eksikYereller().length > KANIT_SINIRI) korunan.pop();
  return [...korunan, ...eksikYereller()];
}

/** DOM'u analize uygun, kısa ve görünür içerikle sınırlar. */
export function domTemizle(html: string, maxKarakter = 30_000): string {
  const temiz = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/<[^>]+>/g, (etiket) => etiket.replace(/\s(?:class|data-[\w-]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, ''))
    .replace(/\s+/g, ' ')
    .trim();

  return temiz.length > maxKarakter ? `${temiz.slice(0, maxKarakter)}…[truncated]` : temiz;
}

/** Başarısız koşunun kanıtlarını beyinle yorumlayıp atomik hata paketi olarak yazar. */
export async function hataAnalizEt(
  beyin: Beyin,
  dizin: KobayDizini,
  test: TestKaydi,
  sonuc: KosuSonucu,
  adimlar: AdimSonucu[],
  s?: { logDizini?: string },
): Promise<HataPaketi> {
  if (sonuc.status !== 'failed' && sonuc.verdict !== 'failed') {
    throw new Error('Failure analysis only runs for a failed run');
  }

  const kosuDizini = await dizin.kosuDizini(sonuc.runId);
  const dusenAdim = dusenAdimiBul(sonuc, adimlar);
  const ekranGoruntusuYolu = join(kosuDizini, `adim-${dusenAdim.stepIndex}.png`);
  const domYolu = join(kosuDizini, `adim-${dusenAdim.stepIndex}.html`);
  const [dom, konsolMetni, agMetni, kod] = await Promise.all([
    istegeBagliOku(domYolu),
    istegeBagliOku(join(kosuDizini, 'console.json')),
    istegeBagliOku(join(kosuDizini, 'network.json')),
    dizin.kodOku(test.id),
  ]);
  const konsolHatalari = jsonDizisiOku<KonsolKaydi>(konsolMetni)
    .filter((kayit) => kayit.tip === 'error')
    .slice(0, 20)
    .map((kayit) => ({ ...kayit, metin: gizliDegerleriMaskele(kayit.metin) }));
  const agHatalari = jsonDizisiOku<AgKaydi>(agMetni)
    .filter((kayit) => kayit.hata !== undefined || (kayit.status !== undefined && kayit.status >= 400))
    .slice(0, 20)
    .map((kayit) => ({
      ...kayit,
      url: gizliDegerleriMaskele(kayit.url),
      ...(kayit.hata === undefined ? {} : { hata: gizliDegerleriMaskele(kayit.hata) }),
    }));
  const adimlariTemizle = adimlar.map((adim) => ({
    ...adim,
    ...(adim.errorMessage === undefined ? {} : {
      errorMessage: gizliDegerleriMaskele(hataMesajiniTemizle(adim.errorMessage)),
    }),
  }));
  const maskeliDusenAdim: AdimSonucu = {
    ...dusenAdim,
    ...(dusenAdim.errorMessage === undefined ? {} : {
      errorMessage: gizliDegerleriMaskele(hataMesajiniTemizle(dusenAdim.errorMessage)),
    }),
  };
  const maskeliHataMetni = gizliDegerleriMaskele(hataMesajiniTemizle(
    dusenAdim.errorMessage ?? sonuc.errorMessage ?? 'No error message',
  ));
  const maskeliDom = dom === null ? null : gizliDegerleriMaskele(dom);
  const haritaFarki = await haritaFarkiHazirla(dizin, test, maskeliDom);

  const beyinYaniti = await beyin.sor<BeyindenGelenHataAnalizi>({
    gorev: `analiz-${test.id}`,
    sistem: analizSistemIstemiOlustur(),
    kullanici: analizKullaniciIstemiOlustur({
      dusenAdim: maskeliDusenAdim,
      hataMetni: maskeliHataMetni,
      ekranGoruntusu: { varMi: await dosyaVarMi(ekranGoruntusuYolu), yol: ekranGoruntusuYolu },
      dom: maskeliDom === null ? null : domTemizle(maskeliDom),
      konsolHatalari,
      agHatalari,
      kod: gizliDegerleriMaskele(kod ?? ''),
      test,
      ...(haritaFarki === undefined ? {} : { mapDiff: haritaFarki }),
    }),
    sema: BeyindenGelenHataAnaliziSemasi,
    logDizini: s?.logDizini ?? kosuDizini,
  });

  const beyinKanitlari: KanitAdayi[] = [];
  for (const kanit of beyinYaniti.json.evidence) {
    const kaynak = kanitYolu(kosuDizini, kanit);
    if (kaynak === null || !(await dosyaVarMi(kaynak))) continue;
    beyinKanitlari.push({ kanit: { ...kanit, path: kaynak.slice(kaynak.lastIndexOf('/') + 1) }, kaynak });
  }
  const secilenKanitlar = kanitlariBirlestir(
    kanitlariTekille(beyinKanitlari),
    await yerelDusenAdimKanitlari(kosuDizini, dusenAdim.stepIndex),
  );

  const ekDosyalar: Array<{ kaynak: string; hedefAd: string }> = [];
  const eklenenHedefler = new Set<string>();
  const kanitlar: Kanit[] = [];
  for (const aday of secilenKanitlar) {
    if (!eklenenHedefler.has(aday.kanit.path)) {
      ekDosyalar.push({ kaynak: aday.kaynak, hedefAd: aday.kanit.path });
      eklenenHedefler.add(aday.kanit.path);
    }
    kanitlar.push(aday.kanit);
  }
  const traceYolu = join(kosuDizini, 'trace.zip');
  if (await dosyaVarMi(traceYolu)) ekDosyalar.push({ kaynak: traceYolu, hedefAd: 'trace.zip' });

  const failure = kodDuzeltmeIpucuEkle(yerelHaritaEmniyeti(
    { ...beyinYaniti.json, evidence: kanitlar },
    haritaFarki,
    maskeliDusenAdim.stepIndex,
    maskeliHataMetni,
    kod ?? '',
  ), maskeliHataMetni);
  const temizSonuc = sonuc.errorMessage === undefined ? sonuc : {
    ...sonuc,
    errorMessage: gizliDegerleriMaskele(hataMesajiniTemizle(sonuc.errorMessage)),
  };
  const paket: HataPaketi = {
    snapshotId: `${sonuc.runId}-${randomUUID().slice(0, 8)}`,
    testId: test.id,
    runId: sonuc.runId,
    // Paketteki koşu kopyası da sınıfı taşısın; runs/<id>/result.json'ı CLI ayrıca günceller.
    result: { ...temizSonuc, failureKind: failure.failureKind },
    steps: adimlariTemizle,
    code: kod ?? '',
    failure,
    ...(haritaFarki === undefined ? {} : { mapDiff: haritaFarki }),
  };
  await dizin.hataPaketiYaz(paket, ekDosyalar);
  return paket;
}

export { analizKullaniciIstemiOlustur, analizSistemIstemiOlustur } from './istem.js';
export { BeyindenGelenHataAnaliziSemasi } from './sema.js';
export { domHaritaFarkiOlustur, haritaFarkiHesapla } from './harita-farki.js';
export type { AnalizIstemBaglami } from './istem.js';
export type { BeyindenGelenHataAnalizi, BeyindenGelenKanit } from './sema.js';
