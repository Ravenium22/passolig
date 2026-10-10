# Passo Bot — Galatasaray vs Barcelona (11 Ekim 2026, 11:00 satış)

Kendi Passo hesabınla, kendi Chrome'unda çalışır. Satış açıldığı an koltuk seçim ekranına atlar, hedef kategoride boş koltuğu seçip sepete koyar ve **ödemeyi sana bırakır** (3D Secure SMS'i sen onaylarsın). Kart bilgisi girmez, şifre tutmaz.

Kurallar (Passo'dan): **1 TC = 1 bilet**, hesap sahibi = bilet sahibi, GS logolu Passo Taraftar Kart şart. Yani herkes **kendi hesabıyla** çalıştırır.

## Kolay yol: indir, PassoBot.bat'a çift tıkla

1. **Node.js LTS** kur: https://nodejs.org ("Windows Installer", hep Next). Google Chrome kurulu olsun.
2. Botu al: sana gönderilen **passolig-main.zip** dosyasını (ya da GitHub'a davet edildiysen tek tık: https://github.com/Ravenium22/passolig/releases/latest/download/passolig-main.zip) sağ tık **Tümünü ayıkla** → `passolig-main` klasörü çıkar.
3. Klasörde **`PassoBot.bat`** çift tıkla. Windows "korudu" uyarısı verirse **Daha fazla bilgi → Yine de çalıştır**. İlk seferde paketleri kurar (1 dk), sonra tarayıcıda panel açılır (http://127.0.0.1:4567). Siyah pencereyi kapatma.
4. Panelde sırayla: **1 Chrome'u Aç** (açılan pencerede Passo'ya gir) → **2 Bilgilerin** (TC, telefon, fatura adresi) **Kaydet** → **2b Kategori sırası** (hangi kategoriler, hangi sırayla; tribün tercihi) **Kategorileri Kaydet** → **3 Kontrol Et** ("Her şey hazır" yazmalı) → bugün bir kez **Deneme Yap** ("Deneme başarılı" yazmalı; koltuğa tıklayınca Chrome'da çıkan "Gerçek kişi" kutusunu sen tıkla).
5. Maç günü 10:50: panelde **BAŞLAT**. Sarı yanıp sönerse Chrome'da kutuyu tıkla, kırmızı yanıp sönerse ödeme sırası sende.

Aynı PC'de 2. kişi: klasörü ikinci bir kopyaya kopyala (config ayrı olsun), o kopyada bir kısayol/komutla `PassoBot.bat 4568` çalıştır (panel 4568 portunda açılır), panelde "Gelişmiş" altında profil adı `ali`, port `9223` yaz, Kaydet, sonra Chrome'u Aç ve o pencerede kendi hesabıyla girsin. Her panel kendi botunu çalıştırır.

## Komut satırı yolu (teknik kullanıcı)

1. **Node.js LTS** kur: https://nodejs.org (Windows installer, next-next).
2. Bu klasörü aç, bir terminalde:
   ```
   npm install
   copy config.example.json config.json
   ```
3. `config.json` içinde **`tckn`**, **`phone`** ve **`invoice`** (fatura için `city` / `district` / `address`, örn. `"İstanbul"` / `"Kadıköy"` / `"... Mah. ... Sok. No:1"`) alanlarını kendi bilgilerinle doldur (sadece senin PC'nde kalır, git'e girmez). Bunlar boşsa bot ödeme sayfasında durur, sen elle doldurursun.
4. **`start-chrome.bat`** çift tıkla → ayrı bir Chrome penceresi açılır. **O pencerede Passo'ya giriş yap.** Pencereyi kapatma.
   - Aynı PC'de 2. kişi: `start-chrome.bat ali 9223` ve onun `config.json`'unda `"cdpUrl": "http://127.0.0.1:9223"`.
5. Kontrol:
   ```
   npm run preflight
   ```
   "PREFLIGHT OK" görmelisin (giriş var, kategoriler bulundu, saat farkı).

## Satıştan ÖNCE mutlaka kontrol et

- **E-Bilet süresi:** Koltuğa tıklayınca Passo "Müşterinin E-Bilet kullanım süresi dolmuştur" diyorsa hesabın bilet alamaz. https://passotaraftar.com.tr/tr/kartlarim → **E-Bilet süremi uzat**. Bunu bugün yap; `npm run dryrun` ile doğrula.
- **Tek oturum:** Bot penceresinde giriş yapınca ana Chrome'daki Passo oturumu düşer (Passo tek aktif oturum tutuyor). Maç günü ana Chrome'dan Passo'ya girme, yoksa bot penceresi düşer.
- **Deneme sayısı:** `dryrun`'ı 1-2 kez çalıştır, yeter. Art arda çok koltuk ekleyip silince Passo "Güvenlik doğrulaması başarısız (g)" demeye başlıyor (Google reCAPTCHA puanı düşüyor); bot aynı koltuğu bir kez daha dener ama maç sabahı deneme yapma, hesabı dinlendir.
- **Cloudflare kutusu:** Koltuğa tıklanınca Passo "Gerçek kişi olduğunuzu doğrulayın" kutusu çıkarır. Bu kutuyu **sen** tıklarsın (bot bip çalar, pencereyi öne getirir ve bekler). Yani 11:00'de klavyenin başında ol; bot zamanı, sen kutuyu.

## Maç günü

- **10:50**'de bot Chrome penceresi açık ve girişli olsun, terminalde:
  ```
  npm start
  ```
- Bot 10:58:30'dan itibaren her 0.7 sn'de satış sinyalini kontrol eder. Açılınca: koltuk seçim → kategori sırası `8. Kategori → 9. → 10. → 11.` (plandaki 12→13→14→15) → blok sırası `config.json`'daki `blockOrder` → boş koltuk → Devam → sepet.
- Sepette bot **"Kendi T.C. Kimlik Numarama Tanımla"** kutusunu işaretler (Passo bunu şart koşuyor; "N saniye sonra tekrar deneyiniz" derse bekleyip tekrar dener) → Devam → fatura sayfası: "Faturayı kayıtlı bilgilerime istiyorum" işaretler, şehir/ilçe/adresi `config.json`'dan doldurur ve Devam'a basar.
- **Bip bip + pencere öne gelir = ÖDEME SIRASI SENDE.** "Kredi Kart İle Öde" → kart bilgileri → SMS onayı. Sepet süresi **10 dakika** (sağ üstte "Kalan Zaman"), oyalanma. Passo Taraftar Kart ile ödemek istiyorsan karta parayı **önceden** yükle.
- Cloudflare "insan mısın" kontrolü çıkarsa bot bekler; sen pencerede kutuyu tıkla, bot devam eder.
- "T.C. Kimlik No" penceresi çıkarsa bot `config.json`'daki TCKN'yi yazar (boşsa sen yazarsın).

Herkes aynı `blockOrder` ile koşarsa grup aynı bloğa/tarafa toplanır. Tarafı değiştirmek için: `npm start -- --side kuzey` (kuzey | guney | dogu | bati).

## Önceden deneme (bugün)

Şu an satışta olan bir maçta ucuz bir koltuk seçip geri bırakır, **ödeme yapmaz**:
```
npm run dryrun
npm run dryrun -- --to-basket     (sepet → tanımlama → fatura sayfasına kadar gider, Devam'a basmaz, sonra sepeti boşaltır)
```
`--to-basket` sonunda "BASKET FLOW: invoice:ready" görmelisin. Deneme bitince test sepeti **boşaltılır** ve Chrome etkinlik sayfasına döner; açık kalan sepet/fatura sayfasında Devam'a basarsan "Sepetinizde ürün bulunmamaktadır" demesi normaldir, bir şey satın alınmaz. "invoice:incomplete" ise `config.json`'daki `tckn` / `invoice` alanlarını doldur.

## Sorun giderme

- `Cannot reach Chrome` → `start-chrome.bat` çalışmıyor ya da port farklı.
- `NOT LOGGED IN` → bot penceresinde Passo'ya giriş yap, tekrar çalıştır.
- Loglar `logs/` klasöründe; hata anında ekran görüntüsü de oraya düşer.

## Uyarı

Passo üyelik sözleşmesi otomasyonu yasaklıyor olabilir; hesap TC'ye bağlı. Bot bu yüzden gerçek tarayıcıda, insan hızına yakın (sn'de ~1.5 istek) çalışır, koruma mekanizmalarını atlatmaz, hesap başına 1 bilet alır ve ödemeyi insana bırakır. Risk sana ait.

---

### English summary
Runs in your own logged-in Chrome (`start-chrome.bat`), watches the sale signal, jumps to the seat picker, selects a seat in your category/block order, proceeds to the basket and then **stops for you to pay**. One account = one ticket (Passo rule). `npm install` → `config.json` → `start-chrome.bat` + log in → `npm run preflight` today → `npm start` at 10:50 tomorrow.
