import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import * as v from 'valibot';

export class FileNotFound extends Error {
  constructor(yol: string) {
    super(`File not found: ${yol}`);
    this.name = 'FileNotFound';
  }
}

export class SchemaError extends Error {
  readonly sorunlar: string[];

  constructor(sorunlar: string[]) {
    super(`Schema validation failed: ${sorunlar.join('; ')}`);
    this.name = 'SchemaError';
    this.sorunlar = sorunlar;
  }
}

/** İçeriği önce aynı dizindeki geçici dosyaya, sonra atomik olarak hedefe taşır. */
export async function yazAtomik(yol: string, icerik: string | Buffer, mod?: number): Promise<void> {
  await mkdir(dirname(yol), { recursive: true });
  const geciciYol = `${yol}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(geciciYol, icerik, mod === undefined ? undefined : { mode: mod });
    if (mod !== undefined) {
      await chmod(geciciYol, mod);
    }
    await rename(geciciYol, yol);
  } catch (hata) {
    await unlink(geciciYol).catch(() => undefined);
    throw hata;
  }
}

function sorunlariMetneCevir(issues: readonly v.BaseIssue<unknown>[]): string[] {
  return issues.map((issue) => {
    const yol = issue.path?.map((parca) => String(parca.key)).join('.') ?? '$';
    return `${yol}: ${issue.message}`;
  });
}

export async function jsonOku<T>(yol: string, sema: v.GenericSchema<unknown, T>): Promise<T> {
  let metin: string;
  try {
    metin = await readFile(yol, 'utf8');
  } catch (hata: unknown) {
    if (typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT') {
      throw new FileNotFound(yol);
    }
    throw hata;
  }

  let veri: unknown;
  try {
    veri = JSON.parse(metin) as unknown;
  } catch {
    throw new SchemaError(['$: not valid JSON']);
  }

  const sonuc = v.safeParse(sema, veri);
  if (!sonuc.success) {
    throw new SchemaError(sorunlariMetneCevir(sonuc.issues));
  }
  return sonuc.output;
}
