#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import type { BeyinAyari, Kimlik } from '../depo/index.js';
import { CIKIS } from './cikis.js';
import { ciktiYaz } from './cikti.js';
import { GirdiBittiHatasi, gizliSor, yanitBekle } from './gizli-sor.js';
import { KullanimHatasi, basarisiz, type KomutSonucu } from './komut.js';
import {
  agentInstall,
  codeGet,
  demo,
  doctor,
  explore,
  failureGet,
  mcp,
  planAccept,
  planGenerate,
  projectCreate,
  projectGet,
  projectUpdate,
  setup,
  installBrowser,
  testCreate,
  testDelete,
  testGet,
  testList,
  testRefresh,
  testRerun,
  testResult,
  testRun,
} from './komutlar/index.js';
import { demoPortu } from './komutlar/demo.js';

const require = createRequire(import.meta.url);
const paket = require('../../package.json') as { version: string };

interface CliAkislari {
  input: Readable;
  stdout: Writable;
  stderr: Writable;
}

const varsayilanAkislar: CliAkislari = {
  input: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
};

/** Yalnız verilen beyin alanları; eksikler proje/global ayardan gelir. */
function beyinAyari(
  secenekler: { brain?: string; beyin?: string; model?: string; effort?: string },
): Partial<BeyinAyari> | undefined {
  const brain = secenekler.brain ?? secenekler.beyin;
  if (brain === undefined && secenekler.model === undefined && secenekler.effort === undefined) return undefined;
  return {
    ...(brain === undefined ? {} : { adaptor: brain as BeyinAyari['adaptor'] }),
    ...(secenekler.model === undefined ? {} : { model: secenekler.model }),
    ...(secenekler.effort === undefined ? {} : { effort: secenekler.effort }),
  };
}

/**
 * `--brain` görünen addır; `--beyin` eski Türkçe eş addır, yardımda gizlenir ama çalışır.
 * `gizli` seçimler (ör. test beyni `sahte`) kabul edilir ama yardımda listelenmez.
 */
function beyinSecenekleri(
  komut: Command,
  aciklama: string,
  gorunen: readonly string[],
  gizli: readonly string[] = [],
): Command {
  const gecerli = [...gorunen, ...gizli];
  const denetle = (deger: string): string => {
    if (!gecerli.includes(deger)) {
      throw new InvalidArgumentError(`Allowed choices are ${gorunen.join(', ')}.`);
    }
    return deger;
  };
  const secimMetni = gorunen.map((secim) => `"${secim}"`).join(', ');
  return komut
    .addOption(new Option('--brain <adaptor>', `${aciklama} (alias: --beyin) (choices: ${secimMetni})`).argParser(denetle))
    .addOption(new Option('--beyin <adaptor>').argParser(denetle).hideHelp());
}

async function acikSor(soru: string, akislar: CliAkislari): Promise<string> {
  const arayuz = createInterface({ input: akislar.input, output: akislar.stderr });
  try {
    return await yanitBekle(arayuz, akislar.input, soru);
  } catch (hata: unknown) {
    // İstemden sonra gelecek hata mesajı "Username: " ile aynı satıra düşmesin.
    if (hata instanceof GirdiBittiHatasi) akislar.stderr.write('\n');
    throw hata;
  } finally {
    arayuz.close();
  }
}

async function girisBilgisi(akislar: CliAkislari): Promise<Kimlik> {
  try {
    const kullanici = process.env.KOBAY_LOGIN_USER ?? await acikSor('Username: ', akislar);
    const parola = process.env.KOBAY_LOGIN_PASS ?? await gizliSor('Password: ', akislar.input, akislar.stderr);
    return { kullanici, parola };
  } catch (hata: unknown) {
    if (!(hata instanceof GirdiBittiHatasi)) throw hata;
    throw new KullanimHatasi(
      'Giriş bilgisi sorulamadı: standart girdi kapalı veya yanıt gelmeden bitti.'
      + ' KOBAY_LOGIN_USER ve KOBAY_LOGIN_PASS ortam değişkenlerini verip komutu yeniden çalıştırın',
    );
  }
}

