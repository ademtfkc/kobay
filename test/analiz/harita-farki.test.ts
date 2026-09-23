import { chromium } from '@playwright/test';
import { beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { Sayfa } from '../../src/depo/index.js';
import { domHaritaFarkiOlustur, haritaFarkiHesapla } from '../../src/analiz/index.js';

function sayfa(degerler: Partial<Sayfa> = {}): Sayfa {
  return {
    url: 'http://uygulama.test/cariler',
    baslik: 'Cariler',
    basliklar: [],
    linkler: [],
    formlar: [],
    dugmeler: [],
    menu: [],
    ...degerler,
  };
}

let tarayiciEngeli: unknown;

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
  }
});

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  context.skip(`Gerçek Chromium bu ortamda engelli: ${String(tarayiciEngeli).split('\n')[0] ?? ''}`);
  return false;
}

describe('haritaFarkiHesapla', () => {
  it('başlık, düğme ve form alanlarını boşlukları normalize ederek karşılaştırır', () => {
    const fark = haritaFarkiHesapla(
      sayfa({
        basliklar: [' Cariler ', 'Ortak   Başlık'],
        dugmeler: [' Kaydet '],
        formlar: [{ alanlar: [
          { ad: 'eposta', tip: 'email' },
          { ad: '   ', tip: 'text', etiket: ' Telefon ' },
          { ad: '', tip: 'text', placeholder: 'Adres' },
        ] }],
      }),
      sayfa({
        basliklar: ['Müşteriler', 'Ortak Başlık'],
        dugmeler: ['Güncelle'],
        formlar: [{ alanlar: [
          { ad: 'eposta', tip: 'email' },
          { ad: '', tip: 'text', etiket: 'Telefon' },
          { ad: 'vergiNo', tip: 'text' },
        ] }],
      }),
    );

    expect(fark).toEqual({
      url: 'http://uygulama.test/cariler',
      eklenenBasliklar: ['Müşteriler'],
      silinenBasliklar: ['Cariler'],
      eklenenDugmeler: ['Güncelle'],
      silinenDugmeler: ['Kaydet'],
      eklenenFormAlanlari: ['vergiNo'],
      silinenFormAlanlari: ['Adres'],
      sayfaKimligiUyusuyor: true,
      degisti: true,
    });
  });

  it('büyük/küçük harf değişimini fark sayar', () => {
    const fark = haritaFarkiHesapla(sayfa({ basliklar: ['Cariler'] }), sayfa({ basliklar: ['cariler'] }));

    expect(fark.silinenBasliklar).toEqual(['Cariler']);
    expect(fark.eklenenBasliklar).toEqual(['cariler']);
    expect(fark.degisti).toBe(true);
  });

  it('link ve menü değişimini gürültü olarak yok sayar', () => {
    const fark = haritaFarkiHesapla(
      sayfa({ linkler: ['/cariler/1'], menu: ['Eski menü'] }),
      sayfa({ linkler: ['/cariler/2'], menu: ['Yeni menü'] }),
    );

    expect(fark.degisti).toBe(false);
  });
});

describe('sayfa kimliği', () => {
  it('sayfa başlığı uyuşuyorsa tek başlık yeniden adlandırılsa da kimliği korur', () => {
    const fark = haritaFarkiHesapla(
      sayfa({ baslik: 'Cariler', basliklar: ['Cariler'] }),
      sayfa({ baslik: ' cariler ', basliklar: ['Müşteriler'] }),
    );

    expect(fark.sayfaKimligiUyusuyor).toBe(true);
  });

  it('giriş ekranına yönlenince (başlık değişince) kimliği tutmaz', () => {
    const fark = haritaFarkiHesapla(
      sayfa({ baslik: 'Cariler', basliklar: ['Cariler'], dugmeler: ['Yeni cari'] }),
      sayfa({ baslik: 'Giriş Yap', basliklar: ['Giriş Yap'], dugmeler: ['Giriş Yap'] }),
    );

    expect(fark.sayfaKimligiUyusuyor).toBe(false);
    expect(fark.degisti).toBe(true);
  });

  it('yalnız sayfa title değişimini fark sayar ama aynı sayfa varsaymaz', () => {
    const fark = haritaFarkiHesapla(
      sayfa({ baslik: 'Cariler', basliklar: ['Cariler'] }),
      sayfa({ baslik: 'Beklenmeyen sayfa', basliklar: ['Cariler'] }),
    );

    expect(fark.sayfaKimligiUyusuyor).toBe(false);
    expect(fark.degisti).toBe(true);
  });

  it('title ile tek görünür başlık birlikte yeniden adlandırılırsa sayfa kimliğini korur', () => {
    const fark = haritaFarkiHesapla(
      sayfa({ baslik: 'Cariler', basliklar: ['Cariler'] }),
      sayfa({ baslik: 'Müşteriler', basliklar: ['Müşteriler'] }),
    );

    expect(fark.sayfaKimligiUyusuyor).toBe(true);
    expect(fark.degisti).toBe(true);
  });

  it('sayfa başlığı okunamıyorsa keşif başlıklarından biri kalmış olmalı', () => {
    const kalan = haritaFarkiHesapla(
      sayfa({ baslik: '', basliklar: ['Cariler', 'Son işlemler'] }),
      sayfa({ baslik: '', basliklar: ['Cariler'] }),
    );
    const kalmayan = haritaFarkiHesapla(
      sayfa({ baslik: '', basliklar: ['Cariler', 'Son işlemler'] }),
      sayfa({ baslik: '', basliklar: ['Giriş Yap'] }),
    );

    expect(kalan.sayfaKimligiUyusuyor).toBe(true);
    expect(kalmayan.sayfaKimligiUyusuyor).toBe(false);
  });

  it('keşifte hiç başlık ve sayfa başlığı yoksa kimliği tutuyor sayar', () => {
    const fark = haritaFarkiHesapla(sayfa({ baslik: '' }), sayfa({ baslik: '', basliklar: ['Yeni'] }));

    expect(fark.sayfaKimligiUyusuyor).toBe(true);
  });
});

describe('domHaritaFarkiOlustur', () => {
  it('kaydedilmiş DOM ağ isteği beklemeden hızlı ayrıştırılır', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const html = `<html><head><title>Cariler</title>
      <link rel="stylesheet" href="http://10.255.255.1/gec.css"></head>
      <body><h1>Cariler</h1>
      <img src="http://127.0.0.1:9/x.png">
      <img src="http://10.255.255.1/y.png">
      <iframe src="http://10.255.255.1/z.html"></iframe>
      <button>Kaydet</button></body></html>`;
    const kesif = sayfa({ basliklar: ['Cariler'], dugmeler: ['Kaydet'] });

    const basladi = Date.now();
    const fark = await domHaritaFarkiOlustur(html, kesif, 'http://uygulama.test');
    const sure = Date.now() - basladi;

    expect(fark.degisti).toBe(false);
    expect(fark.sayfaKimligiUyusuyor).toBe(true);
    expect(sure).toBeLessThan(15_000);
  }, 60_000);
});
