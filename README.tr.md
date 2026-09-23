# kobay

[English](README.md) · [CHANGELOG](CHANGELOG.md) · Apache-2.0

Esas belge İngilizce [README.md](README.md); bu dosya onun kısa Türkçe
karşılığıdır. Ayrıntı (komut bayrakları, güvenlik modelinin tamamı, maliyet
tavanları) orada.

**kobay, kodlama ajanları için yerel bir uçtan uca test motorudur.** Kendi
makinende çalışan bir web uygulamasını görünmez (headless) Chromium ile gezer,
bir LLM'e kullanıcı akışları önerttirir, kabul ettiklerini Playwright testine
çevirir, koşturur ve bir test düştüğünde ajanın üzerine iş yapabileceği bir
kanıt paketi verir: kök neden tahmini, `failureKind` sınıfı, önerilen düzeltme
hedefi, düşen adımın ekran görüntüsü ve DOM'u, Playwright trace'i.

Asıl mesele son kısım. Yalnız "failed" diyen bir test ajanı tahmine iter;
`product_bug` yerine `product_changed` diyen bir paket, ajanın hiç bozulmamış bir
uygulamayı "düzeltmesini" engeller.

kobay hesabı, bulut servisi ya da tünel yok; tarayıcı, uygulama ve koşular
makinende kalır. LLM'e "beyin" diyoruz, varsayılanı senin `claude` CLI'ın — yani
kobay'ın kendi API anahtarı yok. Beyne ulaşmak için bir miktar veri makinenden
çıkar; bkz. [Maliyet ve veri](#maliyet-ve-veri).

**kobay'ı yalnız güvendiğin yerel ya da test ortamına yönelt.** Üretilen testler
düğmelere basar, form gönderir, kayıt oluşturur.

## Durum

**0.1.0, erken sürüm.** Kullanılabilir ama pürüzsüz değil. Kurmadan önce neyin
denendiğini, neyin denenmediğini bil:

| | |
| --- | --- |
| **Kime** | Claude Code (ya da Codex / Cursor) kullanan, yerel web uygulamasını ajana "çalışıyor" dedirtmek yerine gerçekten doğrulattırmak isteyen geliştiriciler. |
| **Uçtan uca doğrulandı** | `claude` CLI beyni + MCP üzerinden Claude Code ajanı. Gerçek uygulamada iki gerçek koşu: ajan ürün hatasını buldu, kök nedene indi, düzeltti, testi yeşile çevirdi. |
| **Pratikte denenmedi** | `codex` ve `openrouter` beyinleri. Adaptörler var ve birim testli, ama hiçbiri gerçek CLI/API ile uçtan uca koşturulmadı. Doğrulanmamış say. |
| **Platform** | macOS'ta geliştirildi ve koşuyor. CI, ubuntu-latest ve macos-latest üzerinde Node 22 ve 24 ile tüm test paketini artı paketleme duman testini koşuyor. **Windows denenmedi.** |
| **Dil** | `--help`, bayraklar, ajan becerisi ve İngilizce README İngilizce. Çalışma anı mesajları — hatalar, `doctor`, `test list`, üretilen öneriler — 0.1'de hâlâ **Türkçe**. 0.2'de İngilizce'ye geçecek. |
| **Kapsam** | Yalnız tarayıcı testleri. API testi, backend testi, panel yok. |

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

kobay **henüz npm'de yayında değil**. Bugün kaynaktan kurulur:

```sh
git clone https://github.com/ademtfkc/kobay.git
cd kobay && npm install && npm run build
npm link                     # `kobay` komutunu PATH'e koyar
kobay install-browser        # Linux: kobay install-browser --with-deps
kobay doctor
```

`dist/` git'e girmiyor, yani git üzerinden kurulumun derlemesi gerekiyor.
Bunun için pakette `prepare` script'i var ve **yerel** git kurulumu —
bir projenin içinde `npm i github:ademtfkc/kobay` — `dist/`i derleyip çalışıyor.
**Global** olanı, `npm i -g github:ademtfkc/kobay`, npm 11.19'da hâlâ düşüyor:
npm, git paketinin derleme adımını kendi global bayrağı açıkken koşturuyor,
o adım gereken devDependencies'i kurmuyor ve derleme `tsc: command not found`
ile duruyor. Klonla ve derle; yayınlandıktan sonra bu satır
`npm i -g kobay` olacak.

`install-browser`, kobay'ın kendi Playwright sürümüne uyan Chromium'u indirir
(`npx playwright install` farklı revizyon çekebilir); Linux'ta `--with-deps`
sistem kütüphanelerini de kurar. `doctor` Node'u, beyin CLI'larını, Chromium'u,
projeyi ve hedefi denetler ve her zaman `0` ile çıkar — satırları oku:

```
✓ Node 26.8.1
✓ claude CLI
✓ codex CLI
✓ Chromium
✗ .kobay — `kobay project create --url <URL>` ile proje açın
✗ hedef — proje yok; önce `kobay project create --url <URL>` çalıştırın
```

Varsayılan beyni değiştirmek: `kobay setup --brain codex` (ya da `openrouter`),
`~/.kobay/config.json`'a yazılır. Codex beyni
`codex exec --ignore-user-config --ephemeral` ile salt-okunur kum havuzunda
çalışır (`~/.codex/config.toml` kullanılmaz); model ve düzey `--model`/`--effort`
ile verilir, oturum `CODEX_HOME`'dan gelir.

## Hızlı başlangıç (demo uygulama)

Aşağıdaki çıktılar gerçek koşudan alınmıştır; 0.1'de kobay Türkçe konuşuyor.

```sh
# 1. terminal — açık kalsın
kobay demo --port 3999            # giriş: demo / demo123

# 2. terminal
mkdir kobay-demo && cd kobay-demo
KOBAY_LOGIN_USER=demo KOBAY_LOGIN_PASS=demo123 \
  kobay project create --url http://127.0.0.1:3999 \
                       --login --login-url http://127.0.0.1:3999/giris
#> Proje oluşturuldu: ~/kobay-demo/.kobay
#> Giriş bilgisi: kaydedildi

kobay explore                      # beyin çağrısı yok
#> 4 sayfa keşfedildi (giriş yapıldı)
#> Sayfalar: /giris, /, /liste, /yeni

kobay test plan generate           # LLM çağrısı
#> 2 öneri üretildi
#> {"oneriler":[{"id":"p_d8kun8","oncelik":"p0","baslik":"Kayıt listesi açılır","adimSayisi":2}, ...

kobay test plan accept --ids p_d8kun8,p_dyrsax
kobay test list
#> t_ffcik12p	draft	p0	Kayıt listesi açılır

kobay test run --all               # kod üretimi + koşu (LLM)
#> failed t_kvwmtb23 — product_bug
#>   hata paketi: kobay test failure get t_kvwmtb23

kobay test failure get t_kvwmtb23
#> Hata paketi kopyalandı: ~/kobay-demo/.kobay/failure-out/t_kvwmtb23
#> failure.json code.ts steps.json meta.json adim-1.png adim-1.html trace.zip
```

- Giriş adresi `--url` ile aynı origin'de olmak zorunda, değilse çıkış `2`.
  `--login`, `KOBAY_LOGIN_USER`/`KOBAY_LOGIN_PASS` okur; yoksa sorar (parola
  ekrana yazılmaz). Terminal ve değişken yoksa çıkış `2`; stdin'e boru
  desteklenmez.
- Keşif yalnız aynı origin'deki `<a href>` bağlantılarını izler (en fazla 40
  sayfa), çıkış/sil gibi görünenleri atlar, form göndermez.
