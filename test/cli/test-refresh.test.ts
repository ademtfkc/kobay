import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Harita, Sayfa } from '../../src/depo/index.js';

const sahteler = vi.hoisted(() => ({
  verdict: 'passed' as 'passed' | 'failed',
  yeniSayfa: undefined as unknown,
  yenilenenUrl: undefined as string | undefined,
}));

vi.mock('../../src/kesif/index.js', async (asilModul) => ({
  ...(await asilModul<typeof import('../../src/kesif/index.js')>()),
  kesfet: vi.fn(async () => { throw new Error('Bu testte tam keşif çalışmamalı'); }),
  sayfayiYenile: vi.fn(async ({ url }: { url: string }) => {
    sahteler.yenilenenUrl = url;
    return sahteler.yeniSayfa as Sayfa;
  }),
}));

vi.mock('../../src/kos/index.js', () => ({
  hedefAyaktaMi: vi.fn(async () => true),
  kostur: vi.fn(async (_dizin: unknown, test: { id: string; codeVersion: number }) => ({
    sonuc: {
      testId: test.id,
      runId: 'r_20260918010101_abcd',
      status: sahteler.verdict,
      verdict: sahteler.verdict,
      startedAt: '2026-09-18T00:00:00.000Z',
      finishedAt: '2026-09-18T00:00:01.000Z',
      codeVersion: test.codeVersion,
      ...(sahteler.verdict === 'failed' ? { failedStepIndex: 0, errorMessage: 'Cariler bulunamadı' } : {}),
    },
    adimlar: sahteler.verdict === 'failed'
      ? [{ stepIndex: 0, description: 'Cariler sayfasını aç', status: 'failed', durationMs: 5, errorMessage: 'Cariler bulunamadı' }]
      : [],
  })),
}));

import { ciktiYaz } from '../../src/cli/cikti.js';
import { testRefresh } from '../../src/cli/komutlar/index.js';
import { KobayDizini, yazAtomik, type TestKaydi } from '../../src/depo/index.js';

function metinTopla(akis: PassThrough): { oku: () => string } {
  let metin = '';
  akis.setEncoding('utf8');
  akis.on('data', (parca: string) => { metin += parca; });
  return { oku: () => metin };
}

const TEST_ID = 't_abc12345';

function sayfa(yol: string, baslik: string, dugmeler: string[]): Sayfa {
  return {
    url: `http://uygulama.test${yol}`,
    baslik,
    basliklar: [baslik],
    linkler: [],
    formlar: [],
    dugmeler,
    menu: [baslik],
  };
}

const harita: Harita = {
  baseUrl: 'http://uygulama.test',
  girisYapildi: true,
  kesifTarihi: '2026-09-17T00:00:00.000Z',
  sayfalar: [sayfa('/', 'Ana sayfa', []), sayfa('/cariler', 'Cariler', ['Cari Ekle'])],
};

const testKaydi: TestKaydi = {
  id: TEST_ID,
  name: 'Cariler listesini görüntüle',
  type: 'frontend',
  createdFrom: 'plan',
  status: 'failed',
  planSteps: [
    { type: 'action', description: 'Cariler sayfasını aç' },
    { type: 'assertion', description: 'Cariler başlığını gör' },
  ],
  priority: 'p0',
  url: '/cariler',
  codeVersion: 2,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
};

const YENI_KOD = [
  "import { test, expect } from './_fixture';",
  "test('Müşteriler listesini görüntüle', async ({ page }) => {",
  "  await test.step('0: Müşteriler sayfasını aç', async () => { await page.goto('/cariler'); });",
  "  await test.step('1: Müşteriler başlığını gör', async () => { await expect(page.locator('h1')).toBeVisible(); });",
  '});',
  '',
].join('\n');

