#!/usr/bin/env node
'use strict';
/**
 * Yosemite 房态监控 · 云端一次性运行版（GitHub Actions / 任意 Linux）
 *
 * 设计目标：简单、零成本、稳定。
 *   1) 启动真实 Chromium（虚拟显示器下非无头），生成 reCAPTCHA 令牌；
 *   2) 每个酒店只发 1 次库存请求（覆盖全部关注日期），拿每日余量；
 *   3) 有余量才去取「房型 + 价格」明细（每次最多 N 个日期）；
 *   4) 按冷却时间去重后推送企业微信（明细 1 条 + 姓名 1 条）；
 *   5) 写完 state.json 退出。失败不影响已推送记录。
 *
 * 用法：
 *   node cli.js              # 正常跑，读 env WECOM_WEBHOOK
 *   node cli.js --dry-run    # 只打印不发送（用于验证 IP 能不能过验证）
 *   node cli.js --verbose
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const STATE_PATH = path.join(DIR, 'state.json');
const DRY = process.argv.includes('--dry-run');
const VERBOSE = DRY || process.argv.includes('--verbose');

const START_URL = 'https://reservations.ahlsmsworld.com/Yosemite/Plan-Your-Trip';
const CDP_PORT = Number(process.env.YM_CDP_PORT || 9222);
const HOOK = (process.env.WECOM_WEBHOOK || CFG.webhook || '').trim();

const HOTEL_EN = { M: 'The Ahwahnee', Y: 'Yosemite Valley Lodge', D: 'Curry Village', H: 'Housekeeping Camp', T: 'Tuolumne Meadows Lodge' };
const HOTEL_ZH = { M: '阿赫瓦尼酒店', Y: '优胜美地山谷旅馆', D: '库里村帐篷营地', H: '自助营地小屋', T: '图奥勒米草甸旅馆' };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => { if (VERBOSE) console.log(...a); };

/* ---------------- 房型中文 ---------------- */
const ROOM_TYPE_ZH = [
  [/bunk rooms?/i, '上下铺房'], [/traditional/i, '传统房'], [/tent cabin/i, '帐篷小屋'],
  [/heated/i, '供暖帐篷'], [/cottage/i, '独立小屋'], [/cabin/i, '木屋'],
  [/motel room/i, '汽车旅馆房'], [/lodge room/i, '旅馆客房'], [/studio/i, '开间'],
  [/junior suite/i, '小套房'], [/suite/i, '套房'], [/deluxe/i, '豪华房'],
  [/standard/i, '标准房'], [/family/i, '家庭房'], [/bungalow/i, '平房'],
  [/room/i, '客房'], [/unit/i, '单元']
];
const ROOM_FLAG_ZH = [[/ada|accessible/i, '无障碍'], [/shared bath/i, '公共卫浴'], [/private bath/i, '独立卫浴'], [/river/i, '河畔'], [/view/i, '有景观'], [/fireplace/i, '带壁炉']];
function roomZh(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const parts = [];
  for (const [re, zh] of ROOM_TYPE_ZH) { if (re.test(raw)) { parts.push(zh); break; } }
  const bedZh = { double: '双人床', queen: '大床', king: '特大床', twin: '单人床', bunk: '上下铺', sofa: '沙发床' };
  const beds = [];
  for (const m of raw.matchAll(/(\d+)\s*(double|queen|king|twin|bunk|sofa)\s*beds?/gi)) {
    const zh = bedZh[m[2].toLowerCase()];
    if (zh) beds.push(`${m[1]} 张${zh}`);
  }
  if (beds.length) parts.push(beds.join(' + '));
  for (const [re, zh] of ROOM_FLAG_ZH) if (re.test(raw)) parts.push(zh);
  return parts.filter(Boolean).join(' · ');
}
const priceNum = (s) => Number(String(s || '').replace(/[^\d.]/g, '')) || 0;

