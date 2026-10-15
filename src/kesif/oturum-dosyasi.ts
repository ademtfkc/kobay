import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import * as v from 'valibot';
import { OturumDurumuSemasi, type OturumDurumu } from '../depo/index.js';
import { izinliAnaMakinedeMi, kayitliAlanAdi, oturumIzinliMetni, type OturumGirdisi } from './giris-korumasi.js';

/**
 * Hazır oturum dosyası (`--session-file`): CAPTCHA'lı uygulamalarda kullanıcının tarayıcıda
 * açtığı oturumun Playwright `storageState` JSON'u. kobay dosyayı doğrular ve `.kobay/storageState.json`'a
 * (0600) kendi biçimiyle yazar; kaynak dosyaya dokunmaz.
 *
 * Köken kuralı (`oturumKokenleriniDenetle`), içe alınan oturumla keşif korumasının izinli kümesiyle
 * aynıdır (`izinliAnaMakinedeMi`: `baseUrl`'in TAM ana makinesi, port serbest + tam auth origin'ler).
 * "Aynı site" genellemesi YOK: el yapımı sonek listesi Public Suffix List değildir (`alice.id.au` ile
 * `evil.id.au` aynı site sanılırdı), kardeş ana makine hiçbir zaman izinli değildir.
 * - localStorage origin'i: tam bir http(s) origin'i olmalı ve izinli kümede olmalı.
 * - Çerez alanı (`domain`): çerezlerde şema ve port yoktur (tarayıcı çerezi ana makine adına göre
 *   gönderir, portu ayırmaz). Ad ya `baseUrl` ana makinesine eşit, ya da (yalnız `.` önekli alan
 *   çerezinde) onun ÜST alanı olmalı: ana makine `.`+alan ile bitmeli ve alan, el listesine göre
 *   kayıtlı alan adından kısa olmamalı (kamu soneki `.com`, `.co.uk`, `.github.io` reddedilir). Üst
 *   alan çerezi tarayıcıda kardeş ana makinelere de gider: bilinen sınır, ağ koruması o kardeşlere
 *   çıkışı yine keser. Auth origin çerezi için aynı kural (kendisi ya da noktalı üst alanı).
 * - `secure` ve `sameSite` karara girmez: ikisi de çerezin gideceği ana makineleri genişletmez
 *   (`secure` yalnız https'e daraltır; `sameSite` başka sitenin başlattığı isteğe eklenip
 *   eklenmeyeceğini belirler, çerez yine yalnız kendi alanına gider).
 */

/** Oturum dosyasının en büyük boyu (bayt). */
export const OTURUM_DOSYASI_TAVANI = 1024 * 1024;

/** Hata mesajında listelenen en fazla yabancı köken. */
const MESAJDA_EN_COK_KOKEN = 5;

/**
 * Oturum dosyası kullanılamaz (yok, büyük, JSON değil, şemaya uymuyor, yabancı köken taşıyor).
 * Mesaj hiçbir çerez ya da depolama DEĞERİ taşımaz; yalnız yol, alan yolu ve kökenler.
 */
export class SessionFileError extends Error {
  constructor(mesaj: string) {
    super(mesaj);
    this.name = 'SessionFileError';
  }
}

/** `.kobay/storageState.json` içindeki işaret: dosya `--session-file` ile içe alındı. */
interface IceAlinanIsaret {
  kobay: { sessionSource: 'imported' };
}

const ISARET: IceAlinanIsaret = { kobay: { sessionSource: 'imported' } };

const ICE_ALMA_IPUCU = 'Export it with Playwright\'s `context.storageState({ path })` (or `npx playwright codegen'
  + ' --save-storage <file>`) after logging in to the app.';

function hataKodu(hata: unknown): string | undefined {
  return typeof hata === 'object' && hata !== null && 'code' in hata ? String(hata.code) : undefined;
}

/** Sınırlı okumanın hata türü; çağıran kendi mesajına çevirir. */
class OkumaHatasi extends Error {
  constructor(readonly tur: 'yok' | 'okunamadi' | 'ozel' | 'tavan', readonly kod?: string) {
    super(tur);
  }
}

