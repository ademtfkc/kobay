import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cerezAlaniIzinliMi,
  iceAlinanOturumMetni,
  iceAlinanOturumuOku,
  OTURUM_DOSYASI_TAVANI,
  oturumDosyasiniHazirla,
  oturumDosyasiOku,
  oturumDurumunuCoz,
  oturumKokenleriniDenetle,
  SessionFileError,
} from '../../src/kesif/oturum-dosyasi.js';
import type { OturumCerezi, OturumDurumu, Sayfa } from '../../src/depo/index.js';
import type { BrowserContext } from '@playwright/test';
import {
  girisKorumasiSonDenetim,
  oturumAdiniGizle,
  oturumKorumasiKur,
} from '../../src/kesif/giris-korumasi.js';
import { haritaMaskesi, oturumEslesenAdlar, oturumEsleyici, oturumMetinMaskesi, tamBasliklardaDegerVarMi, type OturumGirdisi } from '../../src/kesif/giris-korumasi.js';
import { sayfaMetinleriniGizle } from '../../src/kesif/sayfa-ozeti.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/** Hata mesajlarında asla görünmemesi gereken çerez değeri. */
const SIR = 'SIRCEREZ-7f3a9c1e5b2d4086';

function cerez(domain: string, ek: Partial<OturumCerezi> = {}): OturumCerezi {
  return {
    name: 'kobaycerezadi', value: SIR, domain, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax', ...ek,
  };
}

function durum(cookies: OturumCerezi[], origins: OturumDurumu['origins'] = []): OturumDurumu {
  return { cookies, origins };
}

async function hataMesaji(is: () => unknown): Promise<string> {
  try {
    await is();
  } catch (hata: unknown) {
    expect(hata).toBeInstanceOf(SessionFileError);
    return (hata as Error).message;
  }
  throw new Error('hata bekleniyordu');
}