/* ---------------- 日期 ---------------- */
const p2 = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const addDays = (isoStr, n) => { const d = new Date(isoStr + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const todayIso = () => iso(new Date());
const mmddyyyy = (isoStr) => { const d = new Date(isoStr + 'T00:00:00'); return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${d.getFullYear()}`; };
const toDateString = (isoStr) => new Date(isoStr + 'T00:00:00').toDateString();

/* 把 ranges 展开成逐日候选（入住日 → 退房日） */
function expandDates(task) {
  const out = new Map();
  const nights0 = Number(task.nights) || 1;
  for (const r of (task.ranges || [])) {
    const nights = Number(r.nights) || nights0;
    let cur = r.from, guard = 0;
    while (cur <= r.to && guard++ < 400) {
      if (cur >= todayIso()) {
        const key = `${cur}|${addDays(cur, nights)}`;
        if (!out.has(key)) out.set(key, { checkIn: cur, checkOut: addDays(cur, nights), nights });
      }
      cur = addDays(cur, 1);
    }
  }
  for (const d of (task.dates || [])) {
    const nights = Number(d.nights) || nights0;
    const key = `${d.from}|${addDays(d.from, nights)}`;
    if (d.from >= todayIso() && !out.has(key)) out.set(key, { checkIn: d.from, checkOut: addDays(d.from, nights), nights });
  }
  return [...out.values()].sort((a, b) => (a.checkIn < b.checkIn ? -1 : 1));
}

/* ---------------- 浏览器 ---------------- */
function findBrowser() {
  const cands = [process.env.CHROME_PATH, CFG.chromePath].filter(Boolean);
  const byPlat = {
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  }[process.platform] || [];
  for (const p of cands.concat(byPlat)) { try { if (p && fs.existsSync(p)) return p; } catch (e) { } }
  throw new Error('未找到 Chrome/Chromium，请设置环境变量 CHROME_PATH');
}

async function httpJson(url, timeout = 5000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  return r.json();
}

function launchBrowser() {
  const exe = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-chrome-'));
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-dev-shm-usage', '--window-size=1400,900', '--lang=en-US',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    START_URL
  ];
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-setuid-sandbox');
  if (process.platform === 'win32') args.push('--window-position=-3000,-3000');
  /* 可选：出口代理。机房 IP 若被人机验证拦下，填住宅代理即可（如 http://user:pass@1.2.3.4:8080） */
  if (CFG.proxy || process.env.YM_PROXY) args.push('--proxy-server=' + (process.env.YM_PROXY || CFG.proxy));
  if (CFG.proxyBypass) args.push('--proxy-bypass-list=' + CFG.proxyBypass);
  console.log('[浏览器] 启动 ' + exe);
  const proc = spawn(exe, args, { stdio: 'ignore', detached: false });
  proc.on('error', (e) => console.error('[浏览器] 启动失败', e.message));
  return { proc, profile };
}

async function waitCdp(ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`, 3000);
      const page = list.find(t => t.type === 'page' && !/devtools/i.test(t.url || ''));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (e) { }
    await sleep(500);
  }
  throw new Error('浏览器调试端口未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pend = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      const fn = this.pend.get(m.id);
      if (fn) { this.pend.delete(m.id); fn(m); }
    });
    ws.addEventListener('close', () => { for (const [, fn] of this.pend) fn({ error: { message: '连接已关闭' } }); this.pend.clear(); });
  }
  send(method, params, timeout = 30000) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pend.delete(id); rej(new Error(method + ' 超时')); }, timeout);
      this.pend.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) return rej(new Error(m.error.message || 'CDP 错误'));
        res(m.result);
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); rej(e); }
    });
  }
  async eval(expr, timeout = 30000) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeout);
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || '页面执行异常');
    }
    return r && r.result ? r.result.value : undefined;
  }
}

async function connectCdp() {
  const page = await waitCdp();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    setTimeout(() => rej(new Error('CDP 连接超时')), 10000);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable', {}).catch(() => { });
  return cdp;
}

