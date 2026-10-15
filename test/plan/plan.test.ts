import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { beyinOlustur } from '../../src/beyin/index.js';
import { PassThrough, Readable } from 'node:stream';
import { main } from '../../src/cli/index.js';
import { planGenerate } from '../../src/cli/komutlar/plan.js';
import { KobayDizini, SchemaError, yazAtomik, type Harita, type Oneri } from '../../src/depo/index.js';
import {
  GIRIS_GEREKLI_SONRAKI_ADIM,
  PLAN_SISTEM_ISTEMI,
  PLAN_YENILEME_SISTEM_ISTEMI,
  haritaYolKaliplari,
  oneriUrlKarari,
  oneriyiTesteCevir,
  planDosyasindanTest,
  planKullaniciIstemiOlustur,
  planUret,
  planYenilemeKullaniciIstemiOlustur,
  yolKalibi,
} from '../../src/plan/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

const harita: Harita = {
  baseUrl: 'http://uygulama.test',
  loggedIn: true,
  exploredAt: '2026-09-17T00:00:00.000Z',
  pages: [
    {
      url: 'http://uygulama.test/giris/', title: 'Giriş', headings: ['Giriş yap'], links: [],
      forms: [{ fields: [{ name: 'e-posta', type: 'email', label: 'E-posta' }] }],
      buttons: ['Giriş yap'], menu: [],
    },
    {
      url: 'http://uygulama.test/urunler', title: 'Ürünler', headings: ['Ürün listesi'], links: [],
      forms: [], buttons: ['Sepete ekle'], menu: ['Ürünler'],
    },
  ],
};

function taslak(sira: number, url = 'http://uygulama.test/urunler/'): Record<string, unknown> {
  return {
    title: `Ürün akışı ${sira}`,
    description: 'Kullanıcı ürünleri görür.',
    priority: sira === 1 ? 'p0' : 'p1',
    category: 'gezinti',
    feature: 'ürünler',
    type: 'frontend',
    url,
    steps: [
      { type: 'action', description: 'Ürünler sayfasını aç' },
      { type: 'assertion', description: 'Ürün listesini gör' },
    ],
  };
}

async function sahteBeyin(icerik: unknown) {
  const dizin = await geciciDizinAc('kobay-plan-');
  await yazAtomik(join(dizin, 'plan.json'), JSON.stringify(icerik));
  return beyinOlustur({ adaptor: 'sahte' }, { KOBAY_SAHTE_YANIT_DIZINI: dizin });
}

describe('planUret', () => {
  it('sahte beynin 12 önerisine yerel proposalId atar', async () => {
    const beyin = await sahteBeyin({ proposals: Array.from({ length: 12 }, (_deger, sira) => taslak(sira + 1)) });

    const sonuc = await planUret(beyin, harita, undefined);

    expect(sonuc.dropped).toEqual([]);
    expect(sonuc.proposals).toHaveLength(12);
    expect(sonuc.proposals.map((oneri) => oneri.proposalId)).toEqual(
      expect.arrayContaining(Array.from({ length: 12 }, () => expect.stringMatching(/^p_[a-z0-9]{6}$/))),
    );
  });

  it('haritada olmayan URL içeren önerileri sebebiyle düşürür', async () => {
    const beyin = await sahteBeyin({ proposals: [
      taslak(1),
      taslak(2, 'https://farkli-origin.test/yonetim'),
      taslak(3, 'https://farkli-origin.test/eksik/'),
    ] });

    const sonuc = await planUret(beyin, harita, undefined);

    expect(sonuc.proposals).toHaveLength(1);
    expect(sonuc.dropped).toEqual([
      {
        title: 'Ürün akışı 2',
        reason: 'URL is not in the map and no path pattern matched: https://farkli-origin.test/yonetim (pattern: /yonetim)',
      },
      {
        title: 'Ürün akışı 3',
        reason: 'URL is not in the map and no path pattern matched: https://farkli-origin.test/eksik/ (pattern: /eksik)',
      },
    ]);
  });

  it('boş veya sınır dışı sayıdaki adımı düşürür', async () => {
    const bosAdimli = { ...taslak(2), steps: [] };
    const cokAdimli = {
      ...taslak(3),
      steps: Array.from({ length: 201 }, () => ({ type: 'action', description: 'Bir adım uygula' })),
    };
    const beyin = await sahteBeyin({ proposals: [taslak(1), bosAdimli, cokAdimli] });

    const sonuc = await planUret(beyin, harita, undefined);

    expect(sonuc.proposals).toHaveLength(1);
    expect(sonuc.dropped).toEqual([
      { title: 'Ürün akışı 2', reason: 'Step count is outside the 1-200 range: 0' },
      { title: 'Ürün akışı 3', reason: 'Step count is outside the 1-200 range: 201' },
    ]);
  });

  it('Türkçeleştirilmiş öneri ve adım anahtarlarını doğrulamadan önce eşler', async () => {
    const turkceTaslak = taslak(1, '/urunler');
    turkceTaslak.baslik = turkceTaslak.title;
    turkceTaslak.aciklama = turkceTaslak.description;
    turkceTaslak.oncelik = turkceTaslak.priority;
    turkceTaslak.kategori = turkceTaslak.category;
    turkceTaslak.ozellik = turkceTaslak.feature;
    turkceTaslak.tur = turkceTaslak.type;
    turkceTaslak.adimlar = (turkceTaslak.steps as Array<Record<string, unknown>>).map((adim) => ({
      tur: adim.type,
      aciklama: adim.description,
    }));
    delete turkceTaslak.title;
    delete turkceTaslak.description;
    delete turkceTaslak.priority;
    delete turkceTaslak.category;
    delete turkceTaslak.feature;
    delete turkceTaslak.type;
    delete turkceTaslak.steps;
    const beyin = await sahteBeyin({ proposals: [turkceTaslak] });

    const sonuc = await planUret(beyin, harita, undefined);

    expect(sonuc.proposals).toHaveLength(1);
    expect(sonuc.proposals[0]).toMatchObject({
      title: 'Ürün akışı 1', description: 'Kullanıcı ürünleri görür.', steps: expect.arrayContaining([
        { type: 'action', description: 'Ürünler sayfasını aç' },
      ]),
    });
  });
});

