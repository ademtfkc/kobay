// 0.8.0 Ş2 (P2-1): keşif SPA sayfasını çizildikten sonra okur; bekleme tavanlıdır.
// Gerçek Chromium + yerel HTTP sunucusu; sayfa özeti sahte değil.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domSessizlik, domSessizlikIptal, DURULMA, gez, istekIzle, sayfaDurulsun } from '../../src/kesif/gezgin.js';
import { sayfayiYenile } from '../../src/kesif/sayfayi-yenile.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

/** Veri gecikmesi (ms) her istekte rastgele: iki keşif aynı haritayı vermeli. */
const gecikme = (): number => 100 + Math.floor(Math.random() * 500);

const SPA = `<!doctype html><title>App</title><div id="app">Loading…</div><script>
  const yol = location.pathname;
  fetch('/api' + yol).then((c) => c.json()).then((veri) => {
    if (veri.yonlen) { history.replaceState(null, '', veri.yonlen); }
    document.getElementById('app').innerHTML = '<h1>' + veri.baslik + '</h1>'
      + veri.linkler.map((l) => '<a href="' + l + '">' + l + '</a>').join('')
      + '<form><input name="title" placeholder="Title"></form>'
      + veri.dugmeler.map((d) => '<button>' + d + '</button>').join('');
  });
</script>`;

/** Hiç durulmayan sayfa: DOM sürekli değişir, bir istek hiç bitmez. */
const DURULMAYAN = `<!doctype html><title>Busy</title><div id="saat"></div><a href="/mesgul-2">2</a><a href="/mesgul-3">3</a>
<script>
  setInterval(() => { document.getElementById('saat').textContent = String(performance.now()); }, 30);
  fetch('/asili');
</script>`;

/** Kötü niyetli sayfa: zamanlayıcıyı bozar; bekleme yine Node tarafında biter. */
const BOZUK_ZAMANLAYICI = `<!doctype html><title>Broken</title><button>Ok</button>
<script>window.setInterval = () => 0; window.MutationObserver = class { observe() {} disconnect() {} };</script>`;

/** DOM hemen durulur ama bir istek (long-poll) hiç bitmez: uzun istek sakinliği engellememeli. */
const UZUN_ISTEK = `<!doctype html><title>Poll</title><button>Ready</button><script>fetch('/asili');</script>`;

/**
 * Codex 2. tur P2-1: son istek DOM sessizlik penceresinin içinde biter, çizim ondan 140 ms sonra
 * `setTimeout` ile gelir. Ağ boşaldı diye hemen kaydedilirse düğme haritada olmaz.
 */
const GEC_CIZIM = `<!doctype html><title>Late</title><div id="app"></div><script>
  fetch('/gec-veri').then((c) => c.text()).then(() => setTimeout(() => {
    document.getElementById('app').innerHTML = '<button>Late button</button>';
  }, 140));
</script>`;

/** Codex 2. tur P2-2: yalnız setInterval bozuk; gerçek MutationObserver'ın kaç tanesi bağlı kalır, sayar. */
const sayanGozcu = (bozma: string): string => `<!doctype html><title>Count</title><button>Ok</button><script>
  ${bozma}
  const Asil = window.MutationObserver;
  let bagli = 0;
  let toplam = 0;
  window.MutationObserver = class extends Asil {
    observe(...a) { bagli++; toplam++; return super.observe(...a); }
    disconnect() { bagli = Math.max(0, bagli - 1); return super.disconnect(); }
  };
  window.bagliGozcu = () => bagli;
  window.toplamGozcu = () => toplam;
</script>`;
/** Yol → sayfanın bozduğu şey. Codex 3. tur (c), (d) ve (a) senaryoları. */
const SAYAN_SAYFALAR: Record<string, string> = {
  '/sayan-gozcu': 'window.setInterval = () => 0;',
  // (c) Sabit iptal anahtarını sayfa önceden, silinemez biçimde tanımlar.
  '/sayan-anahtar': "Object.defineProperty(window, '__kobayDurulmaIptal', { value: 1, configurable: false });",
  // (c) Hiçbir yeni özellik tanımlanamaz: iptal kaydı kurulamazsa gözlemci de bağlanmamalı.
  '/sayan-tanimsiz': 'Object.defineProperty = () => { throw new TypeError("no"); };',
  // (d) setInterval geri çağrıyı eşzamanlı çalıştırır; önce 200 ms meşgul bekler ki koşul hemen doğru olsun.
  '/sayan-eszamanli':
    'window.setInterval = (f) => { const t = performance.now(); while (performance.now() - t < 200) {} f(); return 0; };',
};

