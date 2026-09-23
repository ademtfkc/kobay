import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { agentInstall } from '../../src/cli/komutlar/index.js';
import {
  beceriKur, beceriMetni, kurulumMesaji, mcpKayitTalimati, mcpSunucuGirdisi,
} from '../../src/beceri/index.js';
import { yazAtomik } from '../../src/depo/index.js';

/** `kobay` bulunmayan PATH: tespit `npx -y kobay mcp` biçimine düşmeli. */
const KOBAYSIZ_PATH = { PATH: join(tmpdir(), 'kobay-yok-bir-dizin') };

async function mcpOku(proje: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(proje, '.mcp.json'), 'utf8')) as Record<string, unknown>;
}

async function geciciDizin(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kobay-beceri-'));
}

describe('beceri kurulumu', () => {
  it('Claude becerisini proje altında kurar ve ikinci çağrıda değiştirmez', async () => {
    const proje = await geciciDizin();

    await expect(beceriKur('claude', { projeKoku: proje })).resolves.toMatchObject({
      islem: 'olusturuldu',
    });
    await expect(beceriKur('claude', { projeKoku: proje })).resolves.toMatchObject({
      islem: 'degismedi',
    });
    await expect(readFile(join(proje, '.claude', 'skills', 'kobay', 'SKILL.md'), 'utf8')).resolves.toBe(
      beceriMetni(),
    );
  });

  it('Codex managed bölümünü ekler, dışarıyı korur ve çoğaltmaz', async () => {
    const proje = await geciciDizin();
    const agents = join(proje, 'AGENTS.md');
    const disarisi = '# Proje kuralları\n\nBuna dokunma.\n';

    await yazAtomik(agents, disarisi);
    const ilk = await beceriKur('codex', { projeKoku: proje });
    expect(ilk.islem).toBe('guncellendi');
    const ilkIcerik = await readFile(agents, 'utf8');
    expect(ilkIcerik).toContain(disarisi.trim());
    expect(ilkIcerik.match(/<!-- kobay:BEGIN -->/g)).toHaveLength(1);
    expect(ilkIcerik.match(/<!-- kobay:END -->/g)).toHaveLength(1);

    await expect(beceriKur('codex', { projeKoku: proje })).resolves.toMatchObject({ islem: 'degismedi' });
    await expect(readFile(agents, 'utf8')).resolves.toBe(ilkIcerik);
  });

  it('Codex eski managed bölümünü günceller', async () => {
    const proje = await geciciDizin();
    const agents = join(proje, 'AGENTS.md');
    const eski = '# Dış kural\n\n<!-- kobay:BEGIN -->\neski içerik\n<!-- kobay:END -->\n';

    await yazAtomik(agents, eski);
    await expect(beceriKur('codex', { projeKoku: proje })).resolves.toMatchObject({ islem: 'guncellendi' });
    const yeni = await readFile(agents, 'utf8');
    expect(yeni).toContain('# Dış kural');
    expect(yeni).not.toContain('eski içerik');
    expect(yeni.match(/<!-- kobay:BEGIN -->/g)).toHaveLength(1);
  });

  it('Cursor kuralını frontmatter ile oluşturur', async () => {
    const proje = await geciciDizin();
    const sonuc = await beceriKur('cursor', { projeKoku: proje });
    const icerik = await readFile(sonuc.yol, 'utf8');

    expect(icerik).toMatch(/^---\ndescription: .+\nalwaysApply: false\n---\n/);
    expect(icerik).toContain('Verify web app features with kobay');
  });

  it('kurulum çıktısı İngilizce, yolu ve README ile aynı MCP kaydını söyler', async () => {
    const proje = await geciciDizin();
    const home = join(proje, 'home');

    const ilk = await agentInstall({ cwd: proje, target: 'claude', home, ortam: KOBAYSIZ_PATH });
    expect(ilk.exitCode).toBe(0);
    expect(ilk.metin).toContain('Skill created');
    expect(ilk.metin).toContain(join(proje, '.claude', 'skills', 'kobay', 'SKILL.md'));
    expect(ilk.metin).not.toContain(join(home, '.claude', 'skills', 'kobay', 'SKILL.md'));
    expect(ilk.metin).toContain('MCP registered in .mcp.json');
    expect(ilk.metin).toContain(join(proje, '.mcp.json'));
    // Talimat basma dönemi bitti: kullanıcının elle çalıştıracağı komut kalmadı.
    expect(ilk.metin).not.toContain('claude mcp add');
    expect(ilk.metin).not.toContain('olusturuldu');
    expect(ilk.json).toMatchObject({
      mcp: { yol: join(proje, '.mcp.json'), islem: 'olusturuldu', komut: ['npx', '-y', 'kobay', 'mcp'] },
    });

    const ikinci = await agentInstall({ cwd: proje, target: 'claude', home, ortam: KOBAYSIZ_PATH });
    expect(ikinci.metin).toContain('unchanged');
    expect(ikinci.metin).toContain('MCP already registered in .mcp.json');
    expect(ikinci.json).toMatchObject({ islem: 'degismedi', mcp: { islem: 'degismedi' } });
  });

  it('.mcp.json yoksa oluşturur, kobay PATH\'teyse kısa komutu yazar', async () => {
    const proje = await geciciDizin();
    const sahtePath = join(proje, 'bin');
    await mkdir(sahtePath, { recursive: true });
    await writeFile(join(sahtePath, 'kobay'), '#!/bin/sh\n', { mode: 0o755 });

    const sonuc = await beceriKur('claude', { projeKoku: proje, ortam: { PATH: sahtePath } });
    expect(sonuc.mcp).toMatchObject({ yol: join(proje, '.mcp.json'), islem: 'olusturuldu', komut: ['kobay', 'mcp'] });
    expect(await mcpOku(proje)).toEqual({
      mcpServers: { kobay: { command: 'kobay', args: ['mcp'] } },
    });
  });

  it('kobay PATH\'te yoksa npx biçimine düşer', async () => {
    const proje = await geciciDizin();
    await expect(mcpSunucuGirdisi(KOBAYSIZ_PATH)).resolves.toEqual({ command: 'npx', args: ['-y', 'kobay', 'mcp'] });

    await beceriKur('claude', { projeKoku: proje, ortam: KOBAYSIZ_PATH });
    expect(await mcpOku(proje)).toEqual({
      mcpServers: { kobay: { command: 'npx', args: ['-y', 'kobay', 'mcp'] } },
    });
  });

  it('PATH\'teki boş bileşen çalışma dizini demektir; oradaki kobay bulunur', async () => {
    const calismaDizini = await geciciDizin();
    await writeFile(join(calismaDizini, 'kobay'), '#!/bin/sh\n', { mode: 0o755 });
    const casus = vi.spyOn(process, 'cwd').mockReturnValue(calismaDizini);
    try {
      // Baştaki `:` sıfır uzunluklu ön ek; kabuk burada çalışma dizinine bakar.
      await expect(mcpSunucuGirdisi({ PATH: `:${join(tmpdir(), 'kobay-yok-bir-dizin')}` }))
        .resolves.toEqual({ command: 'kobay', args: ['mcp'] });
      await expect(mcpSunucuGirdisi({ PATH: `${join(tmpdir(), 'kobay-yok-bir-dizin')}:` }))
        .resolves.toEqual({ command: 'kobay', args: ['mcp'] });
    } finally {
      casus.mockRestore();
    }
  });

  it('PATH hiç tanımlı değilse çalışma dizini aranmaz', async () => {
    const calismaDizini = await geciciDizin();
    await writeFile(join(calismaDizini, 'kobay'), '#!/bin/sh\n', { mode: 0o755 });
    const casus = vi.spyOn(process, 'cwd').mockReturnValue(calismaDizini);
    try {
      await expect(mcpSunucuGirdisi({})).resolves.toEqual({ command: 'npx', args: ['-y', 'kobay', 'mcp'] });
    } finally {
      casus.mockRestore();
    }
  });

  it('mevcut .mcp.json ile birleşir: başka sunucular ve kök alanlar korunur', async () => {
    const proje = await geciciDizin();
    await yazAtomik(join(proje, '.mcp.json'), `${JSON.stringify({
      mcpServers: { baska: { command: 'node', args: ['sunucu.js'] }, kobay: { command: 'eski', args: [] } },
      inputs: [{ id: 'token' }],
    }, null, 2)}\n`);

    const sonuc = await beceriKur('claude', { projeKoku: proje, ortam: KOBAYSIZ_PATH });
    expect(sonuc.mcp?.islem).toBe('guncellendi');
    expect(await mcpOku(proje)).toEqual({
      mcpServers: {
        baska: { command: 'node', args: ['sunucu.js'] },
        kobay: { command: 'npx', args: ['-y', 'kobay', 'mcp'] },
      },
      inputs: [{ id: 'token' }],
    });
  });

  it('geçersiz .mcp.json dosyaya dokunmadan hata verir', async () => {
    const proje = await geciciDizin();
    const yol = join(proje, '.mcp.json');
    const bozuk = '{ "mcpServers": { "kobay": }\n';
    await yazAtomik(yol, bozuk);

    const sonuc = await agentInstall({ cwd: proje, target: 'claude', ortam: KOBAYSIZ_PATH });
    // Kullanıcı hatası (çıkış 2), motor arızası değil.
    expect(sonuc.exitCode).toBe(2);
    expect(sonuc.json).toMatchObject({ hata: { kod: 'McpKaydiOkunamadi' } });
    await expect(readFile(yol, 'utf8')).resolves.toBe(bozuk);
  });

  it('mcpServers nesne değilse dosyaya dokunulmaz', async () => {
    const proje = await geciciDizin();
    const yol = join(proje, '.mcp.json');
    const bozuk = `${JSON.stringify({ mcpServers: ['kobay'] }, null, 2)}\n`;
    await yazAtomik(yol, bozuk);

    await expect(beceriKur('claude', { projeKoku: proje, ortam: KOBAYSIZ_PATH })).rejects.toThrow('mcpServers');
    await expect(readFile(yol, 'utf8')).resolves.toBe(bozuk);
  });

  it('codex ve cursor .mcp.json yazmaz, talimat basmayı sürdürür', async () => {
    for (const hedef of ['codex', 'cursor'] as const) {
      const proje = await geciciDizin();
      const sonuc = await agentInstall({ cwd: proje, target: hedef, ortam: KOBAYSIZ_PATH });

      expect(sonuc.exitCode).toBe(0);
      expect(sonuc.json).toMatchObject({ mcp: mcpKayitTalimati(hedef) });
      expect(sonuc.metin).toContain(mcpKayitTalimati(hedef));
      await expect(readFile(join(proje, '.mcp.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('MCP kayıt talimatı README satırlarını birebir verir', () => {
    expect(mcpKayitTalimati('codex')).toBe('MCP registration: `codex mcp add kobay -- kobay mcp`');
    expect(mcpKayitTalimati('cursor')).toBe('MCP registration: add `{ "mcpServers": { "kobay": { "command": "kobay", "args": ["mcp"] } } }` to `.cursor/mcp.json`');
  });

  it('kurulum mesajı İngilizce, JSON işlem anahtarı değişmez', () => {
    const yol = '/p/.claude/skills/kobay/SKILL.md';
    const mcp = { yol: '/p/.mcp.json', islem: 'olusturuldu' as const, komut: ['kobay', 'mcp'] };
    expect(kurulumMesaji('claude', { yol, islem: 'olusturuldu', mcp })).toBe(
      `Skill created: ${yol}\nMCP registered in .mcp.json (kobay → \`kobay mcp\`): /p/.mcp.json`,
    );
    expect(kurulumMesaji('codex', { yol, islem: 'guncellendi' })).toBe(`Skill updated: ${yol}\n${mcpKayitTalimati('codex')}`);
    expect(kurulumMesaji('cursor', { yol, islem: 'degismedi' })).toContain('unchanged');
  });
});
