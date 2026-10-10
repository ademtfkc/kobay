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
