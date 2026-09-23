import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';

const atomikDurum = vi.hoisted(() => ({
  renameDussun: false,
  /** Belirli bir `rename` çağrısını düşürmek için; `true` dönerse o çağrı hata verir. */
  renameKosulu: undefined as ((eski: string, yeni: string) => boolean) | undefined,
  /** Düşen `rename` çağrısının hata kodu; verilmezse kodsuz hata fırlatılır. */
  renameKodu: undefined as string | undefined,
  /** Belirli bir `rm` çağrısını düşürmek için; `true` dönerse o çağrı EBUSY verir. */
  rmKosulu: undefined as ((yol: string) => boolean) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const asil = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...asil,
    rename: async (eski: string, yeni: string) => {
      if (atomikDurum.renameDussun || atomikDurum.renameKosulu?.(eski, yeni) === true) {
        const hata = new Error('yeniden adlandırma simülasyonu');
        throw atomikDurum.renameKodu === undefined
          ? hata
          : Object.assign(hata, { code: atomikDurum.renameKodu });
      }
      await asil.rename(eski, yeni);
    },
    rm: async (yol: Parameters<typeof asil.rm>[0], secenekler?: Parameters<typeof asil.rm>[1]) => {
      if (atomikDurum.rmKosulu?.(String(yol)) === true) {
        throw Object.assign(new Error('silme simülasyonu'), { code: 'EBUSY' });
      }
      await asil.rm(yol, secenekler);
    },
  };
});

import {
  DosyaYok,
  GecersizKimlik,
  SAKLANAN_KOSU,
  hataPaketiCikisYolu,
  HataAnaliziSemasi,
  HataPaketiSemasi,
  HaritaSemasi,
  KimlikGeriAlinamadi,
  KimlikIslemiYurumede,
  KimlikSemasi,
  KobayConfigSemasi,
  KobayDizini,
  KosuSonucuSemasi,
  OneriSemasi,
  PaketYarim,
  PlanDosyasiSemasi,
  SemaHatasi,
  TestKaydiSemasi,
  jsonOku,
  yazAtomik,
  type HataPaketi,
  type KobayConfig,
  type TestKaydi,
} from '../../src/depo/index.js';

async function geciciDizin(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kobay-depo-'));
}

afterEach(() => {
  atomikDurum.renameDussun = false;
  atomikDurum.renameKosulu = undefined;
  atomikDurum.renameKodu = undefined;
  atomikDurum.rmKosulu = undefined;
});

const config: KobayConfig = {
  baseUrl: 'http://localhost:3000',
  beyin: { adaptor: 'sahte' },
};

const yonetilenGitignore = `# >>> kobay managed >>>
credentials.json
runs/
storageState.json
.eski-*
.kimlik-islemi*
*.log
failure/
failure-out/
logs/
tests/_fixture.ts
test-results/
playwright-report/
blob-report/
# <<< kobay managed <<<
`;

/** Ardışık `adet` koşu sonucu yazar; kimlikleri eskiden yeniye sıralı döner. */
async function kosuYaz(dizin: KobayDizini, testId: string, adet: number): Promise<string[]> {
  const runIdler: string[] = [];
  for (let sira = 0; sira < adet; sira += 1) {
    // Son ek testId'den gelir: iki testin koşu kimlikleri çakışmasın.
    const runId = `r_2026091701${String(sira).padStart(4, '0')}_${testId.slice(2, 6)}`;
    await dizin.kosuSonucuYaz({
      testId,
      runId,
      status: 'failed',
      verdict: 'failed',
      startedAt: `2026-09-17T00:00:${String(sira).padStart(2, '0')}.000Z`,
      finishedAt: `2026-09-17T00:00:${String(sira).padStart(2, '0')}.500Z`,
      codeVersion: 1,
    });
    runIdler.push(runId);
  }
  return runIdler;
}

function paket(): HataPaketi {
  return {
    snapshotId: 's_1',
    testId: 't_abc12345',
    runId: 'r_20260917010101_abcd',
    result: {
      testId: 't_abc12345',
      runId: 'r_20260917010101_abcd',
      status: 'failed',
      verdict: 'failed',
      startedAt: '2026-09-17T00:00:00.000Z',
      finishedAt: '2026-09-17T00:00:01.000Z',
      codeVersion: 1,
    },
    steps: [{ stepIndex: 0, description: 'Giriş yap', status: 'failed', durationMs: 10 }],
    code: 'test("giriş", async () => {});',
    failure: {
      rootCauseHypothesis: 'Buton görünmüyor',
      failureKind: 'test_bug',
      recommendedFixTarget: { kind: 'selector', reference: 'login', rationale: 'Rol değişti' },
      evidence: [],
    },
  };
}

describe('dosya', () => {
  it('rename öncesi hata olursa eski içeriği korur', async () => {
    const dizin = await geciciDizin();
    const yol = join(dizin, 'veri.txt');
    await writeFile(yol, 'eski');

    atomikDurum.renameDussun = true;
    await expect(yazAtomik(yol, 'yeni')).rejects.toThrow('yeniden adlandırma simülasyonu');
    await expect(readFile(yol, 'utf8')).resolves.toBe('eski');
  });

  it('olmayan JSON için DosyaYok, geçersiz JSON için SemaHatasi fırlatır', async () => {
    const dizin = await geciciDizin();
    await expect(jsonOku(join(dizin, 'yok.json'), KimlikSemasi)).rejects.toBeInstanceOf(DosyaYok);
    const yol = join(dizin, 'bozuk.json');
    await writeFile(yol, '{');
    await expect(jsonOku(yol, KimlikSemasi)).rejects.toBeInstanceOf(SemaHatasi);
  });
});

describe('şemalar', () => {
  it.each([
    ['Harita', HaritaSemasi, { baseUrl: 4 }],
    ['Öneri', OneriSemasi, { proposalId: 'p' }],
    ['TestKaydi', TestKaydiSemasi, { id: 't' }],
    ['KosuSonucu', KosuSonucuSemasi, { testId: 't' }],
    ['HataAnalizi', HataAnaliziSemasi, { failureKind: 'yanlış' }],
    ['HataPaketi', HataPaketiSemasi, { snapshotId: 's' }],
    ['KobayConfig', KobayConfigSemasi, { baseUrl: 3, beyin: {} }],
    ['Kimlik', KimlikSemasi, { kullanici: 'a' }],
    ['PlanDosyasi', PlanDosyasiSemasi, { projectId: ' ', type: 'frontend', name: 'x', planSteps: [] }],
  ])('%s geçersiz örneği reddeder', (_ad, sema, gecersiz) => {
    expect(v.safeParse(sema, gecersiz).success).toBe(false);
  });
});

