import { hedefAyaktaMi } from '../../kos/index.js';
import { basariliMetin, type KomutSonucu } from '../komut.js';
import { chromiumVarMi, komutVarMi } from './setup.js';
import { KobayDizini } from '../../depo/index.js';

/** Doctor satırı: `oneri` yalnız `ok: false` iken bulunur. */
export interface Kontrol {
  name: string;
  ok: boolean;
  hint?: string;
}

/** Chromium eksikse verilen öneri; kurulu makinede de sınanabilsin diye dışa açık. */
export const CHROMIUM_ONERISI = 'run `kobay install-browser` (Linux: `kobay install-browser --with-deps`)';

export function nodeSurumuYeterliMi(surum: string): boolean {
  const [ana = 0, alt = 0] = surum.split('.').map(Number);
  return ana > 22 || (ana === 22 && alt >= 12);
}

export async function doctor(a: { cwd: string }): Promise<KomutSonucu> {
  const [claude, codex, chromium, dizin] = await Promise.all([
    komutVarMi('claude'),
    komutVarMi('codex'),
    chromiumVarMi(),
    KobayDizini.bul(a.cwd),
  ]);
  let hedef = false;
  let baseUrl: string | undefined;
  if (dizin !== null) {
    try {
      baseUrl = (await dizin.configOku()).baseUrl;
      hedef = await hedefAyaktaMi(baseUrl);
    } catch {
      hedef = false;
    }
  }
  const beyinVar = claude || codex;
  const ham = [
    {
      ad: `Node ${process.versions.node}`,
      ok: nodeSurumuYeterliMi(process.versions.node),
      oneri: 'install Node 22.12 or newer',
    },
    {
      ad: 'claude CLI',
      ok: claude,
      oneri: beyinVar
        ? 'missing; codex can be used as the brain'
        : 'install it, or switch to a key-based brain with `kobay setup --brain openrouter`',
    },
    {
      ad: 'codex CLI',
      ok: codex,
      oneri: beyinVar
        ? 'missing; claude can be used as the brain'
        : 'install it, or switch to a key-based brain with `kobay setup --brain openrouter`',
    },
    { ad: 'Chromium', ok: chromium, oneri: CHROMIUM_ONERISI },
    { ad: '.kobay', ok: dizin !== null, oneri: 'create a project with `kobay project create --url <URL>`' },
    {
      ad: 'target',
      ok: hedef,
      oneri: dizin === null
        ? 'no project; run `kobay project create --url <URL>` first'
        : `${baseUrl ?? 'target'} is not reachable; start the app or fix the address with \`kobay project update --base-url <URL>\``,
    },
  ];
  const metin = ham
    .map((kontrol) => (kontrol.ok ? `✓ ${kontrol.ad}` : `✗ ${kontrol.ad} — ${kontrol.oneri}`))
    .join('\n');
  // `oneri` yalnız düşen kontrolde yazılır: ok:true satırda öneri bırakmak
  // ajanı yanıltıyordu (hedef ayaktayken "ayakta değil" önerisi gibi).
  const kontroller: Kontrol[] = ham.map(({ ad, ok, oneri }) => ({ name: ad, ok, ...(ok ? {} : { hint: oneri }) }));
  return basariliMetin(kontroller, metin);
}
