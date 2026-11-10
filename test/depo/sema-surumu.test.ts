import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import {
  CONFIG_BICIMI,
  KOSU_BICIMI,
  KobayDizini,
  ONERI_BICIMI,
  SchemaError,
  SchemaVersionTooNew,
  depoyuBuda,
  surumluCoz,
  surumluMetin,
  type KosuSonucu,
  type Oneri,
  type TestKaydi,
} from '../../src/depo/index.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/** 0.9.0 D1: `.kobay/` JSON dosyalarında `schemaVersion` ve tek sürüm okuyucusu. */

const ONERI: Oneri = {
  proposalId: 'p_abc123', title: 'Giriş', description: 'Giriş sayfası', priority: 'p1', category: 'auth',
  feature: 'login', type: 'frontend', url: '/login', steps: [{ type: 'action', description: 'Aç' }],
};

const TEST: TestKaydi = {
  id: 't_abc12345', name: 'Hazır test', type: 'frontend', createdFrom: 'cli', status: 'ready',
  planSteps: [{ type: 'action', description: 'Ana sayfayı aç' }], priority: 'p1', codeVersion: 1,
  createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
};

function kosu(runId: string, testId = TEST.id): KosuSonucu {
  return {
    testId, runId, status: 'passed', verdict: 'passed', codeVersion: 1,
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
  };
}

const json = (veri: unknown): string => `${JSON.stringify(veri, null, 2)}\n`;

/** Sürüm 0 (0.2–0.8 biçimi) bir proje: dosyalar `schemaVersion` taşımaz, öneriler dizi köklü. */
async function surumsuzProje(): Promise<string> {
  const cwd = await geciciDizinAc('kobay-sema-surumu-');
  await mkdir(join(cwd, '.kobay', 'plan'), { recursive: true });
  await mkdir(join(cwd, '.kobay', 'tests'), { recursive: true });
  await writeFile(join(cwd, '.kobay', 'config.json'), json({ baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } }));
  await writeFile(join(cwd, '.kobay', 'credentials.json'), json({ username: 'demo', password: 'demo123' }), { mode: 0o644 });
  await writeFile(join(cwd, '.kobay', 'map.json'), json({
    baseUrl: 'http://uygulama.test', loggedIn: false, exploredAt: '2026-01-01T00:00:00.000Z', pages: [],
  }));
  await writeFile(join(cwd, '.kobay', 'plan', 'proposals.json'), json([ONERI]));
  await writeFile(join(cwd, '.kobay', 'tests', `${TEST.id}.json`), json(TEST));
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

async function hamOku(cwd: string, ...parcalar: string[]): Promise<unknown> {
  return JSON.parse(await readFile(join(cwd, '.kobay', ...parcalar), 'utf8')) as unknown;
}

async function kobay(cwd: string, ...argumanlar: string[]): Promise<{ kod: number; zarf: { error?: { code: string; message: string } } }> {
  const stdout = new PassThrough();
  let cikti = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (parca: string) => { cikti += parca; });
  const kod = await main(['node', 'kobay', '--cwd', cwd, '--output', 'json', ...argumanlar], {
    input: Readable.from([]), stdout, stderr: new PassThrough(),
  });
  return { kod, zarf: JSON.parse(cikti.trim()) as { error?: { code: string; message: string } } };
}

