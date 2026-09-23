import { mcpSunucusuBaslat } from '../../mcp/index.js';
import type { KomutSonucu } from '../komut.js';

export async function mcp(): Promise<KomutSonucu> {
  await mcpSunucusuBaslat({ cwd: process.cwd() });
  return { exitCode: 0, json: undefined };
}