/** Codex 2. tur P1-1: sayfa beklemenin ortasında başka kökene geçer. */
const YABANCIYA_GIDEN = (hedef: string) => `<!doctype html><title>Go</title><button>x</button><script>
  setTimeout(() => { location.href = ${JSON.stringify(hedef)}; }, 60);
</script>`;
/**
 * Durulmadan SONRA, özet okunurken başka kökene geçen sayfa: kobay bağlantı adresini okuduğu anda
 * yönlenir (CI'da yavaş makinede 60 ms'lik zamanlayıcının durulma penceresinden sonra ateşlenmesinin
 * zamanlamadan bağımsız kopyası). Bağlantı okuması (`evaluateAll`) yarıda kesilir: bağlam yok hatası.
 */
const OZETTE_YABANCIYA = (hedef: string) => `<!doctype html><title>Go</title><a href="/x">x</a><script>
  const asil = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'href');
  Object.defineProperty(HTMLAnchorElement.prototype, 'href', { configurable: true, get() {
    location.href = ${JSON.stringify(hedef)};
    return asil.get.call(this);
  } });
</script>`;
/** Yabancı kökendeki belge: içine gözlemci kurulursa (kobay script'i çalışırsa) sunucuya haber verir. */
const YABANCI_BELGE = `<!doctype html><title>Foreign</title><script>
  const asil = MutationObserver.prototype.observe;
  MutationObserver.prototype.observe = function (...a) { fetch('/gozlendi'); return asil.apply(this, a); };
</script><p>foreign</p>`;

/** Kör kabul 2: ana iş parçacığı 50 ms sonra sonsuza dek kilitlenir. */
const DONUK = `<!doctype html><title>Hung</title><button>HungBtn</button><a href="/sabit">s</a>
<script>setTimeout(() => { while (true) {} }, 50);</script>`;
/** Kör kabul 1: istemci yönlendirmesi aynı kökendeki giriş sayfasına (oturum düşmüş gibi). */
const GIRISE_YONLENEN = `<!doctype html><title>Guarded</title><script>
  setTimeout(() => { location.replace('/giris-sayfasi'); }, 30);
</script>`;
const GIRIS_SAYFASI = `<!doctype html><title>Login</title><form action="/oturum" method="post">
  <input name="kullanici"><input type="password" name="parola"><button type="submit">Log in</button></form>`;

const VERI: Record<string, { baslik: string; linkler: string[]; dugmeler: string[]; yonlen?: string }> = {
  '/': { baslik: 'Home', linkler: ['/projects/2', '/tasks/1', '/filters/new'], dugmeler: ['Create'] },
  '/projects/2': { baslik: 'Project', linkler: ['/tasks/1'], dugmeler: ['Add', 'Done'], yonlen: '/projects/2/9' },
  '/tasks/1': { baslik: 'Task', linkler: ['/', '/projects/2'], dugmeler: ['Rename', 'Set due date', 'Comment'] },
  '/filters/new': { baslik: 'New filter', linkler: [], dugmeler: ['Save filter'] },
};

let sunucu: Server;
let yabanciSunucu: Server;
let kok: string;
let yabanciKok: string;
let tarayici: Browser;
const asiliYanitlar: Array<() => void> = [];
/** Yol başına HTML belge isteği sayısı. */
const belgeIstekleri = new Map<string, number>();
let yabanciGozlem = 0;

