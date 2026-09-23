import { realpathSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  codeGet,
  doctor,
  explore,
  failureGet,
  planAccept,
  planGenerate,
  projectCreate,
  projectGet,
  projectUpdate,
  testCreate,
  testDelete,
  testGet,
  testList,
  testRefresh,
  testResult,
  testRerun,
  testRun,
} from '../cli/komutlar/index.js';
import {
  enYakinVarolanYol,
  hataPaketiVarsayilanYol,
  hataPaketiYoluDenetle,
} from '../cli/komutlar/ortak.js';
import type { KomutSonucu } from '../cli/komut.js';
import { CIKIS } from '../cli/cikis.js';
import { KobayDizini } from '../depo/index.js';

interface McpAyarlari {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

const require = createRequire(import.meta.url);
const { version: KOBAY_SURUMU } = require('../../package.json') as { version: string };
const PROJE_DIZINI_SEMASI = { projectDir: z.string().min(1).optional() };

export const MCP_INSTRUCTIONS = 'Use project_create once to initialize a target, then explore, plan_generate, and plan_accept. Use test_run to generate and run tests; inspect failures with failure_get, fix product code for product_bug, use test_refresh only for product_changed, and confirm with test_rerun. Pass projectDir when the server is not started inside the target Kobay project.';

/**
 * MCP'de `isError` aracın yürütülemediğini söyler, sonucun kötü olduğunu değil.
 * "Test düştü" (exit 1) geçerli bir yürütme sonucudur: bazı istemciler
 * `isError`'ı akış kesen hata sayıp verdict'i ajana hiç göstermez. Bu yüzden
 * yalnız exit 0 ve 1 hatasız döner; kullanım (2), hedef yok (3), motor/beyin
 * (4) ve yetki (5) gerçek araç hatasıdır — hiçbiri bir verdict taşımaz, hepsi
 * ajanın koşudan önce düzeltmesi gereken bir durumu anlatır.
 */
function sonucDon(sonuc: KomutSonucu): {
  content: [{ type: 'text'; text: string }];
  isError?: true;
} {
  const aracHatasi = sonuc.exitCode !== CIKIS.GECTI && sonuc.exitCode !== CIKIS.DUSTU;
  const yanit = {
    content: [{ type: 'text' as const, text: JSON.stringify(sonuc.json) ?? 'null' }] as [{ type: 'text'; text: string }],
    ...(aracHatasi ? { isError: true as const } : {}),
  };
  return yanit;
}

function hataDon(hata: unknown): ReturnType<typeof sonucDon> {
  const mesaj = hata instanceof Error ? hata.message : String(hata);
  return { content: [{ type: 'text', text: JSON.stringify({ hata: mesaj }) }], isError: true };
}

async function aracCalistir(islem: () => Promise<KomutSonucu>): Promise<ReturnType<typeof sonucDon>> {
  try {
    return sonucDon(await islem());
  } catch (hata) {
    return hataDon(hata);
  }
}

function yolKokIcindeMi(kok: string, yol: string): boolean {
  const fark = relative(kok, yol);
  return fark === '' || (fark !== '..' && !fark.startsWith(`..${sep}`) && !isAbsolute(fark));
}

/** Hem `..` kaçışını hem de var olan symlink atlamalarını proje kökünde tutar. */
async function projeIciYol(projeKoku: string, giris: string, alan: string): Promise<string> {
  const cozulmusKok = resolve(projeKoku);
  const hedef = isAbsolute(giris) ? resolve(giris) : resolve(cozulmusKok, giris);
  if (!yolKokIcindeMi(cozulmusKok, hedef)) throw new Error(`${alan} proje kökü dışında olamaz`);

  const [gercekKok, varolan] = await Promise.all([realpath(cozulmusKok), enYakinVarolanYol(hedef)]);
  const gercekVarolan = await realpath(varolan);
  if (!yolKokIcindeMi(gercekKok, gercekVarolan)) throw new Error(`${alan} proje kökü dışında olamaz`);
  return hedef;
}

function mcpKokleriniDondur(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const girdiler = [cwd, ...(env.KOBAY_MCP_ROOTS ?? '').split(delimiter).filter((yol) => yol !== '')];
  return girdiler.map((girdi) => {
    const kok = realpathSync(resolve(cwd, girdi));
    if (!statSync(kok).isDirectory()) throw new Error(`MCP kökü dizin değil: ${girdi}`);
    return kok;
  });
}

function mcpKokundeDogrula(izinliKokler: string[], yol: string): void {
  if (!izinliKokler.some((kok) => yolKokIcindeMi(kok, yol))) {
    throw new Error(`projectDir izin verilen MCP kökleri dışında: ${yol}`);
  }
}

async function projeKokuSec(
  cwd: string,
  izinliKokler: string[],
  projectDir: string | undefined,
  olusturulacak = false,
): Promise<string> {
  const aday = resolve(cwd, projectDir ?? '.');
  const bilgi = await stat(aday).catch(() => null);
  if (bilgi === null || !bilgi.isDirectory()) throw new Error(`Proje dizini bulunamadı: ${aday}`);
  const gercekAday = await realpath(aday);
  mcpKokundeDogrula(izinliKokler, gercekAday);
  if (olusturulacak) return gercekAday;

  const dizin = await KobayDizini.bul(gercekAday);
  if (dizin === null) throw new Error(`Dizin bir Kobay projesinde değil: ${aday}`);
  await dizin.configOku();
  mcpKokundeDogrula(izinliKokler, dizin.projeKoku);
  return dizin.projeKoku;
}

/**
 * Ortamdaki parola yalnız sunucu ortamındaki KOBAY_LOGIN_ORIGIN adresine bağlanır;
 * adres araç girdisinden asla alınmaz. Böylece sayfa içeriğiyle yönlendirilen bir
 * ajan yeni bir projede kötü bir adres verip parolayı oraya bağlayamaz.
 */
function girisBilgisi(
  env: NodeJS.ProcessEnv,
  loginUser: string | undefined,
  url: string,
): { login?: { kullanici: string; parola: string } } {
  if (loginUser === undefined) return {};
  const izinli = env.KOBAY_LOGIN_ORIGIN;
  if (izinli === undefined || izinli === '') {
    throw new Error(
      'loginUser için KOBAY_LOGIN_ORIGIN tanımlı değil: parolanın gönderilebileceği adresi (ör. http://localhost:3000)'
      + ' MCP sunucusunu başlattığınız ortamda KOBAY_LOGIN_ORIGIN olarak ayarlayın',
    );
  }
  let izinliOrigin: string;
  let hedefOrigin: string;
  try {
    izinliOrigin = new URL(izinli).origin;
  } catch {
    throw new Error(`KOBAY_LOGIN_ORIGIN geçerli bir URL değil: ${izinli}`);
  }
  try {
    hedefOrigin = new URL(url).origin;
  } catch {
    throw new Error(`Geçersiz URL: ${url}`);
  }
  if (hedefOrigin !== izinliOrigin) {
    throw new Error(
      `Giriş bilgisi yalnız KOBAY_LOGIN_ORIGIN (${izinliOrigin}) için verilebilir; istenen ${hedefOrigin}.`
      + ' Bu adres doğruysa MCP sunucusunun ortamında KOBAY_LOGIN_ORIGIN değerini değiştirin',
    );
  }
  const parola = env.KOBAY_LOGIN_PASS;
  if (parola === undefined || parola === '') {
    throw new Error('Parola ortam değişkeni tanımlı değil: KOBAY_LOGIN_PASS');
  }
  return { login: { kullanici: loginUser, parola } };
}

/**
 * Ortamdaki parola MCP üzerinden başka bir origin'e yeniden bağlanamaz: projede
 * başka origin'e ait kayıtlı giriş bilgisi varsa ajan onu `project_create` ile
 * yeni adrese taşıyamaz. Yeni origin için giriş bilgisini kullanıcı CLI'dan verir.
 */
async function kimlikBaskaOrigineTasinmaz(cwd: string, url: string): Promise<void> {
  const dizin = await KobayDizini.bul(cwd);
  if (dizin === null) return;
  const kimlik = await dizin.kimlikOku().catch(() => null);
  let yeniOrigin: string;
  try {
    yeniOrigin = new URL(url).origin;
  } catch {
    return; // Geçersiz URL'yi projectCreate açık hatayla reddeder.
  }
  if (kimlik !== null && kimlik.origin !== yeniOrigin) {
    throw new Error(
      `Kayıtlı giriş bilgisi ${kimlik.origin ?? 'bilinmeyen bir adres'} için; MCP üzerinden ${yeniOrigin} adresine`
      + ' taşınamaz. Kullanıcı terminalde `kobay project create --url <URL> --login --force` çalıştırmalı',
    );
  }
}

/** MCP araçlarını oluşturur; transport bağlamaz, testlerde doğrudan kullanılabilir. */
export function mcpSunucusuOlustur(s: McpAyarlari): McpServer {
  const env = s.env ?? process.env;
  const izinliKokler = mcpKokleriniDondur(s.cwd, env);
  const projeSec = (projectDir: string | undefined, olusturulacak = false): Promise<string> => (
    projeKokuSec(s.cwd, izinliKokler, projectDir, olusturulacak)
  );
  const sunucu = new McpServer(
    { name: 'kobay', version: KOBAY_SURUMU },
    { instructions: MCP_INSTRUCTIONS },
  );

  sunucu.registerTool('project_create', {
    description: 'Hedef proje için Kobay dizinini ve isteğe bağlı giriş bilgilerini oluşturur.',
    inputSchema: z.strictObject({
      ...PROJE_DIZINI_SEMASI,
      url: z.string(),
      docs: z.string().optional(),
      loginUser: z.string().optional(),
      loginUrl: z.string().optional(),
      force: z.boolean().optional(),
    }),
  }, async ({ projectDir, url, docs, loginUser, loginUrl, force }) => aracCalistir(async () => {
    const giris = girisBilgisi(env, loginUser, url);
    const cwd = await projeSec(projectDir, true);
    if (docs !== undefined) await projeIciYol(cwd, docs, 'docs');
    if (loginUser !== undefined) await kimlikBaskaOrigineTasinmaz(cwd, url);
    return projectCreate({
      cwd,
      url,
      ...(docs === undefined ? {} : { docs }),
      ...giris,
      ...(loginUrl === undefined ? {} : { loginUrl }),
      ...(force === undefined ? {} : { force }),
    });
  }));

  sunucu.registerTool('project_update', {
    description: 'Mevcut Kobay projesinin yapılandırmasında yalnız verilen alanları günceller.',
    inputSchema: {
      ...PROJE_DIZINI_SEMASI,
      baseUrl: z.string().optional(),
      loginUrl: z.string().optional(),
      docsPath: z.string().optional(),
      beyin: z.enum(['claude', 'codex', 'openrouter']).optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
    },
  }, async ({ projectDir, baseUrl, loginUrl, docsPath, beyin, model, effort }) => aracCalistir(async () => {
    const cwd = await projeSec(projectDir);
    if (docsPath !== undefined) await projeIciYol(cwd, docsPath, 'docsPath');
    return projectUpdate({
      cwd,
      ...(baseUrl === undefined ? {} : { url: baseUrl }),
      ...(loginUrl === undefined ? {} : { loginUrl }),
      ...(docsPath === undefined ? {} : { docs: docsPath }),
      ...(beyin === undefined && model === undefined && effort === undefined ? {} : {
        beyin: {
          ...(beyin === undefined ? {} : { adaptor: beyin }),
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
        },
      }),
    });
  }));

  sunucu.registerTool('project_get', {
    description: 'Mevcut Kobay projesinin yapılandırmasını ve durum özetini döndürür.',
    inputSchema: PROJE_DIZINI_SEMASI,
  }, async ({ projectDir }) => aracCalistir(async () => projectGet({ cwd: await projeSec(projectDir) })));

  sunucu.registerTool('explore', {
    description: 'Hedef uygulamayı keşfedip sayfa haritasını günceller.',
    inputSchema: PROJE_DIZINI_SEMASI,
  }, async ({ projectDir }) => aracCalistir(async () => explore({ cwd: await projeSec(projectDir) })));

  sunucu.registerTool('plan_generate', {
    description: 'Keşif verilerinden test önerileri üretir.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, hint: z.string().optional() },
  }, async ({ projectDir, hint }) => aracCalistir(async () => planGenerate({
    cwd: await projeSec(projectDir),
    ...(hint === undefined ? {} : { hint }),
  })));

  sunucu.registerTool('plan_accept', {
    description: 'Üretilen test önerilerinin tümünü veya seçilenlerini kabul eder.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, all: z.boolean().optional(), ids: z.array(z.string()).optional() },
  }, async ({ projectDir, all, ids }) => aracCalistir(async () => planAccept({
    cwd: await projeSec(projectDir),
    ...(all === undefined ? {} : { all }),
    ...(ids === undefined ? {} : { ids }),
  })));

  sunucu.registerTool('test_create', {
    description: 'Bir plan JSON dosyasından test kaydı oluşturur.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, planPath: z.string() },
  }, async ({ projectDir, planPath }) => aracCalistir(async () => {
    const cwd = await projeSec(projectDir);
    return testCreate({ cwd, planPath: await projeIciYol(cwd, planPath, 'planPath') });
  }));

  sunucu.registerTool('test_list', {
    description: 'Projede kayıtlı testleri listeler.',
    inputSchema: PROJE_DIZINI_SEMASI,
  }, async ({ projectDir }) => aracCalistir(async () => testList({ cwd: await projeSec(projectDir) })));

  sunucu.registerTool('test_get', {
    description: 'Belirtilen test kaydını döndürür.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string() },
  }, async ({ projectDir, id }) => aracCalistir(async () => testGet({ cwd: await projeSec(projectDir), id })));

  sunucu.registerTool('code_get', {
    description: 'Testin üretilmiş Playwright kodunu döndürür; kod yoksa test_run ile üretilmesi gerekir.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string() },
  }, async ({ projectDir, id }) => aracCalistir(async () => codeGet({ cwd: await projeSec(projectDir), id })));

  sunucu.registerTool('test_delete', {
    description: 'Test kaydını ve üretilmiş kodunu siler.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string() },
  }, async ({ projectDir, id }) => aracCalistir(async () => testDelete({ cwd: await projeSec(projectDir), id })));

  sunucu.registerTool('test_run', {
    description: 'Kodu yoksa üretir, koşturur, düşerse analiz eder; exit 1 = test düştü, 3 = hedef kapalı, 4 = motor.',
    inputSchema: {
      ...PROJE_DIZINI_SEMASI,
      ids: z.array(z.string()).optional(),
      all: z.boolean().optional(),
      rerun: z.boolean().optional(),
    },
  }, async ({ projectDir, ids, all, rerun }) => aracCalistir(async () => testRun({
    cwd: await projeSec(projectDir),
    ...(ids === undefined ? {} : { ids }),
    ...(all === undefined ? {} : { all }),
    ...(rerun === undefined ? {} : { rerun }),
  })));

  sunucu.registerTool('test_rerun', {
    description: 'Mevcut test kodunu yeniden koşturur.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string() },
  }, async ({ projectDir, id }) => aracCalistir(async () => testRerun({ cwd: await projeSec(projectDir), id })));

  sunucu.registerTool('test_refresh', {
    description: 'failureKind product_changed ise: testin sayfasını yeniden keşfeder, haritayı yerinde günceller, plan adımlarını yeni arayüze uyarlar, testi taslağa çeker ve (run false değilse) yeniden üretip koşturur.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string(), run: z.boolean().optional() },
  }, async ({ projectDir, id, run }) => aracCalistir(async () => testRefresh({
    cwd: await projeSec(projectDir),
    id,
    ...(run === undefined ? {} : { run }),
  })));

  sunucu.registerTool('test_result', {
    description: 'Bir testin son koşu sonucunu veya koşu geçmişini döndürür.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string(), history: z.boolean().optional() },
  }, async ({ projectDir, id, history }) => aracCalistir(async () => testResult({
    cwd: await projeSec(projectDir),
    id,
    ...(history === undefined ? {} : { history }),
  })));

  sunucu.registerTool('failure_get', {
    description: 'Bir testin hata paketini belirtilen klasöre kopyalar; out verilmezse .kobay/failure-out/<id> (aynı test için sabit yol, içerik yenilenir).',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string(), out: z.string().optional() },
  }, async ({ projectDir, id, out }) => aracCalistir(async () => {
    const cwd = await projeSec(projectDir);
    const istenen = out ?? await hataPaketiVarsayilanYol(cwd, id);
    const hedef = await projeIciYol(cwd, istenen, 'out');
    // Yazma hedefi: .git/, .claude/, .kobay/ gizli; tek istisna .kobay/failure-out/ (git'e girmez).
    await hataPaketiYoluDenetle(cwd, hedef, 'out');
    return failureGet({ cwd, id, out: hedef });
  }));

  sunucu.registerTool('doctor', {
    description: 'Kobay kurulumu, hedefi ve çalışma ortamını denetler.',
    inputSchema: PROJE_DIZINI_SEMASI,
  }, async ({ projectDir }) => aracCalistir(async () => doctor({ cwd: await projeSec(projectDir) })));

  return sunucu;
}

/** MCP sunucusunu stdio transport ile başlatır. İnsan çıktısı stdout'a yazılmaz. */
export async function mcpSunucusuBaslat(s: McpAyarlari): Promise<void> {
  const sunucu = mcpSunucusuOlustur(s);
  await sunucu.connect(new StdioServerTransport());
}
