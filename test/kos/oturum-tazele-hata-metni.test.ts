import { chromium } from '@playwright/test';
import { describe, expect, it, type TestContext } from 'vitest';
import { girisKorumasiKur } from '../../src/kesif/giris-korumasi.js';
import { hataMetni } from '../../src/kos/oturum-tazele.js';

/**
 * M14: koşu öncesi yeniden girişin `catch` yolundaki yedek maske (`hataMetni`). Gezinme hatası
 * olmayan metin kullanıcıya tek satır olarak gider: adresin sorgu/fragment değerleri
 * (`urlSorgulariniGizle`) ve giriş korumasının sır envanteri (`koruma.metniGizle`) maskelenir.
 */

const kati = process.env.KOBAY_TEST_STRICT === '1';
const ORIGIN = 'http://127.0.0.1:9';
const PAROLA = 'm14-parola-SECRET_M14_PAROLA-8642';

describe('M14: yeniden giriş hata metninin yedek maskesi', () => {
  it('bağlam yokken sorgu ve fragment değerleri maskelenir, yalnız ilk satır kalır', () => {
    const metin = hataMetni(
      new Error(`locator.click: boom at ${ORIGIN}/cb?code=SECRET_M14_SORGU&state=SECRET_M14_STATE#t=SECRET_M14_FRAG\nikinci SECRET_M14_SATIR`),
      undefined,
    );
    // Sahte test olmasın: metin gerçekten taşındı (maskeli).
    expect(metin).toContain('locator.click: boom at http://127.0.0.1:9/cb?code=[redacted]');
    expect(metin).not.toContain('SECRET_M14');
  });

  it('giriş koruması kuruluysa sır envanteri (parola) de maskelenir', async (context: TestContext) => {
    let tarayici;
    try {
      tarayici = await chromium.launch({ headless: true });
    } catch (hata: unknown) {
      const ozet = String(hata).split('\n')[0] ?? '';
      if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
      context.skip(`Chromium engelli: ${ozet}`);
      return;
    }
    try {
      const baglam = await tarayici.newContext();
      await girisKorumasiKur(baglam, { username: 'm14-kullanici', password: PAROLA, origin: ORIGIN }, [ORIGIN]);
      const metin = hataMetni(new Error(`fill failed: value "${PAROLA}" rejected at /login`), baglam);
      expect(metin).toContain('fill failed: value "');
      expect(metin).toContain('rejected at /login');
      expect(metin).not.toContain('SECRET_M14');
    } finally {
      await tarayici.close();
    }
  });
});
