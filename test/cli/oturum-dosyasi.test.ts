import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/kesif/index.js', async (asilModul) => {
  const asil = await asilModul<typeof import('../../src/kesif/index.js')>();
  return {
    ...asil,
    // Gerçek tarayıcı açılmasın; oturum dosyası doğrulaması gerçek modülden gelir.
    kesfetAyrintili: vi.fn(async (secenekler: { oturum?: unknown }) => ({
      harita: {
        baseUrl: 'http://127.0.0.1:3000',
        loggedIn: secenekler.oturum !== undefined,
        pages: [],
        exploredAt: '2026-10-14T00:00:00.000Z',
        ...(secenekler.oturum === undefined ? {} : { sessionSource: 'imported' }),
      },
    })),
  };
});

vi.mock('../../src/kos/index.js', () => ({
  hedefAyaktaMi: vi.fn(async () => true),
  kostur: vi.fn(async () => { throw new Error('Bu testte koşu olmamalı'); }),
}));

import { main } from '../../src/cli/index.js';
import { KobayDizini } from '../../src/depo/index.js';
import { oturumDosyasiniIceAl } from '../../src/cli/komutlar/ortak.js';
import { kesfetAyrintili } from '../../src/kesif/index.js';
import { mcpSunucusuOlustur } from '../../src/mcp/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

const APP = 'http://127.0.0.1:3000';
const SIR = 'OTURUMDEGERI-4c1d8e2f9a7b3065';

