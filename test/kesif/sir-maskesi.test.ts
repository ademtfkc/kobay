import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EN_COK_GIZLI_BICIM,
  GIZLI_HATA_METNI,
  SirMaskesi,
  depoDegeriIzleri,
  metniGizle,
} from '../../src/kesif/giris-korumasi.js';

/** A3: giriş hatası maskesinin saf (tarayıcısız) davranışı. */

afterEach(() => { vi.unstubAllGlobals(); });

describe('SirMaskesi', () => {
  it('maske kendisi hata verirse ham mesaj dönmez: genel metin, alan [withheld]', () => {
    vi.stubGlobal('RegExp', class {
      constructor() {
        throw new SyntaxError('Invalid regular expression: regular expression too large');
      }
    });
    const mesaj = metniGizle('Login failed for parola-uzun-1 at http://x.test', ['parola-uzun-1']);
    const alan = metniGizle('Signed as parola-uzun-1', ['parola-uzun-1'], { alan: true });
    vi.unstubAllGlobals();
    expect(mesaj).toBe(GIZLI_HATA_METNI);
    expect(alan).toBe('[withheld]');
  });

  it('kullanıcı bilgisiz mutlak adres depo envanterine girmez, userinfo\'lu adres ve belirteç girer', () => {
    const izler = depoDegeriIzleri(JSON.stringify({
      api: 'http://localhost:47518',
      ws: 'wss://olay.ornek.test/akim',
      gizli: 'https://kullanici:parola-uzun@ornek.test/',
      token: 'gercek-gizli-belirtec',
    }));
    expect(izler).not.toContain('http://localhost:47518');
    expect(izler).not.toContain('wss://olay.ornek.test/akim');
    expect(izler).toContain('https://kullanici:parola-uzun@ornek.test/');
    expect(izler).toContain('gercek-gizli-belirtec');
    // URL-kodlu biçimi çözülünce adres olan değer de girmez.
    expect(depoDegeriIzleri(encodeURIComponent('http://localhost:47518'))).not.toContain('http://localhost:47518');
  });

  it('envanter tavanı aşılınca eksik sayılır ve sayfa alanları [withheld] olur; mesaj maskesi sürer', () => {
    const maske = new SirMaskesi(['parola-uzun-1']);
    maske.depoEkle(Array.from({ length: EN_COK_GIZLI_BICIM + 10 }, (_, sira) => `belirtec-${String(sira).padStart(6, '0')}`));
    expect(maske.eksikMi()).toBe(true);
    expect(maske.gizle('Log in', { alan: true })).toBe('[withheld]');
    expect(maske.gizle('', { alan: true })).toBe('');
    expect(maske.gizle('password parola-uzun-1 was used')).toBe('password [redacted] was used');
  });

  it('envanter değişince önbellekteki ifade yenilenir', () => {
    const maske = new SirMaskesi(['parola-uzun-1']);
    expect(maske.gizle('t=yeni-belirtec-99')).toBe('t=yeni-belirtec-99');
    maske.depoEkle(['yeni-belirtec-99']);
    expect(maske.gizle('t=yeni-belirtec-99')).toBe('t=[redacted]');
  });
});
