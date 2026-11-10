/**
 * 0.1 sürümünün Türkçe JSON alan adlarını okurken yeni İngilizce adlara eşler.
 *
 * Yazım her zaman yeni adla yapılır; bu dosya yalnız okuma toleransıdır. Desen
 * `src/plan/sema.ts`'deki `anahtarlariNormallestir`'den genelleştirildi: orada
 * beynin ürettiği yanıt, burada diskteki kalıcı dosya eşleniyor.
 *
 * Eşleme özyinelemelidir (harita → sayfalar → formlar → alanlar gibi iç içe
 * nesnelerde de çalışsın diye) ve eski anahtarı silmez: yeni anahtar zaten
 * varsa dokunulmaz, yoksa eskisinin değeriyle eklenir. Şemalar `v.object`
 * olduğu için artan eski anahtarlar doğrulamada zaten düşer.
 */
export type AnahtarTablosu = Readonly<Record<string, string>>;

/** Kalıcı `.kobay` dosyalarındaki bütün eski→yeni alan adları (0.1 → 0.2). */
export const KALICI_ANAHTARLAR: AnahtarTablosu = {
  // Harita
  girisYapildi: 'loggedIn',
  sayfalar: 'pages',
  kesifTarihi: 'exploredAt',
  // Sayfa
  baslik: 'title',
  basliklar: 'headings',
  linkler: 'links',
  formlar: 'forms',
  dugmeler: 'buttons',
  // Form / FormAlani
  alanlar: 'fields',
  ad: 'name',
  tip: 'type',
  etiket: 'label',
  // HaritaFarki
  eklenenBasliklar: 'addedHeadings',
  silinenBasliklar: 'removedHeadings',
  eklenenDugmeler: 'addedButtons',
  silinenDugmeler: 'removedButtons',
  eklenenFormAlanlari: 'addedFormFields',
  silinenFormAlanlari: 'removedFormFields',
  sayfaKimligiUyusuyor: 'pageIdentityMatches',
  degisti: 'changed',
  // HataPaketi
  haritaFarki: 'mapDiff',
  // Kimlik
  kullanici: 'username',
  parola: 'password',
  // KobayConfig
  beyin: 'brain',
  // meta.json
  yazildi: 'writtenAt',
  // Kimlik işlemi işareti (.credentials-txn)
  islemId: 'txnId',
  baslatildi: 'startedAt',
  eskiConfig: 'previousConfig',
  yeniKimlikYazilacak: 'willWriteNewCredentials',
  kenaraAlinanlar: 'setAside',
};

function duzNesneMi(deger: unknown): deger is Record<string, unknown> {
  return typeof deger === 'object' && deger !== null && !Array.isArray(deger);
}

/**
 * Verilen tabloyu değerin tamamına özyinelemeli uygular. Diziler eleman eleman
 * gezilir; ilkel değerlere dokunulmaz. Eski anahtar yenisine TAŞINIR (kopya
 * bırakılmaz): dönüşümün çıktısı yerinde göçte diske de yazıldığı için çift
 * anahtarlı dosya kalmamalı. İkisi birden yazılmış bir dosyada yeni ad kazanır.
 */
export function eskiAnahtarlariEsle(tablo: AnahtarTablosu): (deger: unknown) => unknown {
  const uygula = (deger: unknown): unknown => {
    if (Array.isArray(deger)) return deger.map(uygula);
    if (!duzNesneMi(deger)) return deger;
    const sonuc: Record<string, unknown> = {};
    for (const [anahtar, ic] of Object.entries(deger)) sonuc[anahtar] = uygula(ic);
    for (const [eski, yeni] of Object.entries(tablo)) {
      if (!(eski in sonuc)) continue;
      if (sonuc[yeni] === undefined) sonuc[yeni] = sonuc[eski];
      delete sonuc[eski];
    }
    return sonuc;
  };
  return uygula;
}

/** Kalıcı dosya şemalarının önüne konan tek dönüşüm. */
export const kalicidanEsle = eskiAnahtarlariEsle(KALICI_ANAHTARLAR);

/** Değerde göç edilecek eski bir anahtar var mı? Dosyayı yeniden yazmaya değer mi diye sorulur. */
export function eskiAnahtarVarMi(deger: unknown, tablo: AnahtarTablosu = KALICI_ANAHTARLAR): boolean {
  if (Array.isArray(deger)) return deger.some((oge) => eskiAnahtarVarMi(oge, tablo));
  if (!duzNesneMi(deger)) return false;
  if (Object.keys(tablo).some((eski) => eski in deger)) return true;
  return Object.values(deger).some((ic) => eskiAnahtarVarMi(ic, tablo));
}

