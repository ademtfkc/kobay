# kobay

[English](README.md) · [CHANGELOG](CHANGELOG.md) · Apache-2.0

Esas belge İngilizce [README.md](README.md); bu dosya onun kısa Türkçe
karşılığıdır. Komut tablosunun tamamı, `.kobay/` dizininin dosya dökümü,
güvenlik modelinin tam metni ve maliyet tavanlarının ayrıntısı orada.

**kobay, kodlama ajanları için yerel bir uçtan uca test motorudur.** Kendi
makinende çalışan bir web uygulamasını görünmez (headless) Chromium ile gezer,
bir LLM'e kullanıcı akışları önerttirir, kabul ettiklerini Playwright testine
çevirir, koşturur ve bir test düştüğünde ajanın üzerine iş yapabileceği bir
kanıt paketi verir: kök neden tahmini, `failureKind` sınıfı, önerilen düzeltme
hedefi, düşen adımın ekran görüntüsü ve DOM'u, Playwright trace'i.

Asıl mesele son kısım: `product_bug` yerine `product_changed` diyen bir paket,
ajanın hiç bozulmamış bir uygulamayı "düzeltmesini" engeller.

kobay hesabı, bulut servisi ya da tünel yok; tarayıcı, uygulama ve koşular
makinende kalır. LLM'e "beyin" diyoruz, varsayılanı senin `claude` CLI'ın — yani
kobay'ın kendi API anahtarı yok. Beyne ulaşmak için bir miktar veri makinenden
çıkar; bkz. [Maliyet ve veri](#maliyet-ve-veri). **kobay'ı yalnız güvendiğin
yerel ya da test ortamına yönelt:** üretilen testler düğmelere basar, form
gönderir, kayıt oluşturur.

## Durum

**0.2.1.** Kullanılabilir ama pürüzsüz değil. Kurmadan önce neyin
denendiğini, neyin denenmediğini bil:

| | |
| --- | --- |
| **Kime** | Claude Code (ya da Codex / Cursor) kullanan, yerel web uygulamasını ajana "çalışıyor" dedirtmek yerine gerçekten doğrulattırmak isteyen geliştiriciler. |
| **Uçtan uca doğrulandı** | `claude` CLI beyni + MCP üzerinden Claude Code ajanı: ajan ürün hatasını buldu, kök nedene indi, düzeltti, testi yeşile çevirdi. 0.2'de aynı döngü paketteki demo uygulamada gerçek beyinle tekrarlandı: 14 öneri, kabul edilen 3 testin 3'ü geçti, kasıtlı ürün hatası `product_bug` sınıflandı, tur $0.28 tuttu. |
| **Gerçek CLI ile bir kez denendi** | `codex` beyni. 28 Eylül 2026'da paketteki demo uygulamada gerçek `codex exec` ile (Codex CLI 0.154.0, ChatGPT aboneliği) bir tur koşuldu: plan üretti, test kodu üretti, bir hatayı analiz etti; her beyin çağrısı ilk denemede şemaya uydu. Tek tur, uzun kullanım değil. |
| **Pratikte denenmedi** | `openrouter` beyni. Adaptör birim testli ama gerçek API ile hiç koşturulmadı. Doğrulanmamış say. |
| **Platform** | macOS'ta geliştirildi. 0.2.1'den itibaren CI, ubuntu-latest, macos-latest ve windows-latest üzerinde Node 22 ve 24 ile tam test paketini doğruluyor; Windows matrisi 415 testi yeşil koşuyor. Paketleme duman testi macOS ve Linux'ta koşuyor. |
| **Dil** | Makinenin okuduğu her şey İngilizce: CLI ve MCP mesajları, JSON alan adları, hata kodları, dosya adları, istemler. Beyin; test adlarını ve açıklamaları keşfettiği uygulamanın dilinde yazar — Türkçe bir uygulamada başlıklar Türkçe gelir, bu tasarım gereği. |
| **Kapsam** | Yalnız tarayıcı testleri. API testi, backend testi, panel yok. |

**0.2.0 kırıcı bir sürümdü.** Bütün JSON alan adları, hata kodları ve `.kobay`
dosya adları Türkçeden İngilizceye geçti; tam tablo [CHANGELOG.md](CHANGELOG.md)
içinde. 0.1 projesi ilk 0.2 komutunda kendiliğinden göç eder, ama kurulu ajan
becerisi etmez: **her projede `kobay agent install` komutunu yeniden çalıştır**
ki ajan yeni alan adlarını öğrensin. Sonrasında 0.1, 0.2 projesini okuyamaz.

Panelli, destek sözleşmeli barındırılan bir ürün istiyorsan kobay o değil;
[TestSprite](https://www.testsprite.com/) benzer bir keşif → plan → üretim →
koşu → analiz döngüsünü servis olarak sunuyor. kobay aynı fikrin yerel, daha dar
ve kendi LLM'ini getirdiğin hâli.

## Gereksinimler

- **Node.js 22.12 veya üstü**; macOS, Linux ya da Windows (0.2.1'den itibaren).
- **Chromium**, `kobay install-browser` ile kurulur.
- **Bir beyin:** oturumu açık `claude` CLI (varsayılan ve tek denenmiş yol),
  `codex` CLI ya da `OPENROUTER_API_KEY` ortam değişkeni.
- **Test edilecek uygulama**, kobay'ın erişebileceği bir adreste ayakta.

## Kurulum

```sh
npm install -g @ademtfkc/kobay
kobay install-browser        # Linux: kobay install-browser --with-deps
kobay doctor
```

Kurmadan tek seferlik komut için `npx @ademtfkc/kobay <komut>` de çalışır (ör.
`npx @ademtfkc/kobay doctor`), ama paketi her seferinde yeniden indirir; birden
çok kez kullanacaksan global kurulum daha pratik.

Eskiden kapsamsız `kobay` paketini global kurduysan önce `npm uninstall -g kobay` çalıştır; yoksa kurulum `EEXIST` hatasıyla düşer.

**Kaynaktan** (geliştirme ya da henüz yayınlanmamış bir değişiklik için):

```sh
git clone https://github.com/ademtfkc/kobay.git
cd kobay && npm install && npm run build
npm link                     # `kobay` komutunu PATH'e koyar
kobay install-browser        # Linux: kobay install-browser --with-deps
kobay doctor
```

Doğrudan git'ten global kurulum (`npm i -g github:ademtfkc/kobay`) bir derleme
adımı gerektirir ve npm 11.19'da düşer (`tsc: command not found`); yayınlanan
paketi ya da yerel klonu kullan.

`install-browser`, kobay'ın kendi Playwright sürümüne uyan Chromium'u indirir
(`npx playwright install` farklı revizyon çekebilir); Linux'ta `--with-deps`
sistem kütüphanelerini de kurar. `doctor` Node'u, beyin CLI'larını, Chromium'u,
projeyi ve hedefi denetler; her zaman `0` ile çıkar, satırları oku.

### Windows (0.2.1'den itibaren)

Native Windows desteği var. PowerShell ya da `cmd.exe` içinde kobay'ı ve ona
uyan Chromium'u aynı şekilde kur:

```powershell
npm install -g @ademtfkc/kobay
kobay install-browser
kobay doctor
```

CI bu yolu Node 22 ve 24 ile `windows-latest` üzerinde doğruluyor (415 test
yeşil). PATH/PATHEXT komut çözümü, `.cmd` shim'leri, göreli Playwright spec'leri
ve süreç ağacı sonlandırması bu kapsamda. Henüz gerçek bir Windows makinesinde
doğrulanmayanlar: öksüz süreç temizliği, açık dosyada rename `EPERM`, 8.3 ve UNC
yolları ile `claude` CLI'ın Git Bash gereksinimi. Windows sorunlarını lütfen
bildir. Test matrisine ek olarak CI, `windows-latest` üzerinde bir duman işi de
koşuyor (pack, kurulum, `install-browser`, demo `explore`).

Varsayılan beyni değiştirmek: `kobay setup --brain claude` (ya da `codex`,
`openrouter`), `~/.kobay/config.json`'a yazılır. Codex beyni
`codex exec --ignore-user-config --ephemeral` ile salt-okunur kum havuzunda
çalışır (`~/.codex/config.toml` okunmaz). Model verilmezse Codex CLI'nin kendi
yerleşik varsayılanı kullanılır; seçmek için model ve düzeyi `--model`/`--effort`
ile ya da proje veya genel kobay ayarındaki `brain` bloğunda (`model`, `effort`)
ver. Oturum `CODEX_HOME`'dan gelir.

## Hızlı başlangıç (demo uygulama)

Aşağıdaki çıktılar paketteki demo uygulamaya karşı yapılan gerçek koşudan
alınmıştır.

```sh
# 1. terminal — açık kalsın
kobay demo --port 3999            # giriş: demo / demo123

# 2. terminal
mkdir kobay-demo && cd kobay-demo
KOBAY_LOGIN_USER=demo KOBAY_LOGIN_PASS=demo123 \
  kobay project create --url http://127.0.0.1:3999 \
                       --login --login-url http://127.0.0.1:3999/login
#> Project created: ~/kobay-demo/.kobay
#> Target: http://127.0.0.1:3999
#> Credentials: saved
#> Next: kobay explore

kobay explore                      # beyin çağrısı yok
#> 4 pages explored (logged in)
#> Pages: /login, /, /records, /new

kobay test plan generate           # LLM çağrısı
#> 10 proposals generated
#> {"proposals":[{"id":"p_q3w8wt","priority":"p0","title":"Record list shows saved records","stepCount":2}, ...

kobay test plan accept --ids p_q3w8wt,p_gonrog
#> 2 proposals accepted
#> t_6a12wnx1  Record list shows saved records  frontend  plan  draft  2 steps  p0  /records …

kobay test run --all               # kod üretimi + koşu (LLM)
#> passed t_6a12wnx1
#> failed t_sknz9qok — product_bug
#>   failure bundle: kobay test failure get t_sknz9qok
#> passed t_v1h8tqsy

kobay test failure get t_sknz9qok
#> Failure bundle copied: ~/kobay-demo/.kobay/failure-out/t_sknz9qok
#> code.ts  failure.json  meta.json  step-1.html  step-1.png  steps.json  trace.zip
```

## Ajana bağlama

```sh
kobay agent install --target claude
#> Skill created: ~/my-app/.claude/skills/kobay/SKILL.md
#> MCP registered in .mcp.json (kobay → `kobay mcp`): ~/my-app/.mcp.json
```

`.mcp.json` proje kapsamlı bir MCP ayarı olduğu için o dizindeki ilk `claude`
oturumunda sunucu **pending approval** görünür ve bir kez onaylamanı ister.
Codex (`--target codex`,
`AGENTS.md` içindeki kobay:BEGIN/END bloğu) ve Cursor (`--target cursor`,
`.cursor/rules/kobay.mdc`) için beceriyi kobay yazar, sunucu kaydını sen
yaparsın: `codex mcp add kobay -- kobay mcp`, ya da `.cursor/mcp.json`.

### Kodlama ajanına bunu yapıştır

```text
Bu yerel web uygulamasını uçtan uca doğrulamak için kobay kullan. Önce kobay'ın
erişilebilir olduğundan emin ol (gerekirse kur), `kobay install-browser`
koştur ve uygulamanın yerel URL'sini başlat ya da bul. Kobay projesini oluştur
ya da incele, sonra uygulama sağlık denetimini yap. Değiştirdiğim özellik için
mevcut testleri bul veya uygulamayı keşfet; küçük ve odaklı bir plan üret,
yalnız ilgili önerileri kabul et ve testleri koştur. Bir test düşerse hata
paketini alıp oku. `product_bug` için ürün kodunu düzelt; `product_changed` için
testi yenile; `test_bug` için test kodunu değiştirmeden önce üretilen kodu
incele. Her düzeltmeden sonra aynı testi yeniden koştur. Kobay MCP araçları
varsa onları öncele; yoksa CLI'ı `--output json` ile kullan. CLI JSON'unda karar
verirken borulu komutun kabuk çıkış koduna değil `ok` ve `exitCode` alanlarına
bak. Kimlik bilgilerini, çerezleri veya trace'leri açığa çıkarma. Başarısız iki
düzeltme denemesinden sonra dur; koşan testleri, verdict'leri, değişiklikleri ve
doğrulanmayanları raporla.
```

### MCP-öncelikli çağrı sırası

Kaynak: [`src/mcp/index.ts`](src/mcp/index.ts) ve
[`beceri/SKILL.md`](beceri/SKILL.md). Aşağıdaki her araç isteğe bağlı
`projectDir` alır; sunucu proje içinde başladıysa geçme.

1. `project_get` çağır → proje ayarları ve durumu. Proje yoksa zorunlu `url` ve
   isteğe bağlı `docs`, `loginUser`, `loginUrl`, `force` ile `project_create`
   çağır → `.kobay/` oluşur.
2. `doctor` çağır → kurulum, hedef ve ortam denetimleri. Hedef satırı `ok: true`
   olmadan devam etme; bir satır düşse bile `doctor` başarılı çıkabilir.
3. `test_list` çağır → kaydedilmiş testler. Yeni özellik için `explore` çağır →
   sayfa haritası yenilenir; sonra isteğe bağlı `hint` ile `plan_generate` →
   öneriler; sonra `ids: string[]` (ya da `all: true`) ile `plan_accept` → taslak
   testler.
4. `ids: string[]` ya da `all: true` ile `test_run` çağır (isteğe bağlı
   `rerun`) → test başına `verdict`, `runId` ve düşerse `failureKind` içeren
   sonuçlar.
5. Düşen test için `id` ile `failure_get` çağır (isteğe bağlı `out`) → kanıt
   paketi. `failureKind`'ı oku: ürün düzeltmesinden sonra `id` ile `test_rerun`;
   `product_changed` için isteğe bağlı `run` ile `test_refresh`; test sorunu için
   üretilen kodu değiştirmeden önce `id` ile `code_get` çağır.
6. Döngü bitince `prune` çağır (isteğe bağlı `confirm`, `dryRun`, `maxMb`,
   `olderThanDays`) → eski koşuları, beyin günlüklerini ve artıkları varsayılan
   olarak önizler; sonucu inceleyip silmek için `confirm: true` geçir.
   `dryRun: true` her durumda önizlemeyi zorlar.

**MCP yoksa CLI.** Eş komutları `--output json` ile kullan:
`kobay project get`, `kobay doctor`, `kobay test list`, `kobay explore`,
`kobay test plan generate`, `kobay test plan accept --ids <P1,P2>`,
`kobay test run <ID...>`, `kobay test failure get <ID>` ve
`kobay test rerun <ID>`; temizlik için `kobay prune --dry-run`, sonra
`kobay prune`. Her CLI yanıtı tek bir JSON zarfıdır. Kararı içindeki
`ok` ve `exitCode` alanlarından ver; kobay'ı başka komuta borulayıp `$?` okuma,
o son komutun durumudur, kobay'ın değil.

**MCP'de giriş:** parola ve gidebileceği adres yalnız sunucu ortamından gelir —
ajanı başlattığın kabukta `KOBAY_LOGIN_ORIGIN` ve `KOBAY_LOGIN_PASS` dışa aktar,
araca yalnız `loginUser` geç. Bu değişkenleri commit edilen `.mcp.json`'a yazma.

Sunucu (`kobay mcp`, stdio) şu araçları sunar:

```
project_create  project_update  project_get  explore       plan_generate
plan_accept     test_create     test_list    test_get      code_get
test_delete     test_run        test_rerun   test_refresh  test_result
failure_get     doctor          prune
```

Her araç isteğe bağlı `projectDir` alır ve yalnız sunucunun başladığı dizinin
altında olabilir; ek kökler `KOBAY_MCP_ROOTS` ile.

## Nasıl çalışır

- Giriş adresi `--url` ile aynı origin'de olmalı, değilse çıkış `2`. `--login`,
  `KOBAY_LOGIN_USER`/`KOBAY_LOGIN_PASS` okur; yoksa sorar (parola ekrana
  yazılmaz), terminal de değişken de yoksa çıkış `2` — stdin'e boru yok.
- Keşif LLM çağırmaz: aynı origin'deki `<a href>` bağlantılarını izler (en fazla
  40 sayfa), çıkış/sil gibi görünenleri atlar, form göndermez; sonuç *harita*
  (`.kobay/map.json`). Beyin 8–25 öneri üretir, haritada olmayan adrese
  bağlananlar düşürülür. Giriş ayarlıysa gerçek kimlik bilgisini (parola, gizli
  anahtar, PIN) yazan adımlı öneriler de düşürülür (`dropped` altında, adımıyla);
  geçersiz ya da boş değer yazan adımlar sorun değildir. Her öneri ayrıca
  `requiresRealCredentials` alanını bildirir; `true` öneriyi düşürür, alan `false`
  dese de sözcük filtresi gerçek kimlik yazan adımı yine düşürür. Üretilen kod sessizce
  `test.skip` kullanamaz; gerçek kimlik gerektiren adım yeniden yazılmaz, hata
  fırlatır. Hepsini kabul etme, her test ilk koşuda LLM demek.
- Beynin önermediği akışı elle yazmak için `kobay test create --plan <dosya>`
  ([`schemas/plan.schema.json`](schemas/plan.schema.json)). Zorunlu alanlar
  `type` (`frontend`), `name` ve 1–200 `planSteps`; `url` (testin sayfası: `/records`
  gibi bir yol ya da projenin `baseUrl` origin'inde tam adres), `description`,
  `priority` ve `projectId` (serbest etiket, saklanmaz) isteğe bağlı. Başka
  origin'deki `url` çıkış `2` ile reddedilir. `url`, `baseUrl`'e göre çözülür ve bu normalleşmiş
  biçimiyle saklanır. Kayıtlı kimliği olan projede, adımları gerçek parolayı ya da
  başka bir gizli değeri yazan plan çıkış `2` ile reddedilir; kobay'ın kendi giriş
  adımı testi zaten oturumlu açar. `url` yoksa analiz harita
  karşılaştırmasını atlar ve bunu bir uyarıyla söyler.
- `--out` verilmezse paket `.kobay/failure-out/<id>/` altına gider ve her çağrıda
  yerinde yenilenir; kendi verdiğin klasör önceden var olmamalı. Kanıt dosyaları
  `step-<adım>.png` / `step-<adım>.html`; `console.json` ve `network.json` yalnız
  analiz onları kanıt gösterirse girer. `npx playwright show-trace trace.zip`.
- Düzelttikten sonra `kobay test rerun <id>` kodu yeniden üretmeden koşturur;
  ürün bilerek değiştiyse `kobay test refresh <id>` sayfayı yeniden keşfedip
  plan adımlarını uyarlar.

## Komutlar

`kobay prune [--dry-run] [--max-mb <mb>] [--older-than-days <gün>]` eski
koşuları, beyin günlüklerini, kalmış hata paketlerini ve yalnız bilinen eski
sürüm artıklarını temizler; bilinmeyen `failure-out/` dosyalarını atlar, son
başarısız koşuya ve güncel hata paketine dokunmaz. CLI varsayılan olarak siler;
`--dry-run` yalnız önizler. `--max-mb` `runs/` toplam boyut tavanıdır (varsayılan
500), `--older-than-days` yaş eşiğidir (varsayılan 7). JSON dry-run sonucu
`estimate: true` taşır; gerçek silmede koşu alanı yeniden ölçülür. MCP aracı
varsayılan olarak önizler, yalnız `confirm: true` ile siler ve `dryRun: true`
her durumda önizlemeyi zorlar.

Komutların tamamı ve bayrakları: [README.md#commands](README.md#commands).

## Sonuç okuma

`verdict`: `passed` · `failed` (bir adım beklediğini bulamadı, paket var) ·
`blocked` (hedefe ulaşılamadı) · `inconclusive` (kod yok ya da beyin/motor
hatası). Playwright testi hiç çalıştıramazsa sonuç `inconclusive` +
`failureKind: env` + çıkış `4` olur; asla `passed` değil.

| `failureKind` | Ne yapılır |
| --- | --- |
| `product_bug` | Uygulamayı düzelt, `kobay test rerun <id>`. |
| `product_changed` | Ürüne dokunma: `kobay test refresh <id>`. |
| `test_bug` | `kobay test code get <id>`, testi düzelt. |
| `env` | Ortamı ayağa kaldır, `kobay test rerun <id>`. |
| `flaky` / `unknown` | Kanıtı incele, varsayım yapma. |

Üretilen kodun fırlattığı `kobay:` hatası desteklenmeyen bir plan adımı demektir
(ör. gerçek kimlik gerektiren adım); beyin çağrılmadan `test_bug` olarak
raporlanır.

Çıkış kodları: `0` geçti · `1` test düştü · `2` kullanım · `3` hedef · `4`
beyin/motor · `5` giriş/yetki; `test run` birden çok testte en yükseğiyle çıkar.
Sayfa kimlik bilgisini başka origin'e göndermeye çalıştığı için kobay'ın reddettiği
giriş de `5` ile döner.

`--output json` tek bir zarf basar: `{"ok":true,"exitCode":0,"data":...}` ya da
`{"ok":false,"exitCode":2,"error":{"code":"InvalidId","message":"Invalid testId: t_yok"}}`.
Boruyla çalışırken `$?` yerine JSON'daki `ok`/`exitCode` alanına bak; `--output
json` yoksa komut kısa bir insan özeti basar ve onu ayrıştırmak yanlıştır. Hata
kodları: [README.md#output-and-failures](README.md#output-and-failures).

## Maliyet ve veri

Süreç başına tavanlar: `claude` çağrısı başına **$1** (`KOBAY_MAX_BUDGET_USD`),
**100** beyin çağrısı (`KOBAY_MAX_BRAIN_CALLS`), toplam **$5**
(`KOBAY_MAX_TOTAL_COST_USD`), OpenRouter yanıt token'ı **4096**
(`KOBAY_OPENROUTER_MAX_TOKENS`). Ortam değişkeni config'i ezer, tavan yükseltmek
ancak yeni süreçte geçerli olur, başlayıp hatayla biten çağrı iade edilmez,
toplam tavan yalnız sağlayıcının bildirdiği maliyeti sayar (`codex` bildirmez)
ve `test run --all` kodu olmayan her test için üretim çağrısı demek.
`ANTHROPIC_API_KEY` tanımlıysa `claude -p`, `OPENAI_API_KEY` ya da `CODEX_API_KEY`
tanımlıysa `codex exec` aboneliğin yerine API hesabından faturalayabilir; kobay
bir kez uyarır.

Beyne giden veri: plan üretiminde harita, `--docs` belgesinin ilk 20.000
karakteri ve `--hint`; kod üretiminde plan adımları ve harita; hata analizinde
hata metni, düşen adımın temizlenmiş DOM'u, en fazla 20 konsol ve 20 ağ hatası,
test kodu ve plan adımları (ekran görüntüsü gitmez). Hata analizinden önce ve
`.kobay/logs/` altına bir şey yazılmadan önce, gizli ortam değişkenlerinin
(`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `KOBAY_LOGIN_PASS`) değerleri, `sk-…` ve
`ghp_…` gibi sağlayıcı token biçimleri ve sır benzeri değerler `[redacted]`
yapılır; ortam değişkenleri dışında bu kalıp eşlemedir, hepsini yakalamaz. Ama **plan
aşamasında giden harita ve belge maskelenmez.** Gerçek müşteri verisi gösteren
sayfalara kobay'ı yöneltme. Kayıtlı parola isteme hiç girmez; her çağrının
istemi ve yanıtı aynı maskeleme uygulanarak `.kobay/logs/` altına yazılır (git'e
girmez).

## `.kobay/` dizini

Projenin bütün durumu uygulamanın kökündeki `.kobay/` altında: `config.json`,
`credentials.json` ve `storageState.json` (0600, git dışı), `map.json`,
`plan/proposals.json`, `tests/`, `runs/`, `failure/`, `failure-out/`, `logs/`,
`playwright.config.ts`. Dökümün tamamı:
[README.md#the-kobay-directory](README.md#the-kobay-directory).

Config, harita ve testleri commit et; gerisini kobay'ın yönettiği
`.kobay/.gitignore` bloğu dışlar ve blok her komutta yeniden senkronlanır. Koşu
geçmişi budanır: test başına son 5 koşu, yayımlanan paketin gösterdiği koşu, az
önce biten koşu ve son 10 dakikada biten her şey kalır.

**0.1 projesini yükseltmek.** İlk 0.2 komutu `harita.json`'u `map.json`,
`plan/onerileri.json`'u `plan/proposals.json` yapar; config, kimlik, harita ve
öneri dosyaları İngilizce alan adlarıyla yeniden yazılır (`credentials.json`
0600 kalır). Komut ya da bayrak gerekmez; var olan bir `map.json` eski dosyayla
ezilmez, `.kobay` hiç yazılamıyorsa kobay uyarı basıp eski adları okumayı
sürdürür. Tek yön: 0.1, 0.2 projesini okuyamaz. **`kobay agent install`
komutunu yeniden çalıştır** ki kurulu beceri ajana yeni adları öğretsin.

## Güvenlik modeli (özet)

- Üretilen test kodu senin kullanıcının dosya yetkisiyle yerelde çalışır; sayfa
  metni isteme girdiği için sayfa üretilen kodu yönlendirmeye çalışabilir
  (prompt injection). Kod denetimi el yazımı bir sözcüksel taramadır:
  **hız kesicidir, güvenlik sınırı değildir.** Kum havuzu yok, tarayıcı ağ
  olarak kilitli değil. Test süreçleri kabuk ortamını devralmaz; parola test
  sürecine hiç gitmez, oturum storageState dosyasıyla taşınır.
- `.kobay/credentials.json` parolayı düz metin, 0600 izinle, tek origin'e kilitli
  tutar; `storageState.json` oturum çerezlerini. İkisi de git dışıdır ve proje
  başka origin'e taşınırsa silinir. `trace.zip` de oturum çerezi içerir — hata
  paketini herkese açık yerlere ekleme. Metin kanıtları (`console.json`,
  `network.json`, `step-*.html`) pakete kopyalanırken maskelenir, ama ekran
  görüntüleri ve `trace.zip` maskelenemez: ekranda ya da ağ izinde görünen
  gizli değerleri taşıyabilirler; paketin tamamını hassas say
  (`.kobay/failure-out/` git dışıdır).
- Giriş sayfası `baseUrl` ile tam aynı origin'de olmalı; formun `action` hedefi
  ise aşağıdaki aynı-site kuralına uyar (`app.example.com` formu
  `api.example.com`'a gönderebilir), başka siteye gönderen formda parola hiç
  yazılmaz. *Giriş sırasında* (parola yazılınca başlar; sayfa ilerleyip ağ durulunca, en
  fazla 2 sn sonra biter) kimlik bilgisi yalnız `baseUrl` origin'ine ya da aynı
  siteye gidebilir: parolayı başka siteye taşıyan istek (`fetch`, XHR,
  `sendBeacon`, resim isteği) engellenir ve giriş reddedilir; siteler-arası
  yazmalar (POST, PUT vb.) kesilir, siteler-arası WebSocket bağlanmadan kapatılır;
  önceden açık siteler-arası WebSocket'e bu pencerede (en fazla yaklaşık 7 sn)
  gönderilen mesajlar sessizce düşürülür.
  *Giriş sonrası*, o `explore` ya da `test refresh` tarayıcısı kapanana dek,
  yalnız parolayı açıkça taşıyan siteler-arası istek ve WebSocket mesajı kesilir
  ve keşif reddedilir; uygulamanın kendi siteler-arası API çağrıları ve
  WebSocket'leri geçer. Aynı sitedeki alt alanlar serbest (`app.example.com` ile
  `api.example.com`, aynı şema); ayrı bir kimlik doğrulama sitesi (SSO) değil.
  `localhost`, IP adresi ve tek etiketli adlarda port farklı olabilir ama ana
  makine adı aynı olmalı: `localhost:5173` `localhost:8080`'e istek atabilir,
  `localhost` ile `127.0.0.1` ise farklı sitedir. Kayıtlı alan adı Public
  Suffix List'ten okunmaz, yaklaşık hesaplanır (son iki etiket; `co.uk`,
  `github.io` gibi bilinen soneklerde üç): yaygın barındırma platformlarının
  kiracıları (`github.io`, `vercel.app`, `a.run.app`, `up.railway.app` vb.) ayrı
  sitedir, `amazonaws.com` ve `cloudfront.net` altındaki her adres tam origin
  eşitliği ister. Kullandığınız platform listede yoksa bildirin, eklensin. Kimlik yapılandırılmışsa service
  worker kapalıdır. Sınırlar: 307/308 yönlendirmesinde kobay girişi tespit edip
  reddeder, ama yönlendirilen isteğin kendisini engelleyemez; parola diğer
  sunucuya çoktan ulaşmış olabilir. Web Worker içinden açılan WebSocket kesilmez;
  kobay'ın tanımadığı biçimde kodlanmış parola siteler-arası GET ile, giriş
  sonrasında ise her siteler-arası istekle çıkabilir. Giriş bu nedenlerden
  biriyle reddedilirse `explore` ve `test refresh` `5` ile çıkar.
- Belge/plan yolları proje içinde kalmalı; `..`, symlink kaçışları, `.kobay/`
  altı ve nokta ile başlayan bileşenler reddedilir (çıkış `2`).

Tamamı: [README.md#security-model](README.md#security-model).

## Bilinen sınırlar

- **Uzun kullanım görmüş tek beyin `claude`.** `codex` bir canlı turu geçti
  (plan, kod üretimi, hata analizi); `openrouter` birim testli ama gerçek API ile
  hiç koşmadı.
- **Windows'un CI kapsamı var, fiziksel makine kapsamı yok.** Öksüz süreç
  temizliği, açık dosyada rename `EPERM`, 8.3 ve UNC yolları ile `claude` CLI'ın
  Git Bash gereksinimi doğrulanmadı. Sorunları lütfen bildir.
- Yalnız tarayıcı testleri, tarayıcı hep görünmez, kum havuzu yok; keşif sığdır
  (yalnız `<a href>`, en fazla 40 sayfa) ve giriş yalnız kullanıcı adı/parola
  formudur — SSO (ayrı kimlik sitesi), OAuth, CAPTCHA, 2FA yok; uygulamanın
  kendi sitesindeki alt alanlar kimlik bilgisini alabilir.
- `project get`, `test get`, `test result` ve `test plan generate` insan modunda
  da ham JSON gövdesi basıyor.
- Koşu sonu otomatik budama yalnız o an koşan testin geçmişini süpürür; tüm
  `.kobay` depolamasını (bütün testlerin koşuları, beyin günlükleri, eski
  sürümlerden kalanlar) `kobay prune` süpürür. `test delete` kaydı ve kodu
  siler, `failure/<id>/` ile eski koşuları bırakır.
- kobay SIGKILL ile öldürülürse süreç ağacı (Playwright worker'ı ve Chromium)
  kalır; SIGTERM/SIGINT'te temizlenir.

## Yol haritası

OpenRouter beyninin canlı denenmesi ve Codex'in daha uzun kullanımı; sonra
`test delete` sonrası temizlik, JavaScript ile yapılan girişler. Ayrıntı:
[CHANGELOG.md](CHANGELOG.md).

## Geliştirme

`npm run typecheck` (tsc --noEmit) · `npm run lint` · `npm test` (vitest) ·
`KOBAY_01_DIST=skip npm run test:strict` (katı koşu: gerçek Chromium, sürümler
arası test seti atlanır) · `npm run duman` (duman testi: npm pack, temiz
dizine kurulum, gerçek keşif). `test:strict` çalışması için `KOBAY_01_DIST`
şart: `skip` sürümler arası test setini atlar (CI'ın yaptığı budur); gerçek
bir 0.1 kurulumunun yolunu verirsen o test seti gerçek alt süreçlerle koşar.
CI bu adımları ubuntu-latest ve macos-latest üzerinde Node 22 ve 24 ile
koşturuyor. PR açmadan önce ilk üçünü çalıştır ve neyi gerçekten
koşturduğunu yaz. Makinenin okuduğu her şey İngilizce; kaynaktaki
tanımlayıcılar ve kod yorumları Türkçe kalıyor.

## Lisans

Apache-2.0 — bkz. [LICENSE](LICENSE).
