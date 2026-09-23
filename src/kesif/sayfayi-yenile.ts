import { access } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import type { Harita, Kimlik, Sayfa } from '../depo/index.js';
import { girisFormuBul } from './giris.js';
import { girisiGonder, kimlikOriginDogrula, loginUrlDogrula, oturumDurumunuYaz } from './oturum.js';
import { sayfaOzeti } from './sayfa-ozeti.js';

export interface SayfaYenilemeSecenekleri {
  baseUrl: string;
  /** Yenilenecek sayfanın adresi; göreli verilirse `baseUrl` ile çözülür. */
  url: string;
  storageStateYolu: string;
  kimlik?: Kimlik;
  loginUrl?: string;
  sayfaZamanAsimiMs?: number;
}

/**
 * `src/analiz/index.ts` içindeki `urlYolu` ile aynı mantık: yalnız pathname.
 * Analiz modülü bu şeridin dokunma listesinde olduğu için üç satır tekrarlandı.
 */
function urlYolu(adres: string, baseUrl: string): string | null {
  try {
    return new URL(adres, baseUrl).pathname;
  } catch {
    return null;
  }
}

function dosyaVarMi(yol: string): Promise<boolean> {
  return access(yol).then(() => true).catch(() => false);
}

/**
 * Tek bir sayfayı var olan oturumla açıp yeniden özetler. Oturum düşmüşse
 * (istenen yol yerine giriş ekranına yönlenildiyse) kimlik varsa yeniden giriş
 * yapar ve storageState'i günceller. Sayfa yine açılamıyorsa hata verir; yanlış
 * sayfanın özeti haritaya yazılmaz.
 */
export async function sayfayiYenile(secenekler: SayfaYenilemeSecenekleri): Promise<Sayfa> {
  loginUrlDogrula(secenekler.baseUrl, secenekler.loginUrl);
  // Tarayıcı açılmadan: başka origin'e ait kimlikle hiçbir sayfaya gidilmez.
  if (secenekler.kimlik !== undefined) kimlikOriginDogrula(secenekler.kimlik, new URL(secenekler.baseUrl).origin);
  const hedef = new URL(secenekler.url, secenekler.baseUrl).href;
  const beklenenYol = new URL(hedef).pathname;
  const sayfaZamanAsimiMs = secenekler.sayfaZamanAsimiMs ?? 15_000;
  const tarayici = await chromium.launch({ headless: true });
  const oturumVar = await dosyaVarMi(secenekler.storageStateYolu);
  const context = await tarayici.newContext(
    oturumVar ? { storageState: secenekler.storageStateYolu } : {},
  );
  const sayfa = await context.newPage();

  try {
    await sayfa.goto(hedef, { waitUntil: 'domcontentloaded', timeout: sayfaZamanAsimiMs });

    // Giriş yalnız yönlendirme olduğunda denenir; hedef sayfadaki bir parola
    // alanı (örn. "şifre değiştir" formu) giriş sanılmasın.
    if (secenekler.kimlik !== undefined && new URL(sayfa.url()).pathname !== beklenenYol) {
      if (secenekler.loginUrl !== undefined) {
        await sayfa.goto(secenekler.loginUrl, { waitUntil: 'domcontentloaded', timeout: sayfaZamanAsimiMs });
      }
      const form = await girisFormuBul(sayfa);
      if (form) {
        await girisiGonder(sayfa, form, secenekler.kimlik, new URL(secenekler.baseUrl).origin);
        await oturumDurumunuYaz(context, secenekler.storageStateYolu);
        await sayfa.goto(hedef, { waitUntil: 'domcontentloaded', timeout: sayfaZamanAsimiMs });
      }
    }

    const gelenYol = new URL(sayfa.url()).pathname;
    if (gelenYol !== beklenenYol) {
      throw new Error(`Page could not be refreshed: asked for ${beklenenYol}, got ${gelenYol} (the session may have expired)`);
    }
    return await sayfaOzeti(sayfa, new URL(secenekler.baseUrl).origin);
  } finally {
    await context.close();
    await tarayici.close();
  }
}

/** Haritada verilen adrese yol eşleşmesiyle karşılık gelen sayfanın sırası; yoksa -1. */
function sayfaSirasi(harita: Harita, istenenUrl: string): number {
  const istenenYol = urlYolu(istenenUrl, harita.baseUrl);
  if (istenenYol === null) return -1;
  return harita.pages.findIndex((sayfa) => urlYolu(sayfa.url, harita.baseUrl) === istenenYol);
}

/** Haritadaki sayfayı yol eşleşmesiyle bulur; yoksa null. Tarayıcı gerekmez. */
export function haritadaSayfaBul(harita: Harita, istenenUrl: string): Sayfa | null {
  return harita.pages[sayfaSirasi(harita, istenenUrl)] ?? null;
}

/**
 * Haritadaki tek sayfayı yerinde değiştirir; diğer sayfalara dokunmaz.
 * Eşleşme yol (pathname) üzerinden yapılır, analiz tarafındaki kıyasla aynı.
 * Sayfa haritada yoksa null döner.
 */
export function haritadaSayfayiDegistir(
  harita: Harita,
  istenenUrl: string,
  yeniSayfa: Sayfa,
): { harita: Harita; eskiSayfa: Sayfa } | null {
  const sira = sayfaSirasi(harita, istenenUrl);
  const eskiSayfa = harita.pages[sira];
  if (sira < 0 || eskiSayfa === undefined) return null;

  const sayfalar = [...harita.pages];
  sayfalar[sira] = yeniSayfa;
  return {
    harita: { ...harita, pages: sayfalar, exploredAt: new Date().toISOString() },
    eskiSayfa,
  };
}
