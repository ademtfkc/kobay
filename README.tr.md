<h1 align="center">kobay</h1>

<p align="center">
  <b>Kodlama ajanları için yerel uçtan uca testler; ajanın üzerinde iş yapabileceği hata kanıtlarıyla.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ademtfkc/kobay"><img alt="npm" src="https://img.shields.io/npm/v/@ademtfkc/kobay?color=bc4c00"></a>
  <a href="https://github.com/ademtfkc/kobay/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ademtfkc/kobay/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Node.js 22.12 or newer" src="https://img.shields.io/node/v/@ademtfkc/kobay">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="CHANGELOG.md">Değişiklik günlüğü</a> ·
  <a href="#hızlı-başlangıç">Hızlı başlangıç</a> ·
  <a href="#kodlama-ajanından-kullan">Kodlama ajanları</a> ·
  <a href="#ci-github-actions">CI</a> ·
  <a href="#güvenlik-modeli">Güvenlik</a> ·
  <a href="#başvuru">Başvuru</a>
</p>

kobay'ı kendi makinende çalışan bir web uygulamasına yönelt. Uygulamayı görünmez
(headless) bir Chromium'da gezer, bir LLM'e kullanıcı akışları önerttirir,
kabul ettiklerini Playwright testine çevirir, koşturur ve bir test düştüğünde
ajanının üzerinde iş yapabileceği bir kanıt paketi (evidence bundle) geri verir:
kök neden tahmini, bir `failureKind` (hata türü) sınıfı, önerilen düzeltme
hedefi, düşen adımın ekran görüntüsü ve DOM'u, bir de Playwright trace'i
(adım adım kayıt).

<p align="center">
  <img alt="kobay HTML report: 2 of 4 tests failed, a fix-all prompt for a coding agent, and the first failed test card" src="https://raw.githubusercontent.com/ademtfkc/kobay/main/assets/readme/report-overview.png" width="820">
  <br><sub>kobay'ın paketindeki demo uygulamaya karşı yapılan gerçek bir koşunun HTML raporu.</sub>
</p>

## Neden kobay

