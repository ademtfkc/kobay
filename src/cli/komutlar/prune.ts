import {
  UnsafePrunePath,
  depoyuBuda,
  type DepoBudamaSonucu,
} from '../../depo/index.js';
import {
  PermissionError,
  UsageError,
  basariliMetin,
  komutCalistir,
  type KomutSonucu,
} from '../komut.js';
import { dizinBul } from './ortak.js';

export interface PruneArgumanlari {
  cwd: string;
  dryRun?: boolean;
  maxMb?: number;
  olderThanDays?: number;
}

function pozitifSayi(deger: number | undefined, alan: string): void {
  if (deger !== undefined && (!Number.isFinite(deger) || deger <= 0)) {
    throw new UsageError(`${alan} must be a positive number`);
  }
}

function insanOzeti(sonuc: DepoBudamaSonucu): string {
  const ogeler = sonuc.dryRun ? sonuc.wouldDelete : sonuc.deleted;
  const mb = sonuc.dryRun ? sonuc.wouldReclaimMb : sonuc.reclaimedMb;
  const eylem = sonuc.dryRun ? 'would remove' : 'removed';
  const satirlar = [
    `Prune ${sonuc.dryRun ? 'preview' : 'complete'}: ${eylem} ${ogeler.length} item${ogeler.length === 1 ? '' : 's'} and ${sonuc.dryRun ? 'would reclaim' : 'reclaimed'} ${mb.toFixed(2)} MB.`,
    `Run storage after prune: ${(sonuc.runBytesAfter / (1024 * 1024)).toFixed(2)} MB / ${sonuc.policy.maxMb.toFixed(2)} MB.`,
  ];
  if (sonuc.runLimitExceeded) {
    satirlar.push('The run limit is still exceeded because protected or incomplete runs were kept.');
  }
  if (sonuc.skipped.length > 0) {
    const taninmayan = sonuc.skipped.filter((oge) => oge.reason === 'unrecognized-failure-out-file').length;
    const yeni = sonuc.skipped.filter((oge) => oge.reason === 'too-recent').length;
    const sebepler = [
      ...(taninmayan > 0 ? [`${taninmayan} unrecognized`] : []),
      ...(yeni > 0 ? [`${yeni} too recent`] : []),
    ];
    satirlar.push(`Skipped ${sonuc.skipped.length} failure-out item${sonuc.skipped.length === 1 ? '' : 's'} (${sebepler.join(', ')}).`);
  }
  return satirlar.join('\n');
}

export async function prune(a: PruneArgumanlari): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    pozitifSayi(a.maxMb, 'maxMb');
    pozitifSayi(a.olderThanDays, 'olderThanDays');
    const dizin = await dizinBul(a.cwd);
    try {
      const sonuc = await depoyuBuda(dizin, {
        ...(a.dryRun === undefined ? {} : { dryRun: a.dryRun }),
        ...(a.maxMb === undefined ? {} : { maxMb: a.maxMb }),
        ...(a.olderThanDays === undefined ? {} : { olderThanDays: a.olderThanDays }),
      });
      return basariliMetin(sonuc, insanOzeti(sonuc));
    } catch (hata: unknown) {
      if (hata instanceof UnsafePrunePath) throw new UsageError(hata.message);
      const kod = typeof hata === 'object' && hata !== null && 'code' in hata ? hata.code : undefined;
      if (kod === 'EACCES' || kod === 'EPERM') {
        throw new PermissionError('Prune could not access or remove a managed artifact; check .kobay permissions');
      }
      throw hata;
    }
  });
}
