import * as v from 'valibot';
import type { Oncelik, PlanAdimi } from '../depo/index.js';

/** Beynin ürettiği, henüz yerel proposalId atanmamış öneri. */
export interface OneriTaslagi {
  title: string;
  description: string;
  priority: Oncelik;
  category: string;
  feature: string;
  type: 'frontend';
  url: string;
  steps: PlanAdimi[];
}

export interface PlanYaniti {
  proposals: OneriTaslagi[];
}

const TURKCE_ANAHTARLAR: Readonly<Record<string, string>> = {
  oneriler: 'proposals',
  baslik: 'title',
  aciklama: 'description',
  oncelik: 'priority',
  kategori: 'category',
  ozellik: 'feature',
  tur: 'type',
  adimlar: 'steps',
};

function anahtarlariNormallestir(deger: unknown): unknown {
  if (typeof deger !== 'object' || deger === null || Array.isArray(deger)) return deger;
  const kaynak = deger as Record<string, unknown>;
  const sonuc: Record<string, unknown> = { ...kaynak };
  for (const [turkce, ingilizce] of Object.entries(TURKCE_ANAHTARLAR)) {
    if (sonuc[ingilizce] === undefined && kaynak[turkce] !== undefined) sonuc[ingilizce] = kaynak[turkce];
  }
  return sonuc;
}

/** Modelin yaygın Türkçeleştirdiği öneri alanlarını doğrulamadan önce eşler. */
export function planYanitiniNormallestir(deger: unknown): unknown {
  if (typeof deger !== 'object' || deger === null || Array.isArray(deger)) return deger;
  const sonuc = anahtarlariNormallestir(deger) as Record<string, unknown>;
  if (!Array.isArray(sonuc.proposals)) return sonuc;
  sonuc.proposals = sonuc.proposals.map((oneri) => {
    const normallesmisOneri = anahtarlariNormallestir(oneri) as Record<string, unknown>;
    if (Array.isArray(normallesmisOneri.steps)) {
      normallesmisOneri.steps = normallesmisOneri.steps.map(anahtarlariNormallestir);
    }
    return normallesmisOneri;
  });
  return sonuc;
}

const PlanAdimiTaslagiSemasi: v.GenericSchema<unknown, PlanAdimi> = v.object({
  type: v.picklist(['action', 'assertion']),
  description: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Beyin yanıtının şeması. Adım sınırı burada değil, tek tek öneri düşürülürken
 * uygulanır; böylece bozuk bir öneri geçerli olanları engellemez.
 */
const OneriTaslagiSemasi: v.GenericSchema<unknown, OneriTaslagi> = v.object({
  title: v.pipe(v.string(), v.minLength(1)),
  description: v.pipe(v.string(), v.minLength(1)),
  priority: v.picklist(['p0', 'p1', 'p2', 'p3']),
  category: v.pipe(v.string(), v.minLength(1)),
  feature: v.pipe(v.string(), v.minLength(1)),
  type: v.literal('frontend'),
  url: v.pipe(v.string(), v.minLength(1)),
  steps: v.array(PlanAdimiTaslagiSemasi),
});

export const PlanYanitiSemasi: v.GenericSchema<unknown, PlanYaniti> = v.pipe(
  v.unknown(),
  v.transform(planYanitiniNormallestir),
  v.object({ proposals: v.array(OneriTaslagiSemasi) }),
);

export interface PlanYenilemeYaniti {
  name: string;
  steps: PlanAdimi[];
}

const YENILEME_TURKCE_ANAHTARLAR: Readonly<Record<string, string>> = {
  ad: 'name',
  isim: 'name',
  adimlar: 'steps',
};

function yenilemeYanitiniNormallestir(deger: unknown): unknown {
  if (typeof deger !== 'object' || deger === null || Array.isArray(deger)) return deger;
  const kaynak = deger as Record<string, unknown>;
  const sonuc: Record<string, unknown> = { ...kaynak };
  for (const [turkce, ingilizce] of Object.entries(YENILEME_TURKCE_ANAHTARLAR)) {
    if (sonuc[ingilizce] === undefined && kaynak[turkce] !== undefined) sonuc[ingilizce] = kaynak[turkce];
  }
  if (Array.isArray(sonuc.steps)) sonuc.steps = sonuc.steps.map(anahtarlariNormallestir);
  return sonuc;
}

/**
 * Plan yenileme yanıtının şeması. Adım sayısı şemanın parçasıdır: yanlış sayıda
 * adım gelirse beyin şema hatasıyla bir tur daha denenir, ikinci turda da
 * tutmazsa `BrainError('schema')` atılır.
 */
export function planYenilemeYanitiSemasi(adimSayisi: number): v.GenericSchema<unknown, PlanYenilemeYaniti> {
  return v.pipe(
    v.unknown(),
    v.transform(yenilemeYanitiniNormallestir),
    v.object({
      name: v.pipe(v.string(), v.minLength(1)),
      steps: v.pipe(v.array(PlanAdimiTaslagiSemasi), v.length(adimSayisi)),
    }),
  );
}
