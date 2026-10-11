import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { beyinOlustur } from '../../src/beyin/index.js';
import { yazAtomik, type Harita } from '../../src/depo/index.js';
import { BEYAN_SEBEBI, PLAN_SISTEM_ISTEMI, adimGercekKimlikIsterMi, girisKuraliIhlali, planUret } from '../../src/plan/index.js';
import { sistemIstemi } from '../../src/uret/istem.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

function harita(loggedIn: boolean): Harita {
  return {
    baseUrl: 'http://uygulama.test',
    loggedIn,
    exploredAt: '2026-09-28T00:00:00.000Z',
    pages: [
      { url: 'http://uygulama.test/login', title: 'Login', headings: ['Sign in'], links: [], forms: [], buttons: [], menu: [] },
      { url: 'http://uygulama.test/', title: 'Home', headings: ['Home'], links: [], forms: [], buttons: [], menu: [] },
    ],
  };
}

function taslak(title: string, adimlar: Array<[string, string]>, url = '/login'): Record<string, unknown> {
  return {
    title, description: title, priority: 'p0', category: 'login', feature: 'login', type: 'frontend', url,
    steps: adimlar.map(([type, description]) => ({ type, description })),
  };
}

const GECERLI = taslak('Log in with valid credentials', [
  ['action', 'Open the login page'], ['action', 'Enter the username and password'],
  ['assertion', 'Verify the dashboard is visible'],
]);
const GECERSIZ = taslak('Login with invalid credentials shows an error', [
  ['action', 'Enter a wrong password and submit'], ['assertion', 'Verify an error message is visible'],
]);
const BOS = taslak('Login with empty fields', [
  ['action', 'Submit the login form empty'], ['assertion', 'Verify validation errors appear'],
]);
const SAYFA = taslak('Login page renders', [
  ['action', 'Open the login page'], ['assertion', 'Verify the login form is visible'],
]);
const ANASAYFA = taslak('View home', [['action', 'Open the home page'], ['assertion', 'Verify Home heading']], '/');

async function beyin(oneriler: unknown[]) {
  const dizin = await geciciDizinAc('kobay-giris-');
  await yazAtomik(join(dizin, 'plan.json'), JSON.stringify({ proposals: oneriler }));
  return beyinOlustur({ adaptor: 'sahte' }, { KOBAY_SAHTE_YANIT_DIZINI: dizin });
}

