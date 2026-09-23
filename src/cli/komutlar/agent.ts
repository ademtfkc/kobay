import { beceriKur, kurulumMesaji, mcpKayitTalimati } from '../../beceri/index.js';
import { basariliMetin, komutCalistir, type KomutSonucu } from '../komut.js';

/**
 * JSON alanları (`islem`, `mcp.islem`) sabit kalır; insan çıktısı İngilizcedir
 * (bkz. `kurulumMesaji`). İnsan modunda stdout'a yalnız bu metin gider — ham
 * JSON dökümü basılmaz (`basariliMetin` sözleşmesi, `doctor` ile aynı davranış).
 *
 * `--target claude` MCP kaydını da yapar: JSON'daki `mcp` alanı yazılan
 * `.mcp.json` yolunu, işlemi ve komutu taşır. Codex ve Cursor'da kayıt hâlâ
 * kullanıcının işidir; `mcp` alanı orada talimat metnidir.
 */
export async function agentInstall(a: {
  cwd: string;
  target: 'claude' | 'codex' | 'cursor';
  home?: string;
  ortam?: NodeJS.ProcessEnv;
}): Promise<KomutSonucu> {
  return komutCalistir(async () => {
    const sonuc = await beceriKur(a.target, {
      projeKoku: a.cwd,
      ...(a.ortam === undefined ? {} : { ortam: a.ortam }),
    });
    const json = a.target === 'claude' ? sonuc : { ...sonuc, mcp: mcpKayitTalimati(a.target) };
    return basariliMetin(json, kurulumMesaji(a.target, sonuc));
  });
}
