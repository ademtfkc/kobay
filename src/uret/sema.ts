import * as v from 'valibot';

/**
 * Kod üretici beynin makinece doğrulanan yanıtı. 0.1'in Türkçe anahtarları
 * (`kod`, `aciklama`) hâlâ kabul edilir: model önbellekteki eski istemden
 * onları üretebilir.
 */
const ESKI_ANAHTARLAR: Readonly<Record<string, string>> = { kod: 'code', aciklama: 'explanation' };

function anahtarlariEsle(deger: unknown): unknown {
  if (typeof deger !== 'object' || deger === null || Array.isArray(deger)) return deger;
  const sonuc: Record<string, unknown> = { ...(deger as Record<string, unknown>) };
  for (const [eski, yeni] of Object.entries(ESKI_ANAHTARLAR)) {
    if (sonuc[yeni] === undefined && sonuc[eski] !== undefined) sonuc[yeni] = sonuc[eski];
  }
  return sonuc;
}

export const KodYanitiSemasi = v.pipe(
  v.unknown(),
  v.transform(anahtarlariEsle),
  v.object({
    code: v.pipe(v.string(), v.minLength(1)),
    explanation: v.exactOptional(v.string()),
  }),
);

export type KodYaniti = v.InferOutput<typeof KodYanitiSemasi>;