- `--out` verilmezse paket `.kobay/failure-out/<id>/` altına gider ve her çağrıda
  yerinde yenilenir; kendi verdiğin klasör önceden var olmamalı. `console.json`
  ve `network.json` pakete yalnız analiz onları kanıt gösterirse girer. Trace:
  `npx playwright show-trace trace.zip`.
- Düzelttikten sonra `kobay test rerun <id>` kodu yeniden üretmeden koşturur.

## Ajana bağlama

```sh
kobay agent install --target claude
#> Skill created: ~/my-app/.claude/skills/kobay/SKILL.md
#> MCP registered in .mcp.json (kobay → `kobay mcp`): ~/my-app/.mcp.json
```

`.mcp.json` proje kapsamlı bir MCP ayarı olduğu için Claude Code o dizinde ilk
açılışta sunucuyu onaylamanı ister — tek seferlik. Codex (`--target codex`,
`AGENTS.md` içindeki kobay:BEGIN/END bloğu) ve Cursor (`--target cursor`,
`.cursor/rules/kobay.mdc`) için beceriyi kobay yazar, sunucuyu sen kaydedersin:
`codex mcp add kobay -- kobay mcp`, ya da `.cursor/mcp.json` içine
`{ "mcpServers": { "kobay": { "command": "kobay", "args": ["mcp"] } } }`.

