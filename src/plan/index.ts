import { randomBytes } from 'node:crypto';
import * as v from 'valibot';
import type { Beyin } from '../beyin/index.js';
import {
  PlanDosyasiSemasi,
  SemaHatasi,
  yeniTestId,
  type Harita,
  type Oneri,
  type PlanDosyasi,
  type TestKaydi,
} from '../depo/index.js';
import { PLAN_SISTEM_ISTEMI, planKullaniciIstemiOlustur } from './istem.js';
import { PlanYanitiSemasi, type PlanYaniti } from './sema.js';
import { haritaYolKaliplari, oneriUrlKarari } from './url-kalip.js';

export {
  PLAN_SISTEM_ISTEMI,
  PLAN_YENILEME_SISTEM_ISTEMI,
  planKullaniciIstemiOlustur,
  planYenilemeKullaniciIstemiOlustur,
  type PlanYenilemeIstemBaglami,
} from './istem.js';
export {
  PlanYanitiSemasi,
  planYenilemeYanitiSemasi,
  type OneriTaslagi,
  type PlanYaniti,
  type PlanYenilemeYaniti,
} from './sema.js';
export {
  planYenile,
  type PlanYenilemeBaglami,
  type PlanYenilemeSonucu,
} from './plan-yenile.js';
export {
  haritaYolKaliplari,
  oneriUrlKarari,
  yolKalibi,
  yoluNormallestir,
  type UrlKarari,
} from './url-kalip.js';

const ONERI_ALFABESI = 'abcdefghijklmnopqrstuvwxyz0123456789';

function yeniOneriId(): string {
  const karakterler = Array.from(randomBytes(6), (bayt) => ONERI_ALFABESI[bayt % ONERI_ALFABESI.length]);
  return `p_${karakterler.join('')}`;
}

function semaSorunlariniMetneCevir(issues: readonly v.BaseIssue<unknown>[]): string[] {
  return issues.map((issue) => {
    const yol = issue.path?.map((parca) => String(parca.key)).join('.') ?? '$';
    return `${yol}: ${issue.message}`;
  });
}

/** Harita ve belgeyle beslenen beyin çağrısından kullanılabilir test önerileri üretir. */
export async function planUret(
  beyin: Beyin,
  harita: Harita,
  belge: string | undefined,
  ipucu?: string,
  logDizini?: string,
): Promise<{ oneriler: Oneri[]; dusurulen: Array<{ title: string; sebep: string }> }> {
  const yanit = await beyin.sor<PlanYaniti>({
    gorev: 'plan',
    sistem: PLAN_SISTEM_ISTEMI,
    kullanici: planKullaniciIstemiOlustur(harita, belge, ipucu),
    sema: PlanYanitiSemasi,
    ...(logDizini === undefined ? {} : { logDizini }),
  });
  const oneriler: Oneri[] = [];
  const dusurulen: Array<{ title: string; sebep: string }> = [];
  const kaliplar = haritaYolKaliplari(harita);

  for (const taslak of yanit.json.oneriler) {
    const karar = oneriUrlKarari(taslak.url, harita, kaliplar);
    if (!karar.kabul) {
      const kalipMetni = karar.kalip === null ? 'kalıp çıkarılamadı' : `kalıp: ${karar.kalip}`;
      dusurulen.push({
        title: taslak.title,
        sebep: `URL haritada yok ve yol kalıbı eşleşmedi: ${taslak.url} (${kalipMetni})`,
      });
      continue;
    }
    if (taslak.steps.length < 1 || taslak.steps.length > 200) {
      dusurulen.push({ title: taslak.title, sebep: `Adım sayısı 1–200 aralığında değil: ${taslak.steps.length}` });
      continue;
    }
    oneriler.push({ ...taslak, proposalId: yeniOneriId() });
  }

  if (oneriler.length === 0) throw new Error('Kullanılabilir öneri üretilemedi');
  return { oneriler, dusurulen };
}

/** Plan önerisini henüz kod üretilmemiş taslak test kaydına dönüştürür. */
export function oneriyiTesteCevir(oneri: Oneri): TestKaydi {
  const simdi = new Date().toISOString();
  return {
    id: yeniTestId(),
    name: oneri.title,
    type: 'frontend',
    createdFrom: 'plan',
    status: 'draft',
    planSteps: oneri.steps,
    priority: oneri.priority,
    url: oneri.url,
    codeVersion: 0,
    createdAt: simdi,
    updatedAt: simdi,
  };
}

/** Elle yazılan plan dosyasını taslak test kaydına dönüştürür. */
export function planDosyasindanTest(planJson: unknown): TestKaydi {
  const sonuc = v.safeParse(PlanDosyasiSemasi, planJson);
  if (!sonuc.success) throw new SemaHatasi(semaSorunlariniMetneCevir(sonuc.issues));
  return planDosyasiniTesteCevir(sonuc.output);
}

function planDosyasiniTesteCevir(plan: PlanDosyasi): TestKaydi {
  const simdi = new Date().toISOString();
  return {
    id: yeniTestId(),
    name: plan.name,
    type: 'frontend',
    createdFrom: 'cli',
    status: 'draft',
    planSteps: plan.planSteps,
    priority: plan.priority ?? 'p1',
    codeVersion: 0,
    createdAt: simdi,
    updatedAt: simdi,
  };
}