- **Yerel.** kobay hesabı, bulut servisi, tünel yok — tarayıcı, uygulama ve test
  koşuları makinende kalır. LLM'e (kobay buna **beyin** der) varsayılan olarak
  kendi `claude` CLI'ın bakar; yani kobay'ın kendi API anahtarı yoktur. Beyne
  ulaşmak için bir miktar veri makinenden çıkar; bkz.
  [Maliyet ve veri](#maliyet-ve-veri).
- **Sadece "düştü" değil, kanıt paketi.** Her hata; kök neden tahmini, önerilen
  düzeltme hedefi, düşen adımın ekran görüntüsü ve DOM'u, önemliyse konsol ve ağ
  hataları ve bir Playwright trace'i ile gelir.
- **`failureKind`, ajanının yanlış şeyi düzeltmesini önler.** Yalnızca "düştü"
  diyen bir test ajanı tahmine iter. `product_bug` yerine `product_changed` ya
  da `test_bug` diyen bir paket ise ajanı hiç bozulmamış bir uygulamayı
  "düzeltmekten" alıkoyar.
- **Beyinsiz CI.** Yerelde ürettiğin testler her pull request'te
  `--no-analysis` ile koşar: LLM çağrısı yok, API anahtarı yok; her hata için de
  düzeltme istemi (prompt) içeren bir pull request yorumu var.

**kobay'ı yalnız güvendiğin yerel ya da test ortamına yönelt.** Üretilen testler
düğmelere basar, form gönderir, kayıt oluşturur.

## Hızlı başlangıç

**Node.js 22.12 veya üstü**, macOS, Linux ya da Windows ve bir beyin gerekir:
oturumu açık `claude` CLI varsayılan ve en çok denenmiş olandır
([diğer beyinler](#kurulum-ve-gereksinimler)).

```sh
npm install -g @ademtfkc/kobay
kobay install-browser        # Linux: kobay install-browser --with-deps
kobay doctor
```

kobay küçük bir demo uygulama ile gelir — giriş sayfası, pano, kayıt listesi,
yeni kayıt formu — böylece kendi projene yöneltmeden önce bütün döngüyü
izleyebilirsin. Aşağıdaki her çıktı, `claude` beyniyle yapılan tek bir gerçek
koşudan kopyalandı (yollar ve uzun satırlar kısaltıldı, kesintiler `…` ile
işaretli).

**1. Demoyu başlat:** kendi terminalinde aç ve çalışır bırak.

```sh
kobay demo --port 3999
#> Kobay demo: http://127.0.0.1:3999
#> Login: demo / demo123
#> Press Ctrl+C to stop
```

**2. Proje oluştur ve keşfet.** Keşif LLM çağırmaz: kobay giriş yapar ve
uygulamanın bağlantılarını izleyerek sayfalarının bir *haritasını* çıkarır.

```sh
mkdir kobay-demo && cd kobay-demo
KOBAY_LOGIN_USER=demo KOBAY_LOGIN_PASS=demo123 \
  kobay project create --url http://127.0.0.1:3999 \
                       --login --login-url http://127.0.0.1:3999/login
#> Project created: ~/kobay-demo/.kobay
#> …
#> Next: kobay explore

kobay explore
#> 4 pages explored (logged in)
#> Map: ~/kobay-demo/.kobay/map.json
#> Pages: /login, /, /records, /new
#> Next: kobay test plan generate
```

**3. Beyin test önersin, birkaçını kabul et** (her yeni test ilk koşusunda LLM
çağrısı demektir).

```sh
kobay test plan generate
#> 16 proposals generated; 3 dropped: Login page renders correctly (A step needs the real credentials, …), …
#> { "proposals": [
#>     { "id": "p_5j4p9f", "priority": "p1", "title": "Record List displays existing records with Delete buttons", "stepCount": 4 },
#>     { "id": "p_bc7p1e", "priority": "p0", "title": "Create a new record and see it in the list", "stepCount": 9 },
#>     { "id": "p_e0kklk", "priority": "p1", "title": "Submit New Record form with empty name", "stepCount": 7 },
#>     … 13 more …

kobay test plan accept --ids p_5j4p9f,p_bc7p1e,p_e0kklk
#> 3 proposals accepted
#> t_s7k7kkdn  Record List displays existing records with Delete buttons  …
#> t_jqt9aypj  Create a new record and see it in the list                 …
#> t_v5hpedx1  Submit New Record form with empty name                     …
```

**4. Kendi testini ekle** (isteğe bağlı). Elle yazılmış bir plan, beynin
önermediği bir akış ister — burada demo uygulamada olmayan bir aylık toplam
satırı:

```sh
kobay test create --plan monthly-total.plan.json
#> Test created: t_6t11idff
#> Name: Record list shows a monthly total
#> Steps: 2, priority: p0, status: draft
#> Next: kobay test run t_6t11idff
```

**5. Koştur.** Kodu olmayan testler için önce Playwright kodu üretilir (LLM
çağrısı); düşen test sonra analiz edilir (bir LLM çağrısı daha).

```sh
kobay test run --all
#> failed t_6t11idff — test_bug
#>   failure bundle: kobay test failure get t_6t11idff
#> passed t_jqt9aypj
#> passed t_s7k7kkdn
#> failed t_v5hpedx1 — product_bug
#>   failure bundle: kobay test failure get t_v5hpedx1
```

Çıkış kodu `1`: bir test düştü. İki hata iki ayrı hikâyedir ve `failureKind`
ikisini birbirinden ayırır:

- **`t_v5hpedx1` — `product_bug`.** Paketteki demoda bilinen bir hata var:
  boş isimli kaydı kabul ediyor. Analiz listede dördüncü, isimsiz satırı buldu
  ve formun POST işleyicisini işaret etti:

  ```json
  "failureKind": "product_bug",
  "recommendedFixTarget": {
    "kind": "code",
    "reference": "POST handler for the New Record form at http://127.0.0.1:3999/new (the 'Save' submission that creates a record and redirects to /records) — the 'Name' field is not validated as required",
    "rationale": "The record was persisted with an empty name instead of being rejected. …"
  }
  ```

- **`t_6t11idff` — `test_bug`.** Aylık toplam uygulamanın hiçbir zaman parçası
  olmadı. Analiz sayfayı keşif haritasıyla karşılaştırdı, hiçbir şeyin
  değişmediğini gördü ve beklentinin üründen değil plandan geldiği sonucuna
  vardı. Bir ajanı kayıt listesini "düzeltmeye" göndermek yerine o doğrulamayı
  bırakmayı önerdi — ya da aylık toplam gerçek bir gereksinimse, eksik bir
  özellik olarak ortaya koymayı.

**6. Kanıtı oku ve raporu gör.**

```sh
kobay test failure get t_v5hpedx1
#> Failure bundle copied: ~/kobay-demo/.kobay/failure-out/t_v5hpedx1

kobay test report --all
#> Report written: 4 tests (2 passed, 2 failed, 0 blocked, 0 inconclusive, 0 not run), 20 screenshots.
#> Open: ~/kobay-demo/.kobay/report/index.html
#> Screenshots are not redacted; review them before sharing the report.
```

Düzeltmeden sonra `kobay test rerun <id>` aynı kodu yeniden koşturur. Bu turun
tamamı — bir plan, dört kod üretimi, iki analiz — 7 beyin çağrısıydı ve
`claude` CLI ile yaklaşık 1,10 $ tuttu. İşin bitince demoyu Ctrl+C ile durdur.

Her adımın bayraklarıyla birlikte daha uzun anlatımı
[Ayrıntılı hızlı başlangıç](#ayrıntılı-hızlı-başlangıç) bölümünde.

## Nasıl çalışır

<p align="center">
  <img alt="The kobay loop: explore, plan, generate, run, analyse; a failed test becomes a failure bundle whose failureKind is product_bug (fix the app, then rerun), product_changed (test refresh) or test_bug (fix the test code, then rerun)" src="https://raw.githubusercontent.com/ademtfkc/kobay/main/assets/readme/flow.svg" width="860">
</p>

**explore** (keşif) LLM kullanmaz; her sayfanın başlığını, alt başlıklarını,
bağlantılarını, formlarını, düğmelerini ve menülerini kaydeder. **plan
generate** ve **test run** beyni çağırır; üretilen kod kaydedilmeden önce
denetlenir — `page.goto` yalnız haritadaki adreslere gidebilir ve her
`test.step` başlığı plan adımıyla birebir aynı olmalıdır. **test refresh**
yalnız o testin sayfasını yeniden keşfeder, haritayı yerinde günceller, plan
adımlarını uyarlar, kodu yeniden üretir ve aynı test kimliğiyle koşturur;
`--no-run` plan güncellemesinden sonra durur.

`failureKind`, ajanın üzerinde iş yaptığı alandır:

| `failureKind` | Anlamı | Ne yapılır |
| --- | --- | --- |
| `product_bug` | Uygulama bozuk. | Uygulamayı düzelt, sonra `kobay test rerun <id>`. |
| `product_changed` | Uygulama bilerek değişti; harita eskidi. | Uygulamaya dokunma: `kobay test refresh <id>`. |
| `test_bug` | Test kodu ya da bir seçici (selector) yanlış. | `kobay test code get <id>`, testi düzelt. |

Gerisini `env`, `flaky` ve `unknown` kapsar; bkz.
[Çıktı, çıkış kodları ve hata türleri](#çıktı-çıkış-kodları-ve-hata-türleri).

Panelli, destek sözleşmeli, barındırılan bir ürün istiyorsan kobay o değil —
[TestSprite](https://www.testsprite.com/)'a bak; o benzer bir keşif → plan →
üretim → koşu → analiz döngüsünü servis olarak sunuyor. kobay aynı fikrin yerel,
daha dar ve kendi LLM'ini getirdiğin hâli.

## Kodlama ajanından kullan

İkisi de uygulamanın proje köküne kurulan iki parça: ajana kobay'ın araçlarını
veren bir **MCP sunucusu** (ajanın dış araçlara bağlandığı standart protokol) ve
ne zaman, nasıl kullanılacağını söyleyen bir **beceri dosyası** (skill file).

```sh
kobay agent install --target claude
#> Skill created: ~/my-app/.claude/skills/kobay/SKILL.md
#> MCP registered in .mcp.json (kobay → `kobay mcp`): ~/my-app/.mcp.json
```

`.mcp.json` proje kapsamlı bir MCP ayarıdır; bu yüzden o dizindeki ilk `claude`
oturumunda sunucu **pending approval** (onay bekliyor) görünür ve bir kez onay
ister. Diğer ajanlar için beceriyi kobay yazar, sunucuyu sen kaydedersin:

```sh
kobay agent install --target codex
#> Skill created: ~/my-app/AGENTS.md
#> MCP registration: `codex mcp add kobay -- kobay mcp`

kobay agent install --target cursor
#> Skill created: ~/my-app/.cursor/rules/kobay.mdc
#> MCP registration: add `{ "mcpServers": { "kobay": { "command": "kobay", "args": ["mcp"] } } }` to `.cursor/mcp.json`
```

Codex hedefi yalnız `<!-- kobay:BEGIN -->` ile `<!-- kobay:END -->` arasındaki
bloğu değiştirir, `AGENTS.md`'nin geri kalanını korur. Üçü de bulunduğun projeye
yazar, ev dizinine asla. Claude Code sunucusunu elle kaydetmek için:
`claude mcp add -s project kobay -- kobay mcp`.

### Bunu kodlama ajanına yapıştır

```text
Use kobay to verify this local web app end to end. First ensure kobay is
available (install it if needed), run `kobay install-browser`, and start or
identify the app's local URL. Create or inspect the Kobay project, then run the
app health check. For the feature I changed, find existing tests or explore the
app, generate a small focused plan, accept only the relevant proposals, and run
the tests. If a test fails, fetch and read its failure bundle. For
`product_bug`, fix the product code; for `product_changed`, refresh the test;
for `test_bug`, inspect the generated code before fixing the test. Re-run the
same test after each fix. Prefer the Kobay MCP tools when available; otherwise
use the CLI with `--output json`. In CLI JSON, decide from `ok` and `exitCode`,
not the shell exit status of a piped command. Do not expose credentials, cookies
or traces. Stop after two unsuccessful fix attempts and report the tests run,
their verdicts, changes made, and anything still unverified.
```

**Hata bayrağına değil, `verdict` alanına bak.** MCP üzerinden bir testin sonucu
`test_run` yanıt gövdesindeki `verdict` alanıdır. Düşen bir test normal bir
sonuçtur ve `isError` işaretlemez; `isError` yalnız araç işini yapamadığında
döner — kullanım, hedef, beyin/motor ya da yetki hataları (çıkış kodları
`2`–`5`). Yalnız `isError`'a bakan bir ajan düşen testi geçmiş sayar. MCP hata
gövdesi CLI'ın JSON hatasıyla aynı biçimdedir, `{"error":{"code","message"}}`;
istisna `test_run` ve `test_rerun`: `blocked` (çıkış `3`) ve `inconclusive`
(çıkış `4`) sonuçta `isError` ile birlikte verdict satırlarını döndürür, orada da
`verdict` alanını oku.

<details>
<summary><b>MCP öncelikli çağrı sırası, araç listesi ve MCP üzerinden giriş</b></summary>

### MCP öncelikli çağrı sırası

Kaynak: [`src/mcp/index.ts`](src/mcp/index.ts) ve
[`beceri/SKILL.md`](beceri/SKILL.md). Aşağıdaki her araç isteğe bağlı
`projectDir` alır; sunucu proje içinde başladıysa geçme.

1. `project_get` çağır → proje ayarları ve durumu. Proje yoksa zorunlu `url` ve
   isteğe bağlı `docs`, `loginUser`, `loginUrl`, `force` ile `project_create`
   çağır → `.kobay/` oluşur.
2. `doctor` çağır → kurulum, hedef ve ortam denetimleri. Hedef satırı `ok: true`
   olmadan devam etme; bir satır düşse bile `doctor` başarılı çıkabilir.
3. `test_list` çağır → kaydedilmiş testler. Yeni özellik için `explore` çağır →
   yenilenmiş sayfa haritası; sonra isteğe bağlı `hint` ile `plan_generate` →
   öneriler; sonra `ids: string[]` (ya da `all: true`) ile `plan_accept` → taslak
   testler.
4. `ids: string[]` ya da `all: true` ile `test_run` çağır (isteğe bağlı
   `rerun`) → test başına bir sonuç; `verdict`, `runId` ve düşerse
   `failureKind` dahil.
5. Düşen test için `id` ile `failure_get` çağır (isteğe bağlı `out`) → kanıt
   paketi. `failureKind`'ı oku: ürün düzeltmesinden sonra `id` ile `test_rerun`
   çağır; `product_changed` için `id` ile `test_refresh` (isteğe bağlı `run`);
   test sorunu için üretilen kodu değiştirmeden önce `id` ile `code_get` çağır.
6. Döngü bitince `prune` çağır (isteğe bağlı `confirm`, `dryRun`, `maxMb`,
   `olderThanDays`) → varsayılan olarak eski koşuları, beyin günlüklerini ve
   artıkları önizler; sonucu incele, silmek için `confirm: true` geçir.
   `dryRun: true` her durumda önizlemeyi zorlar.

**MCP yoksa CLI.** Eş komutları `--output json` ile kullan:
`kobay project get`, `kobay doctor`, `kobay test list`, `kobay explore`,
`kobay test plan generate`, `kobay test plan accept --ids <P1,P2>`,
`kobay test run <ID...>`, `kobay test failure get <ID>` ve
`kobay test rerun <ID>`; temizlik için `kobay prune --dry-run`, sonra
`kobay prune`. Her CLI yanıtı tek bir JSON zarfıdır. Kararı içindeki
`ok` ve `exitCode` alanlarından ver; kobay'ı başka bir komuta borulayıp `$?`
okuma — o, kobay'ın değil son komutun durumudur.

**MCP sunucusu** (`kobay mcp`, stdio) şu araçları sunar:

```
project_create  project_update  project_get  explore       plan_generate
plan_accept     test_create     test_list    test_get      code_get
test_delete     test_run        test_rerun   test_refresh  test_result
failure_get     test_report     doctor       prune
```

Her araç MCP ipucu etiketleri taşır: `test_delete`, `prune`, `project_create`
ve `project_update` `destructiveHint` (yıkıcı) ile işaretlidir; hiçbir araç
`readOnlyHint` (salt okunur) taşımaz, çünkü her araç `.kobay` dizininin bakımını
yapabilir.

Her araç isteğe bağlı bir `projectDir` alır; bu, sunucunun başlatıldığı dizinin
içinde olmalıdır. Daha fazlasına izin vermek için sunucu sürecinin
`KOBAY_MCP_ROOTS` değişkenine, platformun yol ayracıyla (macOS ve Linux'ta `:`)
ayırarak yaz; listelenen her yol var olmalı, yoksa sunucu başlamaz; araç
argümanları bunu genişletemez.

**MCP üzerinden giriş.** `project_create` giriş kullanıcısını `loginUser` olarak
alır; parola ve gönderilebileceği origin (kaynak adres) yalnızca sunucunun
ortamından gelir, araç argümanlarından asla. Ajanı başlatan kabukta
`KOBAY_LOGIN_ORIGIN` (ör. `http://localhost:3000`) ve `KOBAY_LOGIN_PASS` dışa
aktar — biri eksikse ya da projenin `url`'si o origin'de değilse çağrı düşer.
Başka bir origin için kaydedilmiş giriş MCP üzerinden taşınamaz; bir terminalde
`kobay project create --url <URL> --login --force` çalıştır. Bu değişkenleri
çoğunlukla commit edilen `.mcp.json`'ın dışında tut.

</details>

## CI (GitHub Actions)

kobay, yerelde ürettiğin ve `.kobay/` altında commit ettiğin testleri her pull
request'te koşturabilir. CI'da beyin yoktur: testler hiçbir zaman LLM
çağırmayan `kobay test run --no-analysis` ile koşar; bu yüzden API anahtarı ya da
beyin CLI'ı gerekmez. Action sonucu üç yere yazar:

- iş akışı koşusunun **iş özeti** (job summary),
- sayı tablosu, test başına bir satır ve düşen, engellenen ya da sonuçsuz her test
  için kopyalanmaya hazır bir **Fix with your coding agent** istemi içeren tek bir
  **pull request yorumu** (yalnız maskeli metin, ekran görüntüsü yok); her
  push'ta aynı yorum güncellenir,
- **`kobay-report` artifact'i**: `.kobay/report` altındaki HTML rapor.

Önce testleri yerelde üret ve koştur (beyinle `kobay test run`), sonra `.kobay/`
klasörünü commit et (yönetilen `.gitignore` kimlik bilgilerini, koşuları, hata
paketlerini ve raporu git dışında tutar). Uygulamanı önceki bir adımda başlat;
Action onu bekler.

```yaml
name: kobay
on: pull_request

permissions:
  contents: read
  pull-requests: write   # only for the pull request comment

jobs:
  kobay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci
      - name: Start the app in the background
        run: npm run dev > app.log 2>&1 &
      - uses: ademtfkc/kobay@v0.4.0
        with:
          wait-for-url: http://localhost:3000
```

| Girdi | Varsayılan | Anlamı |
| --- | --- | --- |
| `version` | `0.4.0` | Kurulacak `@ademtfkc/kobay` sürümü: Action'ın birlikte geldiği sürüme sabitlenmiştir; npm'i izlemek için `latest` ver. Yerel bir `.tgz` yolu da olur. |
| `node-version` | `22` | `actions/setup-node` için Node.js. |
| `working-directory` | `.` | `.kobay/`'ı taşıyan proje kökü; `--cwd` olarak geçer. |
| `tests` | boş | Boşlukla ayrılmış test kimlikleri; boşsa `--all` koşar. |
| `wait-for-url` | boş | Uygulama herhangi bir HTTP durumuyla cevap verene kadar yoklanır; boşsa projenin `baseUrl`'i kullanılır. |
| `wait-timeout` | `120` | Beklenecek saniye; dolarsa adım `3` çıkış koduyla ("hedefe ulaşılamadı") düşer. |
| `install-browser-deps` | `true` | `kobay install-browser --with-deps` (Linux sistem kütüphaneleri). |
| `comment` | `true` | `pull_request` olaylarında tek bir yapışkan (sticky) yorum oluşturur ya da günceller. |
| `upload-report` | `true` | `.kobay/report`'u `kobay-report` artifact'i olarak yükler. |
| `max-prompts` | `5` | Yorumdaki düzeltme istemi sayısı; kalanlar tek satırda sayılır. |
| `github-token` | `${{ github.token }}` | Yalnız yorumu okumak ve yazmak için kullanılır. |

Çıktılar: `exit-code` (`test run`'ın), `report-dir`, `summary-path`.

**Geçti mi düştü mü.** Action'ın son adımı `kobay test run`'ın çıkış koduyla
biter: `0` hepsi geçti, `1` bir test düştü, `3` bir test engellendi (uygulamaya
ulaşılamadı ya da testin henüz üretilmiş kodu yok), `4` motor hatası. Rapor ve
yorum önce yazılır; kırmızı sonuçta da özet durur. `--no-analysis` ile düşen
testin hata türü `unknown` olur ve kanıt paketi yine yazılır; kök neden analizi
için testi yerelde beyinle koştur. Kodu olmayan ya da kodu üretildikten sonra
planı değişmiş bir taslak `blocked` olur ve `kobay test run <ID>`'yi yerelde
koşturup `.kobay/`'ı commit etmeni söyler; bu engellenmiş koşu kaydedilir, yani
rapor onu sayar ve istemi ne yapılacağını söyler. Action önce girdilerini
denetler (`wait-timeout` 1–3600 saniye, `wait-for-url` ve projenin base URL'i
`http(s)://` olmalı, test kimliklerinden başka bir şey olmamalı); uymazsa `2`
çıkış koduyla durur.

<details>
<summary><b>Özet dosyası, girişli uygulamalar, fork'lar ve artifact'ler</b></summary>

**Özet dosyası.** Yorum, `kobay test report <ids...|--all> --summary <path> [--max-prompts <n>]`
çıktısıdır (raporun kendisi gibi `--summary` de bir seçim ister: test kimlikleri
ya da `--all`): `<!-- kobay-report -->` ile başlayan (yorumu bulup güncellemenin
anahtarı) GitHub-flavored Markdown; 60.000 karakteri geçmez (önce hepsini
kapsayan düzeltme istemi, sonra sondan başlayarak tekil istemler düşer; tablo
kalır) ve yalnız metin içerir: her değer tek başına sır maskelemesinden geçer,
adreslerdeki kimlik bilgileri `[redacted]` olur, yerel yollar `[project]`,
`[kobay]` ve `~` olur, diğer mutlak dosya yolları (`/opt`, `/usr`, `/tmp`, `C:\` …
altında) `[path]/<dosya adı>` olur (`/records/new` gibi uygulama rotaları kalır;
`/opt/x` gibi sistem kökü adıyla başlayan uygulama rotaları da maskelenir), tablo
hücreleri kaçışlanır ve istemler, içlerindeki her backtick dizisinden daha uzun
bir çitle sarılır. `--summary` yolu `--out` ile aynı yol kurallarına uyar, ayrıca
`.kobay/` içini ya da rapor klasörünü gösteremez; reddedilen yol `2` ile çıkar.
HTML rapor yine yazılır.

**Giriş gerektiren uygulamalar.** Action kullanıcı adı ya da parola girdisi almaz
ve `.kobay/credentials.json` ile oturum dosyası asla commit edilmez. Bunlar
olmadan testler oturumsuz koşar. Oturum açmak için Action'dan önce, girişi iki
depo secret'ından kaydeden ve bir kez keşif yapan bir adım ekle (bu, oturum
dosyasını yalnız CI checkout'unda yazar):

```yaml
      - name: Sign kobay in
        run: |
          npx --yes @ademtfkc/kobay project create --force --url http://localhost:3000 --login --login-url http://localhost:3000/login
          npx --yes @ademtfkc/kobay install-browser --with-deps
          npx --yes @ademtfkc/kobay explore
        env:
          KOBAY_LOGIN_USER: ${{ secrets.KOBAY_LOGIN_USER }}
          KOBAY_LOGIN_PASS: ${{ secrets.KOBAY_LOGIN_PASS }}
```

`project create --force` yalnız config'i yeniden yazar (beyin ayarları korunur),
testlere ve koşulara dokunmaz; `explore` checkout'taki `map.json`'ı yeniler. Demo
uygulamayla doğrulandı: oturumsuz test düştü, bu üç komuttan sonra geçti.

</details>

**Fork'lar ve token'lar.** Fork'lardan gelen pull request'ler salt okunur token
alır: Action yorumu bir uyarıyla atlar ve iş özeti yine raporu taşır. Bunu aşmak
için `pull_request_target`'a geçme: o, fork'un kodunu deponun secret'larıyla
koşturur. Yapışkan yorum, `github-actions[bot]` tarafından yazılan ve işaretle
başlayan yorumdur; kendi `github-token`'ınla yorum o hesap altında yazılır ve her
koşuda yeni bir yorum eklenir.

**Artifact uyarısı.** HTML rapor maskelenmemiş ekran görüntüleri içerir; açık
(public) bir depoda iş akışı artifact'lerini GitHub'a giriş yapmış herkes
görebilir. Bu önemliyse `upload-report: false` ver.

## Neler elde edersin

**Düşen her test için bir hata paketi (failure bundle);** `kobay test failure get <id>`
ile `.kobay/failure-out/<id>/` altına kopyalanır:

```sh
ls .kobay/failure-out/t_v5hpedx1
#> code.ts  console.json  failure.json  meta.json  network.json  step-4.html  step-4.png  steps.json  trace.zip
```

`failure.json` analizi (`failureKind`, `rootCauseHypothesis`,
`recommendedFixTarget`, `evidence`), tam koşu sonucunu, adım listesini ve üretilen
kodu taşır. Her kanıt kaydı aynı klasördeki bir dosyayı işaret eder; `console.json`
ve `network.json` pakete yalnız analiz onlara atıf yaparsa girer. Trace'i
`npx playwright show-trace trace.zip` ile aç. Ayrıntılar
[Ayrıntılı hızlı başlangıç](#ayrıntılı-hızlı-başlangıç) bölümünde.

**Bir HTML rapor:** her testin son koşusu için; dikkat isteyen her testte bir
**Fix with your coding agent** istemiyle:

<p align="center">
  <img alt="A failed test card in the kobay HTML report: failure kind product_bug, the failure analysis, the recommended fix target, the evidence list and the start of the fix prompt" src="https://raw.githubusercontent.com/ademtfkc/kobay/main/assets/readme/report-failure.png" width="720">
  <br><sub>Hızlı başlangıçtaki boş isim testi: analiz, düzeltme hedefi ve düzeltme isteminin başı.</sub>
</p>

**HTML rapor.** `kobay test report --all`, her testin son koşusundan
`.kobay/report/index.html` yazar; bir tarayıcıda aç. Rapor bir özetle açılır
(koşu çubuğu, geçme oranı, toplam koşu süresi), düşen, engellenen ve sonuçsuz
testleri adımları, ekran görüntüleri ve hata analizleriyle en üste koyar, geçen
testleri kapalı tutar. Dikkat isteyen her test, Claude Code, Codex ya da Cursor'a
yapıştırılacak bir **Fix with your coding agent** istemi taşır: hata türünü
söyler, hata metnini ve analizi güvenilmez veri olarak alıntılar ve kanıtı almak,
düzeltmek ve doğrulamak için kobay komutlarını sıralar (`test failure get`,
`test rerun` ya da `product_changed` için `test refresh`). İki ya da daha çok
böyle test varsa rapor hepsini kapsayan tek bir istem de içerir. Alıntılanan her
değer isteme girmeden önce tek başına sır maskelemesinden geçer ve 2.000
karakterden uzun hata çıktısı kesilir, tam pakete bir yol gösterilir. Bir isteme
tıklayınca tamamı seçilir, sonra kopyalayabilirsin.
`--output json` aynı istemleri `fixPrompts` ve `fixAllPrompt` olarak döndürür.
Klasör kendi içinde bütündür (ekran görüntüleri içine kopyalanır), yani
taşıyabilir ya da CI artifact'i olarak yükleyebilirsin. Sayfada betik ve dış
kaynak yoktur; içindeki her metin sır maskelemesinden ve HTML kaçışından geçer;
proje kökü, kobay'ın kendi kurulumu (yığın izi satırları) ve ev dizinin
`[project]`, `[kobay]` ve `~` olarak görünür. **Ekran görüntüleri
maskelenmez:** uygulamanın ekranda ne gösterdiyse onu gösterirler, bu yüzden
raporu paylaşmadan önce onlara bak (`test report` bu uyarıyı basar, sayfa da
yalnız raporda ekran görüntüsü varsa gösterir).
`--out <dir>` ile rapor başka bir yere yazılır (proje dışı olabilir, nokta ile
başlayan yollar olamaz). Dolu bir klasör yalnızca bütünüyle bir kobay raporuysa
değiştirilir: geçerli bir `kobay-report.json`, `index.html` ve
`assets/<runId>/step-<n>.png` dışında hiçbir şey yok. Tek bir başka girdi
(`notes.txt`, `.DS_Store`) komutun `2` ile çıkmasına ve o girdiyi adıyla
söylemesine yol açar, hiçbir şeye dokunulmaz. Eski rapor dosya dosya kaldırılır,
özyinelemeli silmeyle asla; beklenmeyen her şey yerinde bırakılır ve yolu
basılır. Rapor `.kobay/tests`, `runs`, `failure` ve `config.json`'ı symlink ya da
sert bağ (hard link) izlemeden okur: bağlı veri dışarıda bırakılır. Koşu kaydı
okunamayan bir test bir notla `inconclusive` görünür; koşu klasörü silinmiş bir
test `not run` görünür.

## Durum ve sınırlar

**0.3.0.** Kullanılabilir ama henüz pürüzsüz değil. 0.3.0'da yeni olanlar:
düzeltme istemli [HTML rapor](#neler-elde-edersin), `test run --no-analysis` ile
[GitHub Action](#ci-github-actions) ve
[ayrı bir giriş sitesinde (SSO) giriş](#ayrı-giriş-sitesi-sso). Tam liste
[CHANGELOG.md](CHANGELOG.md) içinde.

Neyin denendiği, neyin denenmediği; kurmadan önce karar verebilesin diye:

| | |
| --- | --- |
| **Kime** | Claude Code (ya da Codex / Cursor) kullanan, yerel web uygulamasını ajana "çalışıyor" dedirtmek yerine gerçekten doğrulattırmak isteyen geliştiriciler. |
| **Uçtan uca doğrulandı** | `claude` CLI beyni, MCP üzerinden bir Claude Code ajanıyla: ajan bir ürün hatası buldu, kök nedene indi, düzeltti ve testi yeşil olarak yeniden koştu. [Hızlı başlangıç](#hızlı-başlangıç)'taki döngü ayrıca paketlenmiş bir derlemeden, paketteki demo uygulamaya karşı gerçek beyinle koşuldu: 16 öneri (3'ü düşürüldü), 4 test, 2'si geçti, 2'si düştü; biri `product_bug`, biri `test_bug` olarak sınıflandı (orada anlatıldığı gibi); 7 beyin çağrısı, yaklaşık 1,10 $. |
| **Gerçek CLI ile bir kez denendi** | `codex` beyni. 28 Eylül 2026'da paketteki demo uygulamada gerçek bir `codex exec` ile (Codex CLI 0.154.0, ChatGPT aboneliği) bir tur koşuldu: plan üretti, test kodu üretti, bir hatayı analiz etti; her beyin çağrısı ilk denemede şemaya uydu. Tek tur, uzun kullanım değil. |
| **Pratikte denenmedi** | `openrouter` beyni. Adaptör birim testli ama gerçek API ile hiç koşturulmadı. Doğrulanmamış say. |
| **Platform** | macOS'ta geliştirildi. Herkese açık depoda CI, tam katı (strict) test paketini ubuntu-latest, macos-latest ve windows-latest üzerinde Node 22 ve 24 ile, üçünde de bir paketleme duman testini ve Ubuntu'da GitHub Action'ın bir duman testini koşuyor. Windows fiziksel bir makinede doğrulanmadı; bkz. [Kurulum ve gereksinimler](#kurulum-ve-gereksinimler). |
| **Dil** | Makinenin okuduğu her şey İngilizce: CLI ve MCP mesajları, JSON alan adları, hata kodları, dosya adları, istemler. Beyin; test adlarını ve açıklamaları keşfettiği uygulamanın dilinde yazar — dolayısıyla İngilizce olmayan bir uygulamada test başlıkları da İngilizce olmaz; bu tasarım gereği. |
| **Kapsam** | Yalnız tarayıcı testleri. API testi, backend testi, panel yok. |

### Bilinen sınırlar

- **Uzun kullanım görmüş tek beyin `claude`.** `codex` bir canlı turu geçti
  (plan, kod üretimi, hata analizi); `openrouter` birim testli ama gerçek API ile
  hiç koşmadı.
- **Windows'un CI kapsamı var, fiziksel makine kapsamı yok.** Doğrulanmayanlar:
  öksüz süreç temizliği, açık dosyada rename `EPERM`, 8.3 ve UNC yolları ve
  `claude` CLI'ın Git Bash gereksinimi. Sorunları lütfen bildir.
- **Üretilen testler için kum havuzu (sandbox) yok.** Bkz. [Güvenlik modeli](#güvenlik-modeli).
- **HTML rapor yarış penceresi.** `test report` bir klasörü denetleyip sonra
  yeniden adlandırır ya da siler; aynı anda o klasörü değiştiren yerel bir süreç
  bu yarışı yine kazanabilir. Windows'ta junction'lar ve diğer yeniden ayrıştırma
  noktaları symlink denetimiyle yalnız kısmen kapsanır.
- **Yalnız tarayıcı testleri.** API ya da backend testi yok.
- **Hep görünmez (headless).** Görünür tarayıcı penceresi yok; onun yerine
  `trace.zip` kullan.
- **Yalnız basit giriş.** Kullanıcı adı/parola HTML formu. Ayrı bir kimlik
  sitesindeki form, yalnız origin'ini `--auth-origin` ile listelersen çalışır
  (bkz. [Ayrı giriş sitesi (SSO)](#ayrı-giriş-sitesi-sso)); OAuth onay ekranları,
  CAPTCHA ve 2FA ele alınmaz; uygulamanın kendi sitesindeki alt alanlar kimlik
  bilgisini alabilir. JavaScript ile yapılan bir giriş yalnız ağ koruması
  kapsamındadır, form-origin denetimi kapsamında değil.
- **Keşif tasarım gereği sığdır:** yalnız `<a href>` bağlantıları, form
  göndermek ya da düğmeye basmak yok, 40 sayfada durur.
- **Bazı komutlar metin kipinde hâlâ ham JSON basıyor:** `project get`,
  `test get`, `test result` ve `test plan generate`'in gövdesi.
- **Koşudan sonraki otomatik budama yalnız az önce koşan testi etkiler.**
  Hiç yeniden koşturmadığın testlerin koşuları, tüm `.kobay` depolamasını (bütün
  testlerin koşuları, beyin günlükleri ve eski sürümlerden kalanlar) süpüren
  `kobay prune`'u çalıştırana kadar diskte kalır.
- **kobay'ı SIGKILL ile öldürmek süreç ağacını geride bırakır.** SIGTERM/SIGINT'te
  kobay Playwright worker'ını ve Chromium'u sonlandırır; SIGKILL yakalanamaz.
- **`test delete` kanıt bırakır.** Test kaydını ve üretilen kodunu siler, ama
  `failure/<id>/`, `failure-out/<id>/` ve eski koşu klasörleri diskte kalır.

## Güvenlik modeli

kobay'ı önemli bir şeye yöneltmeden önce bunu oku. Kısaca:

- **Üretilen kod senin kullanıcın olarak, kum havuzu olmadan çalışır.** Test
  edilen bir sayfa hangi kodun yazılacağını yönlendirmeye çalışabilir (prompt
  injection); kobay'ın kod denetimi bir hız kesicidir, kum havuzu değildir ve
  tarayıcı çevrelenmemiştir.
- **Yalnız yerel ya da test ortamları.** kobay'ı asla canlıya ya da gerçek veriye
  yöneltme.
- **Kimlik bilgileri origin'e kilitlidir** ve uygulamanın sitesinde (artı
  listelediğin auth origin'lerde) kalır; onları başka yere göndermeye çalışan bir
  giriş reddedilir.
- **Trace'ler oturum çerezi taşır ve ekran görüntüleri maskelenmez.** Bir hata
  paketine ya da rapora parola gibi davran.
- **Dosya argümanları proje içinde kalır.**

Bir güvenlik açığını bildirmek için bkz. [SECURITY.md](SECURITY.md).

<details>
<summary><b>Güvenlik modelinin tam metni</b></summary>

- **Üretilen kod senin kullanıcın olarak** çalışır; senin dosya yetkilerinle yerel
  bir Node/Playwright sürecinde. LLM'in girdisi test edilen uygulamadan gelen
  metni içerir, bu yüzden bir sayfa hangi kodun yazılacağını yönlendirmeye
  çalışabilir (prompt injection).
- **Kod denetimi bir hız kesicidir, kum havuzu değil.** Kaydetmeden önce kobay
  şunları kullanan kodu reddeder: `process`, `globalThis`, `eval`, `Function`,
  `arguments[...]`, constructor zincirleri, Node yerleşikleri, `require` (başka
  adla olsa da), izin verilen ilk satırın ötesinde herhangi bir `import`/`export`
  ve metin ile yorumların dışında Unicode kaçışları ya da belirsiz bir `/`.
  (`module` ya da `fs` gibi adlar, testin kendi değişkenleri olarak sorun
  değildir.) Bu, JavaScript ayrıştırıcısı değil, elle yazılmış bir sözcüksel
  tarayıcıdır: **sert kaçışlar açık kalır** — örneğin birleştirilmiş
  metinlerden kurulan bir constructor zinciri — ve üretilen kod diskteki
  dosyaları, `.kobay/` altındakiler dahil, okuyabilir. Kum havuzu yoktur.
- **Tarayıcı çevrelenmemiştir.** Sayfadaki kod (`fetch` ile `page.evaluate`) ya da
  `page.request` veriyi herhangi bir yere gönderebilir; kobay bunu engellemez.
  kobay'ı yalnız güvendiğin uygulamalara ve modellere yönelt.
- **Test süreçleri süzülmüş bir ortam alır.** Kabuğunu devralmazlar. Bir izin
  listesi şunları geçirir: `PATH`, `HOME`, kullanıcı/kabuk/geçici dizin/terminal
  değişkenleri, yerel ayar ve saat dilimi (`LANG`, `LC_*`, `TZ`), `CI`, `DEBUG`,
  Linux ekran ve yazı tipi değişkenleri, `PLAYWRIGHT_*`, `PW_*` ve proxy ile
  sertifika ayarları (`HTTP(S)_PROXY`, `NO_PROXY`, `ALL_PROXY`,
  `NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`). Önek izniyle geçen ama sır gibi görünen
  adlar (`PLAYWRIGHT_SERVICE_ACCESS_TOKEN` ve benzerleri) ikinci bir süzgeçle
  düşürülür; kullanıcı adı ve parola taşıyan proxy URL'leri de öyle;
  `NODE_OPTIONS` listede değildir. Oturum bir storage-state dosyasıyla taşınır,
  yani parola test sürecine hiç ulaşmaz.
- **Yalnız yerel ya da test ortamları.** Üretilen testler tıklar, form gönderir,
  kayıt oluşturur ya da siler. kobay'ı asla canlıya ya da gerçek veriye yöneltme.
- **Kimlik bilgileri origin'e kilitlidir.** `.kobay/credentials.json` giriş
  kullanıcısını ve parolayı tek bir origin için düz metin olarak (0600 izin)
  saklar; `.kobay/storageState.json` oturum çerezlerini tutar (0600). İkisi de
  git dışıdır. Projeyi `project update --base-url` ya da `project create --force`
  ile başka bir origin'e taşımak ikisini de siler ve `invalidated` altında
  listeler. Kayıtlı origin uyuşmazsa `explore` ve `test refresh` tarayıcı
  açmadan `5` ile çıkar; düzeltmek için
  `kobay project create --url <URL> --login --force`. Kilit auth origin
  listesini de kapsar (bkz. [Ayrı giriş sitesi (SSO)](#ayrı-giriş-sitesi-sso)):
  `config.json`'daki `authOrigins` elle değiştirilirse, kayıtlı kimlik bilgileri
  tam listeyle yeniden girilene kadar kullanılmaz:
  `kobay project update --login --auth-origin <origin>` (ya da
  `--clear-auth-origins`).
- **Kimlik bilgileri uygulamanın sitesinde kalır.** Giriş URL'si base URL ile aynı
  origin'i paylaşmalıdır (ya da listelenmiş bir auth origin'de olmalıdır) ve
  giriş sayfası başka bir origin'e yönlendirirse ya da formun `action`'ı başka
  bir siteyi gösterirse kobay parolayı yazmadan durur (aşağıdaki aynı-site kuralı
  geçerlidir, yani `app.example.com` üzerindeki bir form `api.example.com`'a
  gönderebilir). *Giriş sırasında*
  (parola yazılmaya başladığı andan sayfa ilerleyip ağ durulana dek, en fazla
  2 sn), istekler kimlik bilgisini yalnız `baseUrl` origin'ine ya da kendi
  sitesine taşıyabilir: parolayı başka bir siteye taşıyan bir istek (`fetch`,
  XHR, `sendBeacon`, resim isteği) engellenir ve giriş reddedilir, siteler-arası
  yazmalar (POST, PUT ve benzerleri) engellenir ve siteler-arası WebSocket'ler
  bağlanmadan kapatılır; zaten açık olan bir siteler-arası WebSocket'e bu pencere
  boyunca (en fazla yaklaşık 7 sn) gönderilen mesajlar sessizce düşürülür.
  *Giriş sonrasında*, o `explore` ya da `test refresh` tarayıcısı kapanana kadar,
  yalnız parolayı açıkça taşıyan siteler-arası istekler ve WebSocket mesajları
  engellenir ve keşif reddedilir; uygulamanın kendi siteler-arası API çağrıları
  ve WebSocket'leri geçer. Aynı sitedeki alt alanlara izin verilir
  (`app.example.com` ve `api.example.com`, aynı şema); ayrı bir kimlik doğrulama
  sitesine (SSO) ise yalnız listelersen ve o zaman yalnız o tam origin'e izin
  verilir, aşağıya bak.
  `localhost`, IP adreslerinde ve tek etiketli ana makine adlarında port
  farklı olabilir ama ana makine adı eşleşmelidir: `localhost:5173`,
  `localhost:8080`'i çağırabilir; `localhost` ile `127.0.0.1` ise farklı
  sitelerdir. kobay kayıtlı alan adını Public Suffix List'i okumak yerine
  yaklaşık hesaplar (son iki etiket; `co.uk` ya da `github.io` gibi bilinen
  soneklerden sonra üç): yaygın barındırma platformlarının kiracıları
  (`github.io`, `vercel.app`, `a.run.app`, `up.railway.app` ve diğerleri) ayrı
  sitelerdir ve `amazonaws.com` ya da `cloudfront.net` altındaki her şey tam
  origin ister. Barındırma platformun listede yoksa bildir ki eklensin. Kimlik
  bilgileri yapılandırıldığında service worker'lar kapatılır. Sınırlar: 307/308
  yönlendirmesinde kobay girişi tespit eder ve reddeder, ama yönlendirilen
  isteğin kendisini engelleyemez, yani parola diğer sunucuya çoktan ulaşmış
  olabilir; bir Web Worker içinden açılan WebSocket kesilmez; kobay'ın tanımadığı
  biçimde kodlanmış bir parola yine de siteler-arası bir GET ile, giriş
  sonrasında ise herhangi bir siteler-arası istekle çıkabilir. Giriş bu
  nedenlerden biriyle reddedildiğinde `explore` ve `test refresh` `5` ile çıkar.
- **Trace'ler oturum çerezleri içerir.** `runs/`, `failure/` ve herhangi bir
  `failure-out/` kopyasındaki `trace.zip` tarayıcı oturumunu içerir. Bir pakete
  parola gibi davran — herkese açık issue'lara ekleme.
  `.kobay/failure-out/<id>/` git dışıdır; birini `--out` ile başka yere
  kopyalarsan o klasörü git dışı bırak. Metin kanıtları (`console.json`,
  `network.json`, `step-*.html`) pakete kopyalanırken sır maskelemesinden geçer,
  ama ekran görüntüleri ve `trace.zip` geçemez: ekranda ya da ağ izlerinde
  görünen sırları içerebilirler, bu yüzden paketin tamamını hassas say
  (`.kobay/failure-out/` git dışıdır).
- **HTML rapordaki ekran görüntüleri maskelenmez.** `test report` yazdığı her
  metni maskeler ve kaçışlar, ama adım ekran görüntülerini olduğu gibi kopyalar.
  Onlara bakmadan bir raporu yayımlama. `.kobay/report/` git dışıdır; raporu
  `--out` ile başka yere yazarsan o klasörü de git dışı bırak.
- **Yol sınırları.** Dosya argümanları (`--docs`, `--docs-path`, `--plan`; MCP'de
  `docs`, `docsPath`, `planPath`, `out`) proje içinde kalmalıdır; `..` ve symlink
  kaçışları reddedilir, `.kobay/` altındaki yollar ya da nokta ile başlayan
  herhangi bir bileşen (`.env`, `.git`, `.claude`) de — çıkış `2`. Kayıtlı docs
  yolu her plan üretiminde yeniden denetlenir. İki istisna: paket, zaten
  git dışı olan `.kobay/failure-out/` altına yazılabilir; ve **CLI**'da
  `test failure get --out` proje dışını gösterebilir, yine nokta-yol kuralına
  tabi. MCP üzerinden `out` proje kökünün içinde kalmalıdır, böylece bir ajan
  çerez taşıyan bir paketi proje ağacının dışına çıkaramaz.

</details>

### Ayrı giriş sitesi (SSO)

Giriş formu başka bir origin'deyse (`https://auth.example.com` gibi bir kimlik
sağlayıcı ya da başka bir yerel port), kimlik bilgilerini girerken tam olarak o
origin'i listele:

```sh
kobay project create --url https://app.example.com --login \
  --auth-origin https://auth.example.com
# later: replace the whole list, or empty it
kobay project update --login --auth-origin https://sso.example.org
kobay project update --login --clear-auth-origins
```

- Her öğe tam bir origin'dir (`https://auth.example.com`,
  `http://127.0.0.1:4010`): http ya da https; yol, sorgu, kullanıcı bilgisi ya da
  joker yok, en çok 5 öğe ve base URL'in kendi origin'i olmamalı (o zaten her
  zaman izinlidir). `--auth-origin` ve `--clear-auth-origins`, `--login` olmadan
  reddedilir: parolayı alabilecek sitelerin kümesi yalnız sen onu yazarken
  değişir. MCP araçları, plan dosyaları ve `test create` bunu ayarlayamaz.
- Liste `config.json`'da (`authOrigins`) ve kimlik kilidinde saklanır. İkisi
  farklıysa (örneğin `config.json` elle düzenlenince) kimlik bilgileri
  kullanılmaz ve `explore` `5` ile çıkar. Base URL'i başka bir origin'e
  değiştirmek listeyi düşürür. `--auth-origin` olmadan `project update --login`
  listeyi yalnız kayıtlı kimlik bilgileri tam olarak o listeyi daha önce
  onayladıysa korur; aksi hâlde hiçbir şeyi değiştirmez, `2` ile çıkar ve tam
  listeyi (`--auth-origin`) ya da `--clear-auth-origins`'i ister. `config.json`
  kendisi geçersizse `kobay project create --url <URL> --login --force` ile
  sıfırla.
- Parola, base URL'in origin'inde (yukarıdaki aynı-site kuralıyla kendi sitesiyle
  birlikte) ve listelenen origin'lerde yazılabilir ve oralara gönderilebilir —
  yalnız tam origin: `https://yourco.okta.com` listelemek `evilco.okta.com`,
  `login.yourco.okta.com` ya da `yourco.okta.com:444`'e izin vermez. Diğer her
  site eskisi gibi engellenir. Yukarıdaki 307/308 sınırı listelenen origin'ler
  için de geçerlidir.
- Keşif yine yalnız base URL'in origin'ini tarar; auth sitesine yalnız giriş için
  gidilir. Giriş, tarayıcı 10 sn içinde base URL'in origin'ine döndüğünde ve ağ
  durulduktan sonra hâlâ orada olduğunda tamamlanmış sayılır; aksi hâlde
  `explore` "Login did not return to the app origin" ile `5` çıkar. Bu, auth
  origin'li ya da onsuz her girişte geçerlidir.
- `.kobay/storageState.json` (0600) bu durumda auth sitesinin çerezlerini de tutar.

## Başvuru

### Kurulum ve gereksinimler

- **Node.js 22.12 veya üstü**; macOS, Linux ya da Windows.
- **Chromium**, `kobay install-browser` ile kurulur.
- **Bir beyin:** oturumu açık `claude` CLI (varsayılan ve denenmiş tek yol);
  ya da `codex` CLI; ya da bir `OPENROUTER_API_KEY` ortam değişkeni.
- **Test etmek istediğin uygulama**, kobay'ın erişebileceği bir adreste ayakta.

```sh
npm install -g @ademtfkc/kobay
kobay install-browser        # Linux: kobay install-browser --with-deps
kobay doctor
```

Kurmadan tek seferlik komut için `npx @ademtfkc/kobay <komut>` de çalışır —
örneğin `npx @ademtfkc/kobay doctor` — ama paketi her seferinde yeniden indirir;
kobay'ı birden çok kez kullanacaksan global kurulum daha değerli.

Kaynaktan kurulmuş (`npm link`) eski bir `kobay` komutu hâlâ PATH'inde duruyorsa
global kurulum `EEXIST` ile düşer; önce o bağlantıyı kaldır (örneğin eski klonda
`npm unlink -g kobay`).

**Kaynaktan**, geliştirme için ya da henüz yayınlanmamış bir değişikliği
çalıştırmak için:

```sh
git clone https://github.com/ademtfkc/kobay.git
cd kobay
npm install && npm run build
npm link                     # puts `kobay` on your PATH
kobay install-browser        # Linux: kobay install-browser --with-deps
kobay doctor
```

Doğrudan git'ten kurulum (`npm i -g github:ademtfkc/kobay`) alamadığı bir derleme
adımı gerektirir ve npm 11.19'da düşer (`tsc: command not found`) — onun yerine
yayınlanan paketi ya da yerel bir klonu kullan.

`install-browser`, kobay'ın kendi Playwright sürümüne uyan Chromium derlemesini
indirir — farklı bir revizyon çekebilen `npx playwright install` yerine bunu
kullan. Linux'ta `--with-deps` Chromium'un sistem kütüphanelerini de paket
yöneticin üzerinden kurar ve `sudo` isteyebilir.

#### Windows

Native Windows desteklenir. PowerShell ya da `cmd.exe` içinde kobay'ı ve ona uyan
Chromium'u aynı şekilde kur:

```powershell
npm install -g @ademtfkc/kobay
kobay install-browser
kobay doctor
```

Herkese açık depoda CI, tam katı (strict) test paketini `windows-latest` üzerinde
Node 22 ve 24 ile, ayrıca bir paketleme duman testini (pack, kurulum,
`install-browser`, demo `explore`) koşuyor. PATH/PATHEXT komut çözümü, `.cmd`
shim'leri, göreli Playwright spec'leri ve süreç ağacı sonlandırması bu kapsamda.
Henüz fiziksel bir Windows makinesinde doğrulamadık: öksüz süreç temizliği, açık
dosyada rename `EPERM`, 8.3 ve UNC yolları ile `claude` CLI'ın Git Bash
gereksinimi hâlâ o kapsamı bekliyor. Windows sorunlarını lütfen bildir.

`doctor` Node'u, beyin CLI'larını, Chromium'u, mevcut projeyi ve hedefin cevap
verip vermediğini denetler. Her zaman `0` ile çıkar, yani satırları oku. Bir
proje yokken son ikisi, beklendiği gibi, düşer:

```
✓ Node 26.8.1
✓ claude CLI
✓ codex CLI
✓ Chromium
✗ .kobay — create a project with `kobay project create --url <URL>`
✗ target — no project; run `kobay project create --url <URL>` first
```

Varsayılan beyni değiştirmek için (`~/.kobay/config.json`'a yazılır):

```sh
kobay setup --brain claude
#> Default brain set: claude
#> Config file: ~/.kobay/config.json
#> Chromium: installed
#> Next: kobay project create --url <URL>
```

`--brain codex` ve `--brain openrouter` de kabul edilir. Codex beyni
`codex exec --ignore-user-config --ephemeral` komutunu salt okunur bir kum
havuzunda çalıştırır, yani `~/.codex/config.toml`'un yok sayılır. Model
vermezsen Codex CLI kendi yerleşik varsayılanını çalıştırır; birini seçmek için
model ve düzeyi `--model` / `--effort` ile ya da proje veya genel kobay
ayarındaki `brain` bloğunda (`model`, `effort`) ver. Codex oturumu hâlâ
`CODEX_HOME`'dan gelir.

### Ayrıntılı hızlı başlangıç

[Hızlı başlangıç](#hızlı-başlangıç)'ın tamamı, her adımın arkasındaki kurallarla.

**Proje oluşturma.** `--login`, `KOBAY_LOGIN_USER` ve `KOBAY_LOGIN_PASS`'i okur;
yoksa sorar (parola ekrana yazılmaz), terminal de değişken de yoksa `2` ile çıkar
— cevapları stdin'e boru ile vermek desteklenmez. URL `http://` ya da `https://`
olmalıdır. Giriş URL'si, giriş ayrı bir auth sitesinde yapılmıyorsa `--url`'nin
origin'ini paylaşmalıdır (bkz. [Ayrı giriş sitesi (SSO)](#ayrı-giriş-sitesi-sso)).
Demo koşusunun tam çıktısı:

```sh
KOBAY_LOGIN_USER=demo KOBAY_LOGIN_PASS=demo123 \
  kobay project create --url http://127.0.0.1:3999 \
                       --login --login-url http://127.0.0.1:3999/login
#> Project created: ~/kobay-demo/.kobay
#> Target: http://127.0.0.1:3999
#> Brain: claude
#> Login page: http://127.0.0.1:3999/login
#> Credentials: saved
#> Next: kobay explore
```

**Keşif (explore)** — LLM çağrısı yok. kobay giriş yapar ve aynı origin'deki
`<a href>` bağlantılarını en fazla 40 sayfaya kadar izler; metni çıkış ya da
silme gibi görünen bağlantıları atlar ve form asla göndermez. Sonuç *harita*dır,
`.kobay/map.json`.

**Plan üretme** — **LLM çağrısı.** Beyin haritayı okur (`--docs` verdiysen bir
ürün belgesiyle birlikte) ve 8–25 akış ister; harita dışı adreslere işaret eden
öneriler düşürülür. Bir giriş yapılandırılmışsa, gerçek kimlik bilgilerini
(parola, gizli anahtar, PIN) yazan bir adımı olan öneriler de düşürülür; adımıyla
birlikte `dropped` altında listelenir; geçersiz ya da boş değer yazan adımlar
sorun değildir. Her öneri ayrıca `requiresRealCredentials` bildirir; `true`
öneriyi düşürür ve alan `false` dese de adım süzgeci gerçek kimlik yazan adımları
yine düşürür. Üretilen kod sessizce `test.skip` kullanamaz ve gerçek kimlik
gerektirecek bir adım yeniden yazılmak yerine hata fırlatır. Metin çıktısı özet
satırı artı `--output json`'ın döndürdüğü aynı JSON gövdesidir. Demo koşusunda iki
giriş önerisi gerçek kimlik bilgisi gerektirdikleri için, biri de haritanın
dışındaki bir adres yüzünden düşürüldü:

```json
"dropped": [
  { "title": "Login page renders correctly", "reason": "A step needs the real credentials, but the session is already authenticated via kobay's login step and generated tests cannot type credentials (step 3: \"Verify that a 'Password' field of type password is visible\")" },
  { "title": "Login with invalid credentials shows an error", "reason": "A step needs the real credentials, … (step 2: \"Type 'wrongpassword' into the 'Password' field\")" },
  { "title": "Unknown URL returns an error page", "reason": "URL is not in the map and no path pattern matched: /records/does-not-exist (pattern: /records/does-not-exist)" }
]
```

Birkaçını kabul et — hepsini değil, çünkü her test ilk koşusunda LLM çağrısına
mal olur. `kobay test list` her testin durumunu ve önceliğini gösterir:

```sh
kobay test list
#> t_6t11idff	draft	p0	Record list shows a monthly total
#> t_jqt9aypj	draft	p0	Create a new record and see it in the list
#> t_s7k7kkdn	draft	p1	Record List displays existing records with Delete buttons
#> t_v5hpedx1	draft	p1	Submit New Record form with empty name
```

**Kendi testin.** `test create --plan` elle yazılmış bir plan dosyası alır
(biçim [Komutlar](#komutlar) altında). Hızlı başlangıçtaki aylık toplam planı:

```json
{ "type": "frontend", "name": "Record list shows a monthly total",
  "url": "/records", "priority": "p0",
  "planSteps": [
    { "type": "action", "description": "Open the record list at /records" },
    { "type": "assertion", "description": "A 'Monthly total' row shows the sum of the record amounts" } ] }
```

**Koşturma.** Kodu olmayan bir test için önce Playwright kodu üretilir (LLM
çağrısı), sonra koşar; düşen test sonra analiz edilir (bir LLM çağrısı daha).
Test başına 120 sn. Çıkış kodu `1` bir testin düştüğü anlamına gelir; `test list`
bu durumda `draft` yerine karar değerlerini (`passed`, `failed`, …) gösterir.

**Hatayı okuma.** `--out` olmadan paket `.kobay/failure-out/<id>/` altına iner;
her çağrıda yerinde yenilenir, yani öncekinden hiçbir şey kalmaz. Kendi adını
verdiğin bir klasör önceden var olmamalıdır. `failure.json` analizi, tam koşu
sonucunu, adım listesini ve üretilen kodu taşır. Bir ajanın üzerinde iş yaptığı
kısım `failure`'dır; boş isim testi için:

```json
"failure": {
  "failureKind": "product_bug",
  "rootCauseHypothesis": "Submitting the New Record form with an empty Name was accepted by the application: the browser was redirected from /new to the Record List page, and the list now contains a fourth row with an empty Name cell and Amount 10. No validation message was shown and the user did not stay on /new, … the server-side form handler simply does not reject an empty name.",
  "recommendedFixTarget": {
    "kind": "code",
    "reference": "POST handler for the New Record form at http://127.0.0.1:3999/new (the 'Save' submission that creates a record and redirects to /records) — the 'Name' field is not validated as required",
    "rationale": "The record was persisted with an empty name instead of being rejected. Search the product code for the route that handles the /new form submission … and add a required/non-empty check for the Name field …"
  },
  "evidence": [
    { "kind": "snapshot",   "stepIndex": 4, "summary": "The current DOM is the Record List page …; The record table contains a new fourth row with an empty Name cell and Amount 10, proving the empty-name submission was saved. …", "path": "step-4.html" },
    { "kind": "console",    "stepIndex": 4, "summary": "No console errors were recorded.", "path": "console.json" },
    { "kind": "network",    "stepIndex": 4, "summary": "No network errors or 5xx responses were recorded, so the environment is healthy.", "path": "network.json" },
    { "kind": "screenshot", "stepIndex": 4, "summary": "screenshot of the failing step", "path": "step-4.png" }
  ]
}
```

Her kanıt kaydı aynı klasördeki bir dosyayı işaret eder (ekran görüntüsü için
`step-<adım>.png`, DOM için `step-<adım>.html`). `console.json` ve `network.json`
pakete yalnız analiz onlara atıf yaparsa girer. Trace'i
`npx playwright show-trace trace.zip` ile aç.

**Uygulamayı düzelt, sonra `kobay test rerun <id>`** — mevcut kodu yeniden
üretmeden tekrar koşturur.

### Komutlar

Aşağıdaki bayraklar 0.3.0'da `kobay --help` ve her alt komutun `--help` çıktısıyla
örtüşür.

| Komut | Ne yapar |
| --- | --- |
| `setup [--brain <b>] [--model <m>] [--effort <e>]` | Varsayılan beyni `~/.kobay/config.json`'a yazar (`claude`, `codex`, `openrouter`). |
| `install-browser [--with-deps]` | Uyan Chromium'u kurar; `--with-deps` Linux sistem kütüphanelerini ekler. |
| `demo [--port <port>]` | Paketteki demo uygulamayı başlatır. Varsayılan port 3000; `0` boş birini seçer. |
| `doctor` | Node'u, beyin CLI'larını, Chromium'u, projeyi ve hedefi denetler. Her zaman `0` ile çıkar. |
| `project create --url <url> [--docs <path>] [--login] [--login-url <url>] [--auth-origin <origin>]... [--force] [--brain <b>] [--model <m>] [--effort <e>]` | Burada `.kobay/` oluşturur. `--url` bir `http://` ya da `https://` adresi olmalıdır. `--force` var olan bir projenin yalnız config'ini yeniden yazar; yenilerini vermedikçe beynini ve limitlerini korur. `--auth-origin` `--login` ister. |
| `project update [--base-url <url>] [--login-url <url>] [--docs-path <path>] [--login [--auth-origin <origin>]... \| [--clear-auth-origins]] [--brain <b>] [--model <m>] [--effort <e>]` | Yalnız verdiğin alanları değiştirir; `--base-url` ve `--login-url` `http://` ya da `https://` olmalıdır. `--login` kimlik bilgilerini yeniden girer; `--auth-origin` auth origin listesinin tamamını değiştirir ve `--clear-auth-origins` gibi `--login` ister. |
| `project get` | Ayarlar, test sayısı, bir harita olup olmadığı. |
| `explore` | Uygulamayı keşfeder ve `.kobay/map.json`'ı yeniden yazar. |
| `test plan generate [--hint <text>]` | Haritadan ve belgelerden test önerir. `--hint` serbest metindir, ör. "invoice flow only". |
| `test plan accept [--all] [--ids <id,id>]` | Önerileri taslak teste çevirir. |
| `test create --plan <path>` | Elle yazılmış bir plan dosyasından test oluşturur (aşağıda). |
| `test list` | Testler, durum ve öncelikle. |
| `test get <id>` | Tek bir testin kaydı ve plan adımları. |
| `test code get <id>` | Üretilen Playwright kodunu basar. |
| `test delete <id>` | Bir test kaydını ve üretilen kodunu siler. |
| `test run [ids...] [--all] [--rerun] [--no-analysis]` | Eksik kodu üretir, sonra koşturur. `--rerun` üretimi atlar. `--no-analysis` (CI için) beyni hiç çağırmaz: yalnız var olan kodu koşturur, kodsuz bir test (ya da taslak) `blocked` olur (çıkış `3`) ve bir hata, `unknown` hata türlü bir paket alır. |
| `test rerun <id>` | Var olan kodu yeniden üretmeden koşturur. |
| `test refresh <id> [--no-run]` | `product_changed` için: yeniden keşfet, planı uyarla, yeniden üret ve koştur. |
| `test result <id> [--history]` | Son koşu sonucu, ya da hâlâ diskte olan her koşu. |
| `test failure get <id> [--out <dir>]` | Hata paketini kopyalar. Varsayılan `.kobay/failure-out/<id>/`, yerinde yenilenir. |
| `test report [ids...] [--all] [--out <dir>] [--summary <path>] [--max-prompts <n>]` | Seçilen her testin son koşusunun (adımlar, ekran görüntüleri, hata, hata analizi, üretilen kod) statik bir HTML raporunu yazar. Yalnız diskte olanı okur; hiçbir şey koşturmaz. Varsayılan `.kobay/report/`, her seferinde bütünüyle değiştirilir. Testler düşmüş olsa da `0` ile çıkar. `--summary` ayrıca bir pull request yorumu için Markdown özet yazar (yalnız metin, en çok `--max-prompts` düzeltme istemi, varsayılan 5). |
| `prune [--dry-run] [--max-mb <mb>] [--older-than-days <days>]` | Eski koşuları, beyin günlüklerini, bayat hata paketlerini ve eski sürümlerden kalan bilinen artıkları kaldırır. Bilinmeyen `failure-out/` dosyaları atlanır. Son düşen koşuyu ya da güncel bir hata paketini asla kaldırmaz. CLI varsayılan olarak siler; `--dry-run` yalnız önizler. `--max-mb` `runs/` için tavandır (varsayılan 500), `--older-than-days` yaş eşiğidir (varsayılan 7). |
| `agent install --target <claude\|codex\|cursor>` | Ajan becerisini buraya kurar; `claude` için ayrıca MCP sunucusunu `.mcp.json`'a kaydeder. |
| `mcp` | stdio MCP sunucusunu başlatır. |


`prune --dry-run` bir özet basar (demo projesinde gerçek bir koşudan örnek):

```sh
kobay prune --dry-run
#> Prune preview: would remove 7 items and would reclaim 0.05 MB.
#> Run storage after prune: 0.92 MB / 500.00 MB.
```

`--output json` ile aynı koşu `dryRun`, `estimate`, `policy`, `deleted`,
`wouldDelete` (her biri `path`, `kind`, `bytes`, `reason` ile), `skipped` (her
biri `path` ve `reason` ile), `reclaimedBytes` ve `wouldReclaimBytes` döndürür.
Dry-run rakamları `estimate: true` taşır; silme koşu depolamasını yeniden ölçer.
MCP üzerinden `prune` aracı `projectDir`, `confirm`, `dryRun`, `maxMb` ve
`olderThanDays` alır: varsayılan olarak önizler, yalnız `confirm: true` ile siler
ve `dryRun: true` her durumda önizlemeyi zorlar.

Genel seçenekler: `--cwd <dir>`, `--output <text|json>` (varsayılan `text`; başka bir değer `2` ile çıkar), `-V/--version`, `-h/--help`.

`test create --plan` için elle yazılmış plan dosyası
([`schemas/plan.schema.json`](schemas/plan.schema.json)) `type` (`frontend`
olmalı) ve `name` ister; isteğe bağlı olarak `url` (testin sayfası: `/records`
gibi bir yol ya da projenin `baseUrl` origin'indeki bir adres), `description`,
`priority` (`p0`–`p3`, varsayılan `p1`) ve `projectId` (serbest bir etiket,
saklanmaz) alır ve her biri `description` taşıyan `action` ya da `assertion`
türünde 1–200 `planSteps` içerir:

```json
{ "type": "frontend", "name": "Record list shows a monthly total",
  "url": "/records", "priority": "p0",
  "planSteps": [
    { "type": "action", "description": "Open the record list at /records" },
    { "type": "assertion", "description": "A 'Monthly total' row shows the sum of the record amounts" } ] }
```

Başka bir origin'deki `url` `2` çıkış koduyla reddedilir. `url`, `baseUrl`'e göre
çözülür ve bu normalleştirilmiş biçimiyle saklanır. Kayıtlı kimlik bilgisi olan
bir projede, adımları gerçek parolayı ya da başka bir sırrı yazan plan `2`
çıkış koduyla reddedilir; kobay'ın kendi giriş adımı testi zaten oturumlu açar.
`url` yoksa hata analizi harita karşılaştırmasını atlar ve bunu söyleyen bir
uyarı basar (`Test has no URL (<id>); map comparison skipped.`).

### Çıktı, çıkış kodları ve hata türleri

**Metin çıktısı** (varsayılan) kısa, insan okuyacak bir özettir — kimlikler,
yollar, sayılar ve çalıştırılacak sonraki komut. Ayrıştırma. Her komut ayrıca
`--output json` kabul eder ve o zaman tek bir zarf basar:

```
{"ok":true,"exitCode":0,"data":[{"id":"t_6a12wnx1","name":"Record list shows saved records","verdict":"passed","runId":"r_20260923144622_dju9"}]}
{"ok":false,"exitCode":2,"error":{"code":"InvalidId","message":"Invalid testId: t_yok"}}
```

Komut beyni çağırdıysa zarfta ayrıca `"brain":{"calls":7,"costUsd":1.1}` olur (sağlayıcı
maliyet bildirmiyorsa, Codex'teki gibi, `costUsd` `null`'dır); metin çıktısı stderr'de
`Brain: 7 calls, $1.10` satırıyla biter.

Bir boru sonrasında `$?` yerine JSON'daki `ok` ve `exitCode`'u oku —
`kobay ... | jq`, kobay'ın değil `jq`'nun çıkış kodunu bildirir.

**Çıkış kodları:** `0` geçti · `1` bir test düştü · `2` kullanım hatası · `3` hedefe
ulaşılamadı · `4` beyin ya da motor hatası · `5` giriş ya da yetki sorunu. Birden
çok testte `test run` en yüksek kodla çıkar. Çıkış `5`, sayfa kimlik bilgilerini
başka bir origin'e göndermeye çalıştığı için kobay'ın reddettiği girişi de
kapsar.

**Hata kodları** (`error.code`): `UsageError`, `PermissionError`,
`TargetUnreachableError`, `InvalidId`, `FileNotFound`, `SchemaError`,
`BundleIncomplete`, `UnsafeOutputPath`, `CredentialsTxnCorrupt`,
`CredentialsTxnInProgress`, `CredentialsRollbackFailed`, `McpRegistryUnreadable`,
`BrainError`, `BrainRuntimeError`, `CredentialOriginError`,
`FixtureModuleMissing`, `InputClosedError`, `UnknownError`. Bir `BrainError`
nedenini mesajında taşır: `timeout`, `cli_missing`, `schema`,
`empty_response`, `network`, `key_missing`, `cli_error`, `call_cap`, `cost_cap`,
`cost_unknown`, `config_error`.

**Karar değerleri (verdict):** `passed` · `failed` (bir adım beklediğini bulamadı;
bir paket var) · `blocked` (uygulamaya ulaşılamadı) · `inconclusive` (henüz kod
yok, ya da bir beyin veya motor hatası). Playwright testi hiç çalıştıramazsa —
bir rapor hatası ya da sıfır test koşması — sonuç `failureKind: env` ve çıkış
kodu `4` ile `inconclusive` olur. Asla `passed` değil.

**Hata türleri**, düşen bir testin paketinde:

| `failureKind` | Anlamı | Ne yapılır |
| --- | --- | --- |
| `product_bug` | Uygulama bozuk. | Uygulamayı düzelt, sonra `kobay test rerun <id>`. |
| `product_changed` | Uygulama bilerek değişti; harita eskidi. | Uygulamaya dokunma: `kobay test refresh <id>`. |
| `test_bug` | Test kodu ya da bir seçici yanlış. | `kobay test code get <id>`, testi düzelt. |
| `env` | Hedef, bağımlılık ya da erişim çökük. | Ortamı ayağa kaldır, sonra yeniden koştur. |
| `flaky` | Koşudan koşuya değişiyor. | Kanıtı oku; bekleme ve yarış durumlarına bak. |
| `unknown` | kobay sınıflandıramadı. | Kanıtı kendin oku. |

Üretilen kodun fırlattığı bir `kobay:` hatası desteklenmeyen bir plan adımını
(örneğin gerçek kimlik bilgisi gerektiren bir adım) işaretler; beyne sorulmadan
`test_bug` olarak raporlanır.

`failure.recommendedFixTarget.kind` şunlardan biridir: `code`, `selector`, `data`,
`env`, `unknown`; yanında bir `reference` ve bir `rationale` bulunur.

### Maliyet ve veri

Her beyin çağrısı para ya da abonelik kotasına mal olur. kobay bunu süreç başına
sınırlar:

| Limit | Varsayılan | Ortam değişkeni | `.kobay/config.json` (`brain` altında) |
| --- | --- | --- | --- |
| `claude` çağrısı başına (`--max-budget-usd` olarak gönderilir) | $1 | `KOBAY_MAX_BUDGET_USD` | `maxBudgetUsd` |
| Süreç başına beyin çağrısı | 100 | `KOBAY_MAX_BRAIN_CALLS` | `maxCalls` |
| Süreç başına toplam maliyet | $5 | `KOBAY_MAX_TOTAL_COST_USD` | `maxTotalCostUsd` |
| OpenRouter yanıt token'ı | 4096 | `KOBAY_OPENROUTER_MAX_TOKENS` | `maxTokens` |

Ortam değişkenleri config dosyasını ezer. Her sürecin tek bir harcama sayacı
vardır; farklı limitler görürse (örneğin tek bir MCP sunucusunda iki proje) her
birinin en katı değeri geçerli olur ve sayaç sıfırlanmaz. Bir limiti yükseltmek
yalnız yeni bir süreçte etkili olur — kobay'ı ya da MCP sunucusunu yeniden başlat.
Bir limite takılındığında kobay, ajana ayarı kendisi değiştirmek yerine senden
onay istemesini söyler.

Başlayıp sonra zaman aşımına uğrayan ya da hata veren bir çağrı iade **edilmez**,
çünkü sağlayıcı onu çoktan faturalamış olabilir; varsa bildirilen gerçek maliyet
sayılır, yoksa ayrılan miktarın tamamı. Tavan yalnız sağlayıcının bildirdiği
maliyeti sayabilir — `claude` bildirir, `codex` bildirmez; yani Codex için yalnız
çağrı limiti geçerlidir. OpenRouter varsayılanı `google/gemini-3.8-flash`'tır:
kobay modelin fiyatını getirir, en kötü durumu ayırır ve `provider.max_price`
gönderir; fiyat belirlenemezse hiç çağrı yapmaz. `ANTHROPIC_API_KEY`
tanımlıysa `claude -p` aboneliğin yerine API hesabından faturalayabilir; kobay
bir kez uyarır. `OPENAI_API_KEY` ya da `CODEX_API_KEY` tanımlıysa `codex exec`
ChatGPT aboneliğin yerine API hesabından faturalayabilir; kobay bir kez uyarır.
Ve `test run --all` kodu olmayan her test için kod üretir ve her hatayı analiz
eder — önce birkaç öneri kabul et.

**Makinenden ne çıkar.** Tarayıcı, uygulama ve test koşuları yerelde kalır. Şunlar
seçtiğin beyne gider (`claude` ile Anthropic, `codex` ile OpenAI, ya da OpenRouter
ve onun yönlendirdiği her yer):

| Adım | LLM'e gönderilen |
| --- | --- |
| `test plan generate` | Harita: sayfa adresleri, başlıklar, alt başlıklar, bağlantı/düğme/menü etiketleri, form alanı adları ve etiketleri. `--docs` dosyan, ilk 20.000 karakter. `--hint`'in. |
| `test run` (kod üretimi) | Testin plan adımları ve harita. |
| `test run` (hata analizi) | Hata mesajı, düşen adımın temizlenmiş DOM'u, en fazla 20 konsol hatası, en fazla 20 başarısız ağ isteği, test kodu ve plan adımları. Ekran görüntüleri gönderilmez. |
| `test refresh` | Testin sayfasının eski ve yeni özeti, harita farkı ve plan adımları. |

Hata analizinden önce ve `.kobay/logs/` altına herhangi bir şey yazılmadan önce
kobay, gizli ortam değişkenlerinin (`*_API_KEY`, `*_TOKEN`, `*_SECRET`,
`KOBAY_LOGIN_PASS`) değerlerini, `sk-…` ve `ghp_…` gibi sağlayıcı token
biçimlerini ve sır gibi görünen değerleri — parola ve token JSON alanları,
`Bearer`/`Basic` başlıkları, sır gibi görünen URL parametreleri, `key=value`
çiftleri — `[redacted]` olarak maskeler. Ortam değişkenlerinin ötesinde bu bir
kalıp eşlemesidir, yani bazılarını kaçıracaktır. **Planlama sırasında gönderilen
harita ve belgeler maskelenmez.** kobay'ı gerçek müşteri verisi gösteren
sayfalara yöneltme.

kobay kayıtlı parolayı hiçbir zaman isteme koymaz; Playwright onu giriş formuna
yerelde yazar. Her çağrının tam istemi ve ham yanıtı, aynı maskeleme uygulanarak
`.kobay/logs/` altına yazılır (git dışı).

### `.kobay/` dizini

Projenin bütün durumu uygulamanın kökündeki `.kobay/` altında yaşar:

| Yol | İçerik |
| --- | --- |
| `config.json` | Base URL, giriş URL'si, docs yolu, beyin ayarları ve limitler (`brain` altında). |
| `credentials.json` | Giriş `username` ve `password`, 0600 izin, git dışı. |
| `storageState.json` | Playwright oturum durumu, 0600 izin, git dışı. |
| `map.json` | Harita: `title`, `headings`, `links`, `forms`, `buttons`, `menu` içeren `pages`. |
| `plan/proposals.json` | Beynin önerileri. |
| `tests/` | Test kayıtları (`t_*.json`), üretilen kod (`t_*.spec.ts`), `_fixture.ts`. |
| `runs/r_*/` | Koşu başına bir klasör: `result.json`, adım `.png`/`.html`, `console.json`, `network.json`, `trace.zip`. |
| `failure/<testId>/` | Test başına son hata paketi, atomik yazılır. |
| `failure-out/<testId>/` | `test failure get`'in varsayılan hedefi, yerinde yenilenir (git dışı). |
| `report/` | `test report`'un son HTML raporu: `index.html`, `kobay-report.json` ve `assets/<runId>/step-<n>.png` (git dışı). |
| `logs/` | Beyin çağrı günlükleri. |
| `playwright.config.ts` | Üretilen çalıştırıcı config'i. Elle düzenlersen kobay bir uyarıyla ona dokunmaz. |
| `.credentials-txn` | Süren bir kimlik bilgisi değişikliğinin işareti; `.stale-*` kenara alınan kopyaları tutar. İkisi de git dışı. |

`.kobay/tests/_fixture.ts` her koşudan önce etkin kobay kurulumunu gösterecek
şekilde yeniden yazılır; elle düzenleme.

**0.1 projesini yükseltmek.** İlk 0.2 komutu `harita.json`'u `map.json`,
`plan/onerileri.json`'u `plan/proposals.json` olarak yeniden adlandırır ve
`config.json`, `credentials.json`, `map.json` ile `plan/proposals.json`'u
İngilizce alan adlarıyla yeniden yazar (`credentials.json` 0600 kalır). Koşulacak
komut yok, bayrak yok. Var olan bir `map.json` eski bir 0.1 dosyasıyla asla
ezilmez ve `.kobay` hiç yazılamıyorsa kobay dosya başına bir uyarı basar ve eski
adları okumayı sürdürür. Yarım kalmış bir 0.1 kimlik bilgisi işlemi yine
tanınır ve geri alınır; bu uyumluluk penceresi sürdüğü sürece bir 0.2 işlemi iki
işaret adını da taşır (`.credentials-txn` ve 0.1'in `.kimlik-islemi`'si), böylece
eski bir komut yarışmak yerine engellenir. Geçiş tek yönlüdür: 0.1, 0.2 projesini
okuyamaz. **`kobay agent install` komutunu yeniden çalıştır** ki kurulu beceri
ajanına yeni alan adlarını öğretsin.

**Koşu budama.** `.kobay/runs/`, bir koşu tamamen ele alındığında budanır — düşen
bir koşu için paketi yazıldıktan sonra — böylece analiz, analiz ettiği kanıtı
asla kaybetmez. Test başına kobay son 5 koşuyu, yayımlanan paketin işaret ettiği
koşuyu, az önce biten koşuyu ve son 10 dakikada biten her şeyi tutar.
`result.json`'ı olmayan bir koşu klasörüne dokunulmaz, bu yüzden
`test result --history` en fazla diskte hâlâ olanı listeler.

**Git.** kobay `.kobay/.gitignore`'u `# >>> kobay managed >>>` ile
`# <<< kobay managed <<<` arasında yönetir; bu bloğun dışına eklediğin satırlar
korunur. Yönetilen blok şudur:

```
credentials.json
runs/
storageState.json
.stale-*
.eski-*
.credentials-txn*
.kimlik-islemi*
*.log
failure/
failure-out/
logs/
tests/_fixture.ts
test-results/
playwright-report/
blob-report/
report/
.kobay-report-*
```

`.kobay-report-*`, `test report`'un değiştirmeden önce raporun yanına yazdığı
geçici klasördür. `.eski-*` ve `.kimlik-islemi*` 0.1 yazımlarıdır; eski bir
sürümden kalan artık git dışında kalsın diye hâlâ listelenir. Gerisini —
config, harita, testler — ekibinle paylaşmak için commit et. Blok her kobay
komutunda yeniden senkronlanır, yani eski projeler yeni kuralları kendiliğinden
alır; salt okunur bir dosya sisteminde kobay düşmek yerine uyarır. Bu klasörler
git dışı olduğundan taze bir klon ya da CI checkout'u `runs/`, `failure/`,
`failure-out/` ve `logs/` olmadan gelir; kobay onları her komutta yeniden oluşturur.

## Yol haritası

1. **OpenRouter beyninin canlı denemesi**, gerçek bir uygulamayla; ve Codex'in
   daha uzun kullanımı.
2. **`test delete` sonrası temizlik.**
3. **JavaScript ile yapılan girişler**, düz HTML formunun ötesinde.

Değişiklikler [CHANGELOG.md](CHANGELOG.md) içinde kayıtlıdır.

## Katkı

Issue'lar ve pull request'ler
[github.com/ademtfkc/kobay](https://github.com/ademtfkc/kobay) adresinde
memnuniyetle karşılanır. Geliştirme komutları, pull request öncesi çalıştırılacak
denetimler ve kod kuralları [CONTRIBUTING.md](CONTRIBUTING.md) içinde (İngilizce).
Güvenlik bildirimleri [SECURITY.md](SECURITY.md) üzerinden gider.

## Lisans

Apache-2.0. Bkz. [LICENSE](LICENSE).
