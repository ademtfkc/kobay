import { createServer, type Server } from 'node:http';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, expect, it, type TestContext } from 'vitest';
import { main } from '../../src/cli/index.js';
import { KobayDizini } from '../../src/depo/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/**
 * Spec 2026-10-13 §5 madde 5: içe alınan oturumla uçtan uca koşu (project create --session-file →
 * explore → test run → failure get → report) sonrası üretilen HER dosyada (trace.zip içi dahil)
 * çerez ve localStorage değeri aranır. Tek istisna değerin kendi yeri: `.kobay/storageState.json`
 * ve kullanıcının kaynak dosyası.
 */
const SID = 'SIZINTISID-5e6f7a8b9c0d1e2f';
const JWT = 'SIZINTIJWT-1a2b3c4d5e6f7081';
const kati = process.env.KOBAY_TEST_STRICT === '1';
let tarayiciEngeli: unknown;
let sunucu: Server | undefined;
let hedefUrl = '';

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
  }
  if (tarayiciEngeli !== undefined) return;
  sunucu = createServer((istek, yanit) => {
    const yol = new URL(istek.url ?? '/', 'http://x').pathname;
    const girisli = (istek.headers.cookie ?? '').includes(`sid=${SID}`);
    if (yol === '/giris') {
      yanit.writeHead(200, { 'content-type': 'text/html' });
      yanit.end('<!doctype html><html><body><h1>Sign in</h1><form method="post"><input name="k">'
        + '<input type="password" name="p"><button>Log in</button></form></body></html>');
      return;
    }
    if (!girisli) {
      yanit.writeHead(302, { location: '/giris' });
      yanit.end();
      return;
    }
    yanit.writeHead(200, { 'content-type': 'text/html' });
    yanit.end(yol === '/records'
      ? '<!doctype html><html><body><h1>Records</h1><p>3 records</p><script>localStorage.getItem("jwt");</script></body></html>'
      // Codex/Opus P1: uygulama oturum değerini DOM'a basar (başlık, h2, bağlantı metni); test koşusu bu
      // sayfayı açmaz, haritaya ve explore çıktısına girip girmediği ölçülür.
      : '<!doctype html><html><head><title>Dashboard</title></head><body><h1>Dashboard</h1><h2 id="t"></h2>'
        + '<a href="/records" id="l">Records</a><script>const j=localStorage.getItem("jwt");document.title="Hi "+j;'
        + 'document.getElementById("t").textContent="Token "+j;document.getElementById("l").textContent="Records "+j;</script></body></html>');
  });
  const port = await new Promise<number>((coz) => {
    sunucu?.listen(0, '127.0.0.1', () => {
      const a = sunucu?.address();
      coz(typeof a === 'object' && a !== null ? a.port : 0);
    });
  });
  hedefUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (sunucu === undefined) return;
  const s = sunucu;
  await new Promise((coz) => { s.closeAllConnections(); s.close(coz); });
});

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

/** Zip arşivinin girdileri (merkezi dizinden; stored ve deflate). Bağımlılık eklememek için elle. */
function zipGirdileri(arsiv: Buffer): Array<{ ad: string; veri: Buffer }> {
  let son = arsiv.length - 22;
  while (son >= 0 && arsiv.readUInt32LE(son) !== 0x06054b50) son -= 1;
  if (son < 0) throw new Error('zip sonu bulunamadı');
  const adet = arsiv.readUInt16LE(son + 10);
  let konum = arsiv.readUInt32LE(son + 16);
  const girdiler: Array<{ ad: string; veri: Buffer }> = [];
  for (let i = 0; i < adet; i += 1) {
    const yontem = arsiv.readUInt16LE(konum + 10);
    const sikisik = arsiv.readUInt32LE(konum + 20);
    const adBoyu = arsiv.readUInt16LE(konum + 28);
    const ekBoyu = arsiv.readUInt16LE(konum + 30);
    const notBoyu = arsiv.readUInt16LE(konum + 32);
    const yerel = arsiv.readUInt32LE(konum + 42);
    const ad = arsiv.subarray(konum + 46, konum + 46 + adBoyu).toString('utf8');
    const veriBasi = yerel + 30 + arsiv.readUInt16LE(yerel + 26) + arsiv.readUInt16LE(yerel + 28);
    const ham = arsiv.subarray(veriBasi, veriBasi + sikisik);
    girdiler.push({ ad, veri: yontem === 0 ? ham : inflateRawSync(ham) });
    konum += 46 + adBoyu + ekBoyu + notBoyu;
  }
  return girdiler;
}

async function tumDosyalar(kok: string): Promise<string[]> {
  const girdiler = await readdir(kok, { recursive: true, withFileTypes: true });
  return girdiler.filter((g) => g.isFile()).map((g) => join(g.parentPath, g.name));
}

