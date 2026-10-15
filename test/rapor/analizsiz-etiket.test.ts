import { describe, expect, it } from 'vitest';
import { ANALIZ_ATLANDI } from '../../src/analiz/index.js';
import { kosuSatiriMetni } from '../../src/cli/komutlar/test.js';
import { raporHtml, type RaporTesti } from '../../src/rapor/html.js';
import { failureKindEtiketi } from '../../src/rapor/istem.js';
import { duzeltmeIstemi, hepsiniDuzeltIstemi, metniTemizle, ozetMarkdown } from '../../src/rapor/index.js';

const temizle = (metin: string): string => metniTemizle(metin, []);
const baglam = { baseUrl: 'http://localhost:3000', temizle };

function analizsiz(ek: Partial<RaporTesti> = {}): RaporTesti {
  return {
    id: 't_aaaaaa01',
    name: 'Save a record',
    priority: 'p1',
    verdict: 'failed',
    runId: 'r_20261005100000_aaaa',
    failureKind: 'unknown',
    errorMessage: 'expect(locator).toBeVisible() failed',
    steps: [{ index: 0, description: 'Open the page', type: 'action', status: 'failed' }],
    failure: {
      rootCauseHypothesis: ANALIZ_ATLANDI,
      recommendedFixTarget: { kind: 'unknown', reference: ANALIZ_ATLANDI, rationale: ANALIZ_ATLANDI },
      evidence: [],
    },
    ...ek,
  };
}

describe('--no-analysis: human surfaces say "not analysed", machine value stays unknown', () => {
  it('the helper maps only the skipped-analysis hypothesis', () => {
    expect(failureKindEtiketi('unknown', ANALIZ_ATLANDI)).toBe('not analysed');
    expect(failureKindEtiketi('unknown', 'The model could not tell.')).toBe('unknown');
    expect(failureKindEtiketi('env', undefined)).toBe('env');
    expect(failureKindEtiketi(undefined, undefined)).toBeUndefined();
  });

  it('CLI run line', () => {
    const satir = { id: 't_aaaaaa01', verdict: 'failed', failureKind: 'unknown' };
    expect(kosuSatiriMetni(satir, undefined, ANALIZ_ATLANDI)).toContain('failed t_aaaaaa01 — not analysed');
    expect(kosuSatiriMetni(satir)).toContain('failed t_aaaaaa01 — unknown');
    expect(satir.failureKind).toBe('unknown');
  });

  it('summary table cell', () => {
    const t = analizsiz();
    const md = ozetMarkdown({
      testler: [t],
      counts: { passed: 0, failed: 1, blocked: 0, inconclusive: 0, notRun: 0 },
      surum: '0.5.0',
      fixPrompts: [],
      temizle,
    });
    expect(md).toContain('| t\\_aaaaaa01 | Save a record | failed | not analysed |');
    expect(md).not.toContain('| unknown |');
  });

  it('HTML test detail', () => {
    const html = raporHtml({
      baseUrl: 'http://localhost:3000',
      generatedAt: '2026-10-10T00:00:00.000Z',
      version: '0.5.0',
      tests: [analizsiz()],
      counts: { passed: 0, failed: 1, blocked: 0, inconclusive: 0, notRun: 0 },
    });
    expect(html).toContain('<dt>Failure kind</dt><dd><code>not analysed</code></dd>');
    expect(html).not.toContain('<dd><code>unknown</code></dd>');
  });

  it('fix prompt sentence', () => {
    const istem = duzeltmeIstemi(analizsiz(), baglam);
    expect(istem).toContain('so the failure kind is `not analysed`.');
    expect(istem).not.toContain('is `unknown`');
  });

  it('bulk fix prompt labels the skipped-analysis test, keeps the real kind of the other', () => {
    const analizli = analizsiz({
      id: 't_aaaaaa02',
      failureKind: 'test_bug',
      failure: {
        rootCauseHypothesis: 'The selector is stale.',
        recommendedFixTarget: { kind: 'test', reference: '.kobay/tests/t_aaaaaa02.spec.ts', rationale: 'stale selector' },
        evidence: [],
      },
    });
    const istem = hepsiniDuzeltIstemi([analizsiz(), analizli], baglam) ?? '';
    expect(istem).toContain('t_aaaaaa01: failed, failure kind `not analysed`');
    expect(istem).toContain('t_aaaaaa02: failed, failure kind `test_bug`');
    expect(istem).not.toContain('`unknown`');
  });
});