async function kobay(cwd: string, ...argumanlar: string[]): Promise<{ kod: number; cikti: string; hata: string }> {
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

function cerez(domain: string, value = SIR): Record<string, unknown> {
  return { name: 'oturumcerezi', value, domain, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' };
}

async function oturumDosyasi(dizin: string, veri: unknown, ad = 'state.json'): Promise<string> {
  const yol = join(dizin, ad);
  await writeFile(yol, typeof veri === 'string' ? veri : JSON.stringify(veri));
  return yol;
}

const GECERLI = {
  cookies: [cerez('127.0.0.1')],
  origins: [{ origin: APP, localStorage: [{ name: 'jwt', value: `${SIR}-ls` }] }],
};

async function varMi(yol: string): Promise<boolean> {
  return access(yol).then(() => true, () => false);
}

function oturumSecenegi(): unknown {
  return (vi.mocked(kesfetAyrintili).mock.calls.at(-1)?.[0] as { oturum?: unknown } | undefined)?.oturum;
}

beforeEach(() => {
  vi.mocked(kesfetAyrintili).mockClear();
});

describe('project create --session-file', () => {
  it('doğrular, .kobay/storageState.json\'a 0600 ile işaretli yazar, kaynak dosyaya dokunmaz', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    const ham = `${JSON.stringify(GECERLI, null, 4)}\n`;
    const kaynak = await oturumDosyasi(cwd, ham);
    const once = await stat(kaynak);
    const sonuc = await kobay(cwd, '--output', 'json', 'project', 'create', '--url', APP, '--brain', 'sahte', '--session-file', 'state.json');
    expect(sonuc.kod, sonuc.hata).toBe(0);
    expect(JSON.parse(sonuc.cikti)).toMatchObject({ data: { session: { source: 'imported', cookies: 1, origins: 1 } } });
    expect(sonuc.cikti).not.toContain(SIR);
    const hedef = join(cwd, '.kobay', 'storageState.json');
    if (process.platform !== 'win32') expect((await stat(hedef)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(hedef, 'utf8'))).toEqual({ kobay: { sessionSource: 'imported' }, ...GECERLI });
    // Kaynak: aynı bayt, aynı zaman damgası, aynı izin.
    expect(await readFile(kaynak, 'utf8')).toBe(ham);
    const sonra = await stat(kaynak);
    expect([sonra.mtimeMs, sonra.mode]).toEqual([once.mtimeMs, once.mode]);
  });

  it('insan modunda özet satırı yazar, değer yazmaz', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    await oturumDosyasi(cwd, GECERLI);
    const sonuc = await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte', '--session-file', 'state.json');
    expect(sonuc.kod).toBe(0);
    expect(sonuc.cikti).toContain('Session: imported (1 cookie, 1 storage origin)');
    expect(sonuc.cikti).not.toContain(SIR);
  });

  it.each([
    ['yabancı çerez', { cookies: [cerez('127.0.0.1'), cerez('.evil.example')], origins: [] }, 'cookie domain .evil.example'],
    ['yabancı localStorage origin', { cookies: [], origins: [{ origin: 'http://evil.example', localStorage: [{ name: 'a', value: SIR }] }] }, 'storage origin http://evil.example'],
    ['localhost ile 127.0.0.1 farklı site', { cookies: [cerez('localhost')], origins: [] }, 'cookie domain localhost'],
    ['şema dışı', { cookies: [{ ...cerez('127.0.0.1'), sameSite: 'Maybe' }], origins: [] }, 'cookies.0.sameSite'],
    ['JSON değil', `{"cookies":[${SIR}`, 'not valid JSON'],
  ])('%s → exit 2, mesajda köken/alan var, değer yok, proje açılmaz', async (_ad, veri, beklenen) => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    await oturumDosyasi(cwd, veri);
    const sonuc = await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte', '--session-file', 'state.json');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain(beklenen);
    expect(`${sonuc.hata}${sonuc.cikti}`).not.toContain(SIR);
    expect(await varMi(join(cwd, '.kobay'))).toBe(false);
  });

  it('1 MB üstü dosya exit 2 ile reddedilir', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    const temel = JSON.stringify(GECERLI);
    await oturumDosyasi(cwd, temel + ' '.repeat(1024 * 1024 - temel.length + 1));
    const sonuc = await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte', '--session-file', 'state.json');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('larger than 1048576 bytes');
    expect(await varMi(join(cwd, '.kobay'))).toBe(false);
  });

  it('--login ile birlikte exit 2; parola sorulmaz', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    await oturumDosyasi(cwd, GECERLI);
    const sonuc = await kobay(cwd, 'project', 'create', '--url', APP, '--login', '--session-file', 'state.json');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('--login and --session-file cannot be used together');
    expect(sonuc.hata).not.toContain('Username');
    expect(await varMi(join(cwd, '.kobay'))).toBe(false);
  });

  it('--auth-origin --session-file ile kabul edilir; auth sitesinin çerezi geçer, listede olmayan geçmez', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    await oturumDosyasi(cwd, { cookies: [cerez('127.0.0.1'), cerez('auth.example')], origins: [] });
    const red = await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte', '--session-file', 'state.json');
    expect(red.kod).toBe(2);
    expect(red.hata).toContain('cookie domain auth.example');
    const sonuc = await kobay(
      cwd, 'project', 'create', '--url', APP, '--brain', 'sahte', '--session-file', 'state.json',
      '--auth-origin', 'https://auth.example',
    );
    expect(sonuc.kod, sonuc.hata).toBe(0);
    const config = JSON.parse(await readFile(join(cwd, '.kobay', 'config.json'), 'utf8')) as { authOrigins?: string[] };
    expect(config.authOrigins).toEqual(['https://auth.example']);
  });

  it('--auth-origin yalnız başına (ne --login ne --session-file) hâlâ exit 2', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    const sonuc = await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte', '--auth-origin', 'https://auth.example');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('--auth-origin requires --login');
  });

  it('--force --session-file kayıtlı kimliği ve eski oturumu kaldırır, yenisini yazar', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    process.env.KOBAY_LOGIN_USER = 'demo';
    process.env.KOBAY_LOGIN_PASS = 'demo123';
    try {
      expect((await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte', '--login')).kod).toBe(0);
    } finally {
      delete process.env.KOBAY_LOGIN_USER;
      delete process.env.KOBAY_LOGIN_PASS;
    }
    await writeFile(join(cwd, '.kobay', 'storageState.json'), JSON.stringify({ cookies: [], origins: [] }));
    await oturumDosyasi(cwd, GECERLI);
    const sonuc = await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte', '--session-file', 'state.json', '--force');
    expect(sonuc.kod, sonuc.hata).toBe(0);
    expect(sonuc.cikti).toContain('Credentials: removed');
    expect(await varMi(join(cwd, '.kobay', 'credentials.json'))).toBe(false);
    expect(JSON.parse(await readFile(join(cwd, '.kobay', 'storageState.json'), 'utf8'))).toMatchObject({ kobay: { sessionSource: 'imported' } });
    // Kenara alınan kopya kalmaz.
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(cwd, '.kobay'))).filter((ad) => ad.startsWith('.stale-'))).toEqual([]);
  });
});