/* 等页面就绪（reCAPTCHA key + grecaptcha 就位） */
async function waitReady(cdp, ms = 45000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      last = JSON.parse(await cdp.eval(`JSON.stringify({href:location.href, ready:document.readyState, key:!!window.wxa_grecaptcha_site_key, gr:!!(window.grecaptcha&&window.grecaptcha.enterprise)})`, 8000));
      if (last.ready === 'complete' && last.key && last.gr) return last;
    } catch (e) { last = { err: e.message }; }
    await sleep(800);
  }
  throw new Error('页面未就绪: ' + JSON.stringify(last));
}

async function goHome(cdp) {
  await cdp.eval(`location.href=${JSON.stringify(START_URL)}; 'go'`, 10000).catch(() => { });
  await sleep(2500);
  await waitReady(cdp);
}

/* ---------------- 官方接口 ---------------- */
/** 库存：一次覆盖 [startDate, endDate]，返回 Map<YYYY-MM-DD, count> */
async function fetchInventory(cdp, prop, startDate, endDate) {
  const s = toDateString(startDate), e = toDateString(endDate);
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await goHome(cdp);
      await waitReady(cdp, 20000).catch(() => { });
      const expr = `(async () => {
        const key = window.wxa_grecaptcha_site_key;
        if (!key) throw new Error('页面缺少 reCAPTCHA key');
        const tok = await new Promise((res, rej) => {
          if (!(window.grecaptcha && grecaptcha.enterprise)) return rej(new Error('no recaptcha'));
          grecaptcha.enterprise.ready(async () => { try { res(await grecaptcha.enterprise.execute(key, { action: 'GetInventoryCountData' })); } catch (er) { rej(er); } });
          setTimeout(() => rej(new Error('token 超时')), 15000);
        });
        const qs = new URLSearchParams({ CresPropCode: '000000', MultiPropCode: ${JSON.stringify(prop)}, UnitTypeCode: '', StartDate: ${JSON.stringify(s)}, EndDate: ${JSON.stringify(e)}, RecaptchaToken: tok });
        const r = await fetch('/Yosemite/Search/GetInventoryCountData?' + qs, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        return JSON.stringify({ status: r.status, body: await r.text() });
      })()`;
      const out = JSON.parse(await cdp.eval(expr, 40000));
      if (out.status === 200) {
        const data = JSON.parse(out.body);
        const map = new Map();
        for (const row of (Array.isArray(data) ? data : [])) {
          const k = String(row.DateKey || '').slice(0, 10);
          if (k) map.set(k, Number(row.AvailableCount) || 0);
        }
        log(`[库存] ${prop} ${s} → ${e}: ${map.size} 天`);
        return map;
      }
      lastErr = 'HTTP ' + out.status;
      if ([400, 403, 429].includes(out.status)) { log(`[库存] ${prop} 被限速 ${out.status}，重载页面重试`); await goHome(cdp); }
    } catch (er) { lastErr = er.message; }
    await sleep(1500);
  }
  throw new Error('库存查询失败: ' + lastErr);
}
/** 房型 + 价格明细 */
async function fetchDetail(cdp, prop, checkIn, checkOut, adults, children, rooms) {
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await goHome(cdp);
      await waitReady(cdp, 20000).catch(() => { });
      const expr = `(async () => {
        const from = ${JSON.stringify(mmddyyyy(checkIn))}, to = ${JSON.stringify(mmddyyyy(checkOut))};
        const tok = await new Promise((res, rej) => {
          if (!(window.grecaptcha && grecaptcha.enterprise)) return rej(new Error('no recaptcha'));
          if (!window.wxa_grecaptcha_site_key) return rej(new Error('页面缺少 reCAPTCHA key'));
          grecaptcha.enterprise.ready(async () => { try { res(await grecaptcha.enterprise.execute(window.wxa_grecaptcha_site_key, { action: 'SearchProductAvailability' })); } catch (e) { rej(e); } });
          setTimeout(() => rej(new Error('token 超时')), 15000);
        });
        const multi = {};
        for (let i = 0; i < 9; i++) { multi['MultiUnitCount_Adults[' + i + ']'] = String(${Number(adults) || 2}); multi['MultiUnitCount_Children[' + i + ']'] = String(${Number(children) || 0}); multi['MultiUnitCount_Others[' + i + ']'] = '0'; }
        const fields = Object.assign({
          CresPropCode: '000000', MultiPropCode: ${JSON.stringify(prop)}, RecaptchaToken: tok, ProductSelection: ${JSON.stringify(prop)},
          UnitCount: '${Number(rooms) || 1}', Adults: String(${Number(adults) || 2}), Children: String(${Number(children) || 0}),
          ArrivalMonthVisible: 'month, yyyy', RentalPickupDate_nd: '', ArrivalDate_nd: '', ArrivalDate: from,
          DepartureDate_nd: '', DepartureDate: to, SpecialRateCodes: '', CorporateCode: '', GroupCode: '', AgentCode: ''
        }, multi);
        const r = await fetch('/Yosemite/Search/Accomodations', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
        let target = r.url || '';
        if (/PleaseWait/i.test(target)) {
          target = '';
          for (let i = 0; i < 18; i++) {
            await new Promise(x => setTimeout(x, 900));
            const p = await fetch('/Yosemite/Utility/Ajax_CheckInterstitialStatus', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'interstitialCompletedMessage=' + encodeURIComponent('Thank you for waiting.  We are now transferring you to your search results.') });
            const j = await p.json().catch(() => null);
            if (j && j.completed) { target = j.redirectLocation || ''; break; }
          }
        }
        if (!target) throw new Error('搜索未完成');
        const html = await (await fetch('/Yosemite/Plan-Your-Trip/Accommodation-Search/Results')).text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const cards = [...doc.querySelectorAll('.panel-rate-result-item')];
        const items = cards.map(p => {
          const hotel = ((p.querySelector('.rate-result-prop-name') || {}).textContent || '').trim();
          const h3s = [...p.querySelectorAll('h3')];
          const roomEl = h3s.find(x => !/rate-result-item-price/.test(x.className || ''));
          const priceEl = p.querySelector('.rate-result-item-price');
          return { hotel, roomType: (roomEl ? roomEl.textContent : '').trim(), price: (priceEl ? priceEl.textContent : '').trim() };
        }).filter(x => x.roomType);
        return JSON.stringify({ items });
      })()`;
      const out = JSON.parse(await cdp.eval(expr, 70000));
      const items = Array.isArray(out.items) ? out.items : [];
      /* 0 个房型可能是页面竞态：非最后一次尝试时视为失败自动重查 */
      if (items.length || attempt === 2) return items;
      lastErr = '结果页 0 个房型（第 ' + (attempt + 1) + ' 次尝试）';
      await sleep(2500);
    } catch (er) { lastErr = er.message; await sleep(1200); }
  }
  throw new Error('明细查询失败: ' + lastErr);
}