describe('çerez alanı köken kuralı', () => {
  const BASE = 'https://app.example.com';
  it.each([
    ['app.example.com', true, 'ana makinenin kendisi (host-only)'],
    ['.app.example.com', true, 'nokta önekli aynı ad'],
    ['.example.com', true, 'kayıtlı alan adına yazılmış alan çerezi: üst alan'],
    ['example.com', false, 'noktasız (host-only) çerez başka ana makinenindir'],
    ['api.example.com', false, 'kardeş ana makine hiçbir zaman'],
    ['.api.example.com', false, 'kardeşin alan çerezi'],
    ['.x.app.example.com', false, 'alt alan, üst alan değil'],
    ['APP.EXAMPLE.COM.', true, 'büyük harf ve sondaki nokta'],
    ['.com', false, 'kamu soneki'],
    ['com', false, 'kamu soneki noktasız'],
    ['evil.com', false, 'yabancı site'],
    ['example.com.evil.net', false, 'sonek aldatmacası'],
    ['', false, 'boş'],
  ])('%s → %s (%s)', (alan, beklenen) => {
    expect(cerezAlaniIzinliMi(alan, BASE, [])).toBe(beklenen);
  });

  it('kardeş kiracı (Codex P1: alice.id.au ↔ evil.id.au) reddedilir; listede olmayan kamu soneki üst alan olarak geçer (bilinen sınır)', () => {
    expect(cerezAlaniIzinliMi('evil.id.au', 'https://alice.id.au', [])).toBe(false);
    expect(cerezAlaniIzinliMi('.evil.id.au', 'https://alice.id.au', [])).toBe(false);
    expect(cerezAlaniIzinliMi('alice.id.au', 'https://alice.id.au', [])).toBe(true);
    // El listesi Public Suffix List değil: `id.au` listede yok, üst alan sayılır (README'de bilinen sınır).
    expect(cerezAlaniIzinliMi('.id.au', 'https://alice.id.au', [])).toBe(true);
    expect(cerezAlaniIzinliMi('.com.au', 'https://shop.com.au', [])).toBe(false);
  });

  it('localhost ve IP: ad birebir (port çerezde yok); localhost ile 127.0.0.1 farklı', () => {
    expect(cerezAlaniIzinliMi('localhost', 'http://localhost:3000', [])).toBe(true);
    expect(cerezAlaniIzinliMi('127.0.0.1', 'http://localhost:3000', [])).toBe(false);
    expect(cerezAlaniIzinliMi('127.0.0.1', 'http://127.0.0.1:8080', [])).toBe(true);
    expect(cerezAlaniIzinliMi('127.0.0.2', 'http://127.0.0.1:8080', [])).toBe(false);
  });

  it('kiracıya ayrılmış barındırma: komşu kiracı ve sonekin kendisi reddedilir', () => {
    expect(cerezAlaniIzinliMi('.github.io', 'https://me.github.io', [])).toBe(false);
    expect(cerezAlaniIzinliMi('you.github.io', 'https://me.github.io', [])).toBe(false);
    expect(cerezAlaniIzinliMi('me.github.io', 'https://me.github.io', [])).toBe(true);
    expect(cerezAlaniIzinliMi('.amazonaws.com', 'https://b.s3.amazonaws.com', [])).toBe(false);
  });

  it('auth origin: ana makinesi ya da noktalı üst alanı; kiracı soneki ve kardeş değil', () => {
    const auth = ['https://yourco.okta.com'];
    expect(cerezAlaniIzinliMi('yourco.okta.com', 'https://app.example.com', auth)).toBe(true);
    // Codex 2. tur: gerçek Okta dışa aktarımı noktalı; kendi üst alanı kabul (alt alanlarına da gider: bilinen sınır).
    expect(cerezAlaniIzinliMi('.yourco.okta.com', 'https://app.example.com', auth)).toBe(true);
    // Kimlik sağlayıcı kiracı soneki: bütün kiracılara giderdi.
    expect(cerezAlaniIzinliMi('.okta.com', 'https://app.example.com', auth)).toBe(false);
    expect(cerezAlaniIzinliMi('.us.auth0.com', 'https://app.example.com', ['https://t.us.auth0.com'])).toBe(false);
    expect(cerezAlaniIzinliMi('.t.us.auth0.com', 'https://app.example.com', ['https://t.us.auth0.com'])).toBe(true);
    expect(cerezAlaniIzinliMi('.okta.com', 'https://app.example.com', auth)).toBe(false);
    expect(cerezAlaniIzinliMi('evilco.okta.com', 'https://app.example.com', auth)).toBe(false);
  });
});

