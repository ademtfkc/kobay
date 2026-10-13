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

  it('özette hata türü dökümü ve gruplara göre toplu istem başlığı', () => {
    const d = (no: number, kind: RaporTesti['failureKind']): RaporTesti => test_(no, { verdict: 'failed', ...(kind === undefined ? {} : { failureKind: kind }) });
    const metin = raporHtml(veri([d(1, 'test_bug'), d(2, 'env'), d(3, 'unknown'), d(4, 'unknown'), d(5, 'unknown')]));
    expect(metin).toContain('<p class="ozet-dokum">Failure kinds: 1 test_bug · 1 env · 3 unknown</p>');
    expect(metin).toContain('Fix 1 test, review 4 more with your coding agent');
    expect(metin).not.toContain('Fix all');
    expect(raporHtml(veri([d(1, undefined), d(2, undefined)]))).toContain('Failure kinds: 2 not analysed');
    expect(raporHtml(veri([d(1, 'product_bug'), d(2, 'test_bug')]))).toContain('Fix all 2 tests that need attention with your coding agent');
    expect(raporHtml(veri([test_(1, { verdict: 'passed' })]))).not.toContain('Failure kinds');
  });

  it('ekran görüntüsü yoksa redaksiyon uyarısını basmaz, varsa basar', () => {
    expect(raporHtml(veri([test_(1)]))).not.toContain('not redacted');
    expect(raporHtml(veri([]))).not.toContain('not redacted');
    const gorselli = test_(1, { steps: [{ index: 0, screenshot: 'assets/r_20261010000000_0001/step-0.png' }] });
    expect(raporHtml(veri([gorselli]))).toContain('<strong>Screenshots and videos are not redacted.</strong>');
  });

  it('yalnız video varken de redaksiyon uyarısını basar', () => {
    const videolu = test_(1, { verdict: 'failed', video: 'assets/r_20261010000000_0001/video.webm' });
    expect(raporHtml(veri([videolu]))).toContain('<strong>Screenshots and videos are not redacted.</strong>');
  });

  it('videoyu kontrollü, kendiliğinden oynamayan <video> olarak koyar; script ya da olay özniteliği yok', () => {
    const metin = raporHtml(veri([test_(1, { verdict: 'failed', video: 'assets/r_20261010000000_0001/video.webm' })]));
    expect(metin).toContain('<video class="video" controls preload="metadata" src="assets/r_20261010000000_0001/video.webm">');
    expect(metin).not.toMatch(/autoplay/i);
    expect(metin).not.toMatch(/<script/i);
    expect(metin).not.toMatch(/<video[^>]*\son[a-z]+=/i);
  });

  it('video eklenemediyse notu gösterir, <video> koymaz', () => {
    const metin = raporHtml(veri([test_(1, { verdict: 'failed', videoNote: 'The run video is larger than 50 MB, so it was not added to the report.' })]));
    expect(metin).toContain('The run video is larger than 50 MB, so it was not added to the report.');
    expect(metin).not.toContain('<video');
    expect(metin).not.toContain('not redacted');
  });

  it('CSP yalnız media-src self ekler, başka gevşetme yok', () => {
    const metin = raporHtml(veri([test_(1)]));
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(metin)?.[1];
    expect(csp).toBe("default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  });
});
