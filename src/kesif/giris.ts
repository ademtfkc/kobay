import type { Locator, Page } from '@playwright/test';

export interface GirisFormu {
  kullaniciAlani: Locator;
  parolaAlani: Locator;
  gonderDugmesi: Locator;
}

/** Parola alanının bulunduğu formdaki kullanıcı ve gönder alanlarını bulur. */
export async function girisFormuBul(sayfa: Page): Promise<GirisFormu | null> {
  const parolaAlani = sayfa.locator('input[type="password"]').first();
  if (await parolaAlani.count() === 0) return null;

  const form = parolaAlani.locator('xpath=ancestor::form[1]');
  if (await form.count() === 0) return null;

  const kullaniciAlani = form
    .locator('input[type="email"], input[type="text"], input:not([type]), textarea')
    .first();
  const gonderDugmesi = form
    .locator('button[type="submit"], input[type="submit"], button:not([type])')
    .first();

  if (await kullaniciAlani.count() === 0 || await gonderDugmesi.count() === 0) return null;
  return { kullaniciAlani, parolaAlani, gonderDugmesi };
}
