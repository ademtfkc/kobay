import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { eskiAdUyarisi, uyarilariYaz, yazilanUyarilariSifirla } from '../../src/cli/uyari.js';
import { KobayDizini } from '../../src/depo/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

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

const BASE_URL_UYARISI = 'kobay: warning: --base-url is deprecated, use --url (removal: 2.0)';
const DOCS_PATH_UYARISI = 'kobay: warning: --docs-path is deprecated, use --docs (removal: 2.0)';

function uyariSatirlari(stderr: string): string[] {
  return stderr.split('\n').filter((satir) => satir.startsWith('kobay: warning:'));
}

async function proje(): Promise<{ cwd: string; dizin: KobayDizini }> {
  const cwd = await geciciDizinAc('kobay-uyari-');
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://localhost:3000', brain: { adaptor: 'sahte' } });
  await mkdir(join(cwd, 'docs'), { recursive: true });
  await writeFile(join(cwd, 'docs', 'urun.md'), '# Ürün\n');
  return { cwd, dizin };
}

function yakalayici(): { akis: PassThrough; metin: () => string } {
  const akis = new PassThrough();
  let metin = '';
  akis.setEncoding('utf8');
  akis.on('data', (parca: string) => { metin += parca; });
  return { akis, metin: () => metin };
}

describe('uyarı yardımcısı', () => {
  beforeEach(() => yazilanUyarilariSifirla());

  it('aynı uyarıyı süreç başına bir kez, farklı uyarıları ayrı satır yazar', () => {
    const { akis, metin } = yakalayici();
    const eski = eskiAdUyarisi('--base-url', '--url');
    uyarilariYaz([eski], akis);
    uyarilariYaz([eski, eskiAdUyarisi('--docs-path', '--docs')], akis);
    uyarilariYaz([eski], akis);
    expect(metin()).toBe(`${BASE_URL_UYARISI}\n${DOCS_PATH_UYARISI}\n`);
  });

  it('ortam değişkeni adı için de aynı biçimi verir', () => {
    expect(eskiAdUyarisi('KOBAY_ESKI', 'KOBAY_YENI')).toEqual({
      code: 'DEPRECATED',
      message: 'KOBAY_ESKI is deprecated, use KOBAY_YENI (removal: 2.0)',
      replacement: 'KOBAY_YENI',
    });
  });
});