describe('köken denetimi', () => {
  it('yabancı çerez ve yabancı localStorage origin reddedilir; mesaj kökeni söyler, değeri söylemez', async () => {
    const mesaj = await hataMesaji(() => oturumKokenleriniDenetle(durum(
      [cerez('localhost'), cerez('.evil.example', { value: `${SIR}-2` })],
      [{ origin: 'http://evil.test:9', localStorage: [{ name: 'tok', value: SIR }] }],
    ), 'http://localhost:3000', []));
    expect(mesaj).toContain('cookie domain .evil.example');
    expect(mesaj).toContain('storage origin http://evil.test:9');
    expect(mesaj).toContain('nothing was imported');
    expect(mesaj).not.toContain(SIR);
    expect(mesaj).not.toContain('kobaycerezadi');
  });

  it('localStorage origin: kardeş ana makine reddedilir (aynı-site genellemesi yok)', () => {
    expect(() => oturumKokenleriniDenetle(durum([], [
      { origin: 'https://api.example.com', localStorage: [] },
    ]), 'https://app.example.com', [])).toThrow(/storage origin https:\/\/api\.example\.com/);
  });

  it('localStorage origin: aynı ana makine (port serbest) ve tam auth origin geçer; auth sitesinin başka portu geçmez', () => {
    const base = 'http://localhost:3000';
    const auth = ['http://localhost.auth:7000'];
    expect(() => oturumKokenleriniDenetle(durum([], [
      { origin: 'http://localhost:3000', localStorage: [] },
      { origin: 'http://localhost:3001', localStorage: [] },
      { origin: 'http://localhost.auth:7000', localStorage: [] },
    ]), base, auth)).not.toThrow();
    expect(() => oturumKokenleriniDenetle(durum([], [
      { origin: 'http://localhost.auth:7001', localStorage: [] },
    ]), base, auth)).toThrow(SessionFileError);
    // Şema farkı da yabancı (https hedefe http origin).
    expect(() => oturumKokenleriniDenetle(durum([], [
      { origin: 'http://app.example.com', localStorage: [] },
    ]), 'https://app.example.com', [])).toThrow(SessionFileError);
  });

  it('origin alanı tam bir http(s) origin\'i değilse reddedilir (yol, başka şema)', () => {
    for (const origin of ['http://localhost:3000/yol', 'file:///etc', 'javascript:alert(1)', 'localhost:3000']) {
      expect(() => oturumKokenleriniDenetle(durum([], [{ origin, localStorage: [] }]), 'http://localhost:3000', []), origin)
        .toThrow(/not an http\(s\) origin/);
    }
  });

  it('secure ve sameSite karara girmez (çerezin gideceği ana makineyi genişletmezler)', () => {
    expect(() => oturumKokenleriniDenetle(durum([
      cerez('localhost', { secure: true, sameSite: 'None' }),
      cerez('localhost', { secure: false, sameSite: 'Strict' }),
    ]), 'http://localhost:3000', [])).not.toThrow();
  });
});

describe('şema', () => {
  it('geçerli dosyayı okur, bilinmeyen alanları atar', () => {
    const cozulen = oturumDurumunuCoz(JSON.stringify({
      cookies: [{ ...cerez('localhost'), partitionKey: 'x' }], origins: [], ekstra: true,
    }));
    expect(cozulen).toEqual(durum([cerez('localhost')]));
  });

  it('expires: -1 (oturum çerezi) ve sonlu pozitif saniye geçer', () => {
    expect(oturumDurumunuCoz(JSON.stringify(durum([cerez('localhost', { expires: 1_900_000_000.5 })]))).cookies[0]?.expires)
      .toBe(1_900_000_000.5);
  });

  it('BOM\'lu dosya okunur', () => {
    expect(oturumDurumunuCoz(`\uFEFF${JSON.stringify(durum([]))}`)).toEqual(durum([]));
  });

  it.each([
    ['cookies yok', { origins: [] }, 'cookies'],
    ['origins yok', { cookies: [] }, 'origins'],
    ['sameSite bilinmeyen', { cookies: [{ ...cerez('localhost'), sameSite: 'Sometimes' }], origins: [] }, 'cookies.0.sameSite'],
    ['expires -5', { cookies: [{ ...cerez('localhost'), expires: -5 }], origins: [] }, 'cookies.0.expires'],
    ['expires 1e300', { cookies: [{ ...cerez('localhost'), expires: 1e300 }], origins: [] }, 'cookies.0.expires'],
    ['expires 0', { cookies: [{ ...cerez('localhost'), expires: 0 }], origins: [] }, 'cookies.0.expires'],
    ['value sayı', { cookies: [{ ...cerez('localhost'), value: 12345678912345 }], origins: [] }, 'cookies.0.value'],
    ['domain boşluklu', { cookies: [cerez(`evil.com ${SIR}`)], origins: [] }, 'cookies.0.domain'],
    ['domain kontrol karakterli', { cookies: [cerez('a\nb')], origins: [] }, 'cookies.0.domain'],
    ['dizi', [], 'cookies'],
    ['null', null, '(top level)'],
  ])('%s → reddedilir, alan yolu yazılır, değer yazılmaz', async (_ad, veri, yol) => {
    const mesaj = await hataMesaji(() => oturumDurumunuCoz(JSON.stringify(veri)));
    expect(mesaj).toContain(yol);
    expect(mesaj).not.toContain(SIR);
    expect(mesaj).not.toContain('12345678912345');
  });

  it('JSON değilse ayrıştırıcının alıntısı (dosya parçası) mesaja girmez', async () => {
    const mesaj = await hataMesaji(() => oturumDurumunuCoz(`{"cookies": [${SIR}`));
    expect(mesaj).toContain('not valid JSON');
    expect(mesaj).not.toContain(SIR);
  });
});