function bosSayfa(url: string, title: string) {
  return { url, title, headings: [title], links: [], forms: [], buttons: [], menu: [] };
}

/** `/cariler/1`…`/cariler/36` kayıt sayfalarını içeren gerçekçi harita. */
const kayitHaritasi: Harita = {
  baseUrl: 'http://uygulama.test',
  loggedIn: true,
  exploredAt: '2026-09-18T00:00:00.000Z',
  pages: [
    bosSayfa('http://uygulama.test/', 'Panel'),
    bosSayfa('http://uygulama.test/cariler', 'Cariler'),
    ...Array.from({ length: 36 }, (_deger, sira) =>
      bosSayfa(`http://uygulama.test/cariler/${sira + 1}`, `Cari ${sira + 1}`)),
  ],
};

describe('yol kalıpları', () => {
  it('haritadan benzersiz ve sıralı kalıp çıkarır', () => {
    expect(haritaYolKaliplari(kayitHaritasi)).toEqual(['/', '/cariler', '/cariler/:id']);
  });

  it('yalnız sayısal ve UUID-benzeri segmentleri :id yapar', () => {
    const temel = 'http://uygulama.test';
    expect(yolKalibi('/cariler/36', temel)).toBe('/cariler/:id');
    expect(yolKalibi('/cariler/6f1c2b3d-4e5a-6b7c-8d9e-0f1a2b3c4d5e/hareket', temel))
      .toBe('/cariler/:id/hareket');
    expect(yolKalibi('/cariler/0123456789abcdef0123456789abcdef', temel)).toBe('/cariler/:id');
    expect(yolKalibi('/cariler/abc', temel)).toBe('/cariler/abc');
    expect(yolKalibi('/cariler/36a', temel)).toBe('/cariler/36a');
  });

  it('sorgu, hash ve sondaki eğik çizgiyi yok sayar', () => {
    const temel = 'http://uygulama.test';
    expect(yolKalibi('/cariler/36?sekme=hareket#ust', temel)).toBe('/cariler/:id');
    expect(yolKalibi('/cariler/', temel)).toBe('/cariler');
    expect(yolKalibi('/', temel)).toBe('/');
  });

  it('sayfa olmayan şema için null döner ve öneriyi reddeder', () => {
    expect(yolKalibi('javascript:void(0)', 'http://uygulama.test')).toBeNull();
    expect(yolKalibi('mailto:a@b.test', 'http://uygulama.test')).toBeNull();
    expect(oneriUrlKarari('mailto:a@b.test', kayitHaritasi))
      .toEqual({ kabul: false, tur: 'yok', kalip: null });
  });

  it('haritada olmayan ama kalıba uyan kayıt URL’sini kabul eder', () => {
    expect(oneriUrlKarari('/cariler/999999', kayitHaritasi))
      .toEqual({ kabul: true, tur: 'kalip', kalip: '/cariler/:id' });
  });

  it('haritada birebir olan URL’yi kalıba bakmadan kabul eder', () => {
    expect(oneriUrlKarari('/cariler/12', kayitHaritasi))
      .toEqual({ kabul: true, tur: 'yol', kalip: '/cariler/:id' });
  });

  it('hiçbir kalıba uymayan yeni yolu reddeder', () => {
    expect(oneriUrlKarari('/faturalar', kayitHaritasi))
      .toEqual({ kabul: false, tur: 'yok', kalip: '/faturalar' });
  });

  it('sayısal olmayan son segmenti reddeder (kalıp id-biçimli değil)', () => {
    expect(oneriUrlKarari('/cariler/abc', kayitHaritasi))
      .toEqual({ kabul: false, tur: 'yok', kalip: '/cariler/abc' });
  });
});

