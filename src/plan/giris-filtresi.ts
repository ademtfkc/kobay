import type { PlanAdimi } from '../depo/index.js';

/**
 * Giriş yapılandırılmış projede oturum kobay'ın giriş adımıyla zaten açılır ve üretilen
 * test gerçek kimliği yazamaz. Böyle bir adım içeren test yazılamaz; ne atlanır ne de
 * başka bir şeye çevrilir, reddedilir. Karar başlığa değil ADIMLARA bakar: bir adım
 * parola / kimlik bilgisi / gizli anahtar / PIN giriyorsa ve aynı adımda sahte değer
 * işareti (invalid, wrong, empty, fake...) yoksa test gerçek kimlik gerektirir.
 * Başlığında "login" geçen ama kimlik girmeyen test (örneğin giriş kayıtlarını görüntüleme)
 * kalır; başlığı "invalid" deyip adımında gerçek kimlik giren test düşer.
 *
 * Plan üretimi ve elle yazılan plan (`test create --plan`) aynı fonksiyonu kullanır.
 * Bilinen sınırlar: sözcük tabanlıdır (İngilizce + Türkçe) ve `replace it with hunter2` gibi tırnaksız gerçek
 * değeri yakalamaz. T2'nin doğrulama istisnası nedeniyle `Check the password "hunter2" works` kaçar.
 * `Wrong_Pass_2024` ve `badkey1` gibi yapışık değerlerin sahte sayılması bilinçli tasarımdır. Span sınıflandırması
 * 160 karakterlik yerel bağlama bakar; `Type the password that reads "hunter2" with a wrong username` gibi yapay
 * bir yazımda `reads` değeri ekran metni saydırabilir. Başka alışılmadık ifadeyi kaçırırsa kod üretim istemi o
 * adımı `throw` ile düşürtür, sessizce geçmez.
 */
/** T1: yalnız açıkça bir değer giren fiiller. Değiştirme/kullanma fiilleri bu ana tetiğe dahil değildir. */
const ACIK_GIRIS_FIILI_EN = String.raw`\b(?:enter(?:s|ed|ing)?|fill(?:s|ed|ing)?|typ(?:e|es|ed|ing)|input(?:s|ted|ting)?|provid(?:e|es|ed|ing)|submit(?:s|ted|ting)?|past(?:e|es|ed|ing)|put(?:s|ting)?|writ(?:e|es|ing|ten)|wrote|populat(?:e|es|ed|ing)|insert(?:s|ed|ing)?|key(?:s|ed|ing)?\s+in|suppl(?:y|ies|ied|ying))\b`;
/** R1: gizli adı sonraki öbekte anılan değerin taşınmasını/değiştirilmesini de izler. */
const GENIS_GIRIS_FIILI_EN = String.raw`(?:${ACIK_GIRIS_FIILI_EN}|\b(?:replac(?:e|es|ed|ing)|chang(?:e|es|ed|ing)|set(?:s|ting)?|updat(?:e|es|ed|ing)|us(?:e|es|ed|ing)|overwrit(?:e|es|ing|ten)|overwrote|fix(?:es|ed|ing)?|switch(?:es|ed|ing)?|swap(?:s|ped|ping)?|modif(?:y|ies|ied|ying)|edit(?:s|ed|ing)?|correct(?:s|ed|ing)?|retr(?:y|ies|ied|ying)|re-?enter(?:s|ed|ing)?|re-?typ(?:e|es|ed|ing)|giv(?:e|es|ing)|gave|given)\b)`;
/** "Log in" tek başına düğme adı da olabilir ("Sign in button"); yalnız "with/using ... <kimlik>" kalıbında fiil sayılır. */
const GIRIS_KALIBI_EN = String.raw`\b(?:log(?:s|ged|ging)?[ -]?in|sign(?:s|ed|ing)?[ -]?in|authenticat\w*)\s+(?:with|using|by)\b`;
/** CSRF/session belirteçleri ile token UI/ömür ifadeleri kimlik değeri değildir. */
const TOKEN_SONEKI_OLMAYAN_EN = String.raw`tokens?\b(?!\s*(?:count|cookie|header|page|link|expir\w*|refresh\w*)\b)`;
const GENEL_TOKEN_EN = String.raw`(?<!csrf\s)(?<!xsrf\s)(?<!antiforgery\s)(?<!anti-forgery\s)(?<!session\s)${TOKEN_SONEKI_OLMAYAN_EN}`;
/** "password reset", "forgot password" gibi kimlik GİRMEYEN kullanımlar ad sayılmaz. */
const KIMLIK_ADI_EN = String.raw`(?<!forgot\s)(?<!forgotten\s)\b(?:passwd|pwd|pass(?=\s+(?:field|input|box)\b)|pass(?:word|words|phrase|code)|credentials?|secrets?|(?:api|access|secret)[ _-]?key|(?:api|access|secret)[ _-]?${TOKEN_SONEKI_OLMAYAN_EN}|${GENEL_TOKEN_EN}|auth(?:entication)?\s+${TOKEN_SONEKI_OLMAYAN_EN}|otp|one[ -]time\s+(?:code|password|passcode)|(?:verification|security|recovery|backup|2fa|mfa|two[ -]factor|authenticator|authentication)\s+code|pin(?:\s+code)?)\b(?!\s*(?:reset|recovery|strength|requirements?|polic(?:y|ies)|page|link|hint|expired(?:\s+message)?)\b)`;
/** T1: açık giriş fiili ve gizli ad aynı cümlede, iki sıra da tanınır. */
const KIMLIK_GIRISI_EN = new RegExp(
  `${ACIK_GIRIS_FIILI_EN}[^.!?]*${KIMLIK_ADI_EN}|${KIMLIK_ADI_EN}[^.!?]*${ACIK_GIRIS_FIILI_EN}`,
  'i',
);
const KIMLIKLE_GIRIS_KALIBI_EN = new RegExp(
  `${GIRIS_KALIBI_EN}[^.!?]*${KIMLIK_ADI_EN}|${KIMLIK_ADI_EN}[^.!?]*${GIRIS_KALIBI_EN}`,
  'i',
);
/**
 * Giriş formunu doldurmak ya da göndermek da kimlik girmektir ("Fill in the login form", "Submit the login form",
 * "Giriş formunu doldur"). Boş/sahte gönderim ("Submit the login form empty") aşağıdaki sahte işaretiyle kalır.
 */
