import { describe, expect, it } from 'vitest';
import type { HataAnalizi } from '../../src/depo/index.js';
import { analizSistemIstemiOlustur, ortakFixtureOnerisiniDuzelt, oturumKanitsizEnvDuzelt } from '../../src/analiz/index.js';

/** 0.8.0 Ş1 P2-4: oturum düşüşünde analiz ortak `_fixture.ts` düzenlemesini önermez. */

// Gerçek koşudan (Vikunja, reports/2026-11-08-gercek-uygulama-0.8.0.md §5) kısaltılmış beyin yanıtı.
const VIKUNJA: HataAnalizi = {
  rootCauseHypothesis: 'The test session was no longer authenticated: the token refresh request was rejected with 401'
    + ' and the app redirected to the login page.',
  failureKind: 'env',
  recommendedFixTarget: {
    kind: 'env',
    reference: 'Test auth setup in the shared fixture (.kobay/tests/_fixture.ts)',
    rationale: 'Provide a fresh storage state or make the fixture re-authenticate before each test.',
  },
  evidence: [],
};

describe('0.8.0 P2-1: yasaklayıcı anma öneri sayılmaz', () => {
  it('beyin "Do not edit .kobay/tests/_fixture.ts" cümlesini tekrarlarsa doğru öneri ezilmez', () => {
    const analiz: HataAnalizi = {
      rootCauseHypothesis: 'The test needs to start without a logged-in session; the app redirects /login to home when signed in.',
      failureKind: 'env',
      recommendedFixTarget: {
        kind: 'env',
        reference: 'Run this test in an unauthenticated browser context',
        rationale: 'Only this test\'s own spec file should change. Do not edit .kobay/tests/_fixture.ts.',
      },
      evidence: [],
    };
    expect(ortakFixtureOnerisiniDuzelt(analiz, 't_55texgsy')).toBe(analiz);
  });

  it('gerçek düzenleme önerisi sürer; yasak ve öneri birlikteyse öneri yakalanır', () => {
    const analiz: HataAnalizi = {
      ...VIKUNJA,
      recommendedFixTarget: { kind: 'env', reference: 'x', rationale: 'Do not touch the app. Edit .kobay/tests/_fixture.ts to re-authenticate the session.' },
    };
    expect(ortakFixtureOnerisiniDuzelt(analiz, 't_x').recommendedFixTarget.reference).toContain('kobay test rerun t_x');
  });
});

describe('0.8.0 P2: olumsuzluk düzenleme eylemine bağlı', () => {
  const oneri = (rationale: string): HataAnalizi => ({
    ...VIKUNJA,
    recommendedFixTarget: { kind: 'env', reference: 'x', rationale },
  });
  it('"Do not delay editing _fixture.ts" gerçek öneridir: override sürer', () => {
    const s = ortakFixtureOnerisiniDuzelt(oneri('Do not delay editing .kobay/tests/_fixture.ts; re-authenticate there.'), 't_x');
    expect(s.recommendedFixTarget.reference).toContain('kobay test rerun t_x');
  });
  it('"Do not edit/change/modify/touch" ve birleşik yasak öneri sayılmaz', () => {
    for (const r of [
      'Do not edit .kobay/tests/_fixture.ts.', 'Do not change _fixture.ts', 'never modify the shared .kobay/tests/_fixture.ts',
      "Don't touch _fixture.ts", 'Do not edit or change .kobay/tests/_fixture.ts.',
    ]) {
      const a = oneri(r);
      expect(ortakFixtureOnerisiniDuzelt(a, 't_x')).toBe(a);
    }
  });
});

describe('0.8.0 P1-1: 401 gürültüsü oturum düşüşü sayılmaz', () => {
  const GURULTU: HataAnalizi = {
    rootCauseHypothesis: 'The session expired: token refresh requests were rejected with 401, so the heading was not found.',
    failureKind: 'env',
    recommendedFixTarget: { kind: 'env', reference: 'session', rationale: 'Rerun with `kobay test rerun t_9s5ur2ci` to renew the session.' },
    evidence: [],
  };
  it('giriş ekranı olmayan sayfada env -> unknown, rerun önerisi gider', () => {
    const s = oturumKanitsizEnvDuzelt(GURULTU, '<main><h1>Tasks</h1><button>Add</button></main>');
    expect(s.failureKind).toBe('unknown');
    expect(s.recommendedFixTarget.kind).toBe('unknown');
    expect(s.recommendedFixTarget.rationale).not.toMatch(/Rerun with/);
  });
  it('DOM giriş ekranıysa env kalır; 5xx gibi başka ortam izi de env kalır', () => {
    expect(oturumKanitsizEnvDuzelt(GURULTU, '<h1>Login</h1><input type="password">')).toBe(GURULTU);
    expect(oturumKanitsizEnvDuzelt({ ...GURULTU, rootCauseHypothesis: 'token refresh 401 and the API returned 503' }, '<main></main>').failureKind).toBe('env');
  });
  it('istem 401 gürültüsünü oturum kanıtı saymaz', () => {
    expect(analizSistemIstemiOlustur()).not.toMatch(/token refresh requests rejected with 401\):/);
    expect(analizSistemIstemiOlustur()).toMatch(/NOT evidence of a lost session/);
  });
});

