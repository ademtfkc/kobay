import { afterEach, describe, expect, it, vi } from 'vitest';

import { sil } from './gecici-dizin.js';

const bekle = async (): Promise<void> => {};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('geçici dizin temizliği', () => {
  it('beş deneme de düşerse win32 dışında son hatayı fırlatır', async () => {
    const hatalar = [1, 2, 3, 4, 5].map((n) => new Error(`EBUSY ${n}`));
    const rm = vi.fn(async () => { throw hatalar[rm.mock.calls.length - 1]; });
    await expect(sil('/tmp/yok', { rm: rm as never, platform: 'darwin', bekle })).rejects.toBe(hatalar[4]);
    expect(rm).toHaveBeenCalledTimes(5);
  });

  it('win32\'de fırlatmaz, yolu uyarı olarak yazar', async () => {
    const uyari = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rm = vi.fn(async () => { throw new Error('EBUSY'); });
    await expect(sil('C:\\tmp\\kilitli', { rm: rm as never, platform: 'win32', bekle })).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledTimes(5);
    expect(uyari).toHaveBeenCalledWith(expect.stringContaining('C:\\tmp\\kilitli'), expect.any(Error));
  });

  it('bir deneme başarılıysa susar ve durur', async () => {
    let sayac = 0;
    const rm = vi.fn(async () => { sayac += 1; if (sayac < 3) throw new Error('EBUSY'); });
    await expect(sil('/tmp/yok', { rm: rm as never, platform: 'linux', bekle })).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledTimes(3);
  });
});
