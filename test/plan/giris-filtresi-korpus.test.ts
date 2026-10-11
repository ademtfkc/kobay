import { describe, expect, it } from 'vitest';
import { adimGercekKimlikIsterMi } from '../../src/plan/giris-filtresi.js';
import korpus from './fixtures/giris-filtresi-korpus.json';

type KorpusEtiketi = 'P1' | 'P3' | 'limit';
interface KorpusSatiri {
  step: string;
  expected: boolean;
  tag: KorpusEtiketi;
}

const satirlar = korpus as KorpusSatiri[];

describe('giriş filtresi denetim korpusu', () => {
  for (const etiket of ['P1', 'P3'] as const) {
    const grup = satirlar.filter((satir) => satir.tag === etiket);
    it(`${etiket}: ${grup.length}/${grup.length} satır beklenen sonucu verir`, () => {
      const hatalar = grup.filter((satir) => adimGercekKimlikIsterMi(satir.step) !== satir.expected);
      expect(hatalar).toEqual([]);
    });
  }

  it.skip.each(satirlar.filter((satir) => satir.tag === 'limit'))(
    'bilinçli sınır: $step',
    ({ step, expected }) => {
      expect(adimGercekKimlikIsterMi(step)).toBe(expected);
    },
  );

  it('uzun çok-span ve parola tekrarlarını ayrı ayrı 200 ms altında sınıflandırır', () => {
    const girdiler: Array<[string, string, boolean]> = [
      ['span+click', 'click "Save and continue", '.repeat(1_500).slice(0, 36_000), false],
      ['enter password wrong', 'Enter a wrong password, '.repeat(1_500).slice(0, 36_000), false],
      ['password+click', `Type the password ${'click "a" '.repeat(7_200)}`.slice(0, 72_000), true],
    ];
    for (const [ad, adim, beklenen] of girdiler) {
      const baslangic = performance.now();
      expect(adimGercekKimlikIsterMi(adim), ad).toBe(beklenen);
      expect(performance.now() - baslangic, ad).toBeLessThan(200);
    }
  });
});
