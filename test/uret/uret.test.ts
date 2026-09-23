import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import type { Beyin } from '../../src/beyin/index.js';
import type { Harita, TestKaydi } from '../../src/depo/index.js';
import { yazAtomik } from '../../src/depo/index.js';
import { fixtureSablonu } from '../../src/kos/fixture-sablonu.js';
import { calismaAlaniHazirla, kodDogrula, kodUret, sistemIstemi, statikHata } from '../../src/uret/index.js';
import { baslat } from '../kobay-demo/sunucu.mjs';

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');

let tarayiciEngeli: unknown;
let demo: { url: string; kapat: () => Promise<void> } | undefined;

beforeAll(async () => {
  try {
    const tarayici = await chromium.launch({ headless: true });
    await tarayici.close();
  } catch (hata) {
    tarayiciEngeli = hata;
  }
  if (tarayiciEngeli === undefined) demo = await baslat(0);
});

afterAll(async () => { await demo?.kapat(); });

function playwrightMumkun(context: TestContext): boolean {
  if (tarayiciEngeli === undefined) return true;
  context.skip(`Chromium engelli: ${String(tarayiciEngeli).split('\n')[0] ?? ''}`);
  return false;
}

async function geciciKobay(): Promise<string> {
  const kok = await mkdtemp(join(tmpdir(), 'kobay-uret-'));
  await calismaAlaniHazirla(kok);
  return kok;
}

function harita(baseUrl: string): Harita {
  return {
    baseUrl,
    loggedIn: true,
    exploredAt: '2026-09-17T00:00:00.000Z',
    pages: [
      { url: `${baseUrl}/`, title: 'Ana Sayfa', headings: ['Ana Sayfa'], links: [], forms: [], buttons: [], menu: [] },
      { url: `${baseUrl}/liste`, title: 'Liste', headings: ['Liste'], links: [], forms: [], buttons: [], menu: [] },
    ],
  };
}

function testKaydi(): TestKaydi {
  return {
    id: 't_ab12cd34',
    name: 'listeyi doğrular',
    type: 'frontend',
    createdFrom: 'cli',
    status: 'draft',
    planSteps: [
      { type: 'action', description: 'Listeye git' },
      { type: 'assertion', description: 'Liste başlığını doğrula' },
    ],
    priority: 'p1',
    codeVersion: 0,
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
  };
}

function dogruKod(baseUrl: string): string {
  return `import { test, expect } from './_fixture';
test('listeyi doğrular', async ({ page }) => {
  await test.step('0: Listeye git', async () => {
    await page.goto('${baseUrl}/liste');
  });
  await test.step('1: Liste başlığını doğrula', async () => {
    await expect(page.getByRole('heading', { name: 'Liste' })).toBeVisible();
  });
});
`;
}

function sahteBeyin(kodlar: string[], istemler: string[]): Beyin {
  let sira = 0;
  return {
    ad: 'test',
    async sor<T>(istek) {
      istemler.push(istek.kullanici);
      const kod = kodlar[Math.min(sira, kodlar.length - 1)];
      sira += 1;
      return { json: { code: kod } as T, ham: JSON.stringify({ code: kod }), sureMs: 0, adaptor: 'test' };
    },
  };
}

