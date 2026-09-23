import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import type { Harita, Kimlik, Sayfa } from '../depo/index.js';
import { girisFormuBul } from './giris.js';
import { gez } from './gezgin.js';
import { girisiGonder, kimlikOriginDogrula, loginUrlDogrula, oturumDurumunuYaz } from './oturum.js';
import { sayfaOzeti } from './sayfa-ozeti.js';

export interface KesifSecenekleri {
  baseUrl: string;
  kimlik?: Kimlik;
  loginUrl?: string;
  maxSayfa?: number;
  derinlik?: number;
  sayfaZamanAsimiMs?: number;
  storageStateYolu: string;
  ekranGoruntusuDizini?: string;
}

/** Uygulamayı güvenli bağlantılarla gezip test üretimine uygun bir harita çıkarır. */
export async function kesfet(secenekler: KesifSecenekleri): Promise<Harita> {
  loginUrlDogrula(secenekler.baseUrl, secenekler.loginUrl);
  // Tarayıcı açılmadan: başka origin'e ait kimlikle hiçbir sayfaya gidilmez.
  if (secenekler.kimlik !== undefined) kimlikOriginDogrula(secenekler.kimlik, new URL(secenekler.baseUrl).origin);
  const tarayici = await chromium.launch({ headless: true });
  const context = await tarayici.newContext();
  const sayfa = await context.newPage();
  const maxSayfa = secenekler.maxSayfa ?? 40;
  const derinlik = secenekler.derinlik ?? 3;
  const sayfaZamanAsimiMs = secenekler.sayfaZamanAsimiMs ?? 15_000;
  let girisYapildi = false;
  const ilkSayfalar: Sayfa[] = [];

  try {
    await sayfa.goto(secenekler.baseUrl, { waitUntil: 'domcontentloaded', timeout: sayfaZamanAsimiMs });
    if (secenekler.kimlik) {
      if (secenekler.loginUrl) {
        await sayfa.goto(secenekler.loginUrl, { waitUntil: 'domcontentloaded', timeout: sayfaZamanAsimiMs });
      }
      const form = await girisFormuBul(sayfa);
      if (form) {
        ilkSayfalar.push(await sayfaOzeti(sayfa, new URL(secenekler.baseUrl).origin));
        if (secenekler.ekranGoruntusuDizini) {
          await mkdir(secenekler.ekranGoruntusuDizini, { recursive: true });
          await sayfa.screenshot({ path: `${secenekler.ekranGoruntusuDizini}/sayfa-1.png` });
        }
        girisYapildi = await girisiGonder(sayfa, form, secenekler.kimlik, new URL(secenekler.baseUrl).origin);
      }
    }

    await oturumDurumunuYaz(context, secenekler.storageStateYolu);

    return {
      baseUrl: secenekler.baseUrl,
      girisYapildi,
      sayfalar: await gez(sayfa, {
        baseUrl: secenekler.baseUrl,
        maxSayfa,
        derinlik,
        sayfaZamanAsimiMs,
        ilkSayfalar,
        ...(secenekler.ekranGoruntusuDizini
          ? { ekranGoruntusuDizini: secenekler.ekranGoruntusuDizini }
          : {}),
      }),
      kesifTarihi: new Date().toISOString(),
    };
  } finally {
    await context.close();
    await tarayici.close();
  }
}

export { girisFormuBul } from './giris.js';
export {
  girisiGonder,
  KimlikOriginHatasi,
  kimlikOriginDogrula,
  loginUrlDogrula,
  oturumDurumunuYaz,
} from './oturum.js';
export { sayfaOzeti } from './sayfa-ozeti.js';
export {
  haritadaSayfaBul,
  haritadaSayfayiDegistir,
  sayfayiYenile,
  type SayfaYenilemeSecenekleri,
} from './sayfayi-yenile.js';
