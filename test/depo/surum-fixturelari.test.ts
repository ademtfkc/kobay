import { createHash } from 'node:crypto';
import { cp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { main } from '../../src/cli/index.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';
import { baslat } from '../kobay-demo/sunucu.mjs';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * 0.9.0 D1 kabulü: GERÇEK eski kobay sürümlerinin (0.1.0 kaynak ağacı, 0.2.1, 0.7.0, 0.8.1
 * npm paketleri) demo uygulamada sahte beyinle ürettiği `.kobay/` klasörleri
 * (`test/fixtures/surumler/<sürüm>/kobay/`). Her birinde bugünkü kobay okur, çalışır ve
 * dosyaları `schemaVersion` ile yazar; ikinci açılış hiçbir baytı değiştirmez.
 *
 * Fixture'lar 47391 portlu demo adresiyle üretildi; test kopyada portu bu koşunun demo
 * sunucusuna çevirir (adres dışında hiçbir bayt değişmez).
 */

const FIXTURE_KOKU = fileURLToPath(new URL('../fixtures/surumler/', import.meta.url));
const URETIM_ADRESI = '127.0.0.1:47391';

interface Fixture {
  surum: string;
  gecen: string;
  dusen: string;
  oneri: string;
}

/** Fixture'daki kimlikler (üretim çıktısından): geçen test, düşen test (hata paketi), kalan öneri. */
const FIXTURELAR: Fixture[] = [
  { surum: '0.1.0', gecen: 't_1a5doxnl', dusen: 't_ifcwh4xd', oneri: 'p_pxljwz' },
  { surum: '0.2.1', gecen: 't_ribh462p', dusen: 't_o6placir', oneri: '' },
  { surum: '0.7.0', gecen: 't_yozxaw52', dusen: 't_bckf8z11', oneri: '' },
  { surum: '0.8.1', gecen: 't_9cg9t5km', dusen: 't_6sl4za8f', oneri: '' },
];

let tarayiciEngeli: unknown;
let demo: { url: string; kapat: () => Promise<void> } | undefined;

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
  }
  demo = await baslat(0);
  for (const fixture of FIXTURELAR) {
    if (fixture.oneri !== '') continue;
    const oneriler = JSON.parse(await readFile(join(FIXTURE_KOKU, fixture.surum, 'kobay', 'plan', 'proposals.json'), 'utf8')) as Array<{ proposalId: string }>;
    fixture.oneri = oneriler[0]?.proposalId ?? '';
  }
});

afterAll(async () => { await demo?.kapat(); });

function chromiumVarMi(context: TestContext): boolean {
  if (tarayiciEngeli === undefined) return true;
  if (process.env.KOBAY_CHROMIUM_TEST === '1') throw tarayiciEngeli;
  context.skip(`Chromium engelli: ${String(tarayiciEngeli).split('\n')[0] ?? ''}`);
  return false;
}

interface Zarf {
  ok: boolean;
  exitCode: number;
  data?: unknown;
  error?: { code: string; message: string };
}

async function kobay(cwd: string, ...argumanlar: string[]): Promise<{ kod: number; zarf: Zarf; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let cikti = '';
  let hata = '';
  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  stdout.on('data', (parca: string) => { cikti += parca; });
  stderr.on('data', (parca: string) => { hata += parca; });
  const kod = await main(['node', 'kobay', '--cwd', cwd, '--output', 'json', ...argumanlar], {
    input: Readable.from([]), stdout, stderr,
  });
  return { kod, zarf: JSON.parse(cikti.trim()) as Zarf, stderr: hata };
}

/** Fixture'ı geçici bir projeye `.kobay` olarak kopyalar ve demo adresini bu koşunun portuna çevirir. */
async function fixtureProjesi(surum: string): Promise<string> {
  const cwd = await geciciDizinAc(`kobay-surum-${surum}-`);
  const kobayDizini = join(cwd, '.kobay');
  await cp(join(FIXTURE_KOKU, surum, 'kobay'), kobayDizini, { recursive: true });
  const adres = new URL(demo?.url ?? '').host;
  for (const yol of await dosyalar(kobayDizini)) {
    const metin = await readFile(yol, 'utf8');
    if (metin.includes(URETIM_ADRESI)) await writeFile(yol, metin.split(URETIM_ADRESI).join(adres));
  }
  return cwd;
}

async function dosyalar(kok: string): Promise<string[]> {
  const sonuc: string[] = [];
  for (const girdi of await readdir(kok, { withFileTypes: true })) {
    const yol = join(kok, girdi.name);
    if (girdi.isDirectory()) sonuc.push(...await dosyalar(yol));
    else if (girdi.isFile()) sonuc.push(yol);
  }
  return sonuc.sort();
}

