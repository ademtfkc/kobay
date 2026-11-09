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

/** Taşıma yeniden denemesinin toplam süre sınırı; testler kısaltabilsin diye nesne. */
export const ATOMIK_YAZIM = {
  /** Meşgul hedefe taşıma bu süre boyunca yeniden denenir; dolunca özgün hata atılır. */
  tasimaBeklemeMs: 2_000,
};

const TASIMA_ILK_BEKLEME_MS = 5;
const TASIMA_AZAMI_BEKLEME_MS = 100;

/**
 * Taşımanın "hedef şu an meşgul" anlamına gelebilen kodları (`paket-kilidi.ts`
 * ile aynı küme). Windows'ta aynı hedefe eşzamanlı bir taşıma ya da hedefi açık
 * tutan bir okuyucu (antivirüs, dizinleyici, başka bir koşu) `EPERM`/`EACCES`/
 * `EBUSY` verir. Başka kodlar (ENOENT, EISDIR, ...) yeniden denenmez.
 */
const TASIMA_MESGUL_KODLARI = new Set(['EPERM', 'EACCES', 'EBUSY']);

function tasimaMesgulMu(hata: unknown): boolean {
  const kod = typeof hata === 'object' && hata !== null && 'code' in hata ? hata.code : undefined;
  return typeof kod === 'string' && TASIMA_MESGUL_KODLARI.has(kod);
}

/**
 * Dosya işlemini, dosya meşgulse (`EPERM`/`EACCES`/`EBUSY`)
 * `ATOMIK_YAZIM.tasimaBeklemeMs` sınırı içinde artan beklemeyle yeniden dener.
 * Sınır dolunca son (özgün kodlu) hata atılır; başka kodlar hemen atılır.
 * Windows'ta başka bir süreç hedefi taşırken yapılan okuma da meşgul kodu alır.
 */
export async function mesgulseYinele<T>(is: () => Promise<T>): Promise<T> {
  const bitis = Date.now() + ATOMIK_YAZIM.tasimaBeklemeMs;
  let bekleme = TASIMA_ILK_BEKLEME_MS;
  for (;;) {
    try {
      return await is();
    } catch (hata: unknown) {
      const kalan = bitis - Date.now();
      if (!tasimaMesgulMu(hata) || kalan <= 0) throw hata;
      const sure = Math.min(kalan, bekleme + Math.floor(Math.random() * bekleme));
      await new Promise((coz) => setTimeout(coz, sure));
      bekleme = Math.min(bekleme * 2, TASIMA_AZAMI_BEKLEME_MS);
    }
  }
}

/**
 * İçeriği önce aynı dizindeki geçici dosyaya, sonra atomik olarak hedefe taşır.
 * Taşıma meşgul hedefte (Windows'ta eşzamanlı yazıcı) süre sınırı içinde
 * yeniden denenir; geçici dosya her hata yolunda silinir.
 */
export async function yazAtomik(yol: string, icerik: string | Buffer, mod?: number): Promise<void> {
  await mkdir(dirname(yol), { recursive: true });
  const geciciYol = `${yol}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(geciciYol, icerik, mod === undefined ? undefined : { mode: mod });
    if (mod !== undefined) {
      await chmod(geciciYol, mod);
    }
    await mesgulseYinele(() => rename(geciciYol, yol));
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
