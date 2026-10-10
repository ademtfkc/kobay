import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Beyin } from '../../src/beyin/index.js';
import { KobayDizini, yazAtomik, type KosuSonucu, type TestKaydi } from '../../src/depo/index.js';
import { hataAnalizEt, yerelOnSiniflama } from '../../src/analiz/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

const KIMLIK_HATASI = 'kobay: this step needs the real credentials; the session is already authenticated';

describe('yerelOnSiniflama (denetim N7)', () => {
  it('kobay: önekli bilinçli düşüşü test_bug ve test tarafı düzeltme olarak sınıflar', () => {
    for (const metin of [KIMLIK_HATASI, `Error: ${KIMLIK_HATASI}\n    at tests/t.spec.ts:4:11`, `  ${KIMLIK_HATASI}`]) {
      const sonuc = yerelOnSiniflama(metin, 2);
      expect(sonuc, metin).not.toBeNull();
      expect(sonuc?.failureKind).toBe('test_bug');
      expect(sonuc?.rootCauseHypothesis).toContain('declared an unsupported step');
      expect(sonuc?.recommendedFixTarget.rationale).toContain('regenerate the plan without real-credential steps');
      expect(sonuc?.recommendedFixTarget.reference).toContain('step 2');
      expect(sonuc?.recommendedFixTarget.reference).not.toContain('\n');
    }
  });

  it('öneki başta olmayan ya da hiç olmayan hatayı beyne bırakır', () => {
    for (const metin of [
      'Timed out waiting for getByRole("heading")', 'expect(received).toBe(expected)\nReceived: "kobay: x"',
      'Error: page.goto failed; kobay: nothing', 'kobaya: benzer ama değil',
    ]) expect(yerelOnSiniflama(metin, 0), metin).toBeNull();
  });
});

describe('hataAnalizEt + yerel ön-sınıflama', () => {
  it('kobay: düşüşünde beyin çağrılmaz, paket test_bug taşır', async () => {
    const runId = 'r_20260928010101_abcd';
    const test: TestKaydi = {
      id: 't_yerel123', name: 'Log in', type: 'frontend', createdFrom: 'plan', status: 'failed',
      planSteps: [{ type: 'action', description: 'Enter the password' }], priority: 'p0', url: '/login',
      codeVersion: 1, createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
    };
    const sonuc: KosuSonucu = {
      testId: test.id, runId, status: 'failed', verdict: 'failed', startedAt: test.createdAt,
      finishedAt: test.updatedAt, codeVersion: 1, failedStepIndex: 0, errorMessage: `Error: ${KIMLIK_HATASI}`,
    };
    const projeKoku = await geciciDizinAc('kobay-yerel-');
    const dizin = await KobayDizini.ac(projeKoku, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    const kosuDizini = await dizin.kosuDizini(runId);
    await Promise.all([
      dizin.testYaz(test),
      dizin.kodYaz(test.id, `test('t', async () => { throw new Error('${KIMLIK_HATASI}'); });`),
      yazAtomik(join(kosuDizini, 'step-0.png'), 'sahte png'),
    ]);
    let cagri = 0;
    const beyin: Beyin = {
      ad: 'cagrilmamali',
      sor: () => { cagri += 1; return Promise.reject(new Error('brain must not be called')); },
    };

    const paket = await hataAnalizEt(beyin, dizin, test, sonuc, [
      { stepIndex: 0, description: 'Enter the password', status: 'failed', errorMessage: `Error: ${KIMLIK_HATASI}`, durationMs: 5 },
    ]);

    expect(cagri).toBe(0);
    expect(paket.failure.failureKind).toBe('test_bug');
    expect(paket.result.failureKind).toBe('test_bug');
    expect(paket.failure.recommendedFixTarget.rationale).not.toContain('search the product code');
    expect(paket.failure.evidence.map((kanit) => kanit.path)).toEqual(['step-0.png']);
  });
});