describe('KobayDizini', () => {
  it('gitignore, credentials ve storage state izinlerini yazar', async () => {
    const proje = await geciciDizin();
    const dizin = await KobayDizini.ac(proje, config);
    await dizin.kimlikYaz({ kullanici: 'demo', parola: 'gizli' });
    await dizin.storageStateYaz('{"cookies":[]}');

    await expect(readFile(dizin.yol('.gitignore'), 'utf8')).resolves.toBe(
      yonetilenGitignore,
    );
    expect(((await stat(dizin.yol('credentials.json'))).mode & 0o777)).toBe(0o600);
    expect(((await stat(dizin.storageStateYolu())).mode & 0o777)).toBe(0o600);
  });

  it('var olan gitignore satırlarını korur ve yalnız eksik korumaları ekler', async () => {
    const proje = await geciciDizin();
    const gitignoreYolu = join(proje, '.kobay', '.gitignore');
    await mkdir(join(proje, '.kobay'), { recursive: true });
    await writeFile(gitignoreYolu, 'kullanici-notu\nruns/');

    await KobayDizini.ac(proje, config);

    await expect(readFile(gitignoreYolu, 'utf8')).resolves.toBe(
      `${yonetilenGitignore}kullanici-notu\n`,
    );
  });

  it('gitignore yönetilen bloğunu kullanıcı istisnalarından önce tutup eski düz biçimi taşır', async () => {
    const proje = await geciciDizin();
    const gitignoreYolu = join(proje, '.kobay', '.gitignore');
    await mkdir(join(proje, '.kobay'), { recursive: true });
    await writeFile(gitignoreYolu, 'failure/\nkullanici/*\n!failure/README.md\n!kullanici/ornek.txt\n');

    await KobayDizini.ac(proje, config);
    await KobayDizini.ac(proje, config);

    await expect(readFile(gitignoreYolu, 'utf8')).resolves.toBe(
      `${yonetilenGitignore}kullanici/*\n!failure/README.md\n!kullanici/ornek.txt\n`,
    );
  });

  it('eski biçim gitignore\'a (blok işaretsiz) açılışta yönetilen blok eklenir, kullanıcı satırı korunur', async () => {
    const proje = await geciciDizin();
    const gitignoreYolu = join(proje, '.kobay', '.gitignore');
    await mkdir(join(proje, '.kobay'), { recursive: true });
    // 17 Eyl'de yaratılmış bir projenin gerçek içeriği + kullanıcının kendi satırı.
    await writeFile(gitignoreYolu, 'credentials.json\nruns/\nstorageState.json\n*.log\nkullanici-notu.txt\n');

    const dizin = await KobayDizini.bul(join(proje, 'a', 'b'));

    expect(dizin?.kok).toBe(join(proje, '.kobay'));
    const icerik = await readFile(gitignoreYolu, 'utf8');
    expect(icerik).toBe(`${yonetilenGitignore}kullanici-notu.txt\n`);
    expect(icerik).toContain('failure-out/');
    expect(icerik).toContain('tests/_fixture.ts');
  });

  it('yönetilen blok tamsa .gitignore yeniden yazılmaz', async () => {
    const proje = await geciciDizin();
    await KobayDizini.ac(proje, config);
    const gitignoreYolu = join(proje, '.kobay', '.gitignore');
    const once = await stat(gitignoreYolu);

    await KobayDizini.bul(proje);
    await KobayDizini.bul(proje);

    const sonra = await stat(gitignoreYolu);
    expect(sonra.mtimeMs).toBe(once.mtimeMs);
    expect(sonra.ino).toBe(once.ino);
    await expect(readFile(gitignoreYolu, 'utf8')).resolves.toBe(yonetilenGitignore);
  });

  it('eski gitignore bloğundaki son-liste.json satırı ilk komutta düşer', async () => {
    const proje = await geciciDizin();
    await KobayDizini.ac(proje, config);
    const gitignoreYolu = join(proje, '.kobay', '.gitignore');
    // Eski sürümün yazdığı blok: içinde artık üretilmeyen son-liste.json var.
    await writeFile(gitignoreYolu, yonetilenGitignore.replace('logs/\n', 'logs/\nson-liste.json\n'));

    await KobayDizini.bul(proje);

    await expect(readFile(gitignoreYolu, 'utf8')).resolves.toBe(yonetilenGitignore);
  });

  it('bayat .kobay/son-liste.json ilk komutta silinir, komşu dosyalara dokunulmaz', async () => {
    const proje = await geciciDizin();
    await KobayDizini.ac(proje, config);
    const bayat = join(proje, '.kobay', 'son-liste.json');
    const komsu = join(proje, '.kobay', 'playwright.config.ts');
    await writeFile(bayat, '{"config":{"rootDir":"/Users/biri/node_modules"}}\n');
    await writeFile(komsu, 'export default {};\n');

    await KobayDizini.bul(proje);

    await expect(access(bayat)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(komsu, 'utf8')).resolves.toBe('export default {};\n');
  });

  it('son-liste.json bir dizinse silinmez', async () => {
    const proje = await geciciDizin();
    await KobayDizini.ac(proje, config);
    const yol = join(proje, '.kobay', 'son-liste.json');
    await mkdir(yol, { recursive: true });

    await expect(KobayDizini.bul(proje)).resolves.not.toBeNull();
    await expect(access(yol)).resolves.toBeUndefined();
  });

  it('gitignore yazılamayan dizinde komut düşmez, uyarı verir', async () => {
    if (process.getuid?.() === 0) return;
    const proje = await geciciDizin();
    const kobayDizini = join(proje, '.kobay');
    await mkdir(kobayDizini, { recursive: true });
    await writeFile(join(kobayDizini, '.gitignore'), 'credentials.json\n');
    await chmod(kobayDizini, 0o500);
    const uyarilar: string[] = [];
    const casus = vi.spyOn(process.stderr, 'write').mockImplementation((parca: unknown) => {
      uyarilar.push(String(parca));
      return true;
    });

    try {
      const dizin = await KobayDizini.bul(proje);
      expect(dizin?.kok).toBe(kobayDizini);
    } finally {
      casus.mockRestore();
      await chmod(kobayDizini, 0o700);
    }

    expect(uyarilar.join('')).toContain('.gitignore');
    await expect(readFile(join(kobayDizini, '.gitignore'), 'utf8')).resolves.toBe('credentials.json\n');
  });

  it('üst dizinlerde .kobay bulur; bulunmuyorsa null döner', async () => {
    const proje = await geciciDizin();
    await KobayDizini.ac(proje, config);
    const alt = join(proje, 'a', 'b');
    const bulundu = await KobayDizini.bul(alt);
    expect(bulundu?.kok).toBe(join(proje, '.kobay'));

    const baska = await geciciDizin();
    await expect(KobayDizini.bul(baska)).resolves.toBeNull();
  });

  it('boş test dizinini boş liste olarak döner', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await expect(dizin.testListele()).resolves.toEqual([]);
  });

  it('.partial işaretli hata paketini reddeder', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await yazAtomik(dizin.yol('failure', 't_yarim000', '.partial'), '');
    await expect(dizin.hataPaketiOku('t_yarim000')).rejects.toBeInstanceOf(PaketYarim);
  });

  it('hata paketinde meta.json dosyasını en son tamamlar ve geri okur', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const yazilan = await dizin.hataPaketiYaz(paket(), []);
    await expect(readFile(join(yazilan, 'meta.json'), 'utf8')).resolves.toContain('"yazildi"');
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
  });

  it('yol geçişi içeren kimlikleri okuma, yazma ve silmede reddeder', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const oncekiConfig = await readFile(dizin.yol('config.json'), 'utf8');

    expect(() => dizin.testOku('../config')).toThrow(GecersizKimlik);
    await expect(dizin.testYaz({ id: '../config' } as TestKaydi)).rejects.toBeInstanceOf(GecersizKimlik);
    await expect(dizin.testSil('../config')).rejects.toBeInstanceOf(GecersizKimlik);

    await expect(readFile(dizin.yol('config.json'), 'utf8')).resolves.toBe(oncekiConfig);
  });

  it('diğer test ve koşu kimliği girişlerinde yol geçişini reddeder', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const sonuc = paket().result;

    expect(() => dizin.kodYolu('../config')).toThrow(GecersizKimlik);
    await expect(dizin.kodOku('../config')).rejects.toBeInstanceOf(GecersizKimlik);
    await expect(dizin.kodYaz('../config', 'x')).rejects.toBeInstanceOf(GecersizKimlik);
    await expect(dizin.kosuDizini('../config')).rejects.toBeInstanceOf(GecersizKimlik);
    expect(() => dizin.kosuSonucuOku('../config')).toThrow(GecersizKimlik);
    await expect(dizin.kosuListele('../config')).rejects.toBeInstanceOf(GecersizKimlik);
    await expect(dizin.kosuSonucuYaz({ ...sonuc, runId: '../config' })).rejects.toBeInstanceOf(GecersizKimlik);
    await expect(dizin.hataPaketiYaz({ ...paket(), testId: '../config' }, [])).rejects.toBeInstanceOf(GecersizKimlik);
    await expect(dizin.hataPaketiOku('../config')).rejects.toBeInstanceOf(GecersizKimlik);
    await expect(dizin.hataPaketiKopyala('../config', join(await geciciDizin(), 'kopya'))).rejects.toBeInstanceOf(GecersizKimlik);
  });

  it('eşzamanlı hata paketi yazımlarından birini eksiksiz yayımlar', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const ilk = paket();
    const ikinci = { ...paket(), snapshotId: 's_2', code: 'test("ikinci", async () => {});' };

    await Promise.all([dizin.hataPaketiYaz(ilk, []), dizin.hataPaketiYaz(ikinci, [])]);

    const yayimlanan = await dizin.hataPaketiOku('t_abc12345');
    expect([ilk, ikinci]).toContainEqual(yayimlanan);
    expect(yayimlanan.code).toBe(yayimlanan.snapshotId === 's_1' ? ilk.code : ikinci.code);
  });

  it('yarıda kesilen hata paketi yazımı yayımlanmış paketi değiştirmez', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const ilk = paket();
    await dizin.hataPaketiYaz(ilk, []);

    await expect(dizin.hataPaketiYaz(
      { ...paket(), snapshotId: 's_2' },
      [{ kaynak: dizin.yol('failure'), hedefAd: 'ek.txt' }],
    )).rejects.toThrow();

    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(ilk);
  });

  it('bul, git ile gelmeyen çalışma dizinlerini geri açar', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    // Klonlanmış proje: .gitignore bu dizinleri dışladığı için repoda yoklar.
    for (const ad of ['runs', 'failure', 'failure-out', 'logs', 'plan', 'tests']) {
      await rm(dizin.yol(ad), { recursive: true, force: true });
    }

    const bulunan = await KobayDizini.bul(join(kok, 'alt', 'daha-alt'));
    expect(bulunan?.projeKoku).toBe(dizin.projeKoku);
    for (const ad of ['runs', 'failure', 'failure-out', 'logs', 'plan', 'tests']) {
      expect((await stat(dizin.yol(ad))).isDirectory(), ad).toBe(true);
    }
  });

  it('failure/ silinmişse hata paketi yazımı üst dizini kendisi açar', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await rm(dizin.yol('failure'), { recursive: true, force: true });

    const yazilan = await dizin.hataPaketiYaz(paket(), []);

    expect(yazilan).toBe(dizin.yol('failure', 't_abc12345'));
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
  });

  it('varsayılan çıkış klasörü sabittir; ikinci kopya eskisini kalıntısız değiştirir', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const ek = join(kok, 'ek.txt');
    await writeFile(ek, 'ilk koşunun eki');
    await dizin.hataPaketiYaz(paket(), [{ kaynak: ek, hedefAd: 'adim-1.png' }]);
    const hedef = hataPaketiCikisYolu(kok, 't_abc12345');
    expect(hedef).toBe(dizin.yol('failure-out', 't_abc12345'));

    await dizin.hataPaketiKopyala('t_abc12345', hedef);
    expect(await readFile(join(hedef, 'adim-1.png'), 'utf8')).toBe('ilk koşunun eki');

    // İkinci koşunun paketinde o ek yok: aynı yola yazılınca eskisinden iz kalmamalı.
    await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
    await dizin.hataPaketiKopyala('t_abc12345', hedef);

    const kopya = await jsonOku(join(hedef, 'failure.json'), HataPaketiSemasi);
    expect(kopya.snapshotId).toBe('s_2');
    await expect(stat(join(hedef, 'adim-1.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('failure-out dışarıyı gösteren symlink ise varsayılan kopyalama reddedilir, dışarısı durur', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    await dizin.hataPaketiYaz(paket(), []);
    // Kötü niyetli klon: .kobay/failure-out repoda symlink olarak commit edilmiş.
    const disari = await geciciDizin();
    await writeFile(join(disari, 'degerli.txt'), 'silinmemeli');
    await mkdir(join(disari, 't_abc12345'));
    await writeFile(join(disari, 't_abc12345', 'icerik.txt'), 'bu da silinmemeli');
    await rm(dizin.yol('failure-out'), { recursive: true, force: true });
    await symlink(disari, dizin.yol('failure-out'));

    await expect(dizin.hataPaketiKopyala('t_abc12345', hataPaketiCikisYolu(kok, 't_abc12345')))
      .rejects.toThrow('Güvenli olmayan hata paketi çıkışı');

    // Dışarıdaki klasöre hiç dokunulmamalı: ne silinmiş ne de paket yazılmış.
    expect((await readdir(disari)).sort()).toEqual(['degerli.txt', 't_abc12345']);
    await expect(readFile(join(disari, 't_abc12345', 'icerik.txt'), 'utf8')).resolves.toBe('bu da silinmemeli');
  });

  it('<testId> klasörü dışarıyı gösteren symlink ise varsayılan kopyalama reddedilir', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    await dizin.hataPaketiYaz(paket(), []);
    const disari = await geciciDizin();
    await writeFile(join(disari, 'degerli.txt'), 'silinmemeli');
    await symlink(disari, dizin.yol('failure-out', 't_abc12345'));

    await expect(dizin.hataPaketiKopyala('t_abc12345', hataPaketiCikisYolu(kok, 't_abc12345')))
      .rejects.toThrow('Güvenli olmayan hata paketi çıkışı');

    expect(await readdir(disari)).toEqual(['degerli.txt']);
    // Reddedilen yol geçici klasör de bırakmamalı.
    expect(await readdir(dizin.yol('failure-out'))).toEqual(['t_abc12345']);
  });

  it('varsayılan olmayan hedef klasör varsa kopyalama reddedilir', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = join(kok, 'elle-verilen');
    await mkdir(hedef);

    await expect(dizin.hataPaketiKopyala('t_abc12345', hedef)).rejects.toThrow('Hedef klasör zaten var');
  });

  it('koşu dizinleri test başına son beşe budanır; başka testin koşusu kalır', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const kendi = await kosuYaz(dizin, 't_abc12345', 7);
    const digeri = await kosuYaz(dizin, 't_zzz99999', 2);
    // result.json'u olmayan dizin yarım bir koşu olabilir; budama ona dokunmaz.
    await mkdir(dizin.yol('runs', 'r_20260101000000_xxxx'), { recursive: true });

    const silinen = await dizin.kosulariBuda('t_abc12345');

    expect(silinen).toEqual(kendi.slice(0, 2));
    expect((await dizin.kosuListele('t_abc12345')).map((k) => k.runId)).toEqual(kendi.slice(2));
    expect((await dizin.kosuListele('t_zzz99999')).map((k) => k.runId)).toEqual(digeri);
    expect((await stat(dizin.yol('runs', 'r_20260101000000_xxxx'))).isDirectory()).toBe(true);
    for (const runId of kendi.slice(0, 2)) {
      await expect(stat(dizin.yol('runs', runId))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('budama yayımlanmış hata paketinin gösterdiği koşuyu silmez', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const kosular = await kosuYaz(dizin, 't_abc12345', 8);
    const paketKosusu = kosular[0] ?? '';
    await dizin.hataPaketiYaz({
      ...paket(),
      runId: paketKosusu,
      result: { ...paket().result, runId: paketKosusu },
    }, []);

    const silinen = await dizin.kosulariBuda('t_abc12345');

    expect(silinen).not.toContain(paketKosusu);
    expect(silinen).toHaveLength(2);
    expect((await stat(dizin.yol('runs', paketKosusu))).isDirectory()).toBe(true);
    expect((await dizin.kosuListele('t_abc12345')).map((k) => k.runId))
      .toEqual([paketKosusu, ...kosular.slice(-SAKLANAN_KOSU)]);
  });

  it('korunanlar kümesindeki koşu, son beşin dışında kalsa da silinmez', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const kosular = await kosuYaz(dizin, 't_abc12345', 7);
    const korunacak = kosular[0] ?? '';

    const silinen = await dizin.kosulariBuda('t_abc12345', { korunanlar: [korunacak] });

    expect(silinen).toEqual([kosular[1]]);
    expect((await stat(dizin.yol('runs', korunacak))).isDirectory()).toBe(true);
  });

  it('tazeMs içinde biten koşu, son beşin dışında kalsa da silinmez', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const kosular = await kosuYaz(dizin, 't_abc12345', 7);

    // Koşuların hepsi 2026-09-17'de bitiyor; pencere yeterince genişse hiçbiri budanmaz.
    const silinen = await dizin.kosulariBuda('t_abc12345', { tazeMs: Date.now() });

    expect(silinen).toEqual([]);
    expect((await dizin.kosuListele('t_abc12345')).map((k) => k.runId)).toEqual(kosular);
  });

  it('liste alındıktan sonra biten adayı silmez (silme öncesi son bakış)', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const kosular = await kosuYaz(dizin, 't_abc12345', 7);
    // Budamanın göreceği anlık görüntü: hepsi bayat.
    const bayatListe = await dizin.kosuListele('t_abc12345');
    vi.spyOn(dizin, 'kosuListele').mockResolvedValue(bayatListe);
    // En eski aday, liste alındıktan sonra taze bir finishedAt ile yeniden yazılıyor:
    // eşzamanlı koşu az önce bitmiş demektir, kanıtı durmalı.
    const gecBiten = bayatListe[0];
    if (gecBiten === undefined) throw new Error('liste boş olmamalı');
    await dizin.kosuSonucuYaz({ ...gecBiten, finishedAt: new Date().toISOString() });

    const silinen = await dizin.kosulariBuda('t_abc12345');

    expect(silinen).toEqual([kosular[1]]);
    expect((await stat(dizin.yol('runs', gecBiten.runId))).isDirectory()).toBe(true);
  });
});