async function proje(): Promise<{ cwd: string; dizin: KobayDizini }> {
  const cwd = await mkdtemp(join(tmpdir(), 'kobay-refresh-'));
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
  await dizin.haritaYaz(harita);
  await dizin.testYaz(testKaydi);
  await dizin.kodYaz(TEST_ID, '// eski kod: Cariler');
  const yanitlar = await mkdtemp(join(tmpdir(), 'kobay-refresh-yanit-'));
  await Promise.all([
    yazAtomik(join(yanitlar, `plan-yenile-${TEST_ID}.json`), JSON.stringify({
      name: 'Müşteriler listesini görüntüle',
      steps: [
        { type: 'action', description: 'Müşteriler sayfasını aç' },
        { type: 'assertion', description: 'Müşteriler başlığını gör' },
      ],
    })),
    yazAtomik(join(yanitlar, `uret-${TEST_ID}.json`), JSON.stringify({ kod: YENI_KOD })),
  ]);
  process.env.KOBAY_SAHTE_YANIT_DIZINI = yanitlar;
  sahteler.yeniSayfa = sayfa('/cariler', 'Müşteriler', ['Müşteri Ekle']);
  return { cwd, dizin };
}

afterEach(() => {
  sahteler.verdict = 'passed';
  sahteler.yenilenenUrl = undefined;
  delete process.env.KOBAY_SAHTE_YANIT_DIZINI;
});

