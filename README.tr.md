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

**0.2.0, erken sürüm.** Kullanılabilir ama pürüzsüz değil. Kurmadan önce neyin
denendiğini, neyin denenmediğini bil:

| | |
| --- | --- |
| **Kime** | Claude Code (ya da Codex / Cursor) kullanan, yerel web uygulamasını ajana "çalışıyor" dedirtmek yerine gerçekten doğrulattırmak isteyen geliştiriciler. |
| **Uçtan uca doğrulandı** | `claude` CLI beyni + MCP üzerinden Claude Code ajanı: ajan ürün hatasını buldu, kök nedene indi, düzeltti, testi yeşile çevirdi. 0.2'de aynı döngü paketteki demo uygulamada gerçek beyinle tekrarlandı: 14 öneri, kabul edilen 3 testin 3'ü geçti, kasıtlı ürün hatası `product_bug` sınıflandı, tur $0.28 tuttu. |
| **Pratikte denenmedi** | `codex` ve `openrouter` beyinleri. Adaptörler var ve birim testli, ama hiçbiri gerçek CLI/API ile koşturulmadı. Doğrulanmamış say. |
| **Platform** | macOS'ta geliştirildi. CI, ubuntu-latest ve macos-latest üzerinde Node 22 ve 24 ile tüm test paketini artı paketleme duman testini koşuyor. **Windows denenmedi.** |
| **Dil** | Makinenin okuduğu her şey İngilizce: CLI ve MCP mesajları, JSON alan adları, hata kodları, dosya adları, istemler. Beyin; test adlarını ve açıklamaları keşfettiği uygulamanın dilinde yazar — Türkçe bir uygulamada başlıklar Türkçe gelir, bu tasarım gereği. |
| **Kapsam** | Yalnız tarayıcı testleri. API testi, backend testi, panel yok. |

**0.2.0 kırıcı bir sürüm.** Bütün JSON alan adları, hata kodları ve `.kobay`
dosya adları Türkçeden İngilizceye geçti; tam tablo [CHANGELOG.md](CHANGELOG.md)
içinde. 0.1 projesi ilk 0.2 komutunda kendiliğinden göç eder, ama kurulu ajan
becerisi etmez: **her projede `kobay agent install` komutunu yeniden çalıştır**
ki ajan yeni alan adlarını öğrensin. Sonrasında 0.1, 0.2 projesini okuyamaz.

