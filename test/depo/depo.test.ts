import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  /**
   * Belirli bir `access` çağrısını "dosya yok" gibi göstermek için. Göç
   * yarışını taklit eder: hedefi araya giren bir süreç kontrolden SONRA
   * yazmışsa, kontrol onu göremez.
   */
  accessYokKosulu: undefined as ((yol: string) => boolean) | undefined,
  /** `link` çağrısını düşüren kod; sert bağ desteklemeyen dosya sistemini taklit eder. */
  linkKodu: undefined as string | undefined,
  /** Başarılı bir `rename` çağrısından hemen sonra koşar; yarışı taklit eder. */
  renameSonrasi: undefined as ((eski: string, yeni: string) => Promise<void>) | undefined,
  /**
   * `realpath` çağrısından hemen önce koşar; `lstat` ile `realpath` arasındaki
   * pencerede araya giren bir yazıcıyı taklit eder. Fırlatırsa `realpath` o hatayı verir.
   */
  realpathOncesi: undefined as ((yol: string) => Promise<void>) | undefined,
  /**
   * `realpath` sonucunu değiştirir. Açık tutamaktan yol okuyan sistemlerde
   * (macOS) taşınan klasörün yeni, kardeş adı dönebilir; bunu kesin üretir.
   */
  realpathSonucu: undefined as ((yol: string, sonuc: string) => string) | undefined,
  /**
   * Gerçek `rename` düştüğünde hatayı dönüştürür (döndürdüğü fırlatılır).
   * Windows taklidi gerçek ENOTEMPTY/EEXIST sonucunu EPERM'e çevirir; önceden
   * "hedef var mı" diye bakıp gerçek taşımayı hiç denememek TOCTOU'luydu.
   */
  renameHatasi: undefined as ((eski: string, yeni: string, hata: unknown) => unknown) | undefined,
  /** `rename` çağrısından hemen önce koşar (gerçek taşıma henüz yapılmadı). */
  renameOncesi: undefined as ((eski: string, yeni: string) => Promise<void>) | undefined,
  /** Kilit dosyasının gövdesi yazılmadan hemen önce koşar (dosya henüz boş). */
  kilitYazimOncesi: undefined as ((yol: string) => Promise<void>) | undefined,
  /** Verilirse kilit gövdesinin `writeFile` çağrısı hiçbir şey yazmadan bu kodla düşer. */
  kilitYazKodu: undefined as string | undefined,
  /** Verilirse kilit dosyasının `close()` çağrısı bu kodla düşer (dosya yine kapanır). */
  kilitKapatKodu: undefined as string | undefined,
  /**
   * Windows taklidinin gördüğü "dolu klasöre taşıma" çarpışmaları: POSIX'te
   * gerçek ENOTEMPTY/EEXIST'in EPERM'e çevrilmesi, win32'de yerel EPERM/EACCES.
   */
  donusum: 0,
  /** Kilit dosyasının gövdesi yazıldıktan hemen sonra (kapatmadan önce) koşar. */
  kilitYazimSonrasi: undefined as ((yol: string) => Promise<void>) | undefined,
  /** Belirli bir `open` çağrısını düşürmek için; dönen kod fırlatılır. */
  openKodu: undefined as ((yol: string, bayrak: unknown) => string | undefined) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const asil = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...asil,
    rename: async (eski: string, yeni: string) => {
      await atomikDurum.renameOncesi?.(eski, yeni);
      if (atomikDurum.renameDussun || atomikDurum.renameKosulu?.(eski, yeni) === true) {
        const hata = new Error('yeniden adlandırma simülasyonu');
        throw atomikDurum.renameKodu === undefined
          ? hata
          : Object.assign(hata, { code: atomikDurum.renameKodu });
      }
      try {
        await asil.rename(eski, yeni);
      } catch (hata: unknown) {
        throw atomikDurum.renameHatasi === undefined ? hata : atomikDurum.renameHatasi(eski, yeni, hata);
      }
      await atomikDurum.renameSonrasi?.(eski, yeni);
    },
    rm: async (yol: Parameters<typeof asil.rm>[0], secenekler?: Parameters<typeof asil.rm>[1]) => {
      if (atomikDurum.rmKosulu?.(String(yol)) === true) {
        throw Object.assign(new Error('silme simülasyonu'), { code: 'EBUSY' });
      }
      await asil.rm(yol, secenekler);
    },
    link: async (eski: string, yeni: string) => {
      if (atomikDurum.linkKodu !== undefined) {
        throw Object.assign(new Error('sert bağ simülasyonu'), { code: atomikDurum.linkKodu });
      }
      await asil.link(eski, yeni);
    },
    realpath: async (...argumanlar: Parameters<typeof asil.realpath>) => {
      await atomikDurum.realpathOncesi?.(String(argumanlar[0]));
      const sonuc = await asil.realpath(...argumanlar);
      return atomikDurum.realpathSonucu?.(String(argumanlar[0]), String(sonuc)) ?? sonuc;
    },
    open: async (...argumanlar: Parameters<typeof asil.open>) => {
      const kod = atomikDurum.openKodu?.(String(argumanlar[0]), argumanlar[1]);
      if (kod !== undefined) throw Object.assign(new Error(`${kod}: open simülasyonu`), { code: kod, syscall: 'open' });
      const tutamac = await asil.open(...argumanlar);
      const yol = String(argumanlar[0]);
      const kilitMi = argumanlar[1] === 'wx' && basename(yol).startsWith('.lock-');
      const sonrasi = atomikDurum.kilitYazimSonrasi;
      const oncesi = atomikDurum.kilitYazimOncesi;
      const yazKodu = atomikDurum.kilitYazKodu;
      if ((sonrasi !== undefined || oncesi !== undefined || yazKodu !== undefined) && kilitMi) {
        const asilYaz = tutamac.writeFile.bind(tutamac);
        tutamac.writeFile = async (...veri: Parameters<typeof tutamac.writeFile>) => {
          await oncesi?.(yol);
          if (yazKodu !== undefined) {
            throw Object.assign(new Error(`${yazKodu}: write simülasyonu`), { code: yazKodu, syscall: 'write' });
          }
          await asilYaz(...veri);
          await sonrasi?.(yol);
        };
      }
      const kapatKodu = atomikDurum.kilitKapatKodu;
      if (kapatKodu !== undefined && kilitMi) {
        const asilKapat = tutamac.close.bind(tutamac);
        tutamac.close = async () => {
          await asilKapat();
          throw Object.assign(new Error(`${kapatKodu}: close simülasyonu`), { code: kapatKodu, syscall: 'close' });
        };
      }
      return tutamac;
    },
    access: async (yol: Parameters<typeof asil.access>[0], mod?: number) => {
      if (atomikDurum.accessYokKosulu?.(String(yol)) === true) {
        throw Object.assign(new Error('erişim simülasyonu'), { code: 'ENOENT' });
      }
      await asil.access(yol, mod);
    },
  };
});

import {
  FileNotFound,
  InvalidId,
  SAKLANAN_KOSU,
  hataPaketiCikisYolu,
  HataAnaliziSemasi,
  HataPaketiSemasi,
  HaritaSemasi,
  CredentialsRollbackFailed,
  CredentialsTxnInProgress,
  KimlikSemasi,
  KobayConfigSemasi,
  KobayDizini,
  KosuSonucuSemasi,
  OneriSemasi,
  BundleIncomplete,
  UnsafeBundlePath,
  UnsafeOutputPath,
  PublishCleanupFailed,
  PlanDosyasiSemasi,
  depoyuBuda,
  SchemaError,
  TestKaydiSemasi,
  jsonOku,
  yazAtomik,
  type HataPaketi,
  type KobayConfig,
  type TestKaydi,
} from '../../src/depo/index.js';
import { BundleLockConflict, BundleLockLost, BundleLockTimeout, PAKET_KILIDI } from '../../src/depo/paket-kilidi.js';

/** `paket-yolu.ts` içindeki yeniden bakış sınırı; değişirse testler bilerek kırılsın. */
const YENIDEN_BAKIS = 10;

async function geciciDizin(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kobay-depo-'));
}

const PAKET_KILIDI_VARSAYILAN = { ...PAKET_KILIDI };

afterEach(() => {
  Object.assign(PAKET_KILIDI, PAKET_KILIDI_VARSAYILAN);
  atomikDurum.renameDussun = false;
  atomikDurum.renameKosulu = undefined;
  atomikDurum.renameKodu = undefined;
  atomikDurum.rmKosulu = undefined;
  atomikDurum.accessYokKosulu = undefined;
  atomikDurum.linkKodu = undefined;
  atomikDurum.renameSonrasi = undefined;
  atomikDurum.realpathOncesi = undefined;
  atomikDurum.realpathSonucu = undefined;
  atomikDurum.renameHatasi = undefined;
  atomikDurum.openKodu = undefined;
  atomikDurum.kilitYazimSonrasi = undefined;
  atomikDurum.renameOncesi = undefined;
  atomikDurum.kilitKapatKodu = undefined;
  atomikDurum.kilitYazimOncesi = undefined;
  atomikDurum.kilitYazKodu = undefined;
  atomikDurum.donusum = 0;
});

const gizliDosyaModu = process.platform === 'win32' ? 0o666 : 0o600;

const config: KobayConfig = {
  baseUrl: 'http://localhost:3000',
  brain: { adaptor: 'sahte' },
};