describe('dosya okuma', () => {
  it('1 MB tavanı: tam tavan okunur, bir bayt fazlası reddedilir', async () => {
    const dizin = await geciciDizinAc('kobay-oturum-dosyasi-');
    const temel = JSON.stringify(durum([]));
    const tam = join(dizin, 'tam.json');
    await writeFile(tam, temel + ' '.repeat(OTURUM_DOSYASI_TAVANI - temel.length));
    expect((await oturumDosyasiOku(tam)).length).toBe(OTURUM_DOSYASI_TAVANI);
    const fazla = join(dizin, 'fazla.json');
    await writeFile(fazla, temel + ' '.repeat(OTURUM_DOSYASI_TAVANI - temel.length + 1));
    expect(await hataMesaji(() => oturumDosyasiOku(fazla))).toContain('larger than 1048576 bytes');
  });

  it('yok, dizin ve FIFO reddedilir (FIFO açılışta asılı kalmaz)', async () => {
    const dizin = await geciciDizinAc('kobay-oturum-dosyasi-');
    expect(await hataMesaji(() => oturumDosyasiOku(join(dizin, 'yok.json')))).toContain('not found');
    await mkdir(join(dizin, 'klasor'));
    expect(await hataMesaji(() => oturumDosyasiOku(join(dizin, 'klasor')))).toContain('not a regular file');
    if (process.platform !== 'win32') {
      const fifo = join(dizin, 'boru');
      execFileSync('mkfifo', [fifo]);
      expect(await hataMesaji(() => oturumDosyasiOku(fifo))).toContain('not a regular file');
    }
  });

  it('hazırlık: yazılacak metin yalnız bilinen alanları ve içe alma işaretini taşır', async () => {
    const dizin = await geciciDizinAc('kobay-oturum-dosyasi-');
    const yol = join(dizin, 'state.json');
    await writeFile(yol, JSON.stringify({ cookies: [{ ...cerez('localhost'), fazla: 1 }], origins: [] }));
    const { metin } = await oturumDosyasiniHazirla(yol, 'http://localhost:3000', []);
    expect(JSON.parse(metin)).toEqual({ kobay: { sessionSource: 'imported' }, cookies: [cerez('localhost')], origins: [] });
  });
});

describe('kayıtlı dosyanın içe alınmış olup olmadığı', () => {
  it('işaretsiz dosya (giriş akışı ya da kimliksiz keşif) ve olmayan dosya: null, eski yol', async () => {
    const dizin = await geciciDizinAc('kobay-oturum-dosyasi-');
    const yol = join(dizin, 'storageState.json');
    expect(await iceAlinanOturumuOku(yol, 'http://localhost:3000', [])).toBeNull();
    // Yabancı çerez taşısa bile işaretsiz dosya bu yolun konusu değil.
    await writeFile(yol, JSON.stringify(durum([cerez('evil.com')])));
    expect(await iceAlinanOturumuOku(yol, 'http://localhost:3000', [])).toBeNull();
    // Codex 2. tur: var ama okunamayan/bozuk dosya "yok" sayılmaz (üstüne yazılıp kaybolmasın).
    await writeFile(yol, 'bozuk');
    expect(await hataMesaji(() => iceAlinanOturumuOku(yol, 'http://localhost:3000', []))).toContain('did not touch it');
  });

  it('işaretli dosya her okumada yeniden doğrulanır: elle eklenen yabancı çerez reddedilir', async () => {
    const dizin = await geciciDizinAc('kobay-oturum-dosyasi-');
    const yol = join(dizin, 'storageState.json');
    await writeFile(yol, iceAlinanOturumMetni(durum([cerez('localhost')])));
    expect(await iceAlinanOturumuOku(yol, 'http://localhost:3000', [])).toEqual(durum([cerez('localhost')]));
    await writeFile(yol, iceAlinanOturumMetni(durum([cerez('localhost'), cerez('evil.com')])));
    const mesaj = await hataMesaji(() => iceAlinanOturumuOku(yol, 'http://localhost:3000', []));
    expect(mesaj).toContain('no longer valid');
    expect(mesaj).toContain('evil.com');
    expect(mesaj).not.toContain(SIR);
  });
});

