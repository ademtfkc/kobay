import { test as temel, expect, type Page } from '@playwright/test';
import { yazAtomik } from '../depo/index.js';
import { adimSar } from './fixture-sablonu.js';

type Kayit = Record<string, unknown>;

function kosuDizini(): string | undefined {
  const dizin = process.env.KOBAY_KOSU_DIZINI;
  return dizin === undefined || dizin === '' ? undefined : dizin;
}

function storageState(): string | undefined {
  const yol = process.env.KOBAY_STORAGE_STATE;
  return yol === undefined || yol === '' ? undefined : yol;
}

function adimIndeksi(baslik: string): number | undefined {
  const eslesme = /^(\d+):\s/.exec(baslik);
  return eslesme?.[1] === undefined ? undefined : Number(eslesme[1]);
}

function adimAlani(stepIndex: number | undefined): Kayit {
  return stepIndex === undefined ? {} : { stepIndex };
}

function konsolKaydi(mesaj: { type(): string; text(): string }, stepIndex: number | undefined): Kayit {
  return {
    tip: mesaj.type(),
    metin: mesaj.text(),
    ...adimAlani(stepIndex),
  };
}

export const test = temel.extend<{ page: Page }>({
  page: async ({ browser }, kullan, _testBilgisi) => {
    const durum = storageState();
    const context = durum === undefined ? await browser.newContext() : await browser.newContext({ storageState: durum });
    const page = await context.newPage();
    const dizin = kosuDizini();
    const konsol: Kayit[] = [];
    const ag: Kayit[] = [];
    let aktifStepIndex: number | undefined;
    const geriAlKanit = dizin === undefined ? undefined : adimSar(test, page, dizin);
    const oncekiAdim = test.step;
    const sarmaliAdim = async (
      baslik: string,
      govde: (adim: unknown) => unknown | Promise<unknown>,
      secenekler?: unknown,
    ): Promise<unknown> => oncekiAdim(baslik, async (adim) => {
      const oncekiStepIndex = aktifStepIndex;
      const indeks = adimIndeksi(baslik);
      if (indeks !== undefined) aktifStepIndex = indeks;
      try {
        return await govde(adim);
      } finally {
        aktifStepIndex = oncekiStepIndex;
      }
    }, secenekler as never);
    if (dizin !== undefined) test.step = sarmaliAdim as typeof test.step;

    if (dizin !== undefined) {
      page.on('console', (mesaj) => {
        if (mesaj.type() === 'error' || mesaj.type() === 'warning') konsol.push(konsolKaydi(mesaj, aktifStepIndex));
      });
      page.on('requestfailed', (istek) => {
        ag.push({
          url: istek.url(),
          method: istek.method(),
          hata: istek.failure()?.errorText ?? 'Unknown network error',
          ...adimAlani(aktifStepIndex),
        });
      });
      page.on('response', (yanit) => {
        if (yanit.status() >= 400) {
          ag.push({
            url: yanit.url(),
            method: yanit.request().method(),
            status: yanit.status(),
            ...adimAlani(aktifStepIndex),
          });
        }
      });
    }

    try {
      await kullan(page);
    } finally {
      if (dizin !== undefined) test.step = oncekiAdim;
      geriAlKanit?.();
      try {
        if (dizin !== undefined) {
          await Promise.all([
            yazAtomik(`${dizin}/console.json`, `${JSON.stringify(konsol, null, 2)}\n`),
            yazAtomik(`${dizin}/network.json`, `${JSON.stringify(ag, null, 2)}\n`),
          ]);
        }
      } finally {
        await context.close();
      }
    }
  },
});

export { expect };
