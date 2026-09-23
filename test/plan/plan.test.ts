import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { beyinOlustur } from '../../src/beyin/index.js';
import { SemaHatasi, yazAtomik, type Harita, type Oneri } from '../../src/depo/index.js';
import {
  PLAN_SISTEM_ISTEMI,
  haritaYolKaliplari,
  oneriUrlKarari,
  oneriyiTesteCevir,
  planDosyasindanTest,
  planKullaniciIstemiOlustur,
  planUret,
  yolKalibi,
} from '../../src/plan/index.js';

const harita: Harita = {
  baseUrl: 'http://uygulama.test',
  girisYapildi: true,
  kesifTarihi: '2026-09-17T00:00:00.000Z',
  sayfalar: [
    {
      url: 'http://uygulama.test/giris/', baslik: 'Giriş', basliklar: ['Giriş yap'], linkler: [],
      formlar: [{ alanlar: [{ ad: 'e-posta', tip: 'email', etiket: 'E-posta' }] }],
      dugmeler: ['Giriş yap'], menu: [],
    },
    {
      url: 'http://uygulama.test/urunler', baslik: 'Ürünler', basliklar: ['Ürün listesi'], linkler: [],
      formlar: [], dugmeler: ['Sepete ekle'], menu: ['Ürünler'],
    },
  ],
};

function taslak(sira: number, url = 'https://farkli-origin.test/urunler/'): Record<string, unknown> {
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
  const dizin = await mkdtemp(join(tmpdir(), 'kobay-plan-'));
  await yazAtomik(join(dizin, 'plan.json'), JSON.stringify(icerik));
  return beyinOlustur({ adaptor: 'sahte' }, { KOBAY_SAHTE_YANIT_DIZINI: dizin });
}

