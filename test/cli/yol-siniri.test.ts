import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  failureGet,
  planGenerate,
  projectCreate,
  projectUpdate,
  testCreate,
} from '../../src/cli/komutlar/index.js';
import { KobayDizini, type HataPaketi } from '../../src/depo/index.js';

async function geciciDizin(onEk = 'kobay-sinir-'): Promise<string> {
  return mkdtemp(join(tmpdir(), onEk));
}

/** `failure get` senaryolarının ortak paketi. */
function ornekPaket(): HataPaketi {
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

/** Proje kökü + kökün dışında gerçek bir belge; kaçış senaryolarının ortak kurulumu. */
async function projeVeDisari(): Promise<{ cwd: string; disBelge: string }> {
  const cwd = await geciciDizin();
  const disari = await geciciDizin('kobay-disari-');
  const disBelge = join(disari, 'gercek.md');
  await Promise.all([
    writeFile(disBelge, '# Dışarıdaki belge\n'),
    projectCreate({ cwd, url: 'http://mesru.test', beyin: { adaptor: 'sahte' } }),
  ]);
  return { cwd, disBelge };
}

describe('CLI dosya yolları proje kökünden çıkamaz', () => {
  it('--plan proje kökünün dışını gösteremez', async () => {
    const { cwd, disBelge } = await projeVeDisari();

    for (const planPath of ['../../disarisi.json', '../disarisi.json', disBelge]) {
      const sonuc = await testCreate({ cwd, planPath });
      expect(sonuc.exitCode, planPath).toBe(2);
      expect(sonuc.mesaj, planPath).toContain('planPath proje kökü dışında olamaz');
    }
  });

  it('--docs ve --docs-path proje kökünün dışını gösteremez', async () => {
    const { cwd, disBelge } = await projeVeDisari();

    for (const docs of ['../disarisi.md', disBelge]) {
      const guncelle = await projectUpdate({ cwd, docs });
      expect(guncelle.exitCode, docs).toBe(2);
      expect(guncelle.mesaj, docs).toContain('docsPath proje kökü dışında olamaz');

      const olustur = await projectCreate({ cwd, url: 'http://mesru.test', force: true, docs });
      expect(olustur.exitCode, docs).toBe(2);
      expect(olustur.mesaj, docs).toContain('docs proje kökü dışında olamaz');
    }
    // Reddedilen belge config'e yazılmaz.
    const dizin = await KobayDizini.bul(cwd);
    expect(await dizin?.configOku()).not.toHaveProperty('docsPath');
  });

  it('kök içindeki symlink dışarıyı gösteriyorsa belge yolu reddedilir', async () => {
    const { cwd, disBelge } = await projeVeDisari();
    await mkdir(join(cwd, 'belge'), { recursive: true });
    await symlink(disBelge, join(cwd, 'belge', 'kacak.md'));

    const guncelle = await projectUpdate({ cwd, docs: 'belge/kacak.md' });
    expect(guncelle.exitCode).toBe(2);
    expect(guncelle.mesaj).toContain('docsPath proje kökü dışında olamaz');

    const planla = await testCreate({ cwd, planPath: 'belge/kacak.md' });
    expect(planla.exitCode).toBe(2);
    expect(planla.mesaj).toContain('planPath proje kökü dışında olamaz');
  });

  it('kayıtlı docsPath sonradan dışarı çevrilirse okuma anında reddedilir', async () => {
    const { cwd, disBelge } = await projeVeDisari();
    await mkdir(join(cwd, 'belge'), { recursive: true });
    await writeFile(join(cwd, 'belge', 'urun.md'), '# Ürün\n');
    expect((await projectUpdate({ cwd, docs: 'belge/urun.md' })).exitCode).toBe(0);

    // Kayıttan sonra dosya, kök dışını gösteren bir symlink'e çevriliyor.
    await rm(join(cwd, 'belge', 'urun.md'));
    await symlink(disBelge, join(cwd, 'belge', 'urun.md'));

    // Tarayıcı hiç açılmadan, belge okunmadan reddedilmeli.
    const plan = await planGenerate({ cwd });
    expect(plan.exitCode).toBe(2);
    expect(plan.mesaj).toContain('docsPath proje kökü dışında');
  });

  it('kök içindeki normal yol geçer', async () => {
    const cwd = await geciciDizin();
    await projectCreate({ cwd, url: 'http://mesru.test', beyin: { adaptor: 'sahte' } });
    await mkdir(join(cwd, 'belge', 'alt'), { recursive: true });
    await writeFile(join(cwd, 'belge', 'alt', 'urun.md'), '# Ürün\n');
    await writeFile(join(cwd, 'belge', 'plan.json'), JSON.stringify({
      projectId: 'kobay-sinir',
      type: 'frontend',
      name: 'Giriş akışı',
      priority: 'p0',
      planSteps: [
        { type: 'action', description: 'Ana sayfayı aç' },
        { type: 'assertion', description: 'Başlığı gör' },
      ],
    }));

    expect((await projectUpdate({ cwd, docs: 'belge/alt/urun.md' })).exitCode).toBe(0);
    const olustur = await testCreate({ cwd, planPath: 'belge/plan.json' });
    expect(olustur.mesaj ?? '').not.toContain('proje kökü dışında');
    expect(olustur.exitCode).toBe(0);
  });

  it('varsayılan failure get, .kobay/failure-out dışarıya symlink ise reddedilir', async () => {
    const cwd = await geciciDizin();
    const disari = await geciciDizin('kobay-disari-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    await dizin.hataPaketiYaz(ornekPaket(), []);
    await writeFile(join(disari, 'degerli.txt'), 'silinmemeli');
    await mkdir(join(disari, 't_abc12345'));
    await writeFile(join(disari, 't_abc12345', 'icerik.txt'), 'bu da silinmemeli');
    // Kötü niyetli klon: .kobay/failure-out repoda dışarıyı gösteren bir bağ.
    await rm(dizin.yol('failure-out'), { recursive: true, force: true });
    await symlink(disari, dizin.yol('failure-out'));

    const sonuc = await failureGet({ cwd, id: 't_abc12345' });

    expect(sonuc.exitCode).toBe(2);
    expect(sonuc.mesaj).toContain('Güvenli olmayan hata paketi çıkışı');
    // Kök dışındaki klasör el değmemiş olmalı.
    expect((await readdir(disari)).sort()).toEqual(['degerli.txt', 't_abc12345']);
    await expect(readFile(join(disari, 't_abc12345', 'icerik.txt'), 'utf8')).resolves.toBe('bu da silinmemeli');
  });

  it('varsayılan failure get, <testId> klasörü dışarıya symlink ise reddedilir', async () => {
    const cwd = await geciciDizin();
    const disari = await geciciDizin('kobay-disari-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    await dizin.hataPaketiYaz(ornekPaket(), []);
    await writeFile(join(disari, 'degerli.txt'), 'silinmemeli');
    await symlink(disari, dizin.yol('failure-out', 't_abc12345'));

    const sonuc = await failureGet({ cwd, id: 't_abc12345' });

    expect(sonuc.exitCode).toBe(2);
    expect(sonuc.mesaj).toContain('Güvenli olmayan hata paketi çıkışı');
    expect(await readdir(disari)).toEqual(['degerli.txt']);
  });

  it('symlink yoksa varsayılan failure get yerinde yenilemeye devam eder', async () => {
    const cwd = await geciciDizin();
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    await dizin.hataPaketiYaz(ornekPaket(), []);

    for (const tur of ['ilk', 'ikinci']) {
      const sonuc = await failureGet({ cwd, id: 't_abc12345' });
      expect(sonuc.exitCode, tur).toBe(0);
    }

    expect(await readdir(dizin.yol('failure-out'))).toEqual(['t_abc12345']);
    await access(dizin.yol('failure-out', 't_abc12345', 'failure.json'));
  });

  it('CLI failure get --out proje dışına yazabilir (bilinçli istisna)', async () => {
    const cwd = await geciciDizin();
    const disari = await geciciDizin('kobay-disari-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
    await dizin.hataPaketiYaz(ornekPaket(), []);

    const hedef = join(disari, 'paket');
    const sonuc = await failureGet({ cwd, id: 't_abc12345', out: hedef });
    expect(sonuc.mesaj ?? '').not.toContain('proje kökü dışında');
    expect(sonuc.exitCode).toBe(0);
    await access(join(hedef, 'failure.json'));
  });
});