describe('sürüm okuyucusu (saf çekirdek)', () => {
  it('sürümsüz dosya sürüm 0 sayılır ve göç eder; güncel sürüm aynen okunur', () => {
    expect(surumluCoz({ baseUrl: 'http://a.test', beyin: { adaptor: 'sahte' } }, CONFIG_BICIMI, 'config.json'))
      .toEqual({ baseUrl: 'http://a.test', brain: { adaptor: 'sahte' } });
    expect(surumluCoz({ schemaVersion: 1, baseUrl: 'http://a.test', brain: { adaptor: 'sahte' } }, CONFIG_BICIMI, 'config.json'))
      .toEqual({ baseUrl: 'http://a.test', brain: { adaptor: 'sahte' } });
  });

  it('öneri dosyasının eski dizi kökü sürüm 0 sayılır, { items } köküne taşınır', () => {
    expect(surumluCoz([ONERI], ONERI_BICIMI, 'plan/proposals.json')).toEqual({ items: [ONERI] });
    expect(surumluCoz({ schemaVersion: 1, items: [ONERI] }, ONERI_BICIMI, 'plan/proposals.json')).toEqual({ items: [ONERI] });
  });

  it('daha yeni sürüm SchemaVersionTooNew; geçersiz sürüm alanı SchemaError (yeni değil)', () => {
    expect(() => surumluCoz({ ...kosu('r_20260101000000_abcd'), schemaVersion: 2 }, KOSU_BICIMI, '.kobay/runs/x/result.json'))
      .toThrow(SchemaVersionTooNew);
    for (const bozuk of ['1', -1, 1.5, null]) {
      let yakalanan: unknown;
      try {
        surumluCoz({ ...kosu('r_20260101000000_abcd'), schemaVersion: bozuk }, KOSU_BICIMI, 'result.json');
      } catch (hata) {
        yakalanan = hata;
      }
      expect(yakalanan, String(bozuk)).toBeInstanceOf(SchemaError);
      expect(yakalanan, String(bozuk)).not.toBeInstanceOf(SchemaVersionTooNew);
    }
  });

  it('yazım güncel sürümü kökte ilk alan olarak damgalar, gövdedeki eski sürümü atar', () => {
    const metin = surumluMetin(KOSU_BICIMI, { ...kosu('r_20260101000000_abcd'), schemaVersion: 0 });
    expect(metin.startsWith('{\n  "schemaVersion": 1,\n')).toBe(true);
    expect((metin.match(/schemaVersion/g) ?? []).length).toBe(1);
  });
});

