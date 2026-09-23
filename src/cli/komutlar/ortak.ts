import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  FileNotFound,
  KobayDizini,
  hataPaketiCikisYolu,
  type Harita,
  type Kimlik,
  type KobayConfig,
  type Sayfa,
  type TestKaydi,
} from '../../depo/index.js';
import { haritadaSayfaBul, haritadaSayfayiDegistir, kesfet, sayfayiYenile } from '../../kesif/index.js';
import { CredentialOriginError, kimlikOriginDogrula } from '../../kesif/oturum.js';
import { hedefAyaktaMi } from '../../kos/index.js';
import { TargetUnreachableError, UsageError, PermissionError } from '../komut.js';

export async function dizinBul(cwd: string): Promise<KobayDizini> {
  const dizin = await KobayDizini.bul(cwd);
  if (dizin === null) throw new UsageError('.kobay not found; run `kobay project create --url ...` first');
  return dizin;
}

function kokIcindeMi(kok: string, yol: string): boolean {
  const fark = relative(kok, yol);
  return fark === '' || (fark !== '..' && !fark.startsWith(`..${sep}`) && !isAbsolute(fark));
}

/** Hata paketinin yazılabildiği tek gizli konum: proje kökündeki bu klasörün altı. */
export const HATA_PAKETI_DIZINI = ['.kobay', 'failure-out'] as const;

/**
 * Yolun kökten sonraki bileşenlerinden biri nokta ile başlıyorsa (`.kobay`,
 * `.env`, `.git` …) reddeder. Kök dışındaki yolda baştaki `..` adımları
 * atlanır, kalan bileşenler aynı kurala tabidir.
 *
 * `izinliOnEk` verilirse (ör. `.kobay/failure-out`), kök içinde kalan ve bu
 * önekin *altında* bir çocuğu gösteren yolda önek atlanır; önekten sonraki
 * bileşenler yine nokta kuralına tabidir. `..` ile kökten çıkan ya da `..`
 * normalleşince önekten çıkan yol (`.kobay/failure-out/../credentials.json`)
 * istisnadan yararlanamaz.
 */
export function gizliYolReddet(
  kok: string,
  yol: string,
  alan: string,
  izinliOnEk: readonly string[] = [],
): void {
  const bilesenler = relative(kok, yol).split(sep).filter((parca) => parca !== '');
  let sira = 0;
  while (bilesenler[sira] === '..') sira += 1;
  const kalan = bilesenler.slice(sira);
  const izinli = sira === 0
    && izinliOnEk.length > 0
    && kalan.length > izinliOnEk.length
    && izinliOnEk.every((parca, i) => kalan[i] === parca);
  if (!(izinli ? kalan.slice(izinliOnEk.length) : kalan).some((parca) => parca.startsWith('.'))) return;
  const istisna = izinliOnEk.length === 0 ? '' : ` (except under ${izinliOnEk.join('/')}/)`;
  throw new UsageError(
    `${alan} cannot point inside .kobay${istisna}`
    + ` or at a file/directory whose name starts with a dot (.env, .git …): ${yol}`,
  );
}

/** Var olan en yakın üst dizini bulur; symlink denetimi henüz yazılmamış yolda da çalışsın diye. */
export async function enYakinVarolanYol(yol: string): Promise<string> {
  let aday = yol;
  for (;;) {
    try {
      await stat(aday);
      return aday;
    } catch (hata: unknown) {
      if (!(typeof hata === 'object' && hata !== null && 'code' in hata && hata.code === 'ENOENT')) throw hata;
      const ust = dirname(aday);
      if (ust === aday) throw hata;
      aday = ust;
    }
  }
}

/** Yolu symlink'leri çözerek verir; hedef henüz yoksa var olan en yakın üstü çözüp kalanı ekler. */
async function gercekYolTahmin(hedef: string): Promise<string> {
  const varolan = await enYakinVarolanYol(hedef);
  const kalan = relative(varolan, hedef);
  const gercekVarolan = await realpath(varolan);
  return kalan === '' ? gercekVarolan : resolve(gercekVarolan, kalan);
}

/**
 * Yol denetiminin kapsamı. `kokIci`: yol proje kökünün altında kalmak zorunda.
 * `kokDisiSerbest`: yol kökün dışını gösterebilir — CLI'da hata paketi çıkışı
 * için bilerek verilmiş tek istisna, gizli yol kuralı yine de işler.
 */
type YolKapsami = 'kokIci' | 'kokDisiSerbest';