describe('planUret kalıp eşleşmesi', () => {
  it('kalıba uyan hata-durumu önerisini tutar, uymayanları kalıp bilgisiyle düşürür', async () => {
    const beyin = await sahteBeyin({ proposals: [
      taslak(1, '/cariler/999999'),
      taslak(2, '/faturalar'),
      taslak(3, '/cariler/abc'),
      taslak(4, 'mailto:destek@uygulama.test'),
    ] });

    const sonuc = await planUret(beyin, kayitHaritasi, undefined);

    expect(sonuc.proposals).toHaveLength(1);
    expect(sonuc.proposals[0]).toMatchObject({ title: 'Ürün akışı 1', url: '/cariler/999999' });
    expect(sonuc.dropped).toEqual([
      {
        title: 'Ürün akışı 2',
        reason: 'URL is not in the map and no path pattern matched: /faturalar (pattern: /faturalar)',
      },
      {
        title: 'Ürün akışı 3',
        reason: 'URL is not in the map and no path pattern matched: /cariler/abc (pattern: /cariler/abc)',
      },
      {
        title: 'Ürün akışı 4',
        reason: 'URL is not in the map and no path pattern matched: mailto:destek@uygulama.test (no pattern could be derived)',
      },
    ]);
  });
});

describe('istem', () => {
  it('belgeyi 20 bin karakterde keser ve ipucunu ayrı başlıkta taşır', () => {
    const belge = 'a'.repeat(25_000);
    const istem = planKullaniciIstemiOlustur(harita, belge, 'Önce sepet akışına bak.');

    expect(istem).toContain(`## Project document\n${'a'.repeat(20_000)}…[truncated]`);
    expect(istem).toContain('## User hint\nÖnce sepet akışına bak.');
    expect(istem.length).toBeLessThanOrEqual(60_000);
  });

  it('değişmez İngilizce anahtarları JSON iskeleti ve örnekle açıklar', () => {
    expect(PLAN_SISTEM_ISTEMI).toContain('"title":"..."');
    expect(PLAN_SISTEM_ISTEMI).toContain('{"proposals":[{"title":"...","description":"...","priority":"p1"');
    expect(PLAN_SISTEM_ISTEMI).toContain('are English and fixed; do not translate them');
    expect(PLAN_SISTEM_ISTEMI).toContain('Full example:');
    expect(PLAN_SISTEM_ISTEMI).toContain(
      "Write names, descriptions and rationale in the language of the application's UI and docs;"
      + ' if mixed or unclear, use English.',
    );
    expect(PLAN_SISTEM_ISTEMI).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
  });
});

