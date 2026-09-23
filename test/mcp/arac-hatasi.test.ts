import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sahteler = vi.hoisted(() => ({
  verdict: 'failed' as 'passed' | 'failed' | 'blocked' | 'inconclusive',
}));

vi.mock('../../src/kos/index.js', () => ({
  hedefAyaktaMi: vi.fn(async () => true),
  kostur: vi.fn(async (_dizin: unknown, test: { id: string; codeVersion: number }) => ({
    sonuc: {
      testId: test.id,
      runId: 'r_20260917010101_abcd',
      status: sahteler.verdict === 'inconclusive' ? 'unknown' : sahteler.verdict,
      verdict: sahteler.verdict,
      startedAt: '2026-09-17T00:00:00.000Z',
      finishedAt: '2026-09-17T00:00:01.000Z',
      codeVersion: test.codeVersion,
      ...(sahteler.verdict === 'failed' ? { failedStepIndex: 0, errorMessage: 'Başlık bulunamadı' } : {}),
      ...(sahteler.verdict === 'inconclusive' ? { errorMessage: 'Playwright başlatılamadı' } : {}),
    },
    adimlar: sahteler.verdict === 'failed'
      ? [{ stepIndex: 0, description: 'Ana sayfayı aç', status: 'failed', durationMs: 10, errorMessage: 'Başlık bulunamadı' }]
      : [],
  })),
}));

import { KobayDizini, yazAtomik, type TestKaydi } from '../../src/depo/index.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';

const TEST_KAYDI: TestKaydi = {
  id: 't_abc12345', name: 'Hazır test', type: 'frontend', createdFrom: 'cli', status: 'ready',
  planSteps: [{ type: 'action', description: 'Ana sayfayı aç' }], priority: 'p1', codeVersion: 1,
  createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
};

async function bagliMcp(cwd: string): Promise<{ istemci: Client; kapat: () => Promise<void> }> {
  const sunucu = mcpSunucusuOlustur({ cwd });
  const istemci = new Client({ name: 'kobay-test', version: '0.1.0' });
  const [sunucuTasima, istemciTasima] = InMemoryTransport.createLinkedPair();
  await Promise.all([sunucu.connect(sunucuTasima), istemci.connect(istemciTasima)]);
  return {
    istemci,
    kapat: async () => {
      await istemci.close();
      await sunucu.close();
    },
  };
}

/** Kodu hazır, düşecek bir testi olan proje. */
async function hazirProje(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'kobay-mcp-hata-'));
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
  await dizin.testYaz(TEST_KAYDI);
  await dizin.kodYaz(TEST_KAYDI.id, '// hazır');
  const yanitlar = await mkdtemp(join(tmpdir(), 'kobay-mcp-yanit-'));
  await yazAtomik(join(yanitlar, `analiz-${TEST_KAYDI.id}.json`), JSON.stringify({
    rootCauseHypothesis: 'Başlık değişmiş', failureKind: 'product_bug',
    recommendedFixTarget: { kind: 'code', reference: 'ana sayfa', rationale: 'Beklenen başlık yok' }, evidence: [],
  }));
  process.env.KOBAY_SAHTE_YANIT_DIZINI = yanitlar;
  return cwd;
}

function govde(sonuc: { content: unknown }): unknown {
  return JSON.parse(((sonuc.content as Array<{ text: string }>)[0] ?? { text: 'null' }).text);
}

afterEach(() => {
  sahteler.verdict = 'failed';
  delete process.env.KOBAY_SAHTE_YANIT_DIZINI;
});

describe('MCP isError yalnız gerçek araç hatalarında', () => {
  it('düşen test (exit 1) isError taşımaz, verdict gövdede gelir', async () => {
    const baglanti = await bagliMcp(await hazirProje());
    try {
      for (const arac of ['test_run', 'test_rerun']) {
        const sonuc = await baglanti.istemci.callTool({
          name: arac,
          arguments: arac === 'test_run' ? { ids: [TEST_KAYDI.id] } : { id: TEST_KAYDI.id },
        });
        expect(sonuc.isError, arac).toBeUndefined();
        expect(govde(sonuc), arac).toEqual([expect.objectContaining({
          id: TEST_KAYDI.id, verdict: 'failed', failureKind: 'product_bug',
        })]);
      }
    } finally {
      await baglanti.kapat();
    }
  });

  it('geçen test isError taşımaz', async () => {
    sahteler.verdict = 'passed';
    const baglanti = await bagliMcp(await hazirProje());
    try {
      const sonuc = await baglanti.istemci.callTool({ name: 'test_run', arguments: { ids: [TEST_KAYDI.id] } });
      expect(sonuc.isError).toBeUndefined();
      expect(govde(sonuc)).toEqual([expect.objectContaining({ verdict: 'passed' })]);
    } finally {
      await baglanti.kapat();
    }
  });

  it('hedef kapalı (3) ve motor hatası (4) araç hatası sayılır', async () => {
    for (const verdict of ['blocked', 'inconclusive'] as const) {
      sahteler.verdict = verdict;
      const baglanti = await bagliMcp(await hazirProje());
      try {
        const sonuc = await baglanti.istemci.callTool({ name: 'test_run', arguments: { ids: [TEST_KAYDI.id] } });
        expect(sonuc.isError, verdict).toBe(true);
      } finally {
        await baglanti.kapat();
      }
    }
  });

  it('kullanım hatası (2) araç hatası sayılır', async () => {
    const baglanti = await bagliMcp(await hazirProje());
    try {
      const sonuc = await baglanti.istemci.callTool({ name: 'test_run', arguments: { ids: ['t_yok12345'] } });
      expect(sonuc.isError).toBe(true);
      expect(JSON.stringify(govde(sonuc))).toContain('Test bulunamadı');
    } finally {
      await baglanti.kapat();
    }
  });
});