describe('kod üretimi', () => {
  it('yanıt iskeletindeki Türkçe anahtarları değişmez ilan eder', () => {
    const istem = sistemIstemi();

    expect(istem).toContain('{"code": "...", "explanation": "..."}');
    expect(istem).toContain("The keys code and explanation are the schema's fixed keys; do not translate them");
    expect(istem).toContain(
      "Write names, descriptions and rationale in the language of the application's UI and docs;"
      + ' if mixed or unclear, use English.',
    );
    expect(istem).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
  });

  it('doğru kodu tek denemede üretir ve Playwright ile listeler', async (context) => {
    if (!playwrightMumkun(context)) return;
    const kok = await geciciKobay();
    const istemler: string[] = [];
    const sonuc = await kodUret(sahteBeyin([dogruKod('http://ornek.test')], istemler), testKaydi(), harita('http://ornek.test'), {
      projeKoku: kok,
      kobayKoku: kok,
    });

    expect(sonuc.denemeler).toBe(1);
    expect((await kodDogrula(join(kok, 'tests', 't_ab12cd34.spec.ts'), kok)).ok).toBe(true);
    expect(istemler).toHaveLength(1);
  });

  it('söz dizimi hatasından sonra ikinci turda doğru kodu kabul eder', async (context) => {
    if (!playwrightMumkun(context)) return;
    const kok = await geciciKobay();
    const sonuc = await kodUret(sahteBeyin(['not valid typescript', dogruKod('http://ornek.test')], []), testKaydi(), harita('http://ornek.test'), {
      projeKoku: kok,
      kobayKoku: kok,
    });
    expect(sonuc.denemeler).toBe(2);
  });

  it('haritada olmayan goto yolunu geri bildirimle yeniden üretir', async (context) => {
    if (!playwrightMumkun(context)) return;
    const kok = await geciciKobay();
    const istemler: string[] = [];
    const hataliKod = dogruKod('http://ornek.test').replace('/liste', '/gizli');
    const sonuc = await kodUret(sahteBeyin([hataliKod, dogruKod('http://ornek.test')], istemler), testKaydi(), harita('http://ornek.test'), {
      projeKoku: kok,
      kobayKoku: kok,
    });
    expect(sonuc.denemeler).toBe(2);
    expect(istemler[1]).toContain('not in the map');
  });

  it('iki tur da geçersizse hata fırlatır', async (context) => {
    if (!playwrightMumkun(context)) return;
    const kok = await geciciKobay();
    await expect(kodUret(sahteBeyin(['not valid typescript', 'still invalid'], []), testKaydi(), harita('http://ornek.test'), {
      projeKoku: kok,
      kobayKoku: kok,
    })).rejects.toThrow('Code generation failed');
  });
});

describe('üretim adım başlığı denetimi', () => {
  const basitHarita = harita('http://ornek.test');

  function kodBasligi(baslik: string): string {
    return `import { test, expect } from './_fixture';
test('listeyi doğrular', async ({ page }) => {
  await test.step(${baslik}, async () => {});
  await test.step('1: Liste başlığını doğrula', async () => {});
});`;
  }

  it.each([
    ["'0: Sayfa başlığının \\'Panel · Analizcim\\' olduğunu doğrula'", 'kaçışlı tek tırnak'],
    ['"0: Sayfa başlığının \'Panel · Analizcim\' olduğunu doğrula"', 'çift tırnak'],
    ['`0: Sayfa başlığının \'Panel · Analizcim\' olduğunu doğrula`', 'backtick'],
    ['"0:   Sayfa   başlığının \'Panel · Analizcim\'   olduğunu doğrula"', 'fazla boşluk'],
  ])('%s biçimini kabul eder (%s)', (baslik) => {
    const testBasamaklari: TestKaydi = {
      ...testKaydi(),
      planSteps: [
        { type: 'assertion', description: "Sayfa başlığının 'Panel · Analizcim' olduğunu doğrula" },
        ...testKaydi().planSteps.slice(1),
      ],
    };
    const kod = kodBasligi(baslik);
    expect(statikHata(kod, testBasamaklari, basitHarita)).toBeNull();
  });

  it('farklı metni reddeder', () => {
    const kod = kodBasligi("'0: Sayfa başlığının \\'Başka Panel\\' olduğunu doğrula'");
    expect(statikHata(kod, {
      ...testKaydi(),
      planSteps: [{ type: 'assertion', description: "Sayfa başlığının 'Panel · Analizcim' olduğunu doğrula" }, ...testKaydi().planSteps.slice(1)],
    }, basitHarita)).toContain('Step 0');
  });
});

