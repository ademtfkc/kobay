import { access, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Beyin } from '../beyin/index.js';
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

const GIZLI_AD_DESENI = String.raw`(?:parola|password|token|secret|authorization|api[_ -]?key)`;
const TIRNAKLI_JSON_DESENI = new RegExp(String.raw`("${GIZLI_AD_DESENI}"\s*:\s*")[^"]*(")`, 'gi');
const ANAHTAR_DEGER_DESENI = new RegExp(String.raw`((?:${GIZLI_AD_DESENI})\s*[:=]\s*["']?)([^\s,;"']+)(["']?)`, 'gi');
const BEARER_DESENI = /\b(Bearer\s+)[A-Za-z0-9._-]+/gi;
const BASIC_DESENI = /\b(Basic\s+)[A-Za-z0-9+/=]+/gi;
const URL_GIZLI_PARAMETRE_DESENI = /([?&](?:token|api[_-]?key|password|parola|secret)=)[^&#\s]+/gi;

function gizliDegerleriMaskele(metin: string): string {
  return metin
    .replace(TIRNAKLI_JSON_DESENI, '$1[maskelendi]$2')
    .replace(BEARER_DESENI, '$1[maskelendi]')
    .replace(BASIC_DESENI, '$1[maskelendi]')
    .replace(URL_GIZLI_PARAMETRE_DESENI, '$1[maskelendi]')
    .replace(ANAHTAR_DEGER_DESENI, '$1[maskelendi]$3');
}

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
  return temiz === '' ? 'Kobay test yürütücüsünde hata oluştu.' : temiz;
}

