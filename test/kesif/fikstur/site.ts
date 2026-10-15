// Keşif derinliği fikstürü: arkadaşın taşımacılık sitesinin (rapor
// `reports/2026-10-12-gercek-kullanim-arkadas.md` §3) yapısını taklit eden, bağımlılıksız,
// 57 rotalı yerel HTTP sunucusu. Gerçek sitenin kodu yok; yapı rapordan kuruldu.
//
// Programatik: `const site = await fiksturBaslat(); … await site.kapat();` (port 0 = rastgele).
// Elle: `npx tsx test/kesif/fikstur/site.ts [port] [--sitemap duz|indeks|yok]`.
//
// Rota kümeleri aşağıda sabit olarak dışa açıktır; testler sayıları buradan okur.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

export const HIZMETLER = ['evden-eve', 'ofis-tasima', 'parca-esya', 'piyano-tasima', 'depolama', 'sehirlerarasi']
  .map((ad) => `/hizmet/${ad}`);
export const SEHIRLER = ['istanbul', 'ankara', 'izmir', 'bursa', 'antalya', 'adana', 'konya', 'gaziantep']
  .map((ad) => `/sehir/${ad}`);
/** Raporda 8 yazı vardı; 40 tavanında 5'i gezilmiş, 3'ü dışarıda kalmıştı. */
export const BLOG_YAZILARI = [
  'tasinma-kontrol-listesi', 'piyano-nasil-tasinir', 'ofis-tasima-rehberi', 'kis-tasinmasi',
  'esya-paketleme', 'nakliye-sigortasi', 'tasima-fiyatlari-2026', 'ogrenci-tasinmasi',
].map((ad) => `/blog/${ad}`);
/** Üç şablonun kopyaları (desen başına kota bunlara uygulanır). */
export const SABLON_KOPYALARI = [...HIZMETLER, ...SEHIRLER, ...BLOG_YAZILARI];
export const TASIYICILAR = ['/tasiyicilar/hizli-nakliyat', '/tasiyicilar/guven-tasimacilik'];

/** Uygulamanın ana akış sayfaları: 40 sayfa tavanında haritada olmaları gerekir. */
export const ANA_AKIS = ['/hizli-teklif', '/iletisim', '/tasiyici/kayit'];
/** Bağlantısı olan tekil (desen dışı) herkese açık sayfalar. */
export const TEKIL_SAYFALAR = [
  '/', '/hizmet', '/sehirler', '/blog', '/nasil-calisir', '/hizli-teklif', '/tasiyici-ol', '/giris',
  '/yardim', '/yardim/sss', '/iletisim', '/tasiyici/kayit',
  '/hakkimizda', '/gizlilik', '/kullanim-kosullari', '/kvkk', '/cerez-politikasi', '/mesafeli-satis',
];
/** Bağlantısı görülen, girişsiz istekte 302 ile `/giris`'e yönlenen 7 rota. */
export const GIRIS_GEREKTIRENLER = [
  '/talep/yeni', '/taleplerim', '/mesajlar', '/bildirimler', '/hesabim', '/degerlendirmelerim', '/talep/TLP-4821',
];
/** Hiçbir sayfadan bağlantısı olmayan, yalnız sitemap'te listelenen herkese açık sayfalar. */
export const YALNIZ_SITEMAP = ['/kampanya', '/basin'];
/** Bağlantısı ve sitemap kaydı olmayan rotalar (yönetim paneli ve iç sayfalar). */
export const BAGLANTISIZ = ['/admin', '/admin/kullanicilar', '/admin/talepler', '/admin/raporlar', '/kayit/tamamla', '/kit'];
const GIRISLI_BAGLANTISIZ = new Set(['/kayit/tamamla']);
/** Yönetici rolü ister: normal oturumla da `/giris`'e yönlenir (rol kapısı). */
export const YONETICI_SAYFALARI = ['/admin', '/admin/kullanicilar', '/admin/talepler', '/admin/raporlar'];
/** Giriş dışı yönlendirme (eski adres → yeni adres); `requiresLogin` sayılmamalı. Rota sayısına girmez. */
export const TAKMA_AD = { eski: '/hizmetlerimiz', yeni: '/hizmet' };

