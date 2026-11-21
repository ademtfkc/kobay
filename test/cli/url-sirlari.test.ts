import { createServer, type Server } from 'node:http';
import { createServer as netSunucu } from 'node:net';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { chromium } from '@playwright/test';
import { afterAll, afterEach, beforeAll, expect, it, type TestContext } from 'vitest';
import { main } from '../../src/cli/index.js';
import { KobayDizini } from '../../src/depo/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * Spec 2026-11-13 A (0.9.2): URL sorgu değerleri ve fragment (`code`, `state`, `sid`, `signature`,
 * anahtar adından bağımsız) kobay'ın ürettiği hiçbir çıktıda ham görünmez. Kanıt betiği
 * (`auth-kanit/a-kanit.mjs`) buraya taşındı: gerçek CLI (süreç içi), sahte beyin, gerçek Chromium.
 * Ham kalabilecek yerler (Gökhan kararı + README istisnası): kullanıcının girdisi olan
 * `.kobay/config.json`, `.kobay/map.json`, test kaynağı `.kobay/tests/*.spec.ts` ve Playwright'ın ham
 * koşu çıktıları (`runs/<id>/trace.zip`, `pw-report.json`, `pw/…`).
 */
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;
let sunucu: Server | undefined;
let base = '';
let kapaliPort = 0;

const sirlar = (on: string): string =>
  `code=SECRET_${on}_CODE&state=SECRET_${on}_STATE&sid=SECRET_${on}_SID&signature=SECRET_${on}_SIG&token=SECRET_${on}_TOK`;
const sirliKapali = (on: string): string => `http://127.0.0.1:${kapaliPort}/cb?${sirlar(on)}#access_token=SECRET_${on}_FRAG`;

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
  }
  if (tarayiciEngeli !== undefined) return;
  kapaliPort = await new Promise<number>((coz) => {
    const s = netSunucu();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a !== null ? a.port : 0;
      s.close(() => coz(p));
    });
  });
  sunucu = createServer((istek, yanit) => {
    const yol = new URL(istek.url ?? '/', 'http://x').pathname;
    if (yol === '/go') {
      yanit.writeHead(302, { location: sirliKapali('YON') });
      yanit.end();
      return;
    }
    yanit.writeHead(200, { 'content-type': 'text/html' });
    // `/landing` kendi adresini konsola hata olarak yazar: console.json maskesi sınansın (Codex P3-9).
    const konsol = yol === '/landing' ? '<script>console.error("callback at " + location.href)</script>' : '';
    yanit.end(`<!doctype html><html><head><title>App</title></head><body><h1>App</h1><a href="/about">About</a>${konsol}</body></html>`);
  });
  const port = await new Promise<number>((coz) => {
    sunucu?.listen(0, '127.0.0.1', () => {
      const a = sunucu?.address();
      coz(typeof a === 'object' && a !== null ? a.port : 0);
    });
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (sunucu === undefined) return;
  const s = sunucu;
  await new Promise((coz) => { s.closeAllConnections(); s.close(coz); });
});

afterEach(() => { delete process.env.KOBAY_SAHTE_YANIT_DIZINI; });