describe('üretim kodu güvenlik denetimi', () => {
  const basitHarita = harita('http://ornek.test');

  it.each([
    ['dinamik import', "await import('node:fs/promises');"],
    ['require', "require('node:child_process');"],
    ['process', 'process?.exit(1);'],
    ['globalThis', 'globalThis?.process.exit(1);'],
    ['Reflect.get', "Reflect.get(globalThis, ['pro', 'cess'].join(''));"],
    ['getBuiltinModule', "process.getBuiltinModule(['child', 'process'].join('_'));"],
    ['eval', "eval('process.exit(1)');"],
    ['Function', "Function('return process')();"],
    ['constructor zinciri', "({}).constructor.constructor('return process')();"],
    ['sistem modülü', 'const dosyalar = fs.readFileSync;'],
  ])('%s içeren kodu reddeder', (_ad, ekKod) => {
    const kod = `${dogruKod('http://ornek.test')}\n${ekKod}`;
    expect(statikHata(kod, testKaydi(), basitHarita)).toContain('rejected by the speed bump');
  });

  it('dize ve yorum metnindeki yasaklı sözcükleri çalıştırılabilir kod saymaz', () => {
    const kayit = {
      ...testKaydi(),
      planSteps: [{ type: 'action' as const, description: 'fs raporuna git' }, ...testKaydi().planSteps.slice(1)],
    };
    const kod = dogruKod('http://ornek.test')
      .replace('0: Listeye git', '0: fs raporuna git')
      .replace(
        "await page.goto('http://ornek.test/liste');",
        "await page.goto('http://ornek.test/liste');\n    await page.getByText('module').click(); // exports açıklaması",
      );
    expect(statikHata(kod, kayit, basitHarita)).toBeNull();
  });

  it('şablon dizesinin ham metnini yok sayar, ${} ifadesini denetler', () => {
    const hamMetin = `${dogruKod('http://ornek.test')}\nconst baslik = \`process ve fs metni\`;`;
    const ifadeli = `${dogruKod('http://ornek.test')}\nconst baslik = \`sonuç: \${process.cwd()}\`;`;
    expect(statikHata(hamMetin, testKaydi(), basitHarita)).toBeNull();
    expect(statikHata(ifadeli, testKaydi(), basitHarita)).toContain('process access');
  });

  it.each([
    String.raw`proce\u0073s.getBuiltinMod\u0075le('node:fs')`,
    String.raw`proce\u{73}s.getBuiltinMod\u{75}le('node:fs')`,
  ])('Unicode kaçışlı tanımlayıcıyı reddeder: %s', (gizlenmisKod) => {
    const kod = `${dogruKod('http://ornek.test')}\n${gizlenmisKod};`;
    const hata = statikHata(kod, testKaydi(), basitHarita);
    expect(hata).toContain('Unicode escapes');
    expect(hata).toContain('not a security boundary');
  });

  it.each([
    ['regex içindeki tırnak', String.raw`await expect(page).toHaveURL(/'/); process.exit(1); const s = '';`],
    ['kontrol parantezi sonrası regex', String.raw`if (true) /"/.test('a'); process.exit(1); const s = "";`],
    ['regex sınıfındaki bölü', String.raw`const r = /[/'"]/; process.exit(1); const s = '"';`],
  ])('regex literal ile gizlenen Unicode kaçışını reddeder: %s', (_ad, gizlenmisKod) => {
    const kod = `${dogruKod('http://ornek.test')}\n${gizlenmisKod}`;
    expect(statikHata(kod, testKaydi(), basitHarita)).toContain('rejected by the speed bump');
  });

  it('süslü parantez sonrası belirsiz bölü işaretini reddeder', () => {
    const kod = `${dogruKod('http://ornek.test')}\n${String.raw`const x = function () {} / process.exit(1) / 1;`}`;
    expect(statikHata(kod, testKaydi(), basitHarita)).toContain('rejected by the speed bump');
  });

  it('meşru regex ve bölme işlemini kabul eder', () => {
    const kod = `${dogruKod('http://ornek.test')}\n${String.raw`const oran = 4 / 2; const yol = /\/liste$/; const s = 'a' + oran;`}`;
    expect(statikHata(kod, testKaydi(), basitHarita)).toBeNull();
  });

  it('dize ve yorum içindeki Unicode kaçış metnini reddetmez', () => {
    const kod = `${dogruKod('http://ornek.test')}\n${String.raw`const aciklama = '\u0070rocess'; // \u{66}s`}`;
    expect(statikHata(kod, testKaydi(), basitHarita)).toBeNull();
  });

  it('meşru Playwright kodunu kabul eder', () => {
    const kod = `import { test, expect } from './_fixture';
test('listeyi doğrular', async ({ page }) => {
  await test.step('0: Listeye git', async () => {
    await page.goto('/liste');
    await page.getByRole('button', { name: 'Yenile' }).click();
  });
  await test.step('1: Liste başlığını doğrula', async () => {
    await expect(page.getByRole('heading', { name: 'Liste' })).toBeVisible();
  });
});`;
    expect(statikHata(kod, testKaydi(), basitHarita)).toBeNull();
  });

  it('güvenlik hatasını sonraki üretim turuna geri bildirim olarak verir', async () => {
    const istemler: string[] = [];
    const tehlikeliKod = `${dogruKod('http://ornek.test')}\nprocess.exit(1);`;

    await expect(kodUret(sahteBeyin([tehlikeliKod, tehlikeliKod], istemler), testKaydi(), basitHarita, {
      projeKoku: '/tmp/kobay-uret-guvenlik',
      kobayKoku: '/tmp/kobay-uret-guvenlik',
    })).rejects.toThrow('rejected by the speed bump');

    expect(istemler[1]).toContain('not a security boundary');
  });
});

