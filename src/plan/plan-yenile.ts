import type { Beyin } from '../beyin/index.js';
import type { HaritaFarki, PlanAdimi, Sayfa, TestKaydi } from '../depo/index.js';
import { PLAN_YENILEME_SISTEM_ISTEMI, planYenilemeKullaniciIstemiOlustur } from './istem.js';
import { planYenilemeYanitiSemasi, type PlanYenilemeYaniti } from './sema.js';

export interface PlanYenilemeBaglami {
  test: TestKaydi;
  /** Keşif haritasındaki eski sayfa özeti; yoksa beyne "eski özet yok" denir. */
  eskiSayfa?: Sayfa;
  yeniSayfa: Sayfa;
  /** Son hata paketindeki harita farkı; varsa yeniden adlandırmayı doğrudan gösterir. */
  mapDiff?: HaritaFarki;
}

export interface PlanYenilemeSonucu {
  name: string;
  planSteps: PlanAdimi[];
}

/**
 * Bayatlamış plan adımlarını yeni sayfa özetine uyarlar: adım sayısı ve sırası
 * korunur, yalnız yeniden adlandırılmış öğeler güncellenir. Testin adı da
 * gerekiyorsa yenilenir.
 */
export async function planYenile(
  beyin: Beyin,
  baglam: PlanYenilemeBaglami,
  logDizini?: string,
): Promise<PlanYenilemeSonucu> {
  const adimSayisi = baglam.test.planSteps.length;
  if (adimSayisi === 0) throw new Error(`The test has no plan steps, so it cannot be refreshed: ${baglam.test.id}`);

  const yanit = await beyin.sor<PlanYenilemeYaniti>({
    gorev: `plan-yenile-${baglam.test.id}`,
    sistem: PLAN_YENILEME_SISTEM_ISTEMI,
    kullanici: planYenilemeKullaniciIstemiOlustur({
      test: { name: baglam.test.name, planSteps: baglam.test.planSteps },
      yeniSayfa: baglam.yeniSayfa,
      ...(baglam.eskiSayfa === undefined ? {} : { eskiSayfa: baglam.eskiSayfa }),
      ...(baglam.mapDiff === undefined ? {} : { mapDiff: baglam.mapDiff }),
    }),
    sema: planYenilemeYanitiSemasi(adimSayisi),
    ...(logDizini === undefined ? {} : { logDizini }),
  });

  return { name: yanit.json.name, planSteps: yanit.json.steps };
}
