export type Oncelik = 'p0' | 'p1' | 'p2' | 'p3';

export interface PlanAdimi {
  type: 'action' | 'assertion';
  description: string;
}

export interface FormAlani {
  name: string;
  type: string;
  label?: string;
  placeholder?: string;
}

export interface Form {
  action?: string;
  fields: FormAlani[];
}

export interface Sayfa {
  url: string;
  title: string;
  headings: string[];
  links: string[];
  forms: Form[];
  buttons: string[];
  menu: string[];
}

export interface Harita {
  baseUrl: string;
  loggedIn: boolean;
  pages: Sayfa[];
  exploredAt: string;
}

export interface Oneri {
  proposalId: string;
  title: string;
  description: string;
  priority: Oncelik;
  category: string;
  feature: string;
  type: 'frontend';
  url: string;
  steps: PlanAdimi[];
}

export type TestDurumu =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'unknown';

export interface TestKaydi {
  id: string;
  name: string;
  type: 'frontend';
  createdFrom: 'cli' | 'mcp' | 'plan';
  status: TestDurumu;
  planSteps: PlanAdimi[];
  priority: Oncelik;
  url?: string;
  codeVersion: number;
  lastRunId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type FailureKind = 'product_bug' | 'product_changed' | 'test_bug' | 'env' | 'flaky' | 'unknown';
export type Verdict = 'passed' | 'failed' | 'blocked' | 'inconclusive';

export interface HaritaFarki {
  url: string;
  addedHeadings: string[];
  removedHeadings: string[];
  addedButtons: string[];
  removedButtons: string[];
  addedFormFields: string[];
  removedFormFields: string[];
  /** Kaydedilmiş DOM hâlâ keşifteki sayfayı mı gösteriyor (false ise ortam şüphelisi). */
  pageIdentityMatches: boolean;
  changed: boolean;
}

export interface AdimSonucu {
  stepIndex: number;
  description: string;
  status: 'passed' | 'failed' | 'skipped';
  screenshotPath?: string;
  htmlPath?: string;
  errorMessage?: string;
  durationMs: number;
}

export interface KosuSonucu {
  testId: string;
  runId: string;
  status: TestDurumu;
  verdict: Verdict;
  startedAt: string;
  finishedAt: string;
  codeVersion: number;
  failedStepIndex?: number;
  failureKind?: FailureKind;
  errorMessage?: string;
}

export interface Kanit {
  kind: 'screenshot' | 'snapshot' | 'console' | 'network' | 'log';
  stepIndex: number;
  path: string;
  summary: string;
}

export interface HataAnalizi {
  rootCauseHypothesis: string;
  failureKind: FailureKind;
  recommendedFixTarget: {
    kind: 'code' | 'selector' | 'data' | 'env' | 'unknown';
    reference: string;
    rationale: string;
  };
  evidence: Kanit[];
}

export interface HataPaketi {
  snapshotId: string;
  testId: string;
  runId: string;
  result: KosuSonucu;
  steps: AdimSonucu[];
  code: string;
  failure: HataAnalizi;
  mapDiff?: HaritaFarki;
}

export interface BeyinAyari {
  adaptor: 'claude' | 'codex' | 'openrouter' | 'sahte';
  model?: string;
  effort?: string;
  /** Claude CLI tek çağrı harcama tavanı. */
  maxBudgetUsd?: number;
  /** Tek kobay sürecinin yapabileceği gerçek dış servis çağrısı sayısı. */
  maxCalls?: number;
  /** Tek kobay sürecinin gerçekleşen ve devam eden çağrılar için rezerve edilen toplam maliyet tavanı. */
  maxTotalCostUsd?: number;
  /** OpenRouter yanıt token tavanı. */
  maxTokens?: number;
}

export interface KobayConfig {
  baseUrl: string;
  docsPath?: string;
  loginUrl?: string;
  brain: BeyinAyari;
}

export interface Kimlik {
  username: string;
  password: string;
  /**
   * Kimliğin verildiği hedef origin'i. Parola yalnız bu origin'e yazılır;
   * eski biçimde (origin'siz) kayıtlı kimlik hiçbir yere gönderilmez.
   */
  origin?: string;
}

/** Elle yazılan plan dosyasının uygulama içi görünümü. */
export interface PlanDosyasi {
  projectId: string;
  type: 'frontend';
  name: string;
  description?: string;
  priority?: Oncelik;
  planSteps: PlanAdimi[];
}
