import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import {
  GOC_KANCASI,
  KobayDizini,
  SchemaError,
  SchemaVersionTooNew,
  depoyuBuda,
  hataPaketiCikisYolu,
  type HataPaketi,
  type KosuSonucu,
  type Oneri,
  type TestKaydi,
} from '../../src/depo/index.js';
import { PAKET_KILIDI } from '../../src/depo/paket-kilidi.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * 0.9.0 D1 karşıt denetim (Codex tur 1) gerileme testleri: daha yeni sürümlü dosyayı
 * ezen/silen/taşıyan yazma yolları, göç yarışı, budama, 0.1 adları ön denetimi ve
 * yol-duyarlı 0.1 anahtar göçü.
 */

const json = (veri: unknown): string => `${JSON.stringify(veri, null, 2)}\n`;

const TEST: TestKaydi = {
  id: 't_abcdefgh', name: 'Hazır test', type: 'frontend', createdFrom: 'cli', status: 'ready',
  planSteps: [{ type: 'action', description: 'Ana sayfayı aç' }], priority: 'p1', codeVersion: 1,
  createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
};

const ONERI: Oneri = {
  proposalId: 'p_abc123', title: 'Giriş', description: 'Giriş sayfası', priority: 'p1', category: 'auth',
  feature: 'login', type: 'frontend', url: '/login', steps: [{ type: 'action', description: 'Aç' }],
};

function kosu(runId: string, ek: Partial<KosuSonucu> = {}): KosuSonucu {
  return {
    testId: TEST.id, runId, status: 'passed', verdict: 'passed', codeVersion: 1,
    startedAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T00:00:01.000Z', ...ek,
  };
}

function paket(runId: string): HataPaketi {
  return {
    snapshotId: `${runId}-x`, testId: TEST.id, runId,
    result: kosu(runId, { status: 'failed', verdict: 'failed', failedStepIndex: 0 }),
    steps: [{ stepIndex: 0, description: 'Ana sayfayı aç', status: 'failed', durationMs: 1 }],
    code: '// kod',
    failure: {
      rootCauseHypothesis: 'x', failureKind: 'product_bug',
      recommendedFixTarget: { kind: 'code', reference: 'r', rationale: 'r' }, evidence: [],
    },
  };
}

/** Proje kökü altındaki bütün girdiler (dizinler dahil) ve dosyaların içerik + inode özeti. */
async function agacOzeti(kok: string): Promise<Record<string, string>> {
  const sonuc: Record<string, string> = {};
  const gez = async (dizin: string): Promise<void> => {
    for (const girdi of await readdir(dizin, { withFileTypes: true })) {
      const yol = join(dizin, girdi.name);
      const ad = relative(kok, yol);
      if (girdi.isDirectory()) {
        sonuc[ad] = 'dizin';
        await gez(yol);
      } else {
        const ozet = createHash('sha256').update(await readFile(yol)).digest('hex');
        sonuc[ad] = process.platform === 'win32' ? ozet : `${ozet}:${(await stat(yol)).ino}`;
      }
    }
  };
  await gez(kok);
  return sonuc;
}

async function hamOku(cwd: string, ...parcalar: string[]): Promise<unknown> {
  return JSON.parse(await readFile(join(cwd, '.kobay', ...parcalar), 'utf8')) as unknown;
}

async function surumluProje(): Promise<{ cwd: string; dizin: KobayDizini }> {
  const cwd = await geciciDizinAc('kobay-surum-denetim-');
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } });
  await dizin.testYaz(TEST);
  return { cwd, dizin };
}

async function kobay(cwd: string, ...argumanlar: string[]): Promise<{ kod: number; zarf: { error?: { code: string } } }> {
  const stdout = new PassThrough();
  let cikti = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (parca: string) => { cikti += parca; });
  const kod = await main(['node', 'kobay', '--cwd', cwd, '--output', 'json', ...argumanlar], {
    input: Readable.from([]), stdout, stderr: new PassThrough(),
  });
  return { kod, zarf: JSON.parse(cikti.trim()) as { error?: { code: string } } };
}

