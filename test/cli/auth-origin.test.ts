import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/kesif/index.js', async (asilModul) => ({
  ...(await asilModul<typeof import('../../src/kesif/index.js')>()),
  kesfet: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:3000', loggedIn: true, pages: [], exploredAt: '2026-10-09T00:00:00.000Z' })),
}));

vi.mock('../../src/kos/index.js', () => ({
  hedefAyaktaMi: vi.fn(async () => true),
  kostur: vi.fn(async () => { throw new Error('Bu testte koşu olmamalı'); }),
}));

import { main } from '../../src/cli/index.js';
import { explore } from '../../src/cli/komutlar/index.js';
import { KobayDizini } from '../../src/depo/index.js';
import { kesfet } from '../../src/kesif/index.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

const APP = 'http://127.0.0.1:3000';
const AUTH = 'http://localhost:4000';
const SSO = 'http://auth.localhost:4000';

interface CliSonucu { kod: number; cikti: string; hata: string }

async function kobay(cwd: string, ...argumanlar: string[]): Promise<CliSonucu> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let cikti = '';
  let hata = '';
  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  stdout.on('data', (parca: string) => { cikti += parca; });
  stderr.on('data', (parca: string) => { hata += parca; });
  const kod = await main(['node', 'kobay', '--cwd', cwd, ...argumanlar], { input: Readable.from([]), stdout, stderr });
  return { kod, cikti, hata };
}

async function geciciDizin(): Promise<string> {
  return geciciDizinAc('kobay-auth-origin-cli-');
}

async function dizinAl(cwd: string): Promise<KobayDizini> {
  const dizin = await KobayDizini.bul(cwd);
  if (dizin === null) throw new Error('proje yok');
  return dizin;
}

beforeEach(() => {
  process.env.KOBAY_LOGIN_USER = 'demo';
  process.env.KOBAY_LOGIN_PASS = 'demo123';
});

afterEach(() => {
  delete process.env.KOBAY_LOGIN_USER;
  delete process.env.KOBAY_LOGIN_PASS;
});

