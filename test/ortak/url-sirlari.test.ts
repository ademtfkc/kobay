import { describe, expect, it } from 'vitest';
import { degerdekiUrlSorgulariniGizle, urlSorgulariniGizle } from '../../src/ortak/url-sirlari.js';
import { gizliDegerleriMaskele, istemOlustur } from '../../src/beyin/ortak.js';

/**
 * Spec 2026-11-13 A korpusu: [girdi, beklenen]. Sorgu değerleri ve fragment anahtar adından
 * bağımsız maskelenir; anahtar adları, boş değerler ve sıra kalır. İkinci yarı: adres olmayan
 * metin (kod, seçici, düzyazı) hiç değişmez.
 */
const MASKELENEN: Array<[string, string]> = [
  // Mutlak, Playwright hata satırı.
  ['Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5/cb?code=S1&state=S2&sid=S3&signature=S4',
    'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5/cb?code=[redacted]&state=[redacted]&sid=[redacted]&signature=[redacted]'],
  // Zararsız görünen anahtar da (`id`, `page`) maskelenir; boş değer ve sıra korunur.
  ['https://a.test/x?id=42&empty=&page=2', 'https://a.test/x?id=[redacted]&empty=&page=[redacted]'],
  // Anahtarsız parça mutlak adreste değer sayılır.
  ['https://a.test/x?S1SECRET', 'https://a.test/x?[redacted]'],
  // Fragment: `ad=` biçimi parça parça, düz fragment bütünüyle.
  ['https://a.test/cb#access_token=S1&state=S2', 'https://a.test/cb#access_token=[redacted]&state=[redacted]'],
  ['https://a.test/cb?code=S1#frag', 'https://a.test/cb?code=[redacted]#[redacted]'],
  ['wss://a.test/socket?ticket=S1', 'wss://a.test/socket?ticket=[redacted]'],
  // Göreli adres (kod ve JSON içinde).
  ["await page.goto('/landing?code=S1&state=S2');", "await page.goto('/landing?code=[redacted]&state=[redacted]');"],
  ['{"url":"/cb?code=S1","method":"GET"}', '{"url":"/cb?code=[redacted]","method":"GET"}'],
  ['see cb?sid=S1 now', 'see cb?sid=[redacted] now'],
  ['/cb#access_token=S1', '/cb#access_token=[redacted]'],
  // HTML kaçışlı ayraç.
  ['<a href="/cb?code=S1&amp;state=S2">x</a>', '<a href="/cb?code=[redacted]&amp;state=[redacted]">x</a>'],
  // Kodlanmış: `%3F`, `%3D`, `%26`, `%23` ve kodlanmış şema.
  ['https%3A%2F%2Fa.test%2Fcb%3Fcode%3DS1%26state%3DS2%23t%3DS3', 'https%3A%2F%2Fa.test%2Fcb%3Fcode%3D[redacted]%26state%3D[redacted]%23t%3D[redacted]'],
  ['/login%3Fcode%3DS1', '/login%3Fcode%3D[redacted]'],
  // İç içe yönlendirme: dıştaki değerle birlikte gider.
  ['https://idp.test/auth?redirect_uri=https%3A%2F%2Fapp.test%2Fcb%3Fcode%3DS1&state=S2',
    'https://idp.test/auth?redirect_uri=[redacted]&state=[redacted]'],
  ['/login?next=/cb?code=S1&sid=S2', '/login?next=[redacted]&sid=[redacted]'],
  // JSON kaçışlı metin: kaçış bozulmaz.
  ['"Received string:  \\"http://h/landing?code=S1&state=S2\\"\\nCall log"', '"Received string:  \\"http://h/landing?code=[redacted]&state=[redacted]\\"\\nCall log"'],
  // Sondaki noktalama cümleye ait.
  ['Open http://h/cb?code=S1. Then retry.', 'Open http://h/cb?code=[redacted]. Then retry.'],
  ['(see http://h/cb?code=S1)', '(see http://h/cb?code=[redacted])'],
  // Codex sol tur 1 (P2-1): kullanıcı bilgisi, yalnız noktalamadan oluşan değer, `.` taşıyan göreli anahtar.
  ['http://admin:S1pass@h/?code=S2', 'http://[redacted]@h/?code=[redacted]'],
  ['ws://u:S1@h/socket', 'ws://[redacted]@h/socket'],
  // Parolada `@`: host'tan önceki SON `@`'ye kadar (kör kabul P3-1).
  ['http://u:S1@S2@h/?code=S3', 'http://[redacted]@h/?code=[redacted]'],
  ['http://h/?token=!!!!', 'http://h/?token=[redacted]'],
  ['http://h/#!!!!', 'http://h/#[redacted]'],
  ['/cb?client.id=S1&x=S2', '/cb?client.id=[redacted]&x=[redacted]'],
  // Birden çok adres, satır sonları.
  ['a http://h/1?x=S1\nb http://h/2?y=S2', 'a http://h/1?x=[redacted]\nb http://h/2?y=[redacted]'],
];

