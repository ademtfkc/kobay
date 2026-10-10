import { readFile, writeFile } from 'node:fs/promises';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  EN_COK_AUTH_ORIGIN,
  KimlikSemasi,
  KobayConfigSemasi,
  KobayDizini,
  SchemaError,
  authOriginNormallestir,
  authOriginleriDogrula,
} from '../../src/depo/index.js';
import { geciciDizinAc } from '../yardimci/gecici-dizin.js';

describe('authOriginNormallestir', () => {
  it.each([
    ['https://auth.example.com', 'https://auth.example.com'],
    ['https://Auth.Example.com/', 'https://auth.example.com'],
    ['https://auth.example.com:443', 'https://auth.example.com'],
    ['http://127.0.0.1:4010', 'http://127.0.0.1:4010'],
    ['http://localhost:4010/', 'http://localhost:4010'],
  ])('%s → %s', (girdi, beklenen) => {
    expect(authOriginNormallestir(girdi)).toBe(beklenen);
  });

  it.each([
    ['https://*.example.com', 'wildcards are not allowed'],
    ['*', 'wildcards are not allowed'],
    ['https://auth.example.com/login', 'only an origin is allowed'],
    ['https://auth.example.com/?x=1', 'only an origin is allowed'],
    ['https://auth.example.com?', 'only an origin is allowed'],
    ['https://auth.example.com#a', 'only an origin is allowed'],
    ['https://user:pw@auth.example.com', 'user info is not allowed'],
    ['ftp://auth.example.com', 'only http and https are allowed'],
    ['javascript://auth.example.com', 'only http and https are allowed'],
    ['auth.example.com', 'expected a full origin'],
    ['https://', 'not a valid URL'],
  ])('%s reddedilir (%s)', (girdi, neden) => {
    expect(() => authOriginNormallestir(girdi)).toThrow(neden);
    // Mesaj hangi öğenin geçersiz olduğunu söyler.
    expect(() => authOriginNormallestir(girdi)).toThrow(`"${girdi}"`);
  });
});

describe('authOriginleriDogrula', () => {
  it('normal biçimde ve sıralı döner', () => {
    expect(authOriginleriDogrula('https://app.example.com/x', ['https://sso.example.org/', 'https://auth.example.com']))
      .toEqual(['https://auth.example.com', 'https://sso.example.org']);
  });

  it('baseUrl origin\'i listeye yazılamaz (örtük)', () => {
    expect(() => authOriginleriDogrula('https://app.example.com/panel', ['https://APP.example.com/']))
      .toThrow('it is the baseUrl origin');
  });

  it('normalleşince aynı olan iki öğe tekrardır', () => {
    expect(() => authOriginleriDogrula('https://app.example.com', ['https://auth.example.com', 'https://auth.example.com:443/']))
      .toThrow('listed twice');
  });

  it(`en çok ${EN_COK_AUTH_ORIGIN} öğe`, () => {
    const bes = [1, 2, 3, 4, 5].map((n) => `https://auth${n}.example.com`);
    expect(authOriginleriDogrula('https://app.example.com', bes)).toHaveLength(5);
    expect(() => authOriginleriDogrula('https://app.example.com', [...bes, 'https://auth6.example.com']))
      .toThrow('At most 5 auth origins');
  });
});

describe('config ve kimlik şeması', () => {
  it('config listesini normalleştirip sıralar; boş liste alan yokmuş gibi okunur', () => {
    const okunan = v.parse(KobayConfigSemasi, {
      baseUrl: 'http://127.0.0.1:3000',
      authOrigins: ['http://localhost:4000/', 'http://auth.localhost:4000'],
      brain: { adaptor: 'sahte' },
    });
    expect(okunan.authOrigins).toEqual(['http://auth.localhost:4000', 'http://localhost:4000']);
    const bos = v.parse(KobayConfigSemasi, { baseUrl: 'http://127.0.0.1:3000', authOrigins: [], brain: { adaptor: 'sahte' } });
    expect('authOrigins' in bos).toBe(false);
  });

  it('elle bozulmuş config listesi okunamaz (joker, yol, baseUrl tekrarı)', async () => {
    const cwd = await geciciDizinAc('kobay-auth-origin-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://127.0.0.1:3000', brain: { adaptor: 'sahte' } });
    for (const liste of [['https://*.example.com'], ['https://auth.example.com/login'], ['http://127.0.0.1:3000']]) {
      await writeFile(dizin.yol('config.json'), JSON.stringify({
        baseUrl: 'http://127.0.0.1:3000', authOrigins: liste, brain: { adaptor: 'sahte' },
      }));
      await expect(dizin.configOku()).rejects.toBeInstanceOf(SchemaError);
    }
  });

  it('0.2 kimliği (authOrigins yok) okunur; yeni kimlik listeyi taşır', async () => {
    expect(v.parse(KimlikSemasi, { username: 'a', password: 'b', origin: 'http://x.test' }))
      .toEqual({ username: 'a', password: 'b', origin: 'http://x.test' });
    const cwd = await geciciDizinAc('kobay-auth-origin-');
    const dizin = await KobayDizini.ac(cwd, { baseUrl: 'http://x.test', brain: { adaptor: 'sahte' } });
    await dizin.kimlikYaz({ username: 'a', password: 'b', origin: 'http://x.test', authOrigins: ['http://auth.test'] });
    await expect(dizin.kimlikOku()).resolves.toEqual({
      username: 'a', password: 'b', origin: 'http://x.test', authOrigins: ['http://auth.test'],
    });
    expect(JSON.parse(await readFile(dizin.yol('credentials.json'), 'utf8'))).toHaveProperty('authOrigins');
  });
});
