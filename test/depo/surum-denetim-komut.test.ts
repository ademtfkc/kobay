import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Harita, Sayfa, TestKaydi } from '../../src/depo/index.js';

/**
 * 0.9.0 D1 karşıt denetim tur 2: komut düzeyinde daha yeni sürüm reddi. `test refresh`
 * paketi yan etkiden önce okur; `plan accept` hedef test kayıtlarını yazmadan önce topluca
 * denetler. Tarayıcı ve koşu sahte; beyin sahte adaptör.
 */

const sahteler = vi.hoisted(() => ({ kimlikler: [] as string[] }));

vi.mock('../../src/kesif/index.js', async (asilModul) => ({
  ...(await asilModul<typeof import('../../src/kesif/index.js')>()),
  sayfayiYenile: vi.fn(async ({ url }: { url: string }) => ({
    url, title: 'Cariler', headings: ['Cariler'], links: [], forms: [], buttons: ['Yeni'], menu: [],
  } satisfies Sayfa)),
}));

vi.mock('../../src/kos/index.js', () => ({
  hedefAyaktaMi: vi.fn(async () => true),
  kostur: vi.fn(async () => { throw new Error('Bu testte koşu olmamalı'); }),
}));

vi.mock('../../src/plan/index.js', async (asilModul) => {
  const asil = await asilModul<typeof import('../../src/plan/index.js')>();
  return {
    ...asil,
    oneriyiTesteCevir: vi.fn((oneri: Parameters<typeof asil.oneriyiTesteCevir>[0]) => {
      const kayit = asil.oneriyiTesteCevir(oneri);
      const id = sahteler.kimlikler.shift();
      return id === undefined ? kayit : { ...kayit, id };
    }),
  };
});

import { planAccept, testRefresh } from '../../src/cli/komutlar/index.js';
import { KobayDizini, yazAtomik } from '../../src/depo/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

const json = (veri: unknown): string => `${JSON.stringify(veri, null, 2)}\n`;

const TEST: TestKaydi = {
  id: 't_abc12345', name: 'Cariler', type: 'frontend', createdFrom: 'plan', status: 'failed',
  planSteps: [{ type: 'action', description: 'Cariler sayfasını aç' }], priority: 'p1', url: '/cariler',
  codeVersion: 1, createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
};

const HARITA: Harita = {
  baseUrl: 'http://uygulama.test', loggedIn: false, exploredAt: '2026-09-17T00:00:00.000Z',
  pages: [{ url: 'http://uygulama.test/cariler', title: 'Cariler', headings: ['Cariler'], links: [], forms: [], buttons: [], menu: [] }],
};

async function agacOzeti(kok: string): Promise<Record<string, string>> {
  const sonuc: Record<string, string> = {};
  const gez = async (dizin: string): Promise<void> => {
    for (const girdi of await readdir(dizin, { withFileTypes: true })) {
      const yol = join(dizin, girdi.name);
      if (girdi.isDirectory()) {
        sonuc[relative(kok, yol)] = 'dizin';
        await gez(yol);
      } else {
        const ozet = createHash('sha256').update(await readFile(yol)).digest('hex');
        sonuc[relative(kok, yol)] = process.platform === 'win32' ? ozet : `${ozet}:${(await stat(yol)).ino}`;
      }
    }
  };
  await gez(kok);
  return sonuc;
}

afterEach(() => {
  delete process.env.KOBAY_SAHTE_YANIT_DIZINI;
  sahteler.kimlikler = [];
});

