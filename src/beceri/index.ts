import { constants, readFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { yazAtomik } from '../depo/index.js';

const baslangic = '<!-- kobay:BEGIN -->';
const bitis = '<!-- kobay:END -->';
const beceriYolu = fileURLToPath(new URL('../../beceri/SKILL.md', import.meta.url));

export function beceriMetni(): string {
  return readFileSync(beceriYolu, 'utf8');
}

function govde(metin: string): string {
  const ayrac = metin.indexOf('\n\n');
  return ayrac === -1 ? metin : metin.slice(ayrac + 2);
}

function isaretliIcerik(metin: string): string {
  return `${baslangic}\n${govde(metin).trim()}\n${bitis}`;
}

function codexIcerigi(mevcut: string, yeni: string): string {
  const bas = mevcut.indexOf(baslangic);
  const son = mevcut.indexOf(bitis, bas + baslangic.length);
  if (bas === -1 || son === -1) {
    return `${mevcut.trimEnd()}${mevcut.trimEnd() ? '\n\n' : ''}${yeni}\n`;
  }
  return `${mevcut.slice(0, bas)}${yeni}${mevcut.slice(son + bitis.length)}`;
}

async function mevcutOku(yol: string): Promise<string> {
  try {
    return await readFile(yol, 'utf8');
  } catch (hata: unknown) {
    if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') {
      return '';
    }
    throw hata;
  }
}

/** Bir dosyaya yazmanın sonucu; JSON çıktısındaki `action` alanının değeri. */
export type Islem = 'created' | 'updated' | 'unchanged';

async function kur(yol: string, icerik: string): Promise<Islem> {
  const mevcut = await mevcutOku(yol);
  if (mevcut === icerik) return 'unchanged';
  await yazAtomik(yol, icerik);
  return mevcut === '' ? 'created' : 'updated';
}

/**
 * Beceri dosyası ajanı yönlendirir; araçların kendisi MCP sunucusundan gelir.
 * Claude hedefinde kayıt artık talimat değil: `.mcp.json` doğrudan yazılır
 * (bkz. `mcpKaydiYaz`). Codex ve Cursor'da kaydı kullanıcı yapar; kobay
 * onların yapılandırmasına kendiliğinden dokunmaz.
 */
export function mcpKayitTalimati(hedef: 'codex' | 'cursor'): string {
  if (hedef === 'codex') return 'MCP registration: `codex mcp add kobay -- kobay mcp`';
  return 'MCP registration: add `{ "mcpServers": { "kobay": { "command": "kobay", "args": ["mcp"] } } }` to `.cursor/mcp.json`';
}

/** `.mcp.json` var ama JSON olarak okunamıyor ya da beklenen biçimde değil. */
export class McpRegistryUnreadable extends Error {
  constructor(yol: string, sebep: string) {
    super(
      `Could not write the MCP registration: ${yol} ${sebep}.`
      + ' The file was left untouched; fix it by hand and run'
      + ' `kobay agent install --target claude` again.',
    );
    this.name = 'McpRegistryUnreadable';
  }
}

/**
 * `kobay` çalıştırılabiliri PATH'te mi? Tespit yalnız dosya sistemine bakar:
 * PATH'teki her dizinde `kobay` (Windows'ta `PATHEXT` uzantılarıyla) aranır ve
 * çalıştırma izni denenir. Süreç başlatılmaz — kurulum komutu, kurulu olmayan
 * bir paketi indirmek için ağa çıkmaz.
 *
 * Boş bileşen (`:/usr/bin`, `/usr/bin:`, `a::b`) atılmaz: POSIX'te sıfır
 * uzunluklu ön ek çalışma dizini demektir, kabuk orada da arar. Atsaydık
 * kabuğun `kobay`ı bulduğu bir kurulumda `npx -y kobay` yazardık. PATH hiç
 * tanımlı değilse arama yapılmaz (boş PATH ile karıştırılmaz).
 */
