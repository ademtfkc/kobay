/**
 * Genel yüzey sözleşmesi (0.9.0 donma spec'i, D6). Donma listesindeki (Katman A) bir ad, alan ya da
 * kod değişirse bu dosya düşer. Yeni bayrak/alan eklemek kırıcı değildir ama burada da bilinçli
 * olarak yazılır; bir şeyi kaldırmak ya da adını değiştirmek 1.x içinde yapılmaz (README "Stability").
 */
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Command, Option } from 'commander';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { CIKIS } from '../../src/cli/cikis.js';
import { ciktiYaz, type BeyinOzeti } from '../../src/cli/cikti.js';
import type { KomutSonucu } from '../../src/cli/komut.js';
import { programOlustur } from '../../src/cli/index.js';
import { yazilanUyarilariSifirla } from '../../src/cli/uyari.js';
import { VARSAYILAN_AZAMI_MB, VARSAYILAN_BUDAMA_GUNU } from '../../src/depo/budama.js';
import { PlanDosyasiSemasi } from '../../src/depo/semalar.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';
import { OZET_ISARETI, VARSAYILAN_ISTEM_SAYISI } from '../../src/rapor/ozet.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

const kok = new URL('../../', import.meta.url);
/** Windows'ta git `core.autocrlf` ile CRLF çıkarır; satır kalıpları LF bekler. */
const dosyaOku = async (yol: string): Promise<string> =>
  (await readFile(new URL(yol, kok), 'utf8')).replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------------------------
// CLI

/** Komut yolu → argümanlar ve bayraklar (commander `flags` dizesi, kısa ad dahil). */
const CLI_SOZLESMESI: Record<string, { args: string[]; flags: string[] }> = {
  'kobay': { args: [], flags: ['-V, --version', '--output <format>', '--cwd <dir>'] },
  'kobay setup': { args: [], flags: ['--brain <adaptor>', '--model <model>', '--effort <effort>'] },
  'kobay install-browser': { args: [], flags: ['--with-deps'] },
  'kobay demo': { args: [], flags: ['--port <port>'] },
  'kobay project': { args: [], flags: [] },
  'kobay project create': {
    args: [],
    flags: [
      '--url <url>', '--docs <path>', '--login', '--login-url <url>', '--auth-origin <origin>',
      '--session-file <path>', '--force', '--brain <adaptor>', '--model <model>', '--effort <effort>',
    ],
  },
  'kobay project update': {
    args: [],
    flags: [
      '--url <url>', '--base-url <url>', '--login-url <url>', '--docs <path>', '--docs-path <path>',
      '--login', '--auth-origin <origin>', '--clear-auth-origins', '--brain <adaptor>', '--model <model>',
      '--effort <effort>',
    ],
  },
  'kobay project get': { args: [], flags: [] },
  'kobay explore': {
    args: [],
    flags: ['--seed <url>', '--no-sitemap', '--max-pages <n>', '--depth <n>', '--session-file <path>'],
  },
  'kobay prune': { args: [], flags: ['--dry-run', '--max-mb <mb>', '--older-than-days <days>'] },
  'kobay test': { args: [], flags: [] },
  'kobay test plan': { args: [], flags: [] },
  'kobay test plan generate': { args: [], flags: ['--hint <hint>'] },
  'kobay test plan accept': { args: [], flags: ['--all', '--ids <ids>'] },
  'kobay test create': { args: [], flags: ['--plan <path>'] },
  'kobay test list': { args: [], flags: [] },
  'kobay test get': { args: ['<id>'], flags: [] },
  'kobay test code': { args: [], flags: [] },
  'kobay test code get': { args: ['<id>'], flags: [] },
  'kobay test delete': { args: ['<id>'], flags: [] },
  'kobay test run': { args: ['[ids...]'], flags: ['--all', '--rerun', '--no-analysis'] },
  'kobay test rerun': { args: ['<id>'], flags: [] },
  'kobay test refresh': { args: ['<id>'], flags: ['--no-run'] },
  'kobay test result': { args: ['<id>'], flags: ['--history'] },
  'kobay test report': {
    args: ['[ids...]'],
    flags: ['--all', '--out <dir>', '--summary <path>', '--max-prompts <n>'],
  },
  'kobay test failure': { args: [], flags: [] },
  'kobay test failure get': { args: ['<id>'], flags: ['--out <dir>', '--include-trace'] },
  'kobay agent': { args: [], flags: [] },
  'kobay agent install': { args: [], flags: ['--target <target>'] },
  'kobay mcp': { args: [], flags: [] },
  'kobay doctor': { args: [], flags: [] },
};

