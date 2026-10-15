import { PassThrough, Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/kesif/index.js', async (asilModul) => {
  const asil = await asilModul<typeof import('../../src/kesif/index.js')>();
  return {
    ...asil,
    // Gerçek tarayıcı açılmasın; tohum doğrulaması gerçek modülden gelir.
    kesfetAyrintili: vi.fn(async (_secenekler: unknown) => ({
      harita: { baseUrl: 'http://127.0.0.1:3000', loggedIn: false, pages: [], exploredAt: '2026-10-13T00:00:00.000Z' },
    })),
  };
});

vi.mock('../../src/kos/index.js', () => ({
  hedefAyaktaMi: vi.fn(async () => true),
  kostur: vi.fn(async () => { throw new Error('Bu testte koşu olmamalı'); }),
}));

import { main } from '../../src/cli/index.js';
import { kesfetAyrintili } from '../../src/kesif/index.js';
import { hedefAyaktaMi } from '../../src/kos/index.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

const APP = 'http://127.0.0.1:3000';

async function kobay(cwd: string, ...argumanlar: string[]): Promise<{ kod: number; cikti: string; hata: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let cikti = '';
  let hata = '';
  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  stdout.on('data', (parca: string) => { cikti += parca; });
  stderr.on('data', (parca: string) => { hata += parca; });
  const kod = await main(['node', 'kobay', '--cwd', cwd, ...argumanlar], { input: Readable.from([]), stdout, stderr });
  return { kod, cikti, hata };
}

async function proje(): Promise<string> {
  const cwd = await geciciDizinAc('kobay-explore-bayrak-');
  const sonuc = await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte');
  expect(sonuc.kod).toBe(0);
  return cwd;
}

beforeEach(() => {
  vi.mocked(kesfetAyrintili).mockClear();
  vi.mocked(hedefAyaktaMi).mockClear();
});

describe('kobay explore bayrakları', () => {
  it('varsayılan: sitemap açık, tohum/tavan/derinlik geçilmez (kesif varsayılanı 40/3)', async () => {
    const cwd = await proje();
    expect((await kobay(cwd, 'explore')).kod).toBe(0);
    const secenekler = vi.mocked(kesfetAyrintili).mock.calls[0]?.[0];
    expect(secenekler).toMatchObject({ baseUrl: APP, siteHaritasi: true });
    expect(secenekler).not.toHaveProperty('tohumlar');
    expect(secenekler).not.toHaveProperty('maxSayfa');
    expect(secenekler).not.toHaveProperty('derinlik');
  });

  it('--seed tekrarlanır, --no-sitemap, --max-pages, --depth keşfe geçer', async () => {
    const cwd = await proje();
    const sonuc = await kobay(cwd, 'explore', '--seed', `${APP}/a`, '--seed', `${APP}/b?x=1#y`, '--no-sitemap',
      '--max-pages', '60', '--depth', '0');
    expect(sonuc.kod).toBe(0);
    expect(kesfetAyrintili).toHaveBeenCalledWith(expect.objectContaining({
      tohumlar: [`${APP}/a`, `${APP}/b`], siteHaritasi: false, maxSayfa: 60, derinlik: 0,
    }));
  });

  it('başka kökenli --seed exit 2 (kullanım hatası), hedefe istek atılmaz, keşif başlamaz', async () => {
    const cwd = await proje();
    for (const tohum of ['https://baska.example/x', 'http://127.0.0.1:3001/x', 'ftp://127.0.0.1:3000/x']) {
      const sonuc = await kobay(cwd, 'explore', '--seed', `${APP}/iyi`, '--seed', tohum);
      expect(sonuc.kod).toBe(2);
      expect(sonuc.hata).toMatch(/same origin|valid http/);
    }
    expect(kesfetAyrintili).not.toHaveBeenCalled();
    expect(hedefAyaktaMi).not.toHaveBeenCalled();
  });

  it.each([['--max-pages', '0'], ['--max-pages', '-1'], ['--depth', 'x'], ['--max-pages', '1.5']])(
    'geçersiz %s %s exit 2',
    async (bayrak, deger) => {
      const cwd = await proje();
      expect((await kobay(cwd, 'explore', bayrak, deger)).kod).toBe(2);
      expect(kesfetAyrintili).not.toHaveBeenCalled();
    },
  );
});