beforeAll(async () => {
  yabanciSunucu = createServer((istek, yanit) => {
    if ((istek.url ?? '').startsWith('/gozlendi')) yabanciGozlem++;
    if ((istek.url ?? '').startsWith('/asili-belge')) {
      asiliYanitlar.push(() => yanit.end());
      return;
    }
    if ((istek.url ?? '').startsWith('/yavas-geri-don')) {
      // Yavaş yabancı belge hemen hedef kökene geri gönderir (A → yabancı → A).
      setTimeout(() => {
        yanit.writeHead(200, { 'content-type': 'text/html' });
        yanit.end(`<!doctype html><title>Back</title><script>location.replace(${JSON.stringify(`${kok}/sabit`)});</script>`);
      }, 1_000);
      return;
    }
    if ((istek.url ?? '').startsWith('/fetchli')) {
      yanit.writeHead(200, { 'content-type': 'text/html' });
      yanit.end("<!doctype html><title>F</title><script>fetch('/asili-belge');</script>");
      return;
    }
    yanit.writeHead(200, { 'content-type': 'text/html' });
    yanit.end(YABANCI_BELGE);
  });
  await new Promise<void>((coz) => yabanciSunucu.listen(0, '127.0.0.1', coz));
  yabanciKok = `http://127.0.0.1:${(yabanciSunucu.address() as AddressInfo).port}`;
  sunucu = createServer((istek, yanit) => {
    const yol = new URL(istek.url ?? '/', 'http://x').pathname;
    if (!yol.startsWith('/api/') && yol !== '/asili') belgeIstekleri.set(yol, (belgeIstekleri.get(yol) ?? 0) + 1);
    if (yol === '/gec-veri') {
      setTimeout(() => yanit.end('ok'), 60);
      return;
    }
    if (yol === '/asili') {
      asiliYanitlar.push(() => yanit.end());
      return;
    }
    if (yol.startsWith('/api/')) {
      const veri = VERI[yol.slice(4)];
      setTimeout(() => {
        yanit.writeHead(veri ? 200 : 404, { 'content-type': 'application/json' });
        yanit.end(JSON.stringify(veri ?? {}));
      }, gecikme());
      return;
    }
    yanit.writeHead(200, { 'content-type': 'text/html' });
    if (yol.startsWith('/mesgul')) yanit.end(DURULMAYAN);
    else if (yol === '/bozuk') yanit.end(BOZUK_ZAMANLAYICI);
    else if (yol === '/uzun-istek') yanit.end(UZUN_ISTEK);
    else if (yol === '/gec-cizim') yanit.end(GEC_CIZIM);
    else if (SAYAN_SAYFALAR[yol] !== undefined) yanit.end(sayanGozcu(SAYAN_SAYFALAR[yol]));
    else if (yol === '/yabanciya') yanit.end(YABANCIYA_GIDEN(`${yabanciKok}/belge`));
    else if (yol === '/ozette-yabanciya') yanit.end(OZETTE_YABANCIYA(`${yabanciKok}/belge`));
    else if (yol === '/ozette-bos') yanit.end(OZETTE_YABANCIYA('about:blank'));
    // Yabancı yanıt 1 s gecikir: yönlenme özet sırasında başlar, Playwright sonraki okumayı yeni belge
    // yerleşene dek bekletir; yabancı belge hedef kökene geri gönderir.
    else if (yol === '/ozette-yavas-donen') yanit.end(OZETTE_YABANCIYA(`${yabanciKok}/yavas-geri-don`));
    else if (yol === '/yabanciya-asili') yanit.end(YABANCIYA_GIDEN(`${yabanciKok}/asili-belge`));
    else if (yol === '/donuk') yanit.end(DONUK);
    else if (yol === '/gec-yabanci') {
      yanit.end(`<!doctype html><title>Late</title><button>x</button><script>fetch('/asili');
        setTimeout(() => { location.href = ${JSON.stringify(`${yabanciKok}/fetchli`)}; }, 300);</script>`);
    }
    else if (yol === '/korumali') yanit.end(GIRISE_YONLENEN);
    else if (yol === '/giris-sayfasi') yanit.end(GIRIS_SAYFASI);
    else if (yol === '/sabit') yanit.end('<!doctype html><title>Static</title><button>Static</button>');
    else yanit.end(SPA);
  });
  await new Promise<void>((coz) => sunucu.listen(0, '127.0.0.1', coz));
  kok = `http://127.0.0.1:${(sunucu.address() as AddressInfo).port}`;
  tarayici = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await tarayici?.close();
  for (const bitir of asiliYanitlar) bitir();
  sunucu?.closeAllConnections();
  yabanciSunucu?.closeAllConnections();
  await new Promise<void>((coz) => sunucu.close(() => coz()));
  await new Promise<void>((coz) => yabanciSunucu.close(() => coz()));
});

