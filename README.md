# load-test

Serverlarni yuklama ostida sinash va **qayerda qotayotganini aniqlash** uchun mukammal diagnostikali vosita. 
Tashqi kutubxonalar (`npm install`) talab qilinmaydi, faqatgina Node.js ichki modullari (`net`, `tls`, `url`, `readline`) asosida ishlaydi.

U to'g'ridan-to'g'ri (direct) yoki `proxy-server` (HTTP CONNECT tunnel) orqali so'rov yuborishni qo'llab-quvvatlaydi.

---

## Terminalda ishga tushirish

```bash
cd load-test
node loadtest.js
```

Terminalda ketma-ket so'raladi:
```text
========================================
      YUKLAMA TESTI (LOAD TEST)         
========================================

1. Sayt domeni yoki subdomenini kiriting (masalan: sayt.uz yoki api.sub.sayt.uz): 
2. Parallel oqimlar sonini kiriting (concurrency): 
3. Test davomiyligini kiriting (sekundlarda): 
4. Proxy ishlatilsinmi? (host:port formatida, yoki kerak bo'lmasa Enter bosing): 
```

* **Domen:** `https://` yozish shart emas (masalan: `sayt.uz`, `api.sayt.uz`).
* **Standart qiymatlar yo'q:** Domen, parallel oqimlar va vaqt kiritilishi shart.
* **Proxy:** Agar kerak bo'lmasa, shunchaki `Enter` bosiladi.

---

## ⏱️ Jonli Monitoring va Qotish Signallari

Test paytida har sekundda terminalda serverning real vaqtdagi holati va to'siqlar ko'rsatiladi:

```text
------------------ JONLI MONITORING VA DIAGNOSTIKA ------------------
[01s] RPS: 45   | Kechikish: 120ms  | Javob kutmoqda: 5    | 🟢 Normal
[02s] RPS: 50   | Kechikish: 150ms  | Javob kutmoqda: 8    | 🟢 Normal
[03s] RPS: 15   | Kechikish: 1850ms | Javob kutmoqda: 25   | 🟡 Sekinlashyapti...
   ⚠️  [03-soniyada] OGOHLANTIRISH: Server javob berishda kechikmoqda (1850ms).
[04s] RPS: 2    | Kechikish: 3500ms | Javob kutmoqda: 48   | 🔴 SERVER QOTMOQDA!
   🚨 [04-soniyada] TO'SIQ ANIQLANDI! Qotayotgan joy: ⚙️ Server Dasturi (Backend/Baza hisob-kitobi)
```

---

## 🔬 Mukammal Diagnostika: "Qayerda va nega qotmoqda?"

Test yakunida har bir so'rovning barcha fazalari tahlil qilinadi:

```text
================ QAYERDA QOTMOQDA? (DIAGNOSTIKA) ================
⏱️  Bosqichlar bo'yicha o'rtacha vaqt (Muvaffaqiyatli so'rovlarda):
  1. 🌐 TCP ulanish (Tarmoq/Port):       45 ms
  2. 🔒 SSL/TLS shifrlash:              65 ms
  3. ⚙️  Server Dasturi / TTFB (Backend): 4200 ms  <-- (Asosiy vaqt shu yerga ketyapti!)
  4. 📦 Javobni yuklab olish:           25 ms

❌ Xatoliklar aynan qaysi bosqichda yuz berdi:
  • 🌐 TCP ulanishda (Tarmoq / Port):       25 ta  (5.2%)
  • 🔒 SSL/TLS shifrlashda:                 10 ta  (2.1%)
  • ⚙️  Server Dasturida (TTFB / Baza):     445 ta (92.7%)
  • 📦 Yuklab olishda (Download):           0 ta   (0.0%)

🎯 ANIQ XULOSA VA SABAB:
  ⚙️  SERVERNING O'ZI (BACKEND / BAZA) QOTDI:
     So'rovlar serverga yetib borgan, aloqa bog'langan, lekin server dasturi ularga javob tayyorlay olmay timeout bo'lgan.
     Bu haqiqiy server qotishi (protsessor, RAM yoki MySQL/Postgres bazasi tiqilishi).
=================================================================
```

### Diagnostika qanday xulosalar beradi?
1. **🛡️ Sayt Himoyasi (Cloudflare / WAF):** Agar so'rovlar 403 yoki 429 kodi bilan rad etilgan bo'lsa.
2. **💥 Server Dasturi Qulashi (502 / 504):** Nginx ishlab turibdi, lekin orqadagi Python/Django/Node/PHP o'chib qolgan bo'lsa.
3. **⚙️ Serverning o'zi (TTFB):** Aloqa o'rnatilgan, ammo backend/baza javob berolmay timeout bo'lsa.
4. **🌐 Tarmoq / SYN-Queue:** So'rovlar hatto server portiga ulana olmay uzilib qolgan bo'lsa.
5. **💻 Kompyuter Limiti:** O'zingizning operatsion tizimingizda portlar yoki fayl soketlari (`EMFILE`) yetishmagan bo'lsa.
