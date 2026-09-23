import type { Page } from '@playwright/test';
import type { Form, FormAlani, Sayfa } from '../depo/index.js';

function metniTemizle(metin: string): string {
  return metin.replace(/\s+/g, ' ').trim();
}

function benzersiz(metinler: string[], sinir: number): string[] {
  return [...new Set(metinler.filter(Boolean))].slice(0, sinir);
}

function normalUrl(adres: string): string | null {
  try {
    const url = new URL(adres);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Bir Playwright sayfasındaki test-planı için gerekli görünür arayüz bilgisini çıkarır. */
export async function sayfaOzeti(sayfa: Page, koken: string): Promise<Sayfa> {
  const baslik = metniTemizle(await sayfa.title())
    || metniTemizle((await sayfa.locator('h1').first().allTextContents())[0] ?? '');
  const basliklar = benzersiz((await sayfa.locator('h1, h2, h3').allTextContents()).map(metniTemizle), 30);
  const hamLinkler = await sayfa.locator('a[href]').evaluateAll((baglantilar) =>
    baglantilar.map((baglanti) => ({ href: (baglanti as HTMLAnchorElement).href })),
  );
  const linkler = benzersiz(
    hamLinkler
      .map(({ href }) => normalUrl(href))
      .filter((url): url is string => url !== null && new URL(url).origin === koken),
    100,
  );
  const formlar = await sayfa.locator('form').evaluateAll((elemanlar) =>
    elemanlar.map((eleman) => {
      const form = eleman as HTMLFormElement;
      const alanlar: FormAlani[] = Array.from(form.querySelectorAll('input, select, textarea')).map((alan) => {
        const girdi = alan as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const id = girdi.getAttribute('id');
        const etiket = (id ? form.querySelector(`label[for="${CSS.escape(id)}"]`) : null)
          ?? girdi.closest('label');
        const sonuc: FormAlani = {
          ad: girdi.getAttribute('name') ?? id ?? '',
          tip: girdi.getAttribute('type') ?? girdi.tagName.toLowerCase(),
        };
        const etiketMetni = etiket?.textContent?.replace(/\s+/g, ' ').trim();
        const placeholder = girdi.getAttribute('placeholder');
        if (etiketMetni) sonuc.etiket = etiketMetni;
        if (placeholder) sonuc.placeholder = placeholder;
        return sonuc;
      });
      const sonuc: Form = { alanlar };
      const action = form.getAttribute('action');
      if (action) sonuc.action = action;
      return sonuc;
    }),
  );
  const dugmeler = benzersiz(
    (await sayfa.locator('button, input[type="submit"], input[type="button"]').evaluateAll((elemanlar) =>
      elemanlar.map((eleman) => {
        if (eleman instanceof HTMLInputElement) return eleman.value;
        return eleman.textContent ?? '';
      }),
    )).map(metniTemizle),
    50,
  );
  const menu = benzersiz((await sayfa.locator('nav a').allTextContents()).map(metniTemizle), 100);

  return {
    url: normalUrl(sayfa.url()) ?? sayfa.url(),
    baslik,
    basliklar,
    linkler,
    formlar,
    dugmeler,
    menu,
  };
}
