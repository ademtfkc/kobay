import { describe, expect, it } from 'vitest';

import { raporHtml, type RaporTesti, type RaporVerisi } from '../../src/rapor/html.js';
import { dikkatCumlesi } from '../../src/rapor/ozet.js';

function veri(testler: RaporTesti[]): RaporVerisi {
  const say = (v: RaporTesti['verdict']): number => testler.filter((t) => t.verdict === v).length;
  return {
    baseUrl: 'http://localhost:3000',
    generatedAt: '2026-10-10T00:00:00.000Z',
    version: '0.3.0',
    tests: testler,
    counts: {
      passed: say('passed'), failed: say('failed'), blocked: say('blocked'),
      inconclusive: say('inconclusive'), notRun: say('not_run'),
    },
  };
}

function test_(no: number, ek: Partial<RaporTesti> = {}): RaporTesti {
  return {
    id: `t_aaaaaa0${no}`, name: `Save record ${no}`, priority: 'p1', verdict: 'blocked',
    runId: `r_20261010000000_000${no}`, steps: [{ index: 0, description: 'Open the page' }], ...ek,
  };
}

describe('raporHtml', () => {
  it('dikkat cümlesinde fiil dikkat sayısına, isim toplam sayıya uyar', () => {
    expect(dikkatCumlesi(1, 1)).toBe('1 of 1 test needs attention');
    expect(dikkatCumlesi(1, 3)).toBe('1 of 3 tests needs attention');
    expect(dikkatCumlesi(2, 3)).toBe('2 of 3 tests need attention');

    expect(raporHtml(veri([test_(1)]))).toContain('<h1>1 of 1 test needs attention</h1>');
    expect(raporHtml(veri([test_(1), test_(2)]))).toContain('<h1>2 of 2 tests need attention</h1>');
    expect(raporHtml(veri([test_(1)]))).not.toContain('test need attention');
  });

  it('ekran görüntüsü yoksa redaksiyon uyarısını basmaz, varsa basar', () => {
    expect(raporHtml(veri([test_(1)]))).not.toContain('Screenshots are not redacted');
    expect(raporHtml(veri([]))).not.toContain('Screenshots are not redacted');
    const gorselli = test_(1, { steps: [{ index: 0, screenshot: 'assets/r_20261010000000_0001/step-0.png' }] });
    expect(raporHtml(veri([gorselli]))).toContain('<strong>Screenshots are not redacted.</strong>');
  });
});
