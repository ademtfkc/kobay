import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { KobayDizini } from '../../src/depo/index.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

async function bagliMcp(cwd: string): Promise<{ istemci: Client; kapat: () => Promise<void> }> {
  const sunucu = mcpSunucusuOlustur({ cwd });
  const istemci = new Client({ name: 'kobay-test', version: '0.1.0' });
  const [sunucuTasima, istemciTasima] = InMemoryTransport.createLinkedPair();
  await Promise.all([sunucu.connect(sunucuTasima), istemci.connect(istemciTasima)]);
  return { istemci, kapat: async () => { await istemci.close(); await sunucu.close(); } };
}

interface Yanit { isError?: boolean; content: Array<{ type: string; text: string }>; warnings?: unknown }

async function proje(): Promise<{ cwd: string; dizin: KobayDizini }> {
  const cwd = await geciciDizinAc('kobay-mcp-bilinmeyen-');
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://localhost:3000', brain: { adaptor: 'sahte' } });
  return { cwd, dizin };
}

describe('MCP bilinmeyen alan (UNKNOWN_FIELD)', () => {
  it('project_update bilinmeyen alanı reddetmez, warnings ile bildirir; bilinen alan uygulanır', async () => {
    const { cwd, dizin } = await proje();
    const baglanti = await bagliMcp(cwd);
    try {
      const yanit = await baglanti.istemci.callTool({
        name: 'project_update', arguments: { loginUrl: 'http://localhost:3000/giris', bogus: 1 },
      }) as Yanit;
      expect(yanit.isError).not.toBe(true);
      const beklenen = [{ code: 'UNKNOWN_FIELD', message: 'Unknown field "bogus" was ignored', field: 'bogus' }];
      expect(yanit.warnings).toEqual(beklenen);
      // İlk blok komutun gövdesi olarak kalır; ikinci blok ajan modelinin göreceği uyarı listesi.
      expect(JSON.parse(yanit.content[0]?.text ?? '')).toMatchObject({ config: { loginUrl: 'http://localhost:3000/giris' } });
      expect(JSON.parse(yanit.content[1]?.text ?? '')).toEqual({ warnings: beklenen });
      expect((await dizin.configOku()).loginUrl).toBe('http://localhost:3000/giris');
    } finally {
      await baglanti.kapat();
    }
  });

  it('bilinmeyen alan yokken warnings alanı ve ikinci blok yok', async () => {
    const { cwd } = await proje();
    const baglanti = await bagliMcp(cwd);
    try {
      const yanit = await baglanti.istemci.callTool({ name: 'project_get', arguments: {} }) as Yanit;
      expect(yanit.isError).not.toBe(true);
      expect('warnings' in yanit).toBe(false);
      expect(yanit.content).toHaveLength(1);
    } finally {
      await baglanti.kapat();
    }
  });

  it('ortak kayıttan geçen öteki araçlar da bildirir; araç hatasında da uyarı korunur', async () => {
    const { cwd } = await proje();
    const baglanti = await bagliMcp(cwd);
    try {
      const liste = await baglanti.istemci.callTool({ name: 'test_list', arguments: { ids: ['x'], verbose: true } }) as Yanit;
      expect(liste.isError).not.toBe(true);
      expect((liste.warnings as Array<{ field: string }>).map((u) => u.field)).toEqual(['ids', 'verbose']);

      const hata = await baglanti.istemci.callTool({ name: 'test_get', arguments: { id: 't_yok00000', typo: 'x' } }) as Yanit;
      expect(hata.isError).toBe(true);
      expect(hata.warnings).toEqual([{ code: 'UNKNOWN_FIELD', message: 'Unknown field "typo" was ignored', field: 'typo' }]);
    } finally {
      await baglanti.kapat();
    }
  });

  it('çok sayıda ve çok uzun bilinmeyen alan yanıtı büyütmez: liste sınırlı, kalanı tek özet', async () => {
    const { cwd } = await proje();
    const baglanti = await bagliMcp(cwd);
    try {
      const girdi: Record<string, number> = { [`u${'x'.repeat(100_000)}`]: 0 };
      for (let sira = 0; sira < 100_000; sira += 1) girdi[`x${sira}`] = 0;
      const yanit = await baglanti.istemci.callTool({ name: 'test_list', arguments: girdi }) as Yanit;
      expect(yanit.isError).not.toBe(true);
      const uyarilar = yanit.warnings as Array<{ code: string; message: string; field?: string }>;
      expect(uyarilar).toHaveLength(11);
      expect(uyarilar.every((u) => u.code === 'UNKNOWN_FIELD')).toBe(true);
      expect(uyarilar[0]?.field).toHaveLength(64);
      expect(uyarilar[0]?.field?.endsWith('…')).toBe(true);
      expect(uyarilar[10]).toEqual({ code: 'UNKNOWN_FIELD', message: 'and 99991 more unknown fields were ignored' });
      // İstek ~1 MB; yanıtın tamamı sabit ve küçük bir üst sınırın altında kalır.
      expect(JSON.stringify(yanit).length).toBeLessThan(8_000);
    } finally {
      await baglanti.kapat();
    }
  });

  it('project_update üzerinden authOrigins verilemez: alan yok sayılır, config ve kimlik kilidi değişmez', async () => {
    const { cwd, dizin } = await proje();
    const once = await readFile(dizin.yol('config.json'), 'utf8');
    const baglanti = await bagliMcp(cwd);
    try {
      const yanit = await baglanti.istemci.callTool({
        name: 'project_update',
        arguments: { brain: 'codex', authOrigins: ['https://evil.example'], clearAuthOrigins: true },
      }) as Yanit;
      expect(yanit.isError).not.toBe(true);
      expect((yanit.warnings as Array<{ field: string }>).map((u) => u.field)).toEqual(['authOrigins', 'clearAuthOrigins']);
      const config = await dizin.configOku();
      expect(config.authOrigins).toBeUndefined();
      expect(config.brain.adaptor).toBe('codex');
      expect(once).not.toContain('evil');
      expect(await readFile(dizin.yol('config.json'), 'utf8')).not.toContain('evil');
    } finally {
      await baglanti.kapat();
    }
  });

  it('strict araçlar (project_create, prune) bilinmeyen alanı yine reddeder', async () => {
    const { cwd } = await proje();
    const baglanti = await bagliMcp(cwd);
    try {
      const olustur = await baglanti.istemci.callTool({
        name: 'project_create', arguments: { url: 'http://localhost:3000', force: true, authOrigins: ['https://evil.example'] },
      }) as Yanit;
      expect(olustur.isError).toBe(true);
      const budama = await baglanti.istemci.callTool({ name: 'prune', arguments: { confim: true } }) as Yanit;
      expect(budama.isError).toBe(true);
    } finally {
      await baglanti.kapat();
    }
  });
});
