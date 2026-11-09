import { describe, expect, it } from 'vitest';
import type { Harita, TestKaydi } from '../../src/depo/index.js';
import { kullaniciIstemi, sistemIstemi } from '../../src/uret/istem.js';
import { statikHata } from '../../src/uret/index.js';
import { yerelOnSiniflama } from '../../src/analiz/index.js';
import { planKullaniciIstemiOlustur, PLAN_SISTEM_ISTEMI } from '../../src/plan/istem.js';
import { oneriUrlKarari } from '../../src/plan/url-kalip.js';

const TABAN = 'http://uygulama.test';

function sayfa(yol: string, ek: Record<string, unknown> = {}): Harita['pages'][number] {
  return { url: `${TABAN}${yol}`, title: yol, headings: [], links: [], forms: [], buttons: [], menu: [], ...ek };
}

const harita: Harita = {
  baseUrl: TABAN,
  loggedIn: true,
  exploredAt: '2026-11-08T00:00:00.000Z',
  pages: [sayfa('/'), sayfa('/tasks/36'), sayfa('/projects/new', { disabledButtons: ['Create'] })],
};

const test: TestKaydi = {
  id: 't_ab12cd34', name: 'gorev', type: 'frontend', createdFrom: 'plan', status: 'draft',
  planSteps: [{ type: 'action', description: 'Open' }], priority: 'p1', codeVersion: 0,
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z',
};

function kod(hedef: string): string {
  return `import { test, expect } from './_fixture';
test('gorev', async ({ page }) => {
  await test.step('0: Open', async () => {
    await page.goto('${hedef}');
  });
});
`;
}

describe('plan kapısı ve kod üretim kapısı aynı kuralı kullanır', () => {
  it('plan kapısının kabul ettiği yol kalıbını kod üretim kapısı da kabul eder', () => {
    expect(oneriUrlKarari('/tasks/999999', harita).kabul).toBe(true);
    expect(statikHata(kod(`${TABAN}/tasks/999999`), test, harita)).toBeNull();
    expect(statikHata(kod('/tasks/999999'), test, harita)).toBeNull();
  });

  it('kalıba da yola da uymayan yol reddedilir ve komutu adlandırır', () => {
    const hata = statikHata(kod(`${TABAN}/invoices`), test, harita);
    expect(hata).toContain('not in the map');
    expect(hata).toContain('kobay explore --seed /invoices');
  });

  it('kabuk karakterli yol kapı mesajında ham komut olarak görünmez', () => {
    for (const yol of ['/yok$(id)', '/a;rm']) {
      const hata = statikHata(kod(`${TABAN}${yol}`), test, harita);
      expect(hata, yol).toContain('not in the map');
      expect(hata, yol).toContain('kobay explore --seed <path>');
      expect(hata, yol).not.toContain(`--seed ${yol}`);
    }
  });

  it('başka kökene giden goto kalıp eşleşse de reddedilir', () => {
    const hata = statikHata(kod('https://baska.test/tasks/999999'), test, harita);
    expect(hata).toContain('another origin');
  });
});

describe('haritada olmayan adres: üretilen testin düşüşü', () => {
  const metin = 'Error: kobay: the path /tasks/new is not in the map; add it to the map with: kobay explore --seed /tasks/new';

  it('gerçek kimlik şablonunu değil, eksik harita nedenini ve --seed komutunu verir', () => {
    const sonuc = yerelOnSiniflama(metin, 3);
    expect(sonuc?.failureKind).toBe('env');
    expect(sonuc?.recommendedFixTarget.kind).toBe('env');
    expect(sonuc?.recommendedFixTarget.reference).toContain('`kobay explore --seed /tasks/new`');
    expect(JSON.stringify(sonuc)).not.toContain('real credentials');
  });

  it('kabuk karakteri taşıyan yolu komuta yazmaz', () => {
    const sonuc = yerelOnSiniflama('kobay: the path /a;rm is not in the map', 0);
    expect(sonuc?.recommendedFixTarget.reference).toContain('kobay explore --seed <path>');
    expect(sonuc?.recommendedFixTarget.reference).not.toContain('rm');
  });

  it('gerçek kimlik düşüşü eskisi gibi kalır', () => {
    const sonuc = yerelOnSiniflama('kobay: this step needs the real credentials; the session is already authenticated', 1);
    expect(sonuc?.failureKind).toBe('test_bug');
  });
});

describe('devre dışı düğmeler istemlere girer', () => {
  it('plan istemi sayfanın devre dışı düğmelerini ve kuralı taşır', () => {
    const istem = planKullaniciIstemiOlustur(harita, undefined);
    expect(istem).toContain('disabled buttons (not clickable in the initial state): Create');
    expect(PLAN_SISTEM_ISTEMI).toContain('disabled buttons');
  });

  it('kod üretim istemi alanı yalnız doluysa taşır', () => {
    const istem = kullaniciIstemi(test, harita);
    expect(istem).toContain('"disabledButtons":["Create"]');
    expect(istem.match(/disabledButtons/g)).toHaveLength(1);
    expect(sistemIstemi()).toContain('toBeDisabled');
    expect(sistemIstemi()).toContain('kobay explore --seed <path>');
  });
});
