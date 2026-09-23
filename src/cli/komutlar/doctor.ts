import { hedefAyaktaMi } from '../../kos/index.js';
import { basariliMetin, type KomutSonucu } from '../komut.js';
import { chromiumVarMi, komutVarMi } from './setup.js';
import { KobayDizini } from '../../depo/index.js';

/** Doctor satırı: `oneri` yalnız `ok: false` iken bulunur. */
export interface Kontrol {
  ad: string;
  ok: boolean;
  oneri?: string;
}

/** Chromium eksikse verilen öneri; kurulu makinede de sınanabilsin diye dışa açık. */
export const CHROMIUM_ONERISI = '`kobay install-browser` çalıştırın (Linux: `kobay install-browser --with-deps`)';

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
      oneri: 'Node 22.12 veya üstünü kurun',
    },
    {
      ad: 'claude CLI',
      ok: claude,
      oneri: beyinVar ? 'yok; beyin olarak codex kullanılabilir' : 'kurun veya `kobay setup --beyin openrouter` ile anahtarlı beyne geçin',
    },
    {
      ad: 'codex CLI',
      ok: codex,
      oneri: beyinVar ? 'yok; beyin olarak claude kullanılabilir' : 'kurun veya `kobay setup --beyin openrouter` ile anahtarlı beyne geçin',
    },
    { ad: 'Chromium', ok: chromium, oneri: CHROMIUM_ONERISI },
    { ad: '.kobay', ok: dizin !== null, oneri: '`kobay project create --url <URL>` ile proje açın' },
    {
      ad: 'hedef',
      ok: hedef,
      oneri: dizin === null
        ? 'proje yok; önce `kobay project create --url <URL>` çalıştırın'
        : `${baseUrl ?? 'hedef'} ayakta değil; uygulamayı başlatın veya \`kobay project update --base-url <URL>\` ile adresi düzeltin`,
    },
  ];
  const metin = ham
    .map((kontrol) => (kontrol.ok ? `✓ ${kontrol.ad}` : `✗ ${kontrol.ad} — ${kontrol.oneri}`))
    .join('\n');
  // `oneri` yalnız düşen kontrolde yazılır: ok:true satırda öneri bırakmak
  // ajanı yanıltıyordu (hedef ayaktayken "ayakta değil" önerisi gibi).
  const kontroller: Kontrol[] = ham.map(({ ad, ok, oneri }) => ({ ad, ok, ...(ok ? {} : { oneri }) }));
  return basariliMetin(kontroller, metin);
}