it('içe alınan oturumla koşu: trace.zip dışındaki hiçbir çıktıda çerez/localStorage değeri yok; trace.zip bilinen sınır', async (context) => {
  if (!tarayiciMumkun(context)) return;
  const cwd = await geciciDizinAc('kobay-oturum-sizinti-');
  const kaynak = join(cwd, 'state.json');
  await writeFile(kaynak, JSON.stringify({
    cookies: [{ name: 'sid', value: SID, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [{ origin: hedefUrl, localStorage: [{ name: 'jwt', value: JWT }] }],
  }));
  const ciktilar: string[] = [];
  const adim = async (...argumanlar: string[]): Promise<number> => {
    const sonuc = await kobay(cwd, '--output', 'json', ...argumanlar);
    ciktilar.push(sonuc.cikti);
    return sonuc.kod;
  };
  expect(await adim('project', 'create', '--url', hedefUrl, '--brain', 'sahte', '--session-file', 'state.json')).toBe(0);
  expect(await adim('explore')).toBe(0);
  const harita = JSON.parse(await readFile(join(cwd, '.kobay', 'map.json'), 'utf8')) as { sessionSource?: string; pages: Array<{ url: string }> };
  expect(harita.sessionSource).toBe('imported');
  // Sahte test olmasın: DOM'a basılan jeton haritada maskeli görünür.
  expect(await readFile(join(cwd, '.kobay', 'map.json'), 'utf8')).toContain('Token [redacted]');
  expect(harita.pages.map((s) => new URL(s.url).pathname)).toContain('/records');

  await writeFile(join(cwd, 'plan.json'), JSON.stringify({
    type: 'frontend', name: 'Records page shows the total', url: '/records',
    planSteps: [
      { type: 'action', description: 'Open the records page' },
      { type: 'assertion', description: 'See the records total' },
    ],
  }));
  expect(await adim('test', 'create', '--plan', 'plan.json')).toBe(0);
  const dizin = await KobayDizini.bul(cwd);
  if (dizin === null) throw new Error('.kobay yok');
  const [test] = await dizin.testListele();
  if (test === undefined) throw new Error('test yok');
  // Kod elle yazılır (beyin yok); kayıt hazır işaretlenir. Bilerek düşen ikinci adım: hata paketi,
  // video ve trace üretilsin.
  await dizin.testYaz({ ...test, status: 'ready' });
  await dizin.kodYaz(test.id, `import { test, expect } from './_fixture';
test('Records page shows the total', async ({ page }) => {
  await test.step('0: Open the records page', async () => {
    await page.goto('${hedefUrl}/records');
    await expect(page.getByRole('heading', { name: 'Records' })).toBeVisible();
  });
  await test.step('1: See the records total', async () => {
    await expect(page.getByText('999 records')).toBeVisible({ timeout: 1000 });
  });
});
`);
  expect(await adim('test', 'run', test.id, '--rerun', '--no-analysis'), ciktilar.at(-1)).toBe(1);
  expect(await adim('test', 'failure', 'get', test.id)).toBe(0);
  expect(await adim('test', 'report', '--all')).toBe(0);

  const dosyalar = (await tumDosyalar(cwd)).filter((yol) => yol !== kaynak && yol !== join(cwd, '.kobay', 'storageState.json'));
  const izler = (await Promise.all(dosyalar.map(async (yol) => {
    const icerik = await readFile(yol);
    const parcalar = [{ ad: relative(cwd, yol), veri: icerik }];
    if (yol.endsWith('.zip')) for (const g of zipGirdileri(icerik)) parcalar.push({ ad: `${relative(cwd, yol)}!${g.ad}`, veri: g.veri });
    return parcalar;
  }))).flat();
  // Sahte test olmasın: trace gerçekten açıldı ve ağ kaydı taşıyor.
  expect(izler.some((iz) => iz.ad.includes('trace.zip!') && iz.ad.endsWith('.network'))).toBe(true);
  expect(izler.some((iz) => iz.ad.includes('failure-out'))).toBe(true);
  const sizanlar = izler.filter((iz) => [SID, JWT].some((deger) => iz.veri.includes(deger))).map((iz) => iz.ad);
  // trace.zip DIŞINDAKİ her dosya (harita, koşu sonucu, adımlar, DOM, hata paketi JSON'u, HTML rapor,
  // komut çıktıları) temiz.
  expect(sizanlar.filter((ad) => !ad.includes('trace.zip!'))).toEqual([]);
  // Bilinen, README'de belgeli sınır ("Traces contain session cookies"; `src/kos`, bu şeridin dokunma
  // listesinde değil): Playwright trace'i bağlam seçeneklerindeki storageState'i (`.trace`) ve isteklerin
  // Cookie başlığını (`.network`) olduğu gibi kaydeder. `--login` yolunun oturumu da aynı yoldan geçer;
  // içe alınan oturuma özgü değil. Trace maskelenirse bu satır düşer ve yukarıdaki süzgeç kaldırılır.
  expect([...new Set(sizanlar.map((ad) => ad.replace(/^.*trace\.zip!/, '')))].sort()).toEqual(['1-trace.network', '1-trace.trace']);
  for (const cikti of ciktilar) for (const deger of [SID, JWT]) expect(cikti).not.toContain(deger);
}, 180_000);