function tarayiciMumkun(context: TestContext): boolean {
  if (!tarayiciEngeli) return true;
  const ozet = String(tarayiciEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium bu ortamda engelli: ${ozet}`);
  return false;
}

async function kobay(cwd: string, ...argumanlar: string[]): Promise<{ kod: number; cikti: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let cikti = '';
  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  stdout.on('data', (parca: string) => { cikti += parca; });
  stderr.on('data', (parca: string) => { cikti += parca; });
  const kod = await main(['node', 'kobay', '--cwd', cwd, ...argumanlar], { input: Readable.from([]), stdout, stderr });
  return { kod, cikti };
}

async function tumDosyalar(kok: string): Promise<string[]> {
  const girdiler = await readdir(kok, { recursive: true, withFileTypes: true });
  return girdiler.filter((g) => g.isFile()).map((g) => join(g.parentPath, g.name));
}

/** Ham kalmasına izin verilen yerler (bkz. dosya başı). */
function izinliHam(yol: string): boolean {
  const y = yol.split(sep).join('/');
  return y === '.kobay/config.json' || y === '.kobay/map.json'
    // Kullanıcının kendi plan dosyası ve test kayıtları/kodu (README istisnası).
    || y === 'plan.json' || /^\.kobay\/tests\/[^/]+\.(?:spec\.ts|json)$/.test(y)
    || /^\.kobay\/runs\/[^/]+\/(?:trace\.zip|pw-report\.json|pw\/.*)$/.test(y);
}

it('URL sırları: config/map/test kaynağı/Playwright ham çıktısı dışında hiçbir dosya ve CLI çıktısında SECRET_ yok', async (context) => {
  if (!tarayiciMumkun(context)) return;
  const kok = await geciciDizinAc('kobay-url-sirlari-');
  const sahte = join(kok, 'sahte-yanit');
  await mkdir(sahte);
  process.env.KOBAY_SAHTE_YANIT_DIZINI = sahte;
  const ciktilar: Array<{ komut: string; cikti: string }> = [];
  const calistir = async (cwd: string, ...argumanlar: string[]): Promise<number> => {
    const sonuc = await kobay(cwd, ...argumanlar);
    ciktilar.push({ komut: argumanlar.join(' '), cikti: sonuc.cikti });
    return sonuc.kod;
  };

  // A2: hedef adres sorguda sır taşıyor, sayfa canlı.
  const a2 = join(kok, 'a2');
  await mkdir(a2);
  expect(await calistir(a2, 'project', 'create', '--url', `${base}/?${sirlar('A2')}#access_token=SECRET_A2_FRAG`, '--brain', 'sahte')).toBe(0);
  expect(await calistir(a2, 'explore')).toBe(0);
  expect(await calistir(a2, '--output', 'json', 'explore')).toBe(0);
  expect(await calistir(a2, '--output', 'json', 'project', 'get')).toBe(0);
  // Sahte test olmasın: kullanıcının girdisi config'te ham durur (Gökhan kararı).
  expect(await readFile(join(a2, '.kobay', 'config.json'), 'utf8')).toContain('SECRET_A2_CODE');

  // A1b: hedef adresin kendisi sırlı ve kapalı port.
  const a1 = join(kok, 'a1');
  await mkdir(a1);
  expect(await calistir(a1, 'project', 'create', '--url', sirliKapali('A1'), '--brain', 'sahte')).toBe(0);
  expect(await calistir(a1, 'explore')).toBe(3);
  expect(await calistir(a1, '--output', 'json', 'explore')).toBe(3);

  // A3: temiz hedef; üç test: yönlendirme hedefi sırlı, doğrudan sırlı kapalı adres, canlı sırlı adres + düşen doğrulama.
  const a3 = join(kok, 'a3');
  await mkdir(a3);
  expect(await calistir(a3, 'project', 'create', '--url', base, '--brain', 'sahte')).toBe(0);
  expect(await calistir(a3, 'explore')).toBe(0);
  const govdeler: Record<string, string> = {
    'Redirect callback': `    await page.goto('${base}/go');`,
    'Direct callback': `    await page.goto('${sirliKapali('DOG')}');`,
    'Live callback': `    await page.goto('/landing?${sirlar('CAN')}#access_token=SECRET_CAN_FRAG');
    await expect(page).toHaveURL(/never-matches/, { timeout: 1000 });`,
  };
  const ADIM0 = `Open ${base}/cb?code=SECRET_ADIM_CODE`;
  for (const [ad, govde] of Object.entries(govdeler)) {
    await writeFile(join(a3, 'plan.json'), JSON.stringify({
      type: 'frontend', name: ad, url: '/',
      // Elle yazılmış planın adım açıklaması da sırlı adres taşır (kör kabul P2-2).
      planSteps: [{ type: 'action', description: ADIM0 }, { type: 'assertion', description: 'Check' }],
    }));
    expect(await calistir(a3, 'test', 'create', '--plan', 'plan.json')).toBe(0);
    const dizin = await KobayDizini.bul(a3);
    if (dizin === null) throw new Error('.kobay yok');
    const test = (await dizin.testListele()).find((t) => t.name === ad);
    if (test === undefined) throw new Error('test yok');
    await dizin.testYaz({ ...test, status: 'ready' });
    await dizin.kodYaz(test.id, `import { test, expect } from './_fixture';
test('${ad}', async ({ page }) => {
  await test.step('0: ${ADIM0}', async () => {
${govde}
  });
  await test.step('1: Check', async () => {
    await expect(page.locator('h1')).toBeVisible();
  });
});
`);
    // Sahte analiz adresi yankılamaz: ölçülen kobay'ın kendi işlemesi.
    await writeFile(join(sahte, `analysis-${test.id}.json`), JSON.stringify({
      rootCauseHypothesis: 'The callback page did not load', failureKind: 'env',
      recommendedFixTarget: { kind: 'env', reference: 'callback host', rationale: 'Navigation failed' }, evidence: [],
    }));
    expect(await calistir(a3, 'test', 'run', test.id, '--rerun')).toBe(1);
    expect(await calistir(a3, '--output', 'json', 'test', 'run', test.id, '--rerun', '--no-analysis')).toBe(1);
    expect(await calistir(a3, '--output', 'json', 'test', 'result', test.id)).toBe(0);
    expect(await calistir(a3, 'test', 'result', test.id)).toBe(0);
    expect(await calistir(a3, 'test', 'failure', 'get', test.id)).toBe(0);
    expect(await calistir(a3, '--output', 'json', 'test', 'failure', 'get', test.id, '--out', `disari-${test.id}`)).toBe(0);
    expect(await calistir(a3, 'test', 'code', 'get', test.id)).toBe(0);
  }
  expect(await calistir(a3, 'test', 'report', '--all')).toBe(0);

  const dosyalar = [a1, a2, a3].flatMap((proje) => [proje]);
  const sizanlar: string[] = [];
  const izinliSizanlar: string[] = [];
  for (const proje of dosyalar) {
    for (const yol of await tumDosyalar(proje)) {
      const icerik = await readFile(yol);
      if (!icerik.includes('SECRET_')) continue;
      const goreli = relative(proje, yol);
      (izinliHam(goreli) ? izinliSizanlar : sizanlar).push(`${relative(kok, proje)}/${goreli.split(sep).join('/')}`);
    }
  }
  // `test code get` kodu bilinçli olarak ham verir (Codex P2-5; ayrı testi aşağıda); öteki her çıktı temiz.
  expect(ciktilar.some((c) => c.komut.startsWith('test code get') && c.cikti.includes('SECRET_DOG_CODE'))).toBe(true);
  const sizanCiktilar = ciktilar.filter((c) => !c.komut.startsWith('test code get') && c.cikti.includes('SECRET_')).map((c) => `${c.komut}: ${c.cikti.slice(Math.max(0, c.cikti.indexOf('SECRET_') - 80), c.cikti.indexOf('SECRET_') + 40)}`);
  expect({ ciktilar: sizanCiktilar, dosyalar: sizanlar }).toEqual({ ciktilar: [], dosyalar: [] });
  // Sahte test olmasın: senaryolar gerçekten sır üretti (izinli yerlerde ham görünür), kanıtlar yazıldı.
  expect(izinliSizanlar.some((y) => y.endsWith('/config.json'))).toBe(true);
  // Playwright'ın ham raporu (README istisnası) sırrı taşır; trace.zip sıkıştırılmış, bayt aramasıyla görünmez.
  expect(izinliSizanlar.some((y) => y.endsWith('/pw-report.json'))).toBe(true);
  const a3Dosyalari = (await tumDosyalar(a3)).map((y) => relative(a3, y).split(sep).join('/'));
  expect(a3Dosyalari.some((y) => /^\.kobay\/logs\/brain-analysis-.*\.log$/.test(y))).toBe(true);
  expect(a3Dosyalari.some((y) => /^\.kobay\/runs\/[^/]+\/network\.json$/.test(y))).toBe(true);
  // console.json gerçekten sırlı konsol kaydını (maskeli) taşıyor.
  const konsollar = await Promise.all(a3Dosyalari.filter((y) => y.endsWith('/console.json')).map((y) => readFile(join(a3, y), 'utf8')));
  expect(konsollar.join('\n')).toMatch(/callback at http:\/\/127\.0\.0\.1:\d+\/landing\?code=\[redacted\]/);
  expect(a3Dosyalari.some((y) => y === '.kobay/report/index.html')).toBe(true);
  // Maske anahtar adlarını korur: kanıtta `code=[redacted]&state=[redacted]` görünür.
  const sonuclar = await Promise.all(a3Dosyalari.filter((y) => y.endsWith('/result.json')).map((y) => readFile(join(a3, y), 'utf8')));
  expect(sonuclar.join('\n')).toMatch(/code=\[redacted\]&state=\[redacted\]&sid=\[redacted\]&signature=\[redacted\]/);
}, 300_000);