describe('istem: keşif derinliği alanları', () => {
  const secenekler = Array.from({ length: 20 }, (_d, sira) => `Seçenek ${sira + 1}`);
  const derinHarita: Harita = {
    baseUrl: 'http://uygulama.test',
    loggedIn: false,
    exploredAt: '2026-10-13T00:00:00.000Z',
    pages: [
      {
        url: 'http://uygulama.test/teklif', title: 'Teklif', headings: ['Teklif al'], links: [],
        forms: [{
          detached: true,
          fields: [
            { name: 'sehir', type: 'select', label: 'Şehir', options: secenekler, optionCount: 81 },
            { name: 'ad', type: 'text', label: 'Ad' },
          ],
        }],
        buttons: ['Gönder'], menu: [], disclosures: ['Fiyat dökümü', 'İptal koşulları'],
      },
      {
        url: 'http://uygulama.test/panel', title: 'GİZLİ-BAŞLIK', headings: ['GİZLİ-H1'], links: [],
        forms: [{ fields: [{ name: 'gizli-alan', type: 'text' }] }], buttons: ['GİZLİ-DÜĞME'], menu: [],
        requiresLogin: true, redirectedTo: 'http://uygulama.test/giris',
      },
    ],
  };
  const istem = planKullaniciIstemiOlustur(derinHarita, undefined);

  it('form dışı alanları "page-level fields" diye yazar', () => {
    expect(istem).toContain('page-level fields (outside any <form>): [sehir (select');
    expect(istem).not.toContain('form fields: page-level fields (outside any <form>): [ad');
  });

  it('select seçeneklerinin ilk 8\'ini ve toplam sayıyı yazar', () => {
    expect(istem).toContain('options: Seçenek 1 / Seçenek 2 / Seçenek 3 / Seçenek 4 / Seçenek 5 / Seçenek 6 / Seçenek 7 / Seçenek 8 … (81 options)');
    expect(istem).not.toContain('Seçenek 9');
  });

  it('disclosures satırını yazar', () => {
    expect(istem).toContain('disclosures: Fiyat dökümü | İptal koşulları');
  });

  it('giriş gerekli sayfayı tek satırda yazar, başlık ve alanları yazmaz', () => {
    expect(istem).toContain(
      'url: http://uygulama.test/panel\nlogin required (redirects to http://uygulama.test/giris); '
      + 'without a saved login propose only redirect checks here (loginRedirectCheck: true)',
    );
    expect(istem).not.toContain('GİZLİ');
    expect(istem).not.toContain('gizli-alan');
  });

  it('sistem istemi giriş gerekli sayfalarda requiresRealCredentials kuralını söyler', () => {
    expect(PLAN_SISTEM_ISTEMI).toContain('"login required"');
    expect(PLAN_SISTEM_ISTEMI).toContain('The requiresRealCredentials rule applies to them unchanged');
    expect(PLAN_SISTEM_ISTEMI).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
  });

  it('sahte beyinle plan üretimi bu haritada çalışır', async () => {
    const beyin = await sahteBeyin({ proposals: [taslak(1, 'http://uygulama.test/teklif')] });
    const sonuc = await planUret(beyin, derinHarita, undefined);
    expect(sonuc.proposals).toHaveLength(1);
  });

  it('giriş gerekli sayfaya yazılan öneriyi kayıtlı giriş yokken düşürür, kayıtlı girişte dokunmaz', async () => {
    const taslaklar = [taslak(1, 'http://uygulama.test/teklif'), taslak(2, 'http://uygulama.test/panel/?x=1#a')];
    const giriyok = await planUret(await sahteBeyin({ proposals: taslaklar }), derinHarita, undefined);
    expect(giriyok.proposals).toHaveLength(1);
    expect(giriyok.dropped).toEqual([{
      title: 'Ürün akışı 2',
      reason: `login required, no saved login: http://uygulama.test/panel/?x=1#a`,
    }]);
    const girisli = await planUret(
      await sahteBeyin({ proposals: taslaklar }), { ...derinHarita, loggedIn: true }, undefined,
    );
    expect(giriyok.nextStep).toBe(GIRIS_GEREKLI_SONRAKI_ADIM);
    expect(girisli.proposals).toHaveLength(2);
    expect(girisli).not.toHaveProperty('nextStep');
  });

  const yonlendirmeAdimlari = [
    { type: 'action', description: 'Oturum açmadan panel sayfasına git' },
    { type: 'assertion', description: 'Giriş sayfasına yönlendiğini doğrula' },
  ];
  const panelTaslagi = (sira: number, ek: Record<string, unknown>): Record<string, unknown> => ({
    ...taslak(sira, 'http://uygulama.test/panel'), steps: yonlendirmeAdimlari, ...ek,
  });

  it('kayıtlı giriş yokken loginRedirectCheck: true yönlendirme testi tutulur, beyan yerel öneriye taşınmaz', async () => {
    const sonuc = await planUret(
      await sahteBeyin({ proposals: [panelTaslagi(1, { loginRedirectCheck: true, requiresRealCredentials: false })] }),
      derinHarita, undefined,
    );
    expect(sonuc.dropped).toEqual([]);
    expect(sonuc.proposals).toHaveLength(1);
    expect(sonuc.proposals[0]!.url).toBe('http://uygulama.test/panel');
    expect(sonuc.proposals[0]).not.toHaveProperty('loginRedirectCheck');
    expect(sonuc.proposals[0]).not.toHaveProperty('requiresRealCredentials');
    expect(sonuc).not.toHaveProperty('nextStep');
  });

  it('kapıyı yalnız boolean true açar: "true" dizesi, 1, "TRUE" ve Türkçe eş adlar beyansız sayılıp düşer', async () => {
    const sonuc = await planUret(await sahteBeyin({ proposals: [
      taslak(9, 'http://uygulama.test/teklif'),
      panelTaslagi(1, { loginRedirectCheck: 'true' }),
      panelTaslagi(2, { girisYonlendirmeKontrolu: true }),
      panelTaslagi(3, { girisYonlendirmesiKontrolu: true }),
      panelTaslagi(4, { loginRedirectCheck: 1 }),
      panelTaslagi(5, { loginRedirectCheck: 'TRUE' }),
    ] }), derinHarita, undefined);
    expect(sonuc.proposals.map((o) => o.title)).toEqual(['Ürün akışı 9']);
    expect(sonuc.dropped.map((o) => o.reason)).toEqual(
      Array.from({ length: 5 }, () => 'login required, no saved login: http://uygulama.test/panel'),
    );
  });

  it('giriş gerekli sayfanın kalıbına uyan kayıt URL\'si de giriş gerekli sayılır (fail-closed)', async () => {
    const kalipHaritasi: Harita = {
      ...derinHarita,
      pages: [
        derinHarita.pages[0]!,
        { url: 'http://uygulama.test/siparis/36', title: '', headings: [], links: [], forms: [], buttons: [], menu: [],
          requiresLogin: true, redirectedTo: 'http://uygulama.test/giris' },
      ],
    };
    const icerik = { ...taslak(1, 'http://uygulama.test/siparis/999'), loginRedirectCheck: false };
    const yonlendirme = { ...taslak(2, '/siparis/999'), steps: yonlendirmeAdimlari, loginRedirectCheck: true };
    const sonuc = await planUret(await sahteBeyin({ proposals: [icerik, yonlendirme] }), kalipHaritasi, undefined);
    expect(sonuc.proposals.map((o) => o.title)).toEqual(['Ürün akışı 2']);
    expect(sonuc.dropped).toEqual([{
      title: 'Ürün akışı 1', reason: 'login required, no saved login: http://uygulama.test/siparis/999',
    }]);
    expect(sonuc.nextStep).toBe(GIRIS_GEREKLI_SONRAKI_ADIM);
  });

  it('proje kökeni dışındaki URL, yol haritada olsa ve loginRedirectCheck: true olsa da düşer', async () => {
    const sonuc = await planUret(await sahteBeyin({ proposals: [
      panelTaslagi(1, { loginRedirectCheck: true }),
      { ...panelTaslagi(2, { loginRedirectCheck: true }), url: 'https://evil.test/panel' },
      taslak(3, 'https://evil.test/teklif'),
      taslak(4, 'http://uygulama.test:8080/teklif'),
      taslak(5, '/teklif'),
    ] }), derinHarita, undefined);
    expect(sonuc.proposals.map((o) => o.title)).toEqual(['Ürün akışı 1', 'Ürün akışı 5']);
    expect(sonuc.dropped).toEqual([
      { title: 'Ürün akışı 2', reason: 'URL is outside the project origin: https://evil.test/panel' },
      { title: 'Ürün akışı 3', reason: 'URL is outside the project origin: https://evil.test/teklif' },
      { title: 'Ürün akışı 4', reason: 'URL is outside the project origin: http://uygulama.test:8080/teklif' },
    ]);
  });

  it('loginRedirectCheck: null beyansız sayılır ve kayıtlı giriş yokken düşer', async () => {
    const sonuc = await planUret(await sahteBeyin({ proposals: [
      taslak(1, 'http://uygulama.test/teklif'),
      panelTaslagi(2, { loginRedirectCheck: null }),
    ] }), derinHarita, undefined);
    expect(sonuc.proposals.map((o) => o.title)).toEqual(['Ürün akışı 1']);
    expect(sonuc.dropped).toEqual([{
      title: 'Ürün akışı 2',
      reason: `login required, no saved login: http://uygulama.test/panel`,
    }]);
  });

  it('hepsi düştüğünde hata mesajı düşme sebeplerini taşır, giriş ipucunu sonda bir kez yazar', async () => {
    const beyin = await sahteBeyin({ proposals: [
      panelTaslagi(1, { loginRedirectCheck: false }),
      panelTaslagi(2, {}),
      taslak(3, 'http://uygulama.test/yok'),
    ] });
    const hata = await planUret(beyin, derinHarita, undefined).then(() => null, (e: unknown) => e as Error);
    expect(hata?.message).toBe(
      'No usable proposal was produced; 3 dropped: '
      + 'Ürün akışı 1 (login required, no saved login: http://uygulama.test/panel), '
      + 'Ürün akışı 2 (login required, no saved login: http://uygulama.test/panel), '
      + `Ürün akışı 3 (URL is not in the map and no path pattern matched: http://uygulama.test/yok (pattern: /yok)). `
      + GIRIS_GEREKLI_SONRAKI_ADIM,
    );
    expect(hata?.message.split('kobay project create --login')).toHaveLength(2);
  });

  it('hepsi giriş dışı sebeple düştüğünde hata mesajında giriş ipucu yok', async () => {
    const beyin = await sahteBeyin({ proposals: [taslak(1, 'http://uygulama.test/yok')] });
    const hata = await planUret(beyin, derinHarita, undefined).then(() => null, (e: unknown) => e as Error);
    expect(hata?.message).toContain('1 dropped: Ürün akışı 1 (URL is not in the map');
    expect(hata?.message).not.toContain('kobay project create --login');
  });

  it('CLI plan generate başarılı yol: giriş ipucu metinde, uyarıda ve JSON nextStep alanında tam bir kez', async () => {
    const cwd = await geciciDizinAc('kobay-plan-cli-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } });
    await dizin.haritaYaz(derinHarita);
    const yanitlar = await geciciDizinAc('kobay-plan-cli-yanit-');
    const onceki = process.env.KOBAY_SAHTE_YANIT_DIZINI;
    process.env.KOBAY_SAHTE_YANIT_DIZINI = yanitlar;
    const ipucu = 'kobay project create --login';
    try {
      await yazAtomik(join(yanitlar, 'plan.json'), JSON.stringify({ proposals: [
        taslak(1, 'http://uygulama.test/teklif'),
        panelTaslagi(2, { loginRedirectCheck: false }),
        panelTaslagi(3, {}),
      ] }));
      const sonuc = await planGenerate({ cwd });
      expect(sonuc.exitCode).toBe(0);
      expect(sonuc.metin?.split(ipucu)).toHaveLength(2);
      expect(sonuc.metin?.trimEnd().split('\n').at(-1)).toBe(`next step\t${GIRIS_GEREKLI_SONRAKI_ADIM}`);
      expect(sonuc.mesaj?.split(ipucu)).toHaveLength(2);
      const govde = sonuc.json as { dropped: Array<{ reason: string }>; nextStep?: string };
      expect(govde.nextStep).toBe(GIRIS_GEREKLI_SONRAKI_ADIM);
      expect(govde.dropped.map((o) => o.reason)).toEqual([
        'login required, no saved login: http://uygulama.test/panel',
        'login required, no saved login: http://uygulama.test/panel',
      ]);

      await yazAtomik(join(yanitlar, 'plan.json'), JSON.stringify({ proposals: [
        taslak(1, 'http://uygulama.test/teklif'), taslak(2, 'http://uygulama.test/yok'),
      ] }));
      const ipucusuz = await planGenerate({ cwd });
      expect(ipucusuz.exitCode).toBe(0);
      expect(ipucusuz.json).not.toHaveProperty('nextStep');
      expect(ipucusuz.metin).not.toContain(ipucu);
      expect(ipucusuz.metin).not.toContain('next step');
    } finally {
      if (onceki === undefined) delete process.env.KOBAY_SAHTE_YANIT_DIZINI;
      else process.env.KOBAY_SAHTE_YANIT_DIZINI = onceki;
    }
  });

  it('CLI plan generate: hepsi düştüğünde metin ve JSON hata çıktısında project create --login ipucu görünür', async () => {
    const cwd = await geciciDizinAc('kobay-plan-cli-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', brain: { adaptor: 'sahte' } });
    await dizin.haritaYaz(derinHarita);
    const yanitlar = await geciciDizinAc('kobay-plan-cli-yanit-');
    await yazAtomik(join(yanitlar, 'plan.json'), JSON.stringify({
      proposals: [panelTaslagi(1, { loginRedirectCheck: false })],
    }));
    const onceki = process.env.KOBAY_SAHTE_YANIT_DIZINI;
    process.env.KOBAY_SAHTE_YANIT_DIZINI = yanitlar;
    try {
      const sonuc = await planGenerate({ cwd });
      expect(sonuc.exitCode).toBe(4);
      expect(sonuc.mesaj?.split('kobay project create --login')).toHaveLength(2);
      // Gerçek CLI, --output json: zarf { ok: false, exitCode: 4, error: { message } }, çıkış kodu 4.
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let yazilan = '';
      stdout.setEncoding('utf8');
      stdout.on('data', (parca: string) => { yazilan += parca; });
      const kod = await main(['node', 'kobay', '--cwd', cwd, '--output', 'json', 'test', 'plan', 'generate'], {
        input: Readable.from([]), stdout, stderr,
      });
      expect(kod).toBe(4);
      const zarf = JSON.parse(yazilan.trim()) as { ok: boolean; exitCode: number; error: { message: string } };
      expect(zarf.ok).toBe(false);
      expect(zarf.exitCode).toBe(4);
      expect(zarf.error.message).toBe(
        'No usable proposal was produced; 1 dropped: Ürün akışı 1 (login required, no saved login: '
        + `http://uygulama.test/panel). ${GIRIS_GEREKLI_SONRAKI_ADIM}`,
      );
      expect(zarf.error.message.split('kobay project create --login')).toHaveLength(2);
    } finally {
      if (onceki === undefined) delete process.env.KOBAY_SAHTE_YANIT_DIZINI;
      else process.env.KOBAY_SAHTE_YANIT_DIZINI = onceki;
    }
  });

  it('kayıtlı giriş yokken içerik testi (loginRedirectCheck: false) ve beyansız eski yanıt düşer, sonraki adımı söyler', async () => {
    const icerik = {
      ...taslak(1, 'http://uygulama.test/panel'),
      steps: [
        { type: 'action', description: 'Panel sayfasını aç' },
        { type: 'assertion', description: 'Hesap özetinin göründüğünü doğrula' },
      ],
      loginRedirectCheck: false,
    };
    const eski = panelTaslagi(2, {});
    const sonuc = await planUret(
      await sahteBeyin({ proposals: [taslak(3, 'http://uygulama.test/teklif'), icerik, eski] }), derinHarita, undefined,
    );
    expect(sonuc.proposals.map((o) => o.title)).toEqual(['Ürün akışı 3']);
    const sebep = `login required, no saved login: http://uygulama.test/panel`;
    expect(sonuc.dropped).toEqual([
      { title: 'Ürün akışı 1', reason: sebep },
      { title: 'Ürün akışı 2', reason: sebep },
    ]);
    expect(sonuc.nextStep).toBe(GIRIS_GEREKLI_SONRAKI_ADIM);
    expect(sonuc.nextStep).toContain('kobay project create --login');
    expect(sonuc.nextStep).toContain('kobay project update --login');
  });

  it('gerçek kimlik isteyen yönlendirme testi kayıtlı giriş yokken düşer', async () => {
    const sonuc = await planUret(await sahteBeyin({ proposals: [
      taslak(1, 'http://uygulama.test/teklif'),
      panelTaslagi(2, { loginRedirectCheck: true, requiresRealCredentials: true }),
    ] }), derinHarita, undefined);
    expect(sonuc.proposals).toHaveLength(1);
    expect(sonuc.dropped).toEqual([{
      title: 'Ürün akışı 2',
      reason: 'login required, no saved login: the redirect check declares requiresRealCredentials: true: '
        + `http://uygulama.test/panel`,
    }]);
  });

  it('kayıtlı girişte loginRedirectCheck kararı etkilemez', async () => {
    const sonuc = await planUret(await sahteBeyin({ proposals: [
      panelTaslagi(1, { loginRedirectCheck: false }),
      panelTaslagi(2, { loginRedirectCheck: true }),
    ] }), { ...derinHarita, loggedIn: true }, undefined);
    expect(sonuc.proposals).toHaveLength(2);
  });

  it('sistem istemi yönlendirme testini loginRedirectCheck ile işaretlemeyi söyler', () => {
    expect(PLAN_SISTEM_ISTEMI).toContain('the only tests allowed on such a page are redirect checks');
    expect(PLAN_SISTEM_ISTEMI).toContain('Every proposal must carry loginRedirectCheck as a boolean');
    expect(PLAN_SISTEM_ISTEMI).toContain('"loginRedirectCheck":false}]}');
  });

  it('yenileme sistem istemi seçenek metinlerini ve disclosure başlıklarını yeniden adlandırılabilir sayar', () => {
    expect(PLAN_YENILEME_SISTEM_ISTEMI).toContain('select option texts or disclosure titles');
  });

  it('yenileme istemi aynı yardımcıları kullanır (select seçenekleri ve disclosures gelir)', () => {
    const sayfa = derinHarita.pages[0]!;
    const yenileme = planYenilemeKullaniciIstemiOlustur({
      test: { name: 'Teklif al', planSteps: [{ type: 'action', description: 'Aç' }] },
      yeniSayfa: sayfa,
    });
    expect(yenileme).toContain('page-level fields');
    expect(yenileme).toContain('(81 options)');
    expect(yenileme).toContain('disclosures: Fiyat dökümü');
  });
});

