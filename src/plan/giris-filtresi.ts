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
 * Bilinen sınır: sözcük tabanlıdır (İngilizce + Türkçe); alışılmadık ifadeyi kaçırırsa kod
 * üretim istemi o adımı `throw` ile düşürtür, sessizce geçmez.
 */
const GIRIS_FIILI_EN = String.raw`\b(?:enter(?:s|ed|ing)?|fill(?:s|ed|ing)?|type[sd]?|typing|input(?:s|ted|ting)?|provid(?:e|es|ed|ing)|submit(?:s|ted|ting)?|paste[sd]?)\b`;
/** "Log in" tek başına düğme adı da olabilir ("Sign in button"); yalnız "with/using ... <kimlik>" kalıbında fiil sayılır. */
const GIRIS_KALIBI_EN = String.raw`\b(?:log(?:s|ged|ging)?[ -]?in|sign(?:s|ed|ing)?[ -]?in|authenticat\w*)\s+(?:with|using|by)\b`;
/** "password reset", "forgot password" gibi kimlik GİRMEYEN kullanımlar ad sayılmaz. */
const KIMLIK_ADI_EN = String.raw`(?<!forgot\s)(?<!forgotten\s)\b(?:pass(?:word|words|phrase|code)|credentials?|secrets?|(?:api|access|secret)[ _-]?(?:key|token)|pin(?:\s+code)?)\b(?!\s*(?:reset|recovery|strength|requirements?|polic(?:y|ies)|page|link|hint)\b)`;
/** İngilizce: fiil ve kimlik adı aynı cümlede (nokta aşılmaz), sıra fiil → ad. */
const KIMLIK_GIRISI_EN = new RegExp(`(?:${GIRIS_FIILI_EN}|${GIRIS_KALIBI_EN})[^.]*${KIMLIK_ADI_EN}`, 'i');
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
  // Tırnak içinde: açılmış ve kapanmamış çift/tek/akıllı tırnak ya da ters tırnak.
  if (/["“”`]/.test(once) && ((once.match(/["“”`]/g) ?? []).length % 2 === 1)) return false;
  const cumle = once.split(/[.;!?](?:\s|$)/).at(-1) ?? '';
  return !DOGRULAMA_ISARETI.test(cumle);
}
/** Türkçe: ad ve fiil aynı cümlede, iki sırada da (Türkçede fiil çoğunlukla sonda). */
const KIMLIK_ADI_TR = String.raw`(?:şifre|sifre|parola|kimlik bilgi|giriş bilgi|giris bilgi|gizli anahtar|gizli değer|gizli deger|\bPIN\b|pin kod)`;
/** JS `\b` Türkçe harfleri tanımaz; sözcük sınırı elle. */
const TR_HARF = 'a-zçğıöşü';
const GIRIS_FIILI_TR = `(?<![${TR_HARF}])(?:(?:gir|yaz|doldur)(?:in|iniz|ın|ınız|un|unuz|ip|ıp|up|ilir|ılır|ulur)?|kullan(?:ın|arak)?|giriş yap|giris yap|oturum aç|oturum ac)(?![${TR_HARF}])`;
const KIMLIK_GIRISI_TR = new RegExp(
  `${KIMLIK_ADI_TR}[^.]*${GIRIS_FIILI_TR}|${GIRIS_FIILI_TR}[^.]*${KIMLIK_ADI_TR}`, 'i',
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
const OBEK_SINIRI = /\b(?:and|then|but|while)\b|[,;.]/i;
const KIMLIK_ADI_EN_TUMU = new RegExp(KIMLIK_ADI_EN, 'gi');
/**
 * Tırnak sayılan her karakter: düz, ters, akıllı ve köşeli tırnaklar. Öbekte bunlardan biri (ya da ters bölü)
 * varsa karar YALNIZ tırnaklı değer kuralından gelir; "Type 'hunter2' into the password field without clearing it"
 * içindeki "without" gibi genel sahte işareti tırnaklı gerçek değeri aklayamaz.
 */
const TIRNAK_KARAKTERI = /["'`‘’“”«»„‚‹›]/u;
/**
 * Aynı düz tırnakla açılıp kapanan, boşluksuz ve ters bölüsüz değer: "Type 'wrongpassword' into the password field".
 * Akıllı tırnak, eşi olmayan tırnak, boş tırnak (`''`), boşluklu ya da kaçışlı değer (`'wrong\'password'`) değer
 * sayılmaz; geride tırnak kaldığı için adım düşer.
 */
const TIRNAKLI_DEGER = /(["'`])([^\s"'`‘’“”«»„‚‹›\\]+)\1/gu;
const YAPISIK_SAHTE_KOK = '(?:invalid|incorrect|wrong|bad|fake|dummy|bogus|yanlış|yanlis|geçersiz|gecersiz|sahte|hatalı|hatali)';
/** Sahte kökün yapıştığı kimlik parçası: "wrongpassword", "badpass", "passwordfake". */
const YAPISIK_KIMLIK_PARCASI = '(?:pass(?:word|wd|code|phrase)?|pwd|pw|secret|pin|key|token|cred(?:ential)?s?|login|user(?:name)?|value|input|şifre|sifre|parola)';
/** Kökün yanında durabilecek tek parça: kimlik sözcüğü, ayraç (`_ - .`) ya da tek rakam (rakam dizisi tekrarla kurulur). */
const YAPISIK_YAN_PARCA = `(?:${YAPISIK_KIMLIK_PARCASI}|[-_.]|[0-9])`;
/**
 * Değerin TAMAMI sahte kök, kimlik sözcüğü, ayraç ve rakamlardan kurulu olmalı, en az bir sahte kök içermeli:
 * "wrongpassword", "badpass", "wrong_pw", "password123fake", "wrong123" sahtedir. Serbest harf dizisi kalan değer
 * ("wrongpasswordHunter2", "hunter2wrong", "Badger2024", "wrongÅngström") sahte SAYILMAZ: emin değilsek gerçek
 * kabul edilir (adım düşer).
 */
const YAPISIK_SAHTE_DEGER = new RegExp(
  `^${YAPISIK_YAN_PARCA}*${YAPISIK_SAHTE_KOK}(?:${YAPISIK_SAHTE_KOK}|${YAPISIK_YAN_PARCA})*$`,
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

/** Metinde (kesme işaretleri dışında) tırnak karakteri ya da ters bölü var mı: varsa karar tırnaklı değer kuralına geçer. */
function tirnakVarMi(metin: string): boolean {
  return TIRNAK_KARAKTERI.test(kesmeleriAyikla(metin)) || metin.includes('\\');
}

/**
 * Metindeki tırnaklı değerlerin HEPSİ sahte mi ("'wrongpassword'"). Hiç değer yoksa, tek bir değer bile sahte
 * değilse ("Type 'hunter2' into the password field (not 'wrongpassword')"), değerler çıkarıldıktan sonra
 * geride tırnak kalıyorsa (akıllı, eşsiz, boş, boşluklu ya da kaçışlı tırnak) ya da ters bölü varsa false.
 */
function tirnakliSahteDegerVarMi(hamMetin: string): boolean {
  if (hamMetin.includes('\\')) return false;
  const metin = kesmeleriAyikla(hamMetin);
  const degerler = [...metin.matchAll(TIRNAKLI_DEGER)].map((eslesme) => eslesme[2] ?? '');
  if (degerler.length === 0) return false;
  if (TIRNAK_KARAKTERI.test(metin.replace(TIRNAKLI_DEGER, ' '))) return false;
  return degerler.every((deger) => YAPISIK_SAHTE_DEGER.test(deger));
}

/**
 * Her gizli kimlik adının (password, secret, PIN...) kendi öbeğinde sahte işareti var mı. Öbekte (bağlaç ya da
 * noktalamayla ayrılan parça) tırnak varsa karar yalnız tırnaklı değer kuralındadır: öbekteki tırnaklı değerlerin
 * hepsi sahte olmalı ("Type 'wrongpassword' into the password field"). Tırnak yoksa adın önündeki en çok 3 sözcük
 * ya da ardındaki en çok 5 sözcükte sahte işareti aranır ("a wrong password", "password field with a wrong value").
 * Başka bir adın sahte işareti sayılmaz: "an invalid username and the account password" gerçektir.
 * Adımda İngilizce gizli ad yoksa (Türkçe adım, "Submit the login form empty") null: karar cümle geneline kalır.
 */
function gizliAdlarSahteMi(aciklama: string): boolean | null {
  const eslesmeler = [...aciklama.matchAll(KIMLIK_ADI_EN_TUMU)];
  if (eslesmeler.length === 0) return null;
  return eslesmeler.every((eslesme) => {
    const once = aciklama.slice(0, eslesme.index).split(OBEK_SINIRI).at(-1) ?? '';
    const sonra = aciklama.slice(eslesme.index + eslesme[0].length).split(OBEK_SINIRI)[0] ?? '';
    const obek = `${once}${eslesme[0]}${sonra}`;
    if (tirnakVarMi(obek)) return tirnakliSahteDegerVarMi(obek);
    // Adın kendisi de pencerededir: "without a password" yapısı adla birlikte okunur.
    const pencere = [
      ...once.trim().split(/\s+/).slice(-3),
      eslesme[0],
      ...sonra.trim().split(/\s+/).slice(0, 5),
    ].join(' ');
    return SAHTE_DEGER_ISARETI.test(pencere);
  });
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
  const tetik = [KIMLIK_GIRISI_EN, KIMLIK_GIRISI_TR, GIRIS_FORMU_DOLDURMA];
  if (!tetik.some((desen) => desen.test(aciklama)) && !hesaplaGirisEylemMi(aciklama)) return false;
  if (GERCEK_DEGER_ISARETI.test(aciklama)) return true;
  const adlarSahte = gizliAdlarSahteMi(aciklama);
  if (adlarSahte !== null) return !adlarSahte;
  // İngilizce gizli ad yok (Türkçe adım, giriş formu): tırnak varsa burada da karar tırnaklı değer kuralındadır.
  if (tirnakVarMi(aciklama)) return !tirnakliSahteDegerVarMi(aciklama);
  return !SAHTE_DEGER_ISARETI.test(aciklama);
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
