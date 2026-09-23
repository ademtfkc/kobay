import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
import { main, programOlustur } from '../../src/cli/index.js';
import { demo, demoModuluUrl, demoPortu } from '../../src/cli/komutlar/demo.js';
import { installBrowser } from '../../src/cli/komutlar/install-browser.js';

function metinTopla(akis: PassThrough): { oku: () => string } {
  let metin = '';
  akis.setEncoding('utf8');
  akis.on('data', (parca: string) => { metin += parca; });
  return { oku: () => metin };
}

describe('yayın CLI komutları', () => {
  it('install-browser ve demo komutlarını CLI\'ya kaydeder', () => {
    const komutlar = programOlustur().commands.map((komut) => komut.name());
    expect(komutlar).toContain('install-browser');
    expect(komutlar).toContain('demo');
  });

  it('install-browser Kobay\'a kurulu Playwright CLI ile Chromium kurar ve --with-deps aktarır', async () => {
    const calistir = vi.fn(async () => 0);
    const sonuc = await installBrowser({ withDeps: true, calistir, cliYolu: '/paket/@playwright/test/cli.js' });

    expect(sonuc.exitCode).toBe(0);
    expect(calistir).toHaveBeenCalledWith(process.execPath, [
      '/paket/@playwright/test/cli.js', 'install', '--with-deps', 'chromium',
    ]);
  });

  it('install-browser alt süreç hatasını başarı saymaz', async () => {
    const sonuc = await installBrowser({ calistir: async () => 7, cliYolu: '/playwright/cli.js' });

    expect(sonuc.exitCode).toBe(4);
    expect(sonuc.mesaj).toContain('exit 7');
  });

  it('demo varsayılan portu kullanır ve giriş bilgisini basar', async () => {
    const baslat = vi.fn(async (port: number) => ({
      url: `http://127.0.0.1:${port}`,
      kapat: async () => undefined,
    }));
    const sonuc = await demo({ baslat });

    expect(baslat).toHaveBeenCalledWith(3000);
    expect(sonuc.exitCode).toBe(0);
    expect(sonuc.metin).toContain('http://127.0.0.1:3000');
    expect(sonuc.metin).toContain('demo / demo123');
  });

  it('demo modülünü paket kökündeki yayımlanan dosyadan bulur', () => {
    const url = demoModuluUrl('file:///paket/dist/cli/komutlar/demo.js');
    expect(url.href).toBe('file:///paket/test/kobay-demo/sunucu.mjs');
  });

  it('demo portunu sınırlar', () => {
    expect(demoPortu('0')).toBe(0);
    expect(demoPortu('65535')).toBe(65_535);
    expect(() => demoPortu('65536')).toThrow('--port');
    expect(() => demoPortu('abc')).toThrow('--port');
  });

  it('--version değerini package.json dosyasından okur', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const cikti = metinTopla(stdout);
    const hata = metinTopla(stderr);

    const exitCode = await main(['node', 'kobay', '--version'], {
      input: Readable.from([]), stdout, stderr,
    });

    expect(exitCode).toBe(0);
    expect(cikti.oku().trim()).toBe(packageJson.version);
    expect(hata.oku()).toBe('');
  });
});
