#!/usr/bin/env node
// Oddiy, mustaqil va chuqur diagnostikali load-test asbobi (faqat Node ichki modullari).
// Qayerda qotayotganini aniqlash:
//   - TCP ulanish (Tarmoq / Firewall / Portlar)
//   - TLS/SSL shifrlash (Server CPU)
//   - TTFB (Backend / Dastur / Baza hisob-kitobi)
//   - Ma'lumot uzatish (Download)
//   - Cloudflare / WAF blokirovkasi (403 / 429)

const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const readline = require('readline');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function promptQuestions() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY
  });
  const lines = rl[Symbol.asyncIterator]();

  const ask = async (query) => {
    process.stdout.write(query + ': ');
    const res = await lines.next();
    return res.done ? '' : (res.value || '').trim();
  };

  console.log('\n========================================');
  console.log('      YUKLAMA TESTI (LOAD TEST)         ');
  console.log('========================================\n');

  // 1. Domen yoki subdomen
  let rawUrl = '';
  while (!rawUrl) {
    const input = await ask("1. Sayt domeni yoki subdomenini kiriting (masalan: sayt.uz yoki api.sub.sayt.uz)");
    let cleaned = input.replace(/^https?:\/\//i, '').trim();

    if (!cleaned) {
      console.log("   ❌ Domen nomi bo'sh bo'lishi mumkin emas! Iltimos, kiriting.\n");
      continue;
    }

    try {
      const parsed = new URL('https://' + cleaned);
      if (!parsed.hostname || !parsed.hostname.includes('.') || parsed.hostname.endsWith('.')) {
        console.log("   ❌ Noto'g'ri domen! Domen yoki subdomen ko'rinishida kiriting (masalan: sayt.uz yoki api.sayt.uz).\n");
        continue;
      }
      rawUrl = parsed.href;
    } catch (e) {
      console.log("   ❌ Noto'g'ri domen kiritildi! Qaytadan kiriting.\n");
    }
  }

  // 2. Parallel oqimlar soni
  let concurrency = 0;
  while (!concurrency) {
    const input = await ask("2. Parallel oqimlar sonini kiriting (concurrency)");
    const num = parseInt(input, 10);
    if (!isNaN(num) && num > 0) {
      concurrency = num;
    } else {
      console.log("   ❌ Iltimos, noldan katta butun son kiriting (masalan: 10, 20, 50).\n");
    }
  }

  // 3. Test davomiyligi
  let duration = 0;
  while (!duration) {
    const input = await ask("3. Test davomiyligini kiriting (sekundlarda)");
    const num = parseInt(input, 10);
    if (!isNaN(num) && num > 0) {
      duration = num;
    } else {
      console.log("   ❌ Iltimos, noldan katta butun son kiriting (masalan: 5, 10, 30).\n");
    }
  }

  // 4. Proxy (ixtiyoriy)
  const useProxy = await ask("4. Proxy ishlatilsinmi? (host:port formatida, yoki kerak bo'lmasa Enter bosing)");
  let rawAuth = '';
  if (useProxy) {
    rawAuth = await ask("   Proxy login:parol (user:pass formatida, yoki bo'lmasa Enter bosing)");
  }

  rl.close();

  return {
    url: rawUrl,
    concurrency,
    duration,
    proxy: useProxy || null,
    auth: rawAuth || null
  };
}

let target;
let concurrency;
let duration;
let proxy;
let auth;
let isHttps;
let port;
let path;

const results = {
  ok: 0,
  fail: 0,
  statuses: {},
  latencies: [],
  bytes: 0,
  errors: {},
  // Qayerda qotayotganini aniq belgilash
  phaseFailures: {
    tcp: 0,       // Tarmoq / TCP ulanishda
    tls: 0,       // SSL/TLS shifrlashda
    ttfb: 0,      // Server javobini kutishda (Backend / Baza)
    download: 0,  // Yuklab olishda
    proxy: 0      // Proxy orqali ulanishda
  },
  phaseTimings: {
    tcp: [],
    tls: [],
    ttfb: [],
    download: []
  }
};

let running = true;

// Jonli monitoring
let inFlight = 0;
let secOk = 0;
let secFail = 0;
let secLatencies = [];
let secPhaseFails = { tcp: 0, tls: 0, ttfb: 0, download: 0, proxy: 0 };