afterEach(() => {
  delete GOC_KANCASI.yazmadanOnce;
  delete GOC_KANCASI.kilit;
});

describe('P1: mevcut daha yeni (ya da geçersiz) sürümlü dosyayı ezen/silen yazma yolu önce sürümü denetler', () => {
  it('hataPaketiYaz: sürüm 2 paket kenara alınıp silinmez', async () => {
    const { cwd, dizin } = await surumluProje();
    await mkdir(join(cwd, '.kobay', 'failure', TEST.id), { recursive: true });
    await writeFile(join(cwd, '.kobay', 'failure', TEST.id, 'failure.json'), json({ schemaVersion: 2, futureField: 'korunmalı' }));
    const once = await agacOzeti(cwd);
    await expect(dizin.hataPaketiYaz(paket('r_20260101000000_aaaa'), [])).rejects.toBeInstanceOf(SchemaVersionTooNew);
    expect(await agacOzeti(cwd)).toEqual(once);
  });

  it('hataPaketiYaz: geçersiz sürüm alanlı ("2") paket de ezilmez (SchemaError)', async () => {
    const { cwd, dizin } = await surumluProje();
    await mkdir(join(cwd, '.kobay', 'failure', TEST.id), { recursive: true });
    await writeFile(join(cwd, '.kobay', 'failure', TEST.id, 'failure.json'), json({ schemaVersion: '2', futureField: 'korunmalı' }));
    const once = await agacOzeti(cwd);
    await expect(dizin.hataPaketiYaz(paket('r_20260101000000_aaaa'), [])).rejects.toBeInstanceOf(SchemaError);
    expect(await agacOzeti(cwd)).toEqual(once);
  });

  const RUN = 'r_20260101000000_bbbb';
  const yazicilar: Array<{ ad: string; dosya: string[]; yaz: (d: KobayDizini) => Promise<void> }> = [
    { ad: 'testYaz', dosya: ['tests', `${TEST.id}.json`], yaz: (d) => d.testYaz(TEST) },
    { ad: 'testSil', dosya: ['tests', `${TEST.id}.json`], yaz: (d) => d.testSil(TEST.id) },
    { ad: 'kosuSonucuYaz', dosya: ['runs', RUN, 'result.json'], yaz: (d) => d.kosuSonucuYaz(kosu(RUN)) },
    { ad: 'configYaz', dosya: ['config.json'], yaz: (d) => d.configYaz({ baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } }) },
    { ad: 'kimlikYaz', dosya: ['credentials.json'], yaz: (d) => d.kimlikYaz({ username: 'u', password: 'p' }) },
    {
      ad: 'haritaYaz', dosya: ['map.json'],
      yaz: (d) => d.haritaYaz({ baseUrl: 'http://uygulama.test', loggedIn: false, pages: [], exploredAt: '2026-01-01T00:00:00.000Z' }),
    },
    { ad: 'onerileriYaz', dosya: ['plan', 'proposals.json'], yaz: (d) => d.onerileriYaz([ONERI]) },
  ];

  it.each(yazicilar)('$ad: sürüm 9 dosyanın üstüne yazmaz / silmez', async ({ dosya, yaz }) => {
    const { cwd, dizin } = await surumluProje();
    await mkdir(join(cwd, '.kobay', ...dosya.slice(0, -1)), { recursive: true });
    await writeFile(join(cwd, '.kobay', ...dosya), json({ schemaVersion: 9, futureField: 'korunmalı' }));
    const once = await agacOzeti(cwd);
    await expect(yaz(dizin)).rejects.toBeInstanceOf(SchemaVersionTooNew);
    expect(await agacOzeti(cwd)).toEqual(once);
  });
});