describe('kayıtlı dosyanın sınırlı okunması', () => {
  it('1 MB üstü kayıtlı dosya açık hata (üstüne yazılmasın); FIFO kayıtlı dosya asılmadan reddedilir', async () => {
    const dizin = await geciciDizinAc('kobay-oturum-dosyasi-');
    const yol = join(dizin, 'storageState.json');
    const metin = iceAlinanOturumMetni(durum([cerez('localhost')]));
    await writeFile(yol, metin.trimEnd() + ' '.repeat(OTURUM_DOSYASI_TAVANI));
    expect(await hataMesaji(() => iceAlinanOturumuOku(yol, 'http://localhost:3000', []))).toContain('larger than');
    if (process.platform !== 'win32') {
      const fifo = join(dizin, 'boru.json');
      execFileSync('mkfifo', [fifo]);
      expect(await hataMesaji(() => iceAlinanOturumuOku(fifo, 'http://localhost:3000', []))).toContain('not a regular file');
    }
  });
});

const g = (...degerler: string[]): OturumGirdisi[] => degerler.map((deger, i) => ({ ad: `cookie c${i}`, deger }));

describe('içe alınan oturum izi (Opus 2. kabul: 8 karakterden kısa değer sır değil)', () => {
  it('8+ karakter her yerde ve her biçimde; 8 karakterden kısa değerler hiç izlenmez', () => {
    const tasir = oturumEsleyici(g('ABC123', 'true', 'dark', 'x'.repeat(2000), 'http://localhost:1/tok', SIR));
    expect(tasir('https://evil/?x=ABC123')).toBe(false);
    expect(tasir('https://evil/pixel?lazy=true&theme=dark')).toBe(false);
    expect(tasir(`https://evil/?x=${'x'.repeat(2000)}`)).toBe(true);
    expect(tasir(`https://evil/?u=${encodeURIComponent('http://localhost:1/tok')}`)).toBe(true);
    expect(tasir(`https://evil/?a${SIR}b`)).toBe(true);
    const b64 = Buffer.from(SIR).toString('base64').replace(/=+$/, '');
    expect(tasir(`https://evil/collect/${b64}`)).toBe(true);
    expect(tasir(`https://evil/c/${b64.replace(/\+/g, '-').replace(/\//g, '_')}`)).toBe(true);
  });

  it('eşleşen değerin ADI bulunur (mesaj için), değeri değil', () => {
    const adlar = oturumEslesenAdlar([{ ad: 'cookie sid', deger: SIR }, { ad: 'localStorage jwt', deger: 'JWT-0123456789' }]);
    expect(adlar(`https://evil/?s=${SIR}`)).toEqual(['cookie sid']);
  });

  it('1.000.000 karakterlik tek değer: maske ve eşleştirme RegExp kurmaz, atmaz', () => {
    const buyuk = 'Z'.repeat(999_999) + '1';
    expect(oturumMetinMaskesi(g(buyuk))(`a ${buyuk} b`)).toBe('a [redacted] b');
    expect(haritaMaskesi([buyuk]).metin(`a ${buyuk} b`)).toBe('a [redacted] b');
    expect(oturumEsleyici(g(buyuk))(`x=${buyuk}`)).toBe(true);
  });
});