async function kesif(baseUrl: string, ek: { maxSayfa?: number; toplamDurulmaTavaniMs?: number } = {}) {
  const sayfa = await tarayici.newPage();
  try {
    return await gez(sayfa, { baseUrl, maxSayfa: ek.maxSayfa ?? 10, derinlik: 3, sayfaZamanAsimiMs: 10_000, ...ek });
  } finally {
    await sayfa.close();
  }
}

const yolu = (adres: string): string => new URL(adres).pathname;

describe('keşif durulma beklemesi (P2-1)', () => {
  it('SPA sayfası veri gelip çizildikten sonra okunur: bağlantı, form ve düğmeler haritada', async () => {
    const sayfalar = await kesif(`${kok}/`);
    const bul = (yol: string) => sayfalar.find((s) => yolu(s.url) === yol);
    expect(bul('/')?.buttons).toEqual(['Create']);
    expect(bul('/tasks/1')?.buttons).toEqual(['Rename', 'Set due date', 'Comment']);
    expect(bul('/filters/new')?.forms[0]?.fields.map((alan) => alan.name)).toEqual(['title']);
    expect(bul('/')?.links.map(yolu)).toEqual(['/projects/2', '/tasks/1', '/filters/new']);
  });

  it('istemci yönlendirmesi: /projects/2 çizildiği adresle (/projects/2/9) kaydedilir, istenen adres tekrar gezilmez', async () => {
    belgeIstekleri.clear();
    const sayfalar = await kesif(`${kok}/`);
    // /projects/2 hem / hem /tasks/1 sayfasından bağlı; yine bir kez istenir.
    expect(belgeIstekleri.get('/projects/2')).toBe(1);
    const yollar = sayfalar.map((s) => yolu(s.url));
    expect(yollar).toContain('/projects/2/9');
    expect(yollar).not.toContain('/projects/2');
    expect(sayfalar.find((s) => yolu(s.url) === '/projects/2/9')?.buttons).toEqual(['Add', 'Done']);
  });

  it('aynı uygulamada iki keşif aynı sayfa ve öğe sayılarını verir (gecikme rastgele)', async () => {
    const say = (sayfalar: Awaited<ReturnType<typeof kesif>>) => sayfalar
      .map((s) => `${yolu(s.url)} l${s.links.length} f${s.forms.length} b${s.buttons.length}`).sort();
    const birinci = say(await kesif(`${kok}/`));
    const ikinci = say(await kesif(`${kok}/`));
    expect(ikinci).toEqual(birinci);
    expect(birinci).toHaveLength(4);
  });

  it('hiç durulmayan sayfa keşfi sayfa tavanından fazla tutmaz', async () => {
    const bas = Date.now();
    const sayfalar = await kesif(`${kok}/mesgul-1`, { maxSayfa: 3 });
    const sure = Date.now() - bas;
    expect(sayfalar.map((s) => yolu(s.url))).toEqual(['/mesgul-1', '/mesgul-2', '/mesgul-3']);
    expect(sure).toBeLessThan(3 * DURULMA.sayfaTavaniMs + 3_000);
    expect(sure).toBeGreaterThanOrEqual(3 * DURULMA.sayfaTavaniMs - 500);
  }, 30_000);

  it('toplam durulma tavanı dolunca bekleme kapanır: 3 durulmayan sayfa toplamda tavan kadar bekler', async () => {
    const bas = Date.now();
    // Kör kabul 3: hesap satırı kalkarsa her sayfa 600 ms bekler (≈1.8 s); doğru davranış ≈0.6 s + gezinme.
    const sayfalar = await kesif(`${kok}/mesgul-1`, { maxSayfa: 3, toplamDurulmaTavaniMs: 600 });
    expect(sayfalar).toHaveLength(3);
    expect(Date.now() - bas).toBeLessThan(1_500);
  }, 30_000);

  it('bitmeyen tek istek (long-poll) beklemeyi sayfa tavanına kadar uzatmaz: uzun istek sınırında bırakılır', async () => {
    const bas = Date.now();
    const sayfalar = await kesif(`${kok}/uzun-istek`, { maxSayfa: 1 });
    const sure = Date.now() - bas;
    expect(sayfalar[0]?.buttons).toEqual(['Ready']);
    expect(sure).toBeGreaterThanOrEqual(DURULMA.uzunIstekMs - 300);
    expect(sure).toBeLessThan(DURULMA.sayfaTavaniMs - 300);
  }, 30_000);

  it('zamanlayıcıyı ve MutationObserver\'ı bozan sayfa beklemeyi kilitlemez', async () => {
    const bas = Date.now();
    const sayfalar = await kesif(`${kok}/bozuk`, { maxSayfa: 1 });
    expect(sayfalar[0]?.buttons).toEqual(['Ok']);
    expect(Date.now() - bas).toBeLessThan(DURULMA.sayfaTavaniMs + 2_500);
  }, 30_000);

  it('sayfa yenileme de SPA sayfasını çizildikten sonra okur', async () => {
    const dizin = await geciciDizinAc('kobay-durulma-');
    const sayfa = await sayfayiYenile({ baseUrl: kok, url: '/tasks/1', storageStateYolu: join(dizin, 'yok.json') });
    expect(sayfa.buttons).toEqual(['Rename', 'Set due date', 'Comment']);
  }, 30_000);
});