export const ROTALAR = [
  ...TEKIL_SAYFALAR, ...SABLON_KOPYALARI, ...TASIYICILAR, ...GIRIS_GEREKTIRENLER, ...YALNIZ_SITEMAP, ...BAGLANTISIZ,
];

/** Yıkıcı bağlantı: keşif süzgeci bunu hiç istememeli. */
export const YIKICI_BAGLANTI = '/hesap/sil';

export const GIRIS_BILGISI = { username: 'demo@tasigelsin.test', password: 'demo-parola-41' };

/** 81 il, plaka sırasıyla; `/hizli-teklif`'teki il seçicileri bunları taşır. */
export const ILLER = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Amasya', 'Ankara', 'Antalya', 'Artvin', 'Aydın', 'Balıkesir',
  'Bilecik', 'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa', 'Çanakkale', 'Çankırı', 'Çorum', 'Denizli',
  'Diyarbakır', 'Edirne', 'Elazığ', 'Erzincan', 'Erzurum', 'Eskişehir', 'Gaziantep', 'Giresun', 'Gümüşhane', 'Hakkari',
  'Hatay', 'Isparta', 'Mersin', 'İstanbul', 'İzmir', 'Kars', 'Kastamonu', 'Kayseri', 'Kırklareli', 'Kırşehir',
  'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa', 'Kahramanmaraş', 'Mardin', 'Muğla', 'Muş', 'Nevşehir',
  'Niğde', 'Ordu', 'Rize', 'Sakarya', 'Samsun', 'Siirt', 'Sinop', 'Sivas', 'Tekirdağ', 'Tokat',
  'Trabzon', 'Tunceli', 'Şanlıurfa', 'Uşak', 'Van', 'Yozgat', 'Zonguldak', 'Aksaray', 'Bayburt', 'Karaman',
  'Kırıkkale', 'Batman', 'Şırnak', 'Bartın', 'Ardahan', 'Iğdır', 'Yalova', 'Karabük', 'Kilis', 'Osmaniye',
  'Düzce',
];

export type SitemapKipi = 'duz' | 'indeks' | 'yok';

export interface FiksturSecenekleri {
  port?: number;
  /** `duz`: tek `/sitemap.xml`; `indeks`: `/sitemap.xml` iki alt sitemap'e işaret eder; `yok`: 404. */
  sitemap?: SitemapKipi;
  /**
   * Verilirse `/yonlendir-dis` (`/iletisim`'den bağlantılı) ve `/yonlendir-dis-sitemap` (yalnız
   * sitemap'te) bu adrese 302 ile yönlenir; rota sayısına girmez. Varsayılan sitede yoktur.
   */
  disYonlendirme?: string;
}

export const DIS_YONLENDIRMELER = { bagli: '/yonlendir-dis', sitemap: '/yonlendir-dis-sitemap' };

export interface FiksturSitesi {
  url: string;
  /** Gelen isteklerin `YÖNTEM /yol?sorgu` satırları, geliş sırasıyla. */
  istekler: string[];
  kapat: () => Promise<void>;
}

const OTURUM_CEREZI = 'tg_oturum=gecerli';