Panelli, destek sözleşmeli barındırılan bir ürün istiyorsan kobay o değil;
[TestSprite](https://www.testsprite.com/) benzer bir keşif → plan → üretim →
koşu → analiz döngüsünü servis olarak sunuyor. kobay aynı fikrin yerel, daha dar
ve kendi LLM'ini getirdiğin hâli.

## Gereksinimler

- **Node.js 22.12 veya üstü**; macOS ya da Linux.
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

Varsayılan beyni değiştirmek: `kobay setup --brain claude` (ya da `codex`,
`openrouter`), `~/.kobay/config.json`'a yazılır. Codex beyni
`codex exec --ignore-user-config --ephemeral` ile salt-okunur kum havuzunda
çalışır (`~/.codex/config.toml` kullanılmaz); model ve düzey `--model`/`--effort`
ile verilir, oturum `CODEX_HOME`'dan gelir.

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
#> adim-1.html  adim-1.png  code.ts  failure.json  meta.json  steps.json  trace.zip
```

- Giriş adresi `--url` ile aynı origin'de olmalı, değilse çıkış `2`. `--login`,
  `KOBAY_LOGIN_USER`/`KOBAY_LOGIN_PASS` okur; yoksa sorar (parola ekrana
  yazılmaz), terminal de değişken de yoksa çıkış `2` — stdin'e boru yok.
- Keşif LLM çağırmaz: aynı origin'deki `<a href>` bağlantılarını izler (en fazla
  40 sayfa), çıkış/sil gibi görünenleri atlar, form göndermez; sonuç *harita*
  (`.kobay/map.json`). Beyin 8–25 öneri üretir, haritada olmayan adrese
  bağlananlar düşürülür; hepsini kabul etme, her test ilk koşuda LLM demek.
- Beynin önermediği akışı elle yazmak için `kobay test create --plan <dosya>`
  ([`schemas/plan.schema.json`](schemas/plan.schema.json)); elle yazılan planda
  `url` alanı olmadığı için analiz harita karşılaştırmasını atlar ve bunu bir
  uyarıyla söyler.
- `--out` verilmezse paket `.kobay/failure-out/<id>/` altına gider ve her çağrıda
  yerinde yenilenir; kendi verdiğin klasör önceden var olmamalı. Kanıt dosyaları
  `adim-<adım>.png` / `adim-<adım>.html`; `console.json` ve `network.json` yalnız
  analiz onları kanıt gösterirse girer. `npx playwright show-trace trace.zip`.
- Düzelttikten sonra `kobay test rerun <id>` kodu yeniden üretmeden koşturur;
  ürün bilerek değiştiyse `kobay test refresh <id>` sayfayı yeniden keşfedip
  plan adımlarını uyarlar.

Komutların tamamı ve bayrakları: [README.md#commands](README.md#commands).

## Ajana bağlama

```sh
kobay agent install --target claude
#> Skill created: ~/my-app/.claude/skills/kobay/SKILL.md
#> MCP registered in .mcp.json (kobay → `kobay mcp`): ~/my-app/.mcp.json
```

`.mcp.json` proje kapsamlı bir MCP ayarı olduğu için Claude Code o dizinde ilk
açılışta sunucuyu onaylamanı ister — tek seferlik. Codex (`--target codex`,
`AGENTS.md` içindeki kobay:BEGIN/END bloğu) ve Cursor (`--target cursor`,
`.cursor/rules/kobay.mdc`) için beceriyi kobay yazar, sunucu kaydını sen
yaparsın: `codex mcp add kobay -- kobay mcp`, ya da `.cursor/mcp.json`.

Sunucu (`kobay mcp`, stdio) CLI'ın karşılığı 17 araç sunar (`project_create`,
`explore`, `plan_generate`, `test_run`, `failure_get`, `doctor`… tam liste
İngilizce README'de). Her araç isteğe bağlı `projectDir` alır ve yalnız
sunucunun başladığı dizinin altında olabilir; ek kökler `KOBAY_MCP_ROOTS` ile.

**MCP'de giriş:** parola ve gidebileceği adres yalnız sunucu ortamından gelir —
ajanı başlattığın kabukta `KOBAY_LOGIN_ORIGIN` ve `KOBAY_LOGIN_PASS` dışa aktar,
araca yalnız `loginUser` geç. Bu değişkenleri commit edilen `.mcp.json`'a yazma.

Ajanın döngüsü ([`beceri/SKILL.md`](beceri/SKILL.md)): projeyi ve uygulamanın
ayakta olduğunu denetle → testleri seç ya da üret → koştur → düşerse paketi al
ve `failureKind`'a göre davran → yeniden koş ve ne geçti, ne değiştirdi, ne
doğrulanmadı diye raporla.

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

Çıkış kodları: `0` geçti · `1` test düştü · `2` kullanım · `3` hedef · `4`
beyin/motor · `5` giriş/yetki; `test run` birden çok testte en yükseğiyle çıkar.

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

Beyne giden veri: plan üretiminde harita, `--docs` belgesinin ilk 20.000
karakteri ve `--hint`; kod üretiminde plan adımları ve harita; hata analizinde
hata metni, düşen adımın temizlenmiş DOM'u, en fazla 20 konsol ve 20 ağ hatası,
test kodu ve plan adımları (ekran görüntüsü gitmez). Analizden önce sır benzeri
değerler kalıpla `[redacted]` yapılır — hepsini yakalamaz — ama **plan
aşamasında giden harita ve belge maskelenmez.** Gerçek müşteri verisi gösteren
sayfalara kobay'ı yöneltme. Kayıtlı parola isteme hiç girmez; her çağrının
istemi ve yanıtı `.kobay/logs/` altına yazılır (git'e girmez).

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
  paketini herkese açık yerlere ekleme.
- Giriş koruması yalnız HTML formunu kapsar. **Giriş sayfanın JavaScript'iyle
  (fetch/XHR) yapılıyorsa kobay parolanın nereye gittiğini göremez.**
- Belge/plan yolları proje içinde kalmalı; `..`, symlink kaçışları, `.kobay/`
  altı ve nokta ile başlayan bileşenler reddedilir (çıkış `2`).

Tamamı: [README.md#security-model](README.md#security-model).

## Bilinen sınırlar

- **Yalnız `claude` beyni kanıtlı**; `codex` ve `openrouter` birim testli ama
  gerçek CLI/API ile hiç koşmadı. **Windows denenmedi.**
- Yalnız tarayıcı testleri, tarayıcı hep görünmez, kum havuzu yok; keşif sığdır
  (yalnız `<a href>`, en fazla 40 sayfa) ve giriş yalnız kullanıcı adı/parola
  formudur — SSO, OAuth, CAPTCHA, 2FA yok.
- `project get`, `test get`, `test result` ve `test plan generate` insan modunda
  da ham JSON gövdesi basıyor.
- Budama yalnız o an koşan testin geçmişini süpürür; `test delete` kaydı ve kodu
  siler, `failure/<id>/` ile eski koşuları bırakır.

## Yol haritası

Codex beyninin canlı denenmesi, ardından OpenRouter; sonra `prune` komutu ve
`test delete` sonrası temizlik, Windows desteği, JavaScript ile yapılan
girişler. Ayrıntı: [CHANGELOG.md](CHANGELOG.md).

## Geliştirme

`npm run typecheck` (tsc --noEmit) · `npm run lint` · `npm test` (vitest) ·
`KOBAY_01_DIST=skip npm run test:kati` (katı koşu: gerçek Chromium, sürümler
arası test seti atlanır) · `npm run duman` (duman testi: npm pack, temiz
dizine kurulum, gerçek keşif). `test:kati` çalışması için `KOBAY_01_DIST`
şart: `skip` sürümler arası test setini atlar (CI'ın yaptığı budur); gerçek
bir 0.1 kurulumunun yolunu verirsen o test seti gerçek alt süreçlerle koşar.
CI bu adımları ubuntu-latest ve macos-latest üzerinde Node 22 ve 24 ile
koşturuyor. PR açmadan önce ilk üçünü çalıştır ve neyi gerçekten
koşturduğunu yaz. Makinenin okuduğu her şey İngilizce; kaynaktaki
tanımlayıcılar ve kod yorumları Türkçe kalıyor.

## Lisans

Apache-2.0 — bkz. [LICENSE](LICENSE).