describe('harita maskesi (Opus 2. kabul R1): yalnız serbest metin, yapı dokunulmaz', () => {
  const sayfa = (url: string, ek: Partial<Sayfa> = {}): Sayfa => ({
    url, title: '', headings: [], links: [], forms: [], buttons: [], menu: [], ...ek,
  });

  it('Opus senaryosu: parola `admin`, /admin bağlantıları, action /admin/save, alan admin_role → harita birebir aynı', () => {
    const ham = sayfa('http://127.0.0.1:3000/admin', {
      title: 'Admin', headings: ['admin panel'],
      links: ['http://127.0.0.1:3000/admin', 'http://127.0.0.1:3000/admin/users'],
      forms: [{ action: 'http://127.0.0.1:3000/admin/save', fields: [{ name: 'admin_role', type: 'text', label: 'admin role' }] }],
      buttons: ['Save admin'], menu: ['admin'],
    });
    expect(sayfaMetinleriniGizle(ham, haritaMaskesi([], 'admin'))).toEqual(ham);
  });

  it('URL alanları ve alan adı hiç değişmez; 16+ karakterlik sır taşıyan bağlantı ve action düşer; serbest metin maskelenir', () => {
    const maske = haritaMaskesi(['returnTo=https://app.example.com/dashboard', 'dashboard', 'records', SIR]);
    const sonuc = sayfaMetinleriniGizle(sayfa(`https://app.example.com/reset/${SIR}`, {
      title: `Dashboard ${SIR}`,
      headings: ['records', 'dashboard'],
      links: ['https://app.example.com/dashboard', `https://app.example.com/reset/${SIR}`, `https://app.example.com/r?t=${encodeURIComponent(SIR)}`],
      forms: [
        { action: `https://app.example.com/f/${SIR}`, fields: [
          { name: SIR, type: 'text', label: 'x' },
          { name: 'tok', type: 'text', label: `Tok ${SIR}`, placeholder: SIR, options: [SIR] },
        ] },
        { action: 'https://app.example.com/records', fields: [] },
      ],
      buttons: [`Use ${SIR}`],
      menu: ['dashboard'],
      redirectedTo: 'https://app.example.com/giris',
    }), maske);
    // Sayfa adresi olduğu gibi (bilinen sınır).
    expect(sonuc.url).toBe(`https://app.example.com/reset/${SIR}`);
    expect(sonuc.links).toEqual(['https://app.example.com/dashboard']);
    expect(sonuc.forms[0]).not.toHaveProperty('action');
    expect(sonuc.forms[1]?.action).toBe('https://app.example.com/records');
    expect(sonuc.redirectedTo).toBe('https://app.example.com/giris');
    expect(sonuc.headings).toEqual(['records', 'dashboard']);
    expect(sonuc.menu).toEqual(['dashboard']);
    expect(sonuc.title).toBe('Dashboard [redacted]');
    // Codex 3. tur: `name`'i 16+ karakterlik oturum değeri taşıyan alan düşer (seçici maskelenmez).
    expect(sonuc.forms[0]?.fields).toHaveLength(1);
    expect(sonuc.forms[0]?.fields[0]).toMatchObject({ name: 'tok', label: 'Tok [redacted]', placeholder: '[redacted]', options: ['[redacted]'] });
    expect(JSON.stringify(sonuc.forms)).not.toContain(SIR);
  });

  it('parola: serbest metinde 8+ karakter, büyük/küçük harfe duyarsız; adreslere bakılmaz; kısa parola maskelenmez', () => {
    const maske = haritaMaskesi([], 'Secret12');
    expect(maske.metin('Hi SECRET12 / secret12 / Secret12')).toBe('Hi [redacted] / [redacted] / [redacted]');
    expect(maske.yapisalDusur('https://app/secret12')).toBe(false);
    expect(haritaMaskesi([], 'admin').bos).toBe(true);
  });
});

