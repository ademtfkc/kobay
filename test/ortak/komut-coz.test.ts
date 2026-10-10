import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { komutCagrisiHazirla, komutCoz, sureciSonlandir, surecAgaciniCoz } from '../../src/ortak/komut-coz.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

const require = createRequire(import.meta.url);

describe('komutCoz', () => {
  it('win32 PATHEXT ile codex.cmd bulur; cmd alıntısı cross-spawn ile aynıdır', async () => {
    const dizin = await geciciDizinAc('kobay-komut-coz-');
    await writeFile(join(dizin, 'codex.cmd'), '@echo off\r\n', { mode: 0o755 });
    const komut = await komutCoz('codex', {
      platform: 'win32', env: { PATH: dizin, PATHEXT: '.cmd' },
    });

    expect(komut).toBe(join(dizin, 'codex.cmd'));
    const argumanlar = ['exec', 'a&b', '', '%USERPROFILE%'];
    const oncekiPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const oncekiComSpec = process.env.ComSpec;
    const oncekiComspec = process.env.comspec;
    const comSpec = 'C:\\Windows\\system32\\cmd.exe';
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    process.env.ComSpec = comSpec;
    process.env.comspec = comSpec;
    const parseYolu = require.resolve('cross-spawn/lib/parse');
    delete require.cache[parseYolu];
    try {
      const parse = require('cross-spawn/lib/parse') as (komut: string, args: string[], secenekler: object) => {
        command: string; args: string[]; options: { windowsVerbatimArguments?: boolean };
      };
      const crossSpawn = parse('C:\\Program Files\\nodejs\\codex.cmd', argumanlar, {});
      expect(komutCagrisiHazirla('C:\\Program Files\\nodejs\\codex.cmd', argumanlar, 'win32', { ComSpec: comSpec })).toEqual({
        komut: crossSpawn.command,
        argumanlar: crossSpawn.args,
        spawnSecenekleri: { windowsVerbatimArguments: crossSpawn.options.windowsVerbatimArguments },
      });
    } finally {
      delete require.cache[parseYolu];
      Object.defineProperty(process, 'platform', oncekiPlatform);
      if (oncekiComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = oncekiComSpec;
      if (oncekiComspec === undefined) delete process.env.comspec;
      else process.env.comspec = oncekiComspec;
    }
    expect(komutCagrisiHazirla(komut!, ['exec', '--tools', ''], 'win32', { ComSpec: comSpec })).toEqual({
      komut: comSpec,
      argumanlar: ['/d', '/s', '/c', `"${komut} ^"exec^" ^"--tools^" ^"^""`],
      spawnSecenekleri: { windowsVerbatimArguments: true },
    });
  });

  // Windows sürücü iki noktası, enjekte edilmiş POSIX PATH ayırıcısıyla temsil edilemez.
  it.skipIf(process.platform === 'win32')('POSIX PATH içindeki yürütülebiliri doğrudan döndürür', async () => {
    const dizin = await geciciDizinAc('kobay-komut-coz-');
    const komutYolu = join(dizin, 'codex');
    await writeFile(komutYolu, '#!/bin/sh\n', { mode: 0o755 });

    await expect(komutCoz('codex', { platform: 'linux', env: { PATH: dizin } })).resolves.toBe(komutYolu);
    expect(komutCagrisiHazirla(komutYolu, ['exec'], 'linux')).toEqual({
      komut: komutYolu, argumanlar: ['exec'], spawnSecenekleri: {},
    });
  });
});

describe('sureciSonlandir', () => {
  it('win32 zaman aşımında taskkill ile süreç ağacını kapatır', async () => {
    const taskkill = new EventEmitter();
    const baslat = vi.fn(() => taskkill) as unknown as typeof spawn;
    const surec = { pid: 4321, kill: vi.fn(() => true) };
    const bitir = sureciSonlandir(surec, { platform: 'win32', spawnIslevi: baslat });
    queueMicrotask(() => { taskkill.emit('close', 0); });
    await bitir;

    expect(baslat).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
    expect(surec.kill).not.toHaveBeenCalled();
  });

  it('POSIX zaman aşımında taskkill çağırmadan SIGTERM kullanır', async () => {
    const baslat = vi.fn() as unknown as typeof spawn;
    const surec = { pid: 4321, kill: vi.fn(() => true) };
    await sureciSonlandir(surec, { platform: 'linux', spawnIslevi: baslat });

    expect(baslat).not.toHaveBeenCalled();
    expect(surec.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('POSIX süreç ağacı', () => {
  // 100 kök çocuk (kobay grubu 50), 101 worker, 102 Chromium (kendi grubunda), 103 Chromium yardımcısı, 900 ilgisiz.
  const ps = ['100 1 50', '101 100 50', '102 101 102', '103 102 102', '900 1 900'].join('\n');

  it('yalnız kökün torunlarını ve lideri torun olan grupları seçer', () => {
    const agac = surecAgaciniCoz(ps, 100);
    expect(agac.pidler.sort()).toEqual([101, 102, 103]);
    // 50 numaralı grubun lideri (kobay/kabuk) torun değil: asla sinyal almaz.
    expect(agac.gruplar).toEqual([102]);
  });

  it('agac:true SIGTERM sonrası yaşayanlara SIGKILL gönderir', async () => {
    const yasayanlar = new Set([101, 102, 103]);
    const gonderilen: Array<[number, string | number]> = [];
    const killIslevi = (pid: number, sinyal: NodeJS.Signals | 0): void => {
      gonderilen.push([pid, sinyal]);
      if (pid > 0 && !yasayanlar.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (sinyal === 'SIGKILL') yasayanlar.delete(pid);
    };
    const surec = { pid: 100, kill: vi.fn(() => true) };
    await sureciSonlandir(surec, {
      platform: 'linux', agac: true, zorlaBeklemeMs: 100, psOkuyucu: () => Promise.resolve(ps), killIslevi,
    });

    expect(surec.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(surec.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(gonderilen).toContainEqual([-102, 'SIGTERM']);
    expect(gonderilen).toContainEqual([101, 'SIGKILL']);
    expect(gonderilen.some(([pid]) => pid === -50 || pid === 50)).toBe(false);
  });

  it('ps zaman aşımına düşerse yalnız köke SIGTERM, bekleme sonrası SIGKILL gider ve asılı kalmaz', async () => {
    const gonderilen: Array<[number, string | number]> = [];
    // Kök SIGTERM'i yok sayar: canlılık yoklaması (sinyal 0) hep başarılı.
    const killIslevi = vi.fn((pid: number, sinyal: NodeJS.Signals | 0) => { gonderilen.push([pid, sinyal]); });
    const surec = { pid: 100, kill: vi.fn(() => true) };
    const asili = (): Promise<string> => new Promise<string>(() => { /* hiç dönmez */ });
    const baslangic = Date.now();
    await sureciSonlandir(surec, {
      platform: 'linux', agac: true, zorlaBeklemeMs: 100, psZamanAsimiMs: 50, psOkuyucu: asili, killIslevi,
    });

    expect(surec.kill.mock.calls.map(([sinyal]) => sinyal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(Date.now() - baslangic).toBeGreaterThanOrEqual(140);
    // Torunlara (ya da gruplara) hiçbir sinyal gitmez; yalnız kökün canlılığına bakılır.
    expect(gonderilen.every(([pid, sinyal]) => pid === 100 && sinyal === 0)).toBe(true);
  });

  it('ps boş dönerse kök SIGTERM ile kapanınca beklemeden çıkar, yine SIGKILL denenir', async () => {
    let canli = true;
    const killIslevi = (pid: number, sinyal: NodeJS.Signals | 0): void => {
      if (pid !== 100 || sinyal !== 0) throw new Error(`beklenmeyen sinyal ${pid} ${sinyal}`);
      if (!canli) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    const surec = { pid: 100, kill: vi.fn((sinyal?: NodeJS.Signals) => { if (sinyal === 'SIGTERM') canli = false; return true; }) };
    const baslangic = Date.now();
    await sureciSonlandir(surec, {
      platform: 'linux', agac: true, zorlaBeklemeMs: 5_000, psOkuyucu: () => Promise.resolve(''), killIslevi,
    });

    expect(surec.kill.mock.calls.map(([sinyal]) => sinyal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(Date.now() - baslangic).toBeLessThan(1_000);
  });

  describe('SIGKILL öncesi yeniden bakış', () => {
    const t0 = 'Mon Sep 28 10:00:00 2026';
    const ilk = [`100 1 50 ${t0}`, `101 100 50 ${t0}`, `102 101 102 ${t0}`, `103 102 102 ${t0}`].join('\n');

    async function sonlandir(yeniPs: string): Promise<Array<[number, string | number]>> {
      const gonderilen: Array<[number, string | number]> = [];
      const killIslevi = (pid: number, sinyal: NodeJS.Signals | 0): void => { gonderilen.push([pid, sinyal]); };
      const okumalar = [ilk, yeniPs];
      const surec = { pid: 100, kill: vi.fn(() => true) };
      await sureciSonlandir(surec, {
        platform: 'linux', agac: true, zorlaBeklemeMs: 60,
        psOkuyucu: () => Promise.resolve(okumalar.shift() ?? ''), killIslevi,
      });
      expect(surec.kill).toHaveBeenLastCalledWith('SIGKILL');
      return gonderilen.filter(([, sinyal]) => sinyal === 'SIGKILL');
    }

    it('soydan çıkan (yeniden kullanılan) pid ve grubuna SIGKILL göndermez', async () => {
      // Kök öldü; worker 101 ve yardımcı 103 öksüz kaldı (aynı süreç). 102 öldü, pid'i ilgisiz bir sürece geçti.
      const yeni = [`101 1 50 ${t0}`, '102 1 102 Mon Sep 28 10:00:02 2026', `103 1 102 ${t0}`].join('\n');
      const kill = await sonlandir(yeni);

      expect(kill).toContainEqual([101, 'SIGKILL']);
      expect(kill).toContainEqual([103, 'SIGKILL']);
      expect(kill.some(([pid]) => pid === 102 || pid === -102)).toBe(false);
    });

    it('başka üste bağlı aynı başlangıçlı pid de soydan sayılmaz', async () => {
      // 101 hâlâ yaşıyor ama 102 artık 101'in değil, ilgisiz 700'ün çocuğu (üst değişmemiş olmalıydı).
      const yeni = [`100 1 50 ${t0}`, `101 100 50 ${t0}`, `102 700 102 ${t0}`, `700 1 700 ${t0}`].join('\n');
      const kill = await sonlandir(yeni);

      expect(kill).toContainEqual([101, 'SIGKILL']);
      expect(kill.some(([pid]) => pid === 102 || pid === -102 || pid === 103)).toBe(false);
    });

    it('yeniden okuma başarısızsa doğrulanamayan hiçbir toruna SIGKILL gitmez', async () => {
      const kill = await sonlandir('');
      expect(kill).toEqual([]);
    });
  });
});