export function programOlustur(
  akislar: CliAkislari = varsayilanAkislar,
  sonucBildir: (sonuc: KomutSonucu) => void = () => undefined,
): Command {
  const program = new Command();
  program
    .name('kobay')
    .description('Local-first automated test engine')
    .version(paket.version)
    .option('--output <format>', 'output format', 'text')
    .option('--cwd <dir>', 'project directory', process.cwd())
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (metin) => akislar.stdout.write(metin),
      writeErr: (metin) => akislar.stderr.write(metin),
    });

  const calistir = async (islem: Promise<KomutSonucu>): Promise<void> => {
    const sonuc = await islem;
    sonucBildir(sonuc);
    ciktiYaz(sonuc, program.opts<{ output: string }>().output === 'json', akislar.stdout, akislar.stderr);
  };
  const cwd = (): string => program.opts<{ cwd: string }>().cwd;

  beyinSecenekleri(program.command('setup')
    .description('selects the default brain (LLM adapter) and writes ~/.kobay/config.json'),
  'brain to use', ['claude', 'codex', 'openrouter'])
    .option('--model <model>', 'model name to pass to the brain')
    .option('--effort <effort>', 'reasoning effort, when supported by the adapter')
    .action(async (secenekler: { brain?: 'claude' | 'codex' | 'openrouter'; beyin?: 'claude' | 'codex' | 'openrouter'; model?: string; effort?: string }) => {
      const { brain, beyin, ...kalan } = secenekler;
      const adaptor = brain ?? beyin;
      await calistir(setup({ ...kalan, ...(adaptor === undefined ? {} : { beyin: adaptor }) }));
    });

  program.command('install-browser')
    .description('installs the Chromium browser matching kobay\'s Playwright version')
    .option('--with-deps', 'also installs Linux system libraries')
    .action(async (secenekler: { withDeps?: boolean }) => {
      await calistir(installBrowser({ withDeps: secenekler.withDeps === true }));
    });

  program.command('demo')
    .description('starts the bundled demo app (login: demo / demo123)')
    .option('--port <port>', 'port to listen on; 0 selects a free port', demoPortu, 3000)
    .action(async (secenekler: { port: number }) => {
      await calistir(demo({ port: secenekler.port }));
    });

  const project = program.command('project').description('create, update, or show a kobay project (.kobay directory)');
  beyinSecenekleri(project.command('create')
    .description('creates a .kobay project here and saves the target URL and optional login credentials')
    .requiredOption('--url <url>', 'target application URL')
    .option('--docs <path>', 'product document file (used to generate plans)')
    .option('--login', 'prompt for credentials and save them in .kobay')
    .option('--login-url <url>', 'login page URL')
    .option('--force', 'overwrite only the config of an existing project'),
  'brain for this project', ['claude', 'codex', 'openrouter'], ['sahte'])
    .option('--model <model>', 'model name to pass to the brain')
    .option('--effort <effort>', 'reasoning effort, when supported by the adapter')
    .action(async (secenekler: {
      url: string;
      docs?: string;
      login?: boolean;
      loginUrl?: string;
      force?: boolean;
      brain?: string;
      beyin?: string;
      model?: string;
      effort?: string;
    }) => {
      const login = secenekler.login === true ? await girisBilgisi(akislar) : undefined;
      const beyin = beyinAyari(secenekler);
      await calistir(projectCreate({
        cwd: cwd(),
        url: secenekler.url,
        ...(secenekler.docs === undefined ? {} : { docs: secenekler.docs }),
        ...(login === undefined ? {} : { login }),
        ...(secenekler.loginUrl === undefined ? {} : { loginUrl: secenekler.loginUrl }),
        ...(beyin === undefined ? {} : { beyin }),
        ...(secenekler.force === undefined ? {} : { force: secenekler.force }),
      }));
    });
  beyinSecenekleri(project.command('update')
    .description('updates individual project fields; unspecified fields are unchanged')
    .option('--base-url <url>', 'new target application URL')
    .option('--login-url <url>', 'new login page URL')
    .option('--docs-path <path>', 'product document file path'),
  'brain to use', ['claude', 'codex', 'openrouter'], ['sahte'])
    .option('--model <model>', 'model name to pass to the brain')
    .option('--effort <effort>', 'reasoning effort, when supported by the adapter')
    .action(async (secenekler: {
      baseUrl?: string;
      loginUrl?: string;
      docsPath?: string;
      brain?: string;
      beyin?: string;
      model?: string;
      effort?: string;
    }) => {
      const brain = secenekler.brain ?? secenekler.beyin;
      const beyin = brain === undefined && secenekler.model === undefined && secenekler.effort === undefined
        ? undefined
        : {
          ...(brain === undefined ? {} : { adaptor: brain as BeyinAyari['adaptor'] }),
          ...(secenekler.model === undefined ? {} : { model: secenekler.model }),
          ...(secenekler.effort === undefined ? {} : { effort: secenekler.effort }),
        };
      await calistir(projectUpdate({
        cwd: cwd(),
        ...(secenekler.baseUrl === undefined ? {} : { url: secenekler.baseUrl }),
        ...(secenekler.loginUrl === undefined ? {} : { loginUrl: secenekler.loginUrl }),
        ...(secenekler.docsPath === undefined ? {} : { docs: secenekler.docsPath }),
        ...(beyin === undefined ? {} : { beyin }),
      }));
    });
  project.command('get')
    .description('shows project settings, test count, and map status')
    .action(async () => calistir(projectGet({ cwd: cwd() })));

  program.command('explore')
    .description('browses the target app and refreshes the exploration map (.kobay/harita.json)')
    .action(async () => calistir(explore({ cwd: cwd() })));

  const test = program.command('test').description('generate test plans, create and run tests, and get results or failure bundles');
  const plan = test.command('plan').description('generate and accept test proposals with the brain');
  plan.command('generate')
    .description('generates test proposals from the exploration map and document (.kobay/plan/onerileri.json)')
    .option('--hint <hint>', 'free-text hint for the brain (for example, "invoice flow only")')
    .action(async (secenekler: { hint?: string }) => calistir(planGenerate({
      cwd: cwd(),
      ...(secenekler.hint === undefined ? {} : { hint: secenekler.hint }),
    })));
  plan.command('accept')
    .description('turns selected proposals into test records')
    .option('--all', 'accept all proposals')
    .option('--ids <ids>', 'comma-separated proposal IDs')
    .action(async (secenekler: { all?: boolean; ids?: string }) => calistir(planAccept({
      cwd: cwd(),
      ...(secenekler.all === undefined ? {} : { all: secenekler.all }),
      ...(secenekler.ids === undefined ? {} : { ids: secenekler.ids.split(',').filter(Boolean) }),
    })));

  test.command('create')
    .description('creates a test record from a hand-written plan file')
    .requiredOption('--plan <path>', 'plan JSON file path')
    .action(async (secenekler: { plan: string }) => calistir(testCreate({ cwd: cwd(), planPath: secenekler.plan })));
  test.command('list')
    .description('lists saved tests with ID, status, and priority')
    .action(async () => calistir(testList({ cwd: cwd() })));
  test.command('get <id>')
    .description('shows a test record (plan steps, status, version)')
    .action(async (id: string) => calistir(testGet({ cwd: cwd(), id })));
  const code = test.command('code').description('show generated Playwright code');
  code.command('get <id>')
    .description('prints the generated Playwright code for a test')
    .action(async (id: string) => calistir(codeGet({ cwd: cwd(), id })));
  test.command('delete <id>')
    .description('deletes a test record and its generated code')
    .action(async (id: string) => calistir(testDelete({ cwd: cwd(), id })));
  test.command('run [ids...]')
    .description('runs tests; generates missing code with the brain and prepares a failure bundle when one fails')
    .option('--all', 'run all saved tests')
    .option('--rerun', 'run existing code without generating it')
    .action(async (ids: string[], secenekler: { all?: boolean; rerun?: boolean }) => calistir(testRun({
      cwd: cwd(),
      ...(ids.length === 0 ? {} : { ids }),
      ...(secenekler.all === undefined ? {} : { all: secenekler.all }),
      ...(secenekler.rerun === undefined ? {} : { rerun: secenekler.rerun }),
    })));
  test.command('rerun <id>')
    .description('runs a test with its existing code without generating it again')
    .action(async (id: string) => calistir(testRerun({ cwd: cwd(), id })));
  test.command('refresh <id>')
    .description('when the product changed, re-explore the page, adapt plan steps, regenerate code, and run the test')
    .option('--no-run', 'refresh only the map and plan steps; do not generate code or run the test')
    .action(async (id: string, secenekler: { run?: boolean }) => calistir(testRefresh({
      cwd: cwd(), id,
      ...(secenekler.run === undefined ? {} : { run: secenekler.run }),
    })));
  test.command('result <id>')
    .description('shows the latest test run result')
    .option('--history', 'show full run history')
    .action(async (id: string, secenekler: { history?: boolean }) => calistir(testResult({
      cwd: cwd(), id,
      ...(secenekler.history === undefined ? {} : { history: secenekler.history }),
    })));
  const failure = test.command('failure').description('get the evidence bundle for a failed run');
  failure.command('get <id>')
    .description('copies the failure bundle with root cause, evidence files, and trace into a directory')
    .option('--out <directory>', 'destination directory for the bundle (default: .kobay/failure-out/<id>, refreshed in place)')
    .action(async (id: string, secenekler: { out?: string }) => calistir(failureGet({
      cwd: cwd(), id, ...(secenekler.out === undefined ? {} : { out: secenekler.out }),
    })));

  const agent = program.command('agent').description('install the kobay skill for coding agents');
  agent.command('install')
    .description('writes the kobay verification skill where the selected agent reads it; for claude it also registers the MCP server in .mcp.json')
    .addOption(new Option('--target <target>', 'agent for which to install the skill')
      .choices(['claude', 'codex', 'cursor']).makeOptionMandatory())
    .action(async (secenekler: { target: 'claude' | 'codex' | 'cursor' }) => calistir(agentInstall({
      cwd: cwd(), target: secenekler.target,
    })));

  program.command('mcp')
    .description('serves kobay tools as a stdio MCP server (register this command with your agent)')
    .action(async () => calistir(mcp()));
  program.command('doctor')
    .description('checks Node, the brain CLI, Chromium, .kobay, and the target app')
    .action(async () => calistir(doctor({ cwd: cwd() })));
  return program;
}

