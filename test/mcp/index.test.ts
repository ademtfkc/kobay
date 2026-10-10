import { access, mkdir, readFile, readdir, realpath, rename, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { ANALIZ_ATLANDI } from '../../src/analiz/index.js';
import { beceriMetni } from '../../src/beceri/index.js';
import { KobayDizini, yazAtomik, type Harita, type HataPaketi, type TestKaydi } from '../../src/depo/index.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';
import { baslat } from '../kobay-demo/sunucu.mjs';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

async function bagliMcp(cwd: string, env?: NodeJS.ProcessEnv): Promise<{ istemci: Client; kapat: () => Promise<void> }> {
  const sunucu = mcpSunucusuOlustur({ cwd, ...(env === undefined ? {} : { env }) });
  const istemci = new Client({ name: 'kobay-test', version: '0.1.0' });
  const [sunucuTasima, istemciTasima] = InMemoryTransport.createLinkedPair();
  await Promise.all([sunucu.connect(sunucuTasima), istemci.connect(istemciTasima)]);
  return {
    istemci,
    kapat: async () => {
      await istemci.close();
      await sunucu.close();
    },
  };
}

function hataPaketi(): HataPaketi {
  return {
    snapshotId: 's_1',
    testId: 't_abc12345',
    runId: 'r_20260917010101_abcd',
    result: {
      testId: 't_abc12345',
      runId: 'r_20260917010101_abcd',
      status: 'failed',
      verdict: 'failed',
      startedAt: '2026-09-17T00:00:00.000Z',
      finishedAt: '2026-09-17T00:00:01.000Z',
      codeVersion: 1,
    },
    steps: [{ stepIndex: 0, description: 'Giriş yap', status: 'failed', durationMs: 10 }],
    code: 'test("giriş", async () => {});',
    failure: {
      rootCauseHypothesis: 'Buton görünmüyor',
      failureKind: 'test_bug',
      recommendedFixTarget: { kind: 'selector', reference: 'login', rationale: 'Rol değişti' },
      evidence: [],
    },
  };
}

describe('MCP sunucusu', () => {
  it('19 aracı listeler', async () => {
    const baglanti = await bagliMcp(await geciciDizinAc('kobay-mcp-'));
    try {
      const liste = await baglanti.istemci.listTools();
      expect(liste.tools).toHaveLength(19);
      expect(liste.tools.map((arac) => arac.name)).toEqual(expect.arrayContaining([
        'project_create', 'project_update', 'project_get', 'explore', 'plan_generate', 'plan_accept',
        'test_create', 'test_list', 'test_get', 'code_get', 'test_delete', 'test_run', 'test_rerun',
        'test_refresh', 'test_result', 'failure_get', 'prune', 'doctor', 'test_report',
      ]));
      const alanlar = (ad: string): string[] => Object.keys(
        (liste.tools.find((arac) => arac.name === ad)?.inputSchema.properties ?? {}) as Record<string, unknown>,
      );
      expect(alanlar('test_run')).toEqual(expect.arrayContaining(['ids', 'all', 'rerun', 'noAnalysis']));
      expect(alanlar('test_report').sort()).toEqual(['all', 'ids', 'maxPrompts', 'out', 'projectDir', 'summary']);
      for (const arac of liste.tools) {
        expect((arac.inputSchema.properties as Record<string, unknown>).projectDir).toBeDefined();
      }
      // Beceri araç tablosu sunucunun bütün araçlarını anar; yeni araç eklenince tablo da güncellenir.
      const beceriTablosu = beceriMetni().split('\n').filter((satir) => satir.startsWith('| '));
      const tablodaOlmayan = liste.tools
        .map((arac) => arac.name)
        .filter((ad) => !beceriTablosu.some((satir) => satir.includes(`\`${ad}\``)));
      expect(tablodaOlmayan).toEqual([]);
    } finally {
      await baglanti.kapat();
    }
  });

  it('araç ipuçlarını tools/list çıktısında verir: salt-okuma yok, yıkıcı ve yazan araçlar', async () => {
    const baglanti = await bagliMcp(await geciciDizinAc('kobay-mcp-'));
    try {
      const { tools } = await baglanti.istemci.listTools();
      const ipucu = Object.fromEntries(tools.map((arac) => [arac.name, arac.annotations]));
      // Her araç `.kobay` bakımı yazabildiği için hiçbiri readOnlyHint: true taşımaz.
      for (const arac of tools) expect(arac.annotations?.readOnlyHint, arac.name).toBe(false);
      const yikicilar = ['test_delete', 'prune', 'project_update', 'project_create'];
      for (const ad of yikicilar) {
        expect(ipucu[ad], ad).toEqual({ readOnlyHint: false, destructiveHint: true });
      }
      const yazanlar = tools.map((arac) => arac.name).filter((ad) => !yikicilar.includes(ad));
      expect(yazanlar).toEqual(expect.arrayContaining([
        'project_get', 'test_list', 'test_get', 'code_get', 'test_result', 'doctor', 'failure_get', 'test_report',
      ]));
      expect(yazanlar).toHaveLength(15);
      for (const ad of yazanlar) {
        expect(ipucu[ad], ad).toEqual({ readOnlyHint: false, destructiveHint: false });
      }
    } finally {
      await baglanti.kapat();
    }
  });

  it('prune previews by default and requires confirm true for deletion', async () => {
    const cwd = await geciciDizinAc('kobay-mcp-prune-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://localhost:3000', brain: { adaptor: 'sahte' } });
    await writeFile(dizin.yol('failure-out', 'trace.zip'), 'legacy');
    await utimes(dizin.yol('failure-out', 'trace.zip'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const baglanti = await bagliMcp(cwd);
    try {
      const onizleme = await baglanti.istemci.callTool({
        name: 'prune', arguments: { maxMb: 25, olderThanDays: 2 },
      });
      expect(onizleme.isError).not.toBe(true);
      expect(JSON.parse((onizleme.content[0] as { text: string }).text)).toMatchObject({
        dryRun: true,
        policy: { maxMb: 25, olderThanDays: 2 },
        deleted: [],
        wouldDelete: [{ path: '.kobay/failure-out/trace.zip', kind: 'legacy-failure-file' }],
      });
      await expect(access(dizin.yol('failure-out', 'trace.zip'))).resolves.toBeUndefined();

      const zorlananOnizleme = await baglanti.istemci.callTool({
        name: 'prune', arguments: { confirm: true, dryRun: true },
      });
      expect(JSON.parse((zorlananOnizleme.content[0] as { text: string }).text)).toMatchObject({ dryRun: true });
      await expect(access(dizin.yol('failure-out', 'trace.zip'))).resolves.toBeUndefined();

      const sil = await baglanti.istemci.callTool({ name: 'prune', arguments: { confirm: true } });
      expect(sil.isError).not.toBe(true);
      expect(JSON.parse((sil.content[0] as { text: string }).text)).toMatchObject({
        dryRun: false,
        deleted: [{ path: '.kobay/failure-out/trace.zip', kind: 'legacy-failure-file' }],
        wouldDelete: [],
      });
      await expect(access(dizin.yol('failure-out', 'trace.zip'))).rejects.toThrow();
    } finally {
      await baglanti.kapat();
    }
  });

  it('package.json sürümünü ve kısa İngilizce kullanım talimatını bildirir', async () => {
    const baglanti = await bagliMcp(await geciciDizinAc('kobay-mcp-'));
    try {
      const paket = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
      expect(baglanti.istemci.getServerVersion()?.version).toBe(paket.version);
      expect(baglanti.istemci.getInstructions()).toContain('Use test_run');
      expect(baglanti.istemci.getInstructions()).toContain('test_refresh only for product_changed');
      expect(baglanti.istemci.getInstructions()).toContain('prune tool previews by default');
      expect(baglanti.istemci.getInstructions()).toContain('confirm true');
      expect(baglanti.istemci.getInstructions()).toContain('Finish with test_report');
    } finally {
      await baglanti.kapat();
    }
  });

  it('proje yoksa test_list MCP hatası ve JSON metni döndürür', async () => {
    const baglanti = await bagliMcp(await geciciDizinAc('kobay-mcp-'));
    try {
      const sonuc = await baglanti.istemci.callTool({ name: 'test_list', arguments: {} });
      expect(sonuc.isError).toBe(true);
      expect(sonuc.content).toEqual([{ type: 'text', text: expect.stringContaining('not inside a Kobay project') }]);
      // Aracın kendi denetimi de komut hatalarıyla aynı zarfı verir: `{"error": {"code", "message"}}`.
      expect(JSON.parse((sonuc.content[0] as { text: string }).text)).toEqual({
        error: { code: 'UsageError', message: expect.stringContaining('not inside a Kobay project') },
      });
    } finally {
      await baglanti.kapat();
    }
  });

  it('project_create yalnız sabit KOBAY_LOGIN_PASS kullanır ve env adı seçimini reddeder', async () => {
    const cwd = await geciciDizinAc('kobay-mcp-');
    const baglanti = await bagliMcp(cwd, {
      KOBAY_LOGIN_PASS: 'sifre-test-123',
      KOBAY_LOGIN_ORIGIN: 'http://localhost:3000',
      ANTHROPIC_API_KEY: 'api-anahtari-sizmasin',
    });
    try {
      const liste = await baglanti.istemci.listTools();
      const olusturSemasi = liste.tools.find((arac) => arac.name === 'project_create')?.inputSchema;
      expect(olusturSemasi?.properties).not.toHaveProperty('loginPass');
      expect(olusturSemasi?.properties).not.toHaveProperty('loginPassEnv');
      const envSecimi = await baglanti.istemci.callTool({
        name: 'project_create',
        arguments: {
          url: 'http://localhost:3000',
          loginUser: 'demo',
          loginPassEnv: 'ANTHROPIC_API_KEY',
        },
      });
      expect(envSecimi.isError).toBe(true);
      await expect(access(join(cwd, '.kobay'))).rejects.toThrow();

      const olustur = await baglanti.istemci.callTool({
        name: 'project_create',
        arguments: {
          url: 'http://localhost:3000',
          loginUser: 'demo',
        },
      });
      expect(olustur.isError).not.toBe(true);
      expect(JSON.stringify(olustur)).not.toContain('sifre-test-123');
      const kimlikMetni = await readFile(join(cwd, '.kobay', 'credentials.json'), 'utf8');
      expect(kimlikMetni).toContain('sifre-test-123');
      expect(kimlikMetni).not.toContain('api-anahtari-sizmasin');
      const getir = await baglanti.istemci.callTool({ name: 'project_get', arguments: {} });
      const metin = (getir.content[0] as { text: string }).text;
      expect(metin).not.toContain('sifre-test-123');
      expect(JSON.parse(metin)).toMatchObject({ config: { baseUrl: 'http://localhost:3000' } });
    } finally {
      await baglanti.kapat();
    }
  });
  it('project_update yalnız verilen alanı değiştirir, proje yoksa hata döner', async () => {
    const cwd = await geciciDizinAc('kobay-mcp-');
    const baglanti = await bagliMcp(cwd);
    try {
      const projesiz = await baglanti.istemci.callTool({
        name: 'project_update',
        arguments: { loginUrl: 'http://localhost:3000/giris' },
      });
      expect(projesiz.isError).toBe(true);

      await baglanti.istemci.callTool({
        name: 'project_create',
        arguments: { url: 'http://localhost:3000', docs: 'docs/rehber.md' },
      });
      const guncelle = await baglanti.istemci.callTool({
        name: 'project_update',
        arguments: { loginUrl: 'http://localhost:3000/giris', brain: 'claude' },
      });
      expect(guncelle.isError).not.toBe(true);
      expect(JSON.parse((guncelle.content[0] as { text: string }).text)).toMatchObject({
        config: {
          baseUrl: 'http://localhost:3000',
          docsPath: 'docs/rehber.md',
          loginUrl: 'http://localhost:3000/giris',
          brain: { adaptor: 'claude' },
        },
      });
      const disOrigin = await baglanti.istemci.callTool({
        name: 'project_update',
        arguments: { loginUrl: 'http://kimlik.test/giris' },
      });
      expect(disOrigin.isError).toBe(true);
      expect((disOrigin.content[0] as { text: string }).text).toContain('same origin as baseUrl');
      const liste = await baglanti.istemci.listTools();
      const guncelleme = liste.tools.find((arac) => arac.name === 'project_update')?.inputSchema;
      const beyinSemasi = (guncelleme?.properties as Record<string, { enum?: string[] }> | undefined)?.brain;
      expect(beyinSemasi?.enum).toEqual(['claude', 'codex', 'openrouter']);
    } finally {
      await baglanti.kapat();
    }
  });

  it('giriş bilgisini başka origin\'e bağlama reddi aynı hata zarfında PermissionError döner', async () => {
    const cwd = await geciciDizinAc('kobay-mcp-');
    const baglanti = await bagliMcp(cwd, { KOBAY_LOGIN_PASS: 'sifre-test-123', KOBAY_LOGIN_ORIGIN: 'http://localhost:3000' });
    try {
      const sonuc = await baglanti.istemci.callTool({
        name: 'project_create', arguments: { url: 'http://baska.test', loginUser: 'demo' },
      });
      expect(sonuc.isError).toBe(true);
      expect(JSON.parse((sonuc.content[0] as { text: string }).text)).toEqual({
        error: { code: 'PermissionError', message: expect.stringContaining('Credentials may only be given for KOBAY_LOGIN_ORIGIN') },
      });
    } finally {
      await baglanti.kapat();
    }
  });

  it('project_create ve project_update yalnız http(s) adres kabul eder', async () => {
    const cwd = await geciciDizinAc('kobay-mcp-');
    const baglanti = await bagliMcp(cwd);
    const ipucu = 'Use an http:// or https:// URL, e.g. http://localhost:3000';
    const metin = (sonuc: Awaited<ReturnType<Client['callTool']>>): string => (sonuc.content as Array<{ text: string }>)[0]?.text ?? '';
    try {
      for (const url of ['localhost:3000', 'ftp://x', 'http:example.com', 'http:/example.com', 'ht\ntp://x', 'http://x y']) {
        const sonuc = await baglanti.istemci.callTool({ name: 'project_create', arguments: { url } });
        expect(sonuc.isError, url).toBe(true);
        expect(JSON.parse(metin(sonuc)), url).toEqual({ error: { code: 'UsageError', message: expect.stringContaining(ipucu) } });
      }
      await expect(access(join(cwd, '.kobay'))).rejects.toThrow();

      await baglanti.istemci.callTool({ name: 'project_create', arguments: { url: 'http://localhost:3000' } });
      for (const alan of [
        { baseUrl: 'localhost:3000' }, { loginUrl: 'ftp://localhost:3000/giris' },
        { baseUrl: 'http:/localhost:3000' }, { loginUrl: 'http://localhost:3000/gi\nris' },
      ]) {
        const sonuc = await baglanti.istemci.callTool({ name: 'project_update', arguments: alan });
        expect(sonuc.isError).toBe(true);
        expect(metin(sonuc)).toContain(ipucu);
      }
    } finally {
      await baglanti.kapat();
    }
  });

  it('projectDir ile sunucu cwd dışındaki Kobay projesini seçer, normal dizini reddeder', async () => {
    const sunucuKoku = await geciciDizinAc('kobay-mcp-server-');
    const projeKoku = join(sunucuKoku, 'uygulama');
    const normalDizin = join(sunucuKoku, 'normal');
    await Promise.all([mkdir(projeKoku), mkdir(normalDizin)]);
    await KobayDizini.ac(projeKoku, { baseUrl: 'http://proje.test', beyin: { adaptor: 'sahte' } });
    const baglanti = await bagliMcp(sunucuKoku);
    try {
      const getir = await baglanti.istemci.callTool({
        name: 'project_get', arguments: { projectDir: projeKoku },
      });
      expect(getir.isError).not.toBe(true);
      expect(JSON.parse((getir.content[0] as { text: string }).text)).toMatchObject({
        config: { baseUrl: 'http://proje.test' },
      });

      const reddedilen = await baglanti.istemci.callTool({
        name: 'project_get', arguments: { projectDir: normalDizin },
      });
      expect(reddedilen.isError).toBe(true);
      expect((reddedilen.content[0] as { text: string }).text).toContain('not inside a Kobay project');
    } finally {
      await baglanti.kapat();
    }
  });

  it('projectDir izinli MCP kökleri dışındaysa reddeder, başlangıç ortamındaki ek kökü kabul eder', async () => {
    const sunucuKoku = await geciciDizinAc('kobay-mcp-root-');
    const disKok = await geciciDizinAc('kobay-mcp-dis-');
    await KobayDizini.ac(disKok, { baseUrl: 'http://dis.test', beyin: { adaptor: 'sahte' } });

    const sinirli = await bagliMcp(sunucuKoku);
    try {
      const sonuc = await sinirli.istemci.callTool({ name: 'project_get', arguments: { projectDir: disKok } });
      expect(sonuc.isError).toBe(true);
      expect((sonuc.content[0] as { text: string }).text).toContain('is outside the allowed MCP roots');
    } finally {
      await sinirli.kapat();
    }

    const ekKoklu = await bagliMcp(sunucuKoku, { KOBAY_MCP_ROOTS: disKok });
    try {
      const sonuc = await ekKoklu.istemci.callTool({ name: 'project_get', arguments: { projectDir: disKok } });
      expect(sonuc.isError).not.toBe(true);
    } finally {
      await ekKoklu.kapat();
    }
  });

  it('docs, planPath ve out yollarının proje kökünden kaçmasını engeller', async () => {
    const sunucuKoku = await geciciDizinAc('kobay-mcp-yol-');
    const projeKoku = join(sunucuKoku, 'uygulama');
    const yeniProje = join(sunucuKoku, 'yeni-uygulama');
    const disPlan = join(sunucuKoku, 'dis-plan.json');
    const disDizin = join(sunucuKoku, 'dis-dizin');
    await Promise.all([mkdir(projeKoku), mkdir(yeniProje), mkdir(disDizin), writeFile(disPlan, '{}')]);
    await KobayDizini.ac(projeKoku, { baseUrl: 'http://proje.test', beyin: { adaptor: 'sahte' } });
    await symlink(disDizin, join(projeKoku, 'disari-link'));
    const baglanti = await bagliMcp(sunucuKoku);
    try {
      const sonuclar = await Promise.all([
        baglanti.istemci.callTool({
          name: 'project_create',
          arguments: { projectDir: yeniProje, url: 'http://yeni.test', docs: '../dis-plan.json' },
        }),
        baglanti.istemci.callTool({
          name: 'project_update',
          arguments: { projectDir: projeKoku, docsPath: '../dis-plan.json' },
        }),
        baglanti.istemci.callTool({
          name: 'test_create',
          arguments: { projectDir: projeKoku, planPath: '../dis-plan.json' },
        }),
        baglanti.istemci.callTool({
          name: 'failure_get',
          arguments: { projectDir: projeKoku, id: 't_abcd1234', out: '../dis-dizin' },
        }),
        baglanti.istemci.callTool({
          name: 'failure_get',
          arguments: { projectDir: projeKoku, id: 't_abcd1234', out: 'disari-link/paket' },
        }),
        // Canlı denemede "MCP /tmp/... kabul etti" denmişti: mutlak yol da kök dışıdır.
        baglanti.istemci.callTool({
          name: 'failure_get',
          arguments: { projectDir: projeKoku, id: 't_abcd1234', out: join(disDizin, 'paket') },
        }),
      ]);
      for (const sonuc of sonuclar) {
        expect(sonuc.isError).toBe(true);
        expect((sonuc.content[0] as { text: string }).text).toContain('cannot be outside the project root');
      }
      await expect(access(join(yeniProje, '.kobay'))).rejects.toThrow();
    } finally {
      await baglanti.kapat();
    }
  });

  it('kaydedildikten sonra dışarı çevrilen docsPath symlinkini okuma anında reddeder', async () => {
    const sunucuKoku = await geciciDizinAc('kobay-mcp-docs-');
    const projeKoku = join(sunucuKoku, 'uygulama');
    const disBelge = join(sunucuKoku, 'gizli.md');
    await mkdir(projeKoku);
    await Promise.all([writeFile(join(projeKoku, 'belge.md'), 'iç belge'), writeFile(disBelge, 'gizli')]);
    await symlink(join(projeKoku, 'belge.md'), join(projeKoku, 'belge-link'));
    const baglanti = await bagliMcp(sunucuKoku);
    try {
      const olustur = await baglanti.istemci.callTool({
        name: 'project_create',
        arguments: { projectDir: projeKoku, url: 'http://proje.test', docs: 'belge-link' },
      });
      expect(olustur.isError).not.toBe(true);
      const dizin = await KobayDizini.bul(projeKoku);
      await dizin?.haritaYaz({
        baseUrl: 'http://proje.test', loggedIn: false,
        exploredAt: '2026-09-21T00:00:00.000Z', pages: [],
      });

      await rename(join(projeKoku, 'belge-link'), join(projeKoku, 'eski-belge-link'));
      await symlink(disBelge, join(projeKoku, 'belge-link'));
      const sonuc = await baglanti.istemci.callTool({
        name: 'plan_generate', arguments: { projectDir: projeKoku },
      });
      expect(sonuc.isError).toBe(true);
      expect((sonuc.content[0] as { text: string }).text).toContain('docsPath cannot be outside the project root');
    } finally {
      await baglanti.kapat();
    }
  });

  it('test_refresh testi ve haritayı denetler; tarayıcı gerektirmeden hata döndürür', async () => {
    const cwd = await geciciDizinAc('kobay-mcp-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    const harita: Harita = {
      baseUrl: 'http://uygulama.test',
      loggedIn: true,
      exploredAt: '2026-09-17T00:00:00.000Z',
      pages: [{
        url: 'http://uygulama.test/cariler', title: 'Cariler', headings: ['Cariler'],
        links: [], forms: [], buttons: [], menu: [],
      }],
    };
    await dizin.haritaYaz(harita);
    const test: TestKaydi = {
      id: 't_abc12345', name: 'URL’siz test', type: 'frontend', createdFrom: 'plan', status: 'failed',
      planSteps: [{ type: 'action', description: 'Aç' }], priority: 'p0', codeVersion: 1,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    };
    await dizin.testYaz(test);
    await dizin.testYaz({ ...test, id: 't_bcd12345', url: '/faturalar' });

    const baglanti = await bagliMcp(cwd);
    try {
      const bilinmeyen = await baglanti.istemci.callTool({
        name: 'test_refresh', arguments: { id: 't_zzz99999', run: false },
      });
      expect(bilinmeyen.isError).toBe(true);

      const urlsuz = await baglanti.istemci.callTool({
        name: 'test_refresh', arguments: { id: 't_abc12345', run: false },
      });
      expect(urlsuz.isError).toBe(true);
      expect((urlsuz.content as [{ text: string }])[0].text).toContain('URL');

      const haritadaYok = await baglanti.istemci.callTool({
        name: 'test_refresh', arguments: { id: 't_bcd12345', run: false },
      });
      expect(haritadaYok.isError).toBe(true);
      expect((haritadaYok.content as [{ text: string }])[0].text).toContain('not in the exploration map');
      await expect(dizin.haritaOku()).resolves.toEqual(harita);
    } finally {
      await baglanti.kapat();
    }
  });

  it('baseUrl değiştirilerek ya da create --force ile parola başka origin\'e gönderilemez', async () => {
    const yakalanan: string[] = [];
    const sunucuAc = (ad: string): Promise<{ url: string; kapat: () => Promise<void> }> => new Promise((coz) => {
      const sunucu = createServer((istek, yanit) => {
        let govde = '';
        istek.on('data', (parca: Buffer) => { govde += parca.toString(); });
        istek.on('end', () => {
          if (istek.method === 'POST') {
            yakalanan.push(`${ad}: ${govde}`);
            yanit.writeHead(302, { location: '/panel' });
            yanit.end();
            return;
          }
          yanit.writeHead(200, { 'content-type': 'text/html' });
          yanit.end('<form method="post" action="/giris"><input type="text" name="u"><input type="password" name="p"><button type="submit">Giriş</button></form>');
        });
      });
      sunucu.listen(0, '127.0.0.1', () => {
        const adres = sunucu.address();
        coz({
          url: `http://127.0.0.1:${typeof adres === 'object' && adres !== null ? adres.port : 0}`,
          kapat: () => new Promise((bitti) => { sunucu.close(() => bitti()); }),
        });
      });
    });
    const [mesru, kotu] = await Promise.all([sunucuAc('MESRU'), sunucuAc('KOTU')]);
    const cwd = await geciciDizinAc('kobay-mcp-origin-');
    const baglanti = await bagliMcp(cwd, { KOBAY_LOGIN_PASS: 'GIZLI-PAROLA-123', KOBAY_LOGIN_ORIGIN: mesru.url });
    const metin = (sonuc: Awaited<ReturnType<Client['callTool']>>): string => (sonuc.content as [{ text: string }])[0].text;
    try {
      const olustur = await baglanti.istemci.callTool({
        name: 'project_create', arguments: { url: mesru.url, loginUser: 'ali' },
      });
      expect(olustur.isError).not.toBe(true);

      // Ajan project_create --force ile ortamdaki parolayı kötü origin'e yeniden bağlayamaz.
      const yenidenBagla = await baglanti.istemci.callTool({
        name: 'project_create', arguments: { url: kotu.url, loginUser: 'ali', force: true },
      });
      expect(yenidenBagla.isError).toBe(true);
      expect(metin(yenidenBagla)).toContain('KOBAY_LOGIN_ORIGIN');

      const guncelle = await baglanti.istemci.callTool({ name: 'project_update', arguments: { baseUrl: kotu.url } });
      expect(guncelle.isError).not.toBe(true);
      expect(metin(guncelle)).toContain('invalidated');
      await expect(access(join(cwd, '.kobay', 'credentials.json'))).rejects.toThrow();

      await baglanti.istemci.callTool({ name: 'explore', arguments: {} });
      expect(yakalanan.join('\n')).not.toContain('GIZLI-PAROLA-123');
    } finally {
      await baglanti.kapat();
      await Promise.all([mesru.kapat(), kotu.kapat()]);
    }
  });

  it('planPath ve docsPath .kobay altını ve gizli dosyaları gösteremez', async () => {
    const cwd = await geciciDizinAc('kobay-mcp-sir-');
    const baglanti = await bagliMcp(cwd, { KOBAY_LOGIN_PASS: 'GIZLI-PAROLA-123', KOBAY_LOGIN_ORIGIN: 'http://127.0.0.1:9' });
    try {
      const olusturIlk = await baglanti.istemci.callTool({
        name: 'project_create', arguments: { url: 'http://127.0.0.1:9', loginUser: 'ali' },
      });
      expect(olusturIlk.isError).not.toBe(true);
      await writeFile(join(cwd, '.env'), 'SIR=1\n');
      for (const planPath of ['.kobay/credentials.json', '.env']) {
        const sonuc = await baglanti.istemci.callTool({ name: 'test_create', arguments: { planPath } });
        expect(sonuc.isError, planPath).toBe(true);
        expect(JSON.stringify(sonuc), planPath).not.toContain('GIZLI-PAROLA-123');
        expect(JSON.stringify(sonuc), planPath).toContain('name starts with a dot');
      }
      for (const docsPath of ['.kobay/credentials.json', '.env']) {
        const sonuc = await baglanti.istemci.callTool({ name: 'project_update', arguments: { docsPath } });
        expect(sonuc.isError, docsPath).toBe(true);
        const olustur = await baglanti.istemci.callTool({
          name: 'project_create', arguments: { url: 'http://127.0.0.1:9', docs: docsPath, force: true },
        });
        expect(olustur.isError, docsPath).toBe(true);
      }
      const getir = await baglanti.istemci.callTool({ name: 'project_get', arguments: {} });
      expect(JSON.parse((getir.content[0] as { text: string }).text).config.docsPath).toBeUndefined();
    } finally {
      await baglanti.kapat();
    }
  });

  it('loginUser parolayı yalnız KOBAY_LOGIN_ORIGIN\'e bağlar: yeni alt dizinde kötü adres reddedilir, POST yok', async () => {
    const yakalanan: string[] = [];
    const sunucuAc = (): Promise<{ url: string; kapat: () => Promise<void> }> => new Promise((coz) => {
      const sunucu = createServer((istek, yanit) => {
        let govde = '';
        istek.on('data', (parca: Buffer) => { govde += parca.toString(); });
        istek.on('end', () => {
          if (istek.method === 'POST') {
            yakalanan.push(govde);
            yanit.writeHead(302, { location: '/panel' });
            yanit.end();
            return;
          }
          yanit.writeHead(200, { 'content-type': 'text/html' });
          yanit.end('<form method="post" action="/giris"><input type="text" name="u"><input type="password" name="p"><button type="submit">Giriş</button></form>');
        });
      });
      sunucu.listen(0, '127.0.0.1', () => {
        const adres = sunucu.address();
        coz({
          url: `http://127.0.0.1:${typeof adres === 'object' && adres !== null ? adres.port : 0}`,
          kapat: () => new Promise((bitti) => { sunucu.close(() => bitti()); }),
        });
      });
    });
    const [mesru, kotu] = await Promise.all([sunucuAc(), sunucuAc()]);
    const kok = await geciciDizinAc('kobay-mcp-altdizin-');
    await mkdir(join(kok, 'yeni'));
    const metin = (sonuc: Awaited<ReturnType<Client['callTool']>>): string => (sonuc.content as [{ text: string }])[0].text;
    const kilitli = await bagliMcp(kok, { KOBAY_LOGIN_PASS: 'GIZLI-PAROLA-123', KOBAY_LOGIN_ORIGIN: mesru.url });
    try {
      const kotuProje = await kilitli.istemci.callTool({
        name: 'project_create', arguments: { projectDir: 'yeni', url: kotu.url, loginUser: 'ali' },
      });
      expect(kotuProje.isError).toBe(true);
      expect(metin(kotuProje)).toContain('KOBAY_LOGIN_ORIGIN');
      await expect(access(join(kok, 'yeni', '.kobay'))).rejects.toThrow();
      // Proje açılamadığı için keşif de yapılamaz; kötü sunucuya parola gitmez.
      await kilitli.istemci.callTool({ name: 'explore', arguments: { projectDir: 'yeni' } });
      expect(yakalanan.join('\n')).not.toContain('GIZLI-PAROLA-123');
      expect(yakalanan).toEqual([]);

      // Meşru origin'de aynı çağrı çalışır.
      const mesruProje = await kilitli.istemci.callTool({
        name: 'project_create', arguments: { projectDir: 'yeni', url: `${mesru.url}/uygulama`, loginUser: 'ali' },
      });
      expect(mesruProje.isError).not.toBe(true);
    } finally {
      await kilitli.kapat();
    }

    const tanimsiz = await bagliMcp(await geciciDizinAc('kobay-mcp-tanimsiz-'), { KOBAY_LOGIN_PASS: 'GIZLI-PAROLA-123' });
    try {
      const sonuc = await tanimsiz.istemci.callTool({
        name: 'project_create', arguments: { url: kotu.url, loginUser: 'ali' },
      });
      expect(sonuc.isError).toBe(true);
      expect(metin(sonuc)).toContain('KOBAY_LOGIN_ORIGIN is not set');
    } finally {
      await tanimsiz.kapat();
      await Promise.all([mesru.kapat(), kotu.kapat()]);
    }
  });

  it('failure_get out .kobay, .git, .claude gibi gizli dizinlere yazmaz', async () => {
    const cwd = await geciciDizinAc('kobay-mcp-out-');
    await KobayDizini.ac(cwd, { baseUrl: 'http://proje.test', beyin: { adaptor: 'sahte' } });
    const baglanti = await bagliMcp(cwd);
    try {
      const reddedilecek = [
        '.git/hooks-x',
        '.claude/skills/x',
        '.kobay/tests/x',
        '.kobay/failure-out',
        '.kobay/failure-out/../credentials.json',
        '.kobay/failure-out/x/../../storageState.json',
        '.kobay/failure-out/.gizli',
        'alt/.gizli',
      ];
      for (const out of reddedilecek) {
        const sonuc = await baglanti.istemci.callTool({ name: 'failure_get', arguments: { id: 't_abc12345', out } });
        expect(sonuc.isError, out).toBe(true);
        expect((sonuc.content[0] as { text: string }).text, out).toContain('name starts with a dot');
      }
      // Tek istisna: paket oturum çerezi taşır, .kobay/failure-out/ zaten git'e girmez.
      for (const out of ['paket', '.kobay/failure-out/x', '.kobay/failure-out/t_abc12345-1/alt']) {
        const sonuc = await baglanti.istemci.callTool({ name: 'failure_get', arguments: { id: 't_abc12345', out } });
        expect((sonuc.content[0] as { text: string }).text, out).not.toContain('name starts with a dot');
      }
    } finally {
      await baglanti.kapat();
    }
  });

  it('test_run noAnalysis never generates code: a test without code is blocked; test_report then reports it from disk', async () => {
    const cwd = await realpath(await geciciDizinAc('kobay-mcp-rapor-'));
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://127.0.0.1:9', beyin: { adaptor: 'sahte' } });
    await dizin.testYaz({
      id: 't_mcpr1234', name: 'shows the login heading', type: 'frontend', createdFrom: 'cli', status: 'draft',
      planSteps: [{ type: 'action', description: 'Open the login page' }],
      priority: 'p1', codeVersion: 0,
      createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
    });
    const alt = join(cwd, 'alt');
    await mkdir(alt);
    const baglanti = await bagliMcp(cwd);
    const metin = (sonuc: Awaited<ReturnType<typeof baglanti.istemci.callTool>>): string => (
      (sonuc.content as Array<{ text: string }>)[0]?.text ?? ''
    );
    try {
      // noAnalysis testRun'a ulaşır: beyin hiç çağrılmadan kodsuz test engellenir (exit 3 = araç hatası).
      const kosu = await baglanti.istemci.callTool({ name: 'test_run', arguments: { ids: ['t_mcpr1234'], noAnalysis: true } });
      expect(kosu.isError).toBe(true);
      expect(metin(kosu)).toContain('locally with a brain');
      await expect(dizin.kodOku('t_mcpr1234')).resolves.toBeNull();
      expect((await dizin.kosuListele('t_mcpr1234')).map((k) => k.verdict)).toEqual(['blocked']);

      // Varsayılan klasör + özet; göreli summary projectDir'e (burada alt/) göre çözülür, CLI --cwd gibi.
      const rapor = await baglanti.istemci.callTool({
        name: 'test_report', arguments: { projectDir: alt, all: true, summary: 'summary.md', maxPrompts: 1 },
      });
      expect(rapor.isError, metin(rapor)).not.toBe(true);
      const veri = JSON.parse(metin(rapor)) as Record<string, unknown>;
      expect(veri).toMatchObject({
        reportDir: join(cwd, '.kobay', 'report'),
        indexPath: join(cwd, '.kobay', 'report', 'index.html'),
        summaryPath: join(alt, 'summary.md'),
        counts: { blocked: 1, notRun: 0 },
      });
      expect(Array.isArray(veri.fixPrompts)).toBe(true);
      await access(join(cwd, '.kobay', 'report', 'index.html'));
      expect(await readFile(join(alt, 'summary.md'), 'utf8')).toContain('<!-- kobay-report -->');

      // CLI ile aynı kullanım hatası; proje dışı ve gizli dizin hedefi reddedilir, hiçbir şey yazılmaz.
      const tekBasina = await baglanti.istemci.callTool({ name: 'test_report', arguments: { all: true, maxPrompts: 2 } });
      expect(tekBasina.isError).toBe(true);
      expect(metin(tekBasina)).toContain('--max-prompts only applies together with --summary <path>');
      const disari = await baglanti.istemci.callTool({
        name: 'test_report', arguments: { all: true, out: join(tmpdir(), 'kobay-mcp-dis-rapor') },
      });
      expect(disari.isError).toBe(true);
      expect(metin(disari)).toContain('out cannot be outside the project root');
      const gizli = await baglanti.istemci.callTool({ name: 'test_report', arguments: { all: true, out: '.git/rapor' } });
      expect(gizli.isError).toBe(true);
      expect(metin(gizli)).toContain('name starts with a dot');
      await expect(access(join(cwd, '.git'))).rejects.toThrow();
    } finally {
      await baglanti.kapat();
    }
  });

  it('test_report summary and out cannot leave the project root (absolute, .., symlink) and write nothing outside', async () => {
    const sunucuKoku = await realpath(await geciciDizinAc('kobay-mcp-rapor-yol-'));
    const projeKoku = join(sunucuKoku, 'uygulama');
    const disDizin = join(sunucuKoku, 'dis');
    const alt = join(projeKoku, 'alt');
    await mkdir(projeKoku);
    await mkdir(disDizin);
    const dizin = await KobayDizini.ac(projeKoku, { baseUrl: 'http://127.0.0.1:9', beyin: { adaptor: 'sahte' } });
    await dizin.testYaz({
      id: 't_rpyl1234', name: 'shows the login heading', type: 'frontend', createdFrom: 'cli', status: 'draft',
      planSteps: [{ type: 'action', description: 'Open the login page' }],
      priority: 'p1', codeVersion: 0,
      createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
    });
    await mkdir(alt);
    await symlink(disDizin, join(projeKoku, 'disari-link'));
    const baglanti = await bagliMcp(sunucuKoku);
    try {
      const durumlar: Array<[string, Record<string, unknown>, string]> = [
        ['summary absolute', { projectDir: projeKoku, all: true, summary: join(disDizin, 'mutlak.md') }, 'summary'],
        ['summary ..', { projectDir: alt, all: true, summary: '../../dis/kacis.md' }, 'summary'],
        ['summary symlink', { projectDir: projeKoku, all: true, summary: 'disari-link/link.md' }, 'summary'],
        ['out symlink', { projectDir: projeKoku, all: true, out: 'disari-link/rapor' }, 'out'],
      ];
      for (const [ad, argumanlar, alan] of durumlar) {
        const sonuc = await baglanti.istemci.callTool({ name: 'test_report', arguments: argumanlar });
        const metin = (sonuc.content as Array<{ text: string }>)[0]?.text ?? '';
        expect(sonuc.isError, `${ad}: ${metin}`).toBe(true);
        expect(metin, ad).toContain(`${alan} cannot be outside the project root`);
      }
      // Dışarıda hiçbir dosya oluşmadı; sınır yazımdan önce denetlendi.
      expect(await readdir(disDizin)).toEqual([]);
      await expect(access(join(projeKoku, '.kobay', 'report'))).rejects.toThrow();
    } finally {
      await baglanti.kapat();
    }
  });

  it('failure_get out verilmezse hep .kobay/failure-out/<id> kullanır, çöp klasör açmaz', async () => {
    const cwd = await realpath(await geciciDizinAc('kobay-mcp-varsayilan-'));
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://proje.test', beyin: { adaptor: 'sahte' } });
    await dizin.hataPaketiYaz(hataPaketi(), []);
    const cikisKoku = join(cwd, '.kobay', 'failure-out');
    const baglanti = await bagliMcp(cwd);
    try {
      for (const tur of ['ilk', 'ikinci']) {
        const sonuc = await baglanti.istemci.callTool({ name: 'failure_get', arguments: { id: 't_abc12345' } });
        expect(sonuc.isError, tur).toBeUndefined();
        expect(JSON.parse((sonuc.content[0] as { text: string }).text) as { hedef: string }).toEqual({
          id: 't_abc12345',
          destination: join(cikisKoku, 't_abc12345'),
        });
        await access(join(cikisKoku, 't_abc12345', 'failure.json'));
      }
      // İkinci çağrı aynı klasörü yeniler; -1/-2 gibi kopyalar ya da geçici artık kalmaz.
      expect(await readdir(cikisKoku)).toEqual(['t_abc12345']);
    } finally {
      await baglanti.kapat();
    }
  });
});

/**
 * `test_run` + `noAnalysis` kodu olan, gerçekten düşen bir testte: demo uygulama +
 * gerçek Chromium (test/cli/analizsiz-kosu.test.ts ile aynı kurgu). Sahte beyne her
 * görev için HAZIR yanıt verilir; beyin çağrılsaydı analiz `product_bug` dönerdi ve
 * `.kobay/logs` altına `brain-*` günlüğü düşerdi.
 */
describe('MCP test_run noAnalysis (real demo run, no brain)', () => {
  const TEST_ID = 't_mcpn1234';
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

  afterEach(() => { delete process.env.KOBAY_SAHTE_YANIT_DIZINI; });

  function playwrightMumkun(context: TestContext): boolean {
    if (tarayiciEngeli === undefined) return true;
    // Katı kipte (CI) Chromium yoksa atlama değil hata.
    if (process.env.KOBAY_CHROMIUM_TEST === '1') throw tarayiciEngeli;
    context.skip(`Chromium engelli: ${String(tarayiciEngeli).split('\n')[0] ?? ''}`);
    return false;
  }

  function kod(baseUrl: string, baslik: string): string {
    return `import { test, expect } from './_fixture';
test('shows the login heading', async ({ page }) => {
  await test.step('0: Open the login page', async () => {
    await page.goto('${baseUrl}/login');
  });
  await test.step('1: See the login heading', async () => {
    await expect(page.getByRole('heading', { name: '${baslik}' })).toBeVisible({ timeout: 3000 });
  });
});
`;
  }

  it('a test with code that fails gets failure kind unknown and the brain is never called', async (context) => {
    if (!playwrightMumkun(context) || demo === undefined) return;
    const cwd = await realpath(await geciciDizinAc('kobay-mcp-analizsiz-'));
    const dizin = await KobayDizini.ac(cwd, { baseUrl: demo.url, beyin: { adaptor: 'sahte' } });
    await dizin.testYaz({
      id: TEST_ID, name: 'shows the login heading', type: 'frontend', createdFrom: 'cli', status: 'ready',
      planSteps: [
        { type: 'action', description: 'Open the login page' },
        { type: 'assertion', description: 'See the login heading' },
      ],
      priority: 'p1', codeVersion: 1,
      createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
    });
    const kotuKod = kod(demo.url, 'Wrong heading');
    await dizin.kodYaz(TEST_ID, kotuKod);
    const yanitDizini = await geciciDizinAc('kobay-mcp-analizsiz-yanit-');
    await yazAtomik(join(yanitDizini, `analysis-${TEST_ID}.json`), JSON.stringify({
      rootCauseHypothesis: 'The heading text changed', failureKind: 'product_bug',
      recommendedFixTarget: { kind: 'code', reference: 'login page', rationale: 'Wrong heading' }, evidence: [],
    }));
    await yazAtomik(join(yanitDizini, `generate-${TEST_ID}.json`), JSON.stringify({ kod: kod(demo.url, 'Login') }));
    process.env.KOBAY_SAHTE_YANIT_DIZINI = yanitDizini;

    const baglanti = await bagliMcp(cwd);
    try {
      const kosu = await baglanti.istemci.callTool({ name: 'test_run', arguments: { ids: [TEST_ID], noAnalysis: true } });
      const metin = (kosu.content as Array<{ text: string }>)[0]?.text ?? '';
      // Düşen test araç hatası değildir; sonuç satırı döner.
      expect(kosu.isError, metin).not.toBe(true);
      expect(JSON.parse(metin)).toEqual([expect.objectContaining({ id: TEST_ID, verdict: 'failed', failureKind: 'unknown' })]);
      const gunlukler = (await readdir(join(cwd, '.kobay', 'logs')).catch(() => [] as string[])).filter((ad) => ad.startsWith('brain-'));
      expect(gunlukler).toEqual([]);
      // Kod yeniden üretilmedi, analiz atlandı olarak işaretlendi.
      expect(await dizin.kodOku(TEST_ID)).toBe(kotuKod);
      const paket = await dizin.hataPaketiOku(TEST_ID);
      expect(paket.failure.failureKind).toBe('unknown');
      expect(paket.failure.rootCauseHypothesis).toBe(ANALIZ_ATLANDI);
    } finally {
      await baglanti.kapat();
    }
  }, 120_000);
});