const IC_ALAN_KARSILIKLARI: Array<[RegExp, string]> = [
  [/sayfaKimligiUyusuyor\s*[:=]\s*false/gi, 'güncel DOM keşifteki sayfa kimliğiyle uyuşmuyor'],
  [/sayfaKimligiUyusuyor\s*[:=]\s*true/gi, 'güncel DOM keşifteki sayfa kimliğiyle uyuşuyor'],
  [/degisti\s*[:=]\s*false/gi, 'keşif haritasında görünür öğe farkı yok'],
  [/degisti\s*[:=]\s*true/gi, 'keşif haritasında görünür öğe farkı var'],
  [/\bharitaFarki\b/g, 'keşif haritası kıyası'],
  [/\bsayfaKimligiUyusuyor\b/g, 'sayfa kimliği doğrulaması'],
  [/\bdegisti\b/g, 'sayfa haritası değişikliği'],
  [/\beklenenBasliklar\b/g, 'yeni görünen başlıklar'],
  [/\bsilinenBasliklar\b/g, 'artık görünmeyen başlıklar'],
  [/\beklenenDugmeler\b/g, 'yeni görünen düğmeler'],
  [/\bsilinenDugmeler\b/g, 'artık görünmeyen düğmeler'],
  [/\beklenenFormAlanlari\b/g, 'yeni görünen form alanları'],
  [/\bsilinenFormAlanlari\b/g, 'artık görünmeyen form alanları'],
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
  if (/ürün (?:kaynak )?kodunda.*\bara(?:yın|mak)/i.test(temiz.recommendedFixTarget.rationale)) return temiz;
  const received = /Received(?: string)?:\s*(?:\n\s*)?([^\n]+)/i.exec(hataMetni)?.[1]?.trim();
  const aranacak = received === undefined || received === ''
    ? 'hata mesajındaki "Received" değerini veya metnini'
    : `hata mesajının "Received" bölümündeki ${received.slice(0, 160)} metnini`;
  return {
    ...temiz,
    recommendedFixTarget: {
      ...temiz.recommendedFixTarget,
      rationale: `${temiz.recommendedFixTarget.rationale} Kaynak dosyayı bulmak için ürün kodunda ${aranacak} arayın.`,
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
  process.stderr.write(`[kobay analiz] ${mesaj}\n`);
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
      analizUyarisiYaz('Keşif haritası yok; harita kıyası atlandı.');
      return undefined;
    }
    if (test.url === undefined) {
      analizUyarisiYaz(`Test URL'si yok (${test.id}); harita kıyası atlandı.`);
      return undefined;
    }
    const testYolu = urlYolu(test.url, harita.baseUrl);
    const haritaSayfasi = testYolu === null
      ? undefined
      : harita.sayfalar.find((sayfa) => urlYolu(sayfa.url, harita.baseUrl) === testYolu);
    if (haritaSayfasi === undefined) {
      analizUyarisiYaz(`Test sayfası keşif haritasında yok (${test.url}); harita kıyası atlandı.`);
      return undefined;
    }
    if (dom === null) {
      analizUyarisiYaz(`Düşen adımın DOM dosyası yok (${test.id}); harita kıyası atlandı.`);
      return undefined;
    }
    return await domHaritaFarkiOlustur(dom, haritaSayfasi, new URL(harita.baseUrl).origin);
  } catch (hata) {
    analizUyarisiYaz(`Harita kıyası yapılamadı; eski analiz akışı sürdürüldü: ${String(hata).split('\n')[0] ?? 'bilinmeyen hata'}`);
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
    { silinenler: fark.silinenBasliklar, eklenenler: fark.eklenenBasliklar },
    { silinenler: fark.silinenDugmeler, eklenenler: fark.eklenenDugmeler },
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
  if (fark !== undefined && !fark.sayfaKimligiUyusuyor) return analiz;
  const eslesme = urunDegisikligiEslesmesi(fark, stepIndex, hataMetni, kod);
  if (eslesme === null || fark === undefined) return analiz;
  return {
    ...analiz,
    rootCauseHypothesis: `Yerel harita kıyası: "${eslesme.eski}" keşifte vardı, şimdi yok. ${analiz.rootCauseHypothesis}`,
    failureKind: 'product_changed',
    recommendedFixTarget: {
      kind: 'code',
      reference: `${fark.url}: "${eslesme.eski}" → "${eslesme.yeni}"`,
      rationale: 'Keşif haritası bayatlamış; keşif yenilenip test yeniden üretilmeli.',
    },
  };
}

function dusenAdimiBul(sonuc: KosuSonucu, adimlar: AdimSonucu[]): AdimSonucu {
  if (sonuc.failedStepIndex !== undefined) {
    return adimlar.find((adim) => adim.stepIndex === sonuc.failedStepIndex) ?? {
      stepIndex: sonuc.failedStepIndex,
      description: 'Kaydedilmemiş düşen adım',
      status: 'failed',
      durationMs: 0,
    };
  }
  return adimlar.filter((adim) => adim.status === 'failed').at(-1) ?? {
    stepIndex: -1,
    description: 'test kurulumu',
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
  { kind: 'screenshot', uzanti: 'png', summary: 'düşen adımın ekran görüntüsü' },
  { kind: 'snapshot', uzanti: 'html', summary: 'düşen adımın DOM kopyası' },
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

  return temiz.length > maxKarakter ? `${temiz.slice(0, maxKarakter)}…[kesildi]` : temiz;
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
    throw new Error('Hata analizi yalnız düşen koşu için yapılır');
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
    dusenAdim.errorMessage ?? sonuc.errorMessage ?? 'Hata metni yok',
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
      ...(haritaFarki === undefined ? {} : { haritaFarki }),
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
    ...(haritaFarki === undefined ? {} : { haritaFarki }),
  };
  await dizin.hataPaketiYaz(paket, ekDosyalar);
  return paket;
}

export { analizKullaniciIstemiOlustur, analizSistemIstemiOlustur } from './istem.js';
export { BeyindenGelenHataAnaliziSemasi } from './sema.js';
export { domHaritaFarkiOlustur, haritaFarkiHesapla } from './harita-farki.js';
export type { AnalizIstemBaglami } from './istem.js';
export type { BeyindenGelenHataAnalizi, BeyindenGelenKanit } from './sema.js';
