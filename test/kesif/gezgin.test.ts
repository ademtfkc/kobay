import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/kesif/sayfa-ozeti.js', () => ({ sayfaOzeti: vi.fn() }));

import { baglantiIzlenebilir, gez, urlKalibi } from '../../src/kesif/gezgin.js';
import { sayfaOzeti } from '../../src/kesif/sayfa-ozeti.js';

const sayfaOzetiSahte = vi.mocked(sayfaOzeti);

describe('baglantiIzlenebilir', () => {
  it.each(['Çıkış', 'LOGOUT', 'Sil kaydı', 'remove item'])('yıkıcı bağlantıyı reddeder: %s', (metin) => {
    expect(baglantiIzlenebilir(metin)).toBe(false);
  });

  it('normal bağlantıyı kabul eder', () => {
    expect(baglantiIzlenebilir('New Record')).toBe(true);
  });
});

describe('URL kalıbı kotası', () => {
  it('sayısal ve UUID-benzeri parçaları aynı kalıba indirger', () => {
    expect(urlKalibi('https://uygulama.test/cariler/31')).toBe('/cariler/:id');
    expect(urlKalibi('https://uygulama.test/cariler/550e8400-e29b-41d4-a716-446655440000')).toBe('/cariler/:id');
  });

  it('aynı kalıptan yalnız iki, farklı kalıplardan ikişer sayfayı gezer', async () => {
    const baglantilar: Record<string, Array<{ href: string; metin: string }>> = {
      'https://uygulama.test/': [
        ...Array.from({ length: 10 }, (_deger, sira) => ({ href: `https://uygulama.test/x/${sira + 1}`, metin: 'Kayıt' })),
        { href: 'https://uygulama.test/y/1', metin: 'Diğer kayıt' },
        { href: 'https://uygulama.test/y/2', metin: 'Diğer kayıt' },
      ],
    };
    let etkinUrl = '';
    const gezilen: string[] = [];
    const sayfa = {
      goto: vi.fn(async (url: string) => {
        etkinUrl = url;
        gezilen.push(url);
      }),
      locator: vi.fn(() => ({
        evaluateAll: async (isleyici: (elemanlar: unknown[]) => unknown) => isleyici(baglantilar[etkinUrl] ?? []),
      })),
    } as unknown as Page;
    sayfaOzetiSahte.mockImplementation(async () => ({
      url: etkinUrl, title: '', headings: [], links: [], forms: [], buttons: [], menu: [],
    }));

    await gez(sayfa, {
      baseUrl: 'https://uygulama.test/', maxSayfa: 20, derinlik: 1, sayfaZamanAsimiMs: 1,
    });

    expect(gezilen.filter((url) => url.startsWith('https://uygulama.test/x/'))).toHaveLength(2);
    expect(gezilen.filter((url) => url.startsWith('https://uygulama.test/y/'))).toHaveLength(2);
  });
});
