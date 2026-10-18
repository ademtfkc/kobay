import { realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  FileNotFound,
  adresKimligiGizle,
  KobayDizini,
  hataPaketiCikisYolu,
  type Harita,
  type Kimlik,
  type KobayConfig,
  type OturumDurumu,
  type Sayfa,
  type TestKaydi,
} from '../../depo/index.js';
import {
  CredentialLeakBlockedError,
  haritadaSayfaBul,
  girisSayfaMesajiNotu,
  haritadaSayfayiDegistir,
  kesfetAyrintili,
  sayfayiYenile,
  type KesifSonucu,
} from '../../kesif/index.js';
// Doğrudan modülden: keşif modülünü taklit eden testlerde de oturum dosyası doğrulaması gerçek kalır.
import {
  iceAlinanOturumuOku,
  oturumDosyasiniHazirla,
  SessionFileError,
} from '../../kesif/oturum-dosyasi.js';
// Doğrudan modülden: keşif modülünü taklit eden testlerde de tohum doğrulaması gerçek kalır.
import { SeedUrlError, tohumlariDogrula } from '../../kesif/sitemap.js';
import { CredentialOriginError, LoginFormOriginError, StorageStateSymlinkError, kimlikOriginDogrula } from '../../kesif/oturum.js';
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

/** HTML raporun varsayılan klasörü; `.kobay` altında rapor için tek izinli yol. */
export const RAPOR_DIZINI = ['.kobay', 'report'] as const;

/**
 * Rapor çıkış klasörünü denetler; `hataPaketiYoluDenetle` ile aynı kural ailesi:
 * kök dışı serbest, gizli yol bileşeni yasak. `.kobay` altındaki tek istisna
 * tam olarak `.kobay/report` (altı değil): oranın symlink denetimi yayımda
 * yapılır. Dolu klasörün kobay raporu olup olmadığı yayım katmanında denetlenir.
 */