describe('hız kesici: modül bildirimleri (denetim 3 madde 4a)', () => {
  const basitHarita = harita('http://ornek.test');
  const ilk = "import { test, expect } from './_fixture';";

  it.each([
    ['yorum önekli import', `/**/import { execSync } from 'node:child_process';`],
    ['noktalı virgül önekli import', `;import { env } from 'node:process';`],
    ['satır ortasında import', `const a = 1; import { readFileSync } from 'node:fs';`],
    ['yorumdan sonra aynı satırda import', `/* not */ import os from 'node:os';`],
    ['export ... from', `export * from 'node:fs';`],
    ['adlı export ... from', `export { execSync } from 'node:child_process';`],
    ['yorum önekli export', `/**/export { x } from './x';`],
  ])('%s reddedilir', (_ad, satir) => {
    const kod = dogruKod('http://ornek.test').replace(`${ilk}\n`, `${ilk}\n${satir}\n`);
    expect(statikHata(kod, testKaydi(), basitHarita)).toMatch(/rejected by the speed bump.*no (import|export) declaration/);
  });

  it('izinli satırla aynı satırdaki ikinci bildirimi reddeder', () => {
    const kod = dogruKod('http://ornek.test').replace(ilk, `${ilk}import fs from 'node:fs';`);
    expect(statikHata(kod, testKaydi(), basitHarita)).not.toBeNull();
    const yorumlu = dogruKod('http://ornek.test').replace(ilk, `${ilk}/**/import fs from 'node:fs';`);
    expect(statikHata(yorumlu, testKaydi(), basitHarita)).toContain('import');
  });

  it.each([
    ['require değer olarak', 'const r = require;'],
    ['require dizide', "[require][0]('node:fs');"],
    ['arguments ile sarmalayıcıya erişim', "arguments[1]('node:child_process');"],
  ])('%s reddedilir', (_ad, ekKod) => {
    const kod = `${dogruKod('http://ornek.test')}\n${ekKod}`;
    expect(statikHata(kod, testKaydi(), basitHarita)).toContain('rejected by the speed bump');
  });
});

describe('hız kesici: yanlış pozitifler (denetim 3 madde 9)', () => {
  const basitHarita = harita('http://ornek.test');
  const adimaEkle = (ek: string): string => dogruKod('http://ornek.test')
    .replace("await page.goto('http://ornek.test/liste');", `await page.goto('http://ornek.test/liste');\n${ek}`);

  it.each([
    ['değişken adı module', "    const module = page.getByTestId('module-card');\n    await expect(module).toBeVisible();"],
    ['değişken adı fs, iç blokta kullanım', "    const fs = page.getByRole('row');\n    if (true) { await expect(fs).toHaveCount(1); }"],
    ['özellik ve nesne anahtarı', '    const o = { module: 1, fs: 2, exports: 3 };\n    expect(o.module + o.fs + o.exports).toBe(6);'],
    ['if bloğundan sonra satır başı regex', "    const rows = await page.getByRole('row').allTextContents();\n    if (rows.length > 0) { expect(rows[0]).toBeTruthy(); }\n    /\\d+ kayıt/.test(rows.join(''));"],
    ['else bloğundan sonra regex', "    if (1) { } else { }\n    /a/.test('a');"],
    ['try/catch bloğundan sonra regex', "    try { } catch (e) { }\n    /a/.test('a');"],
    ['for bloğundan sonra regex', "    for (let i = 0; i < 2; i++) { }\n    /a/.test('a');"],
    ['ok gövdesinden sonra regex', "    const f = () => { };\n    /a/.test('a');"],
  ])('%s kabul edilir', (_ad, ek) => {
    expect(statikHata(adimaEkle(ek), testKaydi(), basitHarita)).toBeNull();
  });

  it.each([
    ['blok dışındaki gölge', "{ const module = 1; }\nmodule['req' + 'uire']('node:fs');"],
    ['for başlığındaki gölge', 'for (const module of []) { }\nmodule.paths;'],
    ['declare ile sahte gölge', 'declare const module: any;\nmodule.paths;'],
    ['var ile sahte gölge', 'var module;\nmodule.paths;'],
    ['yayma', 'console.log({ ...module });'],
    ['kısa nesne özelliği', 'console.log({ module });'],
    ['serbest __dirname', 'console.log(__dirname);'],
  ])('kaçış kapalı kalır: %s', (_ad, ekKod) => {
    const kod = `${dogruKod('http://ornek.test')}\n${ekKod}`;
    expect(statikHata(kod, testKaydi(), basitHarita)).toContain('rejected by the speed bump');
  });

  it.each([
    ['nesne literalinden sonra satır başı bölü', 'const o = {}\n/ 1 / 2;'],
    ['fonksiyon ifadesinden sonra bölü', 'const x = function () {} / 3 / 1;'],
    ['şablon ifadesinde nesneden sonra bölü', 'const s = `${ {a: 1}\n/ 2 / 1 }`;'],
  ])('gerçekten belirsiz bölü hâlâ reddedilir: %s', (_ad, ekKod) => {
    const kod = `${dogruKod('http://ornek.test')}\n${ekKod}`;
    expect(statikHata(kod, testKaydi(), basitHarita)).toContain('could not tell whether');
  });
});

