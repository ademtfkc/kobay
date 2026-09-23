import * as v from 'valibot';
import type { FailureKind, HataAnalizi, Kanit } from '../depo/index.js';

/** Beynin gönderdiği, paket yolu henüz eklenmemiş kanıt. */
export type BeyindenGelenKanit = Omit<Kanit, 'path'>;

/** Beynin gönderdiği analiz; kanıt dosya yollarını yerel süreç tamamlar. */
export interface BeyindenGelenHataAnalizi extends Omit<HataAnalizi, 'evidence'> {
  failureKind: FailureKind;
  evidence: BeyindenGelenKanit[];
}

const KanitTuruSemasi = v.picklist(['screenshot', 'snapshot', 'console', 'network', 'log']);
const FixHedefiSemasi = v.picklist(['code', 'selector', 'data', 'env', 'unknown']);
const FailureKindSemasi = v.picklist(['product_bug', 'product_changed', 'test_bug', 'env', 'flaky', 'unknown']);

/** HataAnalizi'nin yalnız beynin ürettiği kısmı. */
export const BeyindenGelenHataAnaliziSemasi: v.GenericSchema<unknown, BeyindenGelenHataAnalizi> = v.object({
  rootCauseHypothesis: v.pipe(v.string(), v.minLength(1)),
  failureKind: FailureKindSemasi,
  recommendedFixTarget: v.object({
    kind: FixHedefiSemasi,
    reference: v.pipe(v.string(), v.minLength(1)),
    rationale: v.pipe(v.string(), v.minLength(1)),
  }),
  evidence: v.pipe(v.array(v.object({
    kind: KanitTuruSemasi,
    stepIndex: v.number(),
    summary: v.pipe(v.string(), v.minLength(1)),
  })), v.maxLength(6)),
});