describe('test kaydı dönüşümü', () => {
  const oneri: Oneri = { ...taslak(1, '/urunler') as Omit<Oneri, 'proposalId'>, proposalId: 'p_abc123' };

  it('öneriyi plan kaynaklı taslak teste dönüştürür', () => {
    const test = oneriyiTesteCevir(oneri);

    expect(test).toMatchObject({
      name: oneri.title, type: 'frontend', createdFrom: 'plan', status: 'draft', planSteps: oneri.steps,
      priority: oneri.priority, url: oneri.url, codeVersion: 0,
    });
    expect(test.id).toMatch(/^t_[a-z0-9]{8}$/);
    expect(test.createdAt).toBe(test.updatedAt);
    expect(new Date(test.createdAt).toISOString()).toBe(test.createdAt);
  });

  it('geçerli elle plan dosyasını CLI kaynaklı taslak teste dönüştürür', () => {
    const test = planDosyasindanTest({
      projectId: 'proje-1', type: 'frontend', name: 'Giriş yapılır', priority: 'p0',
      planSteps: [{ type: 'action', description: 'Giriş sayfasını aç' }],
    });

    expect(test).toMatchObject({ name: 'Giriş yapılır', createdFrom: 'cli', priority: 'p0', status: 'draft' });
  });

  it('elle plan dosyasındaki url alanını test kaydına taşır, yoksa alan hiç eklenmez', () => {
    const adimlar = [{ type: 'action', description: 'Kayıtlar sayfasını aç' }];
    expect(planDosyasindanTest({ type: 'frontend', name: 'Kayıt listesi', url: '/records', planSteps: adimlar }).url)
      .toBe('/records');
    expect('url' in planDosyasindanTest({ type: 'frontend', name: 'Kayıt listesi', planSteps: adimlar })).toBe(false);
  });

  it('geçersiz öncelikte hangi alanın neden yanlış olduğunu söyler', () => {
    expect(() => planDosyasindanTest({
      projectId: 'proje-1', type: 'frontend', name: 'Giriş yapılır', priority: 'p9',
      planSteps: [{ type: 'action', description: 'Giriş sayfasını aç' }],
    })).toThrow(SchemaError);
    expect(() => planDosyasindanTest({
      projectId: 'proje-1', type: 'frontend', name: 'Giriş yapılır', priority: 'p9',
      planSteps: [{ type: 'action', description: 'Giriş sayfasını aç' }],
    })).toThrow(/priority: .*Expected/);
  });
});