describe('açılışta göç', () => {
  it('kök dosyalar bir kez sürüm 1 ile yeniden yazılır; ikinci açılış bayt bayt aynı; derin dosyalar okunur ama yazılmaz', async () => {
    const cwd = await surumsuzProje();
    const dizin = await KobayDizini.bul(cwd);
    expect(dizin).not.toBeNull();
    expect(await hamOku(cwd, 'plan', 'proposals.json')).toEqual({ schemaVersion: 1, items: [ONERI] });
    expect(await hamOku(cwd, 'config.json')).toMatchObject({ schemaVersion: 1 });
    expect(await hamOku(cwd, 'credentials.json')).toMatchObject({ schemaVersion: 1, username: 'demo' });
    expect(await hamOku(cwd, 'map.json')).toMatchObject({ schemaVersion: 1 });
    if (process.platform !== 'win32') {
      expect((await stat(join(cwd, '.kobay', 'credentials.json'))).mode & 0o777).toBe(0o600);
    }
    // Derin dosya: okunur, sürüm 0'da kalır (kobay onu bir sonraki yazışında damgalar).
    expect(await hamOku(cwd, 'tests', `${TEST.id}.json`)).not.toHaveProperty('schemaVersion');
    expect(await dizin?.testOku(TEST.id)).toEqual(TEST);
    expect(await dizin?.onerileriOku()).toEqual([ONERI]);

    const once = await ozetler(cwd);
    await KobayDizini.bul(cwd);
    expect(await ozetler(cwd)).toEqual(once);

    await dizin?.testYaz(TEST);
    expect(await hamOku(cwd, 'tests', `${TEST.id}.json`)).toMatchObject({ schemaVersion: 1 });
  });

  it('şemaya uymayan sürümsüz dosya göç edilmez (hata okumada görünür, dosya aynen kalır)', async () => {
    const cwd = await surumsuzProje();
    const bozuk = json({ baseUrl: 'http://uygulama.test' });
    await writeFile(join(cwd, '.kobay', 'config.json'), bozuk);
    const dizin = await KobayDizini.bul(cwd);
    expect(await readFile(join(cwd, '.kobay', 'config.json'), 'utf8')).toBe(bozuk);
    await expect(dizin?.configOku()).rejects.toBeInstanceOf(SchemaError);
  });

  it('şemanın tanımadığı alanlar göçte korunur (göç ham veriyi yazar)', async () => {
    const cwd = await surumsuzProje();
    await writeFile(join(cwd, '.kobay', 'config.json'), json({
      baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' }, gelecekAlani: { x: 1 },
    }));
    await KobayDizini.bul(cwd);
    expect(await hamOku(cwd, 'config.json')).toEqual({
      schemaVersion: 1, baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' }, gelecekAlani: { x: 1 },
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'yazma izni yoksa göç bellekte yapılır, okuma sürer, dosyalar değişmez (kural 6)',
    async () => {
      const cwd = await surumsuzProje();
      // 0.1 alan adları da göç gerektirsin: harita Türkçe, öneriler dizi kökü.
      await writeFile(join(cwd, '.kobay', 'map.json'), json({
        baseUrl: 'http://uygulama.test', girisYapildi: true, kesifTarihi: '2026-01-01T00:00:00.000Z', sayfalar: [],
      }));
      // Bul'un kurduğu alt dizinler ve .gitignore önceden dursun; böylece salt okunurluk
      // yalnız göçü etkiler.
      await KobayDizini.bul(cwd).catch(() => undefined);
      await writeFile(join(cwd, '.kobay', 'config.json'), json({ baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } }));
      await writeFile(join(cwd, '.kobay', 'plan', 'proposals.json'), json([ONERI]));
      await writeFile(join(cwd, '.kobay', 'map.json'), json({
        baseUrl: 'http://uygulama.test', girisYapildi: true, kesifTarihi: '2026-01-01T00:00:00.000Z', sayfalar: [],
      }));
      const kilitlenecek = [join(cwd, '.kobay'), join(cwd, '.kobay', 'plan')];
      const once = await ozetler(cwd);
      try {
        for (const yol of kilitlenecek) await chmod(yol, 0o555);
        const dizin = await KobayDizini.bul(cwd);
        expect(await dizin?.configOku()).toEqual({ baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } });
        expect(await dizin?.onerileriOku()).toEqual([ONERI]);
        expect(await dizin?.haritaOku()).toMatchObject({ loggedIn: true, pages: [] });
        expect(await ozetler(cwd)).toEqual(once);
      } finally {
        for (const yol of kilitlenecek) await chmod(yol, 0o755);
      }
    },
  );
});

describe('daha yeni sürüm: çıkış 2, dosyaya dokunulmaz', () => {
  it('kök dosya: açılış hiçbir şeye dokunmadan durur (kimlik kurtarması, .gitignore dahil)', async () => {
    const cwd = await surumsuzProje();
    await writeFile(join(cwd, '.kobay', 'map.json'), json({ schemaVersion: 7, yeniBicim: true }));
    const once = await ozetler(cwd);
    await expect(KobayDizini.bul(cwd)).rejects.toBeInstanceOf(SchemaVersionTooNew);
    await expect(KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } }))
      .rejects.toBeInstanceOf(SchemaVersionTooNew);
    expect(await ozetler(cwd)).toEqual(once);
  });

  it('project update yeni sürümlü config\'i "geçersiz, sıfırla" diye değil "yükselt" diye reddeder', async () => {
    const cwd = await surumsuzProje();
    await writeFile(join(cwd, '.kobay', 'config.json'), json({ schemaVersion: 2, baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } }));
    const once = await ozetler(cwd);
    const sonuc = await kobay(cwd, 'project', 'update', '--login-url', 'http://uygulama.test/login');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.zarf.error?.code).toBe('SchemaVersionTooNew');
    expect(sonuc.zarf.error?.message).toContain('.kobay/config.json was written by a newer kobay (schemaVersion 2)');
    expect(sonuc.zarf.error?.message).not.toContain('--force');
    expect(await ozetler(cwd)).toEqual(once);
  });

  it('MCP aynı hata kodunu döndürür (isError, SchemaVersionTooNew)', async () => {
    const cwd = await surumsuzProje();
    await writeFile(join(cwd, '.kobay', 'config.json'), json({ schemaVersion: 999, baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } }));
    const once = await ozetler(cwd);
    const sunucu = mcpSunucusuOlustur({ cwd });
    const istemci = new Client({ name: 'kobay-test', version: '0.1.0' });
    const [sunucuTasima, istemciTasima] = InMemoryTransport.createLinkedPair();
    await Promise.all([sunucu.connect(sunucuTasima), istemci.connect(istemciTasima)]);
    try {
      const sonuc = await istemci.callTool({ name: 'test_list', arguments: {} });
      expect(sonuc.isError).toBe(true);
      const govde = JSON.parse(((sonuc.content as Array<{ text: string }>)[0] ?? { text: 'null' }).text) as {
        error: { code: string; message: string };
      };
      expect(govde.error.code).toBe('SchemaVersionTooNew');
      expect(govde.error.message).toContain('Upgrade kobay');
    } finally {
      await istemci.close();
      await sunucu.close();
    }
    expect(await ozetler(cwd)).toEqual(once);
  });

  it('başka testin yeni sürümlü koşusu bu testin sonucunu düşürmez; kendi yeni sürümlü koşusu çıkış 2', async () => {
    const cwd = await surumsuzProje();
    const dizin = await KobayDizini.bul(cwd);
    await dizin?.testYaz({ ...TEST, id: 't_baska123' });
    await dizin?.kosuSonucuYaz(kosu('r_20260101000000_aaaa'));
    await mkdir(join(cwd, '.kobay', 'runs', 'r_20260101000001_bbbb'), { recursive: true });
    await writeFile(join(cwd, '.kobay', 'runs', 'r_20260101000001_bbbb', 'result.json'),
      json({ ...kosu('r_20260101000001_bbbb', 't_baska123'), schemaVersion: 5 }));
    expect((await dizin?.kosuListele(TEST.id))?.map((k) => k.runId)).toEqual(['r_20260101000000_aaaa']);
    expect((await kobay(cwd, 'test', 'result', TEST.id)).kod).toBe(0);
    const sonuc = await kobay(cwd, 'test', 'result', 't_baska123');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.zarf.error?.code).toBe('SchemaVersionTooNew');
  });

  it('budama yeni sürümlü koşu kaydı görünce hiçbir şey silmez (çıkış 2 için SchemaVersionTooNew)', async () => {
    const cwd = await surumsuzProje();
    const dizin = await KobayDizini.bul(cwd);
    if (dizin === null) throw new Error('proje yok');
    const yeni = 'r_20200101000000_cccc';
    await mkdir(join(cwd, '.kobay', 'runs', yeni), { recursive: true });
    // Silinmiş bir teste ait, çok eski: sürüm 1 olsaydı yaşından silinirdi.
    await writeFile(join(cwd, '.kobay', 'runs', yeni, 'result.json'), json({ ...kosu(yeni, 't_silindi1'), schemaVersion: 3, finishedAt: '2020-01-01T00:00:01.000Z' }));
    const eski = 'r_20200101000001_dddd';
    await dizin.kosuSonucuYaz({ ...kosu(eski, 't_silindi1'), finishedAt: '2020-01-01T00:00:01.000Z' });
    // Sürüm 1 eski koşu kendi başına yaşından silinirdi; yeni sürümlü kayıt varken budama durur.
    const once = await ozetler(cwd);
    await expect(depoyuBuda(dizin)).rejects.toBeInstanceOf(SchemaVersionTooNew);
    expect(await ozetler(cwd)).toEqual(once);
  });
});