/** Seçim listesi olan bayraklar (değer adları da donar). */
const CLI_SECIMLERI: Record<string, string[]> = {
  'kobay --output': ['text', 'json'],
  'kobay agent install --target': ['claude', 'codex', 'cursor'],
};

/** Varsayılanlar: commander'ın kendi varsayılanı ya da yardım metnindeki `(default: …)`. */
const CLI_VARSAYILANLARI: Record<string, string> = {
  'kobay --output': 'text',
  'kobay demo --port': '3000',
  'kobay explore --max-pages': '40',
  'kobay explore --depth': '3',
  'kobay test report --out': '.kobay/report',
  'kobay test report --max-prompts': '5',
  'kobay test failure get --out': '.kobay/failure-out/<id>',
};

/** Kullanımdan kalkmış adlar: README tablosunda değil, "Stability" bölümünde yazılır. */
const ESKI_BAYRAKLAR: Record<string, string[]> = {
  'kobay project update': ['--base-url', '--docs-path'],
};

function argumanMetni(arguman: { name: () => string; required: boolean; variadic: boolean }): string {
  const ad = `${arguman.name()}${arguman.variadic ? '...' : ''}`;
  return arguman.required ? `<${ad}>` : `[${ad}]`;
}

function komutlar(komut: Command, yol: string[] = []): Array<{ yol: string; komut: Command }> {
  const ad = [...yol, komut.name()];
  return [{ yol: ad.join(' '), komut }, ...komut.commands.flatMap((alt) => komutlar(alt, ad))];
}

function uzunAd(secenek: Option): string {
  return secenek.long ?? secenek.flags;
}

/** Yaprak komut: alt komutu olmayan (README tablosunda satırı olan) komut. */
function yapraklar(): Array<{ yol: string; komut: Command }> {
  return komutlar(programOlustur()).filter((k) => k.komut.commands.length === 0 && k.yol !== 'kobay');
}

