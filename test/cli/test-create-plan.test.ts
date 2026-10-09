import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testCreate } from '../../src/cli/komutlar/index.js';
import { planUrlDogrula } from '../../src/cli/komutlar/test.js';
import { KobayDizini, type TestKaydi } from '../../src/depo/index.js';

async function proje(plan: Record<string, unknown>): Promise<{ cwd: string; dizin: KobayDizini }> {
  const cwd = await mkdtemp(join(tmpdir(), 'kobay-test-create-'));
  const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://uygulama.test', beyin: { adaptor: 'sahte' } });
  await writeFile(join(cwd, 'plan.json'), JSON.stringify({
    type: 'frontend',
    name: 'Kayıtlar listelenir',
    planSteps: [
      { type: 'action', description: 'Kayıtlar sayfasını aç' },
      { type: 'assertion', description: 'Kayıtlar başlığı görünür' },
    ],
    ...plan,
  }));
  return { cwd, dizin };
}

describe('test create: elle yazılan plan dosyası', () => {
  it('url alanını test kaydına taşır (yol ve aynı origin tam adres)', async () => {
    for (const url of ['/records', 'http://uygulama.test/records?sayfa=2']) {
      const { cwd, dizin } = await proje({ url });
      const sonuc = await testCreate({ cwd, planPath: 'plan.json' });
      expect(sonuc.exitCode, url).toBe(0);
      const kayit = sonuc.json as TestKaydi;
      expect(kayit.url, url).toBe(url);
      await expect(dizin.testOku(kayit.id)).resolves.toMatchObject({ url });
    }
  });

  it('projectId olmadan da test oluşturur; eski plan dosyasındaki projectId hâlâ kabul edilir', async () => {
    const yeni = await proje({});
    const sonuc = await testCreate({ cwd: yeni.cwd, planPath: 'plan.json' });
    expect(sonuc.exitCode).toBe(0);
    expect((sonuc.json as TestKaydi).url).toBeUndefined();

    const eski = await proje({ projectId: 'demo' });
    expect((await testCreate({ cwd: eski.cwd, planPath: 'plan.json' })).exitCode).toBe(0);
  });

  it('başka origin ya da bozuk url exit 2 verir ve test yazılmaz', async () => {
    for (const url of ['http://kotu.test/records', '//kotu.test/records', 'records', ' ']) {
      const { cwd, dizin } = await proje({ url });
      const sonuc = await testCreate({ cwd, planPath: 'plan.json' });
      expect(sonuc.exitCode, url).toBe(2);
      await expect(dizin.testListele()).resolves.toEqual([]);
    }
  });

  it('url hatasında baseUrl ve plan url kimliği maskelenir', async () => {
    const kimlikli = 'http://admin:Hunter2Pass@uygulama.test';
    const dizin = await mkdtemp(join(tmpdir(), 'kobay-test-create-'));
    await KobayDizini.ac(dizin, { baseUrl: kimlikli, beyin: { adaptor: 'sahte' } });
    for (const url of ['http://root:Hunter2Pass@kotu.test/x', 'records:Hunter2Pass@x', '//root:Hunter2Pass@kotu.test']) {
      await writeFile(join(dizin, 'plan.json'), JSON.stringify({
        type: 'frontend', name: 'Kayıtlar listelenir', url,
        planSteps: [{ type: 'action', description: 'a' }, { type: 'assertion', description: 'b' }],
      }));
      const sonuc = await testCreate({ cwd: dizin, planPath: 'plan.json' });
      expect(sonuc.exitCode, url).toBe(2);
      expect(JSON.stringify(sonuc), url).not.toContain('Hunter2Pass');
    }
    expect(() => planUrlDogrula('http://root:Hunter2Pass@kotu.test/x', kimlikli)).toThrow(/\[redacted\]@kotu\.test/);
  });

  it('ters bölü, //host, javascript: ve başka origin exit 2; kısayol yok (denetim P1)', async () => {
    for (const url of ['/\\evil.test/path', '/\\\\evil.test/path', '//evil.test/path', '/\t/evil.test/path', 'javascript:alert(1)', 'http://evil.test/records', 'ftp://uygulama.test/records']) {
      const { cwd, dizin } = await proje({ url });
      const sonuc = await testCreate({ cwd, planPath: 'plan.json' });
      expect(sonuc.exitCode, url).toBe(2);
      await expect(dizin.testListele()).resolves.toEqual([]);
    }
  });

  it('kayda çözülmüş, normalleştirilmiş değer yazılır', async () => {
    const baz = 'http://uygulama.test';
    expect(planUrlDogrula('/records', baz)).toBe('/records');
    expect(planUrlDogrula('/a/../records?x=1#y', baz)).toBe('/records?x=1#y');
    expect(planUrlDogrula('HTTP://UYGULAMA.TEST/records', baz)).toBe('http://uygulama.test/records');
    // Aynı origin'e çözülen ters bölülü yol güvenli biçime çevrilir.
    expect(planUrlDogrula('/\\uygulama.test/records', baz)).toBe('/records');
    expect(() => planUrlDogrula('/\\evil.test/path', baz)).toThrow(/different origin/);
    expect(() => planUrlDogrula('javascript:alert(1)', baz)).toThrow(/must be a path/);
  });

  it('giriş yapılandırılmış projede gerçek kimlik isteyen plan exit 2 ile reddedilir, test yazılmaz', async () => {
    const adimlar = (ilk: string) => ({ planSteps: [
      { type: 'action', description: ilk }, { type: 'assertion', description: 'Verify the admin panel is visible' },
    ] });
    const gercek = await proje({ name: 'Sign in as admin', ...adimlar('Enter the account secret') });
    await gercek.dizin.kimlikYaz({ username: 'u', password: 'p', origin: 'http://uygulama.test' });
    const sonuc = await testCreate({ cwd: gercek.cwd, planPath: 'plan.json' });
    expect(sonuc.exitCode).toBe(2);
    expect(JSON.stringify(sonuc.json)).toContain('needs the real credentials');
    await expect(gercek.dizin.testListele()).resolves.toEqual([]);

    // Sahte değer adımı ve kimliksiz proje: kabul.
    const sahte = await proje(adimlar('Enter a wrong password and submit'));
    await sahte.dizin.kimlikYaz({ username: 'u', password: 'p', origin: 'http://uygulama.test' });
    expect((await testCreate({ cwd: sahte.cwd, planPath: 'plan.json' })).exitCode).toBe(0);
    const kimliksiz = await proje(adimlar('Enter the account secret'));
    expect((await testCreate({ cwd: kimliksiz.cwd, planPath: 'plan.json' })).exitCode).toBe(0);
  });
});
