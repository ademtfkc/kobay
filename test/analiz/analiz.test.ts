import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import { BrainError, beyinOlustur } from '../../src/beyin/index.js';
import { KobayDizini, yazAtomik, type KosuSonucu, type Sayfa, type TestKaydi } from '../../src/depo/index.js';
import { analizKullaniciIstemiOlustur, analizSistemIstemiOlustur, domTemizle, dusenAdimKodunuBul, hataAnalizEt, hataMesajiniTemizle } from '../../src/analiz/index.js';

const runId = 'r_20260917010101_abcd';
const test: TestKaydi = {
  id: 't_abcd1234', name: 'Ürün başlığı görünür', type: 'frontend', createdFrom: 'cli', status: 'failed',
  planSteps: [{ type: 'action', description: 'Ürün sayfasını aç' }, { type: 'assertion', description: 'Başlığı gör' }],
  priority: 'p1', url: 'http://uygulama.test/urunler', codeVersion: 1,
  createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
};
const sonuc: KosuSonucu = {
  testId: test.id, runId, status: 'failed', verdict: 'failed', startedAt: test.createdAt,
  finishedAt: test.updatedAt, codeVersion: 1, errorMessage: 'Başlık bulunamadı',
};
const beyinYanit = {
  rootCauseHypothesis: 'Başlık metni ürün tarafından değiştirildi.',
  failureKind: 'product_bug',
  recommendedFixTarget: { kind: 'code', reference: 'http://uygulama.test/urunler içindeki h1', rationale: 'DOM h1 içeriyor.' },
  evidence: [
    { kind: 'screenshot', stepIndex: 1, summary: 'Düşen adım görüntüsü.' },
    { kind: 'snapshot', stepIndex: 1, summary: 'Başlık DOM içinde.' },
    { kind: 'console', stepIndex: 1, summary: 'Konsol hatası.' },
    { kind: 'network', stepIndex: 1, summary: 'Sunucu hatası.' },
    { kind: 'screenshot', stepIndex: 99, summary: 'Olmayan görüntü.' },
  ],
};

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

