import * as v from 'valibot';
import { kalicidanEsle } from './anahtar-gocu.js';
import type {
  AdimSonucu,
  BeyinAyari,
  FailureKind,
  Form,
  FormAlani,
  Harita,
  HaritaFarki,
  HataAnalizi,
  HataPaketi,
  Kanit,
  Kimlik,
  KobayConfig,
  KosuSonucu,
  Oneri,
  Oncelik,
  PlanAdimi,
  PlanDosyasi,
  Sayfa,
  TestDurumu,
  TestKaydi,
  Verdict,
} from './tipler.js';

export const OncelikSemasi: v.GenericSchema<unknown, Oncelik> = v.picklist(['p0', 'p1', 'p2', 'p3']);
export const TestDurumuSemasi: v.GenericSchema<unknown, TestDurumu> = v.picklist([
  'draft', 'ready', 'queued', 'running', 'passed', 'failed', 'blocked', 'cancelled', 'unknown',
]);
export const FailureKindSemasi: v.GenericSchema<unknown, FailureKind> = v.picklist([
  'product_bug', 'product_changed', 'test_bug', 'env', 'flaky', 'unknown',
]);
export const VerdictSemasi: v.GenericSchema<unknown, Verdict> = v.picklist([
  'passed', 'failed', 'blocked', 'inconclusive',
]);

export const PlanAdimiSemasi: v.GenericSchema<unknown, PlanAdimi> = v.object({
  type: v.picklist(['action', 'assertion']),
  description: v.pipe(v.string(), v.minLength(1)),
});

export const FormAlaniSemasi: v.GenericSchema<unknown, FormAlani> = v.object({
  name: v.string(),
  type: v.string(),
  label: v.exactOptional(v.string()),
  placeholder: v.exactOptional(v.string()),
});

export const FormSemasi: v.GenericSchema<unknown, Form> = v.object({
  action: v.exactOptional(v.string()),
  fields: v.array(FormAlaniSemasi),
});

export const SayfaSemasi: v.GenericSchema<unknown, Sayfa> = v.object({
  url: v.string(),
  title: v.string(),
  headings: v.array(v.string()),
  links: v.array(v.string()),
  forms: v.array(FormSemasi),
  buttons: v.array(v.string()),
  menu: v.array(v.string()),
});

/** Diskteki harita; 0.1'in Türkçe alan adları okunurken yenisine eşlenir. */
export const HaritaSemasi: v.GenericSchema<unknown, Harita> = v.pipe(
  v.unknown(),
  v.transform(kalicidanEsle),
  v.object({
    baseUrl: v.string(),
    loggedIn: v.boolean(),
    pages: v.array(SayfaSemasi),
    exploredAt: v.string(),
  }),
);

export const HaritaFarkiSemasi: v.GenericSchema<unknown, HaritaFarki> = v.object({
  url: v.string(),
  addedHeadings: v.array(v.string()),
  removedHeadings: v.array(v.string()),
  addedButtons: v.array(v.string()),
  removedButtons: v.array(v.string()),
  addedFormFields: v.array(v.string()),
  removedFormFields: v.array(v.string()),
  pageIdentityMatches: v.boolean(),
  changed: v.boolean(),
});

export const OneriSemasi: v.GenericSchema<unknown, Oneri> = v.object({
  proposalId: v.string(),
  title: v.string(),
  description: v.string(),
  priority: OncelikSemasi,
  category: v.string(),
  feature: v.string(),
  type: v.literal('frontend'),
  url: v.string(),
  steps: v.array(PlanAdimiSemasi),
});