describe('geçerli kimlikle giriş filtresi', () => {
  it('giriş yapılandırılmış projede geçerli-kimlik önerisini gerekçeyle düşürür', async () => {
    const sonuc = await planUret(await beyin([GECERLI, GECERSIZ, BOS, SAYFA, ANASAYFA]), harita(true), undefined);

    expect(sonuc.proposals.map((oneri) => oneri.title)).toEqual([
      'Login with invalid credentials shows an error', 'Login with empty fields', 'Login page renders', 'View home',
    ]);
    expect(sonuc.dropped).toHaveLength(1);
    expect(sonuc.dropped[0]).toMatchObject({ title: 'Log in with valid credentials' });
    expect(sonuc.dropped[0]?.reason).toContain('already authenticated');
  });

  it('giriş yapılandırılmamış projede hiçbir öneriyi düşürmez', async () => {
    const sonuc = await planUret(await beyin([GECERLI, SAYFA]), harita(false), undefined);

    expect(sonuc.dropped).toEqual([]);
    expect(sonuc.proposals).toHaveLength(2);
  });

  it('denetimin üç somut örneği: karar başlıktan değil adımlardan', async () => {
    // Başlıkta "invalid" var ama adım gerçek kimlik giriyor → düşer (eski filtre "invalid" ile kısa devre yapıyordu).
    const gecerliAmaInvalidBaslik = taslak('Valid login does not show invalid credentials error', [
      ['action', 'Enter the valid username and password and submit'],
      ['assertion', 'Verify that no invalid credentials error is shown'],
    ]);
    // "secret" kimlik sayılır → düşer.
    const gizli = taslak('Sign in as admin', [
      ['action', 'Enter the account secret'], ['assertion', 'Verify the admin panel is visible'],
    ]);
    // Başlıkta "successful login" var ama hiçbir adım kimlik girmiyor → kalır.
    const denetimKaydi = taslak('View successful login audit entries', [
      ['action', 'Open the audit log page'], ['assertion', 'Verify successful login entries are listed'],
    ], '/');

    const sonuc = await planUret(await beyin([gecerliAmaInvalidBaslik, gizli, denetimKaydi]), harita(true), undefined);

    expect(sonuc.proposals.map((oneri) => oneri.title)).toEqual(['View successful login audit entries']);
    expect(sonuc.dropped.map((kayit) => kayit.title)).toEqual([
      'Valid login does not show invalid credentials error', 'Sign in as admin',
    ]);
    expect(sonuc.dropped[1]?.reason).toContain('step 0: "Enter the account secret"');
  });

  it('adım sınıflaması: gerçek kimlik, sahte değer ve kimlik girmeyen adımlar (İngilizce + Türkçe)', () => {
    for (const adim of [
      'Enter the account secret', 'Enter the username and password', 'Type the password and press Log in',
      'Log in with valid credentials', 'Fill in the password field', 'Enter the PIN', 'Fill in the login form',
      'Enter valid credentials and verify no invalid credentials error is shown',
      'Şifreyi gir', 'Kullanıcı adı ve şifreyi yazın', 'Geçerli şifreyle giriş yap', 'Giriş formunu doldur',
      // İkinci karşıt denetimin (N6) üç kaçağı:
      'Enter an invalid username and the account password', 'Submit the login form',
      'Sign in as the configured administrator',
      'Log in as admin', 'Enter an invalid username and password',
      'Log in as admin and verify the dashboard is shown', 'Open the home page. Sign in as the demo user',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
    for (const adim of [
      'Enter a wrong password and submit', 'Enter a valid username and a wrong password',
      'Submit the login form with an empty password', 'Fill the login form with fake values',
      'Verify the password field is visible', 'Click the Sign in button', 'Enter your email on the forgot password page',
      'Verify successful login entries are listed', 'Yanlış şifre gir', 'Şifre alanının altındaki yazıyı doğrula',
      'Kullanıcı adı alanını doldur',
      'Submit the login form empty', 'Sign in as a nonexistent user', 'Enter an invalid username and an invalid password',
      'Fill in the password field with a wrong value', 'Enter a wrong or empty password',
      // Üçüncü karşıt denetim (F5): giriş sonrası ekran metnini doğrulayan adımlar.
      'Verify the header shows "Signed in as demo@example.com"', 'Check that the banner reads Logged in as admin',
      'Expect the greeting to say Signed in as demo', 'The header text reads “Logged in as admin”',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
  });

  it('tırnak içinde sahte köke yapışık değer sahtedir; emin olunmayan değer düşer', () => {
    for (const adim of [
      "Type 'wrongpassword' into the password field", 'Type "password123fake" into the password field',
      "Enter 'badpass' in the password box and submit", "Type `fake_pw` into the password field",
      "Type 'WrongPassword' into the password field",
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      'Enter the password and submit', 'Type the real password', "Type 'password' into the field",
      // Kök rastgele sözcüğe yapışık ya da kimlik parçasına değil: emin değiliz, gerçek sayılır.
      "Type 'Badger2024' into the password field", "Type 'testpassword' into the password field",
      // Yapışık sahte değer başka bir öbekte; bu adın penceresinde sahte işaret yok.
      "Type 'wrongpassword' into the username field and the account password into the password field",
      // Tırnak yok: yapışık sözcük pencere kuralına takılmaz.
      'Type wrongpassword into the password field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('not sahte kökü dolgu sözcükleriyle birleşebilir; en az bir sahte kök şartı korunur', () => {
    for (const adim of [
      'Type "not-the-password" into the password field', 'Type "not-a-password" into the password field',
      'Type "notmypassword" into the password field', 'Type "not_the_real_password" into the password field',
      'Type "not-valid-password" into the password field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      'Type "the-real-password" into the password field', 'Type "not-hunter2" into the password field',
      'Type "notebook" into the password field', 'Type "nothing" into the password field',
      'Type "not-the-password-hunter2" into the password field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('gizli ad öbeğinden sonraki giriş fiilli tırnaklı gerçek değer düşer', () => {
    for (const adim of [
      'Type "wrongpassword" into the password field, then replace it with "hunter2"',
      'Enter a wrong password, then replace it with "hunter2"',
      'Type "wrongpassword" into the password field and then type "hunter2"',
      'Type "wrongpassword" into the password field. Then enter "hunter2"',
      // Akıllı/eşsiz/boş tırnak ve ters bölü: değer güvenle sahte sayılamaz.
      'Type "wrongpassword" into the password field, then type “hunter2”',
      'Type "wrongpassword" into the password field, then type "hunter2',
      'Type "wrongpassword" into the password field, then type ""',
      'Type "wrongpassword" into the password field, then type "hunter\\2"',
      'Type "wrongpassword" into the password field, then "hunter2"',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
    for (const adim of [
      'Type "wrongpassword" into the password field and click "Login"',
      'Type "wrongpassword" into the password field, then type "admin" into the username field',
      'Type "wrongpassword" into the password field, then replace it with "wrongpassword2"',
      'Enter "admin" in the username field and "wrongpass" in the password field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
  });

  it('tırnak içindeki arayüz metnini fiil veya hedef sanmaz; kimlik-dışı alanları serbest bırakır', () => {
    for (const adim of [
      'Type "wrongpassword" into the password field, and click "Submit"',
      'Type "wrongpassword" into the password field, then press "Enter"',
      'Type "wrongpassword" into the password field, then click "Use another account"',
      'Type "wrongpassword" into the password field, then click "Update" and check the error',
      'Type "wrongpassword" into the password field, then type "London" into the city field',
      'Type "wrongpassword" into the password field, then type "Acme" into the company field',
      'Type "wrongpassword" into the password field, then type "admin" into the username field',
      'Type "wrongpassword" into the password field and "admin" in the username field',
      'Type "wrongpassword" into the password field, then click "Submit" to submit the form',
      'Search for "laptop". Enter a wrong password',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      'Type "wrongpassword" into the password field, then type "hunter2" into the user field',
      'Type "wrongpassword" into the password field, then type "hunter2" into the login field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('gönderme, giriş fiili, bilinmeyen fiil ve pasifte tırnaklı gerçek değeri düşürür', () => {
    for (const adim of [
      'Type "wrongpassword" into the password field, then retry with "hunter2" for the same user',
      'Type "wrongpassword" into the password field, then enter "hunter2" to confirm the email change',
      'Type "wrongpassword" into the password field, then replace it with "hunter2" in the name field',
      'Type "wrongpassword" into the password field, then replace it with "search-2024"',
      'Type "wrongpassword" into the password field, then write "hunter2" into it',
      'Type "wrongpassword" into the password field, then it is replaced with "hunter2"',
      'Type "wrongpassword" into the password field, then using "hunter2" in it',
      'Type "wrongpassword" into the password field. Then pasting "hunter2" into it',
      'Type "wrongpassword" into the password field. Then updated it to "hunter2"',
      'Type "wrongpassword" into the password field. "hunter2" is used instead',
      'Type "wrongpassword" into the password field, then fix it to "hunter2"',
      'Type "wrongpassword" into the password field, then switch to "hunter2"',
      'Type "wrongpassword" into the password field, then type, without delay, "hunter2" into it',
      'Type "wrongpassword" into the password field. Then type; "hunter2" into it',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('gizli addan önceki öbekleri ve iki yönlü ana tetikleyiciyi tarar', () => {
    for (const adim of [
      'Type "hunter2" into it, then submit it as a wrong password',
      'Type "hunter2", then enter a wrong password',
      'Enter "hunter2" and then enter "wrongpass" in the password field',
      'Put "hunter2" in the password field',
      'Write "hunter2" in the password field',
      'The password field is populated with "hunter2"',
      'Click the password field, type "wrongpassword", then replace it with "hunter2"',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('yeni kimlik adlarını ve Türkçe/karma giriş fiillerini gerçek kimlik olarak tanır', () => {
    for (const adim of [
      'Type "hunter2" into the token field',
      'Enter "hunter2" as the authentication token',
      'Enter "hunter2" into the OTP field',
      'Enter "hunter2" as the one-time code',
      'Enter "hunter2" into the verification code field',
      'Enter "hunter2" into the security code field',
      'Enter "hunter2" into the recovery code field',
      'Enter "hunter2" into the backup code field',
      'Enter "hunter2" into the 2FA code field',
      'Enter "hunter2" into the MFA code field',
      'Enter "hunter2" into the two-factor code field',
      'Enter "hunter2" into the authenticator code field',
      'Erişim tokenını "hunter2" olarak gir',
      'Şifreyi "hunter2" ile değiştir',
      'Şifre alanına "hunter2" yerleştir',
      'Type "wrongpassword" into the password field, sonra içine "hunter2" yaz',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
    for (const adim of [
      'Verify the token page is visible', 'Check the token expired message',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
  });

  it('genişletilen İngilizce giriş/değiştirme fiillerinin çekimlerini tanır', () => {
    for (const fiil of [
      'Put', 'Writes', 'Wrote', 'Written', 'Populated', 'Supplies', 'Inserted', 'Sets', 'Uses', 'Replaced',
      'Changed', 'Updated', 'Overwrote', 'Overwritten', 'Corrected', 'Re-entered', 'Re-typed', 'Retries',
      'Fixed', 'Switched', 'Swapped', 'Modified', 'Edited', 'Keyed in', 'Gave', 'Given',
    ]) {
      const adim = `${fiil} "hunter2" in the password field`;
      expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
    }
  });

  it('not yalnız dar gramerle sahtedir', () => {
    for (const adim of [
      'Type "not-the-password" into the password field', 'Type "not-a-password" into the password field',
      'Type "notmypassword" into the password field', 'Type "not_the_real_password" into the password field',
      'Type "not-valid-password" into the password field', 'Type "not-the-password-1" into the password field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      'Type "not123" into the password field', 'Type "not" into the password field',
      'Type "nota1" into the password field', 'Type "Not4Pass" into the password field',
      'Type "not-hunter2" into the password field', 'Type "notebook" into the password field',
      'Type "nothing" into the password field', 'Type "the-real-password" into the password field',
      'Type "not-the-password-hunter2" into the password field',
      'Type "wrong-valid-password-123" into the password field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('tam genişlik ve ters akıllı tırnakları güvenli tarafta düşürür', () => {
    for (const adim of [
      'Type "wrongpassword" into the password field, then type ＂hunter2＂ into it',
      'Type ＇hunter2＇ into the password field',
      'Type ‛hunter2‛ into the password field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('pencerede birden çok tırnaklı değer varsa hepsi sahte olmalı; akıllı ya da eşsiz tırnak değer sayılmaz', () => {
    for (const adim of [
      "Type 'wrongpassword' into the password field",
      "Type 'wrongpassword' and 'badpass' into the password field",
      "Type 'wrongpassword' into the password field (not 'badpass')",
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      // Biri gerçek görünüyor: sahte değer yanındaki gerçeği aklamaz.
      "Type 'hunter2' into the password field (not 'wrongpassword')",
      "Type 'wrongpassword' into the password field (not 'hunter2')",
      // Akıllı tırnak değer sayılmaz; eşi olmayan tırnak da (emniyetli taraf).
      'Type ‘wrongpassword’ into the password field', 'Type “wrongpassword” into the password field',
      "Type 'wrongpassword\" into the password field",
      "Type 'wrongpassword' into the password field (not “hunter2”)",
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('öbekte tırnak varsa genel sahte işareti devre dışı; karar yalnız tırnaklı değerden gelir', () => {
    for (const adim of [
      "Type 'wrong_pw' into the password field", "Type 'wrong123' into the password field",
      "Type 'wrong-password' into the password field without clearing it",
      // Kimlik adı yalnız tırnaklı değerin içinde ve öbekte başka değer yok.
      "Type 'wrongpassword' into the field",
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      // Dördüncü karşıt denetim: "without" genel işareti tırnaklı gerçek değeri aklamaz.
      "Type 'hunter2' into the password field without clearing it",
      "Type 'hunter2' into the password field and verify the invalid password error is gone",
      "Type “hunter2” into the password field with a wrong username",
      // Tam değer: kök ile kimlik sözcüğü, ayraç ve rakam dışında serbest harf dizisi kalmamalı.
      "Type 'wrongpasswordHunter2' into the password field", "Type 'hunter2wrong' into the password field",
      "Type 'fakeHunter' into the password field",
      // Unicode harf sözcük sınırı değildir.
      "Type 'wrongÅngström' into the password field", 'Type wrongÅngström into the password field',
      // Kaçışlı tırnak, boşluklu değer ve boş tırnak değer sayılmaz.
      "Type 'wrong\\'password' into the password field", "Type 'wrong password' into the password field",
      "Type '' into the password field and expect a wrong password error",
      "Type 'wrong\\pw' into the password field",
      // Kaçışlı açılış tırnağı: ardından gelen "değer" gerçek bir tırnaklı değer değildir.
      "Type \\'wrongpassword' into the password field",
      // İki kimlik adı: biri sahte biri gerçek → düşer.
      "Type 'wrongpassword' into the password field and 'hunter2' into the secret field",
      // Tırnak penceresinin (önde 3, arkada 5 sözcük) dışında ama aynı öbekte: genel işaret yine devre dışı.
      "Type 'hunter2' slowly one character at a time into the password field without clearing it",
      // Tırnak pencere kenarından taşıyor.
      "Type into the password field the value 'wrong pass' slowly",
      // İngilizce ad yoksa da tırnak kuralı geçerli.
      "Fill in the login form with 'hunter2' and an empty username",
      "Şifre alanına 'hunter2' yazın, yanlış uyarısı çıkmasın",
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('iki harf arasındaki düz ya da akıllı tek tırnak kesme işaretidir, tırnak sayılmaz', () => {
    for (const adim of [
      "Enter the user's wrong password", "Submit with an invalid password and verify it doesn't log in",
      "Enter the admin's invalid password and verify it isn't accepted",
      "Type 'wrongpassword' into the user's password field",
      "Kullanıcı'nın şifre alanına yanlış şifre yaz",
      // Akıllı kesme (’) de iki harf arasında kesme işaretidir.
      'Enter the user’s wrong password', 'Enter an invalid password and verify it doesn’t log in',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      "Type 'hunter2' into the user's password field", "Enter the user's password",
      // Harf olmayan yana değen tırnak kesme değildir: "2'" tırnak kuralına girer, emin olunmayan biçim düşer.
      "Type 'hunter2's' into the password field with a wrong username",
      "Type 'wrong's' into the password field",
      // Akıllı tırnak çifti harf arasında değil: tırnak sayılır, değer sayılmaz.
      'Type ’hunter2’ into the password field', "Type 'hunter2' into the user’s password field",
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('tırnak yoksa eski genel işaret kuralı aynen çalışır', () => {
    for (const adim of [
      'Enter a wrong password and submit', 'Fill in the password field without a value',
      'Enter a mismatched password', 'Yanlış şifre gir', "Fill the login form with 'fake' values",
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      'Type the password into the password field', 'Enter the wrongful password',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('"without" yalnız kimlik yokluğu yapısında sahte işaretidir', () => {
    for (const adim of [
      'Submit the form without a password', 'Submit without entering the password and verify the error',
      'Leave the password empty and submit',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      'Enter the password without changing the username', 'Type the password without pressing enter',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('tırnaklı değerleri öbek, gizli ad, fiil ve hedef taramasından önce maskeler', () => {
    for (const adim of [
      'Click "Save and continue"', 'Click "Yes, continue"', 'Click "Password help"',
      'Click "Use another account"',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
  });

  it('T2 gizli adla aynı öbekteki tırnaklı değeri fiilsiz de yakalar', () => {
    for (const adim of [
      'Password: "hunter2"', 'password = "hunter2"', 'with password "hunter2"',
      'Select "hunter2" in the password list', 'Keyed in "hunter2" into the password field',
      'Punch in "hunter2" into the password field', 'Feed "hunter2" into the password field',
      'Load "hunter2" into the password field', 'Type "hunter2" şifre alanına',
      'The password is "hunter2". Type it into the field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
    for (const adim of [
      'Verify the password field shows "Error"', 'Verify the error "Invalid password" appears',
      'Verify the password field is visible and click "Login"',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
  });

  it('geniş değiştirme fiilleri T1 değildir; yaygın meşru adımlar kalır', () => {
    for (const adim of [
      'Check that the password field uses masking', 'Click "Change password" in the settings menu',
      'Click "Update password" and verify the form opens',
      'Change the display name and verify the password section is unchanged',
      'Verify the API token is updated in the header',
      'Open the security settings and set the language to English, then check the PIN section',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
  });

  it('yalnız pozitif listedeki adlandırılmış gizli-olmayan hedefleri serbest bırakır', () => {
    for (const hedef of [
      'into the username field', 'into the user name input', 'to your user id box',
      'into an email field', 'into the e-mail address textbox', 'into the first name field',
      'into the last name field', 'into the full name field', 'into the display name field',
      'into the nickname field', 'into the company field', 'into the organization field',
      'into the city field', 'into the country field', 'into the state field', 'into the address field',
      'into the street field', 'into the zip code field', 'into the postal code field',
      'into the phone number field', 'into the search box', 'into the url field',
      'into the website field', 'into the comment area', 'into the message textarea',
      'into the subject field', 'into the title field', 'into the description field',
      'into the note field', 'into the quantity input', 'into the amount field',
      'into the date picker', 'into the age field',
    ]) {
      const adim = `Type "hunter2" ${hedef}`;
      expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    }
    for (const hedef of [
      'into the input', 'into the text box', 'into the next field', 'into the second field',
      'into the new field', 'into the first field', 'into the confirmation field',
      'into the confirm field', 'into the repeat field', 'into the login field', 'into the user field',
      'as the correct one', 'as well', 'as the new value', 'into the box below',
    ]) {
      const adim = `Type "hunter2" ${hedef}`;
      expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
      const baglamli = `Type "wrongpassword" into the password field, then ${adim}`;
      expect(adimGercekKimlikIsterMi(baglamli), baglamli).toBe(true);
    }
    for (const hedef of ['into the passwd field', 'into the pwd input', 'into the pass box']) {
      const adim = `Type "hunter2" ${hedef}`;
      expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
    }
  });

  it('göndermeyi yalnız hedef konumunda tanır', () => {
    for (const adim of [
      'Type "wrongpassword" into the password field, then verify that "Error" appears',
      'Type "wrongpassword" into the password field, then click "Retry" again',
      'Type "wrongpassword" into the password field, then click "Login" again',
      'Type "wrongpassword" into the password field, then type "London" into the city field to check it',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      'Type "wrongpassword" into the password field, then type "hunter2" into it',
      'Type "wrongpassword" into the password field, then replace it with "hunter2"',
      'Type "wrongpassword" into the password field, then put "hunter2" in the same field',
      'Type "wrongpassword" into the password field, then put "hunter2" in the field',
      'Type "wrongpassword" into the password field, then put "hunter2" in there',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('kimliksiz tırnaklı öbek tek başına tetik değildir; T1 bağlamında R1 taranır', () => {
    expect(adimGercekKimlikIsterMi('click "Submit"')).toBe(false);
    expect(adimGercekKimlikIsterMi('"hunter2" should be accepted')).toBe(false);
    expect(adimGercekKimlikIsterMi('"hunter2" is submitted')).toBe(false);
    expect(adimGercekKimlikIsterMi('Enter a wrong password, then "hunter2" should be accepted')).toBe(true);
    expect(adimGercekKimlikIsterMi('Enter a wrong password, then "hunter2" is submitted')).toBe(true);
  });

  it('Türkçe fiil sınırlarını ve Türkçe gizli ad öbeklerini korur', () => {
    for (const adim of [
      'Type "wrongpassword" into the password field, then "hunter2" from the database',
      'Type "wrongpassword" into the password field, then "hunter2" in parallel',
      'Type "wrongpassword" into the password field, then şifre alanına "hunter2" yaz',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
    expect(adimGercekKimlikIsterMi('The tokenized field shows "hunter2"')).toBe(false);
  });

  it('listelenen tırnak benzerlerini ve tırnak içindeki biçim karakterlerini zehirli sayar', () => {
    for (const tirnak of [...'′″‴‵‶‷´‟「」『』〝〞〟ʹʺʻʼʽˈ˝']) {
      const adim = `Type ${tirnak}hunter2${tirnak} into the password field`;
      expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
    }
    for (const adim of [
      'Type "hunter\u200B2" into the password field',
      'Ty\u200Bpe "hunter2" into the pass\u200Bword field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('R1 yalnız T1/T2 sonrasında kimliksiz öbekleri tarar', () => {
    for (const adim of [
      'Type "Buy milk" into the new todo input', 'Set the quantity to "3"',
      'Type "Blue" into the color field', 'Type "Hello world" into the chat box',
      'Use "Express" shipping', 'Change the language to "Türkçe"',
      'Type "2024-01-01" into the start date field', 'Fill the amount field with "120"',
      'Type "Monthly total" into the report name field', 'Şehir alanına "İstanbul" yazın',
      'Ad alanına "Ali" yaz', 'Kullanıcı adı alanına "admin" yaz',
      'Type "hunter2" into the input',
      '"hunter2" should be accepted', 'Verify the height shows 5′10″',
      'Click the user´s profile',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      'Type "password" into the field',
      'Type "wrongpassword" into the password field, then type "hunter2" into the input',
      'Enter a wrong password, then "hunter2" should be accepted',
      'Enter a wrong password, then "hunter2" is submitted',
      'Type "wrongpassword" into the password field, then type ′hunter2′ into it',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('doğrulama istisnası yalnız giriş fiilsiz doğrulama öbeğini atlar', () => {
    for (const adim of [
      'Type "wrongpass" into the password field and "hunter2" into the confirm password field',
      "Type 'wrongpassword' into the password field, then type 'Hunter2!' into the confirm password box",
      'Type "hunter2" into the visible password field and a wrong PIN',
      'Type the displayed code "hunter2" into the password field and type "wrongpin" into the PIN field',
      'Type "hunter2" into the confirm password field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
    for (const adim of [
      'Verify the password field shows "Error"', 'Verify the error "Invalid password" appears',
      'Verify the password field is visible and click "Login"',
      'Enter a wrong password and verify the password field shows "Error"',
      'Enter a wrong password, then check that the "Invalid credentials" message is visible',
      'Fill in the form and check that the CSRF token is present',
      'Submit the form and verify the session token cookie is set',
      'Enter a search term, then verify the token count is shown',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
  });

  it('genel token adını CSRF/session ve UI/ömür bağlamlarında dışlar', () => {
    for (const ad of [
      'CSRF token', 'XSRF token', 'anti-forgery token', 'antiforgery token', 'session token',
      'token count', 'token cookie', 'token header', 'token page', 'token link',
      'token expired', 'token expiration', 'token refresh', 'token refreshed',
    ]) {
      const adim = `Enter a search term, then inspect the ${ad}`;
      expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
      const tirnakliAdim = `Type "hunter2" into the ${ad} field`;
      expect(adimGercekKimlikIsterMi(tirnakliAdim), tirnakliAdim).toBe(false);
    }
    for (const adim of [
      'Type "hunter2" into the token field', 'Enter "hunter2" as the authentication token',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('tetiklenmiş adımda C0/C1 kontrol karakterlerini zehirli sayar', () => {
    expect(adimGercekKimlikIsterMi(
      'Type "wrongpassword" into the confirm field, then type \u00000\u0000hunter2 into the password field',
    )).toBe(true);
    for (const kod of [0x01, 0x1f, 0x7f, 0x85]) {
      const adim = `Enter a wrong password, then type ${String.fromCharCode(kod)}hunter2 into the field`;
      expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
    }
    for (const kontrol of ['\t', '\n', '\r']) {
      const adim = `Type "wrongpassword"${kontrol}into the password field`;
      expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    }
  });

  it('geniş Türkçe fiilleri T1 dışında, R1 içinde tutar', () => {
    for (const adim of [
      'Şifreyi değiştir sayfasını aç', 'Şifre Değiştir butonuna tıkla',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
    for (const adim of [
      'Şifreyi "hunter2" ile değiştir', 'Şifre alanına "hunter2" yerleştir',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(true);
  });

  it('bilinçli sınırları sabitler', () => {
    expect(adimGercekKimlikIsterMi('Replace it with hunter2')).toBe(false);
    expect(adimGercekKimlikIsterMi('Check the password "hunter2" works')).toBe(false);
    for (const adim of [
      'Type "Wrong_Pass_2024" into the password field',
      'Type "badkey1" into the password field',
    ]) expect(adimGercekKimlikIsterMi(adim), adim).toBe(false);
  });

  it('ortak kural: başlığa bakmaz, giriş yapılandırılmamışsa kapalıdır', () => {
    const adimlar = [{ type: 'action' as const, description: 'Enter the password' }];
    expect(girisKuraliIhlali(adimlar, true)).toContain('already authenticated');
    expect(girisKuraliIhlali(adimlar, false)).toBeNull();
    expect(girisKuraliIhlali([{ type: 'action', description: 'Open the login page' }], true)).toBeNull();
  });
});

describe('yapısal requiresRealCredentials alanı (denetim N6)', () => {
  const beyanli = (oneri: Record<string, unknown>, deger: unknown, anahtar = 'requiresRealCredentials') =>
    ({ ...oneri, title: `${String(oneri.title)} [${String(deger)}]`, [anahtar]: deger });

  it('true düşürür; false olsa da sözcük filtresi gerçek kimlik görürse düşürür; kalan öneri alanı taşımaz', async () => {
    const sonuc = await planUret(await beyin([
      beyanli(SAYFA, true), beyanli(ANASAYFA, 'true'), beyanli(ANASAYFA, true, 'gercekKimlikGerekir'),
      beyanli(GECERLI, false), beyanli(SAYFA, false), beyanli(ANASAYFA, 'false'), beyanli(ANASAYFA, null), ANASAYFA,
    ]), harita(true), undefined);

    expect(sonuc.dropped.map((kayit) => kayit.title)).toEqual([
      'Login page renders [true]', 'View home [true]', 'View home [true]', 'Log in with valid credentials [false]',
    ]);
    expect(sonuc.dropped.slice(0, 3).map((kayit) => kayit.reason)).toEqual([BEYAN_SEBEBI, BEYAN_SEBEBI, BEYAN_SEBEBI]);
    expect(sonuc.dropped[3]?.reason).toContain('step 1: "Enter the username and password"');
    expect(sonuc.proposals.map((oneri) => oneri.title)).toEqual([
      'Login page renders [false]', 'View home [false]', 'View home [null]', 'View home',
    ]);
    for (const oneri of sonuc.proposals) expect(oneri).not.toHaveProperty('requiresRealCredentials');
  });

  it('giriş yapılandırılmamışsa beyan da düşürmez; tanınmayan değer şema hatasıdır', async () => {
    const sonuc = await planUret(await beyin([beyanli(SAYFA, true), ANASAYFA]), harita(false), undefined);
    expect(sonuc.dropped).toEqual([]);
    expect(girisKuraliIhlali([{ description: 'Open the home page' }], true, true)).toBe(BEYAN_SEBEBI);
    expect(girisKuraliIhlali([{ description: 'Open the home page' }], true, false)).toBeNull();
    expect(girisKuraliIhlali([{ description: 'Enter the password' }], true, false)).toContain('already authenticated');
    await expect(planUret(await beyin([beyanli(ANASAYFA, 'maybe')]), harita(true), undefined)).rejects.toThrow();
  });
});

describe('istemler', () => {
  it('plan istemi oturumun açık olduğunu ve giriş yapılandırılmamışsa kuralın geçersiz olduğunu söyler', () => {
    expect(PLAN_SISTEM_ISTEMI).toContain('already authenticated');
    expect(PLAN_SISTEM_ISTEMI).toContain('Logged in: no');
    expect(PLAN_SISTEM_ISTEMI).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    expect(PLAN_SISTEM_ISTEMI).toContain('requiresRealCredentials as a boolean: true if any step needs the real username/password');
    expect(PLAN_SISTEM_ISTEMI).toContain('"requiresRealCredentials":false}]}');
  });

  it('kod üretim istemi sessiz skip yasaklar ve kimlik adımını yorumlatmaz, throw yazdırır', () => {
    const istem = sistemIstemi();
    expect(istem).toContain('Never skip a test or a step');
    expect(istem).toContain('test.skip');
    expect(istem).toContain("throw new Error('kobay: this step needs the real credentials; the session is already authenticated')");
    expect(istem).toContain('Do not reinterpret a step');
    expect(istem).not.toMatch(/write the step as a check of that state/);
  });
});
