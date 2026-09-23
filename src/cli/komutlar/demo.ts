import { basariliMetin, komutCalistir, KullanimHatasi, type KomutSonucu } from '../komut.js';

interface DemoSunucusu {
  url: string;
  kapat: () => Promise<void>;
}

export type DemoBaslat = (port: number) => Promise<DemoSunucusu>;

export function demoModuluUrl(temelUrl: string = import.meta.url): URL {
  return new URL('../../../test/kobay-demo/sunucu.mjs', temelUrl);
}

async function paketDemoBaslat(port: number): Promise<DemoSunucusu> {
  const demoUrl = demoModuluUrl();
  const demoModulu = await import(demoUrl.href) as { baslat: DemoBaslat };
  return demoModulu.baslat(port);
}

export function demoPortu(deger: string): number {
  const port = Number(deger);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new KullanimHatasi('--port 0 ile 65535 arasında bir tam sayı olmalı');
  }
  return port;
}

export async function demo(a: { port?: number; baslat?: DemoBaslat } = {}): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const port = a.port ?? 3000;
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new KullanimHatasi('--port 0 ile 65535 arasında bir tam sayı olmalı');
    }
    const sunucu = await (a.baslat ?? paketDemoBaslat)(port);
    return basariliMetin(
      { url: sunucu.url, kullanici: 'demo', parola: 'demo123' },
      `Kobay demo: ${sunucu.url}\nGiriş: demo / demo123\nDurdurmak için Ctrl+C`,
    );
  });
}