/**
 * Dosyayı tek fd üzerinden en çok `OTURUM_DOSYASI_TAVANI` bayt okur: düzenli dosya değilse (dizin,
 * FIFO) ya da tavanı aşarsa okumaz. FIFO'da açılış `O_NONBLOCK` ile asılı kalmaz; tür açık fd'de
 * yeniden denetlenir (stat ile açılış arasında dosya değişebilir); tavan okuma döngüsünde (stat
 * boyuna güvenilmez, büyük dosyanın tamamı okunmaz).
 */
async function sinirliOku(yol: string): Promise<string> {
  let bilgi;
  try {
    bilgi = await stat(yol);
  } catch (hata: unknown) {
    const kod = hataKodu(hata);
    throw new OkumaHatasi(kod === 'ENOENT' ? 'yok' : 'okunamadi', kod);
  }
  if (!bilgi.isFile()) throw new OkumaHatasi('ozel');
  const dosya = await open(yol, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch((hata: unknown) => {
    throw new OkumaHatasi('okunamadi', hataKodu(hata));
  });
  try {
    if (!(await dosya.stat()).isFile()) throw new OkumaHatasi('ozel');
    const tampon = Buffer.alloc(OTURUM_DOSYASI_TAVANI + 1);
    let okunan = 0;
    for (;;) {
      const { bytesRead } = await dosya.read(tampon, okunan, tampon.length - okunan, okunan);
      if (bytesRead === 0) break;
      okunan += bytesRead;
      if (okunan > OTURUM_DOSYASI_TAVANI) throw new OkumaHatasi('tavan');
    }
    return tampon.subarray(0, okunan).toString('utf8');
  } finally {
    await dosya.close();
  }
}

/** Dosyayı en çok `OTURUM_DOSYASI_TAVANI` bayt okur; düzenli dosya değilse ya da tavanı aşarsa reddeder. */
export async function oturumDosyasiOku(yol: string): Promise<string> {
  try {
    return await sinirliOku(yol);
  } catch (hata: unknown) {
    if (!(hata instanceof OkumaHatasi)) throw hata;
    switch (hata.tur) {
      case 'yok': throw new SessionFileError(`Session file not found: ${yol}`);
      case 'ozel': throw new SessionFileError(`Session file is not a regular file: ${yol}`);
      case 'tavan': throw new SessionFileError(
        `Session file is larger than ${OTURUM_DOSYASI_TAVANI} bytes (1 MB): ${yol}; nothing was imported`,
      );
      default: throw new SessionFileError(`Session file could not be read: ${yol}${hata.kod === undefined ? '' : ` (${hata.kod})`}`);
    }
  }
}

/** JSON + şema. Hata mesajı alanın yolunu verir, değerini vermez. */
export function oturumDurumunuCoz(metin: string): OturumDurumu {
  let veri: unknown;
  try {
    veri = JSON.parse(metin.replace(/^\uFEFF/, ''));
  } catch {
    // JSON.parse mesajı dosyanın parçasını alıntılar; çerez değeri olabilir, yazılmaz.
    throw new SessionFileError(`The session file is not valid JSON. ${ICE_ALMA_IPUCU}`);
  }
  const sonuc = v.safeParse(OturumDurumuSemasi, veri);
  if (!sonuc.success) {
    const yollar = [...new Set(sonuc.issues.map((sorun) => v.getDotPath(sorun) ?? '(top level)'))];
    throw new SessionFileError(
      `The session file is not a Playwright storageState file (\`cookies\` and \`origins\`): invalid field`
      + `${yollar.length === 1 ? '' : 's'} ${yollar.slice(0, 3).join(', ')}${yollar.length > 3 ? ', ...' : ''}.`
      + ` ${ICE_ALMA_IPUCU}`,
    );
  }
  return sonuc.output;
}

/** Çerez alanının ana makine adı: baştaki nokta ve sondaki nokta atılır, küçük harf. */
function cerezAnaMakinesi(alan: string): string {
  return alan.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
}

/** Çerez alanı izinli kümeye giden bir çerez mi? Bkz. modül açıklaması. */
export function cerezAlaniIzinliMi(alan: string, baseUrl: string, authOrigins: readonly string[]): boolean {
  const ad = cerezAnaMakinesi(alan);
  if (ad === '') return false;
  // Aynı kural base ana makinesi ve her auth origin ana makinesi için: kendisi ya da noktalı üst alanı.
  // `.tenant.okta.com` (gerçek Okta dışa aktarımı) kabul; `.okta.com` (kamu/kiracı soneki) ve kardeş red.
  // Üst alan çerezi tarayıcıda o alanın alt alanlarına da gider (bilinen sınır; ağ kümesi tam ana makine).
  const anaMakineler = [baseUrl, ...authOrigins].map((adres) => cerezAnaMakinesi(new URL(adres).hostname));
  return anaMakineler.some((anaMakine) => cerezAnaMakinesiIcinMi(alan, ad, anaMakine));
}

/**
 * Çerez bu ana makineye ait mi? Ad ana makineye eşitse evet. Yoksa yalnız `.` önekli alan çerezi
 * üst alana yazılabilir (noktasız, host-only çerez başka ana makinenindir); kardeş hiçbir zaman (ana
 * makine `.ad` ile bitmeli); üst alan kayıtlı alan adından kısa olamaz (kamu soneki; IP/localhost/
 * kiracı alanında üst alan yok).
 */
function cerezAnaMakinesiIcinMi(alan: string, ad: string, anaMakine: string): boolean {
  if (ad === anaMakine) return true;
  if (!alan.startsWith('.') || !anaMakine.endsWith(`.${ad}`)) return false;
  const kayitli = kayitliAlanAdi(anaMakine);
  return kayitli !== null && (ad === kayitli || ad.endsWith(`.${kayitli}`));
}

/** localStorage girdisinin origin'i: tam bir http(s) origin'i değilse null. */
function depoOrigini(deger: string): string | null {
  try {
    const adres = new URL(deger);
    if (adres.protocol !== 'http:' && adres.protocol !== 'https:') return null;
    return adres.origin === deger.replace(/\/$/, '') ? adres.origin : null;
  } catch {
    return null;
  }
}

/**
 * Çerez ve localStorage kökenleri izinli kümede mi? Dışında kalan varsa hangileri olduğunu yazıp
 * reddeder (değer yazılmaz).
 */
export function oturumKokenleriniDenetle(durum: OturumDurumu, baseUrl: string, authOrigins: readonly string[]): void {
  const baseOrigin = new URL(baseUrl).origin;
  const yabancilar: string[] = [];
  for (const cerez of durum.cookies) {
    if (!cerezAlaniIzinliMi(cerez.domain, baseUrl, authOrigins)) {
      yabancilar.push(`cookie domain ${cerez.domain.toLowerCase()}`);
    }
  }
  for (const girdi of durum.origins) {
    const origin = depoOrigini(girdi.origin);
    if (origin === null) yabancilar.push('a storage entry that is not an http(s) origin');
    else if (!izinliAnaMakinedeMi(origin, baseOrigin, authOrigins)) yabancilar.push(`storage origin ${origin}`);
  }
  if (yabancilar.length === 0) return;
  const tekil = [...new Set(yabancilar)];
  throw new SessionFileError(
    `The session file has data for sites outside this project: ${tekil.slice(0, MESAJDA_EN_COK_KOKEN).join(', ')}`
    + `${tekil.length > MESAJDA_EN_COK_KOKEN ? `, ... (${tekil.length} in all)` : ''}. Allowed:`
    + ` ${oturumIzinliMetni(baseOrigin, authOrigins)}; nothing was imported. Remove those entries, or, if a`
    + ' separate login site (SSO) is part of the flow, add its exact origin with'
    + ' `kobay project create --url <URL> --session-file <file> --auth-origin <origin> --force`.',
  );
}

/** Oturumun adlı değerleri (`cookie sid`, `localStorage jwt`): ağ izi ve hata maskesi; ad mesaja girer. */
export function oturumGirdileri(durum: OturumDurumu): OturumGirdisi[] {
  return [
    ...durum.cookies.map((cerez) => ({ ad: `cookie ${cerez.name}`, deger: cerez.value })),
    ...durum.origins.flatMap((origin) => origin.localStorage.map((oge) => ({ ad: `localStorage ${oge.name}`, deger: oge.value }))),
  ];
}

/** Oturumun sır sayılan değerleri: çerez değerleri ve localStorage değerleri (maske ve sızıntı izi için). */
export function oturumDegerleri(durum: OturumDurumu): string[] {
  return [
    ...durum.cookies.map((cerez) => cerez.value),
    ...durum.origins.flatMap((origin) => origin.localStorage.map((oge) => oge.value)),
  ];
}

/** Doğrulanmış oturumun `.kobay/storageState.json` metni: yalnız bilinen alanlar + içe alma işareti. */
export function iceAlinanOturumMetni(durum: OturumDurumu): string {
  // Sıkı biçim: yazılan dosya kaynaktan büyümesin (kayıtlı dosya da aynı 1 MB tavanla okunur).
  return `${JSON.stringify({ ...ISARET, cookies: durum.cookies, origins: durum.origins })}\n`;
}

/**
 * `--session-file` yolu: dosyayı okur, şemayla ve köken kuralıyla doğrular, `.kobay`'a yazılacak
 * metni döner. Hiçbir şey yazmaz; kaynak dosyaya dokunmaz.
 */
export async function oturumDosyasiniHazirla(
  yol: string,
  baseUrl: string,
  authOrigins: readonly string[],
): Promise<{ durum: OturumDurumu; metin: string }> {
  const durum = oturumDurumunuCoz(await oturumDosyasiOku(yol));
  oturumKokenleriniDenetle(durum, baseUrl, authOrigins);
  const metin = iceAlinanOturumMetni(durum);
  if (Buffer.byteLength(metin, 'utf8') > OTURUM_DOSYASI_TAVANI) {
    throw new SessionFileError(`The session file is larger than ${OTURUM_DOSYASI_TAVANI} bytes (1 MB) once normalized; nothing was imported`);
  }
  return { durum, metin };
}

function isaretliMi(veri: unknown): boolean {
  if (typeof veri !== 'object' || veri === null || !('kobay' in veri)) return false;
  const kobay = (veri as { kobay: unknown }).kobay;
  return typeof kobay === 'object' && kobay !== null && 'sessionSource' in kobay
    && (kobay as { sessionSource: unknown }).sessionSource === 'imported';
}

/**
 * `.kobay/storageState.json` içe alınmış bir oturum mu? Değilse (dosya yok, giriş akışının ya
 * da kimliksiz keşfin yazdığı dosya) null: eski yol aynen sürer. İşaretliyse dosya her keşifte
 * yeniden doğrulanır (elle değiştirilmiş olabilir); geçersizse `SessionFileError`.
 */
export async function iceAlinanOturumuOku(
  storageStateYolu: string,
  baseUrl: string,
  authOrigins: readonly string[],
): Promise<OturumDurumu | null> {
  let metin: string;
  try {
    // Kaynak dosyayla aynı sınırlı okuyucu: büyük dosya ya da FIFO belleği/komutu kilitlemesin.
    metin = await sinirliOku(storageStateYolu);
  } catch (hata: unknown) {
    if (!(hata instanceof OkumaHatasi)) throw hata;
    // Yalnız "yok" oturum yok demektir. Var ama okunamayan, tavanı aşan ya da özel dosya açık
    // hatadır: "yok" sayılsaydı kimliksiz keşif üstüne yazıp dosyayı (belki içe alınmış oturumu) kaybederdi.
    if (hata.tur === 'yok') return null;
    throw new SessionFileError({
      ozel: '.kobay/storageState.json is not a regular file',
      tavan: `.kobay/storageState.json is larger than ${OTURUM_DOSYASI_TAVANI} bytes (1 MB)`,
      okunamadi: `.kobay/storageState.json could not be read${hata.kod === undefined ? '' : ` (${hata.kod})`}`,
    }[hata.tur] + '; kobay did not touch it. Move it away (or fix its permissions), then log in or import a session again.');
  }
  let veri: unknown;
  try {
    veri = JSON.parse(metin);
  } catch {
    throw new SessionFileError('.kobay/storageState.json is not valid JSON; kobay did not touch it.'
      + ' Move it away, then log in or import a session again.');
  }
  if (!isaretliMi(veri)) return null;
  try {
    const durum = oturumDurumunuCoz(metin);
    oturumKokenleriniDenetle(durum, baseUrl, authOrigins);
    return durum;
  } catch (hata: unknown) {
    if (!(hata instanceof SessionFileError)) throw hata;
    throw new SessionFileError(
      `The imported session in .kobay/storageState.json is no longer valid: ${hata.message}`
      + ' Import it again with `kobay explore --session-file <file>`.',
    );
  }
}