describe('slug yol kalıbı (plan)', () => {
  const harita: Harita = {
    baseUrl: 'http://uygulama.test',
    loggedIn: false,
    exploredAt: '2026-10-12T00:00:00.000Z',
    pages: [
      { ...bosSayfa('http://uygulama.test/', 'Ana'), links: ['/iletisim'] },
      {
        ...bosSayfa('http://uygulama.test/sehir/istanbul', 'Istanbul'),
        links: ['/sehir/ankara', '/sehir/izmir', '/sehir/bursa', '/sehir/adana', '/sehir/konya'],
      },
      bosSayfa('http://uygulama.test/sehir/ankara', 'Ankara'),
    ],
  };

  it('haritada 2 sayfa + bağlantılarda >=5 şehir varken olmayan şehir kalıpla kabul edilir', () => {
    expect(oneriUrlKarari('/sehir/olmayan-sehir-xyz', harita))
      .toEqual({ kabul: true, tur: 'kalip', kalip: '/sehir/:slug' });
  });

  it('tamamen yeni yol yine düşer; kök sayfa kalıbı genişlemez', () => {
    expect(oneriUrlKarari('/faturalar', harita).kabul).toBe(false);
    expect(oneriUrlKarari('/hakkimizda', harita).kabul).toBe(false);
  });

  it('bağlantılar olmadan (eşik altı) şehir kalıbı oluşmaz', () => {
    const dar: Harita = { ...harita, pages: harita.pages.map((s) => ({ ...s, links: [] })) };
    expect(oneriUrlKarari('/sehir/olmayan-sehir-xyz', dar).kabul).toBe(false);
  });
});