describe('MCP explore girdileri', () => {
  async function bagliMcp(cwd: string): Promise<{ istemci: Client; kapat: () => Promise<void> }> {
    const sunucu = mcpSunucusuOlustur({ cwd });
    const istemci = new Client({ name: 'kobay-test', version: '0.1.0' });
    const [sunucuTasima, istemciTasima] = InMemoryTransport.createLinkedPair();
    await Promise.all([sunucu.connect(sunucuTasima), istemci.connect(istemciTasima)]);
    return { istemci, kapat: async () => { await istemci.close(); await sunucu.close(); } };
  }

  it('şemada seeds, maxPages, depth, sitemap var; sessionFile yok', async () => {
    const baglanti = await bagliMcp(await proje());
    try {
      const { tools } = await baglanti.istemci.listTools();
      const ozellikler = Object.keys(tools.find((arac) => arac.name === 'explore')?.inputSchema.properties ?? {});
      expect(ozellikler.sort()).toEqual(['depth', 'maxPages', 'projectDir', 'seeds', 'sitemap']);
    } finally {
      await baglanti.kapat();
    }
  });

  it.each([
    ['maxPages 0', { maxPages: 0 }], ['maxPages 10000', { maxPages: 10_000 }], ['maxPages 1.5', { maxPages: 1.5 }],
    ['depth -1', { depth: -1 }], ['depth 10000', { depth: 10_000 }], ['depth 1.5', { depth: 1.5 }],
    ['51 seeds', { seeds: Array.from({ length: 51 }, (_d, i) => `${APP}/s${i}`) }], ['empty seed', { seeds: [''] }],
  ])('geçersiz girdi araç hatası verir, keşif başlamaz: %s', async (_ad, girdi) => {
    const baglanti = await bagliMcp(await proje());
    try {
      const sonuc = await baglanti.istemci.callTool({ name: 'explore', arguments: girdi });
      expect(sonuc.isError).toBe(true);
      expect(kesfetAyrintili).not.toHaveBeenCalled();
    } finally {
      await baglanti.kapat();
    }
  });

  it('sınırdaki geçerli değerler kabul edilir: maxPages 1 ve 9999, depth 0 ve 9999, 50 tohum', async () => {
    const baglanti = await bagliMcp(await proje());
    try {
      for (const girdi of [{ maxPages: 1, depth: 0 }, { maxPages: 9999, depth: 9999 },
        { seeds: Array.from({ length: 50 }, (_d, i) => `${APP}/s${i}`) }]) {
        expect((await baglanti.istemci.callTool({ name: 'explore', arguments: girdi })).isError).not.toBe(true);
      }
      expect(kesfetAyrintili).toHaveBeenCalledTimes(3);
    } finally {
      await baglanti.kapat();
    }
  });

  it('girdiler keşfe geçer; başka kökenli tohum araç hatası verir', async () => {
    const baglanti = await bagliMcp(await proje());
    try {
      const iyi = await baglanti.istemci.callTool({
        name: 'explore', arguments: { seeds: [`${APP}/a`], sitemap: false, maxPages: 10, depth: 1 },
      });
      expect(iyi.isError).not.toBe(true);
      expect(kesfetAyrintili).toHaveBeenCalledWith(expect.objectContaining({
        tohumlar: [`${APP}/a`], siteHaritasi: false, maxSayfa: 10, derinlik: 1,
      }));
      vi.mocked(kesfetAyrintili).mockClear();
      const kotu = await baglanti.istemci.callTool({ name: 'explore', arguments: { seeds: ['https://baska.example/'] } });
      expect(kotu.isError).toBe(true);
      expect((kotu.content as [{ text: string }])[0].text).toContain('same origin');
      expect(kesfetAyrintili).not.toHaveBeenCalled();
    } finally {
      await baglanti.kapat();
    }
  });
});