export async function main(argv: string[] = process.argv, akislar: CliAkislari = varsayilanAkislar): Promise<number> {
  let sonKod = CIKIS.GECTI as number;
  const program = programOlustur(akislar, (sonuc) => { sonKod = sonuc.exitCode; });
  try {
    await program.parseAsync(argv);
    return sonKod;
  } catch (hata: unknown) {
    if (hata instanceof CommanderError && hata.exitCode === 0) return CIKIS.GECTI;
    const sonuc = basarisiz(hata instanceof Error ? hata : new Error('Komut ayrıştırılamadı'), CIKIS.KULLANIM);
    const json = argv.some((deger, sira) => deger === '--output=json' || (deger === '--output' && argv[sira + 1] === 'json'));
    // Commander kullanım hatasını fırlatmadan ÖNCE kendisi basar (`Command.error()`
    // → configureOutput.writeErr: `error: …` satırı + kullanım yardımı). Hatanın
    // metni CommanderError.message ile aynı olduğundan burada bir daha basmak
    // aynı satırı iki kez gösteriyordu. İnsan modunda basan taraf Commander'dır;
    // JSON modunda ise stdout'a tek satırlık zarfı yalnız biz yazarız.
    if (hata instanceof CommanderError && !json) return sonuc.exitCode;
    ciktiYaz(sonuc, json, akislar.stdout, akislar.stderr);
    return sonuc.exitCode;
  }
}

// npm bin symlink'i: argv[1] symlink yolu, import.meta.url gerçek yol; realpath ile karşılaştır.
function gercekYolHref(yol: string): string | null {
  try {
    return pathToFileURL(realpathSync(yol)).href;
  } catch {
    return null;
  }
}
const dogrudanCalisiyor = process.argv[1] !== undefined && gercekYolHref(process.argv[1]) === import.meta.url;
if (dogrudanCalisiyor) process.exitCode = await main();
