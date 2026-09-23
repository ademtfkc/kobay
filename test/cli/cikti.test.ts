import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ciktiYaz } from '../../src/cli/cikti.js';
import { main } from '../../src/cli/index.js';
import { KobayDizini } from '../../src/depo/index.js';

function metinTopla(akis: PassThrough): { oku: () => string } {
  let metin = '';
  akis.setEncoding('utf8');
  akis.on('data', (parca: string) => { metin += parca; });
  return { oku: () => metin };
}

afterEach(() => {
  delete process.env.KOBAY_LOGIN_USER;
  delete process.env.KOBAY_LOGIN_PASS;
});

describe('insan modunda tablo hücreleri', () => {
  it('iç içe dizi ve nesneleri okunur kısaltmaya çevirir, [object Object] basmaz', async () => {
    const { hucreMetni } = await import('../../src/cli/cikti.js');
    expect(hucreMetni('planSteps', [
      { type: 'action', description: 'Cariler sayfasını aç' },
      { type: 'assertion', description: 'Başlığı gör' },
    ])).toBe('2 steps');
    expect(hucreMetni('evidence', [])).toBe('0 evidence items');
    expect(hucreMetni('bilinmeyen', [{ a: 1 }, { a: 2 }, { a: 3 }])).toBe('3 items');
    expect(hucreMetni('headings', ['Cariler', 'Faturalar'])).toBe('Cariler, Faturalar');
    expect(hucreMetni('recommendedFixTarget', { kind: 'selector', reference: '/cariler' })).toBe('selector');
    expect(hucreMetni('error', { code: 'UsageError', message: 'Test bulunamadı' })).toBe('Test bulunamadı');
    expect(hucreMetni('bos', undefined)).toBe('');
    expect(hucreMetni('uzun', 'x'.repeat(80))).toBe(`${'x'.repeat(59)}…`);
  });

  it('plan accept benzeri satırlarda tabloyu tek satıra sığdırır', () => {
    const stdout = new PassThrough();
    const cikti = metinTopla(stdout);

    ciktiYaz({
      exitCode: 0,
      json: [{
        id: 't_abc12345',
        ad: 'Cari ekleme akışı',
        planSteps: [
          { type: 'action', description: 'Cariler sayfasını aç' },
          { type: 'action', description: 'Cari Ekle düğmesine bas' },
        ],
        durum: 'draft',
      }],
    }, false, stdout, new PassThrough());

    expect(cikti.oku()).not.toContain('[object Object]');
    expect(cikti.oku().trim()).toBe('t_abc12345\tCari ekleme akışı\t2 steps\tdraft');
  });
});