it('Codex P2-5: test code get (CLI ve MCP) kodu diskteki haliyle ham verir; aynen geri yazmak baytı değiştirmez', async () => {
  const { mcpSunucusuOlustur } = await import('../../src/mcp/index.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const cwd = await geciciDizinAc('kobay-code-get-');
  // Hedef adres de sırlı: karşılaştırılan komutun (`project get`) normal gövdesi sır taşısın (Codex tur 2 P3).
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://localhost:3000/?code=SECRET_DAR_CODE', beyin: { adaptor: 'sahte' } });
  await writeFile(join(cwd, 'plan.json'), JSON.stringify({
    type: 'frontend', name: 'Search', url: '/', planSteps: [{ type: 'action', description: 'Open' }],
  }));
  expect((await kobay(cwd, 'test', 'create', '--plan', 'plan.json')).kod).toBe(0);
  const [test] = await dizin.testListele();
  if (test === undefined) throw new Error('test yok');
  const kod = `import { test } from './_fixture';\ntest('Search', async ({ page }) => {\n  await test.step('0: Open', async () => { await page.goto('http://admin:SECRET_RT_PASS@localhost:3000/search?q=SECRET_RT_Q#t=SECRET_RT_F'); });\n});\n`;
  await dizin.kodYaz(test.id, kod);
  const diskte = await readFile(dizin.kodYolu(test.id));

  const json = await kobay(cwd, '--output', 'json', 'test', 'code', 'get', test.id);
  expect((JSON.parse(json.cikti) as { data: string }).data).toBe(kod);
  const insan = await kobay(cwd, 'test', 'code', 'get', test.id);
  expect(insan.cikti).toBe(`${kod}\n`);

  const sunucu = mcpSunucusuOlustur({ cwd });
  const istemci = new Client({ name: 'kobay-test', version: '0.1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([sunucu.connect(a), istemci.connect(b)]);
  try {
    const yanit = await istemci.callTool({ name: 'code_get', arguments: { id: test.id } });
    const mcpKod = JSON.parse((yanit.content as Array<{ text: string }>)[0]?.text ?? '') as string;
    expect(mcpKod).toBe(kod);
    // Round-trip: alınan kod aynen geri yazılınca dosya bayt bayt aynı kalır.
    await dizin.kodYaz(test.id, mcpKod);
    expect((await readFile(dizin.kodYolu(test.id))).equals(diskte)).toBe(true);
  } finally {
    await istemci.close();
    await sunucu.close();
  }
  // Delik dar: başka komutun (project get) sırlı gövdesi aynı projede iki biçimde de yine maskeli.
  for (const argumanlar of [['--output', 'json', 'project', 'get'], ['project', 'get']]) {
    const cikti = (await kobay(cwd, ...argumanlar)).cikti;
    expect(cikti, argumanlar.join(' ')).toContain('code=[redacted]');
    expect(cikti, argumanlar.join(' ')).not.toContain('SECRET_');
  }
});