describe('tam başlık yolu (allHeaders)', () => {
  it('Cookie yalnız allHeaders()\'ta görünen istek yakalanır (headers() Cookie vermese de)', async () => {
    const istek = {
      url: () => 'https://evil.example/r',
      postDataBuffer: () => null,
      headers: () => ({ accept: '*/*' }),
      allHeaders: async () => ({ accept: '*/*', cookie: `sid=${SIR}` }),
    };
    expect(await tamBasliklardaDegerVarMi(istek, oturumEsleyici(g(SIR)))).toBe(true);
    expect(await tamBasliklardaDegerVarMi({ ...istek, allHeaders: async () => ({ accept: '*/*' }) }, oturumEsleyici(g(SIR)))).toBe(false);
  });
});

describe('Codex 3. tur: harita maskesi biçimleri ve yapısal regresyonlar', () => {
  const sayfa = (url: string, ek: Partial<Sayfa> = {}): Sayfa => ({
    url, title: '', headings: [], links: [], forms: [], buttons: [], menu: [], ...ek,
  });

  it('serbest metinde base64/base64url biçimleri ve harfe duyarsız yüzde-kodu maskelenir', () => {
    const maske = haritaMaskesi(['sessionABC123', 'a/b?c=d&e/f'], 's3cr3t!x');
    // Dolgu (`=`) kalabilir, değer gider.
    expect(maske.metin(`v ${Buffer.from('sessionABC123').toString('base64')}`)).toMatch(/^v \[redacted\]=*$/);
    expect(maske.metin(`v ${encodeURIComponent('a/b?c=d&e/f').toLowerCase()}`)).toBe('v [redacted]');
    // Parola: ham biçim (8+), harfe duyarsız.
    expect(maske.metin('p S3CR3T!X')).toBe('p [redacted]');
  });

  it('düz sözcük istisnası Unicode harf, - ve _ kapsar (sidebar-open, workspace_v, kullanıcılar)', () => {
    const maske = haritaMaskesi(['sidebar-open', 'workspace_v', 'kullanıcılar']);
    expect(maske.metin('sidebar-open workspace_v kullanıcılar')).toBe('sidebar-open workspace_v kullanıcılar');
  });

  it('Codex örnekleri: parola http/test, oturum app.example, göreli action → yapı birebir aynı', () => {
    const ham = sayfa('https://app.example.com/contest', {
      title: 'Contest',
      links: ['https://app.example.com', 'https://app.example.com/contest'],
      forms: [{ action: '/save/sessionABC123', fields: [{ name: 'q', type: 'text' }] }],
    });
    for (const maske of [haritaMaskesi([], 'http'), haritaMaskesi([], 'test'), haritaMaskesi(['app.example', 'sessionABC123'])]) {
      const sonuc = sayfaMetinleriniGizle(ham, maske);
      expect(sonuc.url).toBe(ham.url);
      expect(sonuc.links).toEqual(ham.links);
      expect(sonuc.forms).toEqual(ham.forms);
    }
  });
});