const GIRIS_FORMU_DOLDURMA = /\b(?:fill(?:s|ed|ing)?|complet(?:e|es|ed|ing)|submit(?:s|ted|ting)?)\s+(?:in\s+|out\s+)?(?:the\s+)?(?:log[ -]?in|sign[ -]?in)\s+form\b|giriş formunu doldur|giris formunu doldur/i;
/** "Sign in as the configured administrator", "Log in as admin": bir hesapla oturum açmak kimlik girmektir. */
const HESAPLA_GIRIS_EN = /\b(?:log(?:s|ged|ging)?|sign(?:s|ed|ing)?)[ -]?in\s+as\b/i;
/**
 * "Verify the header shows "Signed in as demo@example.com"", "Check that the banner reads Logged in as admin":
 * aynı cümlede ÖNCE gelen doğrulama sözcüğü ya da tırnak içi metin, "… in as" ifadesini ekrandaki yazı yapar.
 * "Log in as admin and verify the dashboard" gerçek girişte kalır (doğrulama sonra geliyor).
 */
const DOGRULAMA_ISARETI = /\b(?:verif(?:y|ies|ied)|check(?:s|ed)?|asserts?|expects?|confirms?|sees?|shows?|showing|shown|reads?|reading|displays?|displayed|contains?|header|banner|heading|text|message|label|greeting|title|visible)\b/i;

/** "… in as" ifadesi bir eylem mi (hesapla oturum aç), yoksa doğrulanan ekran metni mi? */
function hesaplaGirisEylemMi(aciklama: string): boolean {
  const eslesme = HESAPLA_GIRIS_EN.exec(aciklama);
  if (eslesme === null) return false;
  const once = aciklama.slice(0, eslesme.index);
  const cumle = once.split(/[.;!?](?:\s|$)/).at(-1) ?? '';
  return !DOGRULAMA_ISARETI.test(cumle);
}
/** JS `\b` Türkçe harfleri tanımaz; sözcük sınırı elle. */
const TR_HARF = 'a-zçğıöşü';
const KIMLIK_ADI_TR = String.raw`(?:şifre|sifre|parola|kimlik bilgi|giriş bilgi|giris bilgi|gizli anahtar|gizli değer|gizli deger|erişim token|erisim token|(?<![${TR_HARF}])token['’]?(?:ını|ini|unu|ünü|ın|in|un|ün|ı|i|u|ü)(?![${TR_HARF}])|doğrulama kodu|dogrulama kodu|tek kullanımlık|tek kullanimlik|güvenlik kodu|guvenlik kodu|\bPIN\b|pin kod)`;
const TR_FIIL_EKI = '(?:in|iniz|ın|ınız|un|unuz|ün|ünüz|ip|ıp|up|üp|erek|arak|ilir|ılır|ulur|ülür|di|dı|du|dü|miş|mış|muş|müş|iyor|ıyor|uyor|üyor)?';
const ACIK_GIRIS_FIILI_TR = `(?<![${TR_HARF}])(?:(?:gir|yaz|doldur|yerleştir|yerlestir)${TR_FIIL_EKI}|giriş yap|giris yap|oturum aç|oturum ac)(?![${TR_HARF}])`;
const GENIS_GIRIS_FIILI_TR = `(?<![${TR_HARF}])(?:(?:gir|yaz|doldur|değiştir|degistir|yerleştir|yerlestir|kullan|düzelt|duzelt)${TR_FIIL_EKI}|giriş yap|giris yap|oturum aç|oturum ac)(?![${TR_HARF}])`;
const KIMLIK_GIRISI_TR = new RegExp(
  `${KIMLIK_ADI_TR}[^.!?]*${ACIK_GIRIS_FIILI_TR}|${ACIK_GIRIS_FIILI_TR}[^.!?]*${KIMLIK_ADI_TR}`, 'i',
);
/** JS `\b` yalnız ASCII harf tanır ("wrongÅngström" sınır sanılır); sözcük sınırı Unicode harf/rakamla elle çizilir. */
const ONCESI_HARF_DEGIL = String.raw`(?<![\p{L}\p{N}])`;
const SONRASI_HARF_DEGIL = String.raw`(?![\p{L}\p{N}])`;
/**
 * "without" tek başına sahte işareti değildir ("Enter the password without changing the username" gerçek şifre
 * ister); yalnız kimlik yokluğu yapısında sayılır: "without a password", "without entering the password".
 */
