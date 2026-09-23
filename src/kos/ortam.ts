/**
 * Üretilen test kodunu çalıştıran Playwright alt süreçlerinin ortamı.
 *
 * İzin listesi kullanılır: kullanıcının kabuğunda hangi sırların (bulut anahtarları,
 * veritabanı adresleri, CI jetonları…) bulunduğunu önceden bilemeyiz; red listesi yenisini
 * kaçırır. Yalnız Node, Playwright ve Chromium'un çalışması için gerekenler geçer. Bunun
 * üstüne önekle izin alan adlardan sır gibi görünenler (ör. PLAYWRIGHT_SERVICE_ACCESS_TOKEN)
 * ikinci bir süzgeçle yine atılır. Giriş storageState dosyasıyla taşındığı için test sürecine parola gerekmez.
 */

const IZINLI_ADLAR = new Set([
  // POSIX / macOS temel
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'COLORTERM',
  'LANG', 'LANGUAGE', 'TZ', 'NO_COLOR', 'FORCE_COLOR', 'CI', 'DEBUG',
  // Linux ekran, oturum ve yazı tipi
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'XDG_DATA_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE',
  // Ağ: vekil sunucu ve kurum sertifikaları
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Windows
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
]);

const IZINLI_ONEKLER = ['LC_', 'PLAYWRIGHT_', 'PW_'];

/** Önek izniyle gelen (ör. PLAYWRIGHT_*) ama sır sayılan adlar. */
const SIR_DESENI = /KEY|TOKEN|SECRET|PASSW|PASS$|_PASS_|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE/;

/** Kullanıcı adı/parola gömülü vekil adresi (`http://kullanici:parola@vekil`). */
const KIMLIKLI_ADRES = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i;

function izinliMi(ad: string, deger: string): boolean {
  const buyuk = ad.toUpperCase();
  if (!IZINLI_ADLAR.has(buyuk)) {
    if (!IZINLI_ONEKLER.some((onek) => buyuk.startsWith(onek)) || SIR_DESENI.test(buyuk)) return false;
  }
  if (buyuk.endsWith('_PROXY') && KIMLIKLI_ADRES.test(deger)) return false;
  return true;
}

/**
 * Kaynak ortamdan yalnız izinli değişkenleri alır, kobay'ın koşu değişkenlerini ekler.
 * `ek` içindeki değerler süzgece girmez; çağıran yalnız kendi ürettiği değerleri verir.
 */
export function testSureciOrtami(
  kaynak: NodeJS.ProcessEnv,
  ek: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const ortam: NodeJS.ProcessEnv = {};
  for (const [ad, deger] of Object.entries(kaynak)) {
    if (deger !== undefined && izinliMi(ad, deger)) ortam[ad] = deger;
  }
  return { ...ortam, ...ek };
}