describe('test refresh', () => {
  it('--no-run: haritanın yalnız o sayfasını yeniler, testi taslağa çeker, koşmaz', async () => {
    const { cwd, dizin } = await proje();

    const sonuc = await testRefresh({ cwd, id: TEST_ID, run: false });

    expect(sonuc.exitCode).toBe(0);
    expect(sahteler.yenilenenUrl).toBe('/cariler');
    expect(sonuc.json).toMatchObject({
      id: TEST_ID,
      ad: 'Müşteriler listesini görüntüle',
      eskiAd: 'Cariler listesini görüntüle',
      adimSayisi: 2,
      durum: 'draft',
      // refresh kod üretmez: codeVersion yalnız `test run` kod üretince artar.
      codeVersion: 2,
    });

    // İnsan modu: JSON gövdesi değil, kimliği ve yeni adımları taşıyan özet.
    expect(sonuc.mesaj).toBeUndefined();
    const satirlar = (sonuc.metin ?? '').split('\n');
    expect(satirlar.some((satir) => /^[{["]/.test(satir.trimStart()))).toBe(false);
    expect(sonuc.metin).not.toContain('"planSteps"');
    expect(satirlar[0]).toBe('Sayfa yenilendi: http://uygulama.test/cariler');
    expect(satirlar[1]).toContain(TEST_ID);
    expect(sonuc.metin).toContain('0. [action] Müşteriler sayfasını aç');
    expect(sonuc.metin).toContain('kobay test run');

    const guncelTest = await dizin.testOku(TEST_ID);
    expect(guncelTest.status).toBe('draft');
    expect(guncelTest.name).toBe('Müşteriler listesini görüntüle');
    expect(guncelTest.planSteps).toEqual([
      { type: 'action', description: 'Müşteriler sayfasını aç' },
      { type: 'assertion', description: 'Müşteriler başlığını gör' },
    ]);
    expect(guncelTest.codeVersion).toBe(testKaydi.codeVersion);

    const guncelHarita = await dizin.haritaOku();
    expect(guncelHarita?.sayfalar).toHaveLength(2);
    expect(guncelHarita?.sayfalar[0]).toEqual(harita.sayfalar[0]);
    expect(guncelHarita?.sayfalar[1]?.baslik).toBe('Müşteriler');

    // --no-run kod üretmez; eski kod dosyası olduğu gibi kalır.
    await expect(dizin.kodOku(TEST_ID)).resolves.toBe('// eski kod: Cariler');
    await expect(dizin.kosuListele(TEST_ID)).resolves.toEqual([]);
  });

  it('koşu yolunu çalıştırır: taslaktan kod üretir, koşturur, verdict ve runId döner', async () => {
    const { cwd, dizin } = await proje();

    const sonuc = await testRefresh({ cwd, id: TEST_ID });

    expect(sonuc.exitCode).toBe(0);
    expect(sonuc.json).toMatchObject({
      id: TEST_ID,
      ad: 'Müşteriler listesini görüntüle',
      kosu: { id: TEST_ID, verdict: 'passed', runId: 'r_20260918010101_abcd' },
    });
    // Koşu yolunda da özet basılır; koşu satırları `test run` biçiminde sona eklenir.
    expect(sonuc.mesaj).toBeUndefined();
    expect(sonuc.metin).toContain(`Test: ${TEST_ID} — Müşteriler listesini görüntüle`);
    expect(sonuc.metin).toContain(`passed ${TEST_ID}`);
    expect(sonuc.metin).not.toContain('"codeVersion"');

    await expect(dizin.kodOku(TEST_ID)).resolves.toBe(YENI_KOD);
    const guncelTest = await dizin.testOku(TEST_ID);
    expect(guncelTest.status).toBe('ready');
    expect(guncelTest.name).toBe('Müşteriler listesini görüntüle');
    // Tek kod üretimi = tek artış; refresh ayrıca artırmaz.
    expect(guncelTest.codeVersion).toBe(testKaydi.codeVersion + 1);
    expect(sonuc.json).toMatchObject({ codeVersion: testKaydi.codeVersion + 1, durum: 'ready' });
  });

  it('koşu düşerse exit 1 ve failureKind döner', async () => {
    const { cwd } = await proje();
    sahteler.verdict = 'failed';
    await yazAtomik(join(process.env.KOBAY_SAHTE_YANIT_DIZINI ?? '', `analiz-${TEST_ID}.json`), JSON.stringify({
      rootCauseHypothesis: 'Adım hâlâ eski adı arıyor',
      failureKind: 'test_bug',
      recommendedFixTarget: { kind: 'selector', reference: '/cariler', rationale: 'Seçici eski' },
      evidence: [],
    }));

    const sonuc = await testRefresh({ cwd, id: TEST_ID });

    expect(sonuc.exitCode).toBe(1);
    expect(sonuc.json).toMatchObject({ kosu: { verdict: 'failed', failureKind: 'test_bug' } });

    // Düşen koşuda özet stderr'e gider; stdout boş kalır, JSON gövdesi basılmaz.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const cikti = metinTopla(stdout);
    const hata = metinTopla(stderr);
    ciktiYaz(sonuc, false, stdout, stderr);
    expect(cikti.oku()).toBe('');
    expect(hata.oku()).toContain(`failed ${TEST_ID} — test_bug`);
    expect(hata.oku()).not.toContain('"planSteps"');
  });

  it('URL’si olmayan testte ve haritada olmayan sayfada exit 2 verir, tarayıcı açmaz', async () => {
    const { cwd, dizin } = await proje();
    await dizin.testYaz({ ...testKaydi, id: 't_bcd12345', url: undefined });
    await dizin.testYaz({ ...testKaydi, id: 't_cde12345', url: '/faturalar' });

    const urlsuz = await testRefresh({ cwd, id: 't_bcd12345', run: false });
    expect(urlsuz.exitCode).toBe(2);
    expect(urlsuz.json).toEqual({ hata: expect.objectContaining({ kod: 'KullanimHatasi' }) });

    const haritadaYok = await testRefresh({ cwd, id: 't_cde12345', run: false });
    expect(haritadaYok.exitCode).toBe(2);
    expect(sahteler.yenilenenUrl).toBeUndefined();
  });

  it('harita yoksa exit 2 verir', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kobay-refresh-haritasiz-'));
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    await dizin.testYaz(testKaydi);

    const sonuc = await testRefresh({ cwd, id: TEST_ID, run: false });

    expect(sonuc.exitCode).toBe(2);
    expect(sonuc.mesaj).toMatch(/Keşif haritası yok/);
  });
});
