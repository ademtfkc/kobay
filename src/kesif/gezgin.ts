import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Sayfa } from '../depo/index.js';
import { sayfaOzeti } from './sayfa-ozeti.js';

interface KuyrukOgesi { url: string; derinlik: number }

export interface GezginSecenekleri {
  baseUrl: string;
  maxSayfa: number;
  derinlik: number;
  sayfaZamanAsimiMs: number;
  ekranGoruntusuDizini?: string;
  ilkSayfalar?: Sayfa[];
  kalipBasinaSayfa?: number;
}

const riskliBaglantiMetni = /çıkış|logout|sign out|oturumu kapat|sil|delete|kaldır|remove/i;

/** Yıkıcı veya oturumu kapatan bir bağlantının keşif kuyruğuna girmesini engeller. */
export function baglantiIzlenebilir(metin: string): boolean {
  return !riskliBaglantiMetni.test(metin);
}

function normalUrl(adres: string): string | null {
  try {
    const url = new URL(adres);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Sayısal ve UUID-benzeri yol parçalarını, tekrar eden sayfaları sınırlamak için `:id` yapar. */
export function urlKalibi(adres: string): string | null {
  const url = normalUrl(adres);
  if (url === null) return null;
  const sayisal = /^\d+$/;
  const uuidBenzeri = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
  const yol = new URL(url).pathname
    .split('/')
    .map((parca) => (sayisal.test(parca) || uuidBenzeri.test(parca) ? ':id' : parca))
    .join('/');
  return yol || '/';
}

async function izlenebilirLinkler(sayfa: Page, koken: string): Promise<string[]> {
  const baglantilar = await sayfa.locator('a[href]').evaluateAll((elemanlar) =>
    elemanlar.map((eleman) => {
      const baglanti = eleman as HTMLAnchorElement;
      return { href: baglanti.href, metin: baglanti.textContent ?? '' };
    }),
  );
  const sonuc: string[] = [];
  for (const baglanti of baglantilar) {
    if (!baglantiIzlenebilir(baglanti.metin)) continue;
    const url = normalUrl(baglanti.href);
    if (url && new URL(url).origin === koken && !sonuc.includes(url)) sonuc.push(url);
  }
  return sonuc;
}

/** Aynı kökende, yalnızca güvenli bağlantıları genişlik öncelikli gezer. */
export async function gez(sayfa: Page, secenekler: GezginSecenekleri): Promise<Sayfa[]> {
  const baslangic = normalUrl(secenekler.baseUrl);
  if (!baslangic) throw new Error('baseUrl geçerli bir http(s) adresi olmalı');
  const koken = new URL(baslangic).origin;
  const sayfalar = [...(secenekler.ilkSayfalar ?? [])].slice(0, secenekler.maxSayfa);
  const gorulen = new Set(sayfalar.map(({ url }) => url));
  const kuyruk: KuyrukOgesi[] = [{ url: baslangic, derinlik: 0 }];
  const kalipBasinaSayfa = secenekler.kalipBasinaSayfa ?? 2;
  const kalipSayilari = new Map<string, number>();
  const baslangicKalibi = urlKalibi(baslangic);
  if (baslangicKalibi !== null) kalipSayilari.set(baslangicKalibi, 1);

  if (secenekler.ekranGoruntusuDizini) await mkdir(secenekler.ekranGoruntusuDizini, { recursive: true });

  while (kuyruk.length > 0 && sayfalar.length < secenekler.maxSayfa) {
    const oge = kuyruk.shift();
    if (!oge || gorulen.has(oge.url)) continue;

    try {
      await sayfa.goto(oge.url, { waitUntil: 'domcontentloaded', timeout: secenekler.sayfaZamanAsimiMs });
      const ozet = await sayfaOzeti(sayfa, koken);
      if (gorulen.has(ozet.url)) continue;
      gorulen.add(ozet.url);
      sayfalar.push(ozet);
      if (secenekler.ekranGoruntusuDizini) {
        await sayfa.screenshot({ path: join(secenekler.ekranGoruntusuDizini, `sayfa-${sayfalar.length}.png`) });
      }
      if (oge.derinlik >= secenekler.derinlik) continue;
      for (const url of await izlenebilirLinkler(sayfa, koken)) {
        const kalip = urlKalibi(url);
        const kalipSayisi = kalip === null ? 0 : (kalipSayilari.get(kalip) ?? 0);
        if (
          !gorulen.has(url)
          && !kuyruk.some((aday) => aday.url === url)
          && kalip !== null
          && kalipSayisi < kalipBasinaSayfa
        ) {
          kuyruk.push({ url, derinlik: oge.derinlik + 1 });
          kalipSayilari.set(kalip, kalipSayisi + 1);
        }
      }
    } catch {
      // Ulaşılamayan bir sayfa keşfi durdurmaz; diğer kuyruk öğeleri sürer.
    }
  }
  return sayfalar;
}