async function kobayKomutuVarMi(ortam: NodeJS.ProcessEnv): Promise<boolean> {
  const ham = ortam.PATH ?? ortam.Path;
  if (ham === undefined) return false;
  const patikalar = ham.split(delimiter).map((parca) => (parca === '' ? process.cwd() : parca));
  const uzantilar = process.platform === 'win32'
    ? (ortam.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((parca) => parca !== '')
    : [''];
  for (const dizin of patikalar) {
    for (const uzanti of uzantilar) {
      try {
        // İlk eşleşmede duruluyor; paralel tarama gereksiz iş yapardı.
        await access(join(dizin, `kobay${uzanti}`), constants.X_OK);
        return true;
      } catch {
        // Bu dizinde yok; sıradakine bak.
      }
    }
  }
  return false;
}

/** `.mcp.json` içine yazılan sunucu girdisi. */
export interface McpSunucuGirdisi {
  command: string;
  args: string[];
}

/**
 * Küresel kurulum varsa `kobay mcp`, yoksa `npx -y kobay mcp`. İkincisi
 * `npx kobay` ile denenen projelerde de çalışan tek biçim.
 */
export async function mcpSunucuGirdisi(ortam: NodeJS.ProcessEnv = process.env): Promise<McpSunucuGirdisi> {
  return await kobayKomutuVarMi(ortam)
    ? { command: 'kobay', args: ['mcp'] }
    : { command: 'npx', args: ['-y', 'kobay', 'mcp'] };
}

function duzNesneMi(deger: unknown): deger is Record<string, unknown> {
  return typeof deger === 'object' && deger !== null && !Array.isArray(deger);
}

/**
 * Proje kökündeki `.mcp.json` dosyasına kobay sunucusunu yazar.
 *
 * Birleştirme kuralı: dosya yoksa oluşturulur; varsa köküyle birlikte bütün
 * alanları ve `mcpServers` altındaki diğer sunucular korunur, yalnız `kobay`
 * anahtarı üzerine yazılır. Geçerli JSON değilse (ya da kök/`mcpServers` bir
 * nesne değilse) dosyaya hiç dokunulmaz, `McpRegistryUnreadable` atılır: burada
 * sessizce üzerine yazmak kullanıcının başka sunucularını silerdi.
 */
export async function mcpKaydiYaz(
  projeKoku: string,
  girdi: McpSunucuGirdisi,
): Promise<{ path: string; action: Islem; command: string[] }> {
  const yol = resolve(projeKoku, '.mcp.json');
  const mevcut = await mevcutOku(yol);
  let kok: Record<string, unknown> = {};
  if (mevcut.trim() !== '') {
    let cozulen: unknown;
    try {
      cozulen = JSON.parse(mevcut);
    } catch {
      throw new McpRegistryUnreadable(yol, 'is not valid JSON');
    }
    if (!duzNesneMi(cozulen)) throw new McpRegistryUnreadable(yol, 'does not hold a JSON object at its root');
    kok = cozulen;
  }
  const sunucular = kok.mcpServers;
  if (sunucular !== undefined && !duzNesneMi(sunucular)) {
    throw new McpRegistryUnreadable(yol, 'has an `mcpServers` field that is not a JSON object');
  }
  const yeni = {
    ...kok,
    mcpServers: { ...(sunucular ?? {}), kobay: { command: girdi.command, args: girdi.args } },
  };
  return {
    path: yol,
    action: await kur(yol, `${JSON.stringify(yeni, null, 2)}\n`),
    command: [girdi.command, ...girdi.args],
  };
}

const ISLEM_METNI = {
  created: 'created',
  updated: 'updated',
  unchanged: 'unchanged (already up to date)',
} as const;

const MCP_ISLEM_METNI = {
  created: 'MCP registered in .mcp.json',
  updated: 'MCP registration updated in .mcp.json',
  unchanged: 'MCP already registered in .mcp.json',
} as const;

/** `agent install` sonucu; `mcp` yalnız `.mcp.json` yazılan hedeflerde (claude) doludur. */
export interface BeceriKurulumu {
  path: string;
  action: Islem;
  mcp?: { path: string; action: Islem; command: string[] };
}

/** Kurulumdan sonra insana gösterilen metin; JSON gövdesi aynı bilgiyi verir. */
export function kurulumMesaji(hedef: 'claude' | 'codex' | 'cursor', sonuc: BeceriKurulumu): string {
  const bas = `Skill ${ISLEM_METNI[sonuc.action]}: ${sonuc.path}`;
  if (hedef === 'claude') {
    if (sonuc.mcp === undefined) return bas;
    const komut = sonuc.mcp.command.join(' ');
    return `${bas}\n${MCP_ISLEM_METNI[sonuc.mcp.action]} (kobay → \`${komut}\`): ${sonuc.mcp.path}`;
  }
  return `${bas}\n${mcpKayitTalimati(hedef)}`;
}

export async function beceriKur(
  hedef: 'claude' | 'codex' | 'cursor',
  s: { projeKoku: string; ortam?: NodeJS.ProcessEnv },
): Promise<BeceriKurulumu> {
  const metin = beceriMetni();
  if (hedef === 'claude') {
    const yol = resolve(s.projeKoku, '.claude', 'skills', 'kobay', 'SKILL.md');
    const islem = await kur(yol, metin);
    // Beceri yazıldıktan sonra kayıt: `.mcp.json` geçersizse komut düşer ama
    // beceri yerinde kalır; düzeltip komutu yeniden çalıştırmak yeterlidir.
    const mcp = await mcpKaydiYaz(s.projeKoku, await mcpSunucuGirdisi(s.ortam ?? process.env));
    return { path: yol, action: islem, mcp };
  }

  if (hedef === 'codex') {
    const yol = resolve(s.projeKoku, 'AGENTS.md');
    const mevcut = await mevcutOku(yol);
    const icerik = codexIcerigi(mevcut, isaretliIcerik(metin));
    return { path: yol, action: await kur(yol, icerik) };
  }

  const yol = resolve(s.projeKoku, '.cursor', 'rules', 'kobay.mdc');
  const icerik = `---\ndescription: Verify web app features with kobay\nalwaysApply: false\n---\n\n${govde(metin).trim()}\n`;
  return { path: yol, action: await kur(yol, icerik) };
}
