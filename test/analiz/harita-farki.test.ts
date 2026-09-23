import { chromium } from '@playwright/test';
import { beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { Sayfa } from '../../src/depo/index.js';
import { domHaritaFarkiOlustur, haritaFarkiHesapla } from '../../src/analiz/index.js';

function sayfa(degerler: Partial<Sayfa> = {}): Sayfa {
  return {
    url: 'http://uygulama.test/cariler',
    title: 'Cariler',
    headings: [],
    links: [],
    forms: [],
    buttons: [],
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
        headings: [' Cariler ', 'Ortak   Başlık'],
        buttons: [' Kaydet '],
        forms: [{ fields: [
          { name: 'eposta', type: 'email' },
          { name: '   ', type: 'text', label: ' Telefon ' },
          { name: '', type: 'text', placeholder: 'Adres' },
        ] }],
      }),
      sayfa({
        headings: ['Müşteriler', 'Ortak Başlık'],
        buttons: ['Güncelle'],
        forms: [{ fields: [
          { name: 'eposta', type: 'email' },
          { name: '', type: 'text', label: 'Telefon' },
          { name: 'vergiNo', type: 'text' },
        ] }],
      }),
    );

    expect(fark).toEqual({
      url: 'http://uygulama.test/cariler',
      addedHeadings: ['Müşteriler'],
      removedHeadings: ['Cariler'],
      addedButtons: ['Güncelle'],
      removedButtons: ['Kaydet'],
      addedFormFields: ['vergiNo'],
      removedFormFields: ['Adres'],
      pageIdentityMatches: true,
      changed: true,
    });
  });

  it('büyük/küçük harf değişimini fark sayar', () => {
    const fark = haritaFarkiHesapla(sayfa({ headings: ['Cariler'] }), sayfa({ headings: ['cariler'] }));

    expect(fark.removedHeadings).toEqual(['Cariler']);
    expect(fark.addedHeadings).toEqual(['cariler']);
    expect(fark.changed).toBe(true);
  });

  it('link ve menü değişimini gürültü olarak yok sayar', () => {
    const fark = haritaFarkiHesapla(
      sayfa({ links: ['/cariler/1'], menu: ['Eski menü'] }),
      sayfa({ links: ['/cariler/2'], menu: ['Yeni menü'] }),
    );

    expect(fark.changed).toBe(false);
  });
});

describe('sayfa kimliği', () => {
  it('sayfa başlığı uyuşuyorsa tek başlık yeniden adlandırılsa da kimliği korur', () => {
    const fark = haritaFarkiHesapla(
      sayfa({ title: 'Cariler', headings: ['Cariler'] }),
      sayfa({ title: ' cariler ', headings: ['Müşteriler'] }),
    );

    expect(fark.pageIdentityMatches).toBe(true);
  });

  it('giriş ekranına yönlenince (başlık değişince) kimliği tutmaz', () => {
    const fark = haritaFarkiHesapla(
      sayfa({ title: 'Cariler', headings: ['Cariler'], buttons: ['Yeni cari'] }),
      sayfa({ title: 'Giriş Yap', headings: ['Giriş Yap'], buttons: ['Giriş Yap'] }),
    );

    expect(fark.pageIdentityMatches).toBe(false);
    expect(fark.changed).toBe(true);
  });

  it('yalnız sayfa title değişimini fark sayar ama aynı sayfa varsaymaz', () => {
    const fark = haritaFarkiHesapla(
      sayfa({ title: 'Cariler', headings: ['Cariler'] }),
      sayfa({ title: 'Beklenmeyen sayfa', headings: ['Cariler'] }),
    );

    expect(fark.pageIdentityMatches).toBe(false);
    expect(fark.changed).toBe(true);
  });

  it('title ile tek görünür başlık birlikte yeniden adlandırılırsa sayfa kimliğini korur', () => {
    const fark = haritaFarkiHesapla(
      sayfa({ title: 'Cariler', headings: ['Cariler'] }),
      sayfa({ title: 'Müşteriler', headings: ['Müşteriler'] }),
    );

    expect(fark.pageIdentityMatches).toBe(true);
    expect(fark.changed).toBe(true);
  });

  it('sayfa başlığı okunamıyorsa keşif başlıklarından biri kalmış olmalı', () => {
    const kalan = haritaFarkiHesapla(
      sayfa({ title: '', headings: ['Cariler', 'Son işlemler'] }),
      sayfa({ title: '', headings: ['Cariler'] }),
    );
    const kalmayan = haritaFarkiHesapla(
      sayfa({ title: '', headings: ['Cariler', 'Son işlemler'] }),
      sayfa({ title: '', headings: ['Giriş Yap'] }),
    );

    expect(kalan.pageIdentityMatches).toBe(true);
    expect(kalmayan.pageIdentityMatches).toBe(false);
  });

  it('keşifte hiç başlık ve sayfa başlığı yoksa kimliği tutuyor sayar', () => {
    const fark = haritaFarkiHesapla(sayfa({ title: '' }), sayfa({ title: '', headings: ['Yeni'] }));

    expect(fark.pageIdentityMatches).toBe(true);
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
    const kesif = sayfa({ headings: ['Cariler'], buttons: ['Kaydet'] });

    const basladi = Date.now();
    const fark = await domHaritaFarkiOlustur(html, kesif, 'http://uygulama.test');
    const sure = Date.now() - basladi;

    expect(fark.changed).toBe(false);
    expect(fark.pageIdentityMatches).toBe(true);
    expect(sure).toBeLessThan(15_000);
  }, 60_000);
});
