import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { KobayDizini, type Harita, type HataPaketi, type TestKaydi } from '../../src/depo/index.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';

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
  it('17 aracı listeler', async () => {
    const baglanti = await bagliMcp(await mkdtemp(join(tmpdir(), 'kobay-mcp-')));
    try {
      const liste = await baglanti.istemci.listTools();
      expect(liste.tools).toHaveLength(17);
      expect(liste.tools.map((arac) => arac.name)).toEqual(expect.arrayContaining([
        'project_create', 'project_update', 'project_get', 'explore', 'plan_generate', 'plan_accept',
        'test_create', 'test_list', 'test_get', 'code_get', 'test_delete', 'test_run', 'test_rerun',
        'test_refresh', 'test_result', 'failure_get', 'doctor',
      ]));
      for (const arac of liste.tools) {
        expect((arac.inputSchema.properties as Record<string, unknown>).projectDir).toBeDefined();
      }
    } finally {
      await baglanti.kapat();
    }
  });

  it('package.json sürümünü ve kısa İngilizce kullanım talimatını bildirir', async () => {
    const baglanti = await bagliMcp(await mkdtemp(join(tmpdir(), 'kobay-mcp-')));
    try {
      const paket = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
      expect(baglanti.istemci.getServerVersion()?.version).toBe(paket.version);
      expect(baglanti.istemci.getInstructions()).toContain('Use test_run');
      expect(baglanti.istemci.getInstructions()).toContain('test_refresh only for product_changed');
    } finally {
      await baglanti.kapat();
    }
  });

  it('proje yoksa test_list MCP hatası ve JSON metni döndürür', async () => {
    const baglanti = await bagliMcp(await mkdtemp(join(tmpdir(), 'kobay-mcp-')));
    try {
      const sonuc = await baglanti.istemci.callTool({ name: 'test_list', arguments: {} });
      expect(sonuc.isError).toBe(true);
      expect(sonuc.content).toEqual([{ type: 'text', text: expect.stringContaining('Kobay projesinde değil') }]);
      expect(() => JSON.parse((sonuc.content[0] as { text: string }).text)).not.toThrow();
    } finally {
      await baglanti.kapat();
    }
  });

  it('project_create yalnız sabit KOBAY_LOGIN_PASS kullanır ve env adı seçimini reddeder', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kobay-mcp-'));
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
    const cwd = await mkdtemp(join(tmpdir(), 'kobay-mcp-'));
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
        arguments: { loginUrl: 'http://localhost:3000/giris', beyin: 'claude' },
      });
      expect(guncelle.isError).not.toBe(true);
      expect(JSON.parse((guncelle.content[0] as { text: string }).text)).toMatchObject({
        config: {
          baseUrl: 'http://localhost:3000',
          docsPath: 'docs/rehber.md',
          loginUrl: 'http://localhost:3000/giris',
          beyin: { adaptor: 'claude' },
        },
      });
      const disOrigin = await baglanti.istemci.callTool({
        name: 'project_update',
        arguments: { loginUrl: 'http://kimlik.test/giris' },
      });
      expect(disOrigin.isError).toBe(true);
      expect((disOrigin.content[0] as { text: string }).text).toContain('aynı origin');
      const liste = await baglanti.istemci.listTools();
      const guncelleme = liste.tools.find((arac) => arac.name === 'project_update')?.inputSchema;
      const beyinSemasi = (guncelleme?.properties as Record<string, { enum?: string[] }> | undefined)?.beyin;
      expect(beyinSemasi?.enum).not.toContain('sahte');
    } finally {
      await baglanti.kapat();
    }
  });

  it('projectDir ile sunucu cwd dışındaki Kobay projesini seçer, normal dizini reddeder', async () => {
    const sunucuKoku = await mkdtemp(join(tmpdir(), 'kobay-mcp-server-'));
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
      expect((reddedilen.content[0] as { text: string }).text).toContain('Kobay projesinde değil');
    } finally {
      await baglanti.kapat();
    }
  });

  it('projectDir izinli MCP kökleri dışındaysa reddeder, başlangıç ortamındaki ek kökü kabul eder', async () => {
    const sunucuKoku = await mkdtemp(join(tmpdir(), 'kobay-mcp-root-'));
    const disKok = await mkdtemp(join(tmpdir(), 'kobay-mcp-dis-'));
    await KobayDizini.ac(disKok, { baseUrl: 'http://dis.test', beyin: { adaptor: 'sahte' } });

    const sinirli = await bagliMcp(sunucuKoku);
    try {
      const sonuc = await sinirli.istemci.callTool({ name: 'project_get', arguments: { projectDir: disKok } });
      expect(sonuc.isError).toBe(true);
      expect((sonuc.content[0] as { text: string }).text).toContain('izin verilen MCP kökleri dışında');
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
    const sunucuKoku = await mkdtemp(join(tmpdir(), 'kobay-mcp-yol-'));
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
        expect((sonuc.content[0] as { text: string }).text).toContain('proje kökü dışında');
      }
      await expect(access(join(yeniProje, '.kobay'))).rejects.toThrow();
    } finally {
      await baglanti.kapat();
    }
  });

  it('kaydedildikten sonra dışarı çevrilen docsPath symlinkini okuma anında reddeder', async () => {
    const sunucuKoku = await mkdtemp(join(tmpdir(), 'kobay-mcp-docs-'));
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
        baseUrl: 'http://proje.test', girisYapildi: false,
        kesifTarihi: '2026-09-21T00:00:00.000Z', sayfalar: [],
      });

      await rename(join(projeKoku, 'belge-link'), join(projeKoku, 'eski-belge-link'));
      await symlink(disBelge, join(projeKoku, 'belge-link'));
      const sonuc = await baglanti.istemci.callTool({
        name: 'plan_generate', arguments: { projectDir: projeKoku },
      });
      expect(sonuc.isError).toBe(true);
      expect((sonuc.content[0] as { text: string }).text).toContain('docsPath proje kökü dışında');
    } finally {
      await baglanti.kapat();
    }
  });

  it('test_refresh testi ve haritayı denetler; tarayıcı gerektirmeden hata döndürür', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kobay-mcp-'));
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    const harita: Harita = {
      baseUrl: 'http://uygulama.test',
      girisYapildi: true,
      kesifTarihi: '2026-09-17T00:00:00.000Z',
      sayfalar: [{
        url: 'http://uygulama.test/cariler', baslik: 'Cariler', basliklar: ['Cariler'],
        linkler: [], formlar: [], dugmeler: [], menu: [],
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
      expect((haritadaYok.content as [{ text: string }])[0].text).toContain('haritasında yok');
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
    const cwd = await mkdtemp(join(tmpdir(), 'kobay-mcp-origin-'));
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
      expect(metin(guncelle)).toContain('gecersizKilinan');
      await expect(access(join(cwd, '.kobay', 'credentials.json'))).rejects.toThrow();

      await baglanti.istemci.callTool({ name: 'explore', arguments: {} });
      expect(yakalanan.join('\n')).not.toContain('GIZLI-PAROLA-123');
    } finally {
      await baglanti.kapat();
      await Promise.all([mesru.kapat(), kotu.kapat()]);
    }
  });

  it('planPath ve docsPath .kobay altını ve gizli dosyaları gösteremez', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kobay-mcp-sir-'));
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
        expect(JSON.stringify(sonuc), planPath).toContain('nokta ile başlayan');
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
    const kok = await mkdtemp(join(tmpdir(), 'kobay-mcp-altdizin-'));
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

    const tanimsiz = await bagliMcp(await mkdtemp(join(tmpdir(), 'kobay-mcp-tanimsiz-')), { KOBAY_LOGIN_PASS: 'GIZLI-PAROLA-123' });
    try {
      const sonuc = await tanimsiz.istemci.callTool({
        name: 'project_create', arguments: { url: kotu.url, loginUser: 'ali' },
      });
      expect(sonuc.isError).toBe(true);
      expect(metin(sonuc)).toContain('KOBAY_LOGIN_ORIGIN tanımlı değil');
    } finally {
      await tanimsiz.kapat();
      await Promise.all([mesru.kapat(), kotu.kapat()]);
    }
  });

  it('failure_get out .kobay, .git, .claude gibi gizli dizinlere yazmaz', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kobay-mcp-out-'));
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
        expect((sonuc.content[0] as { text: string }).text, out).toContain('nokta ile başlayan');
      }
      // Tek istisna: paket oturum çerezi taşır, .kobay/failure-out/ zaten git'e girmez.
      for (const out of ['paket', '.kobay/failure-out/x', '.kobay/failure-out/t_abc12345-1/alt']) {
        const sonuc = await baglanti.istemci.callTool({ name: 'failure_get', arguments: { id: 't_abc12345', out } });
        expect((sonuc.content[0] as { text: string }).text, out).not.toContain('nokta ile başlayan');
      }
    } finally {
      await baglanti.kapat();
    }
  });

  it('failure_get out verilmezse hep .kobay/failure-out/<id> kullanır, çöp klasör açmaz', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'kobay-mcp-varsayilan-')));
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
          hedef: join(cikisKoku, 't_abc12345'),
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