describe('planUret', () => {
  it('sahte beynin 12 önerisine yerel proposalId atar', async () => {
    const beyin = await sahteBeyin({ oneriler: Array.from({ length: 12 }, (_deger, sira) => taslak(sira + 1)) });

    const sonuc = await planUret(beyin, harita, undefined);

    expect(sonuc.dusurulen).toEqual([]);
    expect(sonuc.oneriler).toHaveLength(12);
    expect(sonuc.oneriler.map((oneri) => oneri.proposalId)).toEqual(
      expect.arrayContaining(Array.from({ length: 12 }, () => expect.stringMatching(/^p_[a-z0-9]{6}$/))),
    );
  });

  it('haritada olmayan URL içeren önerileri sebebiyle düşürür', async () => {
    const beyin = await sahteBeyin({ oneriler: [
      taslak(1),
      taslak(2, 'https://farkli-origin.test/yonetim'),
      taslak(3, 'https://farkli-origin.test/eksik/'),
    ] });

    const sonuc = await planUret(beyin, harita, undefined);

    expect(sonuc.oneriler).toHaveLength(1);
    expect(sonuc.dusurulen).toEqual([
      {
        title: 'Ürün akışı 2',
        sebep: 'URL haritada yok ve yol kalıbı eşleşmedi: https://farkli-origin.test/yonetim (kalıp: /yonetim)',
      },
      {
        title: 'Ürün akışı 3',
        sebep: 'URL haritada yok ve yol kalıbı eşleşmedi: https://farkli-origin.test/eksik/ (kalıp: /eksik)',
      },
    ]);
  });

  it('boş veya sınır dışı sayıdaki adımı düşürür', async () => {
    const bosAdimli = { ...taslak(2), steps: [] };
    const cokAdimli = {
      ...taslak(3),
      steps: Array.from({ length: 201 }, () => ({ type: 'action', description: 'Bir adım uygula' })),
    };
    const beyin = await sahteBeyin({ oneriler: [taslak(1), bosAdimli, cokAdimli] });

    const sonuc = await planUret(beyin, harita, undefined);

    expect(sonuc.oneriler).toHaveLength(1);
    expect(sonuc.dusurulen).toEqual([
      { title: 'Ürün akışı 2', sebep: 'Adım sayısı 1–200 aralığında değil: 0' },
      { title: 'Ürün akışı 3', sebep: 'Adım sayısı 1–200 aralığında değil: 201' },
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
    const beyin = await sahteBeyin({ oneriler: [turkceTaslak] });

    const sonuc = await planUret(beyin, harita, undefined);

    expect(sonuc.oneriler).toHaveLength(1);
    expect(sonuc.oneriler[0]).toMatchObject({
      title: 'Ürün akışı 1', description: 'Kullanıcı ürünleri görür.', steps: expect.arrayContaining([
        { type: 'action', description: 'Ürünler sayfasını aç' },
      ]),
    });
  });
});

function bosSayfa(url: string, baslik: string) {
  return { url, baslik, basliklar: [baslik], linkler: [], formlar: [], dugmeler: [], menu: [] };
}

/** `/cariler/1`…`/cariler/36` kayıt sayfalarını içeren gerçekçi harita. */
const kayitHaritasi: Harita = {
  baseUrl: 'http://uygulama.test',
  girisYapildi: true,
  kesifTarihi: '2026-09-18T00:00:00.000Z',
  sayfalar: [
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
    const beyin = await sahteBeyin({ oneriler: [
      taslak(1, '/cariler/999999'),
      taslak(2, '/faturalar'),
      taslak(3, '/cariler/abc'),
      taslak(4, 'mailto:destek@uygulama.test'),
    ] });

    const sonuc = await planUret(beyin, kayitHaritasi, undefined);

    expect(sonuc.oneriler).toHaveLength(1);
    expect(sonuc.oneriler[0]).toMatchObject({ title: 'Ürün akışı 1', url: '/cariler/999999' });
    expect(sonuc.dusurulen).toEqual([
      {
        title: 'Ürün akışı 2',
        sebep: 'URL haritada yok ve yol kalıbı eşleşmedi: /faturalar (kalıp: /faturalar)',
      },
      {
        title: 'Ürün akışı 3',
        sebep: 'URL haritada yok ve yol kalıbı eşleşmedi: /cariler/abc (kalıp: /cariler/abc)',
      },
      {
        title: 'Ürün akışı 4',
        sebep: 'URL haritada yok ve yol kalıbı eşleşmedi: mailto:destek@uygulama.test (kalıp çıkarılamadı)',
      },
    ]);
  });
});

describe('istem', () => {
  it('belgeyi 20 bin karakterde keser ve ipucunu ayrı başlıkta taşır', () => {
    const belge = 'a'.repeat(25_000);
    const istem = planKullaniciIstemiOlustur(harita, belge, 'Önce sepet akışına bak.');

    expect(istem).toContain(`## Proje belgesi\n${'a'.repeat(20_000)}…[kesildi]`);
    expect(istem).toContain('## Kullanıcı ipucu\nÖnce sepet akışına bak.');
    expect(istem.length).toBeLessThanOrEqual(60_000);
  });

  it('değişmez İngilizce anahtarları JSON iskeleti ve örnekle açıklar', () => {
    expect(PLAN_SISTEM_ISTEMI).toContain('"title":"..."');
    expect(PLAN_SISTEM_ISTEMI).toContain('anahtarları İngilizce ve değişmezdir');
    expect(PLAN_SISTEM_ISTEMI).toContain('Tam örnek:');
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

  it('geçersiz öncelikte hangi alanın neden yanlış olduğunu söyler', () => {
    expect(() => planDosyasindanTest({
      projectId: 'proje-1', type: 'frontend', name: 'Giriş yapılır', priority: 'p9',
      planSteps: [{ type: 'action', description: 'Giriş sayfasını aç' }],
    })).toThrow(SemaHatasi);
    expect(() => planDosyasindanTest({
      projectId: 'proje-1', type: 'frontend', name: 'Giriş yapılır', priority: 'p9',
      planSteps: [{ type: 'action', description: 'Giriş sayfasını aç' }],
    })).toThrow(/priority: .*Expected/);
  });
});