const KIMLIK_YOKLUGU_EN = String.raw`without(?:\s+(?:a|an|the|any))?\s+(?:pass(?:word|words|phrase|code)|credentials?|secrets?|(?:(?:api|access|secret)[ _-]?)?(?:key|token)s?|pin(?:\s+code)?|values?|log[ -]?in|entering|typing|filling)`;
/** Adımın sahte/geçersiz değer girdiğini söyleyen işaretler: bunlar gerçek kimlik gerektirmez. */
const SAHTE_DEGER_ISARETI = new RegExp(
  `${ONCESI_HARF_DEGIL}(?:invalid|incorrect|wrong|bad|empty|blank|fake|dummy|bogus|random|made[ -]up|nonexistent|non-existent|unknown|expired|mismatch\\p{L}*|${KIMLIK_YOKLUGU_EN})${SONRASI_HARF_DEGIL}`
  + `|geçersiz|gecersiz|yanlış|yanlis|${ONCESI_HARF_DEGIL}boş|${ONCESI_HARF_DEGIL}bos${SONRASI_HARF_DEGIL}|sahte|hatalı|hatali|rastgele|olmayan|uydurma`,
  'iu',
);
/** Sahte işaretinin bir kimlik adına ait sayılacağı öbek: bağlaç ya da noktalama öbeği böler. */
const OBEK_SINIRI = /\b(?:and|then|but|while)\b|[,;.!?]/i;
const KIMLIK_ADI = `(?:${KIMLIK_ADI_EN}|${KIMLIK_ADI_TR})`;
const KIMLIK_ADI_TUMU = new RegExp(KIMLIK_ADI, 'giu');
const KIMLIK_ADI_VAR = new RegExp(KIMLIK_ADI, 'iu');
/**
 * Tırnak sayılan her karakter: düz, ters, akıllı ve köşeli tırnaklar. Öbekte bunlardan biri (ya da ters bölü)
 * varsa karar YALNIZ tırnaklı değer kuralından gelir; "Type 'hunter2' into the password field without clearing it"
 * içindeki "without" gibi genel sahte işareti tırnaklı gerçek değeri aklayamaz.
 */
