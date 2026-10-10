import { join } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import {
  CredentialLeakBlockedError,
  CredentialOriginError,
  GIRIS_DONUS_BEKLEME_MS,
  kesfet,
  kimlikOriginDogrula,
  loginUrlDogrula,
  sayfayiYenile,
} from '../../src/kesif/index.js';
import { girisKorumasiKur } from '../../src/kesif/giris-korumasi.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

const APP = 'https://app.example.com';
const AUTH = 'https://auth.example.com';
const SSO = 'https://sso.example.org';

describe('kimlik kilidi: origin + auth origin kümesi', () => {
  it('aynı küme (sıra ve yazım farkı dahil) geçer', () => {
    expect(() => kimlikOriginDogrula(
      { username: 'u', password: 'p', origin: APP, authOrigins: [SSO, AUTH] },
      APP,
      [AUTH, `${SSO}/`],
    )).not.toThrow();
    // 0.2 kimliği: liste yok = boş küme; config'te de liste yoksa geçer.
    expect(() => kimlikOriginDogrula({ username: 'u', password: 'p', origin: APP }, APP, [])).not.toThrow();
  });

  it('config\'te liste var, kimlikte yok (0.2 kimliği) → kimlik geçersiz', () => {
    expect(() => kimlikOriginDogrula({ username: 'u', password: 'p', origin: APP }, APP, [AUTH]))
      .toThrow(CredentialOriginError);
    expect(() => kimlikOriginDogrula({ username: 'u', password: 'p', origin: APP }, APP, [AUTH]))
      .toThrow('different set of auth origins');
  });

  it('config listesi elle büyütülürse ya da değiştirilirse kimlik geçersiz (sessiz genişleme yok)', () => {
    const kimlik = { username: 'u', password: 'p', origin: APP, authOrigins: [AUTH] };
    expect(() => kimlikOriginDogrula(kimlik, APP, [AUTH, SSO])).toThrow(CredentialOriginError);
    expect(() => kimlikOriginDogrula(kimlik, APP, [SSO])).toThrow(CredentialOriginError);
    expect(() => kimlikOriginDogrula(kimlik, APP, [])).toThrow(CredentialOriginError);
  });

  it('kimlikteki liste bozuksa kimlik kullanılmaz', () => {
    expect(() => kimlikOriginDogrula(
      { username: 'u', password: 'p', origin: APP, authOrigins: ['https://*.example.com'] },
      APP,
      ['https://*.example.com'],
    )).toThrow(CredentialOriginError);
  });
});

describe('loginUrl ve auth origin', () => {
  it('auth origin\'deki giriş sayfası yalnız listedeyse kabul edilir', () => {
    expect(() => loginUrlDogrula(APP, `${AUTH}/login`)).toThrow('same origin as baseUrl');
    expect(() => loginUrlDogrula(APP, `${AUTH}/login`, [SSO])).toThrow(`allowed: ${APP}, ${SSO}`);
    expect(() => loginUrlDogrula(APP, `${AUTH}/login`, [AUTH])).not.toThrow();
  });

  it('kesfet ve sayfayiYenile tarayıcı açmadan küme uyuşmazlığını reddeder', async () => {
    const dizin = await geciciDizinAc('kobay-auth-kilit-');
    const ortak = {
      baseUrl: APP,
      loginUrl: `${AUTH}/login`,
      authOrigins: [AUTH],
      kimlik: { username: 'u', password: 'p', origin: APP },
      storageStateYolu: join(dizin, 'storage.json'),
    };
    await expect(kesfet(ortak)).rejects.toThrow(CredentialOriginError);
    await expect(sayfayiYenile({ ...ortak, url: '/panel' })).rejects.toThrow(CredentialOriginError);
    // Geçersiz liste de keşfi başlatmaz.
    await expect(kesfet({ ...ortak, authOrigins: [`${AUTH}/login`] })).rejects.toThrow('only an origin is allowed');
  });

  it('giriş sonunda uygulamaya dönüş için 10 sn beklenir', () => {
    expect(GIRIS_DONUS_BEKLEME_MS).toBe(10_000);
  });
});

describe('girisKorumasiKur kimliğin onaylamadığı kümeyi kurmaz', () => {
  it('çağıran fazladan origin geçse bile koruma kurulmadan reddedilir', async () => {
    const sahteBaglam = { route: () => { throw new Error('route çağrılmamalı'); } } as unknown as BrowserContext;
    await expect(girisKorumasiKur(sahteBaglam, { username: 'u', password: 'p', origin: APP }, [APP, AUTH]))
      .rejects.toThrow(CredentialLeakBlockedError);
    await expect(girisKorumasiKur(sahteBaglam, { username: 'u', password: 'p' }, [APP]))
      .rejects.toThrow(CredentialLeakBlockedError);
  });
});