/* ---------------- 汇率 / 推送 ---------------- */
async function getFx() {
  try {
    const j = await httpJson('https://open.er-api.com/v6/latest/USD', 8000);
    const r = Number(j && j.rates && j.rates.CNY);
    if (r > 5 && r < 9) return r;
  } catch (e) { }
  return Number(CFG.fxFallback) || 7.1;
}

async function wecomSend(markdown) {
  if (DRY) { console.log('\n----- [dry-run 未发送] -----\n' + markdown + '\n---------------------------\n'); return { ok: true }; }
  if (!HOOK) return { ok: false, error: '未配置 WECOM_WEBHOOK' };
  try {
    const r = await fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'markdown', markdown: { content: markdown } }), signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (j.errcode === 0) return { ok: true };
    return { ok: false, error: `企业微信 ${j.errcode}: ${j.errmsg}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

function buildBlocks(hits, fx) {
  const groups = new Map();
  for (const h of hits) {
    const k = `${h.prop}|${h.checkIn}|${h.checkOut}|${h.guest || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  const blocks = [];
  for (const [, list] of groups) {
    const f0 = list[0];
    const known = list.filter(x => priceNum(x.price) > 0);
    const use = known.length ? known : list;
    const head = [
      `**${HOTEL_EN[f0.prop] || f0.prop} ｜ ${HOTEL_ZH[f0.prop] || ''}**`,
      `> 日期 Date：${f0.checkIn} → ${f0.checkOut}（${f0.nights} 晚）`,
      `> 入住人 Guest：${f0.guest || '未填写'}`,
      `> 房型 Room Types：${use.length} 种（均已可订）`
    ];
    const lines = use.map((f, i) => {
      const usd = priceNum(f.price);
      const cny = usd ? Math.round(usd * fx).toLocaleString() : '';
      const zh = roomZh(f.roomType);
      const p = usd ? `US$${usd.toFixed(2)}/晚 ≈ ¥${cny}/晚` : '价格待官网确认';
      return `> ${i + 1}. ${f.roomType}${zh ? `\n> 　${zh}` : ''} — ${p}`;
    });
    blocks.push(head.concat(lines).join('\n'));
  }
  return blocks;
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const started = Date.now();
  const state = (() => { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { return {}; } })();
  state.notified = state.notified || {};
  state.hits = state.hits || [];
  state.runs = (state.runs || 0) + 1;

  const maxRuntime = (Number(CFG.maxRuntimeSec) || 300) * 1000;
  const guard = setTimeout(() => { console.error('[超时] 超过 ' + maxRuntime / 1000 + ' 秒，强制退出'); process.exit(2); }, maxRuntime);
  guard.unref && guard.unref();

  const tasks = (CFG.tasks || []).filter(t => t.enabled !== false);
  if (!tasks.length) { console.log('config.json 里没有启用的任务'); process.exit(0); }

  let browser = null, cdp = null;
  const hits = [];
  let okCount = 0, failCount = 0;
  try {
    /* 浏览器启动 + 页面就绪，最多试 3 次（网络瞬断时自动重建，不再直接失败） */
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) {
          console.error(`[浏览器] 第 ${attempt}/3 次尝试：关闭旧实例后重建`);
          try { cdp && cdp.ws && cdp.ws.close(); } catch (e) { }
          try { browser && browser.proc && browser.proc.kill('SIGKILL'); } catch (e) { }
          await sleep(3000);
        }
        browser = launchBrowser();
        cdp = await connectCdp();
        await waitReady(cdp, 60000);
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        console.error('[浏览器] ' + e.message + ' → 自动重试');
        await sleep(2000);
      }
    }
    log('[浏览器] 页面就绪');

    /* 1) 每个酒店一次库存请求 */
    const invCache = new Map();   // prop -> Map(date->count)
    for (const t of tasks) {
      const dates = expandDates(t);
      if (!dates.length) { log(`[跳过] ${t.prop} 没有未来日期`); continue; }
      const start = dates[0].checkIn, end = dates[dates.length - 1].checkIn;
      try {
        invCache.set(t.prop, await fetchInventory(cdp, t.prop, start, end));
        okCount++;
      } catch (e) {
        failCount++;
        console.error(`[失败] ${t.prop} 库存: ${e.message}`);
        if (/HTTP 40[0139]|限速/.test(e.message)) console.error('       ↑ 这是官网人机验证/限速，通常因为机房 IP 评分低；可在 config.json 加 "proxy": "http://..." 换住宅代理出口');
      }
    }

    /* 2) 逐日期判定 + 抓明细 */
    let detailBudget = Number(CFG.detailMaxPerRun) || 3;
    for (const t of tasks) {
      const dates = expandDates(t);
      const inv = invCache.get(t.prop);
      if (!inv) continue;
      for (const d of dates) {
        const cnt = inv.get(d.checkIn);
        if (!(cnt > 0)) continue;
        let rooms = [];
        if (CFG.detail !== false && detailBudget > 0) {
          detailBudget--;
          try {
            rooms = await fetchDetail(cdp, t.prop, d.checkIn, d.checkOut, t.adults || 2, t.children || 0, t.rooms || 1);
            log(`[明细] ${t.prop} ${d.checkIn}: ${rooms.length} 个房型`);
          } catch (e) { console.error(`[明细失败] ${t.prop} ${d.checkIn}: ${e.message}`); }
        }
        const base = { prop: t.prop, checkIn: d.checkIn, checkOut: d.checkOut, nights: d.nights, guest: t.guest || '' };
        if (!rooms.length) hits.push({ ...base, roomType: 'Any Available Unit', price: '', remaining: cnt });
        else for (const r of rooms) hits.push({ ...base, roomType: r.roomType, price: r.price });
      }
    }

    /* 3) 价格过滤 + 冷却去重 */
    const fx = await getFx();
    state.fx = fx;
    const cdMs = (Number(CFG.cooldownHours) || 4) * 3600000;
    const fresh = [];
    for (const h of hits) {
      const usd = priceNum(h.price);
      const task = tasks.find(t => t.prop === h.prop) || {};
      const min = Number(task.minPrice) || 0, max = Number(task.maxPrice) || 0;
      if (usd > 0) {
        if (min && usd < min) continue;
        if (max && usd > max) continue;
      }
      const key = `${h.prop}|${h.checkIn}|${h.checkOut}|${h.roomType}`;
      const old = state.notified[key] || 0;
      if (Date.now() - old < cdMs) continue;
      state.notified[key] = Date.now();
      fresh.push(h);
    }

    /* 4) 推送 */
    let sent = 0;
    if (fresh.length) {
      const blocks = buildBlocks(fresh, fx);
      const tail = `\n[👉 立即预订](${START_URL})\n<font color="comment">汇率 1 USD = ${fx.toFixed(3)} CNY · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</font>`;
      const chunks = [];
      let cur = '';
      for (const b of blocks) {
        if ((cur + b).length > 2600 && cur) { chunks.push(cur); cur = ''; }
        cur += (cur ? '\n\n' : '') + b;
      }
      if (cur) chunks.push(cur);
      let okMsg = 0;
      for (let i = 0; i < chunks.length; i++) {
        const title = chunks.length > 1
          ? `## 🏕 Yosemite 有房提醒（${i + 1}/${chunks.length}）`
          : '## 🏕 Yosemite 有房提醒';
        const r = await wecomSend(title + '\n' + chunks[i] + (i === chunks.length - 1 ? tail : ''));
        if (r.ok) okMsg++; else console.error('[推送失败] ' + r.error);
      }
      const names = [...new Set(fresh.map(h => (h.guest || '').trim()).filter(Boolean))];
      if (names.length) {
        const r2 = await wecomSend(names.join('\n'));
        if (!r2.ok) console.error('[姓名推送失败] ' + r2.error);
      }
      sent = fresh.length;
      state.hits = fresh.concat(state.hits).slice(0, 200);
    }

    /* 5) 保存状态 */
    const now = Date.now();
    for (const k of Object.keys(state.notified)) if (now - state.notified[k] > 7 * 86400000) delete state.notified[k];
    state.lastRun = now;
    state.lastResult = { ok: okCount, fail: failCount, hits: hits.length, sent, ms: now - started };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

    const summary = { 库存成功: okCount, 库存失败: failCount, 有房房型: hits.length, 新推送: sent, 汇率: fx, 耗时秒: Math.round((now - started) / 1000) };
    console.log('结果: ' + JSON.stringify(summary));
    console.log(summary.有房房型 ? '✅ 发现房源' : '— 本次无空房');
    if (okCount === 0) {
      console.error('\n--------------------------------------------------');
      console.error('全部酒店查询失败。排查顺序：');
      console.error('  1) 看上面的错误是不是 HTTP 400/403 → 机房 IP 被官网风控，加住宅代理');
      console.error('  2) 页面未就绪 / token 超时 → 网络到 google.com 不稳，重跑一次');
      console.error('  3) 官网维护（ERR: SCHM02）→ 等官方恢复，程序无需改动');
      console.error('--------------------------------------------------\n');
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(guard);
    try { cdp && cdp.ws && cdp.ws.close(); } catch (e) { }
    try { browser && browser.proc && browser.proc.kill('SIGKILL'); } catch (e) { }
    try { browser && browser.profile && fs.rmSync(browser.profile, { recursive: true, force: true }); } catch (e) { }
  }
}