async function hazirDizin(yanit: unknown = beyinYanit) {
  const projeKoku = await mkdtemp(join(tmpdir(), 'kobay-analiz-'));
  const dizin = await KobayDizini.ac(projeKoku, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
  const kosuDizini = await dizin.kosuDizini(runId);
  const yanitDizini = await mkdtemp(join(tmpdir(), 'kobay-analiz-yanit-'));
  await Promise.all([
    dizin.testYaz(test),
    dizin.kodYaz(test.id, "test('başlık', async () => expect('Ürün').toBe('Ürün'))"),
    yazAtomik(join(kosuDizini, 'adim-1.png'), 'sahte png'),
    yazAtomik(join(kosuDizini, 'adim-1.html'), '<style>.gizli{}</style><!-- yorum --><h1 class="baslik" data-id="7">Yeni ürün</h1><svg><path /></svg><script>gizli()</script>'),
    yazAtomik(join(kosuDizini, 'console.json'), JSON.stringify(Array.from({ length: 22 }, (_deger, sira) => ({ tip: 'error', metin: `konsol-${sira + 1}` })))),
    yazAtomik(join(kosuDizini, 'network.json'), JSON.stringify([{ url: '/api/urun', method: 'GET', status: 500 }])),
    yazAtomik(join(kosuDizini, 'trace.zip'), 'sahte trace'),
    yazAtomik(join(yanitDizini, `analiz-${test.id}.json`), JSON.stringify(yanit)),
  ]);
  return { dizin, kosuDizini, beyin: beyinOlustur({ adaptor: 'sahte' }, { KOBAY_SAHTE_YANIT_DIZINI: yanitDizini }) };
}

const carilerKodu = `test('cariler', async ({ page }) => {
  await test.step('0: Sayfayı aç', async () => { await page.goto('/cariler'); });
  await test.step('1: Cariler başlığını doğrula', async () => {
    await expect(page.getByRole('heading', { name: 'Cariler' })).toBeVisible();
  });
});`;

/** Keşif haritasında tek bir /cariler sayfası olan senaryoyu kurar. */
async function carilerHazirla(yanit: unknown, s: { dom: string; kod?: string; sayfa?: Partial<Sayfa> }) {
  const { dizin, kosuDizini, beyin } = await hazirDizin(yanit);
  const carilerTesti: TestKaydi = { ...test, name: 'Cariler başlığı görünür', url: '/cariler' };
  await Promise.all([
    dizin.testYaz(carilerTesti),
    dizin.kodYaz(test.id, s.kod ?? carilerKodu),
    yazAtomik(join(kosuDizini, 'adim-1.html'), s.dom),
    dizin.haritaYaz({
      baseUrl: 'http://uygulama.test',
      loggedIn: true,
      exploredAt: '2026-09-17T00:00:00.000Z',
      pages: [{
        url: 'http://uygulama.test/cariler',
        title: 'Cariler',
        headings: ['Cariler'],
        links: [],
        forms: [],
        buttons: [],
        menu: [],
        ...s.sayfa,
      }],
    }),
  ]);
  return { dizin, kosuDizini, beyin, carilerTesti };
}

describe('dusenAdimKodunuBul', () => {
  it('yalnız düşen adımın dilimini döndürür', () => {
    const dilim = dusenAdimKodunuBul(carilerKodu, 1);

    expect(dilim).toContain("1: Cariler başlığını doğrula");
    expect(dilim).not.toContain('0: Sayfayı aç');
    expect(dusenAdimKodunuBul(carilerKodu, 0)).toContain('0: Sayfayı aç');
    expect(dusenAdimKodunuBul(carilerKodu, 0)).not.toContain('1: Cariler');
  });

  it('adım yoksa veya kurulum hatasında boş döner', () => {
    expect(dusenAdimKodunuBul(carilerKodu, 7)).toBe('');
    expect(dusenAdimKodunuBul(carilerKodu, -1)).toBe('');
    expect(dusenAdimKodunuBul('', 0)).toBe('');
  });

  it('uret/statikHata kalıbındaki tırnak ve kaçış çeşitlerini tanır', () => {
    const kod = [
      "import { test, expect } from './_fixture';",
      "test('ad', async ({ page }) => {",
      '  await test.step("0: Giriş", async () => { await page.goto(\'/\'); });',
      "  await test.step(`1: O'nun kaydını gör`, async () => { await expect(page.getByText('Ali')).toBeVisible(); });",
      '});',
    ].join('\n');

    expect(dusenAdimKodunuBul(kod, 0)).toContain('0: Giriş');
    expect(dusenAdimKodunuBul(kod, 1)).toContain("1: O'nun kaydını gör");
    expect(dusenAdimKodunuBul(kod, 1)).not.toContain('0: Giriş');
  });
});

describe('domTemizle', () => {
  it('script, style, svg, yorum, class ve data gürültüsünü siler; sınırı belirtir', () => {
    expect(domTemizle('<style>x</style><!-- y --><p class="a" data-x="b"> Merhaba </p><svg>x</svg><script>x</script>')).toBe('<p> Merhaba </p>');
    expect(domTemizle('a'.repeat(30_000))).toBe('a'.repeat(30_000));
    expect(domTemizle('a'.repeat(30_001))).toBe(`${'a'.repeat(30_000)}…[truncated]`);
  });
});

describe('hataMesajiniTemizle', () => {
  it('Kobay iç stack satırlarını çıkarır, kullanıcı test satırını korur', () => {
    const hata = [
      'Error: Beklenen metin bulunamadı',
      '    at fixture (/repo/node_modules/kobay/dist/kos/fixture.js:42:7)',
      '    at Object.run (/home/user/app/src/kos/fixture.ts:18:3)',
      '    at /urun/tests/siparis.spec.ts:27:11',
    ].join('\n');

    const temiz = hataMesajiniTemizle(hata);
    expect(temiz).not.toContain('kobay/dist/kos/fixture');
    expect(temiz).not.toContain('kobay/src/kos/fixture');
    expect(temiz).toContain('/urun/tests/siparis.spec.ts:27:11');
  });
});

describe('hataAnalizEt', () => {
  it('sahte beyin yanıtını kanıt dosyalarıyla atomik pakete dönüştürür', async () => {
    const { dizin, kosuDizini, beyin } = await hazirDizin();
    const paket = await hataAnalizEt(beyin, dizin, test, sonuc, [
      { stepIndex: 0, description: 'Sayfayı aç', status: 'passed', durationMs: 10 },
      { stepIndex: 1, description: 'Başlığı doğrula', status: 'failed', errorMessage: 'Başlık bulunamadı', durationMs: 10 },
    ]);

    const okunan = await dizin.hataPaketiOku(test.id);
    expect(okunan).toEqual(paket);
    expect(okunan.failure.evidence.map((kanit) => kanit.path)).toEqual(['adim-1.png', 'adim-1.html', 'console.json', 'network.json']);
    await Promise.all(okunan.failure.evidence.map((kanit) => access(join(dizin.yol('failure', test.id), kanit.path))));
    await expect(access(join(dizin.yol('failure', test.id), 'trace.zip'))).resolves.toBeUndefined();
    const gunluk = await readFile(join(kosuDizini, `beyin-analiz-${test.id}-1.log`), 'utf8');
    expect(gunluk).toContain('"stepIndex": 1');
    expect(gunluk).toContain('konsol-20');
    expect(gunluk).not.toContain('konsol-21');
  });

  it('harita yokken eski sınıflandırmayı ve paket biçimini korur', async () => {
    const { dizin, beyin } = await hazirDizin();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const paket = await hataAnalizEt(beyin, dizin, test, sonuc, [
      { stepIndex: 1, description: 'Başlığı doğrula', status: 'failed', errorMessage: 'Başlık bulunamadı', durationMs: 10 },
    ]);

    expect(paket.failure.failureKind).toBe('product_bug');
    expect(paket.result.failureKind).toBe('product_bug');
    expect(paket).not.toHaveProperty('mapDiff');
    expect(paket.failure.recommendedFixTarget.rationale).toContain('search the product code');
    expect(paket.failure.recommendedFixTarget.rationale).toContain('Received');
    expect(stderr.mock.calls.map((cagri) => String(cagri[0]))).toContainEqual(
      expect.stringContaining('[kobay analysis] No explore map; map comparison skipped.'),
    );
    stderr.mockRestore();
  });

  it('model metinlerinden iç harita alan adlarını ayıklar', async () => {
    const { dizin, beyin } = await hazirDizin({
      ...beyinYanit,
      rootCauseHypothesis: 'Keşif haritasında pageIdentityMatches=false ve changed=false görünüyor.',
      recommendedFixTarget: {
        ...beyinYanit.recommendedFixTarget,
        rationale: 'removedHeadings alanına göre ürün kodu bozuk.',
      },
      evidence: [{ kind: 'snapshot', stepIndex: 1, summary: 'addedButtons boş.' }],
    });
    const paket = await hataAnalizEt(beyin, dizin, test, sonuc, [
      { stepIndex: 1, description: 'Başlığı doğrula', status: 'failed', errorMessage: 'Başlık bulunamadı', durationMs: 10 },
    ]);

    const metin = JSON.stringify(paket.failure);
    for (const alan of ['pageIdentityMatches', 'changed', 'removedHeadings', 'addedButtons']) {
      expect(metin).not.toContain(alan);
    }
    expect(paket.failure.rootCauseHypothesis).toContain('does not match the page identity from explore');
  });

  it('paket errorMessage alanlarında iç stack satırlarını çıkarır, kullanıcı satırını bırakır', async () => {
    const hata = [
      'Error: expect(received).toBe(expected)',
      '    at fixture (/home/user/app/src/kos/fixture.ts:52:9)',
      '    at /urun/tests/siparis.spec.ts:31:5',
    ].join('\n');
    const { dizin, beyin } = await hazirDizin();
    const paket = await hataAnalizEt(beyin, dizin, test, { ...sonuc, errorMessage: hata }, [
      { stepIndex: 1, description: 'Başlığı doğrula', status: 'failed', errorMessage: hata, durationMs: 10 },
    ]);

    expect(paket.result.errorMessage).not.toContain('src/kos/fixture.ts');
    expect(paket.steps[0]?.errorMessage).not.toContain('src/kos/fixture.ts');
    expect(paket.result.errorMessage).toContain('/urun/tests/siparis.spec.ts:31:5');
    expect(paket.steps[0]?.errorMessage).toContain('/urun/tests/siparis.spec.ts:31:5');
  });

  it('code hedefinde Received metnini ürün kaynağında arama ipucu verir', async () => {
    const hata = 'Expected: "Onaylandı"\nReceived: "Ödeme reddedildi"';
    const { dizin, beyin } = await hazirDizin();
    const paket = await hataAnalizEt(beyin, dizin, test, { ...sonuc, errorMessage: hata }, [
      { stepIndex: 1, description: 'Durumu doğrula', status: 'failed', errorMessage: hata, durationMs: 10 },
    ]);

    expect(paket.failure.recommendedFixTarget.rationale).toContain('search the product code');
    expect(paket.failure.recommendedFixTarget.rationale).toContain('Ödeme reddedildi');
  });

  it('keşifteki Cariler başlığı Müşteriler olunca beyin test_bug dese de product_changed yapar', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const testBugYanit = {
      ...beyinYanit,
      rootCauseHypothesis: 'Başlık seçicisi artık eşleşmiyor.',
      failureKind: 'test_bug',
      recommendedFixTarget: { kind: 'selector', reference: "getByRole('heading')", rationale: 'Seçici güncellenmeli.' },
      evidence: [],
    };
    const { dizin, kosuDizini, beyin } = await hazirDizin(testBugYanit);
    const carilerTesti: TestKaydi = { ...test, name: 'Cariler başlığı görünür', url: '/cariler' };
    await Promise.all([
      dizin.testYaz(carilerTesti),
      dizin.kodYaz(test.id, `test('cariler', async ({ page }) => {
  await test.step('0: Sayfayı aç', async () => { await page.goto('/cariler'); });
  await test.step('1: Cariler başlığını doğrula', async () => {
    await expect(page.getByRole('heading', { name: 'Cariler' })).toBeVisible();
  });
});`),
      yazAtomik(join(kosuDizini, 'adim-1.html'), '<html><head><title>Müşteriler</title></head><body><h1>Müşteriler</h1></body></html>'),
      dizin.haritaYaz({
        baseUrl: 'http://uygulama.test',
        loggedIn: true,
        exploredAt: '2026-09-17T00:00:00.000Z',
        pages: [{
          url: 'http://uygulama.test/cariler', title: 'Cariler', headings: ['Cariler'],
          links: [], forms: [], buttons: [], menu: [],
        }],
      }),
    ]);

    const paket = await hataAnalizEt(beyin, dizin, carilerTesti, sonuc, [
      { stepIndex: 1, description: 'Cariler başlığını doğrula', status: 'failed', errorMessage: 'Cariler bulunamadı', durationMs: 10 },
    ]);

    expect(paket.failure.failureKind).toBe('product_changed');
    expect(paket.result.failureKind).toBe('product_changed');
    expect(paket.failure.rootCauseHypothesis).toContain('"Cariler" was present during explore and is gone now');
    expect(paket.failure.rootCauseHypothesis).toContain(testBugYanit.rootCauseHypothesis);
    expect(paket.failure.recommendedFixTarget).toEqual({
      kind: 'code',
      reference: 'http://uygulama.test/cariler: "Cariler" → "Müşteriler"',
      rationale: 'The explore map is stale; re-run explore and regenerate the test.',
    });
    expect(paket.mapDiff).toMatchObject({
      url: 'http://uygulama.test/cariler',
      removedHeadings: ['Cariler'],
      addedHeadings: ['Müşteriler'],
      pageIdentityMatches: true,
      changed: true,
    });
  });

  it('düğme sadece silinmişse (yerine yenisi gelmemişse) beynin product_bug kararını korur', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const { dizin, beyin, carilerTesti } = await carilerHazirla(beyinYanit, {
      dom: '<html><head><title>Cariler</title></head><body><h1>Cariler</h1></body></html>',
      sayfa: { buttons: ['Kaydet'] },
    });

    const paket = await hataAnalizEt(beyin, dizin, carilerTesti, sonuc, [
      { stepIndex: 1, description: 'Kaydet düğmesine bas', status: 'failed', errorMessage: 'Kaydet düğmesi bulunamadı', durationMs: 10 },
    ]);

    expect(paket.mapDiff).toMatchObject({ removedButtons: ['Kaydet'], addedButtons: [] });
    expect(paket.failure.failureKind).toBe('product_bug');
    expect(paket.failure.rootCauseHypothesis).not.toContain('Local map comparison');
  }, 60_000);

  it('sayfa kimliği tutmuyorsa (giriş ekranına yönlenme) emniyet çalışmaz', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const testBugYanit = { ...beyinYanit, failureKind: 'test_bug', evidence: [] };
    const { dizin, beyin, carilerTesti } = await carilerHazirla(testBugYanit, {
      dom: '<html><head><title>Giriş Yap</title></head><body><h1>Giriş Yap</h1></body></html>',
    });

    const paket = await hataAnalizEt(beyin, dizin, carilerTesti, sonuc, [
      { stepIndex: 1, description: 'Cariler başlığını doğrula', status: 'failed', errorMessage: 'Cariler bulunamadı', durationMs: 10 },
    ]);

    expect(paket.mapDiff).toMatchObject({
      removedHeadings: ['Cariler'],
      addedHeadings: ['Giriş Yap'],
      pageIdentityMatches: false,
    });
    expect(paket.failure.failureKind).toBe('test_bug');
  }, 60_000);

  it('fark bloğuna giren başlıklar maskelenmiş DOM üzerinden üretilir', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const { dizin, kosuDizini, beyin, carilerTesti } = await carilerHazirla(beyinYanit, {
      dom: '<html><head><title>Cariler</title></head><body><h1>Cariler</h1><h2>Token: abc123XYZ</h2></body></html>',
    });

    const paket = await hataAnalizEt(beyin, dizin, carilerTesti, sonuc, [
      { stepIndex: 1, description: 'Cariler başlığını doğrula', status: 'failed', errorMessage: 'Başlık bulunamadı', durationMs: 10 },
    ]);

    expect(paket.mapDiff?.addedHeadings).toEqual(['Token: [redacted]']);
    expect(JSON.stringify(paket)).not.toContain('abc123XYZ');
    const gunluk = await readFile(join(kosuDizini, `beyin-analiz-${test.id}-1.log`), 'utf8');
    expect(gunluk).not.toContain('abc123XYZ');
  }, 60_000);

  it('aranan metin hata mesajında değil yalnız düşen adımın kodundaysa da product_changed yapar', async (context) => {
    if (!tarayiciMumkun(context)) return;
    const testBugYanit = { ...beyinYanit, failureKind: 'test_bug', evidence: [] };
    const { dizin, beyin, carilerTesti } = await carilerHazirla(testBugYanit, {
      dom: '<html><head><title>Cariler</title></head><body><h1>Müşteriler</h1></body></html>',
    });

    const paket = await hataAnalizEt(beyin, dizin, carilerTesti, {
      ...sonuc,
      errorMessage: 'Timed out 5000ms waiting for expect(locator).toBeVisible()',
    }, [
      {
        stepIndex: 1,
        description: 'Cariler başlığını doğrula',
        status: 'failed',
        errorMessage: 'Timed out 5000ms waiting for expect(locator).toBeVisible()',
        durationMs: 10,
      },
    ]);

    expect(paket.failure.failureKind).toBe('product_changed');
    expect(paket.failure.recommendedFixTarget.reference).toBe('http://uygulama.test/cariler: "Cariler" → "Müşteriler"');
  }, 60_000);

  it('beyin anmasa bile düşen adımın png ve html kanıtı pakete girer', async () => {
    const { dizin, beyin } = await hazirDizin({ ...beyinYanit, evidence: [] });
    const paket = await hataAnalizEt(beyin, dizin, test, sonuc, [
      { stepIndex: 1, description: 'Başlığı doğrula', status: 'failed', errorMessage: 'Başlık bulunamadı', durationMs: 10 },
    ]);

    expect(paket.failure.evidence).toEqual([
      { kind: 'screenshot', stepIndex: 1, path: 'adim-1.png', summary: 'screenshot of the failing step' },
      { kind: 'snapshot', stepIndex: 1, path: 'adim-1.html', summary: 'DOM snapshot of the failing step' },
    ]);
    await Promise.all(paket.failure.evidence.map((kanit) => access(join(dizin.yol('failure', test.id), kanit.path))));
  });

  it('aynı dosyayı gösteren kanıtları tek maddede toplar, özetleri birleştirir', async () => {
    const { dizin, beyin } = await hazirDizin({
      ...beyinYanit,
      evidence: [
        { kind: 'snapshot', stepIndex: 1, summary: 'Başlık DOM içinde yok.' },
        { kind: 'snapshot', stepIndex: 1, summary: 'Menüde Müşteriler yazıyor.' },
        { kind: 'snapshot', stepIndex: 1, summary: 'Başlık DOM içinde yok.' },
        { kind: 'snapshot', stepIndex: 1, summary: 'Tablo boş.' },
      ],
    });
    const paket = await hataAnalizEt(beyin, dizin, test, sonuc, [
      { stepIndex: 1, description: 'Başlığı doğrula', status: 'failed', errorMessage: 'Başlık bulunamadı', durationMs: 10 },
    ]);

    const snapshotlar = paket.failure.evidence.filter((kanit) => kanit.kind === 'snapshot');
    expect(snapshotlar).toHaveLength(1);
    expect(snapshotlar[0]).toEqual({
      kind: 'snapshot',
      stepIndex: 1,
      path: 'adim-1.html',
      summary: 'Başlık DOM içinde yok.; Menüde Müşteriler yazıyor.; Tablo boş.',
    });
    // Tekilleştirme sınırı da boşaltır: yerel png hâlâ pakete giriyor.
    expect(paket.failure.evidence.map((kanit) => kanit.path)).toEqual(['adim-1.html', 'adim-1.png']);
  });

  it('kanıt sınırı aşılırsa yerel ekleme kalır, beyninkilerden kırpılır', async () => {
    // Sınır yalnız farklı dosyalarla aşılabilir: aynı dosya artık tek maddeye iniyor.
    const { dizin, kosuDizini, beyin } = await hazirDizin({
      ...beyinYanit,
      evidence: [
        { kind: 'screenshot', stepIndex: 2, summary: 'beyin kanıtı 0' },
        { kind: 'snapshot', stepIndex: 2, summary: 'beyin kanıtı 1' },
        { kind: 'screenshot', stepIndex: 3, summary: 'beyin kanıtı 2' },
        { kind: 'snapshot', stepIndex: 3, summary: 'beyin kanıtı 3' },
        { kind: 'console', stepIndex: 1, summary: 'beyin kanıtı 4' },
        { kind: 'network', stepIndex: 1, summary: 'beyin kanıtı 5' },
      ],
    });
    await Promise.all([
      yazAtomik(join(kosuDizini, 'adim-2.png'), 'sahte png'),
      yazAtomik(join(kosuDizini, 'adim-2.html'), '<h1>iki</h1>'),
      yazAtomik(join(kosuDizini, 'adim-3.png'), 'sahte png'),
      yazAtomik(join(kosuDizini, 'adim-3.html'), '<h1>üç</h1>'),
    ]);
    const paket = await hataAnalizEt(beyin, dizin, test, sonuc, [
      { stepIndex: 1, description: 'Başlığı doğrula', status: 'failed', errorMessage: 'Başlık bulunamadı', durationMs: 10 },
    ]);

    const yollar = paket.failure.evidence.map((kanit) => kanit.path);
    expect(yollar).toHaveLength(6);
    expect(yollar.slice(-2)).toEqual(['adim-1.png', 'adim-1.html']);
    expect(paket.failure.evidence.filter((kanit) => kanit.summary.startsWith('beyin kanıtı'))).toHaveLength(4);
  });

  it('failedStepIndex yoksa son failed adımı seçer', async () => {
    const { dizin, kosuDizini, beyin } = await hazirDizin({ ...beyinYanit, evidence: [] });
    await hataAnalizEt(beyin, dizin, test, sonuc, [
      { stepIndex: 1, description: 'İlk hata', status: 'failed', durationMs: 1 },
      { stepIndex: 2, description: 'Son hata', status: 'failed', durationMs: 1 },
    ]);
    await expect(readFile(join(kosuDizini, `beyin-analiz-${test.id}-1.log`), 'utf8')).resolves.toContain('"stepIndex": 2');
  });

  it('beyin hatasını yutmaz', async () => {
    const { dizin } = await hazirDizin();
    const bosBeyin = beyinOlustur({ adaptor: 'sahte' }, { KOBAY_SAHTE_YANIT_DIZINI: await mkdtemp(join(tmpdir(), 'kobay-analiz-bos-')) });
    await expect(hataAnalizEt(bosBeyin, dizin, test, sonuc, [])).rejects.toBeInstanceOf(BrainError);
  });

  it('JSON, yetkilendirme ve URL sorgu sırlarını maskeler', async () => {
    const { dizin, kosuDizini, beyin } = await hazirDizin();
    await Promise.all([
      dizin.kodYaz(test.id, 'const ayar = {"password":"json-secret", api_key: "duz-secret"};'),
      yazAtomik(join(kosuDizini, 'console.json'), JSON.stringify([
        { tip: 'error', metin: 'Authorization: Bearer abc.DEF-123 ve Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==' },
      ])),
      yazAtomik(join(kosuDizini, 'network.json'), JSON.stringify([
        { url: '/api?token=url-secret&api_key=key-secret', method: 'GET', status: 500 },
      ])),
    ]);
    await hataAnalizEt(beyin, dizin, test, {
      ...sonuc,
      errorMessage: 'Hata {"password":"hata-secret"} Authorization: Bearer hata.token',
    }, [
      { stepIndex: 1, description: 'Başlığı doğrula', status: 'failed', errorMessage: 'Basic Zm9vOmJhcg==', durationMs: 10 },
    ]);

    const gunluk = await readFile(join(kosuDizini, `beyin-analiz-${test.id}-1.log`), 'utf8');
    for (const sir of ['json-secret', 'duz-secret', 'abc.DEF-123', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ', 'url-secret', 'key-secret', 'hata-secret', 'hata.token', 'Zm9vOmJhcg']) {
      expect(gunluk).not.toContain(sir);
    }
    expect(gunluk).toContain('[redacted]');
  });
});

