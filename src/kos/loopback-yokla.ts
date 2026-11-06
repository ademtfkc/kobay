import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

/** RFC 6761: `localhost` ve `*.localhost` her zaman loopback'tir; sistem çözücüsüne sorulmaz. */
export function loopbackAdiMi(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const ad = u.hostname.toLowerCase().replace(/\.$/, '');
    return ad === 'localhost' || ad.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * Yoklama yalnız kök adresi ister (`origin + '/'`): kullanıcı bilgisi, yol, sorgu ve parça gitmez.
 * Tek soru "dinleyen var mı"dır; herhangi bir HTTP yanıtı (404 dahil) ayakta demektir.
 */
export function kokAdres(url: string): string {
  const u = new URL(url);
  // Ağ kökeni olmayan şemalarda (`data:` gibi; origin "null") adres olduğu gibi kalır, kimlik yine gitmez.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    u.username = '';
    u.password = '';
    return u.href;
  }
  return `${u.origin}/`;
}

/** Adı çözücüye sormadan yalnız verilen loopback adresini verir; Host/SNI özgün ad olarak kalır. */
export function loopbackLookup(adres: '127.0.0.1' | '::1'): LookupFunction {
  const aile = adres === '::1' ? 6 : 4;
  return (_ad, secenekler, geri) => {
    if (secenekler.all === true) {
      (geri as unknown as (e: null, l: Array<{ address: string; family: number }>) => void)(null, [{ address: adres, family: aile }]);
      return;
    }
    geri(null, adres, aile);
  };
}

interface Yoklama {
  sonuc: Promise<boolean>;
  iptal: () => void;
}

function birIstek(url: string, method: string, zamanAsimiMs: number, adres: '127.0.0.1' | '::1'): Yoklama {
  let iptal: () => void = () => {};
  const sonuc = new Promise<boolean>((coz) => {
    let bitti = false;
    const bitir = (ok: boolean): void => {
      if (bitti) return;
      bitti = true;
      coz(ok);
    };
    // Geçersiz URL ya da zaman aşımı (AbortSignal.timeout eşzamanlı fırlatır) dahil her hata false'tur.
    try {
      const u = new URL(kokAdres(url));
      const istek = u.protocol === 'https:' ? httpsRequest : httpRequest;
      const r = istek(
        u,
        {
          method,
          lookup: loopbackLookup(adres),
          signal: AbortSignal.timeout(zamanAsimiMs),
          // Yoklama sertifikayı doğrulamaz; istek yalnız alan adını (SNI/Host) taşır, yol/sorgu/kimlik gitmez.
          ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
        },
        (yanit: IncomingMessage) => {
          yanit.destroy();
          bitir(true);
        },
      );
      r.once('error', () => bitir(false));
      iptal = () => {
        bitir(false);
        r.destroy();
      };
      r.end();
    } catch {
      bitir(false);
    }
  });
  return { sonuc, iptal };
}

/** İki loopback adresi paralel denenir (autoSelectFamily'ye güvenilmez); biri yanıt verirse true, diğeri iptal edilir. */
function adreslerdeYokla(url: string, method: string, zamanAsimiMs: number): Promise<boolean> {
  return new Promise((coz) => {
    const yoklamalar = (['127.0.0.1', '::1'] as const).map((adres) => birIstek(url, method, zamanAsimiMs, adres));
    let kalan = yoklamalar.length;
    for (const y of yoklamalar) {
      void y.sonuc.then((ok) => {
        kalan -= 1;
        if (ok) {
          // Kazanan belli: asılı kalan diğer soket süreci zaman aşımına kadar canlı tutmasın.
          for (const diger of yoklamalar) if (diger !== y) diger.iptal();
          coz(true);
        } else if (kalan === 0) coz(false);
      });
    }
  });
}

/** `localhost`/`*.localhost` için HEAD, gerekirse GET; HTTP hata yanıtı ve yönlendirme de erişilebilirdir (yönlendirme izlenmez). */
export async function loopbackYokla(url: string, zamanAsimiMs: number): Promise<boolean> {
  for (const method of ['HEAD', 'GET']) {
    if (await adreslerdeYokla(url, method, zamanAsimiMs)) return true;
  }
  return false;
}