/**
 * `.kimlik-islemi` gövdesinde kullanılan YENİ→ESKİ alan adları: yukarıdaki
 * tablonun ilgili satırlarının tersi.
 *
 * Kimlik işlemi kilidi uyumluluk döneminde iki adla birden tutulur. Yeni ad
 * (`.credentials-txn`) yalnız 0.2'yi ilgilendirir ve İngilizce yazılır; eski adı
 * 0.1 de okur ve KENDİ Türkçe şemasıyla doğrular. Eski ada İngilizce gövde
 * yazarsak 0.1 işareti geçersiz sayar, siler ve aynı projede ikinci bir kimlik
 * işlemi başlatır — kilit hiç yokmuş gibi olur. Bu yüzden eski ada eski şema
 * yazılır.
 *
 * Tablo bilerek dar tutuldu: `KALICI_ANAHTARLAR`ın tamamını tersine çevirmek
 * işaretle ilgisi olmayan adları da (`name`, `type`, `title`…) vururdu.
 * `brain` burada: işaretteki config anlık görüntüsü de 0.1'in
 * `KobayConfigSemasi`'sinden geçer ve orada `beyin` zorunlu alandır.
 */
export const ISARET_ESKI_ANAHTARLARI: AnahtarTablosu = {
  txnId: 'islemId',
  startedAt: 'baslatildi',
  previousConfig: 'eskiConfig',
  willWriteNewCredentials: 'yeniKimlikYazilacak',
  setAside: 'kenaraAlinanlar',
  brain: 'beyin',
};

/** İşaret kaydını 0.1'in Türkçe şemasına çevirir (`kalicidanEsle`nin tersi). */
export const eskiIsaretineEsle = eskiAnahtarlariEsle(ISARET_ESKI_ANAHTARLARI);

/**
 * Yol-duyarlı eşleme tablosu: `anahtarlar` bu düzeydeki eski→yeni adlar,
 * `alt` YENİ adı verilen alanın içine (dizi ise her elemanına) uygulanacak
 * tablo. Tabloda olmayan hiçbir alt nesneye inilmez.
 */
export interface YolluTablo {
  readonly anahtarlar?: AnahtarTablosu;
  readonly alt?: Readonly<Record<string, YolluTablo>>;
}

/**
 * Sürüm göçünün (0→1) 0.1 ad eşlemesi. `eskiAnahtarlariEsle`'den farkı:
 * yalnız 0.1'in gerçekten yazdığı yollara uygulanır. Böylece diske yazılan
 * göçte şemanın tanımadığı alt nesneler (ör. `extensionData.ad`) yeniden
 * adlandırılmaz, olduğu gibi kalır. Eski anahtar yenisine TAŞINIR; ikisi
 * birden varsa yeni ad kazanır.
 */
export function yolluEsle(tablo: YolluTablo): (deger: unknown) => unknown {
  const uygula = (deger: unknown, duzey: YolluTablo): unknown => {
    if (Array.isArray(deger)) return deger.map((oge) => uygula(oge, duzey));
    if (!duzNesneMi(deger)) return deger;
    const sonuc: Record<string, unknown> = { ...deger };
    for (const [eski, yeni] of Object.entries(duzey.anahtarlar ?? {})) {
      if (!(eski in sonuc)) continue;
      if (sonuc[yeni] === undefined) sonuc[yeni] = sonuc[eski];
      delete sonuc[eski];
    }
    for (const [ad, altTablo] of Object.entries(duzey.alt ?? {})) {
      if (ad in sonuc) sonuc[ad] = uygula(sonuc[ad], altTablo);
    }
    return sonuc;
  };
  return (deger) => uygula(deger, tablo);
}

const FORM_ALANI_YOLLARI: YolluTablo = { anahtarlar: { ad: 'name', tip: 'type', etiket: 'label' } };
const SAYFA_YOLLARI: YolluTablo = {
  anahtarlar: { baslik: 'title', basliklar: 'headings', linkler: 'links', formlar: 'forms', dugmeler: 'buttons' },
  alt: { forms: { anahtarlar: { alanlar: 'fields' }, alt: { fields: FORM_ALANI_YOLLARI } } },
};
const HARITA_FARKI_YOLLARI: YolluTablo = {
  anahtarlar: {
    eklenenBasliklar: 'addedHeadings',
    silinenBasliklar: 'removedHeadings',
    eklenenDugmeler: 'addedButtons',
    silinenDugmeler: 'removedButtons',
    eklenenFormAlanlari: 'addedFormFields',
    silinenFormAlanlari: 'removedFormFields',
    sayfaKimligiUyusuyor: 'pageIdentityMatches',
    degisti: 'changed',
  },
};

/** Dosya başına 0.1 yolları: `KALICI_ANAHTARLAR`'ın kalıcı dosya satırları, bulundukları yerle. */
export const ESKI_YOLLAR: Readonly<Record<'config' | 'kimlik' | 'harita' | 'hataPaketi' | 'meta', YolluTablo>> = {
  config: { anahtarlar: { beyin: 'brain' } },
  kimlik: { anahtarlar: { kullanici: 'username', parola: 'password' } },
  harita: {
    anahtarlar: { girisYapildi: 'loggedIn', sayfalar: 'pages', kesifTarihi: 'exploredAt' },
    alt: { pages: SAYFA_YOLLARI },
  },
  hataPaketi: { anahtarlar: { haritaFarki: 'mapDiff' }, alt: { mapDiff: HARITA_FARKI_YOLLARI } },
  meta: { anahtarlar: { yazildi: 'writtenAt' } },
};