/** `.kobay/` altındaki her dosyanın sha256'sı (göreli yol → özet). */
async function ozetler(cwd: string): Promise<Record<string, string>> {
  const kok = join(cwd, '.kobay');
  const sonuc: Record<string, string> = {};
  for (const yol of await dosyalar(kok)) {
    const ozet = createHash('sha256').update(await readFile(yol)).digest('hex');
    // Inode da karşılaştırılır: atomik yazım (geçici dosya + rename) aynı baytları yazsa bile
    // inode değişir; "göç tekrar yazmaz" böylece içerik aynı kalsa da denetlenir.
    sonuc[relative(kok, yol)] = process.platform === 'win32' ? ozet : `${ozet}:${(await stat(yol)).ino}`;
  }
  return sonuc;
}

async function jsonOku(cwd: string, ...parcalar: string[]): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(cwd, '.kobay', ...parcalar), 'utf8')) as Record<string, unknown>;
}

describe.each(FIXTURELAR)('kobay $surum ile üretilmiş .kobay', (fixture) => {
  it('okunur, çalışır, dosyalar schemaVersion ile yazılır, ikinci açılış bayt bayt aynı', { timeout: 240_000 }, async (context) => {
    if (!chromiumVarMi(context)) return;
    const cwd = await fixtureProjesi(fixture.surum);

    // 1. İlk açılış: kök dosyalar yerinde göç eder.
    const liste = await kobay(cwd, 'test', 'list');
    expect(liste.kod, JSON.stringify(liste.zarf)).toBe(0);
    expect((liste.zarf.data as Array<{ id: string }>).map((test) => test.id).sort())
      .toEqual([fixture.gecen, fixture.dusen].sort());
    for (const ad of ['config.json', 'credentials.json', 'map.json']) {
      expect((await jsonOku(cwd, ad)).schemaVersion, ad).toBe(1);
    }
    const oneriDosyasi = await jsonOku(cwd, 'plan', 'proposals.json');
    expect(oneriDosyasi.schemaVersion).toBe(1);
    expect((oneriDosyasi.items as Array<{ proposalId: string }>).map((oneri) => oneri.proposalId)).toEqual([fixture.oneri]);
    expect(Object.keys(await jsonOku(cwd, 'config.json'))).toContain('brain');
    expect(Object.keys(await jsonOku(cwd, 'config.json'))).not.toContain('beyin');
    if (process.platform !== 'win32') {
      expect((await stat(join(cwd, '.kobay', 'credentials.json'))).mode & 0o777).toBe(0o600);
    }

    // 2. İkinci açılış hiçbir dosyayı değiştirmez (göç tekrar yazmaz).
    const ilk = await ozetler(cwd);
    expect((await kobay(cwd, 'test', 'list')).kod).toBe(0);
    expect(await ozetler(cwd)).toEqual(ilk);

    // 3. Derin sürüm-0 dosyaları okunur: koşu kaydı ve (0.1'de Türkçe alanlı) hata paketi.
    const sonuc = await kobay(cwd, 'test', 'result', fixture.dusen);
    expect(sonuc.kod, JSON.stringify(sonuc.zarf)).toBe(0);
    expect(sonuc.zarf.data).toMatchObject({ testId: fixture.dusen, verdict: 'failed' });
    const paket = await kobay(cwd, 'test', 'failure', 'get', fixture.dusen);
    expect(paket.kod, JSON.stringify(paket.zarf)).toBe(0);
    const kopya = await jsonOku(cwd, 'failure-out', fixture.dusen, 'failure.json');
    expect(kopya).toMatchObject({ testId: fixture.dusen, failure: { failureKind: 'product_bug' } });
    expect(await jsonOku(cwd, 'failure', fixture.dusen, 'failure.json')).not.toHaveProperty('schemaVersion');

    // 4. Plan okuma: kalan öneri kabul edilir; öneri dosyası ve yeni test sürüm 1 ile yazılır.
    const kabul = await kobay(cwd, 'test', 'plan', 'accept', '--ids', fixture.oneri);
    expect(kabul.kod, JSON.stringify(kabul.zarf)).toBe(0);
    const yeniTest = (kabul.zarf.data as Array<{ id: string }>)[0]?.id ?? '';
    expect((await jsonOku(cwd, 'tests', `${yeniTest}.json`)).schemaVersion).toBe(1);
    expect(await jsonOku(cwd, 'plan', 'proposals.json')).toEqual({ schemaVersion: 1, items: [] });

    // 5. Gerçek koşu (Chromium, demo uygulama, kayıtlı kimlikle giriş): eski kodla geçer.
    expect((await jsonOku(cwd, 'tests', `${fixture.gecen}.json`))).not.toHaveProperty('schemaVersion');
    const kosu = await kobay(cwd, 'test', 'run', fixture.gecen, '--no-analysis');
    expect(kosu.kod, `${JSON.stringify(kosu.zarf)}\n${kosu.stderr}`).toBe(0);
    const kosuSatiri = (kosu.zarf.data as Array<{ verdict: string; runId: string }>)[0];
    expect(kosuSatiri?.verdict).toBe('passed');
    expect((await jsonOku(cwd, 'tests', `${fixture.gecen}.json`)).schemaVersion).toBe(1);
    expect((await jsonOku(cwd, 'runs', kosuSatiri?.runId ?? '', 'result.json')).schemaVersion).toBe(1);

    // 6. Keşif haritayı sürüm 1 ile yeniden yazar.
    const kesif = await kobay(cwd, 'explore');
    expect(kesif.kod, JSON.stringify(kesif.zarf)).toBe(0);
    expect((await jsonOku(cwd, 'map.json')).schemaVersion).toBe(1);

    // 7. Bütün komutlardan sonra da ikinci açılış bayt bayt aynı.
    expect((await kobay(cwd, 'test', 'list')).kod).toBe(0);
    const son = await ozetler(cwd);
    expect((await kobay(cwd, 'test', 'list')).kod).toBe(0);
    expect(await ozetler(cwd)).toEqual(son);
  });

  it('0.1 adları taşınır; eski adlar kalmaz', async () => {
    const cwd = await fixtureProjesi(fixture.surum);
    expect((await kobay(cwd, 'test', 'list')).kod).toBe(0);
    const adlar = Object.keys(await ozetler(cwd));
    expect(adlar).not.toContain('harita.json');
    expect(adlar).not.toContain(join('plan', 'onerileri.json'));
    expect(adlar).toContain('map.json');
    expect(adlar).toContain(join('plan', 'proposals.json'));
  });
});