describe('P1: göç yarışı', () => {
  it('göç okuyup yazmadan önce başka bir komut config\'i yazarsa yazdığı kaybolmaz', async () => {
    const cwd = await geciciDizinAc('kobay-goc-yarisi-');
    await mkdir(join(cwd, '.kobay'), { recursive: true });
    const A = { baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } };
    const B = { baseUrl: 'http://uygulama.test', loginUrl: 'http://uygulama.test/login', brain: { adaptor: 'sahte' } };
    await writeFile(join(cwd, '.kobay', 'config.json'), json(A));
    // İlk açılış (birinci süreç gibi) config'i okudu, karar verdi, yazmak üzere. Tam o anda
    // ikinci bir komut açılır ve kendi ayarını yazar. İkinci komut göç kilidine takılırsa
    // (düzeltilmiş durum) bekler; takılmazsa (yarış) yazar ve birinci onun üstüne yazar.
    let ilk = true;
    let ikinci: Promise<void> | undefined;
    GOC_KANCASI.yazmadanOnce = async (yol) => {
      if (!ilk || !yol.endsWith('config.json')) return;
      ilk = false;
      let kilideTakildi: () => void = () => undefined;
      const takildi = new Promise<void>((coz) => { kilideTakildi = coz; });
      GOC_KANCASI.kilit = { olay: (olay) => { if (olay === 'incele-basladi') kilideTakildi(); } };
      ikinci = (async () => {
        const dizin = await KobayDizini.bul(cwd);
        await dizin?.configYaz(B);
      })();
      await Promise.race([ikinci, takildi]);
    };
    await KobayDizini.bul(cwd);
    await ikinci;
    expect(await hamOku(cwd, 'config.json')).toEqual({ schemaVersion: 1, ...B });
  });
});

describe('tur 2: göç kilidinde zaman aşımı', () => {
  it('kilidi tutan göç yavaşken, kilitte zaman aşımına düşen komutun config yazımı kaybolmaz', async () => {
    const cwd = await geciciDizinAc('kobay-goc-zaman-asimi-');
    await mkdir(join(cwd, '.kobay'), { recursive: true });
    const A = { baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } };
    const B = { baseUrl: 'http://uygulama.test', loginUrl: 'http://uygulama.test/login', brain: { adaptor: 'sahte' } };
    await writeFile(join(cwd, '.kobay', 'config.json'), json(A));
    const eskiBekleme = PAKET_KILIDI.beklemeMs;
    // Bekleme sınırı kısaltılır; sonuç zamana bağlı değil: birinci göç kancada beklediği sürece
    // kilidi bırakmaz, ikinci komut her koşuda zaman aşımına düşer.
    PAKET_KILIDI.beklemeMs = 50;
    let ilk = true;
    GOC_KANCASI.yazmadanOnce = async (yol) => {
      if (!ilk || !yol.endsWith('config.json')) return;
      ilk = false;
      // Birinci göç (kilit elinde) yazmak üzere. İkinci komut kilidi bekler, zaman aşımına
      // düşer, bellekte göç eder ve kendi ayarını yazar.
      const ikinci = await KobayDizini.bul(cwd);
      await ikinci?.configYaz(B);
    };
    try {
      await KobayDizini.bul(cwd);
    } finally {
      PAKET_KILIDI.beklemeMs = eskiBekleme;
    }
    expect(await hamOku(cwd, 'config.json')).toEqual({ schemaVersion: 1, ...B });
  });
});

describe('tur 2: failure get çıkış klasöründeki daha yeni sürümlü kopya kenara alınıp silinmez', () => {
  it.each(['failure.json', 'meta.json'])('failure-out/<id>/%s sürüm 2', async (ad) => {
    const { cwd, dizin } = await surumluProje();
    await dizin.hataPaketiYaz(paket('r_20260101000000_aaaa'), []);
    const cikis = hataPaketiCikisYolu(cwd, TEST.id);
    await mkdir(cikis, { recursive: true });
    await writeFile(join(cikis, ad), json({ schemaVersion: 2, futureField: 'korunmalı' }));
    const once = await agacOzeti(cwd);
    await expect(dizin.hataPaketiKopyala(TEST.id, cikis)).rejects.toBeInstanceOf(SchemaVersionTooNew);
    expect(await agacOzeti(cwd)).toEqual(once);
  });
});