describe('son kabul: P3', () => {
  it('parola düz sözcükse serbest metinde maskelenmez; harf dışı karakterli parola maskelenir', () => {
    expect(haritaMaskesi([], 'password').metin('Reset password')).toBe('Reset password');
    expect(haritaMaskesi([], 'testtest1').metin('Hi TESTTEST1')).toBe('Hi [redacted]');
  });

  it('sızıntı mesajındaki ad: e-posta benzeri parça ve 16+ karakterlik harf/rakam dizisi gizlenir', () => {
    expect(oturumAdiniGizle('cookie sid')).toBe('cookie sid');
    expect(oturumAdiniGizle('localStorage CognitoIdentityServiceProvider.1example23456789abcd.ali@ornek.com.idToken'))
      .not.toMatch(/ali@ornek|1example23456789abcd/);
    expect(oturumAdiniGizle('localStorage CognitoIdentityServiceProvider.1example23456789abcd.LastAuthUser'))
      .toBe('localStorage [redacted].[redacted].LastAuthUser');
  });

  it('koruma uçtan uca: Cookie yalnız allHeaders()\'ta görünen yabancı istek ve yönlendirme ayağı sızıntı sayılır', async () => {
    type Dinleyici = (...argumanlar: unknown[]) => unknown;
    const dinleyiciler: Record<string, Dinleyici[]> = {};
    let yakala: Dinleyici | undefined;
    const context = {
      route: async (_desen: string, isleyici: Dinleyici) => { yakala = isleyici; },
      routeWebSocket: async () => undefined,
      on: (olay: string, f: Dinleyici) => { (dinleyiciler[olay] ??= []).push(f); },
      pages: () => [],
    } as unknown as BrowserContext;
    const istek = (url: string, yonlendirme: boolean) => ({
      url: () => url,
      method: () => 'GET',
      headers: () => ({ accept: '*/*' }),
      allHeaders: async () => ({ accept: '*/*', cookie: `sid=${SIR}` }),
      postDataBuffer: () => null,
      isNavigationRequest: () => false,
      redirectedFrom: () => (yonlendirme ? {} : null),
    });
    await oturumKorumasiKur(context, 'https://app.example.com', [], [{ ad: 'cookie sid', deger: SIR }]);
    let kesildi = false;
    await yakala?.({ abort: async () => { kesildi = true; }, fallback: async () => undefined }, istek('https://evil.example/a', false));
    expect(kesildi).toBe(true);
    await expect(girisKorumasiSonDenetim(context)).rejects.toThrow(/cookie sid/);
  });

  it('koruma uçtan uca: yönlendirme ayağının Cookie\'si yalnız allHeaders()\'ta → son denetim sızıntı', async () => {
    type Dinleyici = (...argumanlar: unknown[]) => unknown;
    const dinleyiciler: Record<string, Dinleyici[]> = {};
    const context = {
      route: async () => undefined,
      routeWebSocket: async () => undefined,
      on: (olay: string, f: Dinleyici) => { (dinleyiciler[olay] ??= []).push(f); },
      pages: () => [],
    } as unknown as BrowserContext;
    await oturumKorumasiKur(context, 'https://app.example.com', [], [{ ad: 'cookie sid', deger: SIR }]);
    for (const f of dinleyiciler.request ?? []) {
      f({
        url: () => 'https://evil.example/r',
        method: () => 'GET',
        headers: () => ({ accept: '*/*' }),
        allHeaders: async () => ({ cookie: `sid=${SIR}` }),
        postDataBuffer: () => null,
        isNavigationRequest: () => false,
        redirectedFrom: () => ({}),
      });
    }
    await expect(girisKorumasiSonDenetim(context)).rejects.toThrow(/imported session/);
  });

  it('sızıntı mesajı kimlik taşıyan anahtar adını gizler (Cognito)', async () => {
    type Dinleyici = (...argumanlar: unknown[]) => unknown;
    let yakala: Dinleyici | undefined;
    const context = {
      route: async (_desen: string, isleyici: Dinleyici) => { yakala = isleyici; },
      routeWebSocket: async () => undefined,
      on: () => undefined,
      pages: () => [],
    } as unknown as BrowserContext;
    const ad = 'localStorage CognitoIdentityServiceProvider.1example23456789abcd.ali@ornek.com.idToken';
    await oturumKorumasiKur(context, 'https://app.example.com', [], [{ ad, deger: SIR }]);
    await yakala?.({ abort: async () => undefined, fallback: async () => undefined }, {
      url: () => `https://evil.example/?t=${SIR}`, method: () => 'GET', headers: () => ({}), allHeaders: async () => ({}),
      postDataBuffer: () => null, isNavigationRequest: () => false, redirectedFrom: () => null,
    });
    const hata = await girisKorumasiSonDenetim(context).then(() => null, (h: unknown) => h as Error);
    expect(hata?.message).toContain('localStorage [redacted]');
    expect(hata?.message).not.toMatch(/ali@ornek|1example23456789abcd/);
  });
});