describe('CLI sözleşmesi', () => {
  it('komut yolları, argümanlar ve bayraklar donma listesiyle aynı', () => {
    const gercek = Object.fromEntries(komutlar(programOlustur()).map(({ yol, komut }) => [yol, {
      args: komut.registeredArguments.map(argumanMetni),
      flags: komut.options.map((s) => s.flags),
    }]));
    expect(gercek).toEqual(CLI_SOZLESMESI);
  });

  it('seçim listeleri ve varsayılan değerler aynı', () => {
    const secimler: Record<string, string[]> = {};
    const varsayilanlar: Record<string, string> = {};
    for (const { yol, komut } of komutlar(programOlustur())) {
      for (const secenek of komut.options) {
        const anahtar = `${yol} ${uzunAd(secenek)}`;
        if (secenek.argChoices !== undefined) secimler[anahtar] = [...secenek.argChoices];
        if (secenek.negate || secenek.long === '--cwd') continue;
        const yardim = /\(default: ([^)]+?)(?:,[^)]*)?\)/.exec(secenek.description)?.[1];
        const deger = secenek.defaultValue === undefined ? yardim : String(secenek.defaultValue);
        if (deger !== undefined) varsayilanlar[anahtar] = deger;
      }
    }
    expect(secimler).toEqual(CLI_SECIMLERI);
    expect(varsayilanlar).toEqual(CLI_VARSAYILANLARI);
    // Yardımda yazmayan ama README'de belgeli varsayılanlar kodda sabittir.
    expect({ VARSAYILAN_AZAMI_MB, VARSAYILAN_BUDAMA_GUNU, VARSAYILAN_ISTEM_SAYISI })
      .toEqual({ VARSAYILAN_AZAMI_MB: 500, VARSAYILAN_BUDAMA_GUNU: 7, VARSAYILAN_ISTEM_SAYISI: 5 });
  });

  for (const readme of ['README.md', 'README.tr.md']) {
    it(`${readme} Commands tablosu CLI ile eşleşir (iki yön)`, async () => {
      const metin = await dosyaOku(readme);
      const bas = metin.search(/^### (Commands|Komutlar)$/m);
      expect(bas, readme).toBeGreaterThanOrEqual(0);
      const bolum = metin.slice(bas, metin.indexOf('\n### ', bas + 1));
      const satirlar = bolum.split('\n').filter((s) => /^\| `[a-z]/.test(s));
      const tablo = new Map<string, Set<string>>();
      for (const satir of satirlar) {
        const hucre = /^\| `([^`]+)`/.exec(satir)?.[1] ?? '';
        const yol = `kobay ${/^[a-z][a-z -]*?(?= \[| --| <|$)/.exec(hucre)?.[0].trim() ?? ''}`;
        const bayraklar = new Set(hucre.match(/--[a-z][a-z-]*/g) ?? []);
        if (CLI_SOZLESMESI[yol] !== undefined) tablo.set(yol, bayraklar);
      }

      const yaprakYollar = yapraklar().map((k) => k.yol).sort();
      expect([...tablo.keys()].sort()).toEqual(yaprakYollar);
      for (const { yol, komut } of yapraklar()) {
        const cli = komut.options.map(uzunAd);
        const eski = ESKI_BAYRAKLAR[yol] ?? [];
        const beklenen = cli.filter((b) => !eski.includes(b)).sort();
        expect({ yol, bayraklar: [...(tablo.get(yol) ?? [])].sort() }).toEqual({ yol, bayraklar: beklenen });
      }

      // Genel seçenekler satırı ve eski adların "Stability" tablosu.
      const genel = bolum.split('\n').find((s) => /^(Global options|Genel seçenekler):/.test(s)) ?? '';
      for (const secenek of programOlustur().options) expect(genel).toContain(uzunAd(secenek));
      for (const [yol, eskiler] of Object.entries(ESKI_BAYRAKLAR)) {
        for (const eski of eskiler) expect(metin).toContain(`| \`${yol.replace(/^kobay /, '')} ${eski}\` |`);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// MCP

/** Araç adı → giriş şemasındaki alanlar (sıra önemsiz) ve zorunlu alanlar. */
const MCP_SOZLESMESI: Record<string, { fields: string[]; required: string[] }> = {
  project_create: { fields: ['projectDir', 'url', 'docs', 'loginUser', 'loginUrl', 'force'], required: ['url'] },
  project_update: { fields: ['projectDir', 'baseUrl', 'loginUrl', 'docsPath', 'brain', 'model', 'effort'], required: [] },
  project_get: { fields: ['projectDir'], required: [] },
  prune: { fields: ['projectDir', 'dryRun', 'confirm', 'maxMb', 'olderThanDays'], required: [] },
  explore: { fields: ['projectDir', 'seeds', 'sitemap', 'maxPages', 'depth'], required: [] },
  plan_generate: { fields: ['projectDir', 'hint'], required: [] },
  plan_accept: { fields: ['projectDir', 'all', 'ids'], required: [] },
  test_create: { fields: ['projectDir', 'planPath'], required: ['planPath'] },
  test_list: { fields: ['projectDir'], required: [] },
  test_get: { fields: ['projectDir', 'id'], required: ['id'] },
  code_get: { fields: ['projectDir', 'id'], required: ['id'] },
  test_delete: { fields: ['projectDir', 'id'], required: ['id'] },
  test_run: { fields: ['projectDir', 'ids', 'all', 'rerun', 'noAnalysis'], required: [] },
  test_report: { fields: ['projectDir', 'ids', 'all', 'out', 'summary', 'maxPrompts'], required: [] },
  test_rerun: { fields: ['projectDir', 'id'], required: ['id'] },
  test_refresh: { fields: ['projectDir', 'id', 'run'], required: ['id'] },
  test_result: { fields: ['projectDir', 'id', 'history'], required: ['id'] },
  failure_get: { fields: ['projectDir', 'id', 'out', 'includeTrace'], required: ['id'] },
  doctor: { fields: ['projectDir'], required: [] },
};

describe('MCP sözleşmesi', () => {
  it('19 aracın adları, alanları ve zorunlu alanları donma listesiyle aynı', async () => {
    const sunucu = mcpSunucusuOlustur({ cwd: await geciciDizinAc('kobay-sozlesme-') });
    const istemci = new Client({ name: 'kobay-sozlesme', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([sunucu.connect(a), istemci.connect(b)]);
    try {
      const { tools } = await istemci.listTools();
      const gercek = Object.fromEntries(tools.map((arac) => [arac.name, {
        fields: Object.keys(arac.inputSchema.properties ?? {}).sort(),
        required: [...(arac.inputSchema.required ?? [])].sort(),
      }]));
      const beklenen = Object.fromEntries(Object.entries(MCP_SOZLESMESI).map(([ad, s]) => [ad, {
        fields: [...s.fields].sort(),
        required: [...s.required].sort(),
      }]));
      expect(gercek).toEqual(beklenen);
    } finally {
      await istemci.close();
      await sunucu.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// JSON zarfı ve çıkış kodları

function zarfYaz(sonuc: KomutSonucu, beyin?: BeyinOzeti): Record<string, unknown> {
  yazilanUyarilariSifirla();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let metin = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (parca: string) => { metin += parca; });
  ciktiYaz(sonuc, true, stdout, stderr, beyin);
  return JSON.parse(metin) as Record<string, unknown>;
}

describe('JSON zarfı ve çıkış kodları', () => {
  it('zarfın üst alanları ve alt alanları aynı', () => {
    const basari = zarfYaz({ exitCode: 0, json: { a: 1 } });
    expect(Object.keys(basari).sort()).toEqual(['data', 'exitCode', 'ok']);

    const hata = zarfYaz({ exitCode: 2, json: { error: { code: 'UsageError', message: 'x' } } });
    expect(Object.keys(hata).sort()).toEqual(['error', 'exitCode', 'ok']);
    expect(Object.keys(hata.error as object).sort()).toEqual(['code', 'message']);

    const tam = zarfYaz({
      exitCode: 0,
      json: {},
      uyarilar: [{ code: 'DEPRECATED', message: 'm', replacement: '--url' }],
    }, { calls: 2, costUsd: 0.5 });
    expect(Object.keys(tam).sort()).toEqual(['brain', 'data', 'exitCode', 'ok', 'warnings']);
    expect(tam.brain).toEqual({ calls: 2, costUsd: 0.5 });
    expect(tam.warnings).toEqual([{ code: 'DEPRECATED', message: 'm', replacement: '--url' }]);
    expect(zarfYaz({ exitCode: 0, json: {} }, { calls: 1, costUsd: null }).brain).toEqual({ calls: 1, costUsd: null });
  });

  it('çıkış kodları 0–5 ve README iki dilde aynı kodları listeler', async () => {
    expect(CIKIS).toEqual({ GECTI: 0, DUSTU: 1, KULLANIM: 2, HEDEF_YOK: 3, MOTOR: 4, YETKI: 5 });
    for (const [readme, baslik] of [['README.md', '**Exit codes:**'], ['README.tr.md', '**Çıkış kodları:**']] as const) {
      const metin = await dosyaOku(readme);
      const bas = metin.indexOf(baslik);
      expect(bas, readme).toBeGreaterThanOrEqual(0);
      // İlk cümle: kod listesi (sonraki cümleler kodlara yeniden değinebilir).
      const paragraf = metin.slice(bas, metin.indexOf('\n\n', bas)).split('. ')[0] ?? '';
      const kodlar = [...paragraf.matchAll(/`(\d)` /g)].map((m) => Number(m[1]));
      expect({ readme, kodlar }).toEqual({ readme, kodlar: [0, 1, 2, 3, 4, 5] });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// GitHub Action

/** action.yml'de iki boşluk girintili üst düzey bloğun anahtarları (YAML kütüphanesi eklemeden). */
function blokAnahtarlari(yaml: string, blok: string): string[] {
  const satirlar = yaml.split('\n');
  const bas = satirlar.indexOf(`${blok}:`);
  if (bas < 0) return [];
  const anahtarlar: string[] = [];
  for (const satir of satirlar.slice(bas + 1)) {
    if (/^\S/.test(satir)) break;
    const eslesme = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(satir);
    if (eslesme?.[1] !== undefined) anahtarlar.push(eslesme[1]);
  }
  return anahtarlar;
}

describe('GitHub Action sözleşmesi', () => {
  it('11 girdi, 3 çıktı, artifact adı ve yorum işareti aynı', async () => {
    const yaml = await dosyaOku('action.yml');
    expect(blokAnahtarlari(yaml, 'inputs')).toEqual([
      'version', 'node-version', 'working-directory', 'tests', 'wait-for-url', 'wait-timeout',
      'install-browser-deps', 'comment', 'upload-report', 'max-prompts', 'github-token',
    ]);
    expect(blokAnahtarlari(yaml, 'outputs')).toEqual(['exit-code', 'report-dir', 'summary-path']);
    // Çıktının anlamı: hangi adımın hangi çıktısına bağlı olduğu.
    const degerler = Object.fromEntries([...yaml.matchAll(/^ {2}([a-z-]+):\n {4}description: .*\n {4}value: (.+)$/gm)]
      .map((m) => [m[1], m[2]]));
    expect(degerler).toEqual({
      'exit-code': '${{ steps.run.outputs.exit-code }}',
      'report-dir': '${{ steps.report.outputs.report-dir }}',
      'summary-path': '${{ steps.report.outputs.summary-path }}',
    });
    expect(yaml).toMatch(/^ {8}name: kobay-report$/m);
    expect(OZET_ISARETI).toBe('<!-- kobay-report -->');
    expect(yaml).toContain(`startswith("${OZET_ISARETI}")`);
  });

  it('exit-code açıklaması 0–5 kodlarını, son adım 5 için ayrı kolu taşır', async () => {
    const yaml = await dosyaOku('action.yml');
    const aciklama = /^ {2}exit-code:\n {4}description: "([^"]+)"/m.exec(yaml)?.[1] ?? '';
    expect([...aciklama.matchAll(/\b(\d) [a-z]/g)].map((m) => Number(m[1]))).toEqual([0, 1, 2, 3, 4, 5]);
    const kollar = [...yaml.matchAll(/^ {10}(\d)\) echo/gm)].map((m) => Number(m[1]));
    expect(kollar).toEqual([0, 1, 3, 5]);
  });
});

// ---------------------------------------------------------------------------------------------
// Ortam değişkenleri

/** Kullanıcının verdiği değişkenler (Katman A). */
const KULLANICI_ORTAMI = [
  'KOBAY_LOGIN_USER', 'KOBAY_LOGIN_PASS', 'KOBAY_LOGIN_ORIGIN', 'KOBAY_MCP_ROOTS', 'KOBAY_MAX_BUDGET_USD',
  'KOBAY_MAX_BRAIN_CALLS', 'KOBAY_MAX_TOTAL_COST_USD', 'KOBAY_OPENROUTER_MAX_TOKENS', 'OPENROUTER_API_KEY',
  'OPENAI_API_KEY', 'CODEX_API_KEY',
];

/** kobay'ın üretilen test sürecine verdiği değişkenler (Katman A; üretilmiş testler bunlara bağlı). */
const TEST_ORTAMI = [
  'KOBAY_BASE_URL', 'KOBAY_RUN_DIR', 'KOBAY_REPORT_FILE', 'KOBAY_TEST_TIMEOUT_MS', 'KOBAY_ACTION_TIMEOUT_MS',
  'KOBAY_STORAGE_STATE',
];

async function kaynakMetni(): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const dosyalar = await readdir(new URL('src/', kok), { recursive: true });
  const metinler = await Promise.all(dosyalar.filter((d) => d.endsWith('.ts')).map((d) => dosyaOku(`src/${d}`)));
  return metinler.join('\n');
}

describe('ortam değişkeni sözleşmesi', () => {
  it('kullanıcı değişkenlerinin her biri kaynakta okunur', async () => {
    const kaynak = await kaynakMetni();
    const eksik = KULLANICI_ORTAMI.filter((ad) => !new RegExp(`(env\\.${ad}\\b|['"\`]${ad}['"\`])`).test(kaynak));
    expect(eksik).toEqual([]);
  });

  it('test sürecine verilen değişkenler koşucuda aynı adla kurulur', async () => {
    const kosucu = await dosyaOku('src/kos/index.ts');
    const anahtarlar = [...kosucu.matchAll(/^\s+(?:\.\.\.\(.*\{ )?(KOBAY_[A-Z_]+):/gm)].map((m) => m[1]);
    expect([...new Set(anahtarlar)].sort()).toEqual([...TEST_ORTAMI].sort());
  });

  for (const readme of ['README.md', 'README.tr.md']) {
    it(`${readme} Stability bölümü bütün donmuş değişkenleri adlandırır`, async () => {
      const metin = await dosyaOku(readme);
      const bas = metin.search(/^## (Stability|Kararlılık)$/m);
      expect(bas, readme).toBeGreaterThanOrEqual(0);
      const bolum = metin.slice(bas, metin.indexOf('\n## ', bas + 1));
      expect([...KULLANICI_ORTAMI, ...TEST_ORTAMI].filter((ad) => !bolum.includes(`\`${ad}\``))).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// schemas/plan.schema.json ↔ valibot doğrulayıcısı

interface JsonSema {
  required?: string[];
  properties?: Record<string, JsonSema & { const?: string; enum?: string[]; pattern?: string }>;
  minItems?: number;
  maxItems?: number;
  items?: JsonSema;
}

const gecerliPlan = (): Record<string, unknown> => ({
  projectId: 'demo',
  type: 'frontend',
  name: 'Record list shows saved records',
  url: '/records',
  description: 'free text',
  priority: 'p1',
  planSteps: [{ type: 'action', description: 'Open /records' }],
});

const gecerMi = (girdi: unknown): boolean => v.safeParse(PlanDosyasiSemasi, girdi).success;

describe('plan.schema.json ↔ valibot', () => {
  it('alan adları, zorunlu alanlar, seçimler ve sınırlar aynı davranır', async () => {
    const sema = JSON.parse(await dosyaOku('schemas/plan.schema.json')) as JsonSema;
    const ozellikler = sema.properties ?? {};
    const girdiler = (PlanDosyasiSemasi as unknown as { entries: Record<string, unknown> }).entries;
    expect(Object.keys(girdiler).sort()).toEqual(Object.keys(ozellikler).sort());
    expect(gecerMi(gecerliPlan())).toBe(true);

    for (const [alan, ozellik] of Object.entries(ozellikler)) {
      const eksik = gecerliPlan();
      delete eksik[alan];
      expect({ alan, gecer: gecerMi(eksik) }).toEqual({ alan, gecer: !(sema.required ?? []).includes(alan) });

      const degerler = ozellik.enum ?? (ozellik.const === undefined ? [] : [ozellik.const]);
      for (const deger of degerler) expect({ alan, deger, gecer: gecerMi({ ...gecerliPlan(), [alan]: deger }) }).toEqual({ alan, deger, gecer: true });
      if (degerler.length > 0) expect({ alan, gecer: gecerMi({ ...gecerliPlan(), [alan]: 'zz' }) }).toEqual({ alan, gecer: false });
      if (ozellik.pattern === '\\S') expect({ alan, gecer: gecerMi({ ...gecerliPlan(), [alan]: '   ' }) }).toEqual({ alan, gecer: false });
    }

    const adimlar = ozellikler.planSteps ?? {};
    const adim = { type: 'action', description: 'x' };
    const adimli = (n: number): boolean => gecerMi({ ...gecerliPlan(), planSteps: Array.from({ length: n }, () => adim) });
    expect([adimli((adimlar.minItems ?? 1) - 1), adimli(adimlar.minItems ?? 1), adimli(adimlar.maxItems ?? 0), adimli((adimlar.maxItems ?? 0) + 1)])
      .toEqual([false, true, true, false]);

    const adimSemasi = adimlar.items ?? {};
    for (const [alan, ozellik] of Object.entries(adimSemasi.properties ?? {})) {
      const eksik: Record<string, unknown> = { ...adim };
      delete eksik[alan];
      expect({ alan, gecer: gecerMi({ ...gecerliPlan(), planSteps: [eksik] }) })
        .toEqual({ alan, gecer: !(adimSemasi.required ?? []).includes(alan) });
      for (const deger of ozellik.enum ?? []) expect(gecerMi({ ...gecerliPlan(), planSteps: [{ ...adim, [alan]: deger }] })).toBe(true);
      if (ozellik.enum !== undefined) expect(gecerMi({ ...gecerliPlan(), planSteps: [{ ...adim, [alan]: 'zz' }] })).toBe(false);
      if (ozellik.pattern === '\\S') expect(gecerMi({ ...gecerliPlan(), planSteps: [{ ...adim, [alan]: '   ' }] })).toBe(false);
    }
  });
});
