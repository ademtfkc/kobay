import { randomBytes } from 'node:crypto';
import * as v from 'valibot';
import type { Beyin } from '../beyin/index.js';
import {
  PlanDosyasiSemasi,
  SchemaError,
  yeniTestId,
  type Harita,
  type Oneri,
  type PlanDosyasi,
  type TestKaydi,
} from '../depo/index.js';
import { girisKuraliIhlali } from './giris-filtresi.js';
import { PLAN_SISTEM_ISTEMI, planKullaniciIstemiOlustur } from './istem.js';
import { PlanYanitiSemasi, type PlanYaniti } from './sema.js';
import { haritaSlugOnekleri, haritaYolKaliplari, oneriUrlKarari, yoluNormallestir, yolKalibi } from './url-kalip.js';

export {
  PLAN_SISTEM_ISTEMI,
  PLAN_YENILEME_SISTEM_ISTEMI,
  planKullaniciIstemiOlustur,
  planYenilemeKullaniciIstemiOlustur,
  type PlanYenilemeIstemBaglami,
} from './istem.js';
export {
  BEYAN_SEBEBI,
  GERCEK_KIMLIK_SEBEBI,
  adimGercekKimlikIsterMi,
  gercekKimlikAdimi,
  girisKuraliIhlali,
} from './giris-filtresi.js';
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

export const GIRIS_GEREKLI_SEBEBI = 'login required, no saved login';

export const KOKEN_DISI_SEBEBI = 'URL is outside the project origin';

export const YONLENDIRME_KIMLIK_SEBEBI = 'login required, no saved login: the redirect check declares '
  + 'requiresRealCredentials: true';

/** Düşme mesajında kullanıcıya sonraki adım. Kimlik değeri içermez. */
export const GIRIS_GEREKLI_SONRAKI_ADIM = 'only redirect checks (loginRedirectCheck: true) are kept for '
  + 'login-required pages; to test the page itself, save a login with `kobay project create --login` (or '
  + '`kobay project update --login`), then run `kobay explore` and `kobay test plan generate` again';