describe('project update eski bayrak adları', () => {
  beforeEach(() => yazilanUyarilariSifirla());

  it('--base-url çalışır ve stderr\'e tek uyarı satırı yazar', async () => {
    const { cwd, dizin } = await proje();
    const sonuc = await kobay(cwd, 'project', 'update', '--base-url', 'http://localhost:4000');
    expect(sonuc.kod).toBe(0);
    expect(uyariSatirlari(sonuc.hata)).toEqual([BASE_URL_UYARISI]);
    expect((await dizin.configOku()).baseUrl).toBe('http://localhost:4000');
  });

  it('--base-url JSON zarfına warnings ekler, stdout tek JSON satırı kalır', async () => {
    const { cwd } = await proje();
    const sonuc = await kobay(cwd, '--output', 'json', 'project', 'update', '--base-url', 'http://localhost:4000');
    expect(sonuc.kod).toBe(0);
    const satirlar = sonuc.cikti.trim().split('\n');
    expect(satirlar).toHaveLength(1);
    const zarf = JSON.parse(satirlar[0] ?? '') as Record<string, unknown>;
    expect(zarf).toMatchObject({ ok: true, exitCode: 0, data: { config: { baseUrl: 'http://localhost:4000' } } });
    expect(zarf.warnings).toEqual([{
      code: 'DEPRECATED',
      message: '--base-url is deprecated, use --url (removal: 2.0)',
      replacement: '--url',
    }]);
    expect(uyariSatirlari(sonuc.hata)).toEqual([BASE_URL_UYARISI]);
  });

  it('--url ve --docs uyarısız çalışır; zarfta warnings alanı yok', async () => {
    const { cwd, dizin } = await proje();
    const sonuc = await kobay(cwd, '--output', 'json', 'project', 'update', '--url', 'http://localhost:4000', '--docs', 'docs/urun.md');
    expect(sonuc.kod).toBe(0);
    expect(sonuc.hata).toBe('');
    const zarf = JSON.parse(sonuc.cikti) as Record<string, unknown>;
    expect('warnings' in zarf).toBe(false);
    const config = await dizin.configOku();
    expect(config.baseUrl).toBe('http://localhost:4000');
    expect(config.docsPath).toBe('docs/urun.md');
  });

  it('--docs-path çalışır ve kendi uyarısını verir', async () => {
    const { cwd, dizin } = await proje();
    const sonuc = await kobay(cwd, '--output', 'json', 'project', 'update', '--docs-path', 'docs/urun.md');
    expect(sonuc.kod).toBe(0);
    expect(uyariSatirlari(sonuc.hata)).toEqual([DOCS_PATH_UYARISI]);
    const zarf = JSON.parse(sonuc.cikti) as { warnings?: unknown };
    expect(zarf.warnings).toEqual([{
      code: 'DEPRECATED',
      message: '--docs-path is deprecated, use --docs (removal: 2.0)',
      replacement: '--docs',
    }]);
    expect((await dizin.configOku()).docsPath).toBe('docs/urun.md');
  });

  it('aynı süreçte iki eski bayrak iki ayrı satır; aynı uyarı ikinci komutta yinelenmez', async () => {
    const { cwd } = await proje();
    const ilk = await kobay(cwd, 'project', 'update', '--base-url', 'http://localhost:4000', '--docs-path', 'docs/urun.md');
    expect(ilk.kod).toBe(0);
    expect(uyariSatirlari(ilk.hata)).toEqual([BASE_URL_UYARISI, DOCS_PATH_UYARISI]);
    // Aynı süreçte ikinci çağrı: stderr satırı yinelenmez, zarf yine uyarıyı taşır.
    const ikinci = await kobay(cwd, '--output', 'json', 'project', 'update', '--base-url', 'http://localhost:5000');
    expect(ikinci.kod).toBe(0);
    expect(uyariSatirlari(ikinci.hata)).toEqual([]);
    expect((JSON.parse(ikinci.cikti) as { warnings?: Array<{ code: string }> }).warnings?.map((u) => u.code)).toEqual(['DEPRECATED']);
  });

  it('yeni ve eski ad birlikte verilirse kullanım hatası; config değişmez', async () => {
    const { cwd, dizin } = await proje();
    const sonuc = await kobay(cwd, '--output', 'json', 'project', 'update', '--url', 'http://localhost:4000', '--base-url', 'http://localhost:5000');
    expect(sonuc.kod).toBe(2);
    const zarf = JSON.parse(sonuc.cikti) as { ok: boolean; error: { message: string }; warnings?: unknown[] };
    expect(zarf.ok).toBe(false);
    expect(zarf.error.message).toContain('--url and --base-url cannot be used together');
    expect(zarf.warnings).toHaveLength(1);
    expect(uyariSatirlari(sonuc.hata)).toEqual([BASE_URL_UYARISI]);
    expect((await dizin.configOku()).baseUrl).toBe('http://localhost:3000');

    const belge = await kobay(cwd, 'project', 'update', '--docs', 'docs/urun.md', '--docs-path', 'docs/urun.md');
    expect(belge.kod).toBe(2);
    expect(belge.hata).toContain('--docs and --docs-path cannot be used together');
  });

  it('kimlik sorulamadığında da hata zarfı uyarıyı taşır; config değişmez', async () => {
    const { cwd, dizin } = await proje();
    const eski = { kullanici: process.env.KOBAY_LOGIN_USER, parola: process.env.KOBAY_LOGIN_PASS };
    delete process.env.KOBAY_LOGIN_USER;
    delete process.env.KOBAY_LOGIN_PASS;
    try {
      const sonuc = await kobay(cwd, '--output', 'json', 'project', 'update', '--base-url', 'http://localhost:4000', '--login');
      expect(sonuc.kod).toBe(2);
      const satirlar = sonuc.cikti.trim().split('\n');
      expect(satirlar).toHaveLength(1);
      const zarf = JSON.parse(satirlar[0] ?? '') as { ok: boolean; error: { message: string }; warnings?: Array<{ replacement: string }> };
      expect(zarf.ok).toBe(false);
      expect(zarf.error.message).toContain('Could not prompt for credentials');
      expect(zarf.warnings?.map((u) => u.replacement)).toEqual(['--url']);
      expect(uyariSatirlari(sonuc.hata)).toEqual([BASE_URL_UYARISI]);
      expect((await dizin.configOku()).baseUrl).toBe('http://localhost:3000');
    } finally {
      if (eski.kullanici !== undefined) process.env.KOBAY_LOGIN_USER = eski.kullanici;
      if (eski.parola !== undefined) process.env.KOBAY_LOGIN_PASS = eski.parola;
    }
  });

  it('eski bayrağın hatalı değeri de uyarıyı yazar ve zarfa koyar', async () => {
    const { cwd } = await proje();
    const sonuc = await kobay(cwd, '--output', 'json', 'project', 'update', '--base-url', 'ftp://localhost');
    expect(sonuc.kod).toBe(2);
    expect((JSON.parse(sonuc.cikti) as { warnings?: unknown[] }).warnings).toHaveLength(1);
    expect(uyariSatirlari(sonuc.hata)).toEqual([BASE_URL_UYARISI]);
  });
});