describe('tur 3: failure get, kaynak paketin meta.json dosyası daha yeni sürümlü', () => {
  it.each([
    { ad: 'varsayılan çıkış (failure-out)', hedef: (cwd: string) => hataPaketiCikisYolu(cwd, TEST.id) },
    { ad: '--out ile verilen yeni klasör', hedef: (cwd: string) => join(cwd, 'paket-kopyasi') },
  ])('$ad: hiçbir klasör açılmaz, hiçbir şey kopyalanmaz', async ({ hedef }) => {
    const { cwd, dizin } = await surumluProje();
    await dizin.hataPaketiYaz(paket('r_20260101000000_aaaa'), []);
    const metaYolu = join(cwd, '.kobay', 'failure', TEST.id, 'meta.json');
    const meta = JSON.parse(await readFile(metaYolu, 'utf8')) as Record<string, unknown>;
    await writeFile(metaYolu, json({ ...meta, schemaVersion: 999 }));
    const once = await agacOzeti(cwd);
    await expect(dizin.hataPaketiKopyala(TEST.id, hedef(cwd))).rejects.toBeInstanceOf(SchemaVersionTooNew);
    expect(await agacOzeti(cwd)).toEqual(once);
  });
});

describe('P2: budama daha yeni sürümlü hata paketi görünce hiçbir şey silmez, çıkış 2', () => {
  it('paketteki trace.zip silinmez', async () => {
    const { cwd, dizin } = await surumluProje();
    await mkdir(join(cwd, '.kobay', 'failure', TEST.id), { recursive: true });
    await writeFile(join(cwd, '.kobay', 'failure', TEST.id, 'failure.json'), json({ schemaVersion: 2, futureField: 'x' }));
    await writeFile(join(cwd, '.kobay', 'failure', TEST.id, 'trace.zip'), 'iz');
    const once = await agacOzeti(cwd);
    await expect(depoyuBuda(dizin)).rejects.toBeInstanceOf(SchemaVersionTooNew);
    expect(await agacOzeti(cwd)).toEqual(once);
    const cli = await kobay(cwd, 'prune');
    expect(cli.kod).toBe(2);
    expect(cli.zarf.error?.code).toBe('SchemaVersionTooNew');
    expect(await agacOzeti(cwd)).toEqual(once);
  });

  it('paketin yeni biçimle işaret ettiği koşu silinmez (depo budaması ve koşu sonrası budama)', async () => {
    const { cwd, dizin } = await surumluProje();
    const kosular = Array.from({ length: 7 }, (_, sira) => `r_2020010100000${sira}_aaaa`);
    for (const runId of kosular) await dizin.kosuSonucuYaz(kosu(runId));
    await mkdir(join(cwd, '.kobay', 'failure', TEST.id), { recursive: true });
    await writeFile(join(cwd, '.kobay', 'failure', TEST.id, 'failure.json'),
      json({ schemaVersion: 2, activeRun: { id: kosular[0] } }));
    const once = await agacOzeti(cwd);
    await expect(depoyuBuda(dizin)).rejects.toBeInstanceOf(SchemaVersionTooNew);
    expect(await agacOzeti(cwd)).toEqual(once);
    await expect(dizin.kosulariBuda(TEST.id, { tazeMs: 0 })).rejects.toBeInstanceOf(SchemaVersionTooNew);
    expect(await agacOzeti(cwd)).toEqual(once);
  });
});