describe('durulma beklemesi: Codex 2. tur', () => {
  it('P2-1: son istekten sonra gecikmeli çizilen içerik de okunur (ağ boşalınca sessizlik yeniden ölçülür)', async () => {
    for (let tur = 0; tur < 3; tur++) {
      const sayfalar = await kesif(`${kok}/gec-cizim`, { maxSayfa: 1 });
      expect(sayfalar[0]?.buttons).toEqual(['Late button']);
    }
  }, 30_000);

  // Playwright'ın kendi gözlemcisi de sayılabilir: önce beklemesiz keşifte taban ölçülür.
  const gozcuOlc = async (yol: string, toplamDurulmaTavaniMs?: number): Promise<{ bagli: number; toplam: number; ms: number }> => {
    const sayfa = await tarayici.newPage();
    try {
      const bas = Date.now();
      const sayfalar = await gez(sayfa, {
        baseUrl: `${kok}${yol}`, maxSayfa: 1, derinlik: 0, sayfaZamanAsimiMs: 10_000,
        ...(toplamDurulmaTavaniMs === undefined ? {} : { toplamDurulmaTavaniMs }),
      });
      const ms = Date.now() - bas;
      expect(sayfalar[0]?.buttons).toEqual(['Ok']);
      const [bagli, toplam] = await sayfa.evaluate(() => {
        const w = window as unknown as { bagliGozcu: () => number; toplamGozcu: () => number };
        return [w.bagliGozcu(), w.toplamGozcu()];
      });
      return { bagli: bagli ?? -1, toplam: toplam ?? -1, ms };
    } finally {
      await sayfa.close();
    }
  };

  it('P2-2: Node süre sınırı kazanınca sayfadaki MutationObserver bağlı kalmaz', async () => {
    expect((await gozcuOlc('/sayan-gozcu')).bagli).toBe((await gozcuOlc('/sayan-gozcu', 0)).bagli);
  }, 30_000);

  it.each([
    ['(c) sabit anahtar sayfada silinemez biçimde önceden tanımlı', '/sayan-anahtar'],
    ['(c) sayfa Object.defineProperty\'yi bozmuş', '/sayan-tanimsiz'],
    ['(d) setInterval geri çağrıyı eşzamanlı çalıştırıyor', '/sayan-eszamanli'],
  ])('Codex 3. tur %s: gözlemci bağlı kalmaz, tur tur yeniden kurulmaz, tavan yakılmaz', async (_ad, yol) => {
    const taban = await gozcuOlc(yol, 0);
    const olcum = await gozcuOlc(yol);
    expect(olcum.bagli).toBe(taban.bagli);
    // Bekleme en çok birkaç gözlemci kurar; hata-tekrar döngüsünde onlarca kurulurdu.
    expect(olcum.toplam - taban.toplam).toBeLessThanOrEqual(2);
    expect(olcum.ms).toBeLessThan(DURULMA.sayfaTavaniMs - 500);
  }, 30_000);

  it.each([
    ['(c) sayfa sabit bir anahtarı önceden tutsa da (her tura özgü anahtar)', '/sayan-anahtar'],
    ['(d) setInterval geri çağrıyı eşzamanlı çalıştırsa da (TDZ yok)', '/sayan-eszamanli'],
  ])('Codex 3. tur %s bekleme çalışır ve durulmuş döner', async (_ad, yol) => {
    const sayfa = await tarayici.newPage();
    const izleyici = istekIzle(sayfa);
    try {
      await sayfa.goto(`${kok}${yol}`, { waitUntil: 'domcontentloaded' });
      expect(await sayfaDurulsun(sayfa, izleyici, DURULMA.sayfaTavaniMs, kok)).toBe(true);
    } finally {
      izleyici.birak();
      await sayfa.close();
    }
  }, 30_000);

  it('Codex 3. tur (a): iptal çağrısı yabancı belgeye düşerse oradaki işlevi çağırmaz', async () => {
    const sayfa = await tarayici.newPage();
    try {
      yabanciGozlem = 0;
      await sayfa.goto(`${yabanciKok}/belge`);
      // Yabancı belge, kobay'ın arayacağı adla bir işlev koyar; çağrılırsa sunucuya haber verir.
      // '[object Object]': eski imza (yalnız anahtar metni) nesne alırsa bu adla arardı; yeniden üretim için.
      await sayfa.evaluate(() => {
        for (const ad of ['__kobayTuzak', '[object Object]']) Reflect.set(window, ad, () => { void fetch('/gozlendi'); });
      });
      await sayfa.evaluate(domSessizlikIptal, { anahtar: '__kobayTuzak', koken: kok });
      await new Promise((coz) => setTimeout(coz, 300));
      expect(yabanciGozlem).toBe(0);
    } finally {
      await sayfa.close();
    }
  }, 30_000);

  it('P1-1: bekleme sırasında başka kökene geçen sayfada kobay kodu çalışmaz, sayfa haritaya girmez', async () => {
    yabanciGozlem = 0;
    const sayfalar = await kesif(`${kok}/yabanciya`, { maxSayfa: 1 });
    // Yabancı belgenin kendi yüklenmesi biter; geç kalan bir gözlem isteği de sayılsın.
    await new Promise((coz) => setTimeout(coz, 300));
    expect(yabanciGozlem).toBe(0);
    expect(sayfalar).toEqual([]);
  }, 30_000);

  it('P1-1 (Node denetimi): belge yabancı kökendeyse sayfaDurulsun hiç evaluate çağırmaz', async () => {
    const sayfa = await tarayici.newPage();
    const izleyici = istekIzle(sayfa);
    try {
      await sayfa.goto(`${yabanciKok}/belge`);
      let cagri = 0;
      const sayan = new Proxy(sayfa, {
        get(hedef, ad) {
          if (ad === 'evaluate') cagri++;
          const deger: unknown = Reflect.get(hedef, ad);
          return typeof deger === 'function' ? (deger as (...a: unknown[]) => unknown).bind(hedef) : deger;
        },
      });
      expect(await sayfaDurulsun(sayan, izleyici, 1_000, kok)).toBe(false);
      expect(cagri).toBe(0);
    } finally {
      izleyici.birak();
      await sayfa.close();
    }
  }, 30_000);

  it('P1-1 (sayfa içi denetim): evaluate yabancı belgeye düşse de gözlemci kurulmaz, hemen false döner', async () => {
    const sayfa = await tarayici.newPage();
    try {
      yabanciGozlem = 0;
      await sayfa.goto(`${yabanciKok}/belge`);
      const sonuc = await sayfa.evaluate(domSessizlik, { sessiz: 150, tavan: 1_000, koken: kok, anahtar: '__k' });
      await new Promise((coz) => setTimeout(coz, 300));
      expect(sonuc).toBe(false);
      expect(yabanciGozlem).toBe(0);
    } finally {
      await sayfa.close();
    }
  }, 30_000);

  it('P1-1: sayfa yenilemede de yabancı kökene geçen belgede bekleme kodu çalışmaz', async () => {
    yabanciGozlem = 0;
    const dizin = await geciciDizinAc('kobay-durulma-yabanci-');
    await expect(sayfayiYenile({ baseUrl: kok, url: '/yabanciya', storageStateYolu: join(dizin, 'yok.json') }))
      .rejects.toThrow(/could not be refreshed.*another origin/);
    await new Promise((coz) => setTimeout(coz, 300));
    expect(yabanciGozlem).toBe(0);
  }, 30_000);

  /** Yenileme köken hatasıyla reddedilir ve yabancı belgede kobay'ın bekleme kodu çalışmaz. */
  const yenilemeKokenHatasi = async (url: string): Promise<void> => {
    yabanciGozlem = 0;
    const dizin = await geciciDizinAc('kobay-durulma-ozette-yabanci-');
    await expect(sayfayiYenile({ baseUrl: kok, url, storageStateYolu: join(dizin, 'yok.json') }))
      .rejects.toThrow(/could not be refreshed.*another origin/);
    await new Promise((coz) => setTimeout(coz, 300));
    expect(yabanciGozlem).toBe(0);
  };

  it('P1-1 (a): durulmadan sonra özet yarıda kesilirse (bağlam yok) köken hatası verir', async () => {
    await yenilemeKokenHatasi('/ozette-yabanciya');
  }, 30_000);

  it('P1-1 (b): özet sırasında yabancıya yönelip hedef kökene dönen belge yine köken hatası verir', async () => {
    await yenilemeKokenHatasi('/ozette-yavas-donen');
  }, 30_000);

  it('P1-1 (c): ağ isteği olmayan gezinme (about:blank) özeti keserse yeni belge beklenir, köken hatası verir', async () => {
    await yenilemeKokenHatasi('/ozette-bos');
  }, 30_000);
});

