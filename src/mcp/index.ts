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
  return { content: [{ type: 'text', text: JSON.stringify({ error: mesaj }) }], isError: true };
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
  if (!yolKokIcindeMi(cozulmusKok, hedef)) throw new Error(`${alan} cannot be outside the project root`);

  const [gercekKok, varolan] = await Promise.all([realpath(cozulmusKok), enYakinVarolanYol(hedef)]);
  const gercekVarolan = await realpath(varolan);
  if (!yolKokIcindeMi(gercekKok, gercekVarolan)) throw new Error(`${alan} cannot be outside the project root`);
  return hedef;
}

function mcpKokleriniDondur(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const girdiler = [cwd, ...(env.KOBAY_MCP_ROOTS ?? '').split(delimiter).filter((yol) => yol !== '')];
  return girdiler.map((girdi) => {
    const kok = realpathSync(resolve(cwd, girdi));
    if (!statSync(kok).isDirectory()) throw new Error(`MCP root is not a directory: ${girdi}`);
    return kok;
  });
}

function mcpKokundeDogrula(izinliKokler: string[], yol: string): void {
  if (!izinliKokler.some((kok) => yolKokIcindeMi(kok, yol))) {
    throw new Error(`projectDir is outside the allowed MCP roots: ${yol}`);
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
  if (bilgi === null || !bilgi.isDirectory()) throw new Error(`Project directory not found: ${aday}`);
  const gercekAday = await realpath(aday);
  mcpKokundeDogrula(izinliKokler, gercekAday);
  if (olusturulacak) return gercekAday;

  const dizin = await KobayDizini.bul(gercekAday);
  if (dizin === null) throw new Error(`Directory is not inside a Kobay project: ${aday}`);
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
): { login?: { username: string; password: string } } {
  if (loginUser === undefined) return {};
  const izinli = env.KOBAY_LOGIN_ORIGIN;
  if (izinli === undefined || izinli === '') {
    throw new Error(
      'KOBAY_LOGIN_ORIGIN is not set for loginUser: set the address the password may be sent to'
      + ' (for example http://localhost:3000) as KOBAY_LOGIN_ORIGIN in the environment that starts the MCP server',
    );
  }
  let izinliOrigin: string;
  let hedefOrigin: string;
  try {
    izinliOrigin = new URL(izinli).origin;
  } catch {
    throw new Error(`KOBAY_LOGIN_ORIGIN is not a valid URL: ${izinli}`);
  }
  try {
    hedefOrigin = new URL(url).origin;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (hedefOrigin !== izinliOrigin) {
    throw new Error(
      `Credentials may only be given for KOBAY_LOGIN_ORIGIN (${izinliOrigin}); ${hedefOrigin} was requested.`
      + ' If that address is correct, change KOBAY_LOGIN_ORIGIN in the MCP server environment',
    );
  }
  const parola = env.KOBAY_LOGIN_PASS;
  if (parola === undefined || parola === '') {
    throw new Error('The password environment variable is not set: KOBAY_LOGIN_PASS');
  }
  return { login: { username: loginUser, password: parola } };
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
      `The saved credentials belong to ${kimlik.origin ?? 'an unknown address'}; they cannot be moved to`
      + ` ${yeniOrigin} over MCP. The user must run \`kobay project create --url <URL> --login --force\` in a terminal`,
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
    description: 'Creates the Kobay directory for a target project, plus optional login credentials.',
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
    description: 'Updates only the given fields in the existing Kobay project configuration.',
    inputSchema: {
      ...PROJE_DIZINI_SEMASI,
      baseUrl: z.string().optional(),
      loginUrl: z.string().optional(),
      docsPath: z.string().optional(),
      brain: z.enum(['claude', 'codex', 'openrouter']).optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
    },
  }, async ({ projectDir, baseUrl, loginUrl, docsPath, brain, model, effort }) => aracCalistir(async () => {
    const cwd = await projeSec(projectDir);
    if (docsPath !== undefined) await projeIciYol(cwd, docsPath, 'docsPath');
    return projectUpdate({
      cwd,
      ...(baseUrl === undefined ? {} : { url: baseUrl }),
      ...(loginUrl === undefined ? {} : { loginUrl }),
      ...(docsPath === undefined ? {} : { docs: docsPath }),
      ...(brain === undefined && model === undefined && effort === undefined ? {} : {
        beyin: {
          ...(brain === undefined ? {} : { adaptor: brain }),
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
        },
      }),
    });
  }));

  sunucu.registerTool('project_get', {
    description: 'Returns the configuration and status summary of the current Kobay project.',
    inputSchema: PROJE_DIZINI_SEMASI,
  }, async ({ projectDir }) => aracCalistir(async () => projectGet({ cwd: await projeSec(projectDir) })));

  sunucu.registerTool('explore', {
    description: 'Explores the target app and updates the page map.',
    inputSchema: PROJE_DIZINI_SEMASI,
  }, async ({ projectDir }) => aracCalistir(async () => explore({ cwd: await projeSec(projectDir) })));

  sunucu.registerTool('plan_generate', {
    description: 'Generates test proposals from the exploration data.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, hint: z.string().optional() },
  }, async ({ projectDir, hint }) => aracCalistir(async () => planGenerate({
    cwd: await projeSec(projectDir),
    ...(hint === undefined ? {} : { hint }),
  })));

  sunucu.registerTool('plan_accept', {
    description: 'Accepts all of the generated test proposals, or the selected ones.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, all: z.boolean().optional(), ids: z.array(z.string()).optional() },
  }, async ({ projectDir, all, ids }) => aracCalistir(async () => planAccept({
    cwd: await projeSec(projectDir),
    ...(all === undefined ? {} : { all }),
    ...(ids === undefined ? {} : { ids }),
  })));

  sunucu.registerTool('test_create', {
    description: 'Creates a test record from a plan JSON file.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, planPath: z.string() },
  }, async ({ projectDir, planPath }) => aracCalistir(async () => {
    const cwd = await projeSec(projectDir);
    return testCreate({ cwd, planPath: await projeIciYol(cwd, planPath, 'planPath') });
  }));

  sunucu.registerTool('test_list', {
    description: 'Lists the tests saved in the project.',
    inputSchema: PROJE_DIZINI_SEMASI,
  }, async ({ projectDir }) => aracCalistir(async () => testList({ cwd: await projeSec(projectDir) })));

  sunucu.registerTool('test_get', {
    description: 'Returns the given test record.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string() },
  }, async ({ projectDir, id }) => aracCalistir(async () => testGet({ cwd: await projeSec(projectDir), id })));

  sunucu.registerTool('code_get', {
    description: 'Returns the generated Playwright code of a test; when there is no code, generate it with test_run.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string() },
  }, async ({ projectDir, id }) => aracCalistir(async () => codeGet({ cwd: await projeSec(projectDir), id })));

  sunucu.registerTool('test_delete', {
    description: 'Deletes a test record and its generated code.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string() },
  }, async ({ projectDir, id }) => aracCalistir(async () => testDelete({ cwd: await projeSec(projectDir), id })));

  sunucu.registerTool('test_run', {
    description: 'Generates the code when missing, runs the test, and analyzes a failure; exit 1 = test failed, 3 = target down, 4 = engine.',
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
    description: 'Runs the existing test code again.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string() },
  }, async ({ projectDir, id }) => aracCalistir(async () => testRerun({ cwd: await projeSec(projectDir), id })));

  sunucu.registerTool('test_refresh', {
    description: 'For failureKind product_changed: re-explores the test page, updates the map in place, adapts the plan steps to the new UI, moves the test back to draft, and (unless run is false) regenerates and runs it.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string(), run: z.boolean().optional() },
  }, async ({ projectDir, id, run }) => aracCalistir(async () => testRefresh({
    cwd: await projeSec(projectDir),
    id,
    ...(run === undefined ? {} : { run }),
  })));

  sunucu.registerTool('test_result', {
    description: 'Returns the latest run result, or the run history, of a test.',
    inputSchema: { ...PROJE_DIZINI_SEMASI, id: z.string(), history: z.boolean().optional() },
  }, async ({ projectDir, id, history }) => aracCalistir(async () => testResult({
    cwd: await projeSec(projectDir),
    id,
    ...(history === undefined ? {} : { history }),
  })));

  sunucu.registerTool('failure_get', {
    description: 'Copies the failure bundle of a test into the given directory; without out, .kobay/failure-out/<id> (a fixed path per test, refreshed in place).',
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
    description: 'Checks the Kobay installation, the target, and the working environment.',
    inputSchema: PROJE_DIZINI_SEMASI,
  }, async ({ projectDir }) => aracCalistir(async () => doctor({ cwd: await projeSec(projectDir) })));

  return sunucu;
}

/** MCP sunucusunu stdio transport ile başlatır. İnsan çıktısı stdout'a yazılmaz. */
export async function mcpSunucusuBaslat(s: McpAyarlari): Promise<void> {
  const sunucu = mcpSunucusuOlustur(s);
  await sunucu.connect(new StdioServerTransport());
}