describe('analiz istemi', () => {
  it('değişmez İngilizce JSON iskeletini açıkça verir', () => {
    const istem = analizSistemIstemiOlustur();

    expect(istem).toContain('"rootCauseHypothesis":"..."');
    expect(istem).toContain('{"rootCauseHypothesis":"...","failureKind":"test_bug","recommendedFixTarget"');
    expect(istem).toContain('are English and fixed; do not translate them');
    expect(istem).toContain('product_changed');
    expect(istem).toContain("Kobay's internal JSON field names");
    expect(istem).toContain('Received');
    expect(istem).toContain(
      "Write names, descriptions and rationale in the language of the application's UI and docs;"
      + ' if mixed or unclear, use English.',
    );
    expect(istem).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
  });

  it('konsol kayıtlarını 20 ile sınırlar', () => {
    const istem = analizKullaniciIstemiOlustur({
      dusenAdim: { stepIndex: 0, description: 'Hata', status: 'failed', durationMs: 0 }, hataMetni: 'Hata',
      ekranGoruntusu: { varMi: false, yol: '/yok' }, dom: null, kod: '', test,
      konsolHatalari: Array.from({ length: 21 }, (_deger, sira) => ({ tip: 'error', metin: `k-${sira + 1}` })),
      agHatalari: [],
    });
    expect(istem).toContain('k-20');
    expect(istem).not.toContain('k-21');
    expect(istem).toContain('"text": "k-1"');
    expect(istem).toContain('## Diff against the exploration map\n[no map diff]');
    expect(istem).toContain('"name": "Ürün başlığı görünür"');
  });
});