describe('--auth-origin yalnız --login ile', () => {
  it('project create --auth-origin --login olmadan reddedilir, proje hiç açılmaz', async () => {
    const cwd = await geciciDizin();
    const sonuc = await kobay(cwd, 'project', 'create', '--url', APP, '--auth-origin', AUTH, '--brain', 'sahte');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('--auth-origin requires --login');
    await expect(access(join(cwd, '.kobay'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('project update --auth-origin / --clear-auth-origins --login olmadan reddedilir, config değişmez', async () => {
    const cwd = await geciciDizin();
    expect((await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte')).kod).toBe(0);
    const once = await (await dizinAl(cwd)).configOku();

    const ekle = await kobay(cwd, 'project', 'update', '--auth-origin', AUTH);
    expect(ekle.kod).toBe(2);
    expect(ekle.hata).toContain('--auth-origin requires --login');
    const temizle = await kobay(cwd, 'project', 'update', '--clear-auth-origins');
    expect(temizle.kod).toBe(2);
    expect(temizle.hata).toContain('--clear-auth-origins requires --login');
    const ikisi = await kobay(cwd, 'project', 'update', '--login', '--auth-origin', AUTH, '--clear-auth-origins');
    expect(ikisi.kod).toBe(2);
    expect(ikisi.hata).toContain('cannot be used together');

    await expect((await dizinAl(cwd)).configOku()).resolves.toEqual(once);
    await expect((await dizinAl(cwd)).kimlikOku()).resolves.toBeNull();
  });

  it('geçersiz öğe kullanım hatasıdır ve öğeyi adıyla söyler', async () => {
    const cwd = await geciciDizin();
    const sonuc = await kobay(
      cwd, 'project', 'create', '--url', APP, '--login', '--auth-origin', 'https://*.example.com', '--brain', 'sahte',
    );
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('Invalid auth origin "https://*.example.com"');
    const tekrar = await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--auth-origin', `${APP}/`, '--brain', 'sahte');
    expect(tekrar.kod).toBe(2);
    expect(tekrar.hata).toContain('baseUrl origin');
  });
});

describe('liste ve kimlik kilidi birlikte yazılır', () => {
  it('create --login listeyi config ve kimliğe aynı (normal, sıralı) yazar; loginUrl auth origin\'de olabilir', async () => {
    const cwd = await geciciDizin();
    const sonuc = await kobay(
      cwd, 'project', 'create', '--url', `${APP}/panel`, '--login', '--login-url', `${SSO}/login`,
      '--auth-origin', `${SSO}/`, '--auth-origin', AUTH, '--brain', 'sahte',
    );
    expect(sonuc.kod).toBe(0);
    expect(sonuc.cikti).toContain(`Auth origins: ${SSO}, ${AUTH}`);
    const dizin = await dizinAl(cwd);
    expect((await dizin.configOku()).authOrigins).toEqual([SSO, AUTH]);
    await expect(dizin.kimlikOku()).resolves.toEqual({
      username: 'demo', password: 'demo123', origin: APP, authOrigins: [SSO, AUTH],
    });
  });

  it('loginUrl auth origin\'de ama liste yoksa reddedilir', async () => {
    const cwd = await geciciDizin();
    const sonuc = await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--login-url', `${AUTH}/login`, '--brain', 'sahte');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('same origin as baseUrl');
  });

  it('update --login: liste verilirse TAM yerine geçer, verilmezse (kilitle aynıysa) korunur, --clear-auth-origins boşaltır', async () => {
    const cwd = await geciciDizin();
    await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--auth-origin', AUTH, '--brain', 'sahte');
    const dizin = await dizinAl(cwd);

    process.env.KOBAY_LOGIN_PASS = 'yeni-parola';
    expect((await kobay(cwd, 'project', 'update', '--login', '--auth-origin', SSO)).kod).toBe(0);
    expect((await dizin.configOku()).authOrigins).toEqual([SSO]);
    await expect(dizin.kimlikOku()).resolves.toEqual({
      username: 'demo', password: 'yeni-parola', origin: APP, authOrigins: [SSO],
    });

    // Çıplak --login: config listesi kimliğin kilitlediği listeyle birebir aynı → değişiklik yok, korunur.
    expect((await kobay(cwd, 'project', 'update', '--login')).kod).toBe(0);
    expect((await dizin.configOku()).authOrigins).toEqual([SSO]);
    expect((await dizin.kimlikOku())?.authOrigins).toEqual([SSO]);

    expect((await kobay(cwd, 'project', 'update', '--login', '--clear-auth-origins')).kod).toBe(0);
    expect('authOrigins' in await dizin.configOku()).toBe(false);
    await expect(dizin.kimlikOku()).resolves.toEqual({ username: 'demo', password: 'yeni-parola', origin: APP });
  });

  it('elle büyütülmüş config + çıplak update --login → exit 2, liste kimliğe kilitlenmez, hiçbir şey değişmez', async () => {
    const cwd = await geciciDizin();
    await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--auth-origin', AUTH, '--brain', 'sahte');
    const dizin = await dizinAl(cwd);
    await writeFile(dizin.yol('config.json'), JSON.stringify({
      ...(await dizin.configOku()), authOrigins: [AUTH, 'https://kotu.example'],
    }));
    const configOnce = await dizin.configOku();
    process.env.KOBAY_LOGIN_PASS = 'yeni-parola';

    const sonuc = await kobay(cwd, 'project', 'update', '--login');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain(`config.json lists ${AUTH}, https://kotu.example`);
    expect(sonuc.hata).toContain('the saved credentials did not approve');
    expect(sonuc.hata).toContain('kobay project update --login --auth-origin <origin>');
    expect(sonuc.hata).toContain('kobay project update --login --clear-auth-origins');
    // Liste büyümedi: kimlik hâlâ eski listeye ve eski parolaya kilitli, config elle yazıldığı gibi.
    await expect(dizin.kimlikOku()).resolves.toEqual({
      username: 'demo', password: 'demo123', origin: APP, authOrigins: [AUTH],
    });
    await expect(dizin.configOku()).resolves.toEqual(configOnce);

    // Önerilen açık komut tam listeyi koyar.
    expect((await kobay(cwd, 'project', 'update', '--login', '--auth-origin', AUTH)).kod).toBe(0);
    expect((await dizin.configOku()).authOrigins).toEqual([AUTH]);
    expect((await dizin.kimlikOku())?.authOrigins).toEqual([AUTH]);
  });

  it('kimlik yokken config\'te liste varsa çıplak update --login reddedilir', async () => {
    const cwd = await geciciDizin();
    expect((await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte')).kod).toBe(0);
    const dizin = await dizinAl(cwd);
    await writeFile(dizin.yol('config.json'), JSON.stringify({ ...(await dizin.configOku()), authOrigins: [AUTH] }));

    const sonuc = await kobay(cwd, 'project', 'update', '--login');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('no saved credentials approve');
    await expect(dizin.kimlikOku()).resolves.toBeNull();
    // Liste yokken çıplak --login sorunsuz: genişleyecek bir şey yok.
    expect((await kobay(cwd, 'project', 'update', '--login', '--clear-auth-origins')).kod).toBe(0);
    expect((await kobay(cwd, 'project', 'update', '--login')).kod).toBe(0);
    await expect(dizin.kimlikOku()).resolves.toEqual({ username: 'demo', password: 'demo123', origin: APP });
  });

  it('config\'te geçersiz authOrigins varken update kurtarma yolunu söyler; create --force --login kurtarır', async () => {
    const cwd = await geciciDizin();
    await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--auth-origin', AUTH, '--brain', 'sahte');
    const dizin = await dizinAl(cwd);
    const gecerli = await dizin.configOku();
    await writeFile(dizin.yol('config.json'), JSON.stringify({ ...gecerli, authOrigins: ['https://*.example.com'] }));

    const temizle = await kobay(cwd, 'project', 'update', '--login', '--clear-auth-origins');
    expect(temizle.kod).toBe(2);
    expect(temizle.hata).toContain('Invalid auth origin "https://*.example.com"');
    expect(temizle.hata).toContain('kobay project create --url <URL> --login --force');
    // Hiçbir şey değişmedi: kimlik eski listeye kilitli.
    expect((await dizin.kimlikOku())?.authOrigins).toEqual([AUTH]);

    // Bozuk config'in beyin ayarı okunamaz; kurtarma komutu --brain'i yeniden verir.
    const kurtar = await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--force', '--brain', 'sahte');
    expect(kurtar.kod).toBe(0);
    expect('authOrigins' in await dizin.configOku()).toBe(false);
    expect((await dizin.configOku()).brain).toEqual(gecerli.brain);
    await expect(dizin.kimlikOku()).resolves.toEqual({ username: 'demo', password: 'demo123', origin: APP });
  });

  it('update --base-url origin değişince liste taşınmaz, kimlik geçersiz kılınır', async () => {
    const cwd = await geciciDizin();
    await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--auth-origin', AUTH, '--brain', 'sahte');
    const sonuc = await kobay(cwd, 'project', 'update', '--base-url', 'http://127.0.0.1:3001');
    expect(sonuc.kod).toBe(0);
    expect(sonuc.cikti).toContain('Auth origins: cleared because the target origin changed');
    const dizin = await dizinAl(cwd);
    expect('authOrigins' in await dizin.configOku()).toBe(false);
    await expect(dizin.kimlikOku()).resolves.toBeNull();
  });

  it('create --force (--login yok) listeyi düşürür; listeli kimlik yeni config\'e taşınmaz', async () => {
    const cwd = await geciciDizin();
    await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--auth-origin', AUTH, '--brain', 'sahte');
    const sonuc = await kobay(cwd, 'project', 'create', '--url', APP, '--force');
    expect(sonuc.kod).toBe(0);
    expect(sonuc.cikti).toContain('Invalidated: credentials.json');
    const dizin = await dizinAl(cwd);
    expect('authOrigins' in await dizin.configOku()).toBe(false);
    await expect(dizin.kimlikOku()).resolves.toBeNull();
  });

  it('config listesi elle değiştirilirse keşif başlamaz (exit 5) ve yeniden giriş komutu söylenir', async () => {
    const cwd = await geciciDizin();
    await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--auth-origin', AUTH, '--brain', 'sahte');
    const dizin = await dizinAl(cwd);
    await writeFile(dizin.yol('config.json'), JSON.stringify({
      ...(await dizin.configOku()), authOrigins: [AUTH, 'https://kotu.example'],
    }));
    vi.mocked(kesfet).mockClear();
    const sonuc = await explore({ cwd });
    expect(sonuc.exitCode).toBe(5);
    expect(sonuc.mesaj).toContain('different set of auth origins');
    expect(sonuc.mesaj).toContain('kobay project update --login --auth-origin <origin>');
    expect(sonuc.mesaj).not.toMatch(/`kobay project update --login`/);
    expect(kesfet).not.toHaveBeenCalled();
  });

  it('eşleşen kimlik ve config ile keşfe liste geçer', async () => {
    const cwd = await geciciDizin();
    await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--auth-origin', AUTH, '--brain', 'sahte');
    vi.mocked(kesfet).mockClear();
    expect((await explore({ cwd })).exitCode).toBe(0);
    expect(kesfet).toHaveBeenCalledWith(expect.objectContaining({ authOrigins: [AUTH] }));
  });
});

describe('MCP bu alanı yazamaz', () => {
  async function bagliMcp(cwd: string): Promise<{ istemci: Client; kapat: () => Promise<void> }> {
    const sunucu = mcpSunucusuOlustur({ cwd, env: {} });
    const istemci = new Client({ name: 'kobay-test', version: '0.1.0' });
    const [sunucuTasima, istemciTasima] = InMemoryTransport.createLinkedPair();
    await Promise.all([sunucu.connect(sunucuTasima), istemci.connect(istemciTasima)]);
    return { istemci, kapat: async () => { await istemci.close(); await sunucu.close(); } };
  }

  it('project_create/project_update şemasında authOrigins yok; verilirse liste değişmez', async () => {
    const cwd = await geciciDizin();
    await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--auth-origin', AUTH, '--brain', 'sahte');
    const dizin = await dizinAl(cwd);
    const baglanti = await bagliMcp(cwd);
    try {
      const araclar = (await baglanti.istemci.listTools()).tools;
      for (const ad of ['project_create', 'project_update']) {
        const ozellikler = Object.keys((araclar.find((arac) => arac.name === ad)?.inputSchema.properties ?? {}) as object);
        expect(ozellikler).not.toContain('authOrigins');
      }
      const olustur = await baglanti.istemci.callTool({
        name: 'project_create', arguments: { url: APP, force: true, authOrigins: ['https://kotu.example'] },
      });
      expect(olustur.isError).toBe(true);
      await baglanti.istemci.callTool({
        name: 'project_update', arguments: { docsPath: undefined, authOrigins: ['https://kotu.example'], model: 'x' },
      });
      expect((await dizin.configOku()).authOrigins).toEqual([AUTH]);
      expect((await dizin.kimlikOku())?.authOrigins).toEqual([AUTH]);
    } finally {
      await baglanti.kapat();
    }
  });
});
