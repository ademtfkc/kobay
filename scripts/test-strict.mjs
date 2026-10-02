import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const sonuc = spawnSync(process.execPath, [vitest, 'run'], {
  env: { ...process.env, KOBAY_TEST_STRICT: '1', KOBAY_CHROMIUM_TEST: '1' },
  stdio: 'inherit',
});

if (sonuc.error !== undefined) throw sonuc.error;
process.exitCode = sonuc.status ?? 1;