export const TestKaydiSemasi: v.GenericSchema<unknown, TestKaydi> = v.object({
  id: v.string(),
  name: v.string(),
  type: v.literal('frontend'),
  createdFrom: v.picklist(['cli', 'mcp', 'plan']),
  status: TestDurumuSemasi,
  planSteps: v.array(PlanAdimiSemasi),
  priority: OncelikSemasi,
  url: v.exactOptional(v.string()),
  codeVersion: v.number(),
  lastRunId: v.exactOptional(v.string()),
  lastError: v.exactOptional(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
});

export const AdimSonucuSemasi: v.GenericSchema<unknown, AdimSonucu> = v.object({
  stepIndex: v.number(),
  description: v.string(),
  status: v.picklist(['passed', 'failed', 'skipped']),
  screenshotPath: v.exactOptional(v.string()),
  htmlPath: v.exactOptional(v.string()),
  errorMessage: v.exactOptional(v.string()),
  durationMs: v.number(),
});

export const KosuSonucuSemasi: v.GenericSchema<unknown, KosuSonucu> = v.object({
  testId: v.string(),
  runId: v.string(),
  status: TestDurumuSemasi,
  verdict: VerdictSemasi,
  startedAt: v.string(),
  finishedAt: v.string(),
  codeVersion: v.number(),
  failedStepIndex: v.exactOptional(v.number()),
  failureKind: v.exactOptional(FailureKindSemasi),
  errorMessage: v.exactOptional(v.string()),
});

export const KanitSemasi: v.GenericSchema<unknown, Kanit> = v.object({
  kind: v.picklist(['screenshot', 'snapshot', 'console', 'network', 'log']),
  stepIndex: v.number(),
  path: v.string(),
  summary: v.string(),
});

export const HataAnaliziSemasi: v.GenericSchema<unknown, HataAnalizi> = v.object({
  rootCauseHypothesis: v.string(),
  failureKind: FailureKindSemasi,
  recommendedFixTarget: v.object({
    kind: v.picklist(['code', 'selector', 'data', 'env', 'unknown']),
    reference: v.string(),
    rationale: v.string(),
  }),
  evidence: v.array(KanitSemasi),
});

/** Diskteki hata paketi; 0.1'in Türkçe alan adları okunurken yenisine eşlenir. */
export const HataPaketiSemasi: v.GenericSchema<unknown, HataPaketi> = v.pipe(
  v.unknown(),
  v.transform(kalicidanEsle),
  v.object({
    snapshotId: v.string(),
    testId: v.string(),
    runId: v.string(),
    result: KosuSonucuSemasi,
    steps: v.array(AdimSonucuSemasi),
    code: v.string(),
    failure: HataAnaliziSemasi,
    mapDiff: v.exactOptional(HaritaFarkiSemasi),
  }),
);

export const BeyinAyariSemasi: v.GenericSchema<unknown, BeyinAyari> = v.object({
  adaptor: v.picklist(['claude', 'codex', 'openrouter', 'sahte']),
  model: v.exactOptional(v.string()),
  effort: v.exactOptional(v.string()),
  maxBudgetUsd: v.exactOptional(v.pipe(v.number(), v.minValue(0.01))),
  maxCalls: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxTotalCostUsd: v.exactOptional(v.pipe(v.number(), v.minValue(0.01))),
  maxTokens: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

/** Ayrı giriş (SSO) origin listesinin üst sınırı. */
export const EN_COK_AUTH_ORIGIN = 5;

/**
 * Tek bir auth origin girdisini denetler ve normal biçimini (`URL.origin`) döner.
 * Yalnız http(s); yol, sorgu, parça, kullanıcı bilgisi ve joker yasak (sondaki tek `/` hariç).
 * Geçersizse nedenini söyleyen `Error` fırlatır.
 */
export function authOriginNormallestir(girdi: string): string {
  const neden = (aciklama: string): Error => new Error(`Invalid auth origin "${girdi}": ${aciklama}`);
  const ham = girdi.trim();
  if (ham.includes('*')) throw neden('wildcards are not allowed; list each origin in full');
  const semaSonrasi = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(ham)?.[1];
  if (semaSonrasi === undefined) throw neden('expected a full origin such as https://auth.example.com');
  const govde = semaSonrasi.endsWith('/') ? semaSonrasi.slice(0, -1) : semaSonrasi;
  if (govde.includes('@')) throw neden('user info is not allowed');
  if (/[/?#\\]/.test(govde)) throw neden('only an origin is allowed (no path, query, or fragment)');
  let adres: URL;
  try {
    adres = new URL(ham);
  } catch {
    throw neden('not a valid URL');
  }
  if (adres.protocol !== 'http:' && adres.protocol !== 'https:') throw neden('only http and https are allowed');
  if (adres.hostname === '') throw neden('the host name is missing');
  return adres.origin;
}

/**
 * Auth origin listesini denetler; normal biçimde, sıralı döner. `baseUrl` origin'i örtüktür
 * (listede olamaz), tekrar ve 5'ten fazla öğe yasak. Geçersizse `Error` fırlatır.
 */
export function authOriginleriDogrula(baseUrl: string, girdiler: readonly string[]): string[] {
  let baseOrigin: string;
  try {
    baseOrigin = new URL(baseUrl).origin;
  } catch {
    throw new Error('baseUrl must be a valid URL');
  }
  if (girdiler.length > EN_COK_AUTH_ORIGIN) {
    throw new Error(`At most ${EN_COK_AUTH_ORIGIN} auth origins are allowed (got ${girdiler.length})`);
  }
  const gorulen = new Set<string>();
  for (const girdi of girdiler) {
    const origin = authOriginNormallestir(girdi);
    if (origin === baseOrigin) {
      throw new Error(`Invalid auth origin "${girdi}": it is the baseUrl origin, which is always allowed; do not list it`);
    }
    if (gorulen.has(origin)) throw new Error(`Invalid auth origin "${girdi}": ${origin} is listed twice`);
    gorulen.add(origin);
  }
  return [...gorulen].sort();
}

/** Diskteki proje ayarı; 0.1'in `beyin` alanı okunurken `brain`'e eşlenir. */
export const KobayConfigSemasi: v.GenericSchema<unknown, KobayConfig> = v.pipe(
  v.unknown(),
  v.transform(kalicidanEsle),
  v.object({
    baseUrl: v.string(),
    docsPath: v.exactOptional(v.string()),
    loginUrl: v.exactOptional(v.string()),
    authOrigins: v.exactOptional(v.array(v.string())),
    brain: BeyinAyariSemasi,
  }),
  // Elle düzenlenmiş liste de aynı kurallardan geçer; okunan liste normal ve sıralıdır.
  // Boş liste alan yokmuş gibi okunur.
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    const { authOrigins, ...kalan } = dataset.value;
    if (authOrigins === undefined) return dataset.value;
    try {
      const liste = authOriginleriDogrula(kalan.baseUrl, authOrigins);
      return liste.length === 0 ? kalan : { ...kalan, authOrigins: liste };
    } catch (hata: unknown) {
      addIssue({ message: hata instanceof Error ? hata.message : String(hata) });
      return NEVER;
    }
  }),
);

/** Diskteki giriş bilgisi; 0.1'in `kullanici`/`parola` alanları okunurken eşlenir. */
export const KimlikSemasi: v.GenericSchema<unknown, Kimlik> = v.pipe(
  v.unknown(),
  v.transform(kalicidanEsle),
  v.object({
    username: v.string(),
    password: v.string(),
    origin: v.exactOptional(v.string()),
    // Yoksa (0.2 kimliği) boş küme sayılır; karşılaştırma `kimlikOriginDogrula`'da.
    authOrigins: v.exactOptional(v.array(v.string())),
  }),
);

/** schemas/plan.schema.json ile aynı zorunlu alanlar ve sınırlar. */
export const PlanDosyasiSemasi: v.GenericSchema<unknown, PlanDosyasi> = v.looseObject({
  // Saklanmaz, projeyle eşlenmez; eski plan dosyaları bozulmasın diye yalnız
  // verilirse biçimi denetlenir.
  projectId: v.exactOptional(v.pipe(v.string(), v.minLength(1), v.regex(/\S/))),
  type: v.literal('frontend'),
  name: v.pipe(v.string(), v.minLength(1), v.regex(/\S/)),
  // Testin sayfası: `/yol` ya da baseUrl origin'inde tam adres. Origin denetimi
  // config'e bağlı olduğu için `test create` içinde yapılır.
  url: v.exactOptional(v.pipe(v.string(), v.minLength(1), v.regex(/\S/))),
  description: v.exactOptional(v.string()),
  priority: v.exactOptional(OncelikSemasi),
  planSteps: v.pipe(v.array(v.object({
    type: v.picklist(['action', 'assertion']),
    description: v.pipe(v.string(), v.minLength(1), v.regex(/\S/)),
  })), v.minLength(1), v.maxLength(200)),
});