const DEGISMEYEN: string[] = [
  'const x = a ? b : c;',
  'page?.url() ?? fallback',
  "await expect(page.locator('div#main')).toBeVisible();",
  'Section #3 of the guide; see issue #42.',
  'https://a.test/path/only',
  'Expected pattern: /never-matches/',
  'What? Yes.',
  'href="#top"',
  '/records',
  'Why?x and done',
  'code=[redacted]',
  '100% done, 50%3F is not a query',
];

describe('urlSorgulariniGizle korpusu', () => {
  it.each(MASKELENEN)('maskeler: %s', (girdi, beklenen) => {
    expect(urlSorgulariniGizle(girdi)).toBe(beklenen);
    // İki kez uygulamak sonucu değiştirmez.
    expect(urlSorgulariniGizle(beklenen)).toBe(beklenen);
    expect(beklenen).not.toMatch(/S[1-4]/);
  });

  it.each(DEGISMEYEN)('dokunmaz: %s', (girdi) => {
    expect(urlSorgulariniGizle(girdi)).toBe(girdi);
  });

  it('JSON değerinde dizeleri ve anahtarları gezer, yapıyı korur', () => {
    const deger = { url: 'http://h/cb?code=S1', n: 3, ic: [{ 'http://h/?k=S2': true }] };
    expect(degerdekiUrlSorgulariniGizle(deger)).toEqual({ url: 'http://h/cb?code=[redacted]', n: 3, ic: [{ 'http://h/?k=[redacted]': true }] });
  });
});

describe('ortak maske ve beyin istemi', () => {
  it('gizliDegerleriMaskele URL sorgularını da maskeler (kanıt, rapor, beyin günlüğü bu yoldan geçer)', () => {
    expect(gizliDegerleriMaskele('at http://h/cb?code=S1&token=S2')).toBe('at http://h/cb?code=[redacted]&token=[redacted]');
  });

  it('beyne giden istem gönderimden önce maskelenir', () => {
    const istem = istemOlustur({ sistem: 'S', kullanici: 'Base URL: http://h/?sid=S1#t=S2', sema: {} as never, gorev: 'plan' } as never);
    expect(istem).toContain('Base URL: http://h/?sid=[redacted]#t=[redacted]');
    expect(istem).not.toContain('S1');
  });
});

describe('komut sonucu kurucuları (Codex P3-9)', () => {
  it('basarili ve basariliMetin gövdeyi, mesajı ve metni maskeler', async () => {
    const { basarili, basariliMetin } = await import('../../src/cli/komut.js');
    const json = { url: 'http://h/cb?code=S1#t=S2' };
    for (const sonuc of [basarili(json, 'at http://h/?sid=S3'), basariliMetin(json, 'Target: http://h/?sid=S3')]) {
      const metin = JSON.stringify(sonuc);
      expect(metin).toContain('code=[redacted]');
      expect(metin).toContain('sid=[redacted]');
      expect(metin).not.toMatch(/S[1-3]/);
    }
  });
});

describe('karmaşıklık (kör kabul P2-1): boşluksuz küçültülmüş CSS', () => {
  it('tarama adımı girdi boyuyla doğrusal büyür (sayaç, duvar saati değil)', async () => {
    const { urlMaskeSayaci } = await import('../../src/ortak/url-sirlari.js');
    const css = (n: number): string => Array.from({ length: n }, (_, i) => `.c${i}{color:#${(i * 2654435761 >>> 8).toString(16).padStart(6, '0').slice(0, 6)}}`).join('');
    const olc = (metin: string): number => {
      urlMaskeSayaci.adim = 0;
      expect(urlSorgulariniGizle(metin)).toBe(metin);
      return urlMaskeSayaci.adim;
    };
    const kucuk = css(1000);
    const buyuk = css(2000);
    const a = olc(kucuk);
    const b = olc(buyuk);
    // Doğrusal: karakter başına sabit adım ve boy ×2 → adım ~×2 (karesel ×4 olurdu).
    expect(b / buyuk.length).toBeLessThan(8);
    expect(b / Math.max(1, a)).toBeLessThan(2.6);
  });
});