function getPhaseName(phase) {
  switch (phase) {
    case 'tcp': return '🌐 Tarmoq/TCP aloqasi (Firewall yoki portlar)';
    case 'tls': return '🔒 SSL/TLS Shifrlash (Server protsessori)';
    case 'ttfb': return '⚙️ Server Dasturi (Backend/Baza hisob-kitobi)';
    case 'download': return '📦 Ma\'lumot uzatish (Yuklab olish)';
    case 'proxy': return '🛡️ Proxy server aloqasi';
    default: return phase;
  }
}

// Bitta so'rov va uning barcha bosqichlarini kuzatish
function oneRequest() {
  return new Promise((resolve) => {
    inFlight++;
    const t_start = process.hrtime.bigint();
    let settled = false;
    let phase = proxy ? 'proxy' : 'tcp';

    let t_tcp = 0;
    let t_tls = 0;
    let t_ttfb = 0;
    let t_end = 0;

    const done = (ok, status, err, failPhase, timings) => {
      if (settled) return;
      settled = true;
      inFlight--;
      const ms = Number(process.hrtime.bigint() - t_start) / 1e6;

      if (ok) {
        results.ok++;
        results.latencies.push(ms);
        secLatencies.push(ms);
        secOk++;
        results.statuses[status] = (results.statuses[status] || 0) + 1;

        if (timings) {
          if (timings.t_tcp > 0) results.phaseTimings.tcp.push(timings.t_tcp);
          if (timings.t_tls > 0) results.phaseTimings.tls.push(timings.t_tls);
          if (timings.t_ttfb > 0) results.phaseTimings.ttfb.push(timings.t_ttfb);
          if (timings.t_end > 0) results.phaseTimings.download.push(timings.t_end);
        }
      } else {
        results.fail++;
        secFail++;
        const p = failPhase || phase;
        results.phaseFailures[p] = (results.phaseFailures[p] || 0) + 1;
        secPhaseFails[p] = (secPhaseFails[p] || 0) + 1;
        results.errors[err] = (results.errors[err] || 0) + 1;
      }
      resolve();
    };

    // HTTP so'rov matnini yuborish va javobni o'qish
    const sendOn = (socket) => {
      phase = 'ttfb';
      const sendStart = process.hrtime.bigint();

      const req =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${target.host}\r\n` +
        `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n` +
        `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n` +
        `Connection: close\r\n\r\n`;

      let buf = Buffer.alloc(0);
      let status = 0;
      let firstByteReceived = false;

      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        results.bytes += d.length;

        if (!firstByteReceived) {
          firstByteReceived = true;
          phase = 'download';
          t_ttfb = Number(process.hrtime.bigint() - sendStart) / 1e6;
        }

        if (status === 0) {
          const line = buf.toString('latin1', 0, Math.min(buf.length, 64));
          const m = line.match(/HTTP\/1\.[01] (\d{3})/);
          if (m) status = parseInt(m[1], 10);
        }
      });

      socket.on('end', () => {
        t_end = Number(process.hrtime.bigint() - sendStart) / 1e6;
        done(status >= 100, status || 'no-status', null, phase, { t_tcp, t_tls, t_ttfb, t_end });
      });

      socket.on('error', (e) => done(false, 0, e.code || 'sock-err', phase));
      socket.setTimeout(15000, () => { socket.destroy(); done(false, 0, 'timeout', phase); });
      socket.write(req);
    };

    if (proxy) {
      // Proxy orqali
      const [phost, pport] = proxy.split(':');
      const p = net.connect(parseInt(pport, 10), phost);
      p.on('error', (e) => done(false, 0, 'proxy-' + (e.code || 'err'), 'proxy'));
      p.setTimeout(15000, () => { p.destroy(); done(false, 0, 'proxy-timeout', 'proxy'); });

      p.on('connect', () => {
        let head = `CONNECT ${target.hostname}:${port} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\n`;
        if (auth) head += `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n`;
        head += '\r\n';
        p.write(head);
      });

      let established = false;
      p.on('data', (d) => {
        if (established) return;
        const s = d.toString('latin1');
        if (s.startsWith('HTTP/1.1 200') || s.startsWith('HTTP/1.0 200')) {
          established = true;
          if (isHttps) {
            phase = 'tls';
            const tlsStart = process.hrtime.bigint();
            const tlsSock = tls.connect({ socket: p, servername: target.hostname, rejectUnauthorized: false }, () => {
              t_tls = Number(process.hrtime.bigint() - tlsStart) / 1e6;
              sendOn(tlsSock);
            });
            tlsSock.on('error', (e) => done(false, 0, 'tls-' + (e.code || 'err'), 'tls'));
            tlsSock.setTimeout(15000, () => { tlsSock.destroy(); done(false, 0, 'timeout', 'tls'); });
          } else {
            sendOn(p);
          }
        } else {
          const m = s.match(/HTTP\/1\.[01] (\d{3})/);
          done(false, 0, 'proxy-' + (m ? m[1] : 'refused'), 'proxy');
          p.destroy();
        }
      });
    } else {
      // To'g'ridan-to'g'ri ulanish
      phase = 'tcp';
      const tcpStart = process.hrtime.bigint();
      const s = net.connect(port, target.hostname);

      s.on('connect', () => {
        t_tcp = Number(process.hrtime.bigint() - tcpStart) / 1e6;

        if (isHttps) {
          phase = 'tls';
          const tlsStart = process.hrtime.bigint();
          const tlsSock = tls.connect({ socket: s, servername: target.hostname, rejectUnauthorized: false }, () => {
            t_tls = Number(process.hrtime.bigint() - tlsStart) / 1e6;
            sendOn(tlsSock);
          });
          tlsSock.on('error', (e) => done(false, 0, e.code || 'tls-err', 'tls'));
          tlsSock.setTimeout(15000, () => { tlsSock.destroy(); done(false, 0, 'timeout', 'tls'); });
        } else {
          sendOn(s);
        }
      });

      s.on('error', (e) => done(false, 0, e.code || 'tcp-err', 'tcp'));
      s.setTimeout(15000, () => { s.destroy(); done(false, 0, 'timeout', 'tcp'); });
    }
  });
}

async function worker() {
  while (running) {
    await oneRequest();
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function avgArr(arr) {
  return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

async function main() {
  const domainCli = arg('domain', arg('url', null));
  const concCli = parseInt(arg('concurrency', '0'), 10);
  const durCli = parseInt(arg('duration', '0'), 10);

  let cfg;
  if (domainCli && concCli > 0 && durCli > 0) {
    let clean = domainCli.replace(/^https?:\/\//i, '').trim();
    cfg = {
      url: new URL('https://' + clean).href,
      concurrency: concCli,
      duration: durCli,
      proxy: arg('proxy', null),
      auth: arg('auth', null)
    };
  } else {
    cfg = await promptQuestions();
  }

  target = new URL(cfg.url);
  concurrency = cfg.concurrency;
  duration = cfg.duration * 1000;
  proxy = cfg.proxy;
  auth = cfg.auth;

  isHttps = target.protocol === 'https:';
  port = target.port || (isHttps ? 443 : 80);
  path = target.pathname + target.search;

  console.log(`\nNishon:      ${target.href}`);
  console.log(`Yo'l:        ${proxy ? 'PROXY orqali (' + proxy + (auth ? ', auth' : '') + ')' : 'TO\'G\'RIDAN-TO\'G\'RI'}`);
  console.log(`Concurrency: ${concurrency} ta oqim | Davomiylik: ${duration / 1000}s\n`);
  console.log("------------------ JONLI MONITORING VA DIAGNOSTIKA ------------------");

  let elapsed = 0;
  let slowWarned = false;
  let freezeWarned = false;
  let freezeSecond = null;
  let slowSecond = null;

  // Har sekundda real vaqt rejimida qayerda qotayotganini tekshiruvchi monitor
  const monitorInterval = setInterval(() => {
    elapsed++;
    const curSecOk = secOk;
    const curSecFail = secFail;
    const curLatencies = secLatencies.splice(0, secLatencies.length);
    const curFails = { ...secPhaseFails };
    secPhaseFails = { tcp: 0, tls: 0, ttfb: 0, download: 0, proxy: 0 };
    secOk = 0;
    secFail = 0;

    const curRps = curSecOk + curSecFail;
    const avgLat = curLatencies.length ? (curLatencies.reduce((a, b) => a + b, 0) / curLatencies.length) : 0;
    const latStr = avgLat > 0 ? `${Math.round(avgLat)}ms` : '-';

    // Qaysi bosqichda eng ko'p xatolik yoki tiqilish bo'lmoqda?
    let worstPhase = 'ttfb';
    let maxPhaseCount = -1;
    for (const [ph, cnt] of Object.entries(curFails)) {
      if (cnt > maxPhaseCount) {
        maxPhaseCount = cnt;
        worstPhase = ph;
      }
    }

    let badge = '🟢 Normal';
    let alertMsg = null;

    if (curSecFail > 0 || avgLat > 3000 || (elapsed >= 2 && inFlight >= concurrency && curSecOk === 0)) {
      badge = '🔴 SERVER QOTMOQDA!';
      if (!freezeWarned) {
        freezeWarned = true;
        freezeSecond = elapsed;
        const cause = getPhaseName(worstPhase);
        alertMsg = `   🚨 [${elapsed}-soniyada] TO'SIQ ANIQLANDI! Qotayotgan joy: ${cause}`;
      }
    } else if (avgLat > 1000 || (elapsed >= 2 && inFlight >= concurrency * 0.7)) {
      badge = '🟡 Sekinlashyapti...';
      if (!slowWarned) {
        slowWarned = true;
        slowSecond = elapsed;
        alertMsg = `   ⚠️  [${elapsed}-soniyada] OGOHLANTIRISH: Server javob berishda kechikmoqda (${Math.round(avgLat)}ms).`;
      }
    }

    const timeStr = `[${String(elapsed).padStart(2, '0')}s]`;
    const rpsStr = `RPS: ${String(curRps).padEnd(4)}`;
    const latDisplay = `Kechikish: ${latStr.padEnd(8)}`;
    const inFlightDisplay = `Javob kutmoqda: ${String(inFlight).padEnd(4)}`;

    console.log(`${timeStr} ${rpsStr} | ${latDisplay} | ${inFlightDisplay} | ${badge}`);
    if (alertMsg) {
      console.log(alertMsg);
    }
  }, 1000);

  const t0 = Date.now();
  const workers = Array.from({ length: concurrency }, () => worker());
  setTimeout(() => { running = false; }, duration);
  await Promise.all(workers);
  clearInterval(monitorInterval);

  const secs = (Date.now() - t0) / 1000;
  const total = results.ok + results.fail;
  const sorted = results.latencies.slice().sort((a, b) => a - b);
  const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;

  console.log('\n================ NATIJA ================');
  console.log(`Jami so'rov:      ${total}`);
  console.log(`Muvaffaqiyatli:  ${results.ok}  (${((results.ok / total) * 100 || 0).toFixed(1)}%)`);
  console.log(`Xato/uzilgan:    ${results.fail}  (${((results.fail / total) * 100 || 0).toFixed(1)}%)`);
  console.log(`Tezlik (RPS):    ${(total / secs).toFixed(1)} so'rov/sekund`);
  console.log(`Yuklab olindi:   ${(results.bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log('--- Kechikish (latency) ---');
  console.log(`  min: ${sorted[0]?.toFixed(0) || 0} ms | avg: ${avg.toFixed(0)} ms | max: ${sorted[sorted.length - 1]?.toFixed(0) || 0} ms`);
  console.log(`  p50: ${pct(sorted, 50).toFixed(0)} ms | p90: ${pct(sorted, 90).toFixed(0)} ms | p99: ${pct(sorted, 99).toFixed(0)} ms`);
  console.log('--- Status kodlar ---');
  Object.entries(results.statuses).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  if (Object.keys(results.errors).length) {
    console.log('--- Xatolar ---');
    Object.entries(results.errors).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  }

  // =======================================================
  // CHUQUR DIAGNOSTIKA: QAYERDA VA NEGA QOTMOQDA?
  // =======================================================
  console.log('\n================ QAYERDA QOTMOQDA? (DIAGNOSTIKA) ================');

  const tcpAvg = avgArr(results.phaseTimings.tcp);
  const tlsAvg = avgArr(results.phaseTimings.tls);
  const ttfbAvg = avgArr(results.phaseTimings.ttfb);
  const dlAvg = avgArr(results.phaseTimings.download);

  console.log('⏱️  Bosqichlar bo\'yicha o\'rtacha vaqt (Muvaffaqiyatli so\'rovlarda):');
  console.log(`  1. 🌐 TCP ulanish (Tarmoq/Port):       ${tcpAvg} ms`);
  if (isHttps) console.log(`  2. 🔒 SSL/TLS shifrlash:              ${tlsAvg} ms`);
  console.log(`  3. ⚙️  Server Dasturi / TTFB (Backend): ${ttfbAvg} ms  <-- (Server hisob-kitob vaqti)`);
  console.log(`  4. 📦 Javobni yuklab olish:           ${dlAvg} ms`);

  if (results.fail > 0) {
    console.log('\n❌ Xatoliklar aynan qaysi bosqichda yuz berdi:');
    const f = results.phaseFailures;
    const fTotal = results.fail;
    console.log(`  • 🌐 TCP ulanishda (Tarmoq / Port):       ${f.tcp} ta  (${((f.tcp / fTotal) * 100).toFixed(1)}%)`);
    if (isHttps) console.log(`  • 🔒 SSL/TLS shifrlashda:                 ${f.tls} ta  (${((f.tls / fTotal) * 100).toFixed(1)}%)`);
    console.log(`  • ⚙️  Server Dasturida (TTFB / Baza):     ${f.ttfb} ta  (${((f.ttfb / fTotal) * 100).toFixed(1)}%)`);
    console.log(`  • 📦 Yuklab olishda (Download):           ${f.download} ta  (${((f.download / fTotal) * 100).toFixed(1)}%)`);
    if (proxy) console.log(`  • 🛡️ Proxy ulanishda:                     ${f.proxy} ta  (${((f.proxy / fTotal) * 100).toFixed(1)}%)`);
  }

  console.log('\n🎯 ANIQ XULOSA VA SABAB:');

  const hasCloudflare = results.statuses[403] || results.statuses[429];
  const hasServerCrash = results.statuses[502] || results.statuses[504] || results.statuses[500];
  const hasLocalLimit = results.errors['EMFILE'] || results.errors['EADDRNOTAVAIL'];

  if (hasCloudflare) {
    console.log('  🛡️  HIMOYA TIZIMI (Cloudflare / WAF / Anti-DDoS):');
    console.log('     Server so\'rovlarni bloklab qo\'ymoqda (403 Forbidden yoki 429 Too Many Requests).');
    console.log('     Sayt ishlayapti, lekin sizning skriptingiz avtomatik bot deb baholanib rad etilgan!');
  } else if (hasServerCrash) {
    console.log('  💥 SERVER DASTURI QULADI (502 Bad Gateway / 504 Gateway Timeout):');
    console.log('     Nginx web-serveri ishlayapti, lekin orqadagi dastur (Django/Node/PHP yoki baza) yuklamani ko\'tara olmay to\'xtab qolgan.');
  } else if (hasLocalLimit) {
    console.log('  💻 O\'ZINGIZNING KOMPYUTER LIMITINGIZ:');
    console.log('     Kompyuteringizda ochiq portlar yoki fayl deskriptorlari (EMFILE) yetishmadi.');
    console.log('     Muammo serverda emas, o\'zingizning operatsion tizimingizda!');
  } else if (results.phaseFailures.ttfb > results.phaseFailures.tcp) {
    console.log('  ⚙️  SERVERNING O\'ZI (BACKEND / BAZA) QOTDI:');
    console.log('     So\'rovlar serverga yetib borgan, aloqa bog\'langan, lekin server dasturi ularga javob tayyorlay olmay timeout bo\'lgan.');
    console.log('     Bu haqiqiy server qotishi (protsessor, RAM yoki MySQL/Postgres bazasi tiqilishi).');
  } else if (results.phaseFailures.tcp > 0) {
    console.log('  🌐 TARMOQ / FIREWALL / SYN-QUEUE TIQILINCHI:');
    console.log('     So\'rovlar server bilan hatto TCP ulanish ham o\'rnata olmagan.');
    console.log('     Sabab: Yoki server porti to\'lgan, yoki o\'zingizning Wi-Fi/provayderingiz so\'rovlar oqimini o\'tkaza olmay qolgan.');
  } else if (results.fail === 0 && avg > 2000) {
    console.log('  🟡 SERVER SEKINLASHDI, LEKIN YIQILMADI:');
    console.log('     Barcha so\'rovlarga javob berildi, lekin o\'rtacha kechikish yuqori bo\'ldi.');
  } else {
    console.log('  🟢 SERVER USHBU YUKLAMANI MUAMMOLARSIZ KO\'TARDI.');
  }

  console.log('=================================================================\n');
}

main();
