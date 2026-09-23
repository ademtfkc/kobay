import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrainError, beyinOlustur } from '../../src/beyin/index.js';
import { yazAtomik, type HaritaFarki, type Sayfa, type TestKaydi } from '../../src/depo/index.js';
import {
  PLAN_YENILEME_SISTEM_ISTEMI,
  planYenile,
  planYenilemeKullaniciIstemiOlustur,
} from '../../src/plan/index.js';

const test: TestKaydi = {
  id: 't_abc12345',
  name: 'Cariler listesini görüntüle',
  type: 'frontend',
  createdFrom: 'plan',
  status: 'failed',
  planSteps: [
    { type: 'action', description: 'Cariler sayfasını aç' },
    { type: 'action', description: 'Cari Ekle düğmesine bas' },
    { type: 'assertion', description: 'Cariler başlığının görünür olduğunu doğrula' },
  ],
  priority: 'p0',
  url: '/cariler',
  codeVersion: 3,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
};

const eskiSayfa: Sayfa = {
  url: 'http://uygulama.test/cariler',
  title: 'Cariler',
  headings: ['Cariler'],
  links: [],
  forms: [],
  buttons: ['Cari Ekle'],
  menu: ['Cariler'],
};

const yeniSayfa: Sayfa = {
  ...eskiSayfa,
  title: 'Müşteriler',
  headings: ['Müşteriler'],
  buttons: ['Müşteri Ekle'],
  menu: ['Müşteriler'],
};

const mapDiff: HaritaFarki = {
  url: 'http://uygulama.test/cariler',
  addedHeadings: ['Müşteriler'],
  removedHeadings: ['Cariler'],
  addedButtons: ['Müşteri Ekle'],
  removedButtons: ['Cari Ekle'],
  addedFormFields: [],
  removedFormFields: [],
  pageIdentityMatches: true,
  changed: true,
};

async function sahteBeyin(icerik: unknown, gorev = `plan-yenile-${test.id}`) {
  const dizin = await mkdtemp(join(tmpdir(), 'kobay-plan-yenile-'));
  await yazAtomik(join(dizin, `${gorev}.json`), JSON.stringify(icerik));
  return beyinOlustur({ adaptor: 'sahte' }, { KOBAY_SAHTE_YANIT_DIZINI: dizin });
}

describe('planYenile', () => {
  it('adım sayısını koruyarak yeniden adlandırılmış adımları ve test adını günceller', async () => {
    const beyin = await sahteBeyin({
      name: 'Müşteriler listesini görüntüle',
      steps: [
        { type: 'action', description: 'Müşteriler sayfasını aç' },
        { type: 'action', description: 'Müşteri Ekle düğmesine bas' },
        { type: 'assertion', description: 'Müşteriler başlığının görünür olduğunu doğrula' },
      ],
    });

    const sonuc = await planYenile(beyin, { test, eskiSayfa, yeniSayfa, mapDiff });

    expect(sonuc.name).toBe('Müşteriler listesini görüntüle');
    expect(sonuc.planSteps).toHaveLength(test.planSteps.length);
    expect(sonuc.planSteps.map((adim) => adim.type)).toEqual(['action', 'action', 'assertion']);
    expect(sonuc.planSteps[0]?.description).toBe('Müşteriler sayfasını aç');
    expect(JSON.stringify(sonuc.planSteps)).not.toContain('Cari');
  });

  it('Türkçeleşmiş anahtarları (ad, adimlar, tur, aciklama) eşler', async () => {
    const beyin = await sahteBeyin({
      ad: 'Müşteriler listesi',
      adimlar: [
        { tur: 'action', aciklama: 'Müşteriler sayfasını aç' },
        { tur: 'action', aciklama: 'Müşteri Ekle düğmesine bas' },
        { tur: 'assertion', aciklama: 'Başlığı doğrula' },
      ],
    });

    const sonuc = await planYenile(beyin, { test, eskiSayfa, yeniSayfa });

    expect(sonuc.name).toBe('Müşteriler listesi');
    expect(sonuc.planSteps).toHaveLength(3);
    expect(sonuc.planSteps[2]).toEqual({ type: 'assertion', description: 'Başlığı doğrula' });
  });

  it('adım sayısı değişirse BrainError(sema) atar', async () => {
    const beyin = await sahteBeyin({
      name: 'Müşteriler listesi',
      steps: [{ type: 'action', description: 'Müşteriler sayfasını aç' }],
    });

    const hata = await planYenile(beyin, { test, eskiSayfa, yeniSayfa }).catch((sebep: unknown) => sebep);

    expect(hata).toBeInstanceOf(BrainError);
    expect((hata as BrainError).sebep).toBe('schema');
  });

  it('adı olmayan yanıtta da şema hatası verir', async () => {
    const beyin = await sahteBeyin({
      steps: test.planSteps.map((adim) => ({ ...adim })),
    });

    await expect(planYenile(beyin, { test, eskiSayfa, yeniSayfa })).rejects.toBeInstanceOf(BrainError);
  });

  it('plan adımı olmayan testi beyne sormadan reddeder', async () => {
    const beyin = await sahteBeyin({ name: 'x', steps: [] });

    await expect(planYenile(beyin, { test: { ...test, planSteps: [] }, eskiSayfa, yeniSayfa }))
      .rejects.toThrow(/has no plan steps/);
  });
});

describe('planYenilemeKullaniciIstemiOlustur', () => {
  it('eski adımları, iki sayfa özetini ve harita farkını isteme koyar', () => {
    const istem = planYenilemeKullaniciIstemiOlustur({
      test: { name: test.name, planSteps: test.planSteps },
      eskiSayfa,
      yeniSayfa,
      mapDiff,
    });

    expect(istem).toContain('3 steps');
    expect(istem).toContain('0. [action] Cariler sayfasını aç');
    expect(istem).toContain('## The page as it was');
    expect(istem).toContain('## The page as it is now');
    expect(istem).toContain('removed buttons: Cari Ekle');
    expect(istem).toContain('added buttons: Müşteri Ekle');
    expect(PLAN_YENILEME_SISTEM_ISTEMI).toContain('DO NOT change the number of steps');
    expect(PLAN_YENILEME_SISTEM_ISTEMI).toContain('{"name":"...","steps":[{"type":"action","description":"..."}');
    expect(PLAN_YENILEME_SISTEM_ISTEMI).toContain(
      "Write names, descriptions and rationale in the language of the application's UI and docs;"
      + ' if mixed or unclear, use English.',
    );
    expect(PLAN_YENILEME_SISTEM_ISTEMI).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
  });

  it('eski sayfa ve fark yoksa eksikliği açıkça yazar', () => {
    const istem = planYenilemeKullaniciIstemiOlustur({
      test: { name: test.name, planSteps: test.planSteps },
      yeniSayfa,
    });

    expect(istem).toContain('No previous summary.');
    expect(istem).toContain('No diff information.');
  });
});
