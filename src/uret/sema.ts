import * as v from 'valibot';

/** Kod üretici beynin makinece doğrulanan yanıtı. */
export const KodYanitiSemasi = v.object({
  kod: v.pipe(v.string(), v.minLength(1)),
  aciklama: v.exactOptional(v.string()),
});

export type KodYaniti = v.InferOutput<typeof KodYanitiSemasi>;