describe('kobay explore --session-file', () => {
  async function proje(): Promise<string> {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    expect((await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte')).kod).toBe(0);
    return cwd;
  }

  it('içe alır ve keşfe oturumu verir; sonraki çıplak explore aynı oturumu kullanır', async () => {
    const cwd = await proje();
    const kaynak = await oturumDosyasi(cwd, GECERLI);
    const ham = await readFile(kaynak, 'utf8');
    const sonuc = await kobay(cwd, 'explore', '--session-file', 'state.json');
    expect(sonuc.kod, sonuc.hata).toBe(0);
    expect(await readFile(kaynak, 'utf8')).toBe(ham);
    expect(sonuc.cikti).toContain('(logged in, imported session)');
    expect(oturumSecenegi()).toEqual(GECERLI);
    expect(vi.mocked(kesfetAyrintili).mock.calls.at(-1)?.[0]).not.toHaveProperty('kimlik');
    expect((await kobay(cwd, 'explore')).kod).toBe(0);
    expect(oturumSecenegi()).toEqual(GECERLI);
  });

  it('işaretsiz storageState (eski yol) keşfe oturum olarak verilmez', async () => {
    const cwd = await proje();
    await writeFile(join(cwd, '.kobay', 'storageState.json'), JSON.stringify({ cookies: [cerez('127.0.0.1')], origins: [] }));
    expect((await kobay(cwd, 'explore')).kod).toBe(0);
    expect(oturumSecenegi()).toBeUndefined();
  });

  it('yabancı kökenli dosya exit 2; önceki oturum dosyası değişmez, keşif başlamaz', async () => {
    const cwd = await proje();
    await oturumDosyasi(cwd, GECERLI);
    expect((await kobay(cwd, 'explore', '--session-file', 'state.json')).kod).toBe(0);
    const once = await readFile(join(cwd, '.kobay', 'storageState.json'), 'utf8');
    vi.mocked(kesfetAyrintili).mockClear();
    await oturumDosyasi(cwd, { cookies: [cerez('evil.example')], origins: [] }, 'kotu.json');
    const sonuc = await kobay(cwd, 'explore', '--session-file', 'kotu.json');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('cookie domain evil.example');
    expect(sonuc.hata).not.toContain(SIR);
    expect(kesfetAyrintili).not.toHaveBeenCalled();
    expect(await readFile(join(cwd, '.kobay', 'storageState.json'), 'utf8')).toBe(once);
  });

  it('elle bozulan içe alınmış dosya exit 2 ile durur', async () => {
    const cwd = await proje();
    await writeFile(join(cwd, '.kobay', 'storageState.json'), JSON.stringify({
      kobay: { sessionSource: 'imported' }, cookies: [cerez('evil.example')], origins: [],
    }));
    const sonuc = await kobay(cwd, 'explore');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('no longer valid');
    expect(sonuc.hata).not.toContain(SIR);
    expect(kesfetAyrintili).not.toHaveBeenCalled();
  });

  it('kayıtlı kimlik varken exit 2; dosya içe alınmaz', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    process.env.KOBAY_LOGIN_USER = 'demo';
    process.env.KOBAY_LOGIN_PASS = 'demo123';
    try {
      expect((await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte', '--login')).kod).toBe(0);
    } finally {
      delete process.env.KOBAY_LOGIN_USER;
      delete process.env.KOBAY_LOGIN_PASS;
    }
    await oturumDosyasi(cwd, GECERLI);
    const sonuc = await kobay(cwd, 'explore', '--session-file', 'state.json');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('saved login credentials');
    expect(sonuc.hata).toContain('removes the saved credentials).');
    expect(await varMi(join(cwd, '.kobay', 'storageState.json'))).toBe(false);
    expect(kesfetAyrintili).not.toHaveBeenCalled();
  });
});

describe('MCP explore: sessionFile yok', () => {
  it('sessionFile argümanı dosyayı içe aldırmaz', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    expect((await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte')).kod).toBe(0);
    const kaynak = await oturumDosyasi(cwd, GECERLI);
    const sunucu = mcpSunucusuOlustur({ cwd });
    const istemci = new Client({ name: 'kobay-test', version: '0.1.0' });
    const [sunucuTasima, istemciTasima] = InMemoryTransport.createLinkedPair();
    await Promise.all([sunucu.connect(sunucuTasima), istemci.connect(istemciTasima)]);
    try {
      await istemci.callTool({ name: 'explore', arguments: { sessionFile: kaynak } });
      expect(oturumSecenegi()).toBeUndefined();
      // Ya araç hatası verdi ya da keşif oturumsuz koştu ve kendi (işaretsiz) durumunu yazdı; içe alma yok.
      const yazilan = await readFile(join(cwd, '.kobay', 'storageState.json'), 'utf8').catch(() => '');
      expect(yazilan).not.toContain('imported');
    } finally {
      await istemci.close();
      await sunucu.close();
    }
  });
});

describe('Opus kör kabul ve Codex 2. tur', () => {
  async function kimlikliProje(): Promise<string> {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    process.env.KOBAY_LOGIN_USER = 'demo';
    process.env.KOBAY_LOGIN_PASS = 'demo123';
    try {
      expect((await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte', '--login')).kod).toBe(0);
    } finally {
      delete process.env.KOBAY_LOGIN_USER;
      delete process.env.KOBAY_LOGIN_PASS;
    }
    return cwd;
  }

  it('project create --force --session-file kimliği kaldırınca JSON zarfı invalidated: [credentials.json] taşır', async () => {
    const cwd = await kimlikliProje();
    await oturumDosyasi(cwd, GECERLI);
    const sonuc = await kobay(cwd, '--output', 'json', 'project', 'create', '--url', APP, '--brain', 'sahte', '--session-file', 'state.json', '--force');
    expect(sonuc.kod, sonuc.hata).toBe(0);
    expect(JSON.parse(sonuc.cikti)).toMatchObject({ data: { invalidated: ['credentials.json'] } });
  });

  it('explore --session-file kimlik işlem kilidi tutulurken yazmaz, işi bırakır', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    expect((await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte')).kod).toBe(0);
    await oturumDosyasi(cwd, GECERLI);
    const dizin = await KobayDizini.bul(cwd);
    if (dizin === null) throw new Error('.kobay yok');
    // Eşzamanlı bir `project create --force --login`un ortası: kilit tutuluyor.
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: await dizin.configOku() });
    try {
      const sonuc = await kobay(cwd, 'explore', '--session-file', 'state.json');
      expect(sonuc.kod).not.toBe(0);
      expect(await varMi(join(cwd, '.kobay', 'storageState.json'))).toBe(false);
      expect(kesfetAyrintili).not.toHaveBeenCalled();
    } finally {
      await islem.geriAl();
    }
  });

  it('tavanı aşan kayıtlı storageState "yok" sayılmaz: explore exit 2, dosya değişmez (Codex 2. tur)', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    expect((await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte')).kod).toBe(0);
    const yol = join(cwd, '.kobay', 'storageState.json');
    const icerik = `${JSON.stringify(GECERLI)}${' '.repeat(1024 * 1024)}`;
    await writeFile(yol, icerik);
    const sonuc = await kobay(cwd, 'explore');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('did not touch it');
    expect(kesfetAyrintili).not.toHaveBeenCalled();
    expect(await readFile(yol, 'utf8')).toBe(icerik);
  });

  it('kayıtlı FIFO storageState çıplak explore\'u asmaz: exit 2', async () => {
    if (process.platform === 'win32') return;
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    expect((await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte')).kod).toBe(0);
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [join(cwd, '.kobay', 'storageState.json')]);
    const sonuc = await kobay(cwd, 'explore');
    expect(sonuc.kod).toBe(2);
    expect(sonuc.hata).toContain('not a regular file');
  }, 20_000);
});

describe('kilit altında config yeniden doğrulanır', () => {
  it('doğrulamadaki config kilit alındığında değişmişse içe alma yazılmaz, eski oturum yerinde kalır', async () => {
    const cwd = await geciciDizinAc('kobay-oturum-cli-');
    expect((await kobay(cwd, 'project', 'create', '--url', APP, '--brain', 'sahte')).kod).toBe(0);
    const yol = await oturumDosyasi(cwd, GECERLI);
    const dizin = await KobayDizini.bul(cwd);
    if (dizin === null) throw new Error('.kobay yok');
    const eski = '{"cookies":[],"origins":[]}';
    await writeFile(join(cwd, '.kobay', 'storageState.json'), eski);
    const dogrulanan = { ...(await dizin.configOku()), loginUrl: `${APP}/baska` };
    await expect(oturumDosyasiniIceAl(dizin, dogrulanan, yol)).rejects.toThrow(/config changed/);
    expect(await readFile(join(cwd, '.kobay', 'storageState.json'), 'utf8')).toBe(eski);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(cwd, '.kobay'))).filter((ad) => ad.startsWith('.stale-') || ad.startsWith('.credentials-txn'))).toEqual([]);
  });
});