describe('ortakFixtureOnerisiniDuzelt', () => {
  it('oturum düşüşünde fixture önerisi yerine oturum komutları gelir; fixture düzenlemesi önerilmez', () => {
    const sonuc = ortakFixtureOnerisiniDuzelt(VIKUNJA, 't_gcelm920');
    expect(sonuc.failureKind).toBe('env');
    expect(sonuc.recommendedFixTarget.kind).toBe('env');
    expect(sonuc.recommendedFixTarget.reference).toContain('`kobay explore --session-file <file>`');
    expect(sonuc.recommendedFixTarget.reference).toContain('`kobay test rerun t_gcelm920`');
    expect(sonuc.recommendedFixTarget.rationale).toContain('Do not edit .kobay/tests/_fixture.ts');
    expect(sonuc.recommendedFixTarget.rationale).not.toMatch(/make the fixture re-authenticate/);
    expect(sonuc.rootCauseHypothesis).toBe(VIKUNJA.rootCauseHypothesis);
  });

  it('oturum izi olmayan fixture önerisi korunur, yasak not olarak eklenir', () => {
    const analiz: HataAnalizi = {
      ...VIKUNJA,
      rootCauseHypothesis: 'The target returned 503 for every request.',
      recommendedFixTarget: { kind: 'env', reference: 'base URL in .kobay/tests/_fixture.ts', rationale: 'Point the fixture at the running app.' },
    };
    const sonuc = ortakFixtureOnerisiniDuzelt(analiz, 't_x');
    expect(sonuc.recommendedFixTarget.reference).toBe('base URL in .kobay/tests/_fixture.ts');
    expect(sonuc.recommendedFixTarget.rationale).toContain('Kobay note: Do not edit .kobay/tests/_fixture.ts');
  });

  it('env olmayan sınıfta da (test_bug/code) fixture hedefi testin kendi spec dosyasına çevrilir (P2-5)', () => {
    const testHatasi: HataAnalizi = {
      ...VIKUNJA,
      failureKind: 'test_bug',
      recommendedFixTarget: { kind: 'code', reference: '.kobay/tests/_fixture.ts line 12', rationale: 'Wait for the app in the fixture.' },
    };
    const sonuc = ortakFixtureOnerisiniDuzelt(testHatasi, 't_x');
    expect(sonuc.failureKind).toBe('test_bug');
    expect(sonuc.recommendedFixTarget.kind).toBe('code');
    expect(sonuc.recommendedFixTarget.reference).toBe('.kobay/tests/t_x.spec.ts');
    expect(sonuc.recommendedFixTarget.rationale).toContain('Do not edit .kobay/tests/_fixture.ts');
    expect(sonuc.recommendedFixTarget.rationale).toContain('.kobay/tests/t_x.spec.ts');
  });

  it('tur 3: ürünün kendi veri fixture\'ını anan öneri değişmez (yalnız kobay _fixture.ts yolu)', () => {
    const urun: HataAnalizi = {
      ...VIKUNJA,
      failureKind: 'product_bug',
      recommendedFixTarget: { kind: 'code', reference: 'src/api/users.ts', rationale: 'The seed data fixture users.json has no admin; update the fixture.' },
    };
    expect(ortakFixtureOnerisiniDuzelt(urun, 't_x')).toBe(urun);
    for (const yol of ['./_fixture', '_fixture.ts', '.kobay/tests/_fixture.ts']) {
      const kobay: HataAnalizi = { ...urun, recommendedFixTarget: { ...urun.recommendedFixTarget, reference: `${yol} line 3` } };
      expect(ortakFixtureOnerisiniDuzelt(kobay, 't_x').recommendedFixTarget.reference, yol).toBe('.kobay/tests/t_x.spec.ts');
    }
  });

  it('B4: ürünün kendi _fixture dosyaları (src/fixtures/_fixture.ts, e2e/_fixture.ts, _fixture.tsx, _fixture.json) eşleşmez', () => {
    for (const yol of ['src/fixtures/_fixture.ts', 'e2e/_fixture.ts', '_fixture.tsx', '_fixture.json']) {
      const urun: HataAnalizi = {
        ...VIKUNJA,
        failureKind: 'product_bug',
        recommendedFixTarget: { kind: 'code', reference: `${yol} line 3`, rationale: `Fix the seed in ${yol}.` },
      };
      expect(ortakFixtureOnerisiniDuzelt(urun, 't_x'), yol).toBe(urun);
    }
  });

  it('fixture anmayan öneriye dokunmaz', () => {
    const testHatasi: HataAnalizi = { ...VIKUNJA, failureKind: 'test_bug', recommendedFixTarget: { kind: 'selector', reference: 'line 4', rationale: 'Use getByRole.' } };
    expect(ortakFixtureOnerisiniDuzelt(testHatasi, 't_x')).toBe(testHatasi);
    const ag: HataAnalizi = { ...VIKUNJA, recommendedFixTarget: { kind: 'env', reference: 'app server', rationale: 'Start the app.' } };
    expect(ortakFixtureOnerisiniDuzelt(ag, 't_x')).toBe(ag);
  });

  it('analiz istemi oturum düşüşü için env ve doğru komutları söyler, fixture düzenlemesini yasaklar', () => {
    const istem = analizSistemIstemiOlustur();
    expect(istem).toContain('If the test session is no longer authenticated');
    expect(istem).toContain('`kobay explore --session-file <file>`');
    expect(istem).toContain('Never recommend editing .kobay/tests/_fixture.ts');
  });
});