export async function raporYoluDenetle(projeKoku: string, yol: string, alan: string): Promise<void> {
  const cozulmusKok = resolve(projeKoku);
  const hedef = isAbsolute(yol) ? resolve(yol) : resolve(cozulmusKok, yol);
  if (hedef === resolve(cozulmusKok, ...RAPOR_DIZINI)) return;
  await yolDenetle(cozulmusKok, hedef, alan, 'kokDisiSerbest');
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
  const hedefOrigin = new URL(config.baseUrl).origin;
  try {
    kimlikOriginDogrula(kimlik, hedefOrigin, config.authOrigins ?? []);
  } catch (hata: unknown) {
    if (!(hata instanceof CredentialOriginError)) throw hata;
    if (kimlik.origin === hedefOrigin) {
      // Hedef aynı, auth origin kümesi farklı (config elle değişti ya da kimlik eski): config'teki
      // liste sorgusuz onaylanmaz; kullanıcı kimliği yeniden girerken tam listeyi açıkça verir.
      throw new PermissionError(
        `${hata.message} Re-enter the credentials and give the full list of separate login sites:`
        + ' `kobay project update --login --auth-origin <origin>` (repeat --auth-origin for each),'
        + ' or `kobay project update --login --clear-auth-origins`',
      );
    }
    throw new PermissionError(
      `${hata.message} Re-enter the credentials for this address: \`kobay project create --url ${adresKimligiGizle(config.baseUrl)}`
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

/** Adres kullanıcı adı ya da parola taşıyor mu; ayrıştırılamayan adres taşımıyor sayılır. */
export function adresKimlikliMi(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}

/**
 * JSON çıktısındaki config: hedef ve giriş adresinin yalnız kullanıcı bilgisi maskelenir
 * (yol, sorgu, port aynen kalır). Kimlikli adres artık geçersiz girdi; eski config'te kalmış
 * olabilir ve makine çıktısına da düz metin parola yazılmaz.
 */
export function configKimligiGizle(config: KobayConfig): KobayConfig {
  return {
    ...config,
    baseUrl: adresKimligiGizle(config.baseUrl),
    ...(config.loginUrl === undefined ? {} : { loginUrl: adresKimligiGizle(config.loginUrl) }),
  };
}

/**
 * Hedef ve giriş adresi kullanıcı bilgisi (kullanıcı adı ya da parola) taşıyamaz: adres config'e,
 * haritaya ve JSON çıktısına aynen yazılır, parola düz metin kalırdı. Giriş bilgisi `--login` ile
 * ayrı saklanır. Ayrıştırılamayan adres burada geçer; onu şema denetimi reddeder.
 */
export function kimlikliAdresReddet(url: string, oneri = 'and save the login with `--login`'): void {
  if (!adresKimlikliMi(url)) return;
  throw new UsageError(
    `The address must not contain a username or password: ${adresKimligiGizle(url)}. Give it without them ${oneri}`,
  );
}

/**
 * Önceden (bu denetimden önce) kaydedilmiş kimlikli adresle tarayıcı açılmaz. Hedefe giden her
 * komut (keşif, sayfa yenileme, test koşusu) config'i okuduktan hemen sonra bunu çağırır. Şema
 * düzeyinde reddedilmez: `project update` kimlikli config'i okuyup düzeltebilmeli.
 */
export function kayitliAdresleriDenetle(config: KobayConfig): void {
  kimlikliAdresReddet(config.baseUrl, 'and fix it with `kobay project update --base-url <URL>`; save the login with `--login`');
  if (config.loginUrl !== undefined) {
    kimlikliAdresReddet(config.loginUrl, 'and fix it with `kobay project update --login-url <URL>`; save the login with `--login`');
  }
}

/** Tarayıcı açmadan hedefi yoklar; ayakta değilse exit 3 ile net mesaj verir. */
async function hedefiDogrula(baseUrl: string): Promise<void> {
  if (await hedefAyaktaMi(baseUrl)) return;
  throw new TargetUnreachableError(
    `Target app is not reachable: ${adresKimligiGizle(baseUrl)}; start the app`
    + ' or fix the address with `kobay project update --base-url <URL>`',
  );
}

const AG_HATASI_DESENI = /net::ERR_|ERR_CONNECTION|ECONNREFUSED|ENOTFOUND|ERR_NAME_NOT_RESOLVED/;

/** Playwright'ın ham ağ hatasını (net::ERR_…) okunur hedef hatasına çevirir. */
function agHatasiniCevir(hata: unknown, baseUrl: string): never {
  const metin = hata instanceof Error ? hata.message : String(hata);
  if (AG_HATASI_DESENI.test(metin)) {
    throw new TargetUnreachableError(
      `Target app is not reachable: ${adresKimligiGizle(baseUrl)}; start the app and run the command again`,
    );
  }
  throw hata;
}

/**
 * Giriş sırasında parolanın başka origin'e gitmesini engelleyen hatalar motor
 * arızası değil, hedefin güvenlik reddidir: kayıtlı kimlik uyuşmazlığı gibi
 * yetki hatası (exit 5) olarak döner. Mesaj aynen korunur.
 */
function girisHatasiniCevir(hata: unknown): void {
  // Sembolik bağ `.kobay/storageState.json`: kullanıcının düzelteceği durum, exit 2.
  if (hata instanceof StorageStateSymlinkError) throw new UsageError(hata.message);
  if (
    hata instanceof CredentialLeakBlockedError
    || hata instanceof CredentialOriginError
    || hata instanceof LoginFormOriginError
  ) {
    throw new PermissionError(hata.message);
  }
}

/** `kobay explore` bayraklarından (ya da MCP girdisinden) gelen keşif ayarı; boş alan varsayılandır. */
export interface KesifAyari {
  tohumlar?: readonly string[];
  siteHaritasi?: boolean;
  maxSayfa?: number;
  derinlik?: number;
}

/** Oturum dosyası hataları kullanım hatasıdır (exit 2); mesaj değer taşımaz. */
export async function oturumHatasiniCevir<T>(is: Promise<T>): Promise<T> {
  try {
    return await is;
  } catch (hata: unknown) {
    if (hata instanceof SessionFileError) throw new UsageError(hata.message);
    throw hata;
  }
}

/**
 * `--session-file`: dosyayı doğrulayıp `.kobay/storageState.json`'a (0600) yazar; kaynak dosyaya
 * dokunulmaz. Doğrulama düşerse hiçbir şey yazılmaz. Yazılan oturum döner.
 *
 * Yazım kimlik işleminin kilidi altında yapılır (`kimlikVeOturumuKenaraAl`): eşzamanlı bir
 * `project create --force --login` ya da hedef değişimi ile yarışmasın. Kilit alındıktan sonra
 * config ve kimlik yeniden okunur: config doğrulamadakinden farklıysa ya da bu arada kimlik
 * kaydedilmişse işlem geri alınır (eski oturum yerine konur), komut exit 2 ile durur.
 */
export async function oturumDosyasiniIceAl(
  dizin: KobayDizini,
  config: KobayConfig,
  oturumDosyasi: string,
): Promise<OturumDurumu> {
  const { durum, metin } = await oturumHatasiniCevir(
    oturumDosyasiniHazirla(oturumDosyasi, config.baseUrl, config.authOrigins ?? []),
  );
  const islem = await dizin.kimlikVeOturumuKenaraAl({ eskiConfig: config });
  let oturumYazildi = false;
  try {
    const guncel = await dizin.configOku();
    if (JSON.stringify(guncel) !== JSON.stringify(config)) {
      throw new UsageError('The project config changed while the session was being imported; nothing was imported. Run the command again');
    }
    if (islem.adlar.includes('credentials.json')) throw new UsageError(OTURUM_VE_KIMLIK_HATASI);
    oturumYazildi = true;
    await dizin.storageStateYaz(metin);
    await islem.kesinlestir();
  } catch (hata: unknown) {
    // Yeni oturum kalmasın; eski oturum (varsa) ve kimlik geri alma ile yerine konur. Config'e
    // dokunulmadı: geri alma onu yazmaz.
    if (oturumYazildi) await rm(dizin.storageStateYolu(), { force: true }).catch(() => undefined);
    await islem.geriAl({ asilHata: hata });
    throw hata;
  }
  return durum;
}

/** `--session-file` ile kayıtlı kimlik bir arada olamaz: keşif kimlikle giriş yapıp içe alınan oturumu ezerdi. */
export const OTURUM_VE_KIMLIK_HATASI = 'This project has saved login credentials (`--login`), so `kobay explore` logs in'
  + ' with them and would replace an imported session. Use one or the other: re-create the project with'
  + ' `kobay project create --url <URL> --session-file <file> --force` (this removes the saved credentials).';

export async function kesfiYenile(dizin: KobayDizini, ayar: KesifAyari = {}, oturumDosyasi?: string): Promise<Harita> {
  const [config, kimlik] = await Promise.all([dizin.configOku(), dizin.kimlikOku()]);
  kayitliAdresleriDenetle(config);
  if (kimlik !== null) kimlikHedefeUyar(kimlik, config);
  // Kullanım hatası ağdan önce: başka kökenli tohum hedefe hiç istek atmadan exit 2.
  let tohumlar: string[];
  try {
    tohumlar = tohumlariDogrula(config.baseUrl, ayar.tohumlar ?? []);
  } catch (hata: unknown) {
    if (hata instanceof SeedUrlError) throw new UsageError(hata.message);
    throw hata;
  }
  // İçe alınan oturum: yeni dosya verildiyse önce o doğrulanıp yazılır; verilmediyse kayıtlı
  // dosya içe alınmış mı diye bakılır (işaretli değilse eski yol aynen sürer).
  let oturum: OturumDurumu | null = null;
  if (oturumDosyasi !== undefined) {
    if (kimlik !== null) throw new UsageError(OTURUM_VE_KIMLIK_HATASI);
    oturum = await oturumDosyasiniIceAl(dizin, config, oturumDosyasi);
  } else if (kimlik === null) {
    oturum = await oturumHatasiniCevir(iceAlinanOturumuOku(dizin.storageStateYolu(), config.baseUrl, config.authOrigins ?? []));
  }
  await hedefiDogrula(config.baseUrl);
  let sonuc: KesifSonucu;
  try {
    sonuc = await kesfetAyrintili({
      baseUrl: config.baseUrl,
      storageStateYolu: dizin.storageStateYolu(),
      ...(tohumlar.length === 0 ? {} : { tohumlar }),
      ...(ayar.siteHaritasi === undefined ? {} : { siteHaritasi: ayar.siteHaritasi }),
      ...(ayar.maxSayfa === undefined ? {} : { maxSayfa: ayar.maxSayfa }),
      ...(ayar.derinlik === undefined ? {} : { derinlik: ayar.derinlik }),
      ...(kimlik === null ? {} : { kimlik }),
      ...(config.loginUrl === undefined ? {} : { loginUrl: config.loginUrl }),
      ...(config.authOrigins === undefined ? {} : { authOrigins: config.authOrigins }),
      ...(oturum === null ? {} : { oturum }),
    });
  } catch (hata: unknown) {
    girisHatasiniCevir(hata);
    agHatasiniCevir(hata, config.baseUrl);
  }
  const { harita } = sonuc;
  const dusenSayfa = oturum === null ? 0 : harita.pages.filter((sayfa) => sayfa.requiresLogin === true).length;
  if (dusenSayfa > 0) {
    process.stderr.write(
      `[kobay] Warning: ${dusenSayfa} page${dusenSayfa === 1 ? '' : 's'} sent the imported session to a login page;`
      + ' the session may have expired. Import a fresh one with `kobay explore --session-file <file>`.\n',
    );
  }
  if (kimlik !== null && !harita.loggedIn) {
    // Sayfanın ret gerekçesi (maskeli, etiketli alıntı ya da "withheld" notu) varsa eklenir;
    // yoksa mesaj eskisiyle birebir aynı kalır.
    const not = girisSayfaMesajiNotu(sonuc.girisSayfaMesaji);
    throw new PermissionError(`Login failed; check the username, the password, and the login URL${not === '' ? '' : `.${not}`}`);
  }
  await dizin.haritaYaz(harita);
  return harita;
}

/**
 * 0.6.0 ve öncesinde kimlikli adresle yapılan keşif parolayı haritaya yazdı; config düzeltilse de
 * harita kalır ve beyne (dış servise) giderdi. Haritayı okuyup hedefe ya da beyne giden her
 * komut bunu çağırır; `explore` haritayı baştan yazdığı için muaftır.
 * Denetlenen alanlar: `baseUrl`, `seeds[]`, `sitemap.url`, `pages[].url`, `pages[].redirectedTo`,
 * `pages[].links[]`, `pages[].forms[].action`.
 */
export function kayitliHaritayiDenetle(harita: Harita | null): void {
  if (harita === null) return;
  const adresler = [
    harita.baseUrl,
    ...(harita.seeds ?? []),
    ...(harita.sitemap === undefined ? [] : [harita.sitemap.url]),
    ...harita.pages.flatMap((sayfa) => [
      sayfa.url,
      ...(sayfa.redirectedTo === undefined ? [] : [sayfa.redirectedTo]),
      ...sayfa.links,
      ...sayfa.forms.flatMap((form) => (form.action === undefined ? [] : [form.action])),
    ]),
  ];
  const kimlikli = adresler.find((adres) => adresKimlikliMi(adres));
  if (kimlikli === undefined) return;
  throw new UsageError(
    `The saved map was built with an address that contains a username or password (${adresKimligiGizle(kimlikli)});`
    + ' run `kobay explore` to rebuild it',
  );
}

export async function haritaSagla(dizin: KobayDizini): Promise<Harita> {
  // Kayıtlı harita eski kimlikli adresle üretilmiş olabilir: harita okuyan her komut da denetlenir.
  kayitliAdresleriDenetle(await dizin.configOku());
  const harita = await dizin.haritaOku();
  if (harita === null) return kesfiYenile(dizin);
  kayitliHaritayiDenetle(harita);
  return harita;
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
  kayitliAdresleriDenetle(config);
  if (harita === null) throw new UsageError('No exploration map; run `kobay explore` first');
  kayitliHaritayiDenetle(harita);
  if (haritadaSayfaBul(harita, testUrl) === null) {
    throw new UsageError(`Test page is not in the exploration map: ${testUrl}; run \`kobay explore\` first`);
  }
  if (kimlik !== null) kimlikHedefeUyar(kimlik, config);
  // İçe alınan oturumun değerleri yenilenen sayfa özetinden maskelenir (keşifteki gibi).
  const oturum = kimlik !== null
    ? null
    : await oturumHatasiniCevir(iceAlinanOturumuOku(dizin.storageStateYolu(), config.baseUrl, config.authOrigins ?? []));
  await hedefiDogrula(config.baseUrl);

  let yeniSayfa: Sayfa;
  try {
    yeniSayfa = await sayfayiYenile({
      baseUrl: config.baseUrl,
      url: testUrl,
      storageStateYolu: dizin.storageStateYolu(),
      ...(kimlik === null ? {} : { kimlik }),
      ...(config.loginUrl === undefined ? {} : { loginUrl: config.loginUrl }),
      ...(config.authOrigins === undefined ? {} : { authOrigins: config.authOrigins }),
      ...(oturum === null ? {} : { oturum }),
    });
  } catch (hata: unknown) {
    girisHatasiniCevir(hata);
    agHatasiniCevir(hata, config.baseUrl);
  }
  const guncel = haritadaSayfayiDegistir(harita, testUrl, yeniSayfa);
  if (guncel === null) throw new UsageError(`Test page is not in the exploration map: ${testUrl}`);
  await dizin.haritaYaz(guncel.harita);
  return { yeniSayfa, eskiSayfa: guncel.eskiSayfa };
}