/* ---------------- 自检（不需要网络） ---------------- */
function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); } };

  console.log('\n[1] 日期展开');
  const ds = expandDates({ ranges: [{ from: '2027-06-11', to: '2027-06-14', nights: 1 }] });
  ok('4 个逐日候选', ds.length === 4, JSON.stringify(ds.map(d => d.checkIn)));
  ok('退房日 = 入住日 +1', ds[0] && ds[0].checkOut === '2027-06-12', ds[0] && ds[0].checkOut);
  ok('过去日期被过滤', expandDates({ ranges: [{ from: '2020-01-01', to: '2020-01-05' }] }).length === 0);

  console.log('\n[2] 房型中文');
  ok('Traditional 1 Queen Bed → 传统房 · 1 张大床', /传统房/.test(roomZh('Traditional Room - 1 Queen Bed')) && /1 张大床/.test(roomZh('Traditional Room - 1 Queen Bed')), roomZh('Traditional Room - 1 Queen Bed'));
  ok('Bunk Rooms → 上下铺房', /上下铺房/.test(roomZh('Bunk Rooms - 1 Queen Bed and 1 Bunk Bed')), roomZh('Bunk Rooms - 1 Queen Bed and 1 Bunk Bed'));
  ok('ADA → 无障碍', /无障碍/.test(roomZh('Traditional Room - 1 Queen Bed (ADA Accessible)')), roomZh('Traditional Room - 1 Queen Bed (ADA Accessible)'));

  console.log('\n[3] 推送文案');
  const hits = [
    { prop: 'Y', checkIn: '2026-12-04', checkOut: '2026-12-05', nights: 1, guest: '玉', roomType: 'Traditional Room - 1 Queen Bed', price: '$269.63' },
    { prop: 'Y', checkIn: '2026-12-04', checkOut: '2026-12-05', nights: 1, guest: '玉', roomType: 'Bunk Rooms - 1 Queen Bed and 1 Bunk Bed', price: '$341.70' },
    { prop: 'M', checkIn: '2026-12-30', checkOut: '2027-01-01', nights: 2, guest: 'Cornock / Mark', roomType: 'Any Available Unit', price: '' }
  ];
  const blocks = buildBlocks(hits, 6.67);
  ok('按酒店+日期+入住人聚成 2 组', blocks.length === 2, blocks.length);
  ok('含英文酒店名与中文', /Yosemite Valley Lodge ｜ 优胜美地山谷旅馆/.test(blocks[0]), blocks[0].split('\n')[0]);
  ok('价格换算人民币', /US\$269\.63\/晚 ≈ ¥1,798\/晚/.test(blocks[0]), blocks[0]);
  ok('无价格时标注待确认', /价格待官网确认/.test(blocks[1]), blocks[1]);
  console.log('\n----- 预览 -----\n## 🏕 Yosemite 有房提醒\n' + blocks.join('\n\n') + '\n---------------\n');
  ok('单条 markdown < 4096 字节', Buffer.byteLength(blocks.join('\n\n')) < 4000, Buffer.byteLength(blocks.join('\n\n')));

  console.log('\n[4] 价格与去重');
  const t = { minPrice: 200, maxPrice: 300 };
  const inRange = (usd) => !((t.minPrice && usd < t.minPrice) || (t.maxPrice && usd > t.maxPrice));
  ok('$269 在 200-300 内', inRange(269.63));
  ok('$341 被最大值排除', !inRange(341.70));
  ok('$189 被最小值排除', !inRange(189));

  console.log('\n' + (fail ? `❌ 自检未通过：${pass} 通过 / ${fail} 失败` : `✅ 全部通过（${pass} 项）`));
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else main().catch((e) => { console.error('运行失败: ' + (e && e.stack || e)); process.exit(1); });