function kokDisiReddet(kok: string, yol: string, alan: string): void {
  if (kokIcindeMi(kok, yol)) return;
  throw new UsageError(`${alan} cannot be outside the project root: ${yol}`);
}

/**
 * Yolu hem yazıldığı hâliyle hem de symlink'ler çözülmüş hâliyle denetler:
 * `kokIci` kapsamında `..` ile kaçan yol da, kök içindeki bir symlink üzerinden
 * dışarıyı gösteren yol da reddedilir. `izinliOnEk` gizli yol kuralının tek
 * istisnasını (hata paketi klasörü) taşır.
 */
async function yolDenetle(
  projeKoku: string,
  yol: string,
  alan: string,
  kapsam: YolKapsami,
  izinliOnEk: readonly string[] = [],
): Promise<void> {
  const cozulmusKok = resolve(projeKoku);
  const hedef = isAbsolute(yol) ? resolve(yol) : resolve(cozulmusKok, yol);
  if (kapsam === 'kokIci') kokDisiReddet(cozulmusKok, hedef, alan);
  gizliYolReddet(cozulmusKok, hedef, alan, izinliOnEk);
  const [gercekKok, gercekHedef] = await Promise.all([realpath(cozulmusKok), gercekYolTahmin(hedef)]);
  if (kapsam === 'kokIci') kokDisiReddet(gercekKok, gercekHedef, alan);
  gizliYolReddet(gercekKok, gercekHedef, alan, izinliOnEk);
}

/**
 * Belge/plan yolunu (`docs`, `docsPath`, `planPath`) denetler: yol proje kökü
 * içinde kalmalı ve gizli yol kuralına uymalı. İstisnası yoktur.
 */
export async function belgeYoluDenetle(projeKoku: string, yol: string, alan: string): Promise<void> {
  await yolDenetle(projeKoku, yol, alan, 'kokIci');
}

/**
 * Hata paketi çıkış klasörünü denetler. İki bilinçli istisna var:
 *
 * 1. Kök dışı serbest: CLI'da `kobay test failure get --out /tmp/...` insanın
 *    kendi kararıdır, paketi istediği yere kopyalayabilir. MCP tarafında bu
 *    serbestlik yok; `src/mcp/index.ts` ajanın verdiği `out` için kök içi
 *    denetimini kendisi yapar, yani ajan paketi proje ağacından çıkaramaz.
 * 2. Gizli yol kuralının `.kobay/failure-out/` altı: paket oturum çerezi
 *    içerir, orası da kobay'ın kendi `.gitignore`'unda zaten dışlanmıştır.
 */
export async function hataPaketiYoluDenetle(projeKoku: string, yol: string, alan: string): Promise<void> {
  await yolDenetle(projeKoku, yol, alan, 'kokDisiSerbest', HATA_PAKETI_DIZINI);
}

/**
 * Varsayılan hata paketi klasörü: `.kobay/failure-out/<id>`. Aynı test için her
 * çağrıda aynı yol; paket orada güvenle yenilenir, çöp klasör birikmez.
 */
export function hataPaketiVarsayilanYol(projeKoku: string, id: string): Promise<string> {
  return Promise.resolve(hataPaketiCikisYolu(projeKoku, id));
}

/**
 * Kayıtlı bir yolu her okuma öncesi yeniden çözüp proje kökünde tutar. Kök içi
 * ve gizli yol denetimi `belgeYoluDenetle`'nin işi; burada kopya kural yok.
 */
export async function kayitliProjeDosyasi(dizin: KobayDizini, yol: string, alan: string): Promise<string> {
  await belgeYoluDenetle(dizin.projeKoku, yol, alan);
  return realpath(isAbsolute(yol) ? yol : resolve(dizin.projeKoku, yol));
}

/**
 * Kayıtlı kimliği hedef origin'e karşı denetler; uyuşmazsa tarayıcı hiç
 * açılmadan yeniden giriş komutunu söyleyen yetki hatası (exit 5) verir.
 */
function kimlikHedefeUyar(kimlik: Kimlik, config: KobayConfig): void {
  try {
    kimlikOriginDogrula(kimlik, new URL(config.baseUrl).origin);
  } catch (hata: unknown) {
    if (!(hata instanceof CredentialOriginError)) throw hata;
    throw new PermissionError(
      `${hata.message} Re-enter the credentials for this address: \`kobay project create --url ${config.baseUrl}`
      + ' --login --force` (use --login-url when the login page differs)',
    );
  }
}

