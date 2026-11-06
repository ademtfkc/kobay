import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';
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
  kesfetAyrintili: vi.fn(async () => { throw new Error('Bu testte tam keşif çalışmamalı'); }),
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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { KobayDizini, yazAtomik, type TestKaydi } from '../../src/depo/index.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';

function metinTopla(akis: PassThrough): { oku: () => string } {
  let metin = '';
  akis.setEncoding('utf8');
  akis.on('data', (parca: string) => { metin += parca; });
  return { oku: () => metin };
}

const TEST_ID = 't_abc12345';

function sayfa(yol: string, title: string, buttons: string[]): Sayfa {
  return {
    url: `http://uygulama.test${yol}`,
    title,
    headings: [title],
    links: [],
    forms: [],
    buttons,
    menu: [title],
  };
}

const harita: Harita = {
  baseUrl: 'http://uygulama.test',
  loggedIn: true,
  exploredAt: '2026-09-17T00:00:00.000Z',
  pages: [sayfa('/', 'Ana sayfa', []), sayfa('/cariler', 'Cariler', ['Cari Ekle'])],
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
  const cwd = await geciciDizinAc('kobay-refresh-');
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
  await dizin.haritaYaz(harita);
  await dizin.testYaz(testKaydi);
  await dizin.kodYaz(TEST_ID, '// eski kod: Cariler');
  const yanitlar = await geciciDizinAc('kobay-refresh-yanit-');
  await Promise.all([
    yazAtomik(join(yanitlar, `plan-refresh-${TEST_ID}.json`), JSON.stringify({
      name: 'Müşteriler listesini görüntüle',
      steps: [
        { type: 'action', description: 'Müşteriler sayfasını aç' },
        { type: 'assertion', description: 'Müşteriler başlığını gör' },
      ],
    })),
    yazAtomik(join(yanitlar, `generate-${TEST_ID}.json`), JSON.stringify({ kod: YENI_KOD })),
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
      name: 'Müşteriler listesini görüntüle',
      previousName: 'Cariler listesini görüntüle',
      stepCount: 2,
      status: 'draft',
      // refresh kod üretmez: codeVersion yalnız `test run` kod üretince artar.
      codeVersion: 2,
    });

    // İnsan modu: JSON gövdesi değil, kimliği ve yeni adımları taşıyan özet.
    expect(sonuc.mesaj).toBeUndefined();
    const satirlar = (sonuc.metin ?? '').split('\n');
    expect(satirlar.some((satir) => /^[{["]/.test(satir.trimStart()))).toBe(false);
    expect(sonuc.metin).not.toContain('"planSteps"');
    expect(satirlar[0]).toBe('Page refreshed: http://uygulama.test/cariler');
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
    expect(guncelHarita?.pages).toHaveLength(2);
    expect(guncelHarita?.pages[0]).toEqual(harita.pages[0]);
    expect(guncelHarita?.pages[1]?.title).toBe('Müşteriler');

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
      name: 'Müşteriler listesini görüntüle',
      run: { id: TEST_ID, verdict: 'passed', runId: 'r_20260918010101_abcd' },
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
    expect(sonuc.json).toMatchObject({ codeVersion: testKaydi.codeVersion + 1, status: 'ready' });
  });

  it('koşu düşerse exit 1 ve failureKind döner', async () => {
    const { cwd } = await proje();
    sahteler.verdict = 'failed';
    await yazAtomik(join(process.env.KOBAY_SAHTE_YANIT_DIZINI ?? '', `analysis-${TEST_ID}.json`), JSON.stringify({
      rootCauseHypothesis: 'Adım hâlâ eski adı arıyor',
      failureKind: 'test_bug',
      recommendedFixTarget: { kind: 'selector', reference: '/cariler', rationale: 'Seçici eski' },
      evidence: [],
    }));

    const sonuc = await testRefresh({ cwd, id: TEST_ID });

    expect(sonuc.exitCode).toBe(1);
    expect(sonuc.json).toMatchObject({ run: { verdict: 'failed', failureKind: 'test_bug' } });

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
    expect(urlsuz.json).toEqual({ error: expect.objectContaining({ code: 'UsageError' }) });

    const haritadaYok = await testRefresh({ cwd, id: 't_cde12345', run: false });
    expect(haritadaYok.exitCode).toBe(2);
    expect(sahteler.yenilenenUrl).toBeUndefined();
  });

  it('harita yoksa exit 2 verir', async () => {
    const cwd = await geciciDizinAc('kobay-refresh-haritasiz-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    await dizin.testYaz(testKaydi);

    const sonuc = await testRefresh({ cwd, id: TEST_ID, run: false });

    expect(sonuc.exitCode).toBe(2);
    expect(sonuc.mesaj).toMatch(/No exploration map/);
  });

  describe('gerçek kimlik süzgeci (giriş yapılandırılmış projede)', () => {
    const IHLAL = 'Enter the account secret on the login form';

    async function girisliProje(tur: 'kimlik' | 'oturum'): Promise<{ cwd: string; dizin: KobayDizini }> {
      const kurulan = await proje();
      if (tur === 'kimlik') {
        await kurulan.dizin.kimlikYaz({ username: 'u', password: 'p', origin: 'http://uygulama.test' });
      } else {
        // `project create --session-file` ile aynı biçim: içe alındı işareti taşıyan storageState, credentials.json yok.
        await kurulan.dizin.storageStateYaz(JSON.stringify({
          cookies: [{ name: 'sid', value: 'OTURUM-9f2c', domain: 'uygulama.test', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
          origins: [],
          kobay: { sessionSource: 'imported' },
        }));
      }
      return kurulan;
    }

    async function beyinYaniti(adimlar: string[]): Promise<void> {
      await yazAtomik(join(process.env.KOBAY_SAHTE_YANIT_DIZINI ?? '', `plan-refresh-${TEST_ID}.json`), JSON.stringify({
        name: 'Müşteriler listesini görüntüle',
        steps: [
          { type: 'action', description: adimlar[0] },
          { type: 'assertion', description: adimlar[1] },
        ],
      }));
    }

    for (const tur of ['kimlik', 'oturum'] as const) {
      it(`beyin gerçek kimlik adımı döndürürse test dosyası bayt bayt aynı kalır, exit 4, mesajda adım (${tur})`, async () => {
        const { cwd, dizin } = await girisliProje(tur);
        await beyinYaniti([IHLAL, 'Müşteriler başlığını gör']);
        const testDosyasi = dizin.yol('tests', `${TEST_ID}.json`);
        const once = await readFile(testDosyasi);

        // kimlik: --no-run (bugünkü kodda exit 0 verirdi); oturum: koşu yolu açık (kod üretimine geçilmemeli).
        const sonuc = await testRefresh({ cwd, id: TEST_ID, ...(tur === 'kimlik' ? { run: false } : {}) });

        expect(sonuc.exitCode).toBe(4);
        expect(sonuc.mesaj).toContain('needs the real credentials');
        expect(sonuc.mesaj).toContain(IHLAL);
        expect(sonuc.mesaj).toContain('The test was not changed');
        expect((await readFile(testDosyasi)).equals(once)).toBe(true);
        // Koşu yoluna da girilmez: kod üretilmez, koşu yok.
        await expect(dizin.kodOku(TEST_ID)).resolves.toBe('// eski kod: Cariler');
        await expect(dizin.kosuListele(TEST_ID)).resolves.toEqual([]);
      });
    }

    it('temiz adımlar giriş yapılandırılmış projede de bugünkü gibi yazılır', async () => {
      const { cwd, dizin } = await girisliProje('oturum');
      const sonuc = await testRefresh({ cwd, id: TEST_ID, run: false });
      expect(sonuc.exitCode).toBe(0);
      expect((await dizin.testOku(TEST_ID)).planSteps[0]?.description).toBe('Müşteriler sayfasını aç');
    });

    it('MCP test_refresh aynı ihlali reddeder, test dosyası değişmez', async () => {
      const { cwd, dizin } = await girisliProje('oturum');
      await beyinYaniti([IHLAL, 'Müşteriler başlığını gör']);
      const testDosyasi = dizin.yol('tests', `${TEST_ID}.json`);
      const once = await readFile(testDosyasi);
      const sunucu = mcpSunucusuOlustur({ cwd });
      const istemci = new Client({ name: 'kobay-test', version: '0.1.0' });
      const [sunucuTasima, istemciTasima] = InMemoryTransport.createLinkedPair();
      await Promise.all([sunucu.connect(sunucuTasima), istemci.connect(istemciTasima)]);
      try {
        const sonuc = await istemci.callTool({ name: 'test_refresh', arguments: { id: TEST_ID, run: false } });
        expect(sonuc.isError).toBe(true);
        expect((sonuc.content as [{ text: string }])[0].text).toContain(IHLAL);
      } finally {
        await istemci.close();
        await sunucu.close();
      }
      expect((await readFile(testDosyasi)).equals(once)).toBe(true);
    });
  });
});
