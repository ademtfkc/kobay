import { createInterface, type Interface } from 'node:readline/promises';
import { Writable, type Readable } from 'node:stream';

/** Soru yanıtlanamadan girdi akışı bittiğinde (stdin kapalı, `< /dev/null`) fırlatılır. */
export class InputClosedError extends Error {
  constructor() {
    super('Input stream closed before an answer arrived');
    this.name = 'InputClosedError';
  }
}

/**
 * readline'ın `question` sözü girdi kapanınca hiç çözülmez; süreç bekleyen
 * üst düzey await ile exit 13'e düşer. Kapanışı yarıştırıp açık hataya çevirir.
 */
export async function yanitBekle(arayuz: Interface, input: Readable, soru: string): Promise<string> {
  if (input.readableEnded || input.destroyed) throw new InputClosedError();
  return new Promise<string>((coz, reddet) => {
    const kapandi = (): void => reddet(new InputClosedError());
    arayuz.once('close', kapandi);
    arayuz.question(soru).then(
      (yanit) => { arayuz.off('close', kapandi); coz(yanit); },
      (hata: unknown) => { arayuz.off('close', kapandi); reddet(hata instanceof Error ? hata : new InputClosedError()); },
    );
  });
}

/** Parolayı readline ile okur; yazılan karakterleri çıktı akışına yansıtmaz. */
export async function gizliSor(
  soru: string,
  input: Readable = process.stdin,
  output: Writable = process.stderr,
): Promise<string> {
  output.write(soru);
  const sessiz = new Writable({ write(_parca, _kodlama, tamam) { tamam(); } });
  const arayuz = createInterface({ input, output: sessiz, terminal: Boolean((input as NodeJS.ReadStream).isTTY) });
  try {
    return await yanitBekle(arayuz, input, '');
  } finally {
    arayuz.close();
    output.write('\n');
  }
}