/** Test kaydını okur; yoksa iç dosya yolu yerine kimlik ve sonraki komutu söyler. */
export async function testOku(dizin: KobayDizini, id: string): Promise<TestKaydi> {
  try {
    return await dizin.testOku(id);
  } catch (hata: unknown) {
    if (hata instanceof FileNotFound) {
      throw new UsageError(`Test not found: ${id}; list the IDs with \`kobay test list\``);
    }
    throw hata;
  }
}

/** Tarayıcı açmadan hedefi yoklar; ayakta değilse exit 3 ile net mesaj verir. */
async function hedefiDogrula(baseUrl: string): Promise<void> {
  if (await hedefAyaktaMi(baseUrl)) return;
  throw new TargetUnreachableError(
    `Target app is not reachable: ${baseUrl}; start the app`
    + ' or fix the address with `kobay project update --base-url <URL>`',
  );
}

const AG_HATASI_DESENI = /net::ERR_|ERR_CONNECTION|ECONNREFUSED|ENOTFOUND|ERR_NAME_NOT_RESOLVED/;

/** Playwright'ın ham ağ hatasını (net::ERR_…) okunur hedef hatasına çevirir. */
function agHatasiniCevir(hata: unknown, baseUrl: string): never {
  const metin = hata instanceof Error ? hata.message : String(hata);
  if (AG_HATASI_DESENI.test(metin)) {
    throw new TargetUnreachableError(
      `Target app is not reachable: ${baseUrl}; start the app and run the command again`,
    );
  }
  throw hata;
}

export async function kesfiYenile(dizin: KobayDizini): Promise<Harita> {
  const [config, kimlik] = await Promise.all([dizin.configOku(), dizin.kimlikOku()]);
  if (kimlik !== null) kimlikHedefeUyar(kimlik, config);
  await hedefiDogrula(config.baseUrl);
  let harita: Harita;
  try {
    harita = await kesfet({
      baseUrl: config.baseUrl,
      storageStateYolu: dizin.storageStateYolu(),
      ...(kimlik === null ? {} : { kimlik }),
      ...(config.loginUrl === undefined ? {} : { loginUrl: config.loginUrl }),
    });
  } catch (hata: unknown) {
    agHatasiniCevir(hata, config.baseUrl);
  }
  if (kimlik !== null && !harita.loggedIn) {
    throw new PermissionError('Login failed; check the username, the password, and the login URL');
  }
  await dizin.haritaYaz(harita);
  return harita;
}

export async function haritaSagla(dizin: KobayDizini): Promise<Harita> {
  return (await dizin.haritaOku()) ?? kesfiYenile(dizin);
}

/**
 * Tek bir sayfayı yeniden keşfedip haritada yerinde günceller; diğer sayfalara
 * dokunmaz. Sayfa haritada yoksa keşif hiç başlatılmaz.
 */
export async function sayfaKesfiniYenile(
  dizin: KobayDizini,
  testUrl: string,
): Promise<{ yeniSayfa: Sayfa; eskiSayfa: Sayfa }> {
  const [config, kimlik, harita] = await Promise.all([
    dizin.configOku(),
    dizin.kimlikOku(),
    dizin.haritaOku(),
  ]);
  if (harita === null) throw new UsageError('No exploration map; run `kobay explore` first');
  if (haritadaSayfaBul(harita, testUrl) === null) {
    throw new UsageError(`Test page is not in the exploration map: ${testUrl}; run \`kobay explore\` first`);
  }
  if (kimlik !== null) kimlikHedefeUyar(kimlik, config);
  await hedefiDogrula(config.baseUrl);

  let yeniSayfa: Sayfa;
  try {
    yeniSayfa = await sayfayiYenile({
      baseUrl: config.baseUrl,
      url: testUrl,
      storageStateYolu: dizin.storageStateYolu(),
      ...(kimlik === null ? {} : { kimlik }),
      ...(config.loginUrl === undefined ? {} : { loginUrl: config.loginUrl }),
    });
  } catch (hata: unknown) {
    agHatasiniCevir(hata, config.baseUrl);
  }
  const guncel = haritadaSayfayiDegistir(harita, testUrl, yeniSayfa);
  if (guncel === null) throw new UsageError(`Test page is not in the exploration map: ${testUrl}`);
  await dizin.haritaYaz(guncel.harita);
  return { yeniSayfa, eskiSayfa: guncel.eskiSayfa };
}