describe('Playwright --list sır yalıtımı (denetim 3 madde 4b)', () => {
  it('liste doğrulamasında çalışan modül kodu sır ortam değişkenlerini göremez', async (context) => {
    if (!playwrightMumkun(context)) return;
    const kok = await geciciKobay();
    const dokum = join(kok, 'liste-ortam.json');
    const specYolu = join(kok, 'tests', 'sizinti.spec.ts');
    // Hız kesicinin aşıldığını varsayar: kodDogrula statik denetim yapmaz, doğrudan --list çalıştırır.
    await yazAtomik(specYolu, `import { test } from './_fixture';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(dokum)}, JSON.stringify(process.env));
test('boş', async () => {});
`);
    vi.stubEnv('FAKE_API_KEY', 'sahte-anahtar-7b2d');
    vi.stubEnv('KOBAY_LOGIN_PASS', 'sahte-parola-7b2d');
    vi.stubEnv('OPENROUTER_API_KEY', 'sahte-or-7b2d');
    try {
      expect((await kodDogrula(specYolu, kok)).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    const metin = await readFile(dokum, 'utf8');
    expect(metin).not.toContain('7b2d');
    expect((JSON.parse(metin) as Record<string, string>).PATH).toBeTruthy();
  });
});

async function playwrightCalistir(kok: string, specYolu: string, env: NodeJS.ProcessEnv): Promise<{ kod: number | null; stderr: string }> {
  return new Promise((coz, red) => {
    const surec = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', '--config', join(kok, 'playwright.config.ts'), specYolu], { cwd: kok, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    surec.stderr.setEncoding('utf8');
    surec.stderr.on('data', (parca: string) => { stderr += parca; });
    surec.once('error', red);
    surec.once('close', (kod) => { coz({ kod, stderr }); });
  });
}

/** 0.1.0 öncesi geçici şablonun birebir çıktısı; göç denetimi buna eşitlik arar. */
const ESKI_SABLON = [
  'export default {',
  "  testDir: 'tests',",
  "  reporter: [['json', { outputFile: 'son-liste.json' }]],",
  '  use: { baseURL: process.env.KOBAY_BASE_URL },',
  '  timeout: 120000,',
  '  fullyParallel: false,',
  '  workers: 1,',
  '};',
  '',
].join('\n');

describe('geçici Playwright config', () => {
  it('okunmayan son-liste.json reporter\'ını yazmaz; --list dosya bırakmaz', async (context) => {
    if (!playwrightMumkun(context)) return;
    const kok = await geciciKobay();
    const config = await readFile(join(kok, 'playwright.config.ts'), 'utf8');

    expect(config).not.toContain('son-liste.json');
    expect(config).not.toContain('reporter');

    const specYolu = join(kok, 'tests', 'liste.spec.ts');
    await yazAtomik(specYolu, "import { test } from './_fixture';\ntest('boş', async () => {});\n");
    expect((await kodDogrula(specYolu, kok)).ok).toBe(true);
    await expect(access(join(kok, 'son-liste.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('birebir eski şablon tazelenir, kalıcı config korunur', async () => {
    const kok = await mkdtemp(join(tmpdir(), 'kobay-uret-config-'));
    const configYolu = join(kok, 'playwright.config.ts');

    await yazAtomik(configYolu, ESKI_SABLON);
    await calismaAlaniHazirla(kok);
    await expect(readFile(configYolu, 'utf8')).resolves.not.toContain('son-liste.json');

    // Koşunun yazdığı kalıcı config'e dokunulmaz.
    const kalici = "export default {\n  reporter: [['json', { outputFile: process.env.KOBAY_RAPOR_DOSYASI }]],\n};\n";
    await yazAtomik(configYolu, kalici);
    await calismaAlaniHazirla(kok);
    await expect(readFile(configYolu, 'utf8')).resolves.toBe(kalici);
  });

  it('elle düzenlenmiş config ezilmez; uyarı basılır', async () => {
    const kok = await mkdtemp(join(tmpdir(), 'kobay-uret-config-ozel-'));
    const configYolu = join(kok, 'playwright.config.ts');
    // Eski şablon + kullanıcının kendi eklediği satır: artık kobay'ın dosyası değil.
    const ozel = ESKI_SABLON.replace("  workers: 1,\n", "  workers: 1,\n  retries: 2,\n");
    await yazAtomik(configYolu, ozel);

    const uyarilar: string[] = [];
    const casus = vi.spyOn(process.stderr, 'write').mockImplementation((parca: string | Uint8Array) => {
      uyarilar.push(String(parca));
      return true;
    });
    try {
      await calismaAlaniHazirla(kok);
    } finally {
      casus.mockRestore();
    }

    await expect(readFile(configYolu, 'utf8')).resolves.toBe(ozel);
    expect(uyarilar.join('')).toContain('remove the reporter line by hand');
  });
});

describe('fixture', () => {
  it('iki adımın kanıtlarını, konsol ve ağ günlüklerini yazar', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const kok = await geciciKobay();
    const kanitDizini = join(kok, 'run');
    const stateYolu = join(kok, 'storage.json');
    const tarayici: Browser = await chromium.launch({ headless: true });
    try {
      const girisContext = await tarayici.newContext();
      const girisSayfasi = await girisContext.newPage();
      await girisSayfasi.goto(`${demo.url}/login`);
      await girisSayfasi.getByLabel('Username').fill('demo');
      await girisSayfasi.getByLabel('Password').fill('demo123');
      await girisSayfasi.getByRole('button', { name: 'Log in' }).click();
      await yazAtomik(stateYolu, `${JSON.stringify(await girisContext.storageState())}\n`);
      await girisContext.close();
    } finally {
      await tarayici.close();
    }

    const specYolu = join(kok, 'tests', 'fixture.spec.ts');
    await yazAtomik(specYolu, `import { test, expect } from './_fixture';
test('fixture evidence', async ({ page }) => {
  await test.step('0: Go to the record list', async () => {
    await page.goto('${demo.url}/records');
    await page.evaluate(() => console.warn('fixture warning'));
    await page.evaluate(() => fetch('/fixture-yok'));
    await expect(page.getByRole('heading', { name: 'Record List' })).toBeVisible();
  });
  await test.step('1: Verify the first record', async () => {
    await expect(page.getByText('First record')).toBeVisible();
  });
});
`);
    const sonuc = await playwrightCalistir(kok, specYolu, {
      ...process.env,
      KOBAY_KOSU_DIZINI: kanitDizini,
      KOBAY_STORAGE_STATE: stateYolu,
    });
    expect(sonuc.kod, sonuc.stderr).toBe(0);
    await Promise.all([
      access(join(kanitDizini, 'adim-0.png')),
      access(join(kanitDizini, 'adim-0.html')),
      access(join(kanitDizini, 'adim-1.png')),
      access(join(kanitDizini, 'adim-1.html')),
      access(join(kanitDizini, 'console.json')),
      access(join(kanitDizini, 'network.json')),
    ]);
    const konsol = JSON.parse(await readFile(join(kanitDizini, 'console.json'), 'utf8'));
    expect(konsol).toContainEqual({ tip: 'warning', metin: 'fixture warning', stepIndex: 0 });
    expect(konsol.some((k: { tip: string; metin: string }) => k.tip === 'error' && k.metin.includes('404'))).toBe(true);
    expect(JSON.parse(await readFile(join(kanitDizini, 'network.json'), 'utf8'))).toEqual([
      expect.objectContaining({ method: 'GET', status: 404, stepIndex: 0 }),
    ]);
  });

  it('fixture şablonu verilen modülü yeniden dışa aktarır', () => {
    expect(fixtureSablonu('/tmp/kobay/dist/kos/fixture.js'))
      .toBe("export * from \"/tmp/kobay/dist/kos/fixture.js\";\n");
  });
});