Sunucu (`kobay mcp`, stdio) 17 araç sunar: `project_create`, `project_update`,
`project_get`, `explore`, `plan_generate`, `plan_accept`, `test_create`,
`test_list`, `test_get`, `code_get`, `test_delete`, `test_run`, `test_rerun`,
`test_refresh`, `test_result`, `failure_get`, `doctor`. Her araç isteğe bağlı
`projectDir` alır ve yalnız sunucunun başladığı dizinin altında olabilir; ek
kökler `KOBAY_MCP_ROOTS` ile verilir.

**MCP'de giriş:** parola ve gidebileceği adres yalnız sunucu ortamından gelir —
ajanı başlattığın kabukta `KOBAY_LOGIN_ORIGIN` ve `KOBAY_LOGIN_PASS` dışa aktar,
araca yalnız `loginUser` geç. Bu değişkenleri commit edilen `.mcp.json`'a yazma.

Ajanın döngüsü ([`beceri/SKILL.md`](beceri/SKILL.md)): projeyi ve uygulamanın
ayakta olduğunu denetle → değişen özelliğin testlerini seç ya da üret → koştur →
düşerse paketi al ve `failureKind`'a göre davran → yeniden koş ve ne geçti, ne
değiştirdi, ne doğrulanmadı diye raporla.

## Sonuç okuma

`verdict`: `passed` · `failed` (bir adım beklediğini bulamadı, paket var) ·
`blocked` (hedefe ulaşılamadı) · `inconclusive` (kod yok ya da beyin/motor
hatası). Playwright testi hiç çalıştıramazsa (rapor hatası ya da sıfır test)
sonuç `inconclusive` + `failureKind: env` + çıkış `4` olur; asla `passed` değil.

| `failureKind` | Ne yapılır |
| --- | --- |
| `product_bug` | Uygulamayı düzelt, `kobay test rerun <id>`. |
| `product_changed` | Ürüne dokunma: `kobay test refresh <id>`. |
| `test_bug` | `kobay test code get <id>`, testi düzelt. |
| `env` | Ortamı ayağa kaldır, `kobay test rerun <id>`. |
| `flaky` / `unknown` | Kanıtı incele, varsayım yapma. |

Çıkış kodları: `0` geçti · `1` test düştü · `2` kullanım hatası · `3` hedef
ulaşılamıyor · `4` beyin/motor hatası · `5` giriş/yetki. Birden çok testte
`test run` en yüksek kodla çıkar.

`--output json` tek bir zarf basar: `{"ok":true,"exitCode":0,"data":...}` ya da
`{"ok":false,"exitCode":2,"hata":{"kod":...,"mesaj":...}}`. Boruyla çalışırken
`$?` yerine JSON'daki `ok`/`exitCode` alanına bak. `--output json` verilmezse
komutlar kısa bir insan özeti basar; betikler ve ajanlar onu ayrıştırmamalı.

## Maliyet ve veri

Süreç başına tavanlar: `claude` çağrısı başına **$1**
(`KOBAY_MAX_BUDGET_USD`), **100** beyin çağrısı (`KOBAY_MAX_BRAIN_CALLS`),
toplam **$5** (`KOBAY_MAX_TOTAL_COST_USD`), OpenRouter yanıt token'ı **4096**
(`KOBAY_OPENROUTER_MAX_TOKENS`). Ortam değişkeni config'i ezer, tavan yükseltmek
ancak yeni süreçte geçerli olur, başlayıp hatayla biten çağrı iade edilmez ve
toplam tavan yalnız sağlayıcının bildirdiği maliyeti sayar (`codex` bildirmez).