/** Harita ve belgeyle beslenen beyin çağrısından kullanılabilir test önerileri üretir. */
export async function planUret(
  beyin: Beyin,
  harita: Harita,
  belge: string | undefined,
  ipucu?: string,
  logDizini?: string,
): Promise<{ proposals: Oneri[]; dropped: Array<{ title: string; reason: string }>; nextStep?: string }> {
  const yanit = await beyin.sor<PlanYaniti>({
    gorev: 'plan',
    sistem: PLAN_SISTEM_ISTEMI,
    kullanici: planKullaniciIstemiOlustur(harita, belge, ipucu),
    sema: PlanYanitiSemasi,
    ...(logDizini === undefined ? {} : { logDizini }),
  });
  const oneriler: Oneri[] = [];
  const dusurulen: Array<{ title: string; reason: string }> = [];
  const kaliplar = haritaYolKaliplari(harita);
  const projeKokeni = new URL(harita.baseUrl).origin;
  // Giriş gerekli sayfaların yolları ve kalıpları; URL kabulüyle aynı kalıp eşleştiricisi (fail-closed).
  const slugOnekleri = haritaSlugOnekleri(harita);
  const girisYollari = new Set<string>();
  const girisKaliplari = new Set<string>();
  for (const sayfa of harita.pages) {
    if (sayfa.requiresLogin !== true) continue;
    const yol = yoluNormallestir(sayfa.url, harita.baseUrl);
    if (yol !== null) girisYollari.add(yol);
    const kalip = yolKalibi(sayfa.url, harita.baseUrl, slugOnekleri);
    if (kalip !== null) girisKaliplari.add(kalip);
  }
  // Giriş-gerekli sebeple en az bir öneri düştüyse sonraki adım bir kez döner (sebeplerde tekrarlanmaz).
  let girisIpucu = false;

  for (const taslak of yanit.json.proposals) {
    const karar = oneriUrlKarari(taslak.url, harita, kaliplar);
    if (!karar.kabul) {
      const kalipMetni = karar.kalip === null ? 'no pattern could be derived' : `pattern: ${karar.kalip}`;
      dusurulen.push({
        title: taslak.title,
        reason: `URL is not in the map and no path pattern matched: ${taslak.url} (${kalipMetni})`,
      });
      continue;
    }
    // Plan yalnız proje kökenindeki sayfaları hedefler: harita da yalnız o kökeni gezer. Yol eşleşse de
    // başka kökene yazılan URL (ör. https://baska.test/panel) düşer.
    if (new URL(taslak.url, harita.baseUrl).origin !== projeKokeni) {
      dusurulen.push({ title: taslak.title, reason: `${KOKEN_DISI_SEBEBI}: ${taslak.url}` });
      continue;
    }
    // Kayıtlı giriş yokken giriş gerektiren sayfanın içeriği test edilemez (haritada yok, oturum yok).
    // Yalnız beynin `loginRedirectCheck: true` diye işaretlediği yönlendirme testi tutulur; beyan yoksa
    // (eski yanıt) ya da false ise düşer. Karar metinden değil yapısal beyandan.
    if (!harita.loggedIn) {
      // Tam yol ya da kalıp bir giriş gerekli sayfaya denk geliyorsa giriş gerekli sayılır (/orders/36
      // giriş istiyorsa /orders/999 da ister); kalıp normal bir sayfayla da çakışsa emniyetli taraf seçilir.
      const yol = yoluNormallestir(taslak.url, harita.baseUrl);
      const girisGerekli = (yol !== null && girisYollari.has(yol))
        || (karar.kalip !== null && girisKaliplari.has(karar.kalip));
      if (girisGerekli && taslak.loginRedirectCheck !== true) {
        dusurulen.push({ title: taslak.title, reason: `${GIRIS_GEREKLI_SEBEBI}: ${taslak.url}` });
        girisIpucu = true;
        continue;
      }
      // Yönlendirme testi gerçek kimlik isteyemez: girişsiz projede kimlik yok, test koşamaz.
      if (girisGerekli && taslak.requiresRealCredentials === true) {
        dusurulen.push({ title: taslak.title, reason: `${YONLENDIRME_KIMLIK_SEBEBI}: ${taslak.url}` });
        girisIpucu = true;
        continue;
      }
    }
    if (taslak.steps.length < 1 || taslak.steps.length > 200) {
      dusurulen.push({ title: taslak.title, reason: `Step count is outside the 1-200 range: ${taslak.steps.length}` });
      continue;
    }
    // Giriş yapılandırılmışsa (harita.loggedIn) oturum zaten açıktır; gerçek kimlik giren adımı olan
    // test yazılamaz. Karar adımlardan; elle yazılan plan da aynı kuraldan geçer (CLI test create).
    // Beyin öneri başına `requiresRealCredentials` beyan eder: true düşürür; false/yok ise sözcük filtresi karar verir.
    const girisIhlali = girisKuraliIhlali(taslak.steps, harita.loggedIn, taslak.requiresRealCredentials);
    if (girisIhlali !== null) {
      dusurulen.push({ title: taslak.title, reason: girisIhlali });
      continue;
    }
    // Beyanlar (requiresRealCredentials, loginRedirectCheck) yerel öneriye taşınmaz; plan.json şeması değişmez.
    const { title, description, priority, category, feature, type, url, steps } = taslak;
    oneriler.push({ title, description, priority, category, feature, type, url, steps, proposalId: yeniOneriId() });
  }

  const nextStep = girisIpucu ? GIRIS_GEREKLI_SONRAKI_ADIM : undefined;
  if (oneriler.length === 0) {
    // Hepsi düştüyse düşme sebepleri ve sonraki adım (bir kez, sonda) hata mesajında kullanıcıya ulaşır.
    const tekSatir = (metin: string): string => metin.replace(/[\r\n\t]+/g, ' ');
    const sebepler = dusurulen.map((o) => `${tekSatir(o.title)} (${tekSatir(o.reason)})`).join(', ');
    throw new Error(dusurulen.length === 0
      ? 'No usable proposal was produced'
      : `No usable proposal was produced; ${dusurulen.length} dropped: ${sebepler}${nextStep === undefined ? '' : `. ${nextStep}`}`);
  }
  return { proposals: oneriler, dropped: dusurulen, ...(nextStep === undefined ? {} : { nextStep }) };
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
  if (!sonuc.success) throw new SchemaError(semaSorunlariniMetneCevir(sonuc.issues));
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
    // Şema yalnız biçimi denetler; hedefin origin'iyle karşılaştırma CLI'da
    // (config'teki baseUrl orada okunur).
    ...(plan.url === undefined ? {} : { url: plan.url }),
    codeVersion: 0,
    createdAt: simdi,
    updatedAt: simdi,
  };
}