const yonetilenGitignore = `# >>> kobay managed >>>
credentials.json
runs/
storageState.json
.stale-*
.eski-*
.credentials-txn*
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

  it('olmayan JSON için FileNotFound, geçersiz JSON için SchemaError fırlatır', async () => {
    const dizin = await geciciDizin();
    await expect(jsonOku(join(dizin, 'yok.json'), KimlikSemasi)).rejects.toBeInstanceOf(FileNotFound);
    const yol = join(dizin, 'bozuk.json');
    await writeFile(yol, '{');
    await expect(jsonOku(yol, KimlikSemasi)).rejects.toBeInstanceOf(SchemaError);
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
    ['Kimlik', KimlikSemasi, { username: 'a' }],
    ['PlanDosyasi', PlanDosyasiSemasi, { projectId: ' ', type: 'frontend', name: 'x', planSteps: [] }],
  ])('%s geçersiz örneği reddeder', (_ad, sema, gecersiz) => {
    expect(v.safeParse(sema, gecersiz).success).toBe(false);
  });
});

describe('KobayDizini', () => {
  it('gitignore, credentials ve storage state izinlerini yazar', async () => {
    const proje = await geciciDizin();
    const dizin = await KobayDizini.ac(proje, config);
    await dizin.kimlikYaz({ username: 'demo', password: 'gizli' });
    await dizin.storageStateYaz('{"cookies":[]}');

    await expect(readFile(dizin.yol('.gitignore'), 'utf8')).resolves.toBe(
      yonetilenGitignore,
    );
    expect(((await stat(dizin.yol('credentials.json'))).mode & 0o777)).toBe(gizliDosyaModu);
    expect(((await stat(dizin.storageStateYolu())).mode & 0o777)).toBe(gizliDosyaModu);
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

  // Windows chmod ile dizini yazılamaz yapmadığı için bu POSIX izin davranışı atlanır.
  it.skipIf(process.platform === 'win32')('gitignore yazılamayan dizinde komut düşmez, uyarı verir', async () => {
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
    await expect(dizin.hataPaketiOku('t_yarim000')).rejects.toBeInstanceOf(BundleIncomplete);
  });

  it('hata paketinde meta.json dosyasını en son tamamlar ve geri okur', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const yazilan = await dizin.hataPaketiYaz(paket(), []);
    await expect(readFile(join(yazilan, 'meta.json'), 'utf8')).resolves.toContain('"writtenAt"');
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
  });

  it('yol geçişi içeren kimlikleri okuma, yazma ve silmede reddeder', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const oncekiConfig = await readFile(dizin.yol('config.json'), 'utf8');

    expect(() => dizin.testOku('../config')).toThrow(InvalidId);
    await expect(dizin.testYaz({ id: '../config' } as TestKaydi)).rejects.toBeInstanceOf(InvalidId);
    await expect(dizin.testSil('../config')).rejects.toBeInstanceOf(InvalidId);

    await expect(readFile(dizin.yol('config.json'), 'utf8')).resolves.toBe(oncekiConfig);
  });

  it('diğer test ve koşu kimliği girişlerinde yol geçişini reddeder', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const sonuc = paket().result;

    expect(() => dizin.kodYolu('../config')).toThrow(InvalidId);
    await expect(dizin.kodOku('../config')).rejects.toBeInstanceOf(InvalidId);
    await expect(dizin.kodYaz('../config', 'x')).rejects.toBeInstanceOf(InvalidId);
    await expect(dizin.kosuDizini('../config')).rejects.toBeInstanceOf(InvalidId);
    expect(() => dizin.kosuSonucuOku('../config')).toThrow(InvalidId);
    await expect(dizin.kosuListele('../config')).rejects.toBeInstanceOf(InvalidId);
    await expect(dizin.kosuSonucuYaz({ ...sonuc, runId: '../config' })).rejects.toBeInstanceOf(InvalidId);
    await expect(dizin.hataPaketiYaz({ ...paket(), testId: '../config' }, [])).rejects.toBeInstanceOf(InvalidId);
    await expect(dizin.hataPaketiOku('../config')).rejects.toBeInstanceOf(InvalidId);
    await expect(dizin.hataPaketiKopyala('../config', join(await geciciDizin(), 'kopya'))).rejects.toBeInstanceOf(InvalidId);
  });

  /** `.tmp-*` / `.stale-*` artıkları; yarış sonrası ikisi de boş kalmalı. */
  async function artiklar(kok: string): Promise<string[]> {
    return (await readdir(kok)).filter((ad) => ad.startsWith('.tmp-') || ad.startsWith('.stale-'));
  }

  /** Yayımlanacak geçici paket klasörü mü (içindeki atomik yazım dosyaları değil). */
  function tmpKlasoruMu(yol: string): boolean {
    return basename(yol).startsWith('.tmp-');
  }

  /**
   * Windows'un `MoveFileExW` davranışını taklit eder: geçici klasör dolu bir
   * hedefin üstüne taşınırsa ENOTEMPTY yerine EPERM düşer.
   */
  function windowsRenameTaklidi(): void {
    atomikDurum.renameHatasi = (eski, yeni, hata) => {
      const kod = (hata as { code?: unknown }).code;
      if (!tmpKlasoruMu(eski)) return hata;
      // Gerçek Windows dolu klasöre taşımada zaten EPERM (ya da EACCES) verir:
      // çevrilecek bir şey yoktur ama çarpışma görülmüştür, o da sayılır.
      if (kod === 'EPERM' || kod === 'EACCES') {
        atomikDurum.donusum += 1;
        return hata;
      }
      if (kod !== 'ENOTEMPTY' && kod !== 'EEXIST') return hata;
      atomikDurum.donusum += 1;
      return Object.assign(new Error(`EPERM: operation not permitted, rename '${eski}' -> '${yeni}'`), {
        code: 'EPERM',
        syscall: 'rename',
      });
    };
  }

  it.each([
    ['yerel dosya sistemi', false],
    ['Windows EPERM taklidi', true],
  ])('eşzamanlı hata paketi yazımlarından birini eksiksiz yayımlar (%s)', async (_ad, windows) => {
    if (windows) windowsRenameTaklidi();
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const yazicilar = [1, 2, 3].map((n) => ({ ...paket(), snapshotId: `s_${n}`, code: `test("${n}", async () => {});` }));

    const rakip = { ...paket(), snapshotId: 's_rakip' };
    // Kilit kobay yazıcılarını sıraya soktuğu için aralarında hedef çarpışması
    // olmaz. Windows dönüşümü (dolu hedefe taşıma → EPERM) anlamlı kalsın diye bu
    // varyantta her tura kilit tutmayan ham bir rakip (ör. eski bir kobay) katılır.
    const hamRakip = async (): Promise<void> => {
      const gecici = dizin.yol('failure', `.tmp-t_abc12345-rakip-${String(Math.random()).slice(2)}`);
      await mkdir(gecici);
      await writeFile(join(gecici, 'failure.json'), JSON.stringify(rakip));
      await rename(gecici, dizin.yol('failure', 't_abc12345')).catch(async () => {
        await rm(gecici, { recursive: true, force: true });
      });
    };

    // Tek tur yarışı her koşuda yakalamaz; çok turla Windows CI de her seferinde görür.
    for (let tur = 0; tur < 50; tur += 1) {
      await Promise.all([
        ...yazicilar.map((yazici) => dizin.hataPaketiYaz(yazici, [])),
        ...(windows ? [hamRakip()] : []),
      ]);

      const yayimlanan = await dizin.hataPaketiOku('t_abc12345');
      expect([...yazicilar, rakip]).toContainEqual(yayimlanan);
      if (!windows) expect(yazicilar).toContainEqual(yayimlanan);
      expect(await artiklar(dizin.yol('failure'))).toEqual([]);
    }
    if (windows) expect(atomikDurum.donusum).toBeGreaterThan(0);
  });

  it('yayımlama rename\'i dolu hedefte EPERM verirse yarışı kaybetmiş sayar ve yeniden dener', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const hedef = dizin.yol('failure', 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    windowsRenameTaklidi();
    // Bu yazıcı eski paketi kenara aldıktan hemen sonra kilit tutmayan bir rakip
    // (ör. eski bir kobay sürümü) hedefe tam bir paket koyar. Rakip bu süreçteki
    // `hataPaketiYaz` olamaz: kilit bu yazıcıda olduğu için sonsuza dek beklerdi.
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (eski !== hedef || !yeni.includes('.stale-')) return;
      atomikDurum.renameSonrasi = undefined;
      await rakipKoy(hedef, 'tam');
    };

    const ikinci = { ...paket(), snapshotId: 's_2' };
    await expect(dizin.hataPaketiYaz(ikinci, [])).resolves.toBe(hedef);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(ikinci);
    expect(await artiklar(dizin.yol('failure'))).toEqual([]);
    // Dolu hedefe taşıma gerçekten ENOTEMPTY verdi ve taklit onu EPERM'e çevirdi.
    expect(atomikDurum.donusum).toBe(1);
  });

  it('hedef yokken kalıcı EPERM: hata verir, geçici klasörü siler, eski paketi geri koyar', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const hedef = dizin.yol('failure', 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    atomikDurum.renameKosulu = (eski, yeni) => tmpKlasoruMu(eski) && yeni === hedef;
    atomikDurum.renameKodu = 'EPERM';

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).rejects.toMatchObject({ code: 'EPERM' });
    expect(await artiklar(dizin.yol('failure'))).toEqual([]);
    atomikDurum.renameKosulu = undefined;
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
  });

  it('ilk paket kalıcı EPERM ile yazılamazsa geçici klasör kalmaz', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    atomikDurum.renameKosulu = (eski) => tmpKlasoruMu(eski);
    atomikDurum.renameKodu = 'EBUSY';

    await expect(dizin.hataPaketiYaz(paket(), [])).rejects.toMatchObject({ code: 'EBUSY' });
    expect(await readdir(dizin.yol('failure'))).toEqual([]);
  });

  it('hedef yokken geçici EPERM (kilit) birkaç denemede aşılır', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    let kalan = 3;
    atomikDurum.renameKosulu = (eski) => tmpKlasoruMu(eski) && (kalan -= 1) >= 0;
    atomikDurum.renameKodu = 'EPERM';

    const ikinci = { ...paket(), snapshotId: 's_2' };
    await expect(dizin.hataPaketiYaz(ikinci, [])).resolves.toBe(dizin.yol('failure', 't_abc12345'));
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(ikinci);
    expect(await artiklar(dizin.yol('failure'))).toEqual([]);
  });

  /**
   * Rakibin hedefe bıraktığı klasör: `tam` ise `hataPaketiOku`'nun kabul ettiği
   * biçimde (failure.json var, .partial yok); `partial` ise failure.json var ama
   * `.partial` işareti duruyor; `tanimsiz` ise failure.json bile yok.
   */
  async function rakipKoy(hedef: string, tur: 'tam' | 'partial' | 'tanimsiz'): Promise<void> {
    await mkdir(hedef);
    await writeFile(join(hedef, 'rakip.txt'), 'rakip');
    if (tur !== 'tanimsiz') await writeFile(join(hedef, 'failure.json'), JSON.stringify({ ...paket(), snapshotId: 's_rakip' }));
    if (tur === 'partial') await writeFile(join(hedef, '.partial'), '');
  }

  it.each([
    ['failure', 'tanimsiz'],
    ['failure-out', 'tanimsiz'],
    ['failure', 'partial'],
    ['failure-out', 'partial'],
  ] as const)('%s: hedefi her turda yarım bir klasör (%s) doldurursa son sağlam kopya silinmez, yeri hatada bildirilir', async (kokAdi, rakipTuru) => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const cikis = kokAdi === 'failure-out';
    const hedef = cikis ? hataPaketiCikisYolu(kok, 't_abc12345') : dizin.yol('failure', 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    if (cikis) await dizin.hataPaketiKopyala('t_abc12345', hedef);
    windowsRenameTaklidi();
    // Her kenara almadan sonra hedefe yarım bir klasör konur: bu yazıcı hep kaybeder.
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (eski !== hedef || !yeni.includes('.stale-')) return;
      await rakipKoy(hedef, rakipTuru);
    };

    const hata: unknown = await (cikis
      ? dizin.hataPaketiKopyala('t_abc12345', hedef)
      : dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).catch((h: unknown) => h);
    expect(hata).toBeInstanceOf(PublishCleanupFailed);
    expect((hata as PublishCleanupFailed).message)
      .toContain(cikis ? 'Failure bundle could not be copied: t_abc12345' : 'Failure bundle could not be published: t_abc12345');
    const kenar = (hata as PublishCleanupFailed).keptAt ?? '';
    // Korunan, ilk turda kenara alınan sağlam s_1 paketi; rakiplerin yarım klasörleri değil.
    await expect(readFile(join(kenar, 'failure.json'), 'utf8')).resolves.toContain('"s_1"');
    expect(await artiklar(dizin.yol(kokAdi))).toEqual([basename(kenar)]);
    await expect(readFile(join(hedef, 'rakip.txt'), 'utf8')).resolves.toBe('rakip');    expect(atomikDurum.donusum).toBeGreaterThan(0);
  });

  it.each(['failure', 'failure-out'] as const)('%s: hedefi her turda tam bir rakip paket doldurursa vazgeçer, ne .tmp-* ne .stale-* kalır', async (kokAdi) => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const cikis = kokAdi === 'failure-out';
    const hedef = cikis ? hataPaketiCikisYolu(kok, 't_abc12345') : dizin.yol('failure', 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    if (cikis) await dizin.hataPaketiKopyala('t_abc12345', hedef);
    windowsRenameTaklidi();
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (eski !== hedef || !yeni.includes('.stale-')) return;
      await rakipKoy(hedef, 'tam');
    };

    const yazim = cikis
      ? dizin.hataPaketiKopyala('t_abc12345', hedef)
      : dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
    await expect(yazim).rejects.toThrow(cikis
      ? 'Failure bundle could not be copied: t_abc12345'
      : 'Failure bundle could not be published: t_abc12345');
    await expect(yazim).rejects.not.toBeInstanceOf(PublishCleanupFailed);
    expect(await artiklar(dizin.yol(kokAdi))).toEqual([]);
    await expect(readFile(join(hedef, 'failure.json'), 'utf8')).resolves.toContain('"s_rakip"');    expect(atomikDurum.donusum).toBeGreaterThan(0);
  });

  it('geri koyma da düşerse hata yutulmaz: PublishCleanupFailed, eski paket kenarda korunur', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const hedef = dizin.yol('failure', 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    // Yeni paket hedefe hiç taşınamaz; eski paketi geri koyma da kalıcı kilitte.
    atomikDurum.renameKosulu = (eski, yeni) => yeni === hedef && (tmpKlasoruMu(eski) || basename(eski).startsWith('.stale-'));
    atomikDurum.renameKodu = 'EPERM';

    const hata: unknown = await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []).catch((h: unknown) => h);
    expect(hata).toBeInstanceOf(PublishCleanupFailed);
    const kenar = (hata as PublishCleanupFailed).keptAt ?? '';
    expect(hata).toMatchObject({ code: 'EPERM' });
    expect((hata as PublishCleanupFailed).errors).toHaveLength(2);
    expect(basename(kenar)).toMatch(/^\.stale-t_abc12345-/);
    // Tek sağlam kopya silinmez; geçici klasör yine temizlenir.
    await expect(readFile(join(kenar, 'failure.json'), 'utf8')).resolves.toContain('"s_1"');
    expect(await artiklar(dizin.yol('failure'))).toEqual([basename(kenar)]);
  });

  it('kenara alma rename\'i kısa süre kilitliyse (Windows) yeniden denenir', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const hedef = dizin.yol('failure', 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    let kalan = 3;
    atomikDurum.renameKosulu = (eski, yeni) => eski === hedef && basename(yeni).startsWith('.stale-') && (kalan -= 1) >= 0;
    atomikDurum.renameKodu = 'EBUSY';

    const ikinci = { ...paket(), snapshotId: 's_2' };
    await expect(dizin.hataPaketiYaz(ikinci, [])).resolves.toBe(hedef);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(ikinci);
    expect(kalan).toBeLessThan(0);
    expect(await artiklar(dizin.yol('failure'))).toEqual([]);
  });

  it('kenara alma kalıcı kilitliyse vazgeçer; yayımlanmış paket yerinde, artık kalmaz', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const hedef = dizin.yol('failure', 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    atomikDurum.renameKosulu = (eski, yeni) => eski === hedef && basename(yeni).startsWith('.stale-');
    atomikDurum.renameKodu = 'EPERM';

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).rejects.toMatchObject({ code: 'EPERM' });
    atomikDurum.renameKosulu = undefined;
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
    expect(await artiklar(dizin.yol('failure'))).toEqual([]);
  });

  it('failure-out: dolu hedefte EPERM yarışı kaybetmek sayılır, kopya tamamlanır', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const hedef = hataPaketiCikisYolu(kok, 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    await dizin.hataPaketiKopyala('t_abc12345', hedef);
    await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
    windowsRenameTaklidi();
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (eski !== hedef || !yeni.includes('.stale-')) return;
      atomikDurum.renameSonrasi = undefined;
      await mkdir(hedef);
      await writeFile(join(hedef, 'rakip.txt'), 'rakip');
    };

    await dizin.hataPaketiKopyala('t_abc12345', hedef);

    const kopya = await jsonOku(join(hedef, 'failure.json'), HataPaketiSemasi);
    expect(kopya.snapshotId).toBe('s_2');
    expect(await artiklar(dizin.yol('failure-out'))).toEqual([]);
  });

  it('failure-out: hedef yokken kalıcı EPERM hata verir, eski kopya geri konur, geçici klasör kalmaz', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const hedef = hataPaketiCikisYolu(kok, 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    await dizin.hataPaketiKopyala('t_abc12345', hedef);
    await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
    atomikDurum.renameKosulu = (eski, yeni) => tmpKlasoruMu(eski) && yeni === hedef;
    atomikDurum.renameKodu = 'EACCES';

    await expect(dizin.hataPaketiKopyala('t_abc12345', hedef)).rejects.toMatchObject({ code: 'EACCES' });
    expect(await artiklar(dizin.yol('failure-out'))).toEqual([]);
    const kopya = await jsonOku(join(hedef, 'failure.json'), HataPaketiSemasi);
    expect(kopya.snapshotId).toBe('s_1');
  });

  it('failure-out: hedef yokken geçici EBUSY birkaç denemede aşılır', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const hedef = hataPaketiCikisYolu(kok, 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    let kalan = 2;
    atomikDurum.renameKosulu = (eski) => tmpKlasoruMu(eski) && (kalan -= 1) >= 0;
    atomikDurum.renameKodu = 'EBUSY';

    await dizin.hataPaketiKopyala('t_abc12345', hedef);

    const kopya = await jsonOku(join(hedef, 'failure.json'), HataPaketiSemasi);
    expect(kopya.snapshotId).toBe('s_1');
    expect(await artiklar(dizin.yol('failure-out'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('hata paketi yazımı .kobay/failure symlink ise hiç başlamaz', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const dis = await geciciDizin();
    await mkdir(join(dis, 't_abc12345'));
    await writeFile(join(dis, 't_abc12345', 'kurban.txt'), 'dokunma');
    await rm(dizin.yol('failure'), { recursive: true, force: true });
    await symlink(dis, dizin.yol('failure'));

    await expect(dizin.hataPaketiYaz(paket(), [])).rejects.toBeInstanceOf(UnsafeBundlePath);
    await expect(readFile(join(dis, 't_abc12345', 'kurban.txt'), 'utf8')).resolves.toBe('dokunma');
  });

  it.skipIf(process.platform === 'win32')('hata paketi rename sonrası yol symlink olursa eski paketi silmez', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const tasinan = join(await geciciDizin(), 'failure-gercek');

    // Yeni paket yerine konduktan hemen sonra, silmeden önce `.kobay/failure`
    // dışarıdaki bir klasörü gösteren symlink'e çevrilir.
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (!eski.includes('.tmp-') || yeni !== dizin.yol('failure', 't_abc12345')) return;
      atomikDurum.renameSonrasi = undefined;
      await rename(dizin.yol('failure'), tasinan);
      await symlink(tasinan, dizin.yol('failure'));
    };

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []))
      .rejects.toBeInstanceOf(UnsafeBundlePath);
    const kalanlar = (await readdir(tasinan)).filter((ad) => ad.startsWith('.stale-t_abc12345-'));
    expect(kalanlar).toHaveLength(1);
    await expect(readFile(join(tasinan, kalanlar[0] ?? '', 'failure.json'), 'utf8')).resolves.toContain('"s_1"');
  });

  it('hata paketi yeniden denetiminde hedef başka yazıcının rename\'iyle kaybolursa hata vermez', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = dizin.yol('failure', 't_abc12345');
    const rakipStale = dizin.yol('failure', '.stale-t_abc12345-rakip');

    // Yeni paket yerine konduktan sonra, yeniden denetimin `lstat`'i hedefi
    // görür; `realpath`'ten hemen önce rakip yazıcı hedefi `.stale-*`e taşır.
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (!eski.includes('.tmp-') || yeni !== hedef) return;
      atomikDurum.renameSonrasi = undefined;
      atomikDurum.realpathOncesi = async (yol) => {
        if (yol !== hedef) return;
        atomikDurum.realpathOncesi = undefined;
        await rename(hedef, rakipStale);
      };
    };

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).resolves.toBe(hedef);
    await expect(readFile(join(rakipStale, 'failure.json'), 'utf8')).resolves.toContain('"s_2"');
  });

  it.skipIf(process.platform === 'win32')('hata paketi yeniden denetiminde kaybolan hedefin yerine symlink gelirse reddeder', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = dizin.yol('failure', 't_abc12345');
    const dis = await geciciDizin();
    await writeFile(join(dis, 'kurban.txt'), 'dokunma');

    // `realpath` hedefi yok görür (ENOENT); o arada hedefin yerine dışarıyı
    // gösteren symlink konur. Yeniden bakış bunu yakalamalı.
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (!eski.includes('.tmp-') || yeni !== hedef) return;
      atomikDurum.renameSonrasi = undefined;
      atomikDurum.realpathOncesi = async (yol) => {
        if (yol !== hedef) return;
        atomikDurum.realpathOncesi = undefined;
        await rm(hedef, { recursive: true, force: true });
        await symlink(dis, hedef);
        throw Object.assign(new Error('realpath simülasyonu'), { code: 'ENOENT' });
      };
    };

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []))
      .rejects.toBeInstanceOf(UnsafeBundlePath);
    await expect(readFile(join(dis, 'kurban.txt'), 'utf8')).resolves.toBe('dokunma');
    const kalanlar = (await readdir(dizin.yol('failure'))).filter((ad) => ad.startsWith('.stale-t_abc12345-'));
    expect(kalanlar).toHaveLength(1);
  });

  /** `failure/` kökünün gerçek yolu altında, hedefin kardeşi olan bir `.stale-*` adı. */
  async function kardesYol(kok: string): Promise<string> {
    return join(await realpath(kok), '.stale-t_abc12345-rakip');
  }

  it('yeniden denetimde realpath kardeş .stale-* adını verirse yanlış alarm vermez, yeniden bakar', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = dizin.yol('failure', 't_abc12345');
    const kardes = await kardesYol(dizin.yol('failure'));
    let kardesVerildi = 0;
    // Rakip yazıcı tam `realpath` sırasında hedefi kenara almış gibi: sonuç kardeş ad.
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (!tmpKlasoruMu(eski) || yeni !== hedef) return;
      atomikDurum.renameSonrasi = undefined;
      atomikDurum.realpathSonucu = (yol, sonuc) => {
        if (yol !== hedef || kardesVerildi > 0) return sonuc;
        kardesVerildi += 1;
        return kardes;
      };
    };

    const ikinci = { ...paket(), snapshotId: 's_2' };
    await expect(dizin.hataPaketiYaz(ikinci, [])).resolves.toBe(hedef);
    expect(kardesVerildi).toBe(1);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(ikinci);
    expect(await artiklar(dizin.yol('failure'))).toEqual([]);
  });

  it('kardeş sonucu hiç düzelmezse kabul etmez: deneme sınırında reddeder, eskiyi silmez', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = dizin.yol('failure', 't_abc12345');
    const kardes = await kardesYol(dizin.yol('failure'));
    let cagri = 0;
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (!tmpKlasoruMu(eski) || yeni !== hedef) return;
      atomikDurum.renameSonrasi = undefined;
      atomikDurum.realpathSonucu = (yol, sonuc) => {
        if (yol !== hedef) return sonuc;
        cagri += 1;
        return kardes;
      };
    };

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []))
      .rejects.toThrow(/kept changing while being checked/);
    // Sınır tam olarak 10 bakıştır; ne erken kabul ne sonsuz döngü.
    expect(cagri).toBe(YENIDEN_BAKIS);
    expect((await artiklar(dizin.yol('failure'))).filter((ad) => ad.startsWith('.stale-'))).toHaveLength(1);
  });

  it('realpath kökün doğrudan çocuğu olmayan bir yer verirse yeniden denemeden reddeder', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = dizin.yol('failure', 't_abc12345');
    // `.kobay/failure` altında ama bir kat derinde; ya da `.kobay`'ın başka bir çocuğu.
    for (const disari of [
      join(await realpath(dizin.yol('failure')), 't_zzz99999', 't_abc12345'),
      join(await realpath(dizin.kok), 'failure-out', 't_abc12345'),
    ]) {
      let cagri = 0;
      atomikDurum.realpathSonucu = (yol, sonuc) => {
        if (yol !== hedef) return sonuc;
        cagri += 1;
        return disari;
      };
      await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []))
        .rejects.toThrow(/its real path is not under \.kobay\/failure\)/);
      expect(cagri).toBe(1);
      atomikDurum.realpathSonucu = undefined;
    }
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
  });

  // Symlink her bakışta yeniden denetlenmeli: ilk, orta ve son (10.) bakıştan önce enjekte edilir.
  it('kök dışı reddi tanıyı mesajın kendisinde taşır (CI günlüğünden okunabilsin)', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = dizin.yol('failure', 't_abc12345');
    const gercekKok = await realpath(dizin.yol('failure'));
    const disari = join(gercekKok, 't_zzz99999', 't_abc12345');
    atomikDurum.realpathSonucu = (yol, sonuc) => (yol === hedef ? disari : sonuc);

    const hata: unknown = await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []).catch((h: unknown) => h);
    expect(hata).toBeInstanceOf(UnsafeBundlePath);
    const mesaj = (hata as Error).message;
    expect(mesaj).toMatch(/its real path is not under \.kobay\/failure\)/);
    expect(mesaj).toContain(`real root ${JSON.stringify(gercekKok)}`);
    expect(mesaj).toContain(`expected ${JSON.stringify(join(gercekKok, 't_abc12345'))}`);
    expect(mesaj).toContain(`resolved ${JSON.stringify(disari)}`);
    expect(String((hata as Error).stack)).toContain(`resolved ${JSON.stringify(disari)}`);
    expect((hata as { details?: unknown }).details).toMatchObject({ gercekHedef: disari });
  });

  it.skipIf(process.platform === 'win32').each([1, 5, YENIDEN_BAKIS - 1])(
    '%i kardeş sonucundan sonra hedef symlink olmuşsa yeniden bakış reddeder',
    async (kardesSayisi) => {
      const dizin = await KobayDizini.ac(await geciciDizin(), config);
      await dizin.hataPaketiYaz(paket(), []);
      const hedef = dizin.yol('failure', 't_abc12345');
      const kardes = await kardesYol(dizin.yol('failure'));
      const dis = await geciciDizin();
      await writeFile(join(dis, 'kurban.txt'), 'dokunma');
      let cagri = 0;
      atomikDurum.renameSonrasi = async (eski, yeni) => {
        if (!tmpKlasoruMu(eski) || yeni !== hedef) return;
        atomikDurum.renameSonrasi = undefined;
        atomikDurum.realpathOncesi = async (yol) => {
          if (yol !== hedef || cagri + 1 !== kardesSayisi) return;
          // Son kardeş sonucu dönerken hedefin yerine dışarıyı gösteren symlink konur.
          await rename(hedef, kardes);
          await symlink(dis, hedef);
        };
        atomikDurum.realpathSonucu = (yol, sonuc) => {
          if (yol !== hedef) return sonuc;
          cagri += 1;
          return kardes;
        };
      };

      await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []))
        .rejects.toThrow(/the bundle directory is a symlink/);
      // Symlink, tam olarak bir sonraki bakışın `lstat`'inde yakalanır.
      expect(cagri).toBe(kardesSayisi);
      await expect(readFile(join(dis, 'kurban.txt'), 'utf8')).resolves.toBe('dokunma');
    },
  );

  it.skipIf(process.platform === 'win32')('silinecek kenara alınmış klasör symlink\'e çevrilmişse hiçbiri silinmez, dışarısı durur', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = dizin.yol('failure', 't_abc12345');
    const dis = await geciciDizin();
    await writeFile(join(dis, 'kurban.txt'), 'dokunma');
    let kenar = '';
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (eski === hedef && basename(yeni).startsWith('.stale-')) kenar = yeni;
      if (!tmpKlasoruMu(eski) || yeni !== hedef) return;
      atomikDurum.renameSonrasi = undefined;
      await rm(kenar, { recursive: true, force: true });
      await symlink(dis, kenar);
    };

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []))
      .rejects.toThrow(/the set-aside folder is not a directory, or is a symlink/);
    await expect(readFile(join(dis, 'kurban.txt'), 'utf8')).resolves.toBe('dokunma');
  });

  it('failure-out: yeniden denetimde realpath kardeş ad verirse kopya yine tamamlanır', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const hedef = hataPaketiCikisYolu(kok, 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    await dizin.hataPaketiKopyala('t_abc12345', hedef);
    await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
    const kardes = await kardesYol(dizin.yol('failure-out'));
    let kardesVerildi = 0;
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (!tmpKlasoruMu(eski) || yeni !== hedef) return;
      atomikDurum.renameSonrasi = undefined;
      atomikDurum.realpathSonucu = (yol, sonuc) => {
        if (yol !== hedef || kardesVerildi > 0) return sonuc;
        kardesVerildi += 1;
        return kardes;
      };
    };

    await dizin.hataPaketiKopyala('t_abc12345', hedef);

    expect(kardesVerildi).toBe(1);
    expect((await jsonOku(join(hedef, 'failure.json'), HataPaketiSemasi)).snapshotId).toBe('s_2');
    expect(await artiklar(dizin.yol('failure-out'))).toEqual([]);
  });

  /** Windows'ta libuv'nin `realpath` sırasında yer değiştiren hedef için verdiği hata. */
  function realpathHatasi(code: string): Error {
    return Object.assign(new Error(`${code}: realpath simülasyonu`), { code, syscall: 'realpath' });
  }

  /**
   * Yeni paket hedefe konduktan sonra yeniden denetimdeki `realpath(hedef)`
   * çağrılarını sayar; `kacinci` (1'den) için `hata` döndürürse o kod fırlatılır.
   */
  function yenidenDenetimdeRealpath(hedef: string, kacinci: (cagri: number) => string | undefined): { cagri: number } {
    const sayac = { cagri: 0 };
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (!tmpKlasoruMu(eski) || yeni !== hedef) return;
      atomikDurum.renameSonrasi = undefined;
      atomikDurum.realpathSonucu = (yol, sonuc) => {
        if (yol !== hedef) return sonuc;
        sayac.cagri += 1;
        const kod = kacinci(sayac.cagri);
        if (kod !== undefined) throw realpathHatasi(kod);
        return sonuc;
      };
    };
    return sayac;
  }

  it.each([1, YENIDEN_BAKIS - 1])('yeniden denetimde %i kez geçici EBADF (Windows) yeniden bakışla aşılır', async (kez) => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = dizin.yol('failure', 't_abc12345');
    const sayac = yenidenDenetimdeRealpath(hedef, (cagri) => (cagri <= kez ? 'EBADF' : undefined));

    const ikinci = { ...paket(), snapshotId: 's_2' };
    await expect(dizin.hataPaketiYaz(ikinci, [])).resolves.toBe(hedef);
    expect(sayac.cagri).toBe(kez + 1);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(ikinci);
    expect(await artiklar(dizin.yol('failure'))).toEqual([]);
  });

  it('kalıcı EBADF kabul edilmez: sınır dolunca özgün EBADF ile düşer, eskiyi silmez', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = dizin.yol('failure', 't_abc12345');
    const sayac = yenidenDenetimdeRealpath(hedef, () => 'EBADF');

    const hata: unknown = await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []).catch((h: unknown) => h);
    expect(hata).toMatchObject({ code: 'EBADF', syscall: 'realpath' });
    expect(sayac.cagri).toBe(YENIDEN_BAKIS);
    expect((await artiklar(dizin.yol('failure'))).filter((ad) => ad.startsWith('.stale-'))).toHaveLength(1);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY', 'EIO'])('realpath %s verirse yeniden bakılmaz, özgün hatayla düşer', async (kod) => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = dizin.yol('failure', 't_abc12345');
    const sayac = yenidenDenetimdeRealpath(hedef, () => kod);

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).rejects.toMatchObject({ code: kod });
    expect(sayac.cagri).toBe(1);
  });

  it.skipIf(process.platform === 'win32').each([1, YENIDEN_BAKIS - 1])(
    '%i geçici EBADF\'den sonra hedef symlink olmuşsa yeniden bakış reddeder',
    async (ebadfSayisi) => {
      const dizin = await KobayDizini.ac(await geciciDizin(), config);
      await dizin.hataPaketiYaz(paket(), []);
      const hedef = dizin.yol('failure', 't_abc12345');
      const kardes = await kardesYol(dizin.yol('failure'));
      const dis = await geciciDizin();
      await writeFile(join(dis, 'kurban.txt'), 'dokunma');
      const sayac = yenidenDenetimdeRealpath(hedef, () => 'EBADF');
      // Son EBADF'den hemen önce hedefin yerine dışarıyı gösteren symlink konur;
      // yalnız yayım sonrası denetimde (kurulum kancası koşup kendini sildikten sonra).
      atomikDurum.realpathOncesi = async (yol) => {
        if (atomikDurum.renameSonrasi !== undefined) return;
        if (yol !== hedef || sayac.cagri + 1 !== ebadfSayisi) return;
        await rename(hedef, kardes);
        await symlink(dis, hedef);
      };

      await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []))
        .rejects.toThrow(/the bundle directory is a symlink/);
      expect(sayac.cagri).toBe(ebadfSayisi);
      await expect(readFile(join(dis, 'kurban.txt'), 'utf8')).resolves.toBe('dokunma');
    },
  );

  it('failure-out: ön denetimde geçici EBADF yeniden bakışla aşılır, kalıcısı özgün EBADF ile düşer', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const hedef = hataPaketiCikisYolu(kok, 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    await dizin.hataPaketiKopyala('t_abc12345', hedef);

    let cagri = 0;
    atomikDurum.realpathSonucu = (yol, sonuc) => {
      if (yol !== hedef) return sonuc;
      cagri += 1;
      if (cagri <= 2) throw realpathHatasi('EBADF');
      return sonuc;
    };
    await dizin.hataPaketiKopyala('t_abc12345', hedef);
    expect(cagri).toBeGreaterThanOrEqual(3);
    expect(await artiklar(dizin.yol('failure-out'))).toEqual([]);

    cagri = 0;
    atomikDurum.realpathSonucu = (yol, sonuc) => {
      if (yol !== hedef) return sonuc;
      cagri += 1;
      throw realpathHatasi('EBADF');
    };
    await expect(dizin.hataPaketiKopyala('t_abc12345', hedef)).rejects.toMatchObject({ code: 'EBADF' });
    expect(cagri).toBe(YENIDEN_BAKIS);
    expect(await readdir(dizin.yol('failure-out'))).toEqual(['t_abc12345']);
  });

  it('failure-out: ön denetimde hedef rakip kopyalayıcının rename\'iyle kaybolursa hata vermez', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const hedef = hataPaketiCikisYolu(kok, 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    await dizin.hataPaketiKopyala('t_abc12345', hedef);
    const rakipStale = dizin.yol('failure-out', '.stale-t_abc12345-rakip');
    // `lstat` hedefi görür; `realpath`'ten hemen önce rakip hedefi kenara alır (ENOENT).
    atomikDurum.realpathOncesi = async (yol) => {
      if (yol !== hedef) return;
      atomikDurum.realpathOncesi = undefined;
      await rename(hedef, rakipStale);
    };

    await dizin.hataPaketiKopyala('t_abc12345', hedef);
    expect((await jsonOku(join(hedef, 'failure.json'), HataPaketiSemasi)).snapshotId).toBe('s_1');
  });

  it('failure-out: realpath kardeş sonucu hiç düzelmezse UnsafeOutputPath ile reddeder', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const hedef = hataPaketiCikisYolu(kok, 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    await dizin.hataPaketiKopyala('t_abc12345', hedef);
    const kardes = await kardesYol(dizin.yol('failure-out'));
    let cagri = 0;
    atomikDurum.realpathSonucu = (yol, sonuc) => {
      if (yol !== hedef) return sonuc;
      cagri += 1;
      return kardes;
    };

    await expect(dizin.hataPaketiKopyala('t_abc12345', hedef)).rejects.toThrow(/kept changing while being checked/);
    await expect(dizin.hataPaketiKopyala('t_abc12345', hedef)).rejects.toBeInstanceOf(UnsafeOutputPath);
    expect(cagri).toBe(2 * YENIDEN_BAKIS);
    expect(await readdir(dizin.yol('failure-out'))).toEqual(['t_abc12345']);
  });

  /** Kilit dosyası; adı ve yeri ürünle aynı. */
  function kilitYolu(dizin: KobayDizini, kok: 'failure' | 'failure-out' = 'failure'): string {
    return dizin.yol(kok, '.lock-t_abc12345');
  }

  /** Kilit gövdesi; `pid` ve `startedAt` verilen değerlerle. */
  function kilitGovdesi(pid: number, startedAt = new Date().toISOString(), token = 'baskasinin-isareti'): string {
    return JSON.stringify({ pid, token, startedAt });
  }

  it('aynı test kimliğinin ikinci yazıcısı kilit bırakılana dek hedefe ve geçici klasöre dokunmaz', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const hedef = dizin.yol('failure', 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    const olaylar: string[] = [];
    let ikinciYazim: Promise<string> | undefined;
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (tmpKlasoruMu(eski) && yeni === hedef) olaylar.push(`yayım:${olaylar.length}`);
      // Birinci yazıcı eski paketi kenara aldığı an ikinci yazıcı başlar.
      if (eski !== hedef || !basename(yeni).startsWith('.stale-') || ikinciYazim !== undefined) return;
      ikinciYazim = dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_3' }, []);
      await new Promise((coz) => setTimeout(coz, 150));
      // Kilit birincide: ikinci yazıcı geçici klasör bile açmamış olmalı.
      const tmpler = (await readdir(dizin.yol('failure'))).filter((ad) => ad.startsWith('.tmp-'));
      olaylar.push(`bekleme-sonu-tmp:${tmpler.length}`);
    };

    await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
    await expect(ikinciYazim).resolves.toBe(hedef);
    // Birincinin kendi tmp'si duruyordu (1); ikincininki yoktu. İkinci yayım birinciden sonra.
    expect(olaylar).toEqual(['bekleme-sonu-tmp:1', 'yayım:1', 'yayım:2']);
    expect((await dizin.hataPaketiOku('t_abc12345')).snapshotId).toBe('s_3');
    expect(await readdir(dizin.yol('failure'))).toEqual(['t_abc12345']);
  });

  it('aynı süreçteki rakip, gövdesi yeni yazılmış kilidi "bırakılmamış kalıntı" sanıp devralmaz', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    let ikinciYazim: Promise<string> | undefined;
    let kilitBizde: boolean | undefined;
    // Birinci yazıcı kilit gövdesini yazdığı an (aynı pid ile) ikinci yazıcı başlar.
    atomikDurum.kilitYazimSonrasi = async (yol) => {
      if (ikinciYazim !== undefined) return;
      const govde = await readFile(yol, 'utf8');
      ikinciYazim = dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_3' }, []);
      await new Promise((coz) => setTimeout(coz, 150));
      kilitBizde = await readFile(yol, 'utf8').then((simdi) => simdi === govde, () => false);
    };

    await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
    expect(kilitBizde).toBe(true);
    await expect(ikinciYazim).resolves.toBe(dizin.yol('failure', 't_abc12345'));
    expect((await dizin.hataPaketiOku('t_abc12345')).snapshotId).toBe('s_3');
    expect(await readdir(dizin.yol('failure'))).toEqual(['t_abc12345']);
  });

  it('kilit yaşayan başka bir sürecin elindeyse bekleme sınırında açık hata verir, hiçbir şeye dokunmaz', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    PAKET_KILIDI.beklemeMs = 200;
    const govde = kilitGovdesi(process.ppid);
    await writeFile(kilitYolu(dizin), govde);

    const hata: unknown = await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []).catch((h: unknown) => h);
    expect(hata).toBeInstanceOf(BundleLockTimeout);
    expect((hata as Error).message).toContain(`held by pid ${process.ppid}`);
    await expect(readFile(kilitYolu(dizin), 'utf8')).resolves.toBe(govde);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
    expect((await readdir(dizin.yol('failure'))).sort()).toEqual(['.lock-t_abc12345', 't_abc12345']);
  });

  it('failure-out: kilit yaşayan başka sürecin elindeyse kopya bekleme sınırında açık hata verir', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    await dizin.hataPaketiYaz(paket(), []);
    PAKET_KILIDI.beklemeMs = 200;
    await writeFile(kilitYolu(dizin, 'failure-out'), kilitGovdesi(process.ppid));

    await expect(dizin.hataPaketiKopyala('t_abc12345', hataPaketiCikisYolu(kok, 't_abc12345')))
      .rejects.toBeInstanceOf(BundleLockTimeout);
    expect(await readdir(dizin.yol('failure-out'))).toEqual(['.lock-t_abc12345']);
  });

  it.each([
    ['ölü sürecin kilidi', () => kilitGovdesi(2 ** 22 + 12345)],
    ['bu sürecin bırakılmamış kalıntısı (MCP)', () => kilitGovdesi(process.pid, new Date().toISOString(), 'eski-cagri')],
  ])('bayat kilit devralınır: %s', async (_ad, govde) => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    PAKET_KILIDI.beklemeMs = 200;
    await writeFile(kilitYolu(dizin), govde());

    const ikinci = { ...paket(), snapshotId: 's_2' };
    await dizin.hataPaketiYaz(ikinci, []);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(ikinci);
    expect(await readdir(dizin.yol('failure'))).toEqual(['t_abc12345']);
  });

  it('gövdesi okunamayan kilit: tazeyse (yeni yaratılmış) beklenir, eskiyse devralınır ve silinmeden kenarda kalır', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    PAKET_KILIDI.beklemeMs = 200;
    await writeFile(kilitYolu(dizin), '');
    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).rejects.toBeInstanceOf(BundleLockTimeout);

    const eskiAn = new Date(Date.now() - 60 * 1000);
    await utimes(kilitYolu(dizin), eskiAn, eskiAn);
    await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
    expect((await dizin.hataPaketiOku('t_abc12345')).snapshotId).toBe('s_2');
    // Gövdesiz kilit yavaş ama canlı bir yazıcınınki olabilir: silinmez, devralma adında kalır.
    const kalanlar = await readdir(dizin.yol('failure'));
    expect(kalanlar.filter((ad) => ad !== 't_abc12345')).toEqual([expect.stringMatching(/^\.lock-t_abc12345-takeover-/)]);
  });

  it('kilit bırakılırken başkasının işaretini taşıyorsa silinmez', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const hedef = dizin.yol('failure', 't_abc12345');
    const yabanci = kilitGovdesi(process.ppid);
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (!tmpKlasoruMu(eski) || yeni !== hedef) return;
      atomikDurum.renameSonrasi = undefined;
      // Yayım sürerken kilit (ör. yanlış bayat kararıyla) başkasına geçmiş olsun.
      await writeFile(kilitYolu(dizin), yabanci);
    };

    await dizin.hataPaketiYaz(paket(), []);
    await expect(readFile(kilitYolu(dizin), 'utf8')).resolves.toBe(yabanci);
  });

  it.skipIf(process.platform === 'win32').each(['failure', 'failure-out'] as const)(
    '%s: kilit adında dışarıyı gösteren symlink takip edilmez, yazılmaz, silinmez',
    async (kokAdi) => {
      const kok = await geciciDizin();
      const dizin = await KobayDizini.ac(kok, config);
      await dizin.hataPaketiYaz(paket(), []);
      const dis = await geciciDizin();
      const nobetci = join(dis, 'nobetci.txt');
      await writeFile(nobetci, 'dokunma');
      const yok = join(dis, 'olusmamali.txt');
      const yazim = (): Promise<unknown> => (kokAdi === 'failure'
        ? dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])
        : dizin.hataPaketiKopyala('t_abc12345', hataPaketiCikisYolu(kok, 't_abc12345')));
      const tur = kokAdi === 'failure' ? UnsafeBundlePath : UnsafeOutputPath;

      // Var olan dış dosyayı gösteren bağ: içeriği değişmez, bağ yerinde kalır.
      await symlink(nobetci, kilitYolu(dizin, kokAdi));
      await expect(yazim()).rejects.toBeInstanceOf(tur);
      await expect(readFile(nobetci, 'utf8')).resolves.toBe('dokunma');
      // Askıda bağ: `O_EXCL` hedefi yaratmaz (EEXIST), denetim reddeder.
      await rm(kilitYolu(dizin, kokAdi));
      await symlink(yok, kilitYolu(dizin, kokAdi));
      await expect(yazim()).rejects.toBeInstanceOf(tur);
      await expect(access(yok)).rejects.toMatchObject({ code: 'ENOENT' });
      // Kilit adında dizin de kilit sayılmaz.
      await rm(kilitYolu(dizin, kokAdi));
      await mkdir(kilitYolu(dizin, kokAdi));
      await expect(yazim()).rejects.toThrow(/the bundle lock is not a regular file, or is a symlink/);
      await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
    },
  );

  it.skipIf(process.platform === 'win32')('.kobay dışarıyı gösteren symlink ise kilit dışarıda açılmaz', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const dis = await geciciDizin();
    await mkdir(join(dis, 'failure'));
    await writeFile(join(dis, 'nobetci.txt'), 'dokunma');
    await rename(dizin.kok, join(kok, 'kobay-gercek'));
    await symlink(dis, dizin.kok);

    await expect(dizin.hataPaketiYaz(paket(), [])).rejects.toBeInstanceOf(UnsafeBundlePath);
    expect((await readdir(dis)).sort()).toEqual(['failure', 'nobetci.txt']);
    expect(await readdir(join(dis, 'failure'))).toEqual([]);
  });

  it('yaşayan sahibin kilidi 10 dakikadan eski olsa da devralınmaz: açık hata, yol ve çare mesajda', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    PAKET_KILIDI.beklemeMs = 200;
    const govde = kilitGovdesi(process.ppid, new Date(Date.now() - 11 * 60 * 1000).toISOString());
    await writeFile(kilitYolu(dizin), govde);

    const hata: unknown = await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []).catch((h: unknown) => h);
    expect(hata).toBeInstanceOf(BundleLockTimeout);
    expect((hata as Error).message).toContain(kilitYolu(dizin));
    expect((hata as Error).message).toContain(`held by pid ${process.ppid}`);
    expect((hata as Error).message).toContain(`delete ${kilitYolu(dizin)}`);
    await expect(readFile(kilitYolu(dizin), 'utf8')).resolves.toBe(govde);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
  });

  /**
   * Çökme sonrası devralma yarışı: bu yazıcı ölü A'nın bayat kilidini okuduktan
   * sonra, kendi taşıma `rename`'inden hemen önce, C bayatı devralıp kendi taze
   * kilidini koyar. Bu yazıcının taşıdığı artık C'nin kilididir.
   */
  function devralmaYarisi(dizin: KobayDizini, cGovdesi: string, sonra?: () => Promise<void>): void {
    atomikDurum.renameOncesi = async (eski, yeni) => {
      if (eski !== kilitYolu(dizin) || !basename(yeni).includes('-takeover-')) return;
      atomikDurum.renameOncesi = undefined;
      await writeFile(kilitYolu(dizin), cGovdesi);
      if (sonra === undefined) return;
      atomikDurum.renameSonrasi = async (eski2, yeni2) => {
        if (eski2 !== kilitYolu(dizin) || yeni2 !== yeni) return;
        atomikDurum.renameSonrasi = undefined;
        await sonra();
      };
    };
  }

  it('devralma yarışında taşınan taze kilit üstüne yazmadan yerine konur, silinmez; sahibi beklenir', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    PAKET_KILIDI.beklemeMs = 300;
    await writeFile(kilitYolu(dizin), kilitGovdesi(2 ** 22 + 12345));
    const cGovdesi = kilitGovdesi(process.ppid, new Date().toISOString(), 'C');
    devralmaYarisi(dizin, cGovdesi);

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).rejects.toBeInstanceOf(BundleLockTimeout);
    await expect(readFile(kilitYolu(dizin), 'utf8')).resolves.toBe(cGovdesi);
    expect((await readdir(dizin.yol('failure'))).sort()).toEqual(['.lock-t_abc12345', 't_abc12345']);
  });

  it.each([
    ['ad bu arada D\'ye geçmiş (link EEXIST)', 'D'],
    ['sert bağ desteklenmiyor (link EPERM)', 'link'],
  ])('devralma yarışında taşınan taze kilit geri konamazsa: silinmez, yeri bildirilir, açık hata (%s)', async (_ad, tur) => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    await writeFile(kilitYolu(dizin), kilitGovdesi(2 ** 22 + 12345));
    const cGovdesi = kilitGovdesi(process.ppid, new Date().toISOString(), 'C');
    const dGovdesi = kilitGovdesi(process.ppid, new Date().toISOString(), 'D');
    if (tur === 'D') {
      devralmaYarisi(dizin, cGovdesi, async () => { await writeFile(kilitYolu(dizin), dGovdesi); });
    } else {
      devralmaYarisi(dizin, cGovdesi);
      atomikDurum.linkKodu = 'EPERM';
    }

    const hata: unknown = await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []).catch((h: unknown) => h);
    expect(hata).toBeInstanceOf(BundleLockConflict);
    const devir = (hata as BundleLockConflict).takeoverPath;
    await expect(readFile(devir, 'utf8')).resolves.toBe(cGovdesi);
    if (tur === 'D') await expect(readFile(kilitYolu(dizin), 'utf8')).resolves.toBe(dGovdesi);
    else await expect(access(kilitYolu(dizin))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
  });

  it('çift sahiplik (kilit yayım ortasında başkasına geçti): yayım yapılmaz, eski paket geri konur, öteki yazıcı tam yayımlar', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const hedef = dizin.yol('failure', 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    const ucuncu = { ...paket(), snapshotId: 's_3' };
    // Bu yazıcı eski paketi kenara aldığı an kilidi "kaybeder" (çökme sonrası
    // devralma yarışının sonucu) ve ikinci yazıcı kilidi alıp baştan sona yazar.
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (eski !== hedef || !basename(yeni).startsWith('.stale-')) return;
      atomikDurum.renameSonrasi = undefined;
      await rm(kilitYolu(dizin));
      await dizin.hataPaketiYaz(ucuncu, []);
    };

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).rejects.toBeInstanceOf(BundleLockLost);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(ucuncu);
    expect(await readdir(dizin.yol('failure'))).toEqual(['t_abc12345']);
  });

  it('eski klasörleri silmeden önce kilit başkasına geçmişse silinmez; yayımlanan paket tam, öteki kilit durur', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const hedef = dizin.yol('failure', 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    const yabanci = kilitGovdesi(process.ppid);
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (!tmpKlasoruMu(eski) || yeni !== hedef) return;
      atomikDurum.renameSonrasi = undefined;
      await writeFile(kilitYolu(dizin), yabanci);
    };

    const ikinci = { ...paket(), snapshotId: 's_2' };
    await expect(dizin.hataPaketiYaz(ikinci, [])).rejects.toBeInstanceOf(BundleLockLost);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(ikinci);
    await expect(readFile(kilitYolu(dizin), 'utf8')).resolves.toBe(yabanci);
    const kenarda = (await artiklar(dizin.yol('failure'))).filter((ad) => ad.startsWith('.stale-'));
    expect(kenarda).toHaveLength(1);
  });

  it('bırakırken okuma ile taşıma arasında gelen başkasının kilidi silinmez, yerine konur', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const yabanci = kilitGovdesi(process.ppid);
    atomikDurum.renameOncesi = async (eski, yeni) => {
      if (eski !== kilitYolu(dizin) || !basename(yeni).includes('-release-')) return;
      atomikDurum.renameOncesi = undefined;
      await writeFile(kilitYolu(dizin), yabanci);
    };

    await dizin.hataPaketiYaz(paket(), []);
    await expect(readFile(kilitYolu(dizin), 'utf8')).resolves.toBe(yabanci);
    expect((await readdir(dizin.yol('failure'))).sort()).toEqual(['.lock-t_abc12345', 't_abc12345']);
  });

  it('kilit dosyasının close() hatası kalıcı kilit bırakmaz: hata görünür, sonraki yazım hemen alır', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    PAKET_KILIDI.beklemeMs = 200;
    atomikDurum.kilitKapatKodu = 'EIO';
    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).rejects.toMatchObject({ code: 'EIO' });
    expect(await readdir(dizin.yol('failure'))).toEqual(['t_abc12345']);

    atomikDurum.kilitKapatKodu = undefined;
    await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_3' }, []);
    expect((await dizin.hataPaketiOku('t_abc12345')).snapshotId).toBe('s_3');
  });

  it('gövdesini yazamadan takılan canlı yazıcının boş kilidi devralınınca silinmez; o yazıcı kilidi almış sayılmaz', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const hedef = dizin.yol('failure', 't_abc12345');
    await dizin.hataPaketiYaz(paket(), []);
    const ucuncu = { ...paket(), snapshotId: 's_3' };
    const dGovdesi = kilitGovdesi(process.ppid, new Date().toISOString(), 'D');
    let basladi = false;
    let bitti = false;
    // A kilidi `O_EXCL` ile yarattı ama gövdeyi yazamadan 5 sn'den uzun takıldı (dosya boş, eski).
    atomikDurum.kilitYazimOncesi = async (yol) => {
      if (basladi) return;
      basladi = true;
      const eskiAn = new Date(Date.now() - 60 * 1000);
      await utimes(yol, eskiAn, eskiAn);
      // B boş kilidi bayat sayıp devralır, yazar ve bırakır; ardından D kilidi alır.
      await dizin.hataPaketiYaz(ucuncu, []);
      await writeFile(kilitYolu(dizin), dGovdesi);
      bitti = true;
    };
    let aKenaraAldi = false;
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (bitti && eski === hedef && basename(yeni).startsWith('.stale-')) aKenaraAldi = true;
    };

    const hata: unknown = await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []).catch((h: unknown) => h);
    expect(hata).toBeInstanceOf(BundleLockLost);
    // A yayım yoluna hiç girmedi; D'nin kilidine dokunulmadı; B'nin paketi tam.
    expect(aKenaraAldi).toBe(false);
    await expect(readFile(kilitYolu(dizin), 'utf8')).resolves.toBe(dGovdesi);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(ucuncu);
    // A'nın kilidi silinmedi: devralma adında, A'nın sonradan yazdığı gövdeyle duruyor.
    const devirler = (await readdir(dizin.yol('failure'))).filter((ad) => ad.includes('-takeover-'));
    expect(devirler).toHaveLength(1);
    const aGovdesi = JSON.parse(await readFile(dizin.yol('failure', devirler[0] ?? ''), 'utf8')) as { pid: number };
    expect(aGovdesi.pid).toBe(process.pid);
    expect((await readdir(dizin.yol('failure'))).filter((ad) => ad.startsWith('.tmp-'))).toEqual([]);
  });

  it('kilit gövdesi yazılamaz ve close() da düşerse iki hata birlikte görünür, birincil kaybolmaz', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    atomikDurum.kilitYazKodu = 'ENOSPC';
    atomikDurum.kilitKapatKodu = 'EIO';

    const hata: unknown = await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []).catch((h: unknown) => h);
    expect(hata).toBeInstanceOf(AggregateError);
    expect(hata).toMatchObject({ code: 'ENOSPC' });
    expect((hata as AggregateError).errors.map((h: unknown) => (h as { code?: string }).code)).toEqual(['ENOSPC', 'EIO']);
    // Boş kalan kendi kilidimiz (yazım payı dolmadan) kaldırıldı; paket yerinde.
    expect(await readdir(dizin.yol('failure'))).toEqual(['t_abc12345']);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());

    atomikDurum.kilitKapatKodu = undefined;
    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_3' }, [])).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('bırakmada yerine konamayan başkasının kilidi silinmez: bırakma adında kalır, uyarı yazılır', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const yabanci = kilitGovdesi(process.ppid);
    atomikDurum.renameOncesi = async (eski, yeni) => {
      if (eski !== kilitYolu(dizin) || !basename(yeni).includes('-release-')) return;
      atomikDurum.renameOncesi = undefined;
      await writeFile(kilitYolu(dizin), yabanci);
      atomikDurum.linkKodu = 'EPERM';
    };
    const uyarilar: string[] = [];
    const casus = vi.spyOn(process.stderr, 'write').mockImplementation((parca: string | Uint8Array) => {
      uyarilar.push(String(parca));
      return true;
    });

    try {
      await dizin.hataPaketiYaz(paket(), []);
    } finally {
      casus.mockRestore();
    }
    const birakmalar = (await readdir(dizin.yol('failure'))).filter((ad) => ad.includes('-release-'));
    expect(birakmalar).toHaveLength(1);
    await expect(readFile(dizin.yol('failure', birakmalar[0] ?? ''), 'utf8')).resolves.toBe(yabanci);
    expect(uyarilar.join('')).toContain('could not be put back');
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
  });

  /** Yalnız kilit dosyasının `O_EXCL` açılışını hedefler. */
  function kilitAcilisiMi(yol: string, bayrak: unknown): boolean {
    return basename(yol).startsWith('.lock-') && bayrak === 'wx';
  }

  it.each(['EPERM', 'EACCES', 'EBUSY'])('kilit açılışında geçici %s beklenir; kalıcısı özgün kodla açık hata', async (kod) => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    PAKET_KILIDI.beklemeMs = 300;
    let kalan = 2;
    atomikDurum.openKodu = (yol, bayrak) => (kilitAcilisiMi(yol, bayrak) && (kalan -= 1) >= 0 ? kod : undefined);
    await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
    expect(kalan).toBeLessThan(0);
    expect((await dizin.hataPaketiOku('t_abc12345')).snapshotId).toBe('s_2');

    atomikDurum.openKodu = (yol, bayrak) => (kilitAcilisiMi(yol, bayrak) ? kod : undefined);
    const hata: unknown = await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_3' }, []).catch((h: unknown) => h);
    expect(hata).toBeInstanceOf(BundleLockTimeout);
    expect(hata).toMatchObject({ code: kod });
    expect((await dizin.hataPaketiOku('t_abc12345')).snapshotId).toBe('s_2');
    expect(await readdir(dizin.yol('failure'))).toEqual(['t_abc12345']);
  });

  /**
   * Windows'ta libuv `realpath`'inin taşınan bir dosya için verebildiği sonuçlar
   * (CI 37138702502): EBADF, kardeş bir ad ya da bozuk/kırpılmış bir dizge.
   */
  function kilitRealpathTaklidi(dizin: KobayDizini, tur: string): { cagri: number } {
    const sayac = { cagri: 0 };
    const kilit = kilitYolu(dizin);
    atomikDurum.realpathSonucu = (yol, sonuc) => {
      if (yol !== kilit) return sonuc;
      sayac.cagri += 1;
      if (tur === 'EBADF') throw realpathHatasi('EBADF');
      if (tur === 'kardes') return join(dirname(sonuc), '.lock-t_abc12345-release-x');
      return sonuc.slice(0, -5);
    };
    return sayac;
  }

  it.each(['EBADF', 'kardes', 'bozuk'])(
    'kilit adının realpath\'i (Windows taklidi: %s) kilit kararına girmez: canlı sahip beklenir, sahiplik alınmaz',
    async (tur) => {
      const dizin = await KobayDizini.ac(await geciciDizin(), config);
      await dizin.hataPaketiYaz(paket(), []);
      PAKET_KILIDI.beklemeMs = 200;
      const govde = kilitGovdesi(process.ppid);
      await writeFile(kilitYolu(dizin), govde);
      const sayac = kilitRealpathTaklidi(dizin, tur);

      await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).rejects.toBeInstanceOf(BundleLockTimeout);
      expect(sayac.cagri).toBe(0);
      await expect(readFile(kilitYolu(dizin), 'utf8')).resolves.toBe(govde);
      await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
    },
  );

  it.each(['EBADF', 'kardes', 'bozuk'])(
    'yeni alınan kilidin realpath\'i (Windows taklidi: %s) yanlış alarm üretmez: yazım tamamlanır, kilit kalmaz',
    async (tur) => {
      const dizin = await KobayDizini.ac(await geciciDizin(), config);
      await dizin.hataPaketiYaz(paket(), []);
      const sayac = kilitRealpathTaklidi(dizin, tur);

      await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
      expect(sayac.cagri).toBe(0);
      expect((await dizin.hataPaketiOku('t_abc12345')).snapshotId).toBe('s_2');
      expect(await readdir(dizin.yol('failure'))).toEqual(['t_abc12345']);
    },
  );

  it('kilit alındıktan hemen sonra taşınırsa alınmış sayılmaz; taşınan dosya silinmez', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const tasinan = dizin.yol('failure', '.lock-t_abc12345-takeover-rakip');
    atomikDurum.kilitYazimSonrasi = async (yol) => {
      atomikDurum.kilitYazimSonrasi = undefined;
      await rename(yol, tasinan);
    };

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []))
      .rejects.toThrow(/moved away right after it was taken/);
    await expect(access(tasinan)).resolves.toBeUndefined();
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
  });

  it('kilidin yerine hemen başka bir dosya gelirse (farklı dosya kimliği) alınmış sayılmaz, o dosyaya dokunulmaz', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const yabanci = kilitGovdesi(process.ppid);
    atomikDurum.kilitYazimSonrasi = async (yol) => {
      atomikDurum.kilitYazimSonrasi = undefined;
      await rename(yol, dizin.yol('failure', '.lock-t_abc12345-takeover-rakip'));
      await writeFile(yol, yabanci);
    };

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []))
      .rejects.toThrow(/another file replaced it right after it was taken/);
    await expect(readFile(kilitYolu(dizin), 'utf8')).resolves.toBe(yabanci);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
  });

  it.skipIf(process.platform === 'win32')('kilit alınırken failure kökü symlink\'e çevrilirse reddeder; tanı mesajda', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    await dizin.hataPaketiYaz(paket(), []);
    const tasinan = join(await geciciDizin(), 'failure-gercek');
    atomikDurum.kilitYazimSonrasi = async () => {
      atomikDurum.kilitYazimSonrasi = undefined;
      await rename(dizin.yol('failure'), tasinan);
      await symlink(tasinan, dizin.yol('failure'));
    };

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).rejects.toBeInstanceOf(UnsafeBundlePath);
    await expect(readFile(join(tasinan, 't_abc12345', 'failure.json'), 'utf8')).resolves.toContain('"s_1"');
  });

  it('bayat kilidin devralınmasında kilit adının realpath\'ine hiç bakılmaz (Windows taklidi EBADF)', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    await writeFile(kilitYolu(dizin), kilitGovdesi(2 ** 22 + 12345));
    const sayac = kilitRealpathTaklidi(dizin, 'EBADF');

    await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
    expect(sayac.cagri).toBe(0);
    expect((await dizin.hataPaketiOku('t_abc12345')).snapshotId).toBe('s_2');
    expect(await readdir(dizin.yol('failure'))).toEqual(['t_abc12345']);
  });

  it.each(['EIO', 'ENOENT', 'EBADF'])('kilit açılışında %s beklenmez, kabul edilmez: hemen özgün hatayla düşer', async (kod) => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    let cagri = 0;
    atomikDurum.openKodu = (yol, bayrak) => {
      if (!kilitAcilisiMi(yol, bayrak)) return undefined;
      cagri += 1;
      return kod;
    };

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).rejects.toMatchObject({ code: kod });
    expect(cagri).toBe(1);
    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toEqual(paket());
    expect(await readdir(dizin.yol('failure'))).toEqual(['t_abc12345']);
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
    // Hazırlıkta düşen yazım geçici klasör bırakmaz.
    expect(await artiklar(dizin.yol('failure'))).toEqual([]);
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

  it('yayın sırasında kenara alınan eski paketi eşzamanlı budama mtime eski olsa da silmez', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.hataPaketiYaz(paket(), []);
    const hedef = dizin.yol('failure', 't_abc12345');
    const eskiAn = new Date('2026-01-01T00:00:00Z');
    await utimes(hedef, eskiAn, eskiAn);

    let budama: Awaited<ReturnType<typeof depoyuBuda>> | undefined;
    let staleVardi = false;
    // Eski paket `.stale-*` adına taşındığı an (geri alma için hâlâ gerekli) budama koşar.
    atomikDurum.renameSonrasi = async (eski, yeni) => {
      if (eski !== hedef || !yeni.includes('.stale-')) return;
      atomikDurum.renameSonrasi = undefined;
      budama = await depoyuBuda(dizin, { olderThanDays: 1 });
      staleVardi = await access(yeni).then(() => true, () => false);
    };

    await expect(dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, [])).resolves.toBe(hedef);
    expect(budama?.deleted.filter((oge) => oge.kind === 'stale-failure-bundle')).toEqual([]);
    expect(staleVardi).toBe(true);
  });

  it('ek dosyada içerik verilmişse kaynağı değil o içeriği yazar', async () => {
    const kok = await geciciDizin();
    const dizin = await KobayDizini.ac(kok, config);
    const ek = join(kok, 'console.json');
    await writeFile(ek, 'ham sk-ham');
    await dizin.hataPaketiYaz(paket(), [{ kaynak: ek, hedefAd: 'console.json', icerik: 'maskeli' }]);
    await expect(readFile(dizin.yol('failure', 't_abc12345', 'console.json'), 'utf8')).resolves.toBe('maskeli');
    await expect(readFile(ek, 'utf8')).resolves.toBe('ham sk-ham');
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
    await dizin.hataPaketiYaz(paket(), [{ kaynak: ek, hedefAd: 'step-1.png' }]);
    const hedef = hataPaketiCikisYolu(kok, 't_abc12345');
    expect(hedef).toBe(dizin.yol('failure-out', 't_abc12345'));

    await dizin.hataPaketiKopyala('t_abc12345', hedef);
    expect(await readFile(join(hedef, 'step-1.png'), 'utf8')).toBe('ilk koşunun eki');

    // İkinci koşunun paketinde o ek yok: aynı yola yazılınca eskisinden iz kalmamalı.
    await dizin.hataPaketiYaz({ ...paket(), snapshotId: 's_2' }, []);
    await dizin.hataPaketiKopyala('t_abc12345', hedef);

    const kopya = await jsonOku(join(hedef, 'failure.json'), HataPaketiSemasi);
    expect(kopya.snapshotId).toBe('s_2');
    await expect(stat(join(hedef, 'step-1.png'))).rejects.toMatchObject({ code: 'ENOENT' });
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
      .rejects.toThrow('Unsafe failure bundle output path');

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
      .rejects.toThrow('Unsafe failure bundle output path');

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

    await expect(dizin.hataPaketiKopyala('t_abc12345', hedef)).rejects.toThrow('Destination directory already exists');
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
  const kimlik = { username: 'ali', password: 'gizli-1', origin: 'http://mesru.test' };

  async function kimlikliDizin(): Promise<KobayDizini> {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.kimlikYaz(kimlik);
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    return dizin;
  }

  /** `.kobay/` kökündeki kenara alınmış kopyalar. */
  async function kalintilar(dizin: KobayDizini): Promise<string[]> {
    return (await readdir(dizin.kok)).filter((ad) => ad.startsWith('.stale-'));
  }

  /**
   * Süreci öldürülmüş bir işlemin bıraktığı işareti taklit eder: dosya durur
   * ama tazelik penceresinden (10 dk) eskidir.
   */
  /** İşlem işaretinin ham içeriği. */
  async function isaretiOku(dizin: KobayDizini): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(dizin.kok, '.credentials-txn'), 'utf8')) as Record<string, unknown>;
  }

  async function isaretiBayatlat(dizin: KobayDizini): Promise<void> {
    const ham = JSON.parse(await readFile(join(dizin.kok, '.credentials-txn'), 'utf8')) as Record<string, unknown>;
    await writeFile(
      join(dizin.kok, '.credentials-txn'),
      JSON.stringify({ ...ham, startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
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
    await expect(stat(join(dizin.kok, '.credentials-txn'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(sonraki?.kimlikOku()).resolves.toEqual(kimlik);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
  });

  it('kesinleşmemiş işlem tam geri alınır: sonradan yazılan kimliğin üstüne eskisi konur', async () => {
    const dizin = await kimlikliDizin();
    // Kilit bizdeyken asıl adı yalnız düşen işlemin kendisi yazmış olabilir
    // (--login). İşlem hiç olmamış sayılır: yeni kimlik ezilir.
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    await isaretiBayatlat(dizin);
    await dizin.kimlikYaz({ username: 'veli', password: 'gizli-2', origin: 'http://kotu.test' });

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
    await expect(stat(join(dizin.kok, '.credentials-txn'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(basilan).toContain('an unfinished target change was rolled back');
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
    await dizin.kimlikYaz({ username: 'veli', password: 'gizli-2', origin: 'http://kotu.test:8080' });
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
    expect((await isaretiOku(dizin)).setAside).toEqual(['credentials.json', 'storageState.json']);
    await dizin.configYaz({ ...config, baseUrl: 'http://kotu.test:8080' });
    await dizin.kimlikYaz({ username: 'veli', password: 'gizli-2', origin: 'http://kotu.test:8080' });

    // İlk geri alma denemesi: credentials kopyası geri kondu, storageState düştü.
    atomikDurum.renameKosulu = (eski) => eski.includes('-storageState.json');
    atomikDurum.renameKodu = 'EACCES';
    const ilkHata = await islem
      .geriAl({ configYazildi: true, yeniKimlikYazildi: true, asilHata: new Error('kesinleştirme düştü') })
      .catch((hata: unknown) => hata);
    atomikDurum.renameKosulu = undefined;
    atomikDurum.renameKodu = undefined;

    expect(ilkHata).toBeInstanceOf(CredentialsRollbackFailed);
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
    await expect(stat(join(dizin.kok, '.credentials-txn'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aynı işaretle kurtarma iki kez koşarsa sonuç değişmez; orijinal kimlik durur', async () => {
    const dizin = await kimlikliDizin();
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config, yeniKimlikYazilacak: true });
    const isaretYedegi = await isaretiOku(dizin);
    await dizin.configYaz({ ...config, baseUrl: 'http://kotu.test:8080' });
    await dizin.kimlikYaz({ username: 'veli', password: 'gizli-2', origin: 'http://kotu.test:8080' });

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await islem.geriAl({ configYazildi: true, yeniKimlikYazildi: true });
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    expect(await kalintilar(dizin)).toEqual([]);

    // İşaret (örneğin silinemediği için) yerinde kalsaydı kurtarma aynı kayıtla
    // bir kez daha koşardı: kopya kalmadığı için eski kural "eski kimlik yoktu"
    // sonucuna varıp geri konmuş orijinali silerdi. Kalıcı olgu bunu keser.
    await writeFile(join(dizin.kok, '.credentials-txn'), JSON.stringify({
      ...isaretYedegi,
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
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
      join(dizin.kok, `.stale-${String(ham.txnId)}-credentials.json`),
      dizin.yol('credentials.json'),
    );
    // Eski bir kobay sürümünün işareti: kalıcı olgu hiç yazılmamış.
    delete ham.setAside;
    await writeFile(join(dizin.kok, '.credentials-txn'), JSON.stringify({
      ...ham,
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await KobayDizini.bul(dizin.projeKoku);
    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();

    // Güvenli taraf: silinmedi, kullanıcıya ne yapacağı söylendi.
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    expect(basilan).toContain('has no set-aside file list');
    expect(basilan).toContain('kobay project get');
  });

  it('eski sürümün işaretinde (eskiConfig yok) geri koyma yapılmaz: uyarılır, işaret silinir', async () => {
    const dizin = await kimlikliDizin();
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    // Eski kobay sürümünün yazdığı işaret: geri alma kaydı yok.
    const ham = await isaretiOku(dizin);
    delete ham.previousConfig;
    await writeFile(join(dizin.kok, '.credentials-txn'), JSON.stringify({
      ...ham,
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));

    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await KobayDizini.bul(dizin.projeKoku);
    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();

    // Kalıntı yerinde: hangi config'in altına konacağı bilinmiyor.
    expect(await kalintilar(dizin)).toHaveLength(2);
    await expect(dizin.kimlikOku()).resolves.toBeNull();
    await expect(stat(dizin.storageStateYolu())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(basilan).toContain('has no pre-transaction config');
    expect(basilan).toContain('move it to credentials.json by hand');
    // İşaret gider; yoksa kilit sonsuza dek durur.
    await expect(stat(join(dizin.kok, '.credentials-txn'))).rejects.toMatchObject({ code: 'ENOENT' });
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
    await expect(stat(join(dizin.kok, '.credentials-txn'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kesinleştirme anında dosya geri konmuşsa başarı dönmez, açık hata verir', async () => {
    const dizin = await kimlikliDizin();
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    // Başka bir süreç (eski sürüm ya da yarış) kalıntıyı asıl adına geri koydu.
    for (const ad of await kalintilar(dizin)) {
      await rename(join(dizin.kok, ad), join(dizin.kok, ad.slice('.stale-'.length + 36 + 1)));
    }

    await expect(islem.kesinlestir()).rejects.toThrow('Credentials transaction broke');

    // Kullanıcının verisi duruyor ve işaret bırakılmıyor.
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    await expect(stat(join(dizin.kok, '.credentials-txn'))).rejects.toMatchObject({ code: 'ENOENT' });
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
    expect(basilan).toContain('the set-aside copy of storageState.json could not be deleted');
    expect(basilan).toContain('EBUSY');
    // Silinebilen gitti (temizlik ilk hatada durmuyor), silinemeyen duruyor.
    const kalan = await kalintilar(dizin);
    expect(kalan).toHaveLength(1);
    expect(kalan[0]).toMatch(/^\.stale-[0-9a-f-]{36}-storageState\.json$/);
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
    await expect(stat(join(dizin.kok, '.credentials-txn'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kesinleşme işareti yazılamazsa işlem doğrulama hatasıyla düşer; hiçbir yedek silinmez', async () => {
    const dizin = await kimlikliDizin();
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    // İşaretin atomik yazımı (geçici dosya + rename) düşüyor.
    atomikDurum.renameKosulu = (_eski, yeni) => yeni.endsWith('.credentials-txn');

    await expect(islem.kesinlestir()).rejects.toThrow('yeniden adlandırma simülasyonu');

    atomikDurum.renameKosulu = undefined;
    // Doğrulama hatası: iki yedek de duruyor, çağıran güvenle geri alabilir.
    expect(await kalintilar(dizin)).toHaveLength(2);
    await islem.geriAl();
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    // Geri koyma tamamlandı: kalıntı kalmadığı için işaret de kaldırılır.
    await expect(stat(join(dizin.kok, '.credentials-txn'))).rejects.toMatchObject({ code: 'ENOENT' });
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
    await writeFile(join(dizin.kok, '.credentials-txn'), JSON.stringify({ ...isaret, pid: process.ppid }));
    await expect(dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config })).rejects.toBeInstanceOf(CredentialsTxnInProgress);
    expect(await kalintilar(dizin)).toHaveLength(1);

    // Kendi sürecimizin bıraktığı iz kilit sayılmaz: kalıntı temizlenip devralınır.
    await writeFile(join(dizin.kok, '.credentials-txn'), JSON.stringify(isaret));
    const ikinci = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    uyari.mockRestore();
    expect(await kalintilar(dizin)).toEqual([]);
    await ikinci.kesinlestir();
  });

  // Windows'ta chmod dizin yazmayı engellemez; senaryo POSIX'e özgü.
  it.skipIf(process.platform === 'win32')('kenara alma yarıda düşerse o ana kadar taşınanlar hemen geri konur', async () => {
    const dizin = await kimlikliDizin();
    // İlk dosya taşınır, ikincisinde rename düşer. Yalnız kenara alma renameleri
    // sayılır; işaret dosyasının atomik yazımı bu sayıyı kaydırmasın.
    let cagri = 0;
    atomikDurum.renameKosulu = (_eski, yeni) => {
      if (!yeni.includes('/.stale-')) return false;
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
    const oncekiIsaret = await readFile(join(dizin.kok, '.credentials-txn'), 'utf8');
    expect(oncekiKalintilar).toHaveLength(2);

    // İkinci komut beklemez; açık kullanım hatasıyla düşer (CLI'da çıkış 2).
    await expect(dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config })).rejects.toBeInstanceOf(CredentialsTxnInProgress);
    await expect(dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config })).rejects.toThrow('wait for it to finish');

    // Reddedilen komut ne kalıntıya ne de işarete dokunur: kilit ilk işlemin.
    expect(await kalintilar(dizin)).toEqual(oncekiKalintilar);
    await expect(readFile(join(dizin.kok, '.credentials-txn'), 'utf8')).resolves.toBe(oncekiIsaret);

    await islem.kesinlestir();
  });

  it('geri almada config yazımı düşerse yedekler geri KONMAZ, işaret korunur; sonraki bul() tamamlar', async () => {
    const dizin = await kimlikliDizin();
    const yeniConfig = { ...config, baseUrl: 'http://kotu.test:8080' };
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    await dizin.configYaz(yeniConfig);
    // Kesinleştirme doğrulama aşamasında düşüyor (işaret yazımı tutmuyor).
    atomikDurum.renameKosulu = (_eski, yeni) => yeni.endsWith('.credentials-txn');
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

    expect(geriAlmaHatasi).toBeInstanceOf(CredentialsRollbackFailed);
    expect((geriAlmaHatasi as Error).message).toContain('ENOSPC');
    expect((geriAlmaHatasi as Error).message).toContain('run the command again');
    // Asıl bulgu: config geri yazılamadığı için yedekler geri konmadı ve
    // düzeltmeyi taşıyan işaret silinmedi.
    expect(await kalintilar(dizin)).toHaveLength(2);
    await expect(dizin.configOku()).resolves.toEqual(yeniConfig);
    const kalanIsaret = await isaretiOku(dizin);
    expect(kalanIsaret.committed ?? false).toBe(false);
    expect(kalanIsaret.previousConfig).toEqual(config);

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
    await expect(stat(join(dizin.kok, '.credentials-txn'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Windows'ta chmod dizin yazmayı engellemez; senaryo POSIX'e özgü.
  it.skipIf(process.platform === 'win32')('bayat kesinleşmemiş kurtarmada yedek geri konamazsa bul() fırlatır; kilit devralınmaz', async () => {
    const dizin = await kimlikliDizin();
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    await isaretiBayatlat(dizin);
    // Kurtarma yedeği asıl adına koyamıyor (izin yok).
    atomikDurum.renameKosulu = (eski) => eski.includes('/.stale-');
    atomikDurum.renameKodu = 'EACCES';

    const hata = await KobayDizini.bul(dizin.projeKoku).catch((h: unknown) => h);

    expect(hata).toBeInstanceOf(CredentialsRollbackFailed);
    // Kullanıcı hangi dosyanın neden geri konamadığını ve ne yapacağını görür.
    expect((hata as Error).message).toMatch(/\.stale-[0-9a-f-]{36}-credentials\.json/);
    expect((hata as Error).message).toContain('EACCES');
    expect((hata as Error).message).toContain('run the command again');
    // İşaret ve yedek yerinde: sonraki komut aynı sırayla yeniden deneyebilir.
    expect(await kalintilar(dizin)).toHaveLength(2);
    expect((await isaretiOku(dizin)).previousConfig).toEqual(config);

    // Aynı süreçte kimliği değiştiren yeni bir işlem kilidi devralamaz; devralsaydı
    // işlem kaydını siler ve geri konamayan yedek sahipsiz kalırdı.
    await expect(dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config }))
      .rejects.toBeInstanceOf(CredentialsRollbackFailed);
    expect(await kalintilar(dizin)).toHaveLength(2);
    expect((await isaretiOku(dizin)).previousConfig).toEqual(config);

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
    const bayatIsaret = await readFile(join(dizin.kok, '.credentials-txn'), 'utf8');

    const sonuclar = await Promise.allSettled([
      dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config }),
      dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config }),
    ]);

    // Devralmayı rename kazananı belirler: tek sahip.
    expect(sonuclar.filter((sonuc) => sonuc.status === 'fulfilled')).toHaveLength(1);
    const kaybeden = sonuclar.find((sonuc) => sonuc.status === 'rejected') as PromiseRejectedResult;
    expect(kaybeden.reason).toBeInstanceOf(CredentialsTxnInProgress);
    // Red taze işaret kontrolünden değil, devralma rename'inin düşmesinden geldi:
    // sahibi bilinmediği için mesajda pid ayrıntısı yok.
    expect((kaybeden.reason as Error).message).not.toContain('pid');
    // Kilit gerçekten devralındı ve devralma kopyası ortalıkta bırakılmadı.
    await expect(readFile(join(dizin.kok, '.credentials-txn'), 'utf8')).resolves.not.toBe(bayatIsaret);
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.credentials-txn-takeover-'))).toEqual([]);
  });

  it('kurtarma yalnız bayat işaretteki txnId’nin kalıntısını toparlar', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.storageStateYaz('{"cookies":[],"origins":[]}');
    // Yabancı işlemin (başka txnId) kalıntısı; bu işaret onu kapsamıyor.
    const yabanciId = '11111111-1111-4111-8111-111111111111';
    await writeFile(join(dizin.kok, `.stale-${yabanciId}-credentials.json`), '{"kullanici":"veli","parola":"gizli-9"}');

    // Bu işlem yalnız storageState.json'u kenara aldı, sonra süreci öldü.
    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    await isaretiBayatlat(dizin);

    const ilkUyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await KobayDizini.bul(dizin.projeKoku);
    ilkUyari.mockRestore();

    // Kendi kalıntısı geri kondu, yabancıya dokunulmadı.
    await expect(readFile(dizin.storageStateYolu(), 'utf8')).resolves.toBe('{"cookies":[],"origins":[]}');
    expect(await kalintilar(dizin)).toEqual([`.stale-${yabanciId}-credentials.json`]);

    // Yabancı kalıntı sahipsizdir: geri konmaz (hangi hedefe ait olduğu
    // bilinmiyor), silinmez de (içinde parola olabilir); uyarılıp bırakılır.
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await KobayDizini.bul(dizin.projeKoku);
    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();
    expect(basilan).toContain(`an orphaned credentials copy .stale-${yabanciId}-credentials.json`);
    expect(await kalintilar(dizin)).toEqual([`.stale-${yabanciId}-credentials.json`]);
    await expect(dizin.kimlikOku()).resolves.toBeNull();
  });

  it('işaretsiz kalıntı geri konmaz: sahipsiz kopya uyarıyla yerinde bırakılır', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const birinci = '11111111-1111-4111-8111-111111111111';
    const ikinci = '22222222-2222-4222-8222-222222222222';
    await writeFile(join(dizin.kok, `.stale-${birinci}-credentials.json`), '{"kullanici":"ali"}');
    await writeFile(join(dizin.kok, `.stale-${ikinci}-credentials.json`), '{"kullanici":"veli"}');
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await KobayDizini.bul(dizin.projeKoku);

    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    uyari.mockRestore();
    expect(basilan).toContain(`an orphaned credentials copy .stale-${birinci}-credentials.json`);
    expect(basilan).toContain(`an orphaned credentials copy .stale-${ikinci}-credentials.json`);
    expect(basilan).toContain('move it to credentials.json by hand');
    // Hiçbiri seçilmez; kullanıcı elle karar verir.
    expect((await kalintilar(dizin)).sort()).toEqual([
      `.stale-${birinci}-credentials.json`,
      `.stale-${ikinci}-credentials.json`,
    ]);
    await expect(dizin.kimlikOku()).resolves.toBeNull();
  });

  // --- 0.1 ile 0.2 aynı projede: kilit iki adla birden tutulur ---------------

  it('kilit iki işareti birden alır: .credentials-txn ve .kimlik-islemi aynı işlem, ayrı şema', async () => {
    const dizin = await kimlikliDizin();

    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });

    // Asıl bulgu: yalnız yeni adı yaratmak yetmiyordu. 0.1 süreci yalnız
    // `.kimlik-islemi`ni tanır; eski ad da `O_EXCL` ile alınmazsa iki sürüm
    // aynı anda sahip olabiliyordu.
    const yeni = JSON.parse(await readFile(join(dizin.kok, '.credentials-txn'), 'utf8')) as { txnId: string };
    // Eski ad 0.1'in Türkçe şemasıyla yazılır: aynı işlem, eski alan adları.
    // İngilizce gövde yazılsaydı 0.1 dosyayı geçersiz sayıp siler ve kilidi
    // ezerdi — kilit iki adla tutulsa bile iki sahip doğardı.
    const eski = JSON.parse(await readFile(join(dizin.kok, '.kimlik-islemi'), 'utf8')) as {
      islemId: string;
      txnId?: string;
    };
    expect(eski.islemId).toBe(yeni.txnId);
    expect(eski.txnId).toBeUndefined();

    await islem.kesinlestir();
    // Kapanışta iki ad da gider; yoksa eski ad kilidi sonsuza dek tutardı.
    await expect(stat(join(dizin.kok, '.credentials-txn'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(dizin.kok, '.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('taze 0.1 işareti kilittir: yeni işlem reddedilir ve yeni adı geride bırakmaz', async () => {
    const dizin = await kimlikliDizin();
    // Yürüyen bir 0.1 komutunun işareti: yalnız eski ad, Türkçe alanlar.
    await writeFile(join(dizin.kok, '.kimlik-islemi'), JSON.stringify({
      pid: process.pid,
      islemId: '22222222-3333-4444-5555-666666666666',
      baslatildi: new Date().toISOString(),
    }));

    await expect(dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config }))
      .rejects.toBeInstanceOf(CredentialsTxnInProgress);

    // Reddedilen işlem `.credentials-txn`'i geride bırakmamalı: bıraksaydı
    // kilit iki sahipli görünür, sonraki komut da boş yere reddedilirdi.
    await expect(stat(join(dizin.kok, '.credentials-txn'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(dizin.kimlikOku()).resolves.toEqual(kimlik);
  });

  it('bayat 0.1 işareti devralınırken eski ad da yenilenir; devir kopyası kalmaz', async () => {
    const dizin = await kimlikliDizin();
    const bayatId = '33333333-4444-5555-6666-777777777777';
    // Süreci ölmüş 0.1 işlemi; geri alma kaydı taşımadığı için devralınabilir.
    await writeFile(join(dizin.kok, '.kimlik-islemi'), JSON.stringify({
      pid: process.pid,
      islemId: bayatId,
      baslatildi: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));

    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });

    const yeni = JSON.parse(await readFile(join(dizin.kok, '.credentials-txn'), 'utf8')) as { txnId: string };
    const eski = JSON.parse(await readFile(join(dizin.kok, '.kimlik-islemi'), 'utf8')) as { islemId: string };
    expect(yeni.txnId).not.toBe(bayatId);
    expect(eski.islemId).toBe(yeni.txnId);
    expect((await readdir(dizin.kok)).filter((ad) => ad.startsWith('.credentials-txn-takeover-'))).toEqual([]);
    await islem.kesinlestir();
  });

  it('iki işaret ayrı txnId taşıyorsa taze olanı esas alınır ve uyarı basılır', async () => {
    const dizin = await kimlikliDizin();
    const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
    const yeni = await isaretiOku(dizin);
    // 0.1 süreci araya girip kendi (daha taze) işaretini eski ada yazmış.
    const yabanciId = '44444444-5555-6666-7777-888888888888';
    await writeFile(join(dizin.kok, '.kimlik-islemi'), JSON.stringify({
      ...yeni,
      txnId: yabanciId,
      startedAt: new Date(Date.now() + 1000).toISOString(),
    }));
    const uyari = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // Kalıntılar taze görünen yabancı işleme ait sayılır: dokunulmaz.
    await KobayDizini.bul(dizin.projeKoku);

    const basilan = uyari.mock.calls.map(([metin]) => String(metin)).join('');
    expect(basilan).toContain('the two credentials transaction markers disagree');
    expect(basilan).toContain(yabanciId);
    expect(await kalintilar(dizin)).toHaveLength(2);
    await islem.geriAl();
    uyari.mockRestore();
  });
});

describe('0.1 → 0.2 göçü (Türkçe alan ve dosya adları)', () => {
  /** 0.1 sürümünün bıraktığı bir `.kobay` dizinini elle kurar. */
  async function eskiProje(ekle: {
    harita?: boolean;
    kimlik?: boolean;
    oneriler?: boolean;
  } = {}): Promise<string> {
    const kok = await geciciDizin();
    const kobay = join(kok, '.kobay');
    await mkdir(join(kobay, 'plan'), { recursive: true });
    await writeFile(join(kobay, 'config.json'), JSON.stringify({
      baseUrl: 'http://uygulama.test',
      loginUrl: 'http://uygulama.test/giris',
      beyin: { adaptor: 'sahte', model: 'm1' },
    }, null, 2));
    if (ekle.harita !== false) {
      await writeFile(join(kobay, 'harita.json'), JSON.stringify({
        baseUrl: 'http://uygulama.test',
        girisYapildi: true,
        sayfalar: [{
          url: 'http://uygulama.test/cariler',
          baslik: 'Cariler',
          basliklar: ['Cariler'],
          linkler: ['http://uygulama.test/'],
          formlar: [{ action: '/ara', alanlar: [{ ad: 'q', tip: 'text', etiket: 'Ara' }] }],
          dugmeler: ['Yeni cari'],
          menu: ['Cariler'],
        }],
        kesifTarihi: '2026-09-17T00:00:00.000Z',
      }, null, 2));
    }
    if (ekle.kimlik === true) {
      await writeFile(
        join(kobay, 'credentials.json'),
        JSON.stringify({ kullanici: 'ali', parola: 'gizli-1', origin: 'http://uygulama.test' }),
        { mode: 0o600 },
      );
    }
    if (ekle.oneriler === true) {
      await writeFile(join(kobay, 'plan', 'onerileri.json'), JSON.stringify([{
        proposalId: 'p_abc123',
        title: 'Cari listesi',
        description: 'Listeyi görüntüler',
        priority: 'p1',
        category: 'gezinti',
        feature: 'cariler',
        type: 'frontend',
        url: '/cariler',
        steps: [{ type: 'action', description: 'Aç' }],
      }], null, 2));
    }
    return kok;
  }

  it('harita.json → map.json: ad göçer, Türkçe alanlar İngilizceye eşlenir', async () => {
    const kok = await eskiProje();
    const dizin = (await KobayDizini.bul(kok))!;

    expect(dizin).not.toBeNull();
    await expect(access(dizin.yol('map.json'))).resolves.toBeUndefined();
    await expect(access(dizin.yol('harita.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const harita = await dizin.haritaOku();
    expect(harita).toMatchObject({
      loggedIn: true,
      exploredAt: '2026-09-17T00:00:00.000Z',
      pages: [{
        title: 'Cariler',
        headings: ['Cariler'],
        links: ['http://uygulama.test/'],
        buttons: ['Yeni cari'],
        forms: [{ action: '/ara', fields: [{ name: 'q', type: 'text', label: 'Ara' }] }],
      }],
    });

    // İlk komut dosyanın içeriğini de yeni adlara çevirir: tek sözleşme kalır.
    const ham = await readFile(dizin.yol('map.json'), 'utf8');
    expect(ham).toContain('"pages"');
    expect(ham).not.toContain('"sayfalar"');
    expect(ham).not.toContain('"baslik"');
  });

  it('plan/onerileri.json → plan/proposals.json yeniden adlandırılır', async () => {
    const kok = await eskiProje({ oneriler: true });
    const dizin = (await KobayDizini.bul(kok))!;

    await expect(access(dizin.yol('plan', 'proposals.json'))).resolves.toBeUndefined();
    await expect(access(dizin.yol('plan', 'onerileri.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(dizin.onerileriOku()).resolves.toMatchObject([{ proposalId: 'p_abc123' }]);
  });

  it('config.json `beyin` ile açılır, ilk komutta `brain` ile yeniden yazılır', async () => {
    const kok = await eskiProje();
    const dizin = (await KobayDizini.bul(kok))!;

    await expect(dizin.configOku()).resolves.toEqual({
      baseUrl: 'http://uygulama.test',
      loginUrl: 'http://uygulama.test/giris',
      brain: { adaptor: 'sahte', model: 'm1' },
    });
    const ham = await readFile(dizin.yol('config.json'), 'utf8');
    expect(ham).toContain('"brain"');
    expect(ham).not.toContain('"beyin"');
  });

  it('credentials.json yeni adlarla ve 0600 ile yeniden yazılır', async () => {
    const kok = await eskiProje({ kimlik: true });
    const dizin = (await KobayDizini.bul(kok))!;

    await expect(dizin.kimlikOku()).resolves.toEqual({
      username: 'ali',
      password: 'gizli-1',
      origin: 'http://uygulama.test',
    });
    const ham = await readFile(dizin.yol('credentials.json'), 'utf8');
    expect(ham).toContain('"username"');
    expect(ham).not.toContain('"kullanici"');
    expect((await stat(dizin.yol('credentials.json'))).mode & 0o777).toBe(gizliDosyaModu);
  });

  it('hedef adı doluysa yeniden adlandırma yapılmaz; yeni dosya kazanır', async () => {
    const kok = await eskiProje();
    const dizin = (await KobayDizini.bul(kok))!;
    // İlk açılış map.json üretti; ikinci bir eski ad bırakılırsa üstüne yazılmaz.
    await writeFile(dizin.yol('harita.json'), '{"baseUrl":"x"}');
    const ikinci = (await KobayDizini.bul(kok))!;

    await expect(readFile(ikinci.yol('harita.json'), 'utf8')).resolves.toBe('{"baseUrl":"x"}');
    await expect(ikinci.haritaOku()).resolves.toMatchObject({ baseUrl: 'http://uygulama.test' });
  });

  it('eski alan adlı failure.json okunur (haritaFarki → mapDiff)', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    const eskiPaket = {
      ...paket(),
      haritaFarki: {
        url: 'http://uygulama.test/cariler',
        eklenenBasliklar: ['Müşteriler'],
        silinenBasliklar: ['Cariler'],
        eklenenDugmeler: [],
        silinenDugmeler: [],
        eklenenFormAlanlari: [],
        silinenFormAlanlari: [],
        sayfaKimligiUyusuyor: true,
        degisti: true,
      },
    };
    await mkdir(dizin.yol('failure', 't_abc12345'), { recursive: true });
    await writeFile(dizin.yol('failure', 't_abc12345', 'failure.json'), JSON.stringify(eskiPaket));

    await expect(dizin.hataPaketiOku('t_abc12345')).resolves.toMatchObject({
      mapDiff: { addedHeadings: ['Müşteriler'], removedHeadings: ['Cariler'], pageIdentityMatches: true, changed: true },
    });
  });

  it('eski adlı işaret ve `.eski-` kalıntısı kurtarmada tanınır', async () => {
    const kok = await eskiProje({ kimlik: true });
    const kobay = join(kok, '.kobay');
    const txnId = '11111111-2222-3333-4444-555555555555';
    // 0.1 biçiminde yarım kalmış işlem: Türkçe alan adları, eski işaret ve önek.
    await rename(join(kobay, 'credentials.json'), join(kobay, `.eski-${txnId}-credentials.json`));
    await writeFile(join(kobay, '.kimlik-islemi'), JSON.stringify({
      pid: process.pid,
      islemId: txnId,
      baslatildi: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      eskiConfig: {
        baseUrl: 'http://eski.test',
        beyin: { adaptor: 'sahte' },
      },
      kenaraAlinanlar: ['credentials.json'],
    }));

    const dizin = (await KobayDizini.bul(kok))!;

    // Geri alma yürüdü: config işlem öncesine döndü, kimlik geri kondu.
    await expect(dizin.configOku()).resolves.toEqual({
      baseUrl: 'http://eski.test',
      brain: { adaptor: 'sahte' },
    });
    await expect(dizin.kimlikOku()).resolves.toEqual({
      username: 'ali',
      password: 'gizli-1',
      origin: 'http://uygulama.test',
    });
    expect((await readdir(kobay)).filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
    await expect(access(join(kobay, '.kimlik-islemi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('göç hedefi kontrolden SONRA doğarsa yeni dosya ezilmez', async () => {
    const kok = await eskiProje();
    const dizin = (await KobayDizini.bul(kok))!;
    // Yarışı kur: bayat 0.1 dosyası geri konur, hedefte yeni içerik vardır.
    await writeFile(dizin.yol('harita.json'), JSON.stringify({ baseUrl: 'http://bayat.test' }));
    await writeFile(dizin.yol('map.json'), JSON.stringify({ baseUrl: 'http://yeni.test' }));
    // "Hedef var mı" kontrolü hedefi göremiyor: araya giren süreç onu
    // kontrolden sonra yazmış gibi. Kontrole güvenip `rename` eden eski kod
    // bayat dosyayı yeninin üstüne taşırdı; `link` EEXIST verip durur.
    atomikDurum.accessYokKosulu = (yol) => yol.endsWith('/map.json');

    const ikinci = (await KobayDizini.bul(kok))!;

    atomikDurum.accessYokKosulu = undefined;
    await expect(readFile(ikinci.yol('map.json'), 'utf8')).resolves.toContain('yeni.test');
    // Kaynak silinmez: hedef doluyken 0.1 dosyasına hiç dokunulmaz.
    await expect(readFile(ikinci.yol('harita.json'), 'utf8')).resolves.toContain('bayat.test');
  });

  it('sert bağ desteklenmeyen dosya sisteminde göç yine yürür (hedef yoksa taşı)', async () => {
    const kok = await eskiProje();
    // `link` yok (EXDEV): körlemesine değil, yalnız hedef boşken taşınır.
    atomikDurum.linkKodu = 'EXDEV';

    const dizin = (await KobayDizini.bul(kok))!;

    atomikDurum.linkKodu = undefined;
    await expect(dizin.haritaOku()).resolves.toMatchObject({ baseUrl: 'http://uygulama.test' });
    await expect(access(dizin.yol('map.json'))).resolves.toBeUndefined();
    await expect(access(dizin.yol('harita.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sert bağ yoksa ve hedef doluysa 0.1 dosyası yeniyi ezmez', async () => {
    const kok = await eskiProje();
    const dizin = (await KobayDizini.bul(kok))!;
    await writeFile(dizin.yol('harita.json'), JSON.stringify({ baseUrl: 'http://bayat.test' }));
    await writeFile(dizin.yol('map.json'), JSON.stringify({ baseUrl: 'http://yeni.test' }));
    atomikDurum.linkKodu = 'EXDEV';

    const ikinci = (await KobayDizini.bul(kok))!;

    atomikDurum.linkKodu = undefined;
    await expect(readFile(ikinci.yol('map.json'), 'utf8')).resolves.toContain('yeni.test');
  });

  // Windows chmod ile dizini yazılamaz yapmadığı için bu POSIX izin davranışı atlanır.
  it.skipIf(process.platform === 'win32')('yazılamayan .kobay: göç uyarı verir, harita ve öneriler eski adından okunur', async () => {
    if (process.getuid?.() === 0) return;
    const kok = await eskiProje({ oneriler: true });
    const kobay = join(kok, '.kobay');
    await chmod(join(kobay, 'plan'), 0o500);
    await chmod(kobay, 0o500);
    const uyarilar: string[] = [];
    const casus = vi.spyOn(process.stderr, 'write').mockImplementation((parca: unknown) => {
      uyarilar.push(String(parca));
      return true;
    });

    try {
      const dizin = (await KobayDizini.bul(kok))!;
      // Asıl bulgu: göç düştüğü hâlde veri görünmez olmamalı.
      await expect(dizin.haritaOku()).resolves.toMatchObject({
        baseUrl: 'http://uygulama.test',
        loggedIn: true,
      });
      await expect(dizin.onerileriOku()).resolves.toMatchObject([{ proposalId: 'p_abc123' }]);
    } finally {
      casus.mockRestore();
      await chmod(kobay, 0o700);
      await chmod(join(kobay, 'plan'), 0o700);
    }

    const basilan = uyarilar.join('');
    expect(basilan).toContain('could not migrate harita.json to map.json');
    expect(basilan).toContain('could not migrate plan/onerileri.json to plan/proposals.json');
    expect(basilan).toContain('reading the old file');
  });

  it('yeni işlem yeni adları yazar: .credentials-txn ve .stale- öneki', async () => {
    const dizin = await KobayDizini.ac(await geciciDizin(), config);
    await dizin.kimlikYaz({ username: 'ali', password: 'gizli-1' });

    await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });

    const girdiler = await readdir(dizin.kok);
    expect(girdiler).toContain('.credentials-txn');
    expect(girdiler.filter((ad) => ad.startsWith('.stale-'))).toEqual([`.stale-${
      String((JSON.parse(await readFile(dizin.yol('.credentials-txn'), 'utf8')) as { txnId: string }).txnId)
    }-credentials.json`]);
    expect(girdiler.filter((ad) => ad.startsWith('.eski-'))).toEqual([]);
  });
});
