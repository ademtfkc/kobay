import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { beyinOlustur } from '../../src/beyin/index.js';
import { yazAtomik, type Harita } from '../../src/depo/index.js';
import { BEYAN_SEBEBI, PLAN_SISTEM_ISTEMI, adimGercekKimlikIsterMi, girisKuraliIhlali, planUret } from '../../src/plan/index.js';
import { sistemIstemi } from '../../src/uret/istem.js';

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
  const dizin = await mkdtemp(join(tmpdir(), 'kobay-giris-'));
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