const ZEHIRLI_TIRNAK = /[′-‷´‟「-』〝-〟❝❞ʹ-ʽˈ˝]/u;
const TIRNAK_KARAKTERI = /["'`‘’‛“”«»„‚‹›＂＇′-‷´‟「-』〝-〟❝❞ʹ-ʽˈ˝]/u;
const BICIM_KARAKTERI_VAR = /\p{Cf}/u;
const BICIM_KARAKTERLERI = /\p{Cf}/gu;
/**
 * Aynı düz tırnakla açılıp kapanan, boş olmayan ve ters bölüsüz değer: "Type 'wrongpassword' into the password field".
 * Akıllı tırnak, eşi olmayan tırnak, boş tırnak (`''`) ya da kaçışlı değer (`'wrong\'password'`) değer sayılmaz;
 * geride tırnak kaldığı için tetiklenmiş adım düşer. Boşluklu düğme etiketleri de burada maskelenir.
 */
const DEGER_YER_TUTUCU = new RegExp(String.raw`\u0000(\d+)\u0000`, 'gu');
const DEGER_YER_TUTUCU_ILK = new RegExp(String.raw`\u0000\d+\u0000`, 'u');
const YAPISIK_SAHTE_KOK = '(?:invalid|incorrect|wrong|bad|fake|dummy|bogus|yanlış|yanlis|geçersiz|gecersiz|sahte|hatalı|hatali)';
/** Sahte kökün yapıştığı kimlik parçası: "wrongpassword", "badpass", "passwordfake". */
const YAPISIK_KIMLIK_PARCASI = '(?:pass(?:word|wd|code|phrase)?|pwd|pw|secret|pin|key|token|cred(?:ential)?s?|login|user(?:name)?|value|input|şifre|sifre|parola)';
/** Kökün yanında durabilecek tek parça: kimlik sözcüğü, ayraç (`_ - .`) ya da tek rakam. */
const YAPISIK_YAN_PARCA = `(?:${YAPISIK_KIMLIK_PARCASI}|[-_.]|[0-9])`;
/**
 * Genel değer TAMAMEN sahte kök, kimlik sözcüğü, ayraç ve rakamlardan kurulur. "not" ise ayrı ve dar bir
 * gramerdir: yalnız izinli dolguların ardından bir kimlik parçasıyla biter; serbest harf kalırsa gerçek sayılır.
 */
const YAPISIK_SAHTE_DEGER = new RegExp(
  `^${YAPISIK_YAN_PARCA}*${YAPISIK_SAHTE_KOK}(?:${YAPISIK_SAHTE_KOK}|${YAPISIK_YAN_PARCA})*$`,
  'iu',
);
const NOT_SAHTE_DEGER = new RegExp(
  `^not(?:[-_.]?(?:the|a|an|my|your|our|real|actual|correct|right|valid|true|good))*[-_.]?${YAPISIK_KIMLIK_PARCASI}(?:[-_.]|[0-9])*$`,
  'iu',
);

/**
 * İki harf arasındaki düz ya da akıllı tek tırnak (' ’) tırnak değil kesme işaretidir ("user's", "user’s", "doesn't",
 * "kullanıcı'nın"); tırnak tespitinden ve tırnaklı değer ayrıştırmasından önce boşluğa çevrilir. Harf olmayan
 * bir yana değen tek tırnak ("'hunter2's'" içindeki "2'") kesme sayılmaz, tırnak kuralına girer.
 */
const KESME_ISARETI = /(?<=\p{L})['’](?=\p{L})/gu;
function kesmeleriAyikla(metin: string): string {
  return metin.replace(KESME_ISARETI, ' ');
}

function kontrolKarakterleriniAyikla(metin: string): { temiz: string; zehirli: boolean } {
  let zehirli = false;
  const temiz = [...metin].map((karakter) => {
    const kod = karakter.codePointAt(0) ?? 0;
    const c0 = kod <= 0x1f && kod !== 0x09 && kod !== 0x0a && kod !== 0x0d;
    const c1 = kod >= 0x7f && kod <= 0x9f;
    if (!c0 && !c1) return karakter;
    zehirli = true;
    return ' ';
  }).join('');
  return { temiz, zehirli };
}

interface HazirMetin {
  maskeli: string;
  degerler: string[];
  gecersizTirnak: boolean;
  tirnakIcindeBicimKarakteri: boolean;
}

const DUZ_TIRNAK = /["'`]/u;
const ALAN_TURU = /^\s*(?:field|input|box|textbox|text\s+box|area|textarea|alan(?:ı|ına|inda|ında)?|kutu(?:su|suna|sunda)?|girdi(?:si|sine)?)\b/iu;
const ARAYUZ_METNI_SONEKI = /^\s*(?:button|link|menu|toggle|message|label|text|heading|banner|title)\b/iu;
const ARAYUZ_METNI_ONCESI = /\b(?:click|press|tap|open|shows?|reads?|says?|displays?)\s*$/iu;
const ARAYUZ_METNI_SONRASI = /^\s*(?:appears?|is\s+visible)\b/iu;
/** Span'ın değer olduğunu kesinleştiren dar fiiller; use/submit/set/give düğme kullanımını ezmez. */
const SPAN_GIRIS_FIILI_EN = String.raw`\b(?:enter(?:s|ed|ing)?|fill(?:s|ed|ing)?|typ(?:e|es|ed|ing)|input(?:s|ted|ting)?|past(?:e|es|ed|ing)|put(?:s|ting)?|writ(?:e|es|ing|ten)|wrote|populat(?:e|es|ed|ing)|insert(?:s|ed|ing)?)\b`;
const SPAN_GIRIS_FIILI_TR = `(?<![${TR_HARF}])(?:gir|yaz|doldur|yerleştir|yerlestir)${TR_FIIL_EKI}(?![${TR_HARF}])`;
const SPAN_GIRIS_FIILI = new RegExp(`${SPAN_GIRIS_FIILI_EN}|${SPAN_GIRIS_FIILI_TR}`, 'iu');

function kimlikAlanEtiketiMi(deger: string, sonra: string): boolean {
  return KIMLIK_ADI_VAR.test(deger) && (ALAN_TURU.test(sonra) || /^\s*:/.test(sonra));
}

function arayuzMetniMi(once: string, sonra: string): boolean {
  const yerelOnce = once.split(OBEK_SINIRI).at(-1) ?? once;
  if (ARAYUZ_METNI_ONCESI.test(yerelOnce)) return true;
  if (SPAN_GIRIS_FIILI.test(yerelOnce)) return false;
  return ARAYUZ_METNI_SONEKI.test(sonra) || ARAYUZ_METNI_SONRASI.test(sonra);
}

/**
 * Düz tırnakları soldan sağa tarar. Başka tür bir tırnak kapanıştan önce gelirse span'ı
 * metnin ötesine taşımak yerine biçimi geçersiz sayar. Alan etiketleri kimlik bağlamına
 * geri yazılır; düğme/görünen metinler silinir; yalnız değerler numaralı yer tutucu olur.
 */
function duzTirnaklariSinifla(metin: string): {
  maskeli: string;
  degerler: string[];
  gecersiz: boolean;
  tirnakIcindeBicimKarakteri: boolean;
} {
  const degerler: string[] = [];
  let maskeli = '';
  let gecersiz = false;
  let tirnakIcindeBicimKarakteri = false;
  let konum = 0;

  while (konum < metin.length) {
    const acici = metin[konum]!;
    if (!DUZ_TIRNAK.test(acici)) {
      maskeli += acici;
      konum++;
      continue;
    }

    let kapanis = konum + 1;
    while (kapanis < metin.length && !DUZ_TIRNAK.test(metin[kapanis]!)) kapanis++;
    if (kapanis >= metin.length || metin[kapanis] !== acici) {
      return {
        maskeli: metin,
        degerler: [],
        gecersiz: true,
        tirnakIcindeBicimKarakteri,
      };
    }

    const deger = metin.slice(konum + 1, kapanis);
    if (deger.length === 0 || deger.includes('\\')) {
      gecersiz = true;
      maskeli += metin.slice(konum, kapanis + 1);
      konum = kapanis + 1;
      continue;
    }
    if (BICIM_KARAKTERI_VAR.test(deger)) tirnakIcindeBicimKarakteri = true;

    // Yalnız yerel sözdizimi gerekir; tam prefix/suffix dilimlemek çok-span girdisini O(n²) yapar.
    const once = metin.slice(Math.max(0, konum - 160), konum);
    const sonra = metin.slice(kapanis + 1, kapanis + 161);
    if (kimlikAlanEtiketiMi(deger, sonra)) {
      maskeli += ` ${deger} `;
    } else if (arayuzMetniMi(once, sonra)) {
      maskeli += ' ';
    } else {
      const sira = degerler.push(deger) - 1;
      maskeli += `\u0000${sira}\u0000`;
    }
    konum = kapanis + 1;
  }

  return { maskeli, degerler, gecersiz, tirnakIcindeBicimKarakteri };
}

/**
 * Düz tırnaklı değerleri önce harf ve ayraç içermeyen sıra numaralarıyla maskeler. Öbek, ad, fiil ve hedef
 * taramalarının tamamı bu metinde yapılır; gerçek değerler yalnız sahte-değer grameri için sıra numarasıyla okunur.
 */
function metniHazirla(aciklama: string): HazirMetin {
  const kesmesiz = kesmeleriAyikla(aciklama);
  const siniflanmis = duzTirnaklariSinifla(kesmesiz);
  return {
    maskeli: siniflanmis.maskeli.replace(BICIM_KARAKTERLERI, ''),
    degerler: siniflanmis.degerler,
    gecersizTirnak: siniflanmis.gecersiz
      || TIRNAK_KARAKTERI.test(siniflanmis.maskeli)
      || siniflanmis.maskeli.includes('\\'),
    tirnakIcindeBicimKarakteri: siniflanmis.tirnakIcindeBicimKarakteri,
  };
}

function degerSahteMi(deger: string): boolean {
  return YAPISIK_SAHTE_DEGER.test(deger) || NOT_SAHTE_DEGER.test(deger);
}

function obektekiDegerSiralariniBul(obek: string): number[] {
  return [...obek.matchAll(DEGER_YER_TUTUCU)].map((eslesme) => Number(eslesme[1]));
}

function obektekiDegerlerSahteMi(obek: string, degerler: readonly string[]): boolean {
  const siralar = obektekiDegerSiralariniBul(obek);
  return siralar.length > 0 && siralar.every((sira) => degerSahteMi(degerler[sira] ?? ''));
}

function obekteKimlikAdiDegeriVarMi(obek: string, degerler: readonly string[]): boolean {
  return obektekiDegerSiralariniBul(obek).some((sira) => KIMLIK_ADI_VAR.test(degerler[sira] ?? ''));
}

const OBEK_GONDERMESI = new RegExp(
  String.raw`\b(?:into|in|to|on|at|for|with|from)\s+(?:it|that|this|them|(?:the\s+)?same(?:\s+[\p{L}\p{N}_-]+){0,2})\b`
    + String.raw`|\b(?:replace|change|update|set|overwrite|fix|switch|edit|modify|correct|clear|retype|re-type|re-enter)\s+(?:it|that|this|them)\b`
    + String.raw`|\b(?:the\s+)?same\s+(?:field|input|box|place|one)\b|\bthe\s+field\b|\bin\s+there\b`,
  'iu',
);
const OBEK_GIRIS_FIILI = new RegExp(`${GENIS_GIRIS_FIILI_EN}|${GENIS_GIRIS_FIILI_TR}`, 'iu');
const ARAYUZ_FIILI_EN = String.raw`\b(?:click(?:s|ed|ing)?|press(?:es|ed|ing)?|tap(?:s|ped|ping)?|select(?:s|ed|ing)?|choos(?:e|es|ing)|chose|chosen|pick(?:s|ed|ing)?|open(?:s|ed|ing)?|close(?:s|d|ing)?|expand(?:s|ed|ing)?|collapse(?:s|d|ing)?|hover(?:s|ed|ing)?|scroll(?:s|ed|ing)?|navigat(?:e|es|ed|ing)|go(?:es|ne|ing)?\s+to|went\s+to|visit(?:s|ed|ing)?|verif(?:y|ies|ied|ying)|check(?:s|ed|ing)?|assert(?:s|ed|ing)?|expect(?:s|ed|ing)?|see(?:s|ing)?|saw|seen|confirm(?:s|ed|ing)?|wait(?:s|ed|ing)?|observ(?:e|es|ed|ing)|read(?:s|ing)?|search(?:es|ed|ing)?|filter(?:s|ed|ing)?|sort(?:s|ed|ing)?|find(?:s|ing)?|found|look(?:s|ed|ing)?|toggle(?:s|d|ing)?|dismiss(?:es|ed|ing)?|accept(?:s|ed|ing)?|cancel(?:s|ed|ing)?|focus(?:es|ed|ing)?|submit(?:s|ted|ting)?|send(?:s|ing)?|sent)\b`;
const ARAYUZ_FIILI_TR = `(?<![${TR_HARF}])(?:tıkla|bas|seç|aç|kapat|doğrula|dogrula|kontrol|gör|bekle|ara|filtrele|sırala|gönder|gonder)[${TR_HARF}]*(?![${TR_HARF}])`;
const OBEK_ARAYUZ_FIILI = new RegExp(`${ARAYUZ_FIILI_EN}|${ARAYUZ_FIILI_TR}`, 'iu');
const GUVENLI_AD = String.raw`(?:username|user\s+(?:name|id)|e-?mail(?:\s+address)?|first\s+name|last\s+name|full\s+name|display\s+name|nickname|company|organization|city|country|state|address|street|zip(?:\s+code)?|postal\s+code|phone(?:\s+number)?|search|url|website|comment|message|subject|title|description|note|quantity|amount|date|age)`;
const GUVENLI_HEDEF = new RegExp(
  String.raw`\b(?:in|into|to|on|at|for|within|as)\s+(?:(?:the|a|an|this|your|my)\s+)?${GUVENLI_AD}(?:\s+(?:field|input|box|textbox|text\s+box|area|textarea|dropdown|select|list|picker|combo))?\b`,
  'iu',
);
const GUVENLI_DEGER_BAGI = new RegExp(
  String.raw`(?:\b(?:the\s+)?${GUVENLI_AD}(?:\s+(?:field|input|box|textbox|text\s+box))?\s*(?:with|as|=|:)?\s*\u0000\d+\u0000)`
    + String.raw`|(?:\u0000\d+\u0000\s+(?:as|for|in|into)\s+(?:the\s+)?${GUVENLI_AD}\b)`,
  'iu',
);
const REFERANS_DEGERI_GIRISI = new RegExp(
  String.raw`(?:${GENIS_GIRIS_FIILI_EN}|${GENIS_GIRIS_FIILI_TR})\s+(?:it|that|this)\b`,
  'iu',
);
const ARAYUZ_ETIKETINDEN_GIRIS = /\b(?:click|press|tap)\s+(["'`])[^"'`\\]{1,160}\1[^.!?]{0,160}?\b(?:and|then)\s+(?:type|enter|paste|input|write|put)\b/iu;

const DOGRULAMA_FIILIYLE_BASLAR = /^\s*(?:(?:then|and)\b\s*|,\s*)*(?:verif(?:y|ies|ied|ying)|check(?:s|ed|ing)?|assert(?:s|ed|ing)?|expect(?:s|ed|ing)?|ensure(?:s|d|ing)?|make\s+sure|validat(?:e|es|ed|ing)|see(?:s|ing)?|saw|seen|observ(?:e|es|ed|ing)|confirm(?:s|ed|ing)?\s+(?:that|the)\b)/i;
const PAROLA_DOGRULAMA_DEGERI = new RegExp(
  String.raw`^\s*confirm(?:s|ed|ing)?\s+(?:the\s+)?(?:account\s+)?(?:password|passcode|pin)\b[^.!?]*\u0000\d+\u0000`,
  'iu',
);

function dogrulamaObegiMi(obek: string): boolean {
  if (PAROLA_DOGRULAMA_DEGERI.test(obek)) return false;
  return DOGRULAMA_FIILIYLE_BASLAR.test(obek) && !OBEK_GIRIS_FIILI.test(obek);
}

/** T2: gizli ad ile değer aynı öbekteyse, saf doğrulama öbeği olmadıkça tetikler. */
function tirnakliGizliAdTetiklerMi(obekler: readonly string[]): boolean {
  return obekler.some((obek) => {
    if (!DEGER_YER_TUTUCU_ILK.test(obek) || dogrulamaObegiMi(obek)) return false;
    return KIMLIK_ADI_VAR.test(obek);
  });
}

/** R1: ad taşımayan her değer öbeğinin güvenli hedef, gönderme, giriş ve arayüz sırasını uygular. */
function kimliksizTirnakliObeklerSahteMi(
  obekler: readonly string[],
  degerler: readonly string[],
): boolean {
  return obekler.every((obek, sira) => {
    if (!DEGER_YER_TUTUCU_ILK.test(obek) || KIMLIK_ADI_VAR.test(obek)) return true;
    const degerlerSahte = obektekiDegerlerSahteMi(obek, degerler);
    if (OBEK_GONDERMESI.test(obek)) return degerlerSahte;
    if (GUVENLI_HEDEF.test(obek) || GUVENLI_DEGER_BAGI.test(obek)) return true;
    const sonraki = obekler[sira + 1] ?? '';
    if (OBEK_GIRIS_FIILI.test(obek)
      && KIMLIK_ADI_VAR.test(sonraki)
      && SAHTE_DEGER_ISARETI.test(sonraki)
      && !DEGER_YER_TUTUCU_ILK.test(sonraki)) return true;
    const ilkDeger = obek.search(DEGER_YER_TUTUCU_ILK);
    const girisFiili = OBEK_GIRIS_FIILI.exec(obek);
    const arayuzFiili = OBEK_ARAYUZ_FIILI.exec(obek);
    if (girisFiili !== null && girisFiili.index < ilkDeger) return degerlerSahte;
    if (arayuzFiili !== null) return arayuzFiili.index < ilkDeger || degerlerSahte;
    if (girisFiili !== null) return degerlerSahte;
    return degerlerSahte;
  });
}

/** Önceki öbekteki gerçek değer `it/that/this` ile gizli alana taşınıyorsa değer artık kimliktir. */
function oncekiDegerKimlikHedefineAktariliyorMu(
  obekler: readonly string[],
  degerler: readonly string[],
): boolean {
  let oncekiGercekDegerVar = false;
  for (const obek of obekler) {
    if (oncekiGercekDegerVar
      && KIMLIK_ADI_VAR.test(obek)
      && REFERANS_DEGERI_GIRISI.test(obek)) return true;
    const siralar = obektekiDegerSiralariniBul(obek);
    if (siralar.some((sira) => !degerSahteMi(degerler[sira] ?? ''))) oncekiGercekDegerVar = true;
  }
  return false;
}

/** Kimlik girişinden sonraki açıklanamayan gerçek değer, doğrulama diliyle yazılsa da güvenli değildir. */
function kimlikBaglamindanSonraGercekDegerVarMi(
  obekler: readonly string[],
  degerler: readonly string[],
): boolean {
  let kimlikGirisiGoruldu = false;
  for (const obek of obekler) {
    const kimlikAdiVar = KIMLIK_ADI_VAR.test(obek);
    if (kimlikAdiVar && OBEK_GIRIS_FIILI.test(obek)) kimlikGirisiGoruldu = true;
    if (!kimlikGirisiGoruldu || !DEGER_YER_TUTUCU_ILK.test(obek)) continue;
    if (GUVENLI_HEDEF.test(obek)
      || GUVENLI_DEGER_BAGI.test(obek)
      || obektekiDegerlerSahteMi(obek, degerler)) continue;
    return true;
  }
  return false;
}

/**
 * Her gizli kimlik adının (password, secret, PIN...) kendi öbeğinde sahte işareti var mı. Öbekte (bağlaç ya da
 * noktalamayla ayrılan parça) tırnak varsa karar yalnız tırnaklı değer kuralındadır: öbekteki tırnaklı değerlerin
 * hepsi sahte olmalı ("Type 'wrongpassword' into the password field"). Tırnak yoksa adın önündeki en çok 3 sözcük
 * ya da ardındaki en çok 5 sözcükte sahte işareti aranır ("a wrong password", "password field with a wrong value").
 * Başka bir adın sahte işareti sayılmaz: "an invalid username and the account password" gerçektir.
 * Adımda gizli ad yoksa (ör. "Submit the login form empty") null: karar cümle geneline kalır.
 */
function gizliAdlarSahteMi(obekler: readonly string[], degerler: readonly string[]): boolean | null {
  let adGoruldu = false;
  for (const obek of obekler) {
    const eslesmeler = [...obek.matchAll(KIMLIK_ADI_TUMU)];
    for (const eslesme of eslesmeler) {
      adGoruldu = true;
      const adKonumu = eslesme.index ?? 0;
      if (dogrulamaObegiMi(obek)) continue;
      if (DEGER_YER_TUTUCU_ILK.test(obek)) {
        if (!obektekiDegerlerSahteMi(obek, degerler)) return false;
        continue;
      }
      const eslesmeSonu = adKonumu + eslesme[0].length;
      const once = obek.slice(0, adKonumu);
      const sonra = obek.slice(eslesmeSonu);
      if (ALAN_TURU.test(sonra) && SAHTE_DEGER_ISARETI.test(obek)) continue;
      // Adın kendisi de pencerededir: "without a password" yapısı adla birlikte okunur.
      const pencere = [
        ...once.trim().split(/\s+/).slice(-3),
        eslesme[0],
        ...sonra.trim().split(/\s+/).slice(0, 5),
      ].join(' ');
      if (!SAHTE_DEGER_ISARETI.test(pencere)) return false;
    }
  }
  return adGoruldu ? true : null;
}

/**
 * Aynı adımda sahte işaretiyle birlikte gerçek GİZLİ değer de isteniyorsa ("enter valid credentials and check
 * no invalid credentials error") emniyetli taraf: gerçek sayılır. "valid username and wrong password" sahtedir.
 */
const GERCEK_DEGER_ISARETI = /\b(?:valid|real|actual|genuine|configured)\s+(?:(?:login|account|user)\s+)?(?:password|credentials?|secret|pin|details)\b|(?:geçerli|gecerli|gerçek|gercek)\s+(?:şifre|sifre|parola|kimlik|giriş bilgi|giris bilgi)/i;

export const BEYAN_SEBEBI = 'The proposal declares requiresRealCredentials: true, but the session is already '
  + "authenticated via kobay's login step and generated tests cannot type credentials";

export const GERCEK_KIMLIK_SEBEBI = 'A step needs the real credentials, but the session is already authenticated via '
  + "kobay's login step and generated tests cannot type credentials";

/** Adım gerçek kimlik (parola, gizli anahtar, PIN...) girmeyi gerektiriyor mu? */
export function adimGercekKimlikIsterMi(aciklama: string): boolean {
  const zehirliTirnak = ZEHIRLI_TIRNAK.test(aciklama);
  const kontrolKarakterleri = kontrolKarakterleriniAyikla(aciklama);
  // Girdideki kontrol karakterleri yer tutucu NUL dizisini taklit edemesin.
  const hazir = metniHazirla(kontrolKarakterleri.temiz);
  // Tırnak içindeki biçim karakteri değeri ayrıştırılamaz yapar; dışarıdakiler eşleşmeden önce silinmiştir.
  if (hazir.tirnakIcindeBicimKarakteri) return true;
  const obekler = hazir.maskeli.split(OBEK_SINIRI);
  const t1Tetik = KIMLIK_GIRISI_EN.test(hazir.maskeli) || KIMLIK_GIRISI_TR.test(hazir.maskeli);
  const t2Tetik = tirnakliGizliAdTetiklerMi(obekler);
  const baglamsalTetik = KIMLIK_ADI_VAR.test(hazir.maskeli) && obekler.some((obek) =>
    DEGER_YER_TUTUCU_ILK.test(obek)
      && OBEK_GIRIS_FIILI.test(obek)
      && !GUVENLI_HEDEF.test(obek)
      && !GUVENLI_DEGER_BAGI.test(obek));
  const kimlikDegeriTetik = obekler.some((obek) =>
    OBEK_GIRIS_FIILI.test(obek)
      && !GUVENLI_HEDEF.test(obek)
      && !GUVENLI_DEGER_BAGI.test(obek)
      && obekteKimlikAdiDegeriVarMi(obek, hazir.degerler));
  const anaTetik = t1Tetik
    || KIMLIKLE_GIRIS_KALIBI_EN.test(hazir.maskeli)
    || GIRIS_FORMU_DOLDURMA.test(hazir.maskeli)
    || hesaplaGirisEylemMi(hazir.maskeli)
    || t2Tetik
    || baglamsalTetik
    || kimlikDegeriTetik;
  if (!anaTetik) return false;
  // Tetiklenmiş adımda bu karakterler ayrıştırmayı güvenilmez yapar; tek başlarına tetik değildirler.
  if (zehirliTirnak || kontrolKarakterleri.zehirli) return true;
  if (hazir.gecersizTirnak) return true;
  if (GERCEK_DEGER_ISARETI.test(hazir.maskeli)) return true;
  if (t1Tetik && ARAYUZ_ETIKETINDEN_GIRIS.test(kontrolKarakterleri.temiz)) return true;
  if (oncekiDegerKimlikHedefineAktariliyorMu(obekler, hazir.degerler)) return true;
  if ((t1Tetik || t2Tetik || baglamsalTetik || kimlikDegeriTetik)
    && !kimliksizTirnakliObeklerSahteMi(obekler, hazir.degerler)) return true;
  if (kimlikBaglamindanSonraGercekDegerVarMi(obekler, hazir.degerler)) return true;
  const adlarSahte = gizliAdlarSahteMi(obekler, hazir.degerler);
  if (adlarSahte !== null) return !adlarSahte;
  if (hazir.degerler.length > 0) return !hazir.degerler.every(degerSahteMi);
  return !SAHTE_DEGER_ISARETI.test(hazir.maskeli);
}

/** Gerçek kimlik gerektiren ilk adımı (sırası ve metniyle) döndürür; yoksa null. Başlığa bakmaz. */
export function gercekKimlikAdimi(
  adimlar: readonly Pick<PlanAdimi, 'description'>[],
): { sira: number; aciklama: string } | null {
  const sira = adimlar.findIndex((adim) => adimGercekKimlikIsterMi(adim.description));
  return sira === -1 ? null : { sira, aciklama: adimlar[sira]!.description };
}

/**
 * Plan ve elle yazılan plan için ortak kural. Giriş yapılandırılmışsa (oturum kobay'ın giriş
 * adımıyla açılıyorsa) ve bir adım gerçek kimlik gerektiriyorsa ret gerekçesini döndürür;
 * aksi halde null. Giriş yapılandırılmamış projede kural kapalıdır.
 *
 * `beyan` beynin öneri başına verdiği yapısal alandır (`requiresRealCredentials`): `true` ise
 * sözcüklere bakmadan düşer. `false` ya da yok ise karar sözcük filtresinindir: beyan "gerek yok"
 * dese de adım gerçek kimlik giriyorsa düşer (emniyetli taraf).
 */
export function girisKuraliIhlali(
  adimlar: readonly Pick<PlanAdimi, 'description'>[],
  girisYapilandirildi: boolean,
  beyan?: boolean,
): string | null {
  if (!girisYapilandirildi) return null;
  if (beyan === true) return BEYAN_SEBEBI;
  const adim = gercekKimlikAdimi(adimlar);
  if (adim === null) return null;
  return `${GERCEK_KIMLIK_SEBEBI} (step ${adim.sira}: "${adim.aciklama}")`;
}