describe('durulma beklemesi: kör kabul', () => {
  it('1: 0.7.0 haritasındaki /projects/2 yenilenir; aynı kökende istemci yönlendirmesi kabul edilir', async () => {
    const dizin = await geciciDizinAc('kobay-durulma-yonlen-');
    const sayfa = await sayfayiYenile({ baseUrl: kok, url: '/projects/2', storageStateYolu: join(dizin, 'yok.json') });
    expect(new URL(sayfa.url).pathname).toBe('/projects/2/9');
    expect(sayfa.buttons).toEqual(['Add', 'Done']);
  }, 30_000);

  it('1: aynı kökende giriş sayfasına istemci yönlendirmesi yine reddedilir (oturum düşmüş olabilir)', async () => {
    const dizin = await geciciDizinAc('kobay-durulma-giris-');
    await expect(sayfayiYenile({ baseUrl: kok, url: '/korumali', storageStateYolu: join(dizin, 'yok.json') }))
      .rejects.toThrow(/asked for \/korumali, got \/giris-sayfasi \(the session may have expired\)/);
  }, 30_000);

  it('2: ana iş parçacığı kilitlenen sayfa keşfi kilitlemez; sayfa atlanır, keşif biter', async () => {
    const ayri = await chromium.launch({ headless: true });
    try {
      const sayfa = await ayri.newPage();
      const bas = Date.now();
      // Kuyrukta ikinci adres var: kilitli sekme oraya da gidemez (her goto zaman aşımı), keşif durmalı.
      const sayfalar = await gez(sayfa, {
        baseUrl: `${kok}/donuk`, maxSayfa: 3, derinlik: 1, sayfaZamanAsimiMs: 3_000, tohumlar: [`${kok}/sabit`],
      });
      const sure = Date.now() - bas;
      expect(sayfalar).toEqual([]);
      // Durulma tavanı + iptal tavanı + özet tavanı; ikinci adrese gidilseydi +3 s daha.
      expect(sure).toBeLessThan(DURULMA.sayfaTavaniMs + DURULMA.iptalTavaniMs + 3_000 + 1_500);
    } finally {
      await ayri.close();
    }
  }, 60_000);

  it('2: kilitlenen sayfa yenilemede de süre sınırıyla hata verir', async () => {
    const ayri = await chromium.launch({ headless: true });
    try {
      const dizin = await geciciDizinAc('kobay-durulma-donuk-');
      const bas = Date.now();
      await expect(sayfayiYenile({ baseUrl: kok, url: '/donuk', storageStateYolu: join(dizin, 'yok.json'), sayfaZamanAsimiMs: 2_000 }))
        .rejects.toThrow(/did not respond/);
      expect(Date.now() - bas).toBeLessThan(DURULMA.sayfaTavaniMs + 2 * 2_000 + 3_000);
    } finally {
      await ayri.close();
    }
  }, 60_000);

  it('6: ağ beklemesi sırasında belge yabancı kökene geçerse onun isteklerini beklemez', async () => {
    const sayfa = await tarayici.newPage();
    const izleyici = istekIzle(sayfa);
    try {
      await sayfa.goto(`${kok}/gec-yabanci`, { waitUntil: 'domcontentloaded' });
      const bas = Date.now();
      expect(await sayfaDurulsun(sayfa, izleyici, DURULMA.sayfaTavaniMs, kok)).toBe(false);
      // Yönlenme ~300 ms'de; yabancı belgenin asılı isteği ≥1.5 s tutardı.
      expect(Date.now() - bas).toBeLessThan(1_000);
    } finally {
      izleyici.birak();
      await sayfa.close();
    }
  }, 30_000);

  it('6: önceki belgeden kalan istekler (asılı fetch, yarıda kalan gezinme) yeni gezinmede sayılmaz', async () => {
    const sayfa = await tarayici.newPage();
    const izleyici = istekIzle(sayfa);
    try {
      await sayfa.goto(`${kok}/uzun-istek`, { waitUntil: 'domcontentloaded' });
      await new Promise((coz) => setTimeout(coz, 100));
      expect(izleyici.kisaBekleyen()).toBeGreaterThan(0);
      await sayfa.goto(`${kok}/sabit`, { waitUntil: 'domcontentloaded' });
      expect(izleyici.kisaBekleyen()).toBe(0);
      await sayfa.goto(`${kok}/yabanciya-asili`, { waitUntil: 'domcontentloaded' });
      await new Promise((coz) => setTimeout(coz, 200));
      await sayfa.goto(`${kok}/sabit`, { waitUntil: 'domcontentloaded' });
      expect(izleyici.kisaBekleyen()).toBe(0);
    } finally {
      izleyici.birak();
      await sayfa.close();
    }
  }, 30_000);
});