/** Kök ve derin dosya türleri; her biri için sürüm 999 reddi. */
const YENI_SURUM_DURUMLARI: Array<{ ad: string; dosya: (f: Fixture) => string[]; komut: (f: Fixture) => string[] }> = [
  { ad: 'config.json', dosya: () => ['config.json'], komut: () => ['test', 'list'] },
  { ad: 'credentials.json', dosya: () => ['credentials.json'], komut: () => ['test', 'list'] },
  { ad: 'map.json', dosya: () => ['map.json'], komut: () => ['test', 'list'] },
  { ad: 'plan/proposals.json', dosya: () => ['plan', 'proposals.json'], komut: () => ['test', 'list'] },
  { ad: 'tests/<id>.json', dosya: (f) => ['tests', `${f.gecen}.json`], komut: () => ['test', 'list'] },
  { ad: 'runs/<runId>/result.json', dosya: () => [], komut: (f) => ['test', 'result', f.dusen] },
  { ad: 'failure/<id>/failure.json', dosya: (f) => ['failure', f.dusen, 'failure.json'], komut: (f) => ['test', 'failure', 'get', f.dusen] },
];

describe('daha yeni schemaVersion: çıkış 2, "yükselt", dosyaya dokunulmaz (Karar 4)', () => {
  const fixture = FIXTURELAR[3] as Fixture;

  async function dusenKosu(cwd: string): Promise<string[]> {
    const kosular = await readdir(join(cwd, '.kobay', 'runs'));
    for (const kosu of kosular) {
      const kayit = await jsonOku(cwd, 'runs', kosu, 'result.json');
      if (kayit.testId === fixture.dusen) return ['runs', kosu, 'result.json'];
    }
    throw new Error('düşen koşu bulunamadı');
  }

  it.each(YENI_SURUM_DURUMLARI)('$ad', async ({ dosya, komut }) => {
    const cwd = await fixtureProjesi(fixture.surum);
    // Kök dosyalar için göçten ÖNCEKİ (sürüm 0) proje: açılış hiçbir şeye dokunmadan durmalı.
    // Derin dosyalar için göç edilmiş proje: reddi o dosyayı okuyan komut verir.
    const kokMu = dosya(fixture).length === 1 || dosya(fixture)[0] === 'plan';
    if (!kokMu) expect((await kobay(cwd, 'test', 'list')).kod).toBe(0);
    const parcalar = dosya(fixture).length > 0 ? dosya(fixture) : await dusenKosu(cwd);
    const veri = await jsonOku(cwd, ...parcalar);
    const govde = Array.isArray(veri) ? { items: veri } : veri;
    await writeFile(join(cwd, '.kobay', ...parcalar), `${JSON.stringify({ ...govde, schemaVersion: 999 }, null, 2)}\n`);
    const once = await ozetler(cwd);

    const sonuc = await kobay(cwd, ...komut(fixture));
    expect(sonuc.kod, JSON.stringify(sonuc.zarf)).toBe(2);
    expect(sonuc.zarf.error?.code).toBe('SchemaVersionTooNew');
    expect(sonuc.zarf.error?.message).toContain(`.kobay/${parcalar.join('/')} was written by a newer kobay (schemaVersion 999)`);
    expect(sonuc.zarf.error?.message).toContain('Upgrade kobay');
    expect(await ozetler(cwd)).toEqual(once);
  });
});