describe('CLI çıktı sınırı', () => {
  it('--brain öncelikli yardımda görünür ve --beyin eş adı çalışır', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const cikti = metinTopla(stdout);

    const exitCode = await main(['node', 'kobay', 'project', 'create', '--help'], {
      input: Readable.from([]), stdout, stderr,
    });

    expect(exitCode).toBe(0);
    expect(cikti.oku()).toContain('--brain <adaptor>');
    expect(cikti.oku()).toContain('(alias: --beyin)');
    expect(cikti.oku()).not.toContain('--beyin <adaptor>');
  });

  it('--brain ve --beyin aynı beyin ayarını kabul eder', async () => {
    for (const flag of ['--brain', '--beyin']) {
      const cwd = await mkdtemp(join(tmpdir(), 'kobay-cli-brain-'));
      const exitCode = await main([
        'node', 'kobay', '--cwd', cwd, 'project', 'create', '--url', 'http://uygulama.test', flag, 'sahte',
      ], { input: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough() });

      expect(exitCode).toBe(0);
      const dizin = await KobayDizini.bul(cwd);
      await expect(dizin?.configOku()).resolves.toMatchObject({ brain: { adaptor: 'sahte' } });

      const guncelleme = await main([
        'node', 'kobay', '--cwd', cwd, 'project', 'update', flag, 'codex',
      ], { input: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough() });
      expect(guncelleme).toBe(0);
      await expect(dizin?.configOku()).resolves.toMatchObject({ brain: { adaptor: 'codex' } });
    }
  });

  it('--output json ile stdouta yalnız ayrıştırılabilir tek JSON yazar', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kobay-cli-cikti-'));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const cikti = metinTopla(stdout);
    const hata = metinTopla(stderr);

    const exitCode = await main(
      ['node', 'kobay', 'test', 'list', '--output', 'json', '--cwd', cwd],
      { input: Readable.from([]), stdout, stderr },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(cikti.oku())).toMatchObject({ ok: false, exitCode: 2, error: { code: 'UsageError' } });
    expect(cikti.oku().trim().split('\n')).toHaveLength(1);
    expect(hata.oku()).toBe('');
  });

  it('kullanım hatasını tek kez basar, çıkış kodunu ve JSON zarfını korur', async () => {
    for (const [ad, argv] of [
      ['geçersiz seçenek', ['project', 'create', '--url', 'http://uygulama.test', '--brain', 'yok']],
      ['bilinmeyen komut', ['yokkomut']],
      ['eksik zorunlu seçenek', ['project', 'create']],
    ] as const) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const cikti = metinTopla(stdout);
      const hata = metinTopla(stderr);

      const exitCode = await main(['node', 'kobay', ...argv], { input: Readable.from([]), stdout, stderr });

      expect(exitCode, ad).toBe(2);
      // Commander hatayı kendisi basar; ikinci kez basılmamalı.
      expect(hata.oku().split('\n').filter((satir) => satir.startsWith('error:')), ad).toHaveLength(1);
      expect(cikti.oku(), ad).toBe('');
    }

    const jsonCikti = new PassThrough();
    const jsonMetni = metinTopla(jsonCikti);
    const jsonKod = await main([
      'node', 'kobay', '--output', 'json', 'project', 'create', '--url', 'http://uygulama.test', '--brain', 'yok',
    ], { input: Readable.from([]), stdout: jsonCikti, stderr: new PassThrough() });

    expect(jsonKod).toBe(2);
    expect(jsonMetni.oku().trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(jsonMetni.oku())).toMatchObject({ ok: false, exitCode: 2, error: { code: 'CommanderError' } });
  });

  it('test düşüşünü hata nesnesine çevirmeden JSON data olarak korur', async () => {
    const { ciktiZarfi } = await import('../../src/cli/cikti.js');
    expect(ciktiZarfi({ exitCode: 1, json: [{ id: 't_abc12345', verdict: 'failed' }] })).toEqual({
      ok: false,
      exitCode: 1,
      data: [{ id: 't_abc12345', verdict: 'failed' }],
    });
  });

  it('--login bilgilerini ortamdan alır ve hiçbir çıktıda parolayı göstermez', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kobay-cli-login-'));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const cikti = metinTopla(stdout);
    const hata = metinTopla(stderr);
    process.env.KOBAY_LOGIN_USER = 'demo';
    process.env.KOBAY_LOGIN_PASS = 'cok-gizli-parola';

    const exitCode = await main([
      'node', 'kobay', '--cwd', cwd, '--output', 'json',
      'project', 'create', '--url', 'http://uygulama.test', '--login', '--beyin', 'sahte',
    ], { input: Readable.from([]), stdout, stderr });

    expect(exitCode).toBe(0);
    expect(JSON.parse(cikti.oku())).toMatchObject({ ok: true, exitCode: 0 });
    expect(`${cikti.oku()}${hata.oku()}`).not.toContain('cok-gizli-parola');
    const dizin = await KobayDizini.bul(cwd);
    await expect(dizin?.kimlikOku()).resolves.toEqual({
      username: 'demo', password: 'cok-gizli-parola', origin: 'http://uygulama.test',
    });
  });

  it('--login girdisi kapalıyken ve ortam değişkeni yokken asılı kalmaz: exit 2 ve yönlendirme', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kobay-cli-login-kapali-'));
    delete process.env.KOBAY_LOGIN_USER;
    delete process.env.KOBAY_LOGIN_PASS;
    for (const [ad, input] of [
      ['boş akış', Readable.from([])],
      ['yalnız kullanıcı adı', Readable.from(['ali\n'])],
    ] as const) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const hata = metinTopla(stderr);
      const exitCode = await main([
        'node', 'kobay', '--cwd', cwd,
        'project', 'create', '--url', 'http://uygulama.test', '--login', '--beyin', 'sahte',
      ], { input, stdout, stderr });
      expect(exitCode, ad).toBe(2);
      expect(hata.oku(), ad).toContain('KOBAY_LOGIN_USER');
      expect(hata.oku(), ad).toContain('KOBAY_LOGIN_PASS');
      // Hata mesajı istemle aynı satıra düşmez.
      expect(hata.oku(), ad).not.toMatch(/(Username|Password): Could not/);
      expect(hata.oku(), ad).toMatch(/\nCould not prompt for credentials/);
      await expect(KobayDizini.bul(cwd), ad).resolves.toBeNull();
    }
  });
});