describe('P2: ön denetim 0.1 adlarını da kapsar ve her yan etkiden önce çalışır', () => {
  async function eskiAdliProje(): Promise<string> {
    const cwd = await geciciDizinAc('kobay-eski-ad-');
    await writeFile(join(cwd, '.gitignore'), 'node_modules/\n');
    await mkdir(join(cwd, '.kobay', 'plan'), { recursive: true });
    await writeFile(join(cwd, '.kobay', 'config.json'), json({ baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } }));
    return cwd;
  }

  it.each([
    { ad: 'harita.json', parcalar: ['harita.json'] },
    { ad: 'plan/onerileri.json', parcalar: ['plan', 'onerileri.json'] },
  ])('$ad sürüm 999: bul() ve ac() ağaçta hiçbir şeyi değiştirmeden durur', async ({ parcalar }) => {
    const cwd = await eskiAdliProje();
    await writeFile(join(cwd, '.kobay', ...parcalar), json({ schemaVersion: 999, yeni: true }));
    const once = await agacOzeti(cwd);
    await expect(KobayDizini.bul(cwd)).rejects.toBeInstanceOf(SchemaVersionTooNew);
    expect(await agacOzeti(cwd)).toEqual(once);
    await expect(KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } }))
      .rejects.toBeInstanceOf(SchemaVersionTooNew);
    expect(await agacOzeti(cwd)).toEqual(once);
  });
});

describe('P2: 0.1 anahtar göçü yalnız bilinen yollarda; bilinmeyen alt nesneler aynen kalır', () => {
  it('config: bilinmeyen alt nesnedeki ad/tip yeniden adlandırılmaz, beyin → brain', async () => {
    const cwd = await geciciDizinAc('kobay-yollu-goc-');
    await mkdir(join(cwd, '.kobay'), { recursive: true });
    await writeFile(join(cwd, '.kobay', 'config.json'), json({
      baseUrl: 'http://app.test', beyin: { adaptor: 'sahte' }, extensionData: { ad: 'müşteri-kimliği', tip: 'özel' },
    }));
    await KobayDizini.bul(cwd);
    expect(await hamOku(cwd, 'config.json')).toEqual({
      schemaVersion: 1, baseUrl: 'http://app.test', brain: { adaptor: 'sahte' },
      extensionData: { ad: 'müşteri-kimliği', tip: 'özel' },
    });
  });

  it('harita: bilinen 0.1 yolları eşlenir, sayfadaki bilinmeyen nesne aynen kalır', async () => {
    const cwd = await geciciDizinAc('kobay-yollu-goc-');
    await mkdir(join(cwd, '.kobay'), { recursive: true });
    await writeFile(join(cwd, '.kobay', 'config.json'), json({ baseUrl: 'http://app.test', brain: { adaptor: 'sahte' } }));
    await writeFile(join(cwd, '.kobay', 'map.json'), json({
      baseUrl: 'http://app.test', girisYapildi: true, kesifTarihi: '2026-01-01T00:00:00.000Z',
      sayfalar: [{
        url: 'http://app.test/', baslik: 'Ana', basliklar: ['Ana'], linkler: [], dugmeler: [], menu: [],
        formlar: [{ alanlar: [{ ad: 'q', tip: 'text', etiket: 'Ara' }] }],
        eklenti: { baslik: 'dokunma', ad: 'dokunma' },
      }],
    }));
    const dizin = await KobayDizini.bul(cwd);
    expect(await hamOku(cwd, 'map.json')).toEqual({
      schemaVersion: 1, baseUrl: 'http://app.test', loggedIn: true, exploredAt: '2026-01-01T00:00:00.000Z',
      pages: [{
        url: 'http://app.test/', title: 'Ana', headings: ['Ana'], links: [], buttons: [], menu: [],
        forms: [{ fields: [{ name: 'q', type: 'text', label: 'Ara' }] }],
        eklenti: { baslik: 'dokunma', ad: 'dokunma' },
      }],
    });
    expect(await dizin?.haritaOku()).toMatchObject({ pages: [{ title: 'Ana', forms: [{ fields: [{ name: 'q' }] }] }] });
  });
});