describe('test run / rerun: o testin hata paketi daha yeni sürümlüyse koşu hiç başlamaz (Chromium, beyin, yazım yok)', () => {
  const fixture = FIXTURELAR[3] as Fixture;

  /** Göç edilmiş (sürüm 1) projede düşen testin paket dosyasını sürüm 999 yapar; önceki ağaç özetini döner. */
  async function yeniPaketliProje(dosya: string): Promise<{ cwd: string; once: Record<string, string> }> {
    const cwd = await fixtureProjesi(fixture.surum);
    expect((await kobay(cwd, 'test', 'list')).kod).toBe(0);
    const veri = await jsonOku(cwd, 'failure', fixture.dusen, dosya);
    await writeFile(join(cwd, '.kobay', 'failure', fixture.dusen, dosya), `${JSON.stringify({ ...veri, schemaVersion: 999 }, null, 2)}\n`);
    return { cwd, once: await ozetler(cwd) };
  }

  it.each([
    { ad: 'test run (failure.json 999)', dosya: 'failure.json', komut: (f: Fixture) => ['test', 'run', f.dusen] },
    { ad: 'test run --no-analysis (meta.json 999)', dosya: 'meta.json', komut: (f: Fixture) => ['test', 'run', f.dusen, '--no-analysis'] },
    { ad: 'test rerun (failure.json 999)', dosya: 'failure.json', komut: (f: Fixture) => ['test', 'rerun', f.dusen] },
    { ad: 'test run --all: öteki test de koşmaz', dosya: 'failure.json', komut: () => ['test', 'run', '--all'] },
  ])('$ad', { timeout: 60_000 }, async ({ dosya, komut }) => {
    const { cwd, once } = await yeniPaketliProje(dosya);
    const sonuc = await kobay(cwd, ...komut(fixture));
    expect(sonuc.kod, JSON.stringify(sonuc.zarf)).toBe(2);
    expect(sonuc.zarf.error?.code).toBe('SchemaVersionTooNew');
    expect(sonuc.zarf.error?.message).toContain(`.kobay/failure/${fixture.dusen}/${dosya} was written by a newer kobay`);
    // Beyin çağrılmadı: zarfta `brain` alanı yalnız çağrı olduğunda bulunur.
    expect((sonuc.zarf as { brain?: unknown }).brain).toBeUndefined();
    expect(await ozetler(cwd)).toEqual(once);
  });

  it.each(['test_run', 'test_rerun'])('MCP %s aynı yerden reddeder', { timeout: 60_000 }, async (arac) => {
    const { cwd, once } = await yeniPaketliProje('failure.json');
    const sunucu = mcpSunucusuOlustur({ cwd });
    const istemci = new Client({ name: 'kobay-test', version: '0.1.0' });
    const [sunucuTasima, istemciTasima] = InMemoryTransport.createLinkedPair();
    await Promise.all([sunucu.connect(sunucuTasima), istemci.connect(istemciTasima)]);
    try {
      const sonuc = await istemci.callTool({
        name: arac,
        arguments: arac === 'test_run' ? { ids: [fixture.dusen] } : { id: fixture.dusen },
      });
      expect(sonuc.isError).toBe(true);
      const govde = JSON.parse(((sonuc.content as Array<{ text: string }>)[0] ?? { text: 'null' }).text) as {
        error?: { code: string };
      };
      expect(govde.error?.code).toBe('SchemaVersionTooNew');
    } finally {
      await istemci.close();
      await sunucu.close();
    }
    expect(await ozetler(cwd)).toEqual(once);
  });
});