describe('kimlik işlemi (geri alınabilir geçersiz kılma)', () => {
  const kimlik = { kullanici: 'ali', parola: 'gizli-1', origin: 'http://mesru.test' };

  async function kimlikliDizin(): Promise<KobayDizini> {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.kimlikYaz(kimlik);
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    return dizin;
  }

  /** `.kobay/` kökündeki kenara alınmış kopyalar. */
  async function kalintilar(dizin: KobayDizini): Promise<string[]> {
    return (await readdir(dizin.kok)).filter((ad) => ad.startsWith('.eski-'));
  }

  /**
   * Süreci öldürülmüş bir işlemin bıraktığı işareti taklit eder: dosya durur
   * ama tazelik penceresinden (10 dk) eskidir.
   */
  /** İşlem işaretinin ham içeriği. */
  async function isaretiOku(dizin: KobayDizini): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(dizin.kok, '.kimlik-islemi'), 'utf8')) as Record<string, unknown>;
  }

  async function isaretiBayatlat(dizin: KobayDizini): Promise<void> {
    const ham = JSON.parse(await readFile(join(dizin.kok, '.kimlik-islemi'), 'utf8')) as Record<string, unknown>;
    await writeFile(
      join(dizin.kok, '.kimlik-islemi'),
      JSON.stringify({ ...ham, baslatildi: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
    );
  }

  it('kenara alma dosyaları silmez; kesinleştirince gider, geri alınca aynen döner', async () => {
    const dizin = await kimlikliDizin();

    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    expect(islem.adlar).toEqual(['credentials.json', 'storageState.json']);
    // Asıl adlar boşalır ama içerik diskte durur: config yazımı burada düşerse kayıp yok.
    await expect(dizin.kimlikOku()).resolves.toBeNull();
    expect(await kalintilar(dizin)).toHaveLength(2);

    await islem.geriAl();
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    expect(await kalintilar(dizin)).toEqual([]);

    const ikinci = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    await ikinci.kesinlestir();
    await expect(dizin.kimlikOku()).resolves.toBeNull();
    await expect(stat(dizin.storageStateYolu())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await kalintilar(dizin)).toEqual([]);
  });

  it('dosya yoksa sessizce geçer; kenara alınan ad listesi yalnız var olanları sayar', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.storageStateYaz('{"cookies":[]}');

    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });

    expect(islem.adlar).toEqual(['storageState.json']);
    await islem.kesinlestir();
    expect(await kalintilar(dizin)).toEqual([]);
  });

  it('yarım kalan işlemin kalıntısını sonraki komut toparlar: asıl dosya yoksa geri koyar', async () => {
    const dizin = await kimlikliDizin();
    // Süreç kenara aldıktan hemen sonra öldürüldü: ne kesinleştirildi ne geri alındı.
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    await isaretiBayatlat(dizin);
    expect(await kalintilar(dizin)).toHaveLength(2);

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sonraki = await KobayDizini.bul(dizin.projeKoku);
    uyari.mockRestore();

    expect(await kalintilar(dizin)).toEqual([]);
    // Bayat işaret de temizlenir; sonraki komutlar aynı kararı yeniden vermez.
    await expect(stat(join(dizin.kok, '.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(sonraki?.kimlikOku()).resolves.toEqual(kimlik);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
  });

  it('kesinleşmemiş işlem tam geri alınır: sonradan yazılan kimliğin üstüne eskisi konur', async () => {
    const dizin = await kimlikliDizin();
    // Kilit bizdeyken asıl adı yalnız düşen işlemin kendisi yazmış olabilir
    // (--login). İşlem hiç olmamış sayılır: yeni kimlik ezilir.
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    await isaretiBayatlat(dizin);
    await dizin.kimlikYaz({ kullanici: 'veli', parola: 'gizli-2', origin: 'http://kotu.test' });

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await KobayDizini.bul(dizin.projeKoku);
    uyari.mockRestore();

    expect(await kalintilar(dizin)).toEqual([]);
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
  });

  it('config yazıldıktan sonra süreç ölürse config de geri döner; yeni hedefle eski oturum yan yana kalmaz', async () => {
    const dizin = await kimlikliDizin();
    // `project update --base-url` akışının tam ortası: kenara al, yeni config'i
    // yaz, sonra süreç öl. Kesinleştirme hiç çalışmadı.
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    await dizin.configYaz({ ...config, baseUrl: 'http://kotu.test:8080' });
    await isaretiBayatlat(dizin);

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sonraki = await KobayDizini.bul(dizin.projeKoku);
    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();

    // Hedef eski değerine döndü: geri konan oturum yine kendi hedefinin yanında.
    await expect(sonraki?.configOku()).resolves.toEqual(config);
    await expect(sonraki?.kimlikOku()).resolves.toEqual(kimlik);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    expect(await kalintilar(dizin)).toEqual([]);
    await expect(stat(join(dizin.kok, '.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(basilan).toContain('yarım kalmış bir hedef değişikliği geri alındı');
    expect(basilan).toContain(config.baseUrl);
  });

  it('--login çökmesinde yeni kimlik silinir: kenara alınacak eskisi yoksa geride bırakılmaz', async () => {
    // Kayıtlı kimlik yok, yalnız oturum var: `--force --login` yeni kimliği
    // yazdıktan hemen sonra süreç ölüyor.
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config, yeniKimlikYazilacak: true });
    expect(islem.adlar).toEqual(['storageState.json']);
    await dizin.configYaz({ ...config, baseUrl: 'http://kotu.test:8080' });
    await dizin.kimlikYaz({ kullanici: 'veli', parola: 'gizli-2', origin: 'http://kotu.test:8080' });
    await isaretiBayatlat(dizin);

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await KobayDizini.bul(dizin.projeKoku);
    uyari.mockRestore();

    // Yeni hedefin parolası eski config'in altında kalmaz.
    await expect(dizin.kimlikOku()).resolves.toBeNull();
    await expect(dizin.configOku()).resolves.toEqual(config);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    expect(await kalintilar(dizin)).toEqual([]);
  });

  it('geri alma tekrarında geri konmuş credentials.json silinmez (karar işaretteki kalıcı olgudan)', async () => {
    const dizin = await kimlikliDizin();
    // `--force --login`: eskisi kenara alındı, yeni hedef ve yeni parola yazıldı,
    // sonra kesinleşme düştü.
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config, yeniKimlikYazilacak: true });
    expect((await isaretiOku(dizin)).kenaraAlinanlar).toEqual(['credentials.json', 'storageState.json']);
    await dizin.configYaz({ ...config, baseUrl: 'http://kotu.test:8080' });
    await dizin.kimlikYaz({ kullanici: 'veli', parola: 'gizli-2', origin: 'http://kotu.test:8080' });

    // İlk geri alma denemesi: credentials kopyası geri kondu, storageState düştü.
    atomikDurum.renameKosulu = (eski) => eski.includes('-storageState.json');
    atomikDurum.renameKodu = 'EACCES';
    const ilkHata = await islem
      .geriAl({ configYazildi: true, yeniKimlikYazildi: true, asilHata: new Error('kesinleştirme düştü') })
      .catch((hata: unknown) => hata);
    atomikDurum.renameKosulu = undefined;
    atomikDurum.renameKodu = undefined;

    expect(ilkHata).toBeInstanceOf(KimlikGeriAlinamadi);
    // Orijinal kimlik yerine kondu; geriye yalnız oturum kopyası ve işaret kaldı.
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    expect(await kalintilar(dizin)).toHaveLength(1);

    // Sonraki komutun kurtarması. Asıl bulgu: eski karar kuralı kalan
    // kopyalara bakıp "kenara alınan eski kimlik yokmuş" sanıyor ve `--login`
    // artığı diye geri konmuş ORİJİNAL credentials.json'ı siliyordu.
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sonraki = await KobayDizini.bul(dizin.projeKoku);
    uyari.mockRestore();

    await expect(sonraki?.kimlikOku()).resolves.toEqual(kimlik);
    await expect(sonraki?.configOku()).resolves.toEqual(config);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    expect(await kalintilar(dizin)).toEqual([]);
    await expect(stat(join(dizin.kok, '.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aynı işaretle kurtarma iki kez koşarsa sonuç değişmez; orijinal kimlik durur', async () => {
    const dizin = await kimlikliDizin();
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config, yeniKimlikYazilacak: true });
    const isaretYedegi = await isaretiOku(dizin);
    await dizin.configYaz({ ...config, baseUrl: 'http://kotu.test:8080' });
    await dizin.kimlikYaz({ kullanici: 'veli', parola: 'gizli-2', origin: 'http://kotu.test:8080' });

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await islem.geriAl({ configYazildi: true, yeniKimlikYazildi: true });
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    expect(await kalintilar(dizin)).toEqual([]);

    // İşaret (örneğin silinemediği için) yerinde kalsaydı kurtarma aynı kayıtla
    // bir kez daha koşardı: kopya kalmadığı için eski kural "eski kimlik yoktu"
    // sonucuna varıp geri konmuş orijinali silerdi. Kalıcı olgu bunu keser.
    await writeFile(join(dizin.kok, '.kimlik-islemi'), JSON.stringify({
      ...isaretYedegi,
      baslatildi: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));
    await KobayDizini.bul(dizin.projeKoku);
    uyari.mockRestore();

    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    await expect(dizin.configOku()).resolves.toEqual(config);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
  });

  it('işarette kenara alınan dosya listesi yoksa silme yapılmaz, uyarılır', async () => {
    const dizin = await kimlikliDizin();
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config, yeniKimlikYazilacak: true });
    const ham = await isaretiOku(dizin);
    // Kimlik kopyası önceki bir denemede geri konmuş; geriye yalnız oturum kopyası kaldı.
    await rename(
      join(dizin.kok, `.eski-${String(ham.islemId)}-credentials.json`),
      dizin.yol('credentials.json'),
    );
    // Eski bir kobay sürümünün işareti: kalıcı olgu hiç yazılmamış.
    delete ham.kenaraAlinanlar;
    await writeFile(join(dizin.kok, '.kimlik-islemi'), JSON.stringify({
      ...ham,
      baslatildi: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await KobayDizini.bul(dizin.projeKoku);
    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();

    // Güvenli taraf: silinmedi, kullanıcıya ne yapacağı söylendi.
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    expect(basilan).toContain('kenara alınan dosya listesi yok');
    expect(basilan).toContain('kobay project get');
  });

  it('eski sürümün işaretinde (eskiConfig yok) geri koyma yapılmaz: uyarılır, işaret silinir', async () => {
    const dizin = await kimlikliDizin();
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    // Eski kobay sürümünün yazdığı işaret: geri alma kaydı yok.
    const ham = await isaretiOku(dizin);
    delete ham.eskiConfig;
    await writeFile(join(dizin.kok, '.kimlik-islemi'), JSON.stringify({
      ...ham,
      baslatildi: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await KobayDizini.bul(dizin.projeKoku);
    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();

    // Kalıntı yerinde: hangi config'in altına konacağı bilinmiyor.
    expect(await kalintilar(dizin)).toHaveLength(2);
    await expect(dizin.kimlikOku()).resolves.toBeNull();
    await expect(stat(dizin.storageStateYolu())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(basilan).toContain('işlem öncesi config yok');
    expect(basilan).toContain('elle credentials.json adına taşıyın');
    // İşaret gider; yoksa kilit sonsuza dek durur.
    await expect(stat(join(dizin.kok, '.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('işlem sürerken (taze işaret) ikinci sürecin bul() çağrısı kalıntıya dokunmaz', async () => {
    const dizin = await kimlikliDizin();
    // Birinci süreç kenara aldı, config'i henüz yazmadı: işaret taze (bu sürecin pid'i).
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    const oncekiKalintilar = await kalintilar(dizin);
    expect(oncekiKalintilar).toHaveLength(2);

    // İkinci kobay süreci aynı projede bir komut çalıştırıyor.
    const ikinci = await KobayDizini.bul(dizin.projeKoku);

    // Kalıntı aynen durmalı: geri konsaydı birinci süreç eski oturumu yeni hedefin yanında bırakırdı.
    expect(await kalintilar(dizin)).toEqual(oncekiKalintilar);
    await expect(ikinci?.kimlikOku()).resolves.toBeNull();
    await expect(stat(dizin.storageStateYolu())).rejects.toMatchObject({ code: 'ENOENT' });

    // Birinci süreç işini bitirince hem kalıntı hem işaret gider.
    await islem.kesinlestir();
    expect(await kalintilar(dizin)).toEqual([]);
    await expect(stat(join(dizin.kok, '.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kesinleştirme anında dosya geri konmuşsa başarı dönmez, açık hata verir', async () => {
    const dizin = await kimlikliDizin();
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    // Başka bir süreç (eski sürüm ya da yarış) kalıntıyı asıl adına geri koydu.
    for (const ad of await kalintilar(dizin)) {
      await rename(join(dizin.kok, ad), join(dizin.kok, ad.slice('.eski-'.length + 36 + 1)));
    }

    await expect(islem.kesinlestir()).rejects.toThrow('Kimlik işlemi bozuldu');

    // Kullanıcının verisi duruyor ve işaret bırakılmıyor.
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    await expect(stat(join(dizin.kok, '.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kesinleşmeden sonra silme düşerse işlem düşmez: uyarılır, kalıntı yerinde kalır', async () => {
    const dizin = await kimlikliDizin();
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    // Doğrulama aşaması geçti (iki yedek de yerinde). Temizlikte ilk silme
    // tutuyor, ikincisi düşüyor: eski davranışta burada hata fırlıyor, çağıran
    // eksik yedekle geri almaya girip ilk dosyayı büsbütün kaybediyordu.
    atomikDurum.rmKosulu = (yol) => yol.includes('-storageState.json');
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(islem.kesinlestir()).resolves.toBeUndefined();

    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();
    atomikDurum.rmKosulu = undefined;
    expect(basilan).toContain('storageState.json kopyası silinemedi');
    expect(basilan).toContain('EBUSY');
    // Silinebilen gitti (temizlik ilk hatada durmuyor), silinemeyen duruyor.
    const kalan = await kalintilar(dizin);
    expect(kalan).toHaveLength(1);
    expect(kalan[0]).toMatch(/^\.eski-[0-9a-f-]{36}-storageState\.json$/);
    // Kalıntı kaldığı için işaret yerinde bırakılır ve kesinleşmeyi taşır:
    // kurtarma bu kalıntıyı geri koymayacağını ancak buradan bilir.
    await expect(isaretiOku(dizin)).resolves.toMatchObject({ committed: true });
  });

  it('kesinleşmiş kalıntı kurtarmada geri KONMAZ, silinir (origin değişmiş oturum dirilmesin)', async () => {
    // Hedef origin değişti: yalnız oturum dosyası var, credentials.json yok.
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.storageStateYaz('{"cookies":[{"name":"oturum"}],"origins":[]}');
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    // Kesinleşme noktası geçildi, ama yedek silinemiyor (EBUSY) ya da süreç
    // silmeden ölüyor: kalıntı ve kesinleşmiş işaret yerinde kalıyor.
    atomikDurum.rmKosulu = (yol) => yol.includes('-storageState.json');
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await islem.kesinlestir();
    atomikDurum.rmKosulu = undefined;
    expect(await kalintilar(dizin)).toHaveLength(1);
    // Süreç bitti: işaret bayatladı, sonraki komut kurtarmayı çalıştırıyor.
    await isaretiBayatlat(dizin);

    await KobayDizini.bul(dizin.projeKoku);
    uyari.mockRestore();

    // Asıl dosya yok ama kalıntı geri konmuyor: eski origin'in çerezleri yeni
    // hedefin yanında `test run` tarafından Playwright'a verilmezdi.
    await expect(stat(dizin.storageStateYolu())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await kalintilar(dizin)).toEqual([]);
    await expect(stat(join(dizin.kok, '.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kesinleşme işareti yazılamazsa işlem doğrulama hatasıyla düşer; hiçbir yedek silinmez', async () => {
    const dizin = await kimlikliDizin();
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    // İşaretin atomik yazımı (geçici dosya + rename) düşüyor.
    atomikDurum.renameKosulu = (_eski, yeni) => yeni.endsWith('.kimlik-islemi');

    await expect(islem.kesinlestir()).rejects.toThrow('yeniden adlandırma simülasyonu');

    atomikDurum.renameKosulu = undefined;
    // Doğrulama hatası: iki yedek de duruyor, çağıran güvenle geri alabilir.
    expect(await kalintilar(dizin)).toHaveLength(2);
    await islem.geriAl();
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    // Geri koyma tamamlandı: kalıntı kalmadığı için işaret de kaldırılır.
    await expect(stat(join(dizin.kok, '.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('taze kesinleşmiş işaret ikinci işlemi hâlâ reddeder; sahibi devralıp temizler', async () => {
    const dizin = await kimlikliDizin();
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    atomikDurum.rmKosulu = (yol) => yol.includes('-storageState.json');
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await islem.kesinlestir();
    atomikDurum.rmKosulu = undefined;
    const isaret = await isaretiOku(dizin);
    expect(isaret).toMatchObject({ committed: true });

    // Başka bir sürece ait taze kesinleşmiş işaret: o süreç hâlâ temizlik
    // yapıyor olabilir, ikinci komut reddedilir.
    await writeFile(join(dizin.kok, '.kimlik-islemi'), JSON.stringify({ ...isaret, pid: process.ppid }));
    await expect(dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config })).rejects.toBeInstanceOf(KimlikIslemiYurumede);
    expect(await kalintilar(dizin)).toHaveLength(1);

    // Kendi sürecimizin bıraktığı iz kilit sayılmaz: kalıntı temizlenip devralınır.
    await writeFile(join(dizin.kok, '.kimlik-islemi'), JSON.stringify(isaret));
    const ikinci = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    uyari.mockRestore();
    expect(await kalintilar(dizin)).toEqual([]);
    await ikinci.kesinlestir();
  });

  it('kenara alma yarıda düşerse o ana kadar taşınanlar hemen geri konur', async () => {
    const dizin = await kimlikliDizin();
    // İlk dosya taşınır, ikincisinde rename düşer. Yalnız kenara alma renameleri
    // sayılır; işaret dosyasının atomik yazımı bu sayıyı kaydırmasın.
    let cagri = 0;
    atomikDurum.renameKosulu = (_eski, yeni) => {
      if (!yeni.includes('/.eski-')) return false;
      cagri += 1;
      return cagri === 2;
    };

    await expect(dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config })).rejects.toThrow('yeniden adlandırma simülasyonu');

    atomikDurum.renameKosulu = undefined;
    expect(await kalintilar(dizin)).toEqual([]);
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
  });

  it('taze işaret kilittir: ikinci kimlik işlemi reddedilir, ilkinin dosyalarına dokunulmaz', async () => {
    const dizin = await kimlikliDizin();
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    const oncekiKalintilar = await kalintilar(dizin);
    const oncekiIsaret = await readFile(join(dizin.kok, '.kimlik-islemi'), 'utf8');
    expect(oncekiKalintilar).toHaveLength(2);

    // İkinci komut beklemez; açık kullanım hatasıyla düşer (CLI'da çıkış 2).
    await expect(dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config })).rejects.toBeInstanceOf(KimlikIslemiYurumede);
    await expect(dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config })).rejects.toThrow('bitmesini bekleyip');

    // Reddedilen komut ne kalıntıya ne de işarete dokunur: kilit ilk işlemin.
    expect(await kalintilar(dizin)).toEqual(oncekiKalintilar);
    await expect(readFile(join(dizin.kok, '.kimlik-islemi'), 'utf8')).resolves.toBe(oncekiIsaret);

    await islem.kesinlestir();
  });

  it('geri almada config yazımı düşerse yedekler geri KONMAZ, işaret korunur; sonraki bul() tamamlar', async () => {
    const dizin = await kimlikliDizin();
    const yeniConfig = { ...config, baseUrl: 'http://kotu.test:8080' };
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    await dizin.configYaz(yeniConfig);
    // Kesinleştirme doğrulama aşamasında düşüyor (işaret yazımı tutmuyor).
    atomikDurum.renameKosulu = (_eski, yeni) => yeni.endsWith('.kimlik-islemi');
    const kesinlestirmeHatasi = await islem.kesinlestir().catch((hata: unknown) => hata);
    expect(kesinlestirmeHatasi).toBeInstanceOf(Error);
    atomikDurum.renameKosulu = undefined;

    // Geri almanın ilk adımı — config'i eskiye yazmak — dolu diskte düşüyor.
    const casus = vi.spyOn(KobayDizini.prototype, 'configYaz')
      .mockRejectedValueOnce(Object.assign(new Error('disk dolu'), { code: 'ENOSPC' }));
    const geriAlmaHatasi = await islem
      .geriAl({ configYazildi: true, asilHata: kesinlestirmeHatasi })
      .catch((hata: unknown) => hata);
    casus.mockRestore();

    expect(geriAlmaHatasi).toBeInstanceOf(KimlikGeriAlinamadi);
    expect((geriAlmaHatasi as Error).message).toContain('ENOSPC');
    expect((geriAlmaHatasi as Error).message).toContain('yeniden çalıştırın');
    // Asıl bulgu: config geri yazılamadığı için yedekler geri konmadı ve
    // düzeltmeyi taşıyan işaret silinmedi.
    expect(await kalintilar(dizin)).toHaveLength(2);
    await expect(dizin.configOku()).resolves.toEqual(yeniConfig);
    const kalanIsaret = await isaretiOku(dizin);
    expect(kalanIsaret.committed ?? false).toBe(false);
    expect(kalanIsaret.eskiConfig).toEqual(config);

    // Sonraki komut: configYaz artık çalışıyor, kurtarma aynı sırayla tamamlıyor.
    // İşaret bu sürecin pid'iyle taze görünse de "geri alınamadı" diye bilindiği
    // için atlanmıyor.
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sonraki = await KobayDizini.bul(dizin.projeKoku);
    uyari.mockRestore();

    await expect(sonraki?.configOku()).resolves.toEqual(config);
    await expect(sonraki?.kimlikOku()).resolves.toEqual(kimlik);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    expect(await kalintilar(dizin)).toEqual([]);
    await expect(stat(join(dizin.kok, '.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bayat kesinleşmemiş kurtarmada yedek geri konamazsa bul() fırlatır; kilit devralınmaz', async () => {
    const dizin = await kimlikliDizin();
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    await isaretiBayatlat(dizin);
    // Kurtarma yedeği asıl adına koyamıyor (izin yok).
    atomikDurum.renameKosulu = (eski) => eski.includes('/.eski-');
    atomikDurum.renameKodu = 'EACCES';

    const hata = await KobayDizini.bul(dizin.projeKoku).catch((h: unknown) => h);

    expect(hata).toBeInstanceOf(KimlikGeriAlinamadi);
    // Kullanıcı hangi dosyanın neden geri konamadığını ve ne yapacağını görür.
    expect((hata as Error).message).toMatch(/\.eski-[0-9a-f-]{36}-credentials\.json/);
    expect((hata as Error).message).toContain('EACCES');
    expect((hata as Error).message).toContain('yeniden çalıştırın');
    // İşaret ve yedek yerinde: sonraki komut aynı sırayla yeniden deneyebilir.
    expect(await kalintilar(dizin)).toHaveLength(2);
    expect((await isaretiOku(dizin)).eskiConfig).toEqual(config);

    // Aynı süreçte kimliği değiştiren yeni bir işlem kilidi devralamaz; devralsaydı
    // işlem kaydını siler ve geri konamayan yedek sahipsiz kalırdı.
    await expect(dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config }))
      .rejects.toBeInstanceOf(KimlikGeriAlinamadi);
    expect(await kalintilar(dizin)).toHaveLength(2);
    expect((await isaretiOku(dizin)).eskiConfig).toEqual(config);

    // Sorun giderilince sonraki komut geri almayı tamamlar.
    atomikDurum.renameKosulu = undefined;
    atomikDurum.renameKodu = undefined;
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await KobayDizini.bul(dizin.projeKoku);
    uyari.mockRestore();
    expect(await kalintilar(dizin)).toEqual([]);
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
  });

  it('bayat kesinleşmiş işaret devralınır; iki devralma yarışında yalnız biri kazanır', async () => {
    const dizin = await kimlikliDizin();
    // Süreci öldürülmüş ama kesinleşme noktasını geçmiş bir işlemin bıraktığı
    // bayat işaret: geri alınacak bir şey yok, kalıntısı yalnız silinecek.
    // (Kesinleşmemiş, `eskiConfig` taşıyan bayat işaret artık devralınmaz;
    // onun testi aşağıda.)
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    atomikDurum.rmKosulu = (yol) => yol.includes('-storageState.json');
    const kesinlestirmeUyarisi = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await islem.kesinlestir();
    kesinlestirmeUyarisi.mockRestore();
    atomikDurum.rmKosulu = undefined;
    await expect(isaretiOku(dizin)).resolves.toMatchObject({ committed: true });
    await isaretiBayatlat(dizin);
    const bayatIsaret = await readFile(join(dizin.kok, '.kimlik-islemi'), 'utf8');

    const sonuclar = await Promise.allSettled([
      dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config }),
      dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config }),
    ]);

    // Devralmayı rename kazananı belirler: tek sahip.
    expect(sonuclar.filter((sonuc) => sonuc.status === 'fulfilled')).toHaveLength(1);
    const kaybeden = sonuclar.find((sonuc) => sonuc.status === 'rejected') as PromiseRejectedResult;
    expect(kaybeden.reason).toBeInstanceOf(KimlikIslemiYurumede);
    // Red taze işaret kontrolünden değil, devralma rename'inin düşmesinden geldi:
    // sahibi bilinmediği için mesajda pid ayrıntısı yok.
    expect((kaybeden.reason as Error).message).not.toContain('pid');
    // Kilit gerçekten devralındı ve devralma kopyası ortalıkta bırakılmadı.
    await expect(readFile(join(dizin.kok, '.kimlik-islemi'), 'utf8')).resolves.not.toBe(bayatIsaret);
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.kimlik-islemi-devir-'))).toEqual([]);
  });

  it('kurtarma yalnız bayat işaretteki islemId’nin kalıntısını toparlar', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    // Yabancı işlemin (başka islemId) kalıntısı; bu işaret onu kapsamıyor.
    const yabanciId = '11111111-1111-4111-8111-111111111111';
    await writeFile(join(dizin.kok, `.eski-${yabanciId}-credentials.json`), '{"kullanici":"veli","parola":"gizli-9"}');

    // Bu işlem yalnız storageState.json'u kenara aldı, sonra süreci öldü.
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    await isaretiBayatlat(dizin);

    const ilkUyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await KobayDizini.bul(dizin.projeKoku);
    ilkUyari.mockRestore();

    // Kendi kalıntısı geri kondu, yabancıya dokunulmadı.
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    expect(await kalintilar(dizin)).toEqual([`.eski-${yabanciId}-credentials.json`]);

    // Yabancı kalıntı sahipsizdir: geri konmaz (hangi hedefe ait olduğu
    // bilinmiyor), silinmez de (içinde parola olabilir); uyarılıp bırakılır.
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await KobayDizini.bul(dizin.projeKoku);
    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();
    expect(basilan).toContain(`sahipsiz giriş bilgisi kopyası .eski-${yabanciId}-credentials.json`);
    expect(await kalintilar(dizin)).toEqual([`.eski-${yabanciId}-credentials.json`]);
    await expect(dizin.kimlikOku()).resolves.toBeNull();
  });

  it('işaretsiz kalıntı geri konmaz: sahipsiz kopya uyarıyla yerinde bırakılır', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const birinci = '11111111-1111-4111-8111-111111111111';
    const ikinci = '22222222-2222-4222-8222-222222222222';
    await writeFile(join(dizin.kok, `.eski-${birinci}-credentials.json`), '{"kullanici":"ali"}');
    await writeFile(join(dizin.kok, `.eski-${ikinci}-credentials.json`), '{"kullanici":"veli"}');
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await KobayDizini.bul(dizin.projeKoku);

    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();
    expect(basilan).toContain(`sahipsiz giriş bilgisi kopyası .eski-${birinci}-credentials.json`);
    expect(basilan).toContain(`sahipsiz giriş bilgisi kopyası .eski-${ikinci}-credentials.json`);
    expect(basilan).toContain('elle credentials.json adına taşıyın');
    // Hiçbiri seçilmez; kullanıcı elle karar verir.
    expect((await kalintilar(dizin)).sort()).toEqual([
      `.eski-${birinci}-credentials.json`,
      `.eski-${ikinci}-credentials.json`,
    ]);
    await expect(dizin.kimlikOku()).resolves.toBeNull();
  });
});
