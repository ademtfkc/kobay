import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Beyin, BeyinIstegi, BeyinYaniti } from './index.js';
import { BrainError } from './index.js';
import { beyinGunluguYaz, type BeyinButcesi, semaylaSor, istemOlustur } from './ortak.js';

export class SahteBeyin implements Beyin {
  readonly ad = 'sahte';

  constructor(private readonly env: NodeJS.ProcessEnv, private readonly butce: BeyinButcesi) {}

  async sor<T>(istek: BeyinIstegi): Promise<BeyinYaniti<T>> {
    const dizin = this.env.KOBAY_SAHTE_YANIT_DIZINI;
    if (dizin === undefined || dizin === '') throw new BrainError('empty_response');
    const baslangic = Date.now();
    let sonIstem = istemOlustur(istek);
    let sonHam = '';
    try {
      const sonuc = await semaylaSor<T>(istek, async (istem) => {
        sonIstem = istem;
        const rezervasyon = this.butce.cagriBaslat();
        try {
          sonHam = await readFile(join(dizin, `${istek.gorev}.json`), 'utf8');
          this.butce.cagriTamamla(rezervasyon, 0);
          return { ham: sonHam };
        } catch (hata: unknown) {
          this.butce.cagriIptal(rezervasyon);
          if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') {
            throw new BrainError('empty_response');
          }
          throw hata;
        }
      });
      await beyinGunluguYaz(istek.logDizini, istek.gorev, sonIstem, sonuc.ham);
      return { ...sonuc, sureMs: Date.now() - baslangic, adaptor: this.ad };
    } catch (hata) {
      await beyinGunluguYaz(istek.logDizini, istek.gorev, sonIstem, sonHam);
      throw hata;
    }
  }
}