function etiket(metin: string): string {
  return metin.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function insanAdi(yol: string): string {
  const son = yol.split('/').filter(Boolean).pop() ?? 'ana-sayfa';
  return son.split('-').map((parca) => parca.charAt(0).toLocaleUpperCase('tr-TR') + parca.slice(1)).join(' ');
}

function baglanti(yol: string, metin: string): string {
  return `<a href="${yol}">${etiket(metin)}</a>`;
}

function ustBolum(girisli: boolean): string {
  // Profil bağlantısı yalnız ikon: metni yok, adı aria-label'da.
  const profil = '<a href="/hesabim" aria-label="Hesabım"><svg width="16" height="16" aria-hidden="true"><rect width="12" height="12"></rect></svg></a>';
  const kullanici = girisli ? `${profil} ${baglanti('/cikis', 'Çıkış yap')}` : `${profil} ${baglanti('/giris', 'Giriş yap')}`;
  return `<header><nav>${[
    baglanti('/', 'Ana sayfa'), baglanti('/hizmet', 'Hizmetler'), baglanti('/sehirler', 'Şehirler'),
    // Bilerek ASCII: eski süzgeç "Nasil" içindeki "sil"e takılıyordu (backlog notu).
    baglanti('/nasil-calisir', 'Nasil calisir'),
    baglanti('/blog', 'Blog'), baglanti('/hizli-teklif', 'Hızlı teklif'), baglanti('/tasiyici-ol', 'Taşıyıcı ol'),
  ].join(' ')}</nav>
<div class="kullanici">${baglanti('/talep/yeni', 'Talep oluştur')} ${baglanti('/taleplerim', 'Taleplerim')}
${baglanti('/mesajlar', 'Mesajlar')} ${baglanti('/bildirimler', 'Bildirimler')} ${kullanici}</div>
<button type="button" aria-label="Koyu temaya geç"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle></svg></button>
</header>`;
}

function altBolum(): string {
  return `<footer>
<section><h2>Hizmetler</h2>${HIZMETLER.map((yol) => baglanti(yol, insanAdi(yol))).join(' ')}</section>
<section><h2>Şehirler</h2>${SEHIRLER.map((yol) => baglanti(yol, `${insanAdi(yol)} nakliyat`)).join(' ')}</section>
<section><h2>Kurumsal</h2>${[
    baglanti('/yardim', 'Yardım'), baglanti('/yardim/sss', 'SSS'), baglanti('/iletisim', 'İletişim'),
    baglanti('/tasiyici/kayit', 'Taşıyıcı kaydı'), baglanti('/hakkimizda', 'Hakkımızda'),
    baglanti('/degerlendirmelerim', 'Değerlendirmelerim'),
  ].join(' ')}</section>
<section><h2>Yasal</h2>${[
    baglanti('/gizlilik', 'Gizlilik'), baglanti('/kullanim-kosullari', 'Kullanım koşulları'), baglanti('/kvkk', 'KVKK'),
    baglanti('/cerez-politikasi', 'Çerez politikası'), baglanti('/mesafeli-satis', 'Mesafeli satış sözleşmesi'),
  ].join(' ')}</section>
</footer>`;
}

function sayfa(yanit: ServerResponse, baslik: string, govde: string, girisli: boolean): void {
  yanit.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  yanit.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${etiket(baslik)} | Taşı Gelsin</title></head>
<body>${ustBolum(girisli)}<main><h1>${etiket(baslik)}</h1>${govde}</main>${altBolum()}</body></html>`);
}

function ilSecici(ad: string, etiketMetni: string): string {
  const secenekler = ILLER.map((il) => `<option value="${etiket(il)}">${etiket(il)}</option>`).join('');
  return `<label>${etiket(etiketMetni)}<select name="${ad}"><option value="" disabled selected>Şehir seç</option>${secenekler}</select></label>`;
}

function anaSayfa(): string {
  return `<p>Eşyanızı güvenle taşıyacak taşıyıcıyı bulun.</p>
<form action="/talep/yeni" method="get">${ilSecici('nereden', 'Nereden')}${ilSecici('nereye', 'Nereye')}
<label>Kategori<select name="kategori"><option>Evden eve</option><option>Ofis</option><option>Parça eşya</option></select></label>
<label>Tarih<input type="date" name="tarih"></label><button type="submit">Teklif al</button></form>
<section><h2>Hizmetlerimiz</h2>${HIZMETLER.map((yol) => baglanti(yol, insanAdi(yol))).join(' ')}</section>
<section><h2>Popüler şehirler</h2>${SEHIRLER.map((yol) => baglanti(yol, insanAdi(yol))).join(' ')}</section>
<section><h2>Son yazılar</h2>${BLOG_YAZILARI.slice(0, 3).map((yol) => baglanti(yol, insanAdi(yol))).join(' ')}</section>
<section><h2>Öne çıkan taşıyıcılar</h2>${TASIYICILAR.map((yol) => baglanti(yol, insanAdi(yol))).join(' ')}</section>
${baglanti('/hizli-teklif', 'Anında fiyat al')} ${baglanti('/tasiyici-ol', 'Taşıyıcı olun')}`;
}

/** `<form>` etiketi yok: React kontrollü alanlar gibi 4 select + 2 input; fiyat dökümü details içinde. */
function hizliTeklif(): string {
  return `<div class="hesaplayici">
<label for="kategori">Kategori</label><select id="kategori"><option>Evden eve</option><option>Ofis</option><option>Parça eşya</option></select>
<label for="hacim">Hacim</label><select id="hacim"><option>1+1</option><option>2+1</option><option>3+1</option><option>4+1</option></select>
${ilSecici('nereden-il', 'Nereden')}${ilSecici('nereye-il', 'Nereye')}
<label for="ilce">İlçe</label><input id="ilce" type="text" placeholder="İlçe">
<label for="mesafe">Mesafe (km)</label><input id="mesafe" type="number" min="1">
</div>
<h2>2 taşıyıcının tarifesi</h2>
<details><summary>Hızlı Nakliyat fiyat dökümü</summary><ul><li>Taşıma: 4.000 TL</li><li>Paketleme: 800 TL</li></ul></details>
<details><summary>Güven Taşımacılık fiyat dökümü</summary><ul><li>Taşıma: 4.400 TL</li><li>Sigorta: 300 TL</li></ul></details>`;
}

/** Next.js Server Action gizli alanlarıyla giriş formu. */
function girisFormu(next: string, hata: boolean): string {
  return `${hata ? '<p role="alert">E-posta veya parola hatalı</p>' : ''}
<form method="post" action="/giris">
<input type="hidden" name="$ACTION_REF_1" value=""><input type="hidden" name="$ACTION_1:0" value='{"id":"7f3a"}'>
<input type="hidden" name="$ACTION_1:1" value="[]"><input type="hidden" name="$ACTION_KEY" value="k0">
<input type="hidden" name="next" value="${etiket(next)}">
<label>E-posta<input type="email" name="email"></label><label>Parola<input type="password" name="parola"></label>
<button type="submit">Giriş yap</button></form>`;
}

function tasiyiciKayit(): string {
  const adimlar = ['Firma', 'Araçlar', 'Hizmet bölgesi', 'Tarifeler', 'Belgeler', 'Onay'];
  return `<ol>${adimlar.map((adim, sira) => `<li><button type="button">${sira + 1}. ${adim}</button></li>`).join('')}</ol>
<form action="/tasiyici/kayit" method="post"><label>Firma adı<input name="firma" type="text"></label>
<label>Telefon<input name="telefon" type="tel"></label><button type="submit" disabled>Devam et</button></form>`;
}

function sitemapXml(koken: string, yollar: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${yollar.map((yol) => `  <url><loc>${koken}${yol}</loc><changefreq>weekly</changefreq></url>`).join('\n')}
</urlset>`;
}

const SITEMAP_SAYFALAR = [...TEKIL_SAYFALAR, ...TASIYICILAR, ...YALNIZ_SITEMAP];
const SITEMAP_ICERIK = [...SABLON_KOPYALARI];

function sitemapGovdesi(kipi: SitemapKipi, yol: string, koken: string, disVar: boolean): string | null {
  // Başka köken ve sorgu dizisi taşıyan kayıtlar: okuyucu birini atmalı, diğerini tekilleştirmeli.
  const ekler = `${disVar ? `  <url><loc>${koken}${DIS_YONLENDIRMELER.sitemap}</loc></url>\n` : ''}  <url><loc>https://tasigelsin.example${'/kampanya'}</loc></url>\n  <url><loc>${koken}/kampanya?utm_source=x&amp;utm_medium=y</loc></url>`;
  if (kipi === 'duz' && yol === '/sitemap.xml') {
    return sitemapXml(koken, [...SITEMAP_SAYFALAR, ...SITEMAP_ICERIK]).replace('</urlset>', `${ekler}\n</urlset>`);
  }
  if (kipi === 'indeks') {
    if (yol === '/sitemap.xml') {
      return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${koken}/sitemap-sayfalar.xml</loc></sitemap>
  <sitemap><loc><![CDATA[${koken}/sitemap-icerik.xml]]></loc></sitemap>
  <sitemap><loc>https://baska-koken.example/sitemap.xml</loc></sitemap>
</sitemapindex>`;
    }
    if (yol === '/sitemap-sayfalar.xml') return sitemapXml(koken, SITEMAP_SAYFALAR).replace('</urlset>', `${ekler}\n</urlset>`);
    if (yol === '/sitemap-icerik.xml') return sitemapXml(koken, SITEMAP_ICERIK);
  }
  return null;
}

async function govdeOku(istek: IncomingMessage): Promise<URLSearchParams> {
  let govde = '';
  for await (const parca of istek) govde += String(parca);
  return new URLSearchParams(govde);
}

const BASLIKLAR: Record<string, string> = {
  '/': 'Taşı Gelsin', '/hizmet': 'Hizmetler', '/sehirler': 'Şehirler', '/blog': 'Blog',
  '/nasil-calisir': 'Nasıl çalışır', '/hizli-teklif': 'Hızlı teklif', '/tasiyici-ol': 'Taşıyıcı olun',
  '/giris': 'Giriş', '/yardim': 'Yardım merkezi', '/yardim/sss': 'Sık sorulan sorular', '/iletisim': 'İletişim',
  '/tasiyici/kayit': 'Taşıyıcı kaydı', '/hakkimizda': 'Hakkımızda', '/gizlilik': 'Gizlilik politikası',
  '/kullanim-kosullari': 'Kullanım koşulları', '/kvkk': 'KVKK aydınlatma metni', '/cerez-politikasi': 'Çerez politikası',
  '/mesafeli-satis': 'Mesafeli satış sözleşmesi', '/kampanya': 'Kampanyalar', '/basin': 'Basın odası', '/kit': 'Arayüz kiti',
};

function govdeUret(yol: string, disVar: boolean): string {
  switch (yol) {
    case '/': return anaSayfa();
    case '/hizmet': return HIZMETLER.map((y) => baglanti(y, insanAdi(y))).join(' ');
    case '/sehirler': return SEHIRLER.map((y) => baglanti(y, insanAdi(y))).join(' ');
    case '/blog': return BLOG_YAZILARI.map((y) => baglanti(y, insanAdi(y))).join(' ');
    case '/hizli-teklif': return hizliTeklif();
    case '/tasiyici/kayit': return tasiyiciKayit();
    case '/tasiyici-ol': return `<p>Ağımıza katılın.</p>${baglanti('/tasiyici/kayit', 'Hemen kaydol')}`;
    case '/yardim': return baglanti('/yardim/sss', 'Sık sorulan sorular');
    case '/hakkimizda': return `<p>2019'dan beri.</p>${baglanti(TAKMA_AD.eski, 'Hizmetlerimiz')}`;
    case '/yardim/sss':
      return `<details><summary>Talebimi nasıl takip ederim?</summary><p>Örnek: ${baglanti('/talep/TLP-4821', 'TLP-4821')}</p></details>
<details><summary>Hesabımı nasıl kapatırım?</summary><p>${baglanti(YIKICI_BAGLANTI, 'Hesabımı sil')}</p></details>`;
    case '/iletisim':
      return `${disVar ? baglanti(DIS_YONLENDIRMELER.bagli, 'Destek portalı') : ''}<form action="/iletisim" method="post"><label>Ad soyad<input name="ad" type="text"></label>
<label>E-posta<input name="eposta" type="email"></label><label>Mesaj<textarea name="mesaj"></textarea></label>
<button type="submit">Gönder</button></form>`;
    default:
      if (SEHIRLER.includes(yol)) return `<p>${insanAdi(yol)} içi ve şehirlerarası nakliyat.</p>${baglanti('/hizli-teklif', 'Fiyat hesapla')}`;
      if (HIZMETLER.includes(yol)) return `<p>${insanAdi(yol)} hizmeti.</p>${baglanti('/hizli-teklif', 'Fiyat hesapla')}`;
      if (BLOG_YAZILARI.includes(yol)) return `<article><p>${insanAdi(yol)} hakkında yazı.</p></article>${baglanti('/blog', 'Tüm yazılar')}`;
      return `<p>${etiket(BASLIKLAR[yol] ?? insanAdi(yol))}</p>`;
  }
}

/** Fikstür sitesini başlatır; `port` verilmezse rastgele boş port. */
export async function fiksturBaslat(secenekler: FiksturSecenekleri = {}): Promise<FiksturSitesi> {
  const sitemapKipi = secenekler.sitemap ?? 'duz';
  const istekler: string[] = [];
  const herkeseAcik = new Set([...TEKIL_SAYFALAR, ...SABLON_KOPYALARI, ...TASIYICILAR, ...YALNIZ_SITEMAP, '/kit']);
  const girisli = new Set([...GIRIS_GEREKTIRENLER, ...GIRISLI_BAGLANTISIZ]);

  const sunucu = createServer((istek, yanit) => {
    void (async () => {
      const url = new URL(istek.url ?? '/', 'http://fikstur.local');
      istekler.push(`${istek.method ?? 'GET'} ${url.pathname}${url.search}`);
      const koken = `http://${istek.headers.host ?? 'localhost'}`;
      const oturumVar = istek.headers.cookie?.split(';').some((c) => c.trim() === OTURUM_CEREZI) ?? false;
      const yol = url.pathname;

      const sitemap = sitemapGovdesi(sitemapKipi, yol, koken, secenekler.disYonlendirme !== undefined);
      if (sitemap !== null) {
        yanit.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
        yanit.end(sitemap);
        return;
      }
      if (yol === '/giris' && istek.method === 'POST') {
        const form = await govdeOku(istek);
        const next = form.get('next') ?? '/';
        if (form.get('email') === GIRIS_BILGISI.username && form.get('parola') === GIRIS_BILGISI.password) {
          const hedef = next.startsWith('/') && !next.startsWith('//') ? next : '/';
          yanit.writeHead(302, { location: hedef, 'set-cookie': `${OTURUM_CEREZI}; Path=/; HttpOnly` });
          yanit.end();
          return;
        }
        sayfa(yanit, 'Giriş', girisFormu(next, true), false);
        return;
      }
      if (yol === '/cikis') {
        yanit.writeHead(302, { location: '/', 'set-cookie': 'tg_oturum=; Path=/; Max-Age=0' });
        yanit.end();
        return;
      }
      if (istek.method !== 'GET') {
        yanit.writeHead(405);
        yanit.end();
        return;
      }
      if (secenekler.disYonlendirme !== undefined && Object.values(DIS_YONLENDIRMELER).includes(yol)) {
        yanit.writeHead(302, { location: `${secenekler.disYonlendirme}/hedef?jeton=gizli` });
        yanit.end();
        return;
      }
      if (yol === TAKMA_AD.eski) {
        yanit.writeHead(301, { location: TAKMA_AD.yeni });
        yanit.end();
        return;
      }
      if (YONETICI_SAYFALARI.includes(yol)) {
        yanit.writeHead(302, { location: `/giris?next=${encodeURIComponent(yol)}` });
        yanit.end();
        return;
      }
      if (yol === '/giris') {
        sayfa(yanit, 'Giriş', girisFormu(url.searchParams.get('next') ?? '/', false), oturumVar);
        return;
      }
      if (girisli.has(yol)) {
        if (!oturumVar) {
          yanit.writeHead(302, { location: `/giris?next=${encodeURIComponent(yol)}` });
          yanit.end();
          return;
        }
        sayfa(yanit, insanAdi(yol), `<p>${etiket(insanAdi(yol))} (oturum açık)</p>`, true);
        return;
      }
      if (herkeseAcik.has(yol)) {
        sayfa(yanit, BASLIKLAR[yol] ?? insanAdi(yol), govdeUret(yol, secenekler.disYonlendirme !== undefined), oturumVar);
        return;
      }
      yanit.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      yanit.end('<!doctype html><title>Bulunamadı</title><h1>Sayfa bulunamadı</h1>');
    })().catch(() => {
      if (!yanit.headersSent) yanit.writeHead(500);
      yanit.end();
    });
  });

  await new Promise<void>((coz, reddet) => {
    sunucu.once('error', reddet);
    sunucu.listen(secenekler.port ?? 0, '127.0.0.1', () => coz());
  });
  const { port } = sunucu.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    istekler,
    kapat: () => new Promise<void>((coz) => {
      sunucu.closeAllConnections();
      sunucu.close(() => coz());
    }),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 0);
  const kipSirasi = process.argv.indexOf('--sitemap');
  const kip = (kipSirasi > 0 ? process.argv[kipSirasi + 1] : 'duz') as SitemapKipi;
  const site = await fiksturBaslat({ port, sitemap: kip });
  process.stdout.write(`${site.url}\n`);
}