describe('test refresh: daha yeni sürümlü hata paketi', () => {
  it('çıkış 2; harita ve test yazılmaz', async () => {
    const cwd = await geciciDizinAc('kobay-refresh-surum-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } });
    await dizin.haritaYaz(HARITA);
    await dizin.testYaz(TEST);
    await mkdir(join(cwd, '.kobay', 'failure', TEST.id), { recursive: true });
    await writeFile(join(cwd, '.kobay', 'failure', TEST.id, 'failure.json'), json({ schemaVersion: 2, futureField: 'x' }));
    const yanitlar = await geciciDizinAc('kobay-refresh-surum-yanit-');
    await yazAtomik(join(yanitlar, `plan-refresh-${TEST.id}.json`), JSON.stringify({
      name: 'Cariler (yeni)', steps: [{ type: 'action', description: 'Cariler sayfasını aç' }],
    }));
    process.env.KOBAY_SAHTE_YANIT_DIZINI = yanitlar;
    const once = await agacOzeti(cwd);

    const sonuc = await testRefresh({ cwd, id: TEST.id, run: false });
    expect(sonuc.exitCode, JSON.stringify(sonuc.json)).toBe(2);
    expect((sonuc.json as { error: { code: string } }).error.code).toBe('SchemaVersionTooNew');
    expect(await agacOzeti(cwd)).toEqual(once);
  });
});

describe('test refresh: hata paketinin meta.json dosyası daha yeni sürümlü', () => {
  it('çıkış 2; beyin çağrılmaz (log yok), harita ve test yazılmaz', async () => {
    const cwd = await geciciDizinAc('kobay-refresh-meta-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } });
    await dizin.haritaYaz(HARITA);
    await dizin.testYaz(TEST);
    const runId = 'r_20260101000000_aaaa';
    await dizin.hataPaketiYaz({
      snapshotId: `${runId}-x`, testId: TEST.id, runId,
      result: {
        testId: TEST.id, runId, status: 'failed', verdict: 'failed', codeVersion: 1,
        startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', failedStepIndex: 0,
      },
      steps: [{ stepIndex: 0, description: 'Cariler sayfasını aç', status: 'failed', durationMs: 1 }],
      code: '// kod',
      failure: {
        rootCauseHypothesis: 'x', failureKind: 'product_changed',
        recommendedFixTarget: { kind: 'code', reference: 'r', rationale: 'r' }, evidence: [],
      },
    }, []);
    const metaYolu = join(cwd, '.kobay', 'failure', TEST.id, 'meta.json');
    const meta = JSON.parse(await readFile(metaYolu, 'utf8')) as Record<string, unknown>;
    await writeFile(metaYolu, json({ ...meta, schemaVersion: 999 }));
    const yanitlar = await geciciDizinAc('kobay-refresh-meta-yanit-');
    await yazAtomik(join(yanitlar, `plan-refresh-${TEST.id}.json`), JSON.stringify({
      name: 'Cariler (yeni)', steps: [{ type: 'action', description: 'Cariler sayfasını aç' }],
    }));
    process.env.KOBAY_SAHTE_YANIT_DIZINI = yanitlar;
    const once = await agacOzeti(cwd);

    const sonuc = await testRefresh({ cwd, id: TEST.id, run: false });
    expect(sonuc.exitCode, JSON.stringify(sonuc.json)).toBe(2);
    expect((sonuc.json as { error: { code: string; message: string } }).error.code).toBe('SchemaVersionTooNew');
    expect((sonuc.json as { error: { message: string } }).error.message).toContain(`.kobay/failure/${TEST.id}/meta.json`);
    // Ağaç özeti logs/ dahil: beyin çağrılsaydı brain-plan-refresh-… günlüğü düşerdi.
    expect(await agacOzeti(cwd)).toEqual(once);
  });
});

describe('plan accept: hedef test kayıtlarından biri daha yeni sürümlü', () => {
  it('hiçbir test yazılmaz, öneriler değişmez', async () => {
    const cwd = await geciciDizinAc('kobay-accept-surum-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } });
    const oneri = (proposalId: string): Parameters<KobayDizini['onerileriYaz']>[0][number] => ({
      proposalId, title: proposalId, description: 'd', priority: 'p1', category: 'c', feature: 'f',
      type: 'frontend', url: '/cariler', steps: [{ type: 'action', description: 'Aç' }],
    });
    await dizin.onerileriYaz([oneri('p_aaaaaa'), oneri('p_bbbbbb')]);
    // İkinci önerinin test kimliği, daha yeni bir kobay'ın yazdığı kayıtla çakışıyor.
    await writeFile(join(cwd, '.kobay', 'tests', 't_bbbbbbbb.json'), json({ schemaVersion: 2, futureField: 'x' }));
    sahteler.kimlikler = ['t_aaaaaaaa', 't_bbbbbbbb'];
    const once = await agacOzeti(cwd);

    const sonuc = await planAccept({ cwd, all: true });
    expect(sonuc.exitCode, JSON.stringify(sonuc.json)).toBe(2);
    expect((sonuc.json as { error: { code: string } }).error.code).toBe('SchemaVersionTooNew');
    expect(await agacOzeti(cwd)).toEqual(once);
  });
});