Beyne giden veri: plan üretiminde keşif haritası, `--docs` belgesinin ilk 20.000
karakteri ve `--hint`; kod üretiminde plan adımları ve harita; hata analizinde
hata metni, düşen adımın temizlenmiş DOM'u, en fazla 20 konsol hatası ve 20
başarısız ağ isteği, test kodu ve plan adımları (ekran görüntüsü gitmez).
Analizden önce sır benzeri değerler kalıpla `[maskelendi]` yapılır — kalıp
tabanlıdır, hepsini yakalamaz — ama **plan aşamasında giden harita ve belge
maskelenmez.** Gerçek müşteri verisi gösteren sayfalara kobay'ı yöneltme.
Kayıtlı parola isteme hiç girmez. Her çağrının istemi ve yanıtı `.kobay/logs/`
altına yazılır (git'e girmez).

## Güvenlik modeli (özet)

- Üretilen test kodu senin kullanıcının dosya yetkisiyle yerelde çalışır; sayfa
  metni isteme girdiği için sayfa üretilen kodu yönlendirmeye çalışabilir
  (prompt injection).
- Koddaki sözcüksel tarama el yazımıdır, JavaScript ayrıştırıcısı değil:
  **hız kesicidir, güvenlik sınırı değildir.** Kum havuzu yok ve üretilen kod
  `.kobay/` altındaki dosyaları okuyabilir. Tarayıcı ağ olarak da kilitli değil.
- Test süreçleri kabuk ortamını devralmaz (izin listesi); parola test sürecine
  hiç gitmez, oturum storageState dosyasıyla taşınır.
- `.kobay/credentials.json` parolayı düz metin, 0600 izinle, tek origin'e kilitli
  tutar; `storageState.json` oturum çerezlerini tutar. İkisi de git dışıdır ve
  proje başka origin'e taşınırsa silinir. `trace.zip` de oturum çerezi içerir —
  hata paketini herkese açık yerlere ekleme.
- Giriş koruması yalnız HTML formunu kapsar. **Giriş sayfanın JavaScript'iyle
  (fetch/XHR) yapılıyorsa kobay parolanın nereye gittiğini göremez.**
- Yol sınırları: belge/plan yolları proje içinde kalmalı; `..`, symlink
  kaçışları, `.kobay/` altı ve nokta ile başlayan bileşenler reddedilir (çıkış
  `2`). **CLI'da** `test failure get --out` proje dışını gösterebilir, MCP'de
  gösteremez.

Tamamı: [README.md#security-model](README.md#security-model).

## Bilinen sınırlar

- **Çalışma anı mesajları Türkçe.** Hata ve durum metinleri, `doctor` satırları,
  `test list` çıktısı ve bazı JSON alan adları (`ad`, `hata`, `mesaj`, `oneri`,
  `durum`) 0.1'de Türkçe; üretilen öneriler de genelde Türkçe geliyor.
- **Yalnız `claude` beyni kanıtlı.** `codex` ve `openrouter` birim testli ama
  gerçek CLI/API ile hiç koşmadı.
- **Windows denenmedi.** Üretilen testler için kum havuzu yok.
- Yalnız tarayıcı testleri; API/backend testi yok. Tarayıcı hep görünmez.
- Yalnız kullanıcı adı/parola formu: SSO, OAuth, CAPTCHA, 2FA yok.
- Keşif sığdır: yalnız `<a href>`, en fazla 40 sayfa.
- `project get`, `test get`, `test result` ve `test plan generate`'in sonu insan
  modunda da ham JSON basıyor.
- Budama yalnız o an koşan testin geçmişini süpürür; hiç yeniden koşulmayan
  testlerin koşuları diskte kalır.
- `test delete` yalnız test kaydını ve kodunu siler; `failure/<id>/`,
  `failure-out/<id>/` ve eski koşu klasörleri kalır.

## Yol haritası

0.2'de İngilizce çalışma anı mesajları (hatalar, `doctor`, `test list`, JSON alan
adları, plan istemi); ardından Codex beyninin canlı denenmesi ve OpenRouter;
sonra daha iyi temizlik (genel budama, `test delete` sonrası artıklar), Windows
desteği ve npm'de yayın. Ayrıntı: [CHANGELOG.md](CHANGELOG.md).

## Geliştirme

`npm run typecheck` (tsc --noEmit) · `npm run lint` · `npm test` (vitest) ·
`npm run test:kati` (katı koşu: gerçek Chromium) · `npm run duman` (duman testi:
npm pack, temiz dizine kurulum, gerçek keşif). CI bu adımları ubuntu-latest ve
macos-latest üzerinde Node 22 ve 24 ile koşturuyor. PR açmadan önce ilk üçünü
çalıştır ve neyi gerçekten koşturduğunu yaz.

## Lisans

Apache-2.0 — bkz. [LICENSE](LICENSE).
