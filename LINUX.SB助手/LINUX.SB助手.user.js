// ==UserScript==
// @name         LINUX.SB助手（二开版）
// @namespace    https://linux.sb/
// @version      3.3.8
// @description  积分分析（今天/昨天/近七天筛选）+ 称号合成统计（仅统计熔炼/合成通知，回收·售出·打赏等自动过滤并计数；消耗稀有度汇总·熔炼所得按名称+级别明细）+ 称号监控（交易市场按价格阈值提醒，10 秒轮询可启停）+ 幸运打赏今日统计（概率估算·回帖解锁·玩家列表·收支），TAB 切换；未监测到用户时三指标显 "-" 且底部提示
// @author       干货助手
// @license      MIT
// @match        https://linux.sb/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      linux.sb
// ==/UserScript==

(function () {
    'use strict';

    /* ================= 配置 ================= */
    var CONFIG = {
        pageDelayMs: 1000,   // 翻页抓取间隔（1 秒一页）
        maxPages: 40,        // 翻页安全上限
        maxTimeline: 200,    // 时间线最多显示的条数
        maxNames: 30,        // 合成所得里最多展示多少种称号
        luckyCap: 10,        // 每日幸运奖励次数上限
        highThreshold: 1000, // 累计获得幸运奖励积分达到该值后概率归 0
        replyCap: 99999,     // 每日必须回帖 N 次才解锁打赏概率（新规则 20953：99999 次后解锁）
        refreshMs: 10 * 60 * 1000, // 定时刷新间隔（仅在面板展开时执行；收起状态跳过）
        marketUrl: 'https://linux.sb/gacha_market?p=1', // 称号监控抓取页（最新发布）
        poolUrl: 'https://linux.sb/gacha',              // 全部称号列表（解析称号种类）
        monitorMs: 10 * 1000, // 称号监控轮询间隔（10 秒）
    };
    var RULE_URL = 'https://linux.sb/topic/20953';
    var STORE_KEY = 'linuxsb-combo-v310';
    var FOLD_KEY = 'linuxsb-combo-fold-v307';
    var MARKET_KEY = 'linuxsb-market-v309';   // 称号监控配置 + 状态（localStorage 持久化）
    var TAB_KEY = 'linuxsb-combo-tab-v309';   // 记住当前激活的 TAB（刷新后保持，不切回默认）
    var RANGE_KEY = 'linuxsb-combo-range-v310'; // 记住积分分析的筛选范围（今天/昨天/近七天）
    var SYN_KEY = 'linuxsb-syn-v332';           // 称号合成解析结果缓存
    var SYN_RANGE_KEY = 'linuxsb-syn-range-v320'; // 称号合成的筛选范围

    // 筛选范围：value -> 展示名 + 抓取下界（往前 N 天，含当天）
    var RANGES = {
        today: { label: '今日', days: 0 },
        yesterday: { label: '昨日', days: 1 },
        week: { label: '近七天', days: 6 },
    };

    // 我打赏别人：捕获玩家名
    var TIP_RE = /^给用户「(.+?)」的主题打赏$/;
    var LUCKY_RE = /幸运(?:打赏)?奖励/;
    var RECEIVED_RE = /^用户「.+?」打赏了你的主题$/;

    // 积分分析的 reason 分类规则
    var RULES = [
        { key: 'donate_out',   label: '打赏用户', re: /^给用户「.+?」的主题打赏$/ },
        { key: 'donate_in',    label: '被打赏',   re: /^用户「.+?」打赏了你的主题$/ },
        { key: 'lucky',        label: '幸运奖励', re: /幸运(?:打赏)?奖励/ },
        { key: 'gacha',        label: '抽奖',     re: /十连抽|百连抽|十抽|抽奖|称号系统/ },
        { key: 'title_buy',    label: '称号购买', re: /购买称号/ },
        { key: 'checkin',      label: '每日签到', re: /每日签到|签到/ },
        { key: 'topic',        label: '发表主题', re: /发表主题/ },
        { key: 'reply',        label: '发表回帖', re: /发表回帖|回帖奖励/ },
        { key: 'search',       label: '搜索',     re: /搜索/ },
        { key: 'direct',       label: '私信',     re: /私信/ },
        { key: 'attachment',   label: '下载附件', re: /附件/ },
    ];

    var widget = null;
    var lastRecords = null;      // 最近一次抓取到的记录（跨多个自然日，供筛选切换时本地重算）
    var lastTimeText = '';       // 最近一次抓取完成时间（切换筛选时沿用）
    var lastUid = null;          // 最近一次抓取的 uid（切换筛选时按需重抓）
    var currentRange = 'today';  // 当前积分分析筛选范围

    // 称号合成统计状态
    var syn = {
        items: null,        // 已解析的通知项 [{time, timeText, consumed:[{rarity,count}], result}]
        range: 'today',     // 当前筛选范围
        timeText: '',       // 抓取完成时间
        loading: false,
        loadedUid: null,    // 已抓取的 uid（同一会话内不重复抓）
        note: '',           // 抓取过程中的提示（如通知无时间字段）
        err: '',            // 错误提示
        filtered: 0,        // 本轮通知里被过滤掉的非合成通知条数
    };
    // 稀有度展示顺序（未知的排最后）
    var RARITY_ORDER = ['UR', 'SSR', 'SR', 'R', 'N'];
    var poolPromise = null;     // /gacha 称号池请求（多处共享，避免重复抓）
    var poolRarityMap = null;   // 称号名 -> 级别（由称号池构建，池刷新后置空重建）
    var poolTriedForSyn = false; // 合成页是否已为「标注级别」触发过称号池加载
    // 通知里「消耗了 N 个 X 称号」的匹配式
    var CONSUME_HINT_RE = /消耗\s*了?\s*[\d,]+\s*个/;
    // 消耗段里的数量对「96 个 R 称号」（一条通知可能并列多组）
    var CONSUME_PAIR_RE = /([\d,]+)\s*个\s*([A-Za-z]+)\s*(?:级)?\s*称号/;
    // 获得段的称号总量「批量熔炼获得 32 个 SR」
    var GAIN_TOTAL_RE = /([\d,]+)\s*个\s*([A-Za-z]+)/;
    // 获得段的明细「万人迷 ×7、论坛之星 ×13」
    var GAIN_ITEM_RE = /([^\s、，,。：:；;×xX*「」“”"]+)\s*[×xX*]\s*([\d,]+)/;
    // 获得段的称号名「获得了「万人迷」称号」；优先取「称号」后紧跟的引号（配方合成：合成了 UR 称号「非必要不抽奖」）
    var GAIN_QUOTED_RE = /[「“"]([^」”"]+)[」”"]/;
    var GAIN_QUOTED_AFTER_TITLE_RE = /称号\s*[「“"]([^」”"]+)[」”"]/;
    // 「称号」前的稀有度「合成了 UR 称号「…」」
    var GAIN_TITLE_RARITY_RE = /([A-Za-z]+)\s*称号\s*[「“"]/;
    var market = {
        config: null,       // { titles:[{keyword,price}], notif/sound/voice:bool, running:bool }
        pool: [],           // 全部称号列表 [{name,rarity}]
        timer: null,        // 轮询定时器
        lastCheck: null,    // 最近一次检查时间戳
        unread: 0,          // 未读提醒数（面板角标）
        audioCtx: null,     // 音频上下文（声音提示，首次用户交互时解锁）
        alerted: {},        // keyword -> {id,text,url,price} 当前生效且展示在横幅的提醒
        notifying: {},      // keyword -> 已通知过的挂单 id（一个挂单只通知一次）
        noLonger: {},       // keyword -> 横幅被用户点掉 / 该挂单已下架，当前不展示
        listed: {},         // keyword -> 本轮见到的达标挂单（下架/涨价时清理 noLonger）
        alertsQueue: [],    // 本次轮询待通知的达标项（每称号最低价一条）
    };

    /* ================= 工具 ================= */

    function delay(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    function getText(url) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { 'Cache-Control': 'no-cache' },
                onload: function (r) {
                    if (r.status >= 200 && r.status < 300) resolve(r.responseText);
                    else reject(new Error('HTTP ' + r.status));
                },
                onerror: function () { reject(new Error('网络错误')); },
            });
        });
    }

    function detectUid() {
        var a = document.querySelector('a.nav-mine[href*="/user/"]');
        if (a) {
            var m = (a.getAttribute('href') || '').match(/\/user\/(\d+)/);
            if (m) return m[1];
        }
        var n = document.querySelector('[data-notifications-url*="/user/"]');
        if (n) {
            var m2 = (n.getAttribute('data-notifications-url') || '').match(/\/user\/(\d+)/);
            if (m2) return m2[1];
        }
        var path = location.pathname.match(/^\/user\/(\d+)/);
        if (path) return path[1];
        return null;
    }

    // 本地时区当天 00:00 往前偏移 offset 天
    function dayStart(offset) {
        var now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (offset || 0));
    }

    // 某时间是否落在筛选范围内（today / yesterday / week）
    function inRange(iso, range) {
        var t = new Date(iso).getTime();
        if (isNaN(t)) return false;
        var r = RANGES[range] || RANGES.today;
        var lower = dayStart(r.days).getTime();
        if (range === 'yesterday') {
            return t >= lower && t < dayStart(0).getTime();
        }
        return t >= lower;
    }

    // 抓取下界：最宽范围（近七天）的起点，一次抓取即可覆盖全部筛选项
    function fetchFloor() {
        var maxDays = 0;
        Object.keys(RANGES).forEach(function (k) {
            if (RANGES[k].days > maxDays) maxDays = RANGES[k].days;
        });
        return dayStart(maxDays).getTime();
    }

    function parseItems(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var out = [];
        doc.querySelectorAll('li.points-rewards-detail').forEach(function (li) {
            var reasonEl = li.querySelector('.points-rewards-reason');
            var timeEl = li.querySelector('.points-rewards-time');
            var bEl = li.querySelector('.points-rewards-change-value b');
            if (!reasonEl || !timeEl) return;
            var deltaRaw = bEl ? bEl.textContent.replace(/[+\s]/g, '') : '0';
            out.push({
                reason: reasonEl.textContent.trim(),
                time: timeEl.getAttribute('datetime') || '',
                delta: parseInt(deltaRaw, 10) || 0,
            });
        });
        return out;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function fmt(n) {
        return (n > 0 ? '+' : '') + n;
    }

    function fmtTime(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    // 跨天时间线：月-日 时:分
    function fmtDayTime(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
            ' ' + fmtTime(iso);
    }

    // 同一天内只显示时:分，跨天补上日期
    function fmtTimeSmart(iso) {
        return inRange(iso, 'today') ? fmtTime(iso) : fmtDayTime(iso);
    }

    function fmtPrice(n) {
        if (typeof n !== 'number' || isNaN(n)) return '–';
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    // 轻提示（面板内短暂显示）
    function toast(msg) {
        var t = widget && widget.querySelector('[data-market-toast]');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('on');
        clearTimeout(t.__tm);
        t.__tm = setTimeout(function () { t.classList.remove('on'); }, 2600);
    }

    function toNum(x) {
        var v = parseInt(String(x).replace(/[^\d-]/g, ''), 10);
        return isNaN(v) ? 0 : v;
    }

    // 自定义事件小工具（称号监控用）
    function on(el, ev, fn) {
        if (el) el.addEventListener(ev, fn);
    }

    /* ================= 采集 ================= */

    // 逐页抓取记录，页与页间隔 1 秒；抓到「近七天」下界即停止（一次抓取覆盖全部筛选项）
    function collectAll(uid) {
        return new Promise(function (resolve, reject) {
            (async function () {
                var records = [];
                var floor = fetchFloor();
                var pages = 0, truncated = false;
                outer:
                for (var p = 1; p <= CONFIG.maxPages; p++) {
                    var html;
                    try {
                        html = await getText('https://linux.sb/user/' + uid + '?tab=points_rewards&p=' + p);
                    } catch (e) {
                        reject(new Error('第 ' + p + ' 页请求失败：' + e.message));
                        return;
                    }
                    var items = parseItems(html);
                    if (!items.length) break;
                    pages = p;
                    var anyKept = false;
                    for (var i = 0; i < items.length; i++) {
                        var t = new Date(items[i].time).getTime();
                        if (isNaN(t) || t < floor) {
                            truncated = true;
                            break outer;
                        }
                        anyKept = true;
                        records.push(items[i]);
                    }
                    if (!anyKept) break;
                    if (p < CONFIG.maxPages) await delay(CONFIG.pageDelayMs);
                }
                resolve({ records: records, pages: pages, truncated: truncated });
            })();
        });
    }

    // 按当前筛选范围过滤已抓取的记录
    function filterRecords(records, range) {
        return records.filter(function (r) { return inRange(r.time, range); });
    }

    // 解析一页回帖列表，返回当页所有回帖的 Unix 秒时间戳
    // 回帖页 DOM：li.post-item 内 <span data-performance-time="秒">相对时间</span>
    function parseReplyTimes(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var times = [];
        doc.querySelectorAll('li.post-item [data-performance-time]').forEach(function (el) {
            var ts = parseInt(el.getAttribute('data-performance-time'), 10);
            if (!isNaN(ts) && ts > 0) times.push(ts);
        });
        return times;
    }

    // Unix 秒时间戳是否属于今天
    function isTodayTs(ts) {
        var d = new Date(ts * 1000);
        if (isNaN(d.getTime())) return false;
        var now = new Date();
        return d.getFullYear() === now.getFullYear() &&
            d.getMonth() === now.getMonth() &&
            d.getDate() === now.getDate();
    }

    // 逐页抓取用户回帖列表，统计今日回帖数（倒序，遇到非今天立即停止）
    function collectReplies(uid) {
        return new Promise(function (resolve, reject) {
            (async function () {
                var count = 0;
                var pages = 0;
                outer:
                for (var p = 1; p <= CONFIG.maxPages; p++) {
                    var html;
                    try {
                        html = await getText('https://linux.sb/user/' + uid + '?tab=replies&p=' + p);
                    } catch (e) {
                        reject(new Error('回帖第 ' + p + ' 页请求失败：' + e.message));
                        return;
                    }
                    var times = parseReplyTimes(html);
                    if (!times.length) break;
                    pages = p;
                    var anyToday = false;
                    for (var i = 0; i < times.length; i++) {
                        if (!isTodayTs(times[i])) break outer; // 倒序：其后都是更早
                        anyToday = true;
                        count++;
                    }
                    if (!anyToday) break;
                    if (p < CONFIG.maxPages) await delay(CONFIG.pageDelayMs);
                }
                resolve(count);
            })();
        });
    }

    /* ============ 称号合成：通知解析 ============ */

    // 解析各种时间表示：unix 秒/毫秒、ISO、YYYY-MM-DD HH:MM、MM-DD HH:MM、相对时间、今天/昨天/前天
    function parseTimeish(raw) {
        if (raw == null) return null;
        var s = String(raw).trim();
        if (!s) return null;
        var now = new Date();

        if (/^\d{9,}$/.test(s)) {
            var n = parseInt(s, 10);
            var d0 = new Date(s.length >= 13 ? n : n * 1000);
            return isNaN(d0.getTime()) ? null : d0;
        }
        var rel = s.match(/^(\d+)\s*(秒|分钟|小时|天)前$/);
        if (rel) {
            var mult = { '秒': 1000, '分钟': 60000, '小时': 3600000, '天': 86400000 }[rel[2]];
            return new Date(now.getTime() - parseInt(rel[1], 10) * mult);
        }
        if (/^(刚刚|刚才|片刻前)/.test(s)) return now;
        var dayWord = s.match(/^(今天|昨天|前天)\s*(\d{1,2})?:?(\d{2})?/);
        if (dayWord) {
            var off = { '今天': 0, '昨天': 1, '前天': 2 }[dayWord[1]];
            var base = dayStart(off);
            if (dayWord[2] != null) base.setHours(parseInt(dayWord[2], 10), parseInt(dayWord[3] || '0', 10), 0, 0);
            return base;
        }
        var md = s.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
        if (md) {
            return new Date(now.getFullYear(), parseInt(md[1], 10) - 1, parseInt(md[2], 10), parseInt(md[3], 10), parseInt(md[4], 10));
        }
        var d = new Date(s.replace(' ', 'T'));
        if (!isNaN(d.getTime())) return d;
        d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    }

    // 时间是否看起来像日期/相对时间（避免把普通 title 当时间解析）
    function looksLikeTime(s) {
        return /(\d{4}-\d{1,2}-\d{1,2})|(\d{1,2}-\d{1,2})|(\d{1,2}:\d{2})|前|刚刚|刚才|今天|昨天|前天/.test(String(s || ''));
    }

    // 在通知项里找时间：优先时间属性，其次 title 属性，最后正文里的时间片段
    function pickItemTime(el) {
        var attrEls = el.querySelectorAll('[datetime],[data-time],[data-timestamp],[data-performance-time]');
        for (var i = 0; i < attrEls.length; i++) {
            var a = attrEls[i];
            var raw = a.getAttribute('datetime') || a.getAttribute('data-time') ||
                a.getAttribute('data-timestamp') || a.getAttribute('data-performance-time');
            var d = parseTimeish(raw);
            if (d) return d;
        }
        var titled = el.querySelectorAll('[title]');
        for (var j = 0; j < titled.length; j++) {
            var tv = titled[j].getAttribute('title');
            if (!looksLikeTime(tv)) continue;
            var d2 = parseTimeish(tv);
            if (d2) return d2;
        }
        var txt = (el.textContent || '').replace(/\s+/g, ' ');
        // 末尾的「刚刚 / 刚才」不能漏：新通知的时间就长这样，漏了会让刚合成的记录
        // 拿不到时间（time 为空）从而被 inRange 挡掉，表现为「刷新了也不更新」
        var m = txt.match(/(\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)|(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})|(\d+(?:秒|分钟|小时|天)前)|((?:今天|昨天|前天)\s*\d{1,2}:\d{2})|(刚刚|刚才|片刻前|此刻)/);
        return m ? parseTimeish(m[0]) : null;
    }

    // 把一条合成通知切成「消耗段」「获得段」，例如：
    // 「你消耗了 96 个 R 称号，批量熔炼获得 32 个 SR：万人迷 ×7、论坛之星 ×13。」
    function synthSplit(text) {
        var s = String(text || '').replace(/\s+/g, ' ');
        var start = s.search(/消耗/);
        if (start === -1) return { consume: '', gain: s };
        var tail = s.slice(start);
        var cut = tail.search(/熔炼|获得|得到|合成/);
        if (cut < 0) return { consume: tail, gain: '' };
        return { consume: tail.slice(0, cut), gain: tail.slice(cut) };
    }

    // 抽「消耗段」里的全部「N 个 X 称号」数量对（可能并列多组，如「96 个 R 称号、162 个 N 称号」）
    function extractConsume(consumeText) {
        var out = [];
        var re = new RegExp(CONSUME_PAIR_RE.source, 'g');
        var text = String(consumeText || '');
        var m;
        while ((m = re.exec(text)) !== null) {
            var cnt = toNum(m[1]);
            var rarity = (m[2] || '').toUpperCase();
            if (cnt > 0 && rarity) out.push({ rarity: rarity, count: cnt });
        }
        return out;
    }

    // 抽「获得段」里的合成所得：总量（32 个 SR）+ 明细（万人迷 ×7、论坛之星 ×13）
    function parseGain(gainText) {
        var out = { total: 0, rarity: '', items: [] };
        var tail = String(gainText || '');
        if (!tail) return out;
        var gm = tail.match(GAIN_TOTAL_RE);
        if (gm) {
            out.total = toNum(gm[1]);
            out.rarity = (gm[2] || '').toUpperCase();
            tail = tail.slice(gm.index + gm[0].length);
        }
        var re = new RegExp(GAIN_ITEM_RE.source, 'g');
        var m;
        while ((m = re.exec(tail)) !== null) {
            var name = m[1].replace(/^[的个\s]+/, '').trim();
            var cnt = toNum(m[2]);
            if (name && cnt > 0) out.items.push({ name: name, count: cnt });
        }
        if (!out.total && out.items.length) {
            out.total = out.items.reduce(function (a, b) { return a + b.count; }, 0);
        }
        if (!out.items.length && /(?:获得|得到|合成|熔炼)/.test(tail) && /称号/.test(tail)) {
            // 形如「合成成功，获得了「万人迷」称号」；要求正文里同时出现获得类动词和「称号」，
            // 否则回复/私信类通知里的「用户「某某」…」会被误当成合成所得
            var qm = tail.match(GAIN_QUOTED_AFTER_TITLE_RE) || tail.match(GAIN_QUOTED_RE);
            if (qm) {
                out.items.push({ name: qm[1], count: out.total || 1 });
                if (!out.total) out.total = 1;
                if (!out.rarity) {
                    var rm = tail.match(GAIN_TITLE_RARITY_RE);
                    var rar = rm ? (rm[1] || '').toUpperCase() : '';
                    if (RARITY_ORDER.indexOf(rar) >= 0) out.rarity = rar;
                }
            }
        }
        return out;
    }

    // 通知类型白名单：只认「批量熔炼」和「UR 配方合成」两类。
    // 通知列表里还混着称号回收、称号售出、打赏、提及、抽奖、赠送、点赞、兑换等，
    // 其中「你回收了 27 个 SSR…」这种能被 GAIN_TOTAL_RE 抽出「27 个 SSR」，
    // 必须在类型这一层就挡掉，否则会被当成合成所得。
    function isSynthNotif(text) {
        var s = String(text || '');
        return /批量熔炼|熔炼获得|熔炼成功|合成了|合成成功/.test(s);
    }

    // 通知列表项：优先站点约定的类名，取不到时按「装着最多合成通知的那个列表」兜底
    function findNotifNodes(doc) {
        var sels = [
            '.notification-list li', 'ul.notifications li', '[class*=notification-item]',
            '[class*=notification] li', '#notifications li',
        ];
        for (var i = 0; i < sels.length; i++) {
            var els = doc.querySelectorAll(sels[i]);
            if (!els.length) continue;
            var arr = [].slice.call(els);
            // 类名可能命中别的列表（分页、侧栏）；里面一条合成通知都没有就继续往下兜底
            if (arr.some(function (x) { return CONSUME_HINT_RE.test(x.textContent || ''); })) return arr;
            break;
        }
        var main = doc.querySelector('main') || doc.body;
        var lis = [].slice.call(main.querySelectorAll('li')).filter(function (li) {
            return (li.textContent || '').trim().length > 8;
        });
        // 兜底：合成通知集中在哪个列表，就返回那个列表的全部兄弟项（含回收/售出/打赏等），
        // 这样过滤统计反映的是真实通知列表，而不只是把合成项单独挑出来
        var groups = [];
        lis.forEach(function (li) {
            if (!CONSUME_HINT_RE.test(li.textContent || '')) return;
            var p = li.parentElement;
            var g = null;
            for (var j = 0; j < groups.length; j++) {
                if (groups[j].p === p) { g = groups[j]; break; }
            }
            if (!g) { g = { p: p, n: 0 }; groups.push(g); }
            g.n++;
        });
        if (groups.length) {
            groups.sort(function (a, b) { return b.n - a.n; });
            var sibs = [].slice.call(groups[0].p.children).filter(function (el) {
                return el.tagName === 'LI' && (el.textContent || '').trim().length > 8;
            });
            if (sibs.length) return sibs;
        }
        return lis;
    }

    // 解析通知列表页：返回该页全部通知项、命中的合成项、页面签名（翻页去重）
    function parseNotifications(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var nodes = findNotifNodes(doc);
        var synth = [];
        var anyTime = false;
        var skipped = 0;

        nodes.forEach(function (box) {
            var text = (box.textContent || '').replace(/\s+/g, ' ').trim();
            if (!isSynthNotif(text)) { skipped++; return; }   // 回收/售出/打赏/提及/抽奖/赠送等一律不计
            var t = pickItemTime(box);
            if (t) anyTime = true;
            var split = synthSplit(text);
            var consumed = extractConsume(split.consume);
            var gain = parseGain(split.gain);
            // 类型对了但正文没解析出消耗/所得（如「熔炼失败」）也不计入
            if (!consumed.length && !gain.total) { skipped++; return; }
            synth.push({
                time: t ? t.toISOString() : '',
                consumed: consumed,
                gain: gain,
                text: text.slice(0, 200),
            });
        });

        var first = nodes.length ? (nodes[0].textContent || '').replace(/\s+/g, ' ').trim() : '';
        return {
            items: synth,
            nodeCount: nodes.length,
            skipped: skipped,
            anyTime: anyTime,
            sig: nodes.length + '#' + first.slice(0, 80),
        };
    }

    // 稀有度排序（UR→N，未知排最后）
    function sortRarity(keys) {
        return keys.slice().sort(function (a, b) {
            var ia = RARITY_ORDER.indexOf(a), ib = RARITY_ORDER.indexOf(b);
            return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
    }

    // 称号名 -> 级别：取 /gacha 称号池（映射表惰性构建），池里没有时用兜底值
    function rarityOf(name, fallback) {
        if (!name) return fallback || '';
        if (!poolRarityMap) {
            poolRarityMap = {};
            (market.pool || []).forEach(function (p) {
                if (p.name && !poolRarityMap[p.name]) poolRarityMap[p.name] = p.rarity || '';
            });
        }
        return poolRarityMap[name] || fallback || '';
    }

    // 按当前筛选范围汇总合成数据
    function analyzeSyn(items, range) {
        var res = {
            events: [], byRarity: {}, rarities: [], total: 0, count: 0, unknownTime: 0,
            gainTotal: 0, gainByRarity: {}, gainRarities: [], gainNames: [], gainKind: 0,
        };
        var names = {};
        items.forEach(function (it) {
            if (!it.time) {
                res.unknownTime++;
                return;
            }
            if (!inRange(it.time, range)) return;
            var sum = 0;
            it.consumed.forEach(function (c) {
                res.byRarity[c.rarity] = (res.byRarity[c.rarity] || 0) + c.count;
                sum += c.count;
            });
            var got = it.gain || { total: 0, rarity: '', items: [] };
            res.total += sum;
            res.count++;
            res.gainTotal += got.total || 0;
            var namedSum = 0;
            (got.items || []).forEach(function (g) {
                // 级别优先用称号池（/gacha）里的级别，池里没有时退回通知里写的批量级别
                var rar = rarityOf(g.name, '') || got.rarity || '';
                var e = names[g.name];
                if (!e) e = names[g.name] = { name: g.name, count: 0, rarity: rar };
                e.count += g.count;
                namedSum += g.count;
                if (rar) res.gainByRarity[rar] = (res.gainByRarity[rar] || 0) + g.count;
            });
            // 通知只写了总量、没写明细的那部分，按批量级别补上
            var rest = (got.total || 0) - namedSum;
            if (rest > 0 && got.rarity) {
                res.gainByRarity[got.rarity] = (res.gainByRarity[got.rarity] || 0) + rest;
            }
            res.events.push({ time: it.time, consumed: it.consumed, sum: sum, gain: got, text: it.text || '' });
        });
        res.events.sort(function (a, b) { return new Date(b.time).getTime() - new Date(a.time).getTime(); });
        res.rarities = sortRarity(Object.keys(res.byRarity));
        res.gainRarities = sortRarity(Object.keys(res.gainByRarity));
        res.gainNames = Object.keys(names).map(function (name) {
            return names[name];
        }).sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            var ia = RARITY_ORDER.indexOf(a.rarity), ib = RARITY_ORDER.indexOf(b.rarity);
            if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            return a.name < b.name ? -1 : 1;
        });
        res.gainKind = res.gainNames.length;
        return res;
    }

    // 逐页抓取通知列表，抓到「近七天」下界 / 无通知项 / 页码重复即停止
    function collectSyn(uid) {
        return new Promise(function (resolve, reject) {
            (async function () {
                var floor = fetchFloor();
                var items = [], note = '';
                var seenSig = {}, anyTime = false;
                var pages = 0, filtered = 0;
                for (var p = 1; p <= CONFIG.maxPages; p++) {
                    var html;
                    try {
                        html = await getText('https://linux.sb/user/' + uid + '?tab=notifications&p=' + p);
                    } catch (e) {
                        reject(new Error('通知第 ' + p + ' 页请求失败：' + e.message));
                        return;
                    }
                    var parsed = parseNotifications(html);
                    if (!parsed.nodeCount) break;               // 没有通知项：已到末页
                    if (seenSig[parsed.sig]) break;             // 分页参数无效导致页码重复
                    seenSig[parsed.sig] = true;
                    pages = p;
                    filtered += parsed.skipped || 0;
                    if (parsed.anyTime) anyTime = true;
                    if (p === 1 && !parsed.anyTime) {           // 通知不带任何可识别时间：无法按时间分档
                        note = '通知列表里没有可识别的时间字段，无法按时间分档（已把全部命中计入「时间未识别」）';
                        parsed.items.forEach(function (it) { items.push(it); });
                        break;
                    }
                    var older = false;
                    parsed.items.forEach(function (it) {
                        if (it.time && new Date(it.time).getTime() < floor) {
                            older = true;
                            return;
                        }
                        items.push(it);
                    });
                    if (older) break;
                    if (p < CONFIG.maxPages) await delay(CONFIG.pageDelayMs);
                }
                resolve({ items: items, pages: pages, note: note, anyTime: anyTime, filtered: filtered });
            })();
        });
    }

    /* ============ 称号监控：解析 ============ */

    // 解析 /gacha 页面的全部称号种类
    // DOM：.gacha-all-item > .gacha-title-badge(.gacha-title-n/r/sr/ssr/ur) > .gacha-title-name + .gacha-title-rarity
    function parsePool(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var out = [];
        doc.querySelectorAll('.gacha-all-item .gacha-title-badge').forEach(function (b) {
            var nameEl = b.querySelector('.gacha-title-name');
            var rarityEl = b.querySelector('.gacha-title-rarity');
            if (!nameEl) return;
            var cls = b.className || '';
            var m = cls.match(/gacha-title-([nrs]r|ssr|ur)/);
            out.push({
                name: nameEl.textContent.trim(),
                rarity: m ? m[1].toUpperCase() : (rarityEl ? rarityEl.textContent.trim() : ''),
            });
        });
        return out;
    }

    // 解析 /gacha_market 页面的挂单列表（最新发布页）
    // DOM：.gacha-market-card > .gacha-market-title(.gacha-title-name + .gacha-title-rarity)
    //                    + .gacha-market-meta（单价/剩余/剩余时间）
    //                    + form.gacha-market-buy[data-gacha-market-title][data-gacha-market-price][data-gacha-market-serial]
    function parseMarket(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var out = [];
        doc.querySelectorAll('.gacha-market-card').forEach(function (card) {
            var form = card.querySelector('.gacha-market-buy');
            var nameEl = card.querySelector('.gacha-market-title .gacha-title-name');
            var rarityEl = card.querySelector('.gacha-market-title .gacha-title-rarity');
            if (!nameEl) return;
            var title = nameEl.textContent.trim();
            var meta = card.querySelector('.gacha-market-meta');
            var price = form ? toNum(form.getAttribute('data-gacha-market-price')) : 0;
            var listingId = form ? form.querySelector('input[name="listing_id"]') : null;
            var stock = 0, timeLeft = '';
            if (meta) {
                var spans = meta.querySelectorAll(':scope > span');
                spans.forEach(function (sp) {
                    var strong = sp.querySelector('strong');
                    var text = sp.textContent.replace(/\s+/g, ' ');
                    if (!strong) return;
                    var v = strong.textContent.trim();
                    if (text.indexOf('单价') !== -1) { if (!price) price = toNum(v); }
                    else if (text.indexOf('剩余') !== -1) stock = toNum(v);
                    else if (text.indexOf('时间') !== -1) timeLeft = v;
                });
            }
            out.push({
                title: title,
                rarity: rarityEl ? rarityEl.textContent.trim() : '',
                price: price,
                stock: stock,
                timeLeft: timeLeft,
                listingId: listingId ? listingId.value : '',
            });
        });
        return out;
    }

    /* ============ 称号监控：配置存储 ============ */

    function loadMarket() {
        try {
            var s = JSON.parse(localStorage.getItem(MARKET_KEY) || 'null');
            if (s && s.titles) {
                market.config = {
                    titles: s.titles.filter(function (t) {
                        return t && t.keyword && String(t.keyword).trim() !== '';
                    }),
                    notif: !!s.notif,
                    sound: s.sound !== false,
                    voice: !!s.voice,
                    running: !!s.running,
                };
                return;
            }
        } catch (e) { /* 忽略 */ }
        market.config = { titles: [], notif: true, sound: true, voice: false, running: false };
    }

    function saveMarket() {
        try {
            localStorage.setItem(MARKET_KEY, JSON.stringify(market.config));
        } catch (e) { /* 忽略 */ }
    }

    /* ============ 称号监控：UI ============ */

    // 渲染右侧监控面板（titleId 为监听项容器）
    function renderMarketPanel() {
        var c = market.config;
        var box = widget.querySelector('[data-market-titles]');
        if (!box || !c) return;

        // 监听项列表
        box.innerHTML = c.titles.length ? c.titles.map(function (t, i) {
            var info = market.pool.find(function (p) { return p.name === t.keyword; });
            var name = info ? info.name : t.keyword;
            var rarity = info ? info.rarity : '';
            var hit = market.alerted[t.keyword]; // 仍生效中的提醒（含直达筛选 URL）
            return '<div class="market-item' + (hit ? ' market-item-hit' : '') + '">' +
                '<span class="market-item-name">' +
                (rarity ? '<b class="market-rarity market-rarity-' + rarity.toLowerCase() + '">' + escapeHtml(rarity) + '</b>' : '') +
                '<span class="market-item-keyword" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>' +
                '</span>' +
                '<span class="market-item-th" title="目标价">≤ ' + fmtPrice(t.price) + '</span>' +
                '<button type="button" class="market-del" data-market-del="' + i + '" title="删除">✕</button>' +
                '</div>';
        }).join('') : '<div class="market-empty">还没有监听项，输入称号名称和期望价格后点击「添加」</div>';

        // 状态行
        var status = widget.querySelector('[data-market-status]');
        var running = c.running && market.timer;
        var active = c.titles.filter(function (t) { return market.alerted[t.keyword]; }).length;
        status.textContent = market.lastCheck
            ? (running ? '● 监控中 · ' : '○ 已停止 · ') + '上次检查 ' + fmtTime(new Date(market.lastCheck).toISOString()) + ' · 每 ' + (CONFIG.monitorMs / 1000) + ' 秒' + (active ? ' · ' + active + ' 个命中' : '')
            : (running ? '● 监控中 · 尚未检查' : '○ 已停止');
        status.classList.toggle('market-status-hit', active > 0);

        // 快照（仅展示有挂单的监听项）
        var snap = widget.querySelector('[data-market-snap]');
        var rows = widget.querySelectorAll('.market-snap-row');
        if (rows.length) {
            var hits = [];
            rows.forEach(function (r) {
                var kw = r.getAttribute('data-market-kw');
                if (kw && c.titles.some(function (t) { return t.keyword === kw; })) hits.push(r);
            });
            snap.innerHTML = hits.map(function (r) { return r.outerHTML; }).join('');
        }

        // 开始/停止按钮文案
        var toggle = widget.querySelector('[data-market-toggle]');
        if (toggle) toggle.textContent = running ? '⏸ 停止监控' : '▶ 开始监控';

        // 添加按钮始终可点（先添加、后开始监控）
        var addBtn = widget.querySelector('[data-market-add]');
        if (addBtn) addBtn.disabled = false;
    }

    // 刷新监听项下拉提示（datelist）
    function renderPoolDatalist() {
        var dl = widget.querySelector('[data-market-pool]');
        if (!dl) return;
        dl.innerHTML = market.pool.map(function (p) {
            return '<option value="' + escapeHtml(p.name) + '" data-rarity="' + escapeHtml(p.rarity) + '"></option>';
        }).join('');
    }

    // 重新采集全部称号名称（/gacha），更新下拉提示；失败时 toast 提示
    function refreshPool(manual) {
        if (manual) {
            var btn = widget.querySelector('[data-market-refresh-pool]');
            if (btn) { btn.disabled = true; btn.textContent = '采集中…'; }
        }
        getText(CONFIG.poolUrl).then(function (html) {
            market.pool = parsePool(html);
            poolRarityMap = null;
            renderPoolDatalist();
            toast('已刷新称号列表，共 ' + market.pool.length + ' 种');
            if (manual) {
                var btn2 = widget.querySelector('[data-market-refresh-pool]');
                if (btn2) { btn2.disabled = false; btn2.textContent = '刷新称号列表'; }
            }
        }).catch(function (e) {
            toast('称号列表刷新失败：' + e.message);
            if (manual) {
                var btn3 = widget.querySelector('[data-market-refresh-pool]');
                if (btn3) { btn3.disabled = false; btn3.textContent = '刷新称号列表'; }
            }
        });
    }

    // 快照：记录「某监听项关键字出现的挂单」行（供循环复用）
    function upsertSnapshotRow(item) {
        var snap = widget.querySelector('[data-market-snap]');
        if (!snap) return;
        var old = snap.querySelector('[data-market-kw="' + item.keyword + '"]');
        var html = '<div class="market-snap-row" data-market-kw="' + item.keyword + '">' +
            '<span class="market-snap-name" title="' + escapeHtml(item.title) + '">' + escapeHtml(item.title) + '</span>' +
            '<span class="market-snap-meta">' + fmtPrice(item.price) + ' 分 · 剩 ' + item.stock + ' · ' + escapeHtml(item.timeLeft || '') + '</span>' +
            '<a class="market-snap-go" href="/gacha_market" target="_blank" rel="noopener">去购买</a>' +
            '</div>';
        if (old) old.outerHTML = html;
        else snap.insertAdjacentHTML('beforeend', html);
    }

    // 显示醒目提示横幅（价格达标）
    function showMarketAlert(items, sticky) {
        var banner = widget.querySelector('[data-market-alert]');
        if (!banner) return;
        banner.innerHTML = '<span>' + items.map(function (a) { return a.text; }).join('<br>') + '</span>' +
            '<button type="button" class="market-alert-close" title="我知道了（本次忽略）">✕</button>';
        banner.classList.add('market-alert-on');
        if (sticky) {
            widget.classList.add('market-alert-pulse');
        }
        hookAlertClose();
    }

    function hideMarketAlert() {
        var banner = widget.querySelector('[data-market-alert]');
        if (!banner) return;
        banner.innerHTML = '';
        banner.classList.remove('market-alert-on');
        widget.classList.remove('market-alert-pulse');
    }

    // 横幅 X 关闭：本次忽略该称号，直到该挂单下架/涨价才重新提醒
    // 每次重绘后都需重新绑定（按钮是新的 DOM 节点）
    function hookAlertClose() {
        var banner = widget.querySelector('[data-market-alert]');
        if (!banner) return;
        var btn = banner.querySelector('.market-alert-close');
        if (!btn) return;
        on(btn, 'click', function () {
            market.config.titles.forEach(function (t) { market.noLonger[t.keyword] = true; });
            market.alertsQueue = []; // 取消本轮排队
            hideMarketAlert();
            renderMarketPanel();
            saveMarket();
        });
    }

    // 达标挂单描述 + 直达筛选页 URL
    function buildAlert(w, listing) {
        var url = 'https://linux.sb/gacha_market?a=gacha_market&q=' + encodeURIComponent(w.keyword) + '&rarity=&sort=price_asc';
        return {
            url: url,
            text: marketLinkHtml(listing.title || w.keyword, url, listing.price, w.price, listing.stock, listing.timeLeft),
        };
    }

    // 横幅内「称号名 → 快去买」为一个可点击链接
    function marketLinkHtml(name, url, price, target, stock, timeLeft) {
        var display = name + ' 单价 ' + fmtPrice(price) + ' 分（≤ 目标 ' + fmtPrice(target) + '）· 剩余 ' + stock + ' 个 · ' + (timeLeft || '');
        return '<a href="' + url + '" target="_blank" rel="noopener" title="点击打开" class="market-alert-link">🎯 ' + escapeHtml(display) + ' → 快去买</a>';
    }

    /* ============ 称号监控：轮询 ============ */

    function marketTick() {
        if (!market.config || !market.config.running) return;
        var seq = (market.__seq || 0) + 1;
        market.__seq = seq;
        getText(CONFIG.marketUrl).then(function (html) {
            if (!market.config || !market.config.running || market.__seq !== seq) return; // 已停止或过期
            var listings = parseMarket(html);
            market.lastCheck = Date.now();

            // 本轮命中：keyword -> 最低价达标挂单
            var hits = {};

            // 每个监听项：只匹配关键字，选出最低价达标挂单
            market.config.titles.forEach(function (w) {
                var k = w.keyword;
                var cands = [];
                listings.forEach(function (it) {
                    if ((it.title || '').indexOf(k) !== -1 && it.price > 0 && it.price <= w.price) {
                        cands.push(it);
                    }
                });
                // 最低价优先（同价取剩余最少的）
                cands.sort(function (a, b) {
                    return a.price - b.price || a.stock - b.stock;
                });
                hits[k] = cands[0] || null;
            });

            // 已达标但最新页面已无该关键字的挂单（被买走/下架）→ 清理
            Object.keys(market.alerted).forEach(function (kw) {
                var still = market.config.titles.some(function (t) { return t.keyword === kw; });
                if (!still) return;
                if (!hits[kw]) {
                    delete market.alerted[kw];
                    delete market.noLonger[kw];
                }
            });

            // 逐监听项决定：新通知 / 维持 / 关闭（被买走则页面提示消失）
            market.config.titles.forEach(function (w) {
                var best = hits[w.keyword];
                market.listed[w.keyword] = best ? [best] : [];

                if (!best) {
                    // 无挂单（下架/被买走）→ 关闭该称号的所有提醒，且清除「已忽略」标记，允许以后重新提醒
                    delete market.alerted[w.keyword];
                    delete market.notifying[w.keyword];
                    delete market.noLonger[w.keyword];
                    removeSnapshotRow(w.keyword);
                    return;
                }

                // 已达标的当前挂单
                var cur = market.alerted[w.keyword];
                var key = best.listingId || (best.title + '@' + best.price);

                // 用户点过 X 忽略，且该挂单还没下架/涨价 → 保持静默，不再提醒
                if (market.noLonger[w.keyword] && cur && cur.id === key) {
                    return;
                }

                if (cur && cur.id === key) {
                    // 已提醒且未消失：不再重复通知
                    return;
                }

                // 新达标（或价格变低）
                var alertObj = buildAlert(w, best);
                market.alerted[w.keyword] = { id: key, text: alertObj.text, url: alertObj.url, price: best.price };
                // 只通知一次（同挂单不重复）；只有首次达标才入队推送
                if (market.notifying[w.keyword] !== key) {
                    market.notifying[w.keyword] = key;
                    market.noLonger[w.keyword] = false;
                    market.alertsQueue.push(alertObj);
                }
            });

            // 汇总本轮新通知（每个称号只通知最低价一条）
            var alerts = market.alertsQueue.splice(0, market.alertsQueue.length);
            // 始终重绘横幅：命中项保留（alerted 里都是仍然在售的），下架/被买走的自动消失
            var live = [];
            market.config.titles.forEach(function (w) {
                var a = market.alerted[w.keyword];
                if (a) live.push({ text: a.text, url: a.url });
            });
            if (live.length) {
                showMarketAlert(live, false);
            } else {
                hideMarketAlert();
            }
            if (alerts.length) {
                // 文本形式（桌面通知/语音用）
                if (market.config.notif) {
                    try {
                        GM_notification({
                            title: 'LINUX.SB 称号降价提醒',
                            text: alerts.map(function (a) {
                                return a.url ? '🎯 ' + a.url : a.text;
                            }).join('\n'),
                            timeout: 15000,
                            onclick: function () { window.open('https://linux.sb/gacha_market'); },
                        });
                    } catch (e) { /* 忽略 */ }
                }
                // 备选提示：声音蜂鸣 + 语音播报（不依赖通知权限，用户收不到通知也能听到提示）
                if (market.config.sound) {
                    beep(3, 0.45);
                    if (market.config.voice) speak('有称号降价到目标价了，快去看看！');
                }
                markUnread(); // TAB 角标 +1
            }
            renderMarketPanel();
        }).catch(function (e) {
            market.lastCheck = Date.now();
            var banner = widget.querySelector('[data-market-alert]');
            if (banner) {
                banner.innerHTML = '<span>检查失败：' + escapeHtml(e.message) + '</span>';
                banner.classList.add('market-alert-on');
            }
        });
    }

    function startMonitor() {
        if (!market.config) return;
        market.config.running = true;
        if (market.timer) clearInterval(market.timer);
        market.timer = setInterval(marketTick, CONFIG.monitorMs);
        marketTick(); // 立即检查一次
        saveMarket();
        renderMarketPanel();
    }

    function stopMonitor() {
        if (!market.config) return;
        market.config.running = false;
        if (market.timer) { clearInterval(market.timer); market.timer = null; }
        saveMarket();
        renderMarketPanel();
    }

    function toggleMonitor() {
        if (!market.config) return;
        // 开始监控前先解锁音频（浏览器要求用户手势后才能出声）
        if (!market.config.running) ensureAudio();
        if (market.config.running) stopMonitor();
        else startMonitor();
    }

    /* ---------- 备选提示方案 ---------- */

    // 声音提示：蜂鸣（不依赖通知权限，属官方 GM 能力但无需授权弹出窗口）
    function beep(times, gap) {
        var ctx = market.audioCtx;
        if (!ctx) return;
        var gain = ctx.createGain();
        gain.connect(ctx.destination);
        var t0 = ctx.currentTime + 0.05;
        for (var i = 0; i < times; i++) {
            var osc = ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.setValueAtTime(880, t0);     // A5
            osc.frequency.setValueAtTime(1108.73, t0 + 0.08); // C#6
            osc.connect(gain);
            gain.gain.setValueAtTime(0.0001, t0);
            gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
            gain.gain.setValueAtTime(0.25, t0 + 0.14);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
            osc.start(t0);
            osc.stop(t0 + 0.2);
            t0 += gap;
        }
    }

    // 首次用户交互时解锁音频上下文
    function ensureAudio() {
        if (market.audioCtx) {
            if (market.audioCtx.state === 'suspended') market.audioCtx.resume();
            return;
        }
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        market.audioCtx = new AC();
        try { market.audioCtx.resume(); } catch (e) { /* 忽略 */ }
    }

    // 语音播报：TTS 朗读命中内容（不依赖任何授权/通知权限）
    function speak(text) {
        try {
            if (!('speechSynthesis' in window)) return;
            window.speechSynthesis.cancel();
            var u = new SpeechSynthesisUtterance(text);
            u.lang = 'zh-CN';
            u.rate = 1;
            u.volume = 1;
            window.speechSynthesis.speak(u);
        } catch (e) { /* 忽略 */ }
    }

    // 已命中提醒：未读累计（顶部 TAB 角标闪烁）
    function markUnread() {
        market.unread++;
        var badge = widget.querySelector('[data-tab-badge]');
        if (!badge) return;
        badge.textContent = market.unread > 99 ? '99+' : String(market.unread);
        badge.classList.add('on');
    }

    // 初次加载称号种类列表（/gacha），解析后填入下拉；同一次加载共享同一个请求
    function loadPool() {
        if (!poolPromise) {
            poolPromise = getText(CONFIG.poolUrl).then(function (html) {
                market.pool = parsePool(html);
                poolRarityMap = null;
                renderPoolDatalist();
            }).catch(function () { /* 失败不阻塞 */ });
        }
        return poolPromise;
    }

    /* ================= 面板 ================= */

    function buildWidget(uid) {
        var el = document.createElement('div');
        el.id = 'linuxsb-combo';
        el.innerHTML =
            '<div class="combo-head">' +
            '  <div class="combo-head-top">' +
            '    <strong class="combo-title">💎 LINUX.SB助手</strong>' +
            '    <button type="button" class="combo-fold" data-combo-fold title="收起/展开" aria-label="收起/展开">⬇️</button>' +
            '  </div>' +
            '  <div class="combo-head-authors">' +
            '    <a class="combo-author" href="https://linux.sb/user/313" target="_blank" rel="noopener" title="原作者：豆包本包">原作者</a>' +
            '    <a class="combo-author combo-author-2" href="https://linux.sb/user/13467" target="_blank" rel="noopener" title="二开作者：Evanders">二开作者</a>' +
            '  </div>' +
            '</div>' +
            '<div class="combo-tabs">' +
            '  <button type="button" class="combo-tab" data-tab="points" title="积分分析">📊 积分</button>' +
            '  <button type="button" class="combo-tab" data-tab="syn" title="称号合成统计">🧬 合成</button>' +
            '  <button type="button" class="combo-tab" data-tab="market" title="称号监控">📡 称号<span class="combo-tab-badge" data-tab-badge hidden></span></button>' +
            '  <button type="button" class="combo-tab" data-tab="lucky" title="幸运打赏">🎁 打赏</button>' +
            '</div>' +
            '<div class="combo-body">' +
            '  <div class="market-toast" data-market-toast></div>' +
            /* ---- 积分分析面板 ---- */
            '  <div class="combo-pane" data-pane="points">' +
            '    <div class="pda-filter" data-pda-filter>' +
            '      <button type="button" class="pda-filter-btn" data-range="today">今天</button>' +
            '      <button type="button" class="pda-filter-btn" data-range="yesterday">昨天</button>' +
            '      <button type="button" class="pda-filter-btn" data-range="week">近七天</button>' +
            '    </div>' +
            '    <div class="pda-concl" data-pda-concl>' +
            '      <div class="pda-concl-row"><span data-pda-cap="收入">今日收入</span><b class="pda-in" data-pda-in>–</b></div>' +
            '      <div class="pda-concl-row"><span data-pda-cap="支出">今日支出</span><b class="pda-out" data-pda-out>–</b></div>' +
            '      <div class="pda-concl-row"><span data-pda-cap="净变化">今日净变化</span><b class="pda-net" data-pda-net>–</b></div>' +
            '    </div>' +
            '    <div class="pda-section" data-pda-exp-section hidden>' +
            '      <div class="pda-section-cap">支出占比</div>' +
            '      <div class="pda-bars" data-pda-bars></div>' +
            '    </div>' +
            '    <div class="pda-section" data-pda-detail hidden>' +
            '      <div class="pda-section-cap">收支明细</div>' +
            '      <div class="pda-detail-cols">' +
            '        <div class="pda-col"><div class="pda-col-cap pda-col-in">收入</div><ul class="pda-list" data-pda-inc></ul></div>' +
            '        <div class="pda-col"><div class="pda-col-cap pda-col-out">支出</div><ul class="pda-list" data-pda-exp></ul></div>' +
            '      </div>' +
            '    </div>' +
            '    <div class="pda-section" data-pda-tl-section hidden>' +
            '      <div class="pda-section-cap">时间线<span class="pda-tl-count" data-pda-tl-count></span></div>' +
            '      <div class="pda-timeline" data-pda-timeline></div>' +
            '    </div>' +
            '    <div class="pda-msg" data-pda-msg hidden></div>' +
            '    <div class="combo-foot">' +
            '      <button type="button" class="combo-link" data-pda-refresh>刷新</button>' +
            '      <a class="combo-link" href="/user/' + uid + '?tab=points_rewards" target="_blank">积分明细</a>' +
            '      <span class="combo-time" data-pda-time></span>' +
            '    </div>' +
            '  </div>' +
            /* ---- 幸运打赏面板 ---- */
            '  <div class="combo-pane" data-pane="lucky" hidden>' +
            '    <div class="ldm-prob" data-ldm-prob>' +
            '      <span class="ldm-prob-label">下次打赏中奖率</span>' +
            '      <b class="ldm-prob-num">–</b>' +
            '      <span class="ldm-prob-note">–</span>' +
            '    </div>' +
            '    <div class="ldm-grid">' +
            '      <div class="ldm-card">' +
            '        <b class="ldm-num" data-ldm-tips>–</b>' +
            '        <span class="ldm-cap">今日打赏</span>' +
            '        <small class="ldm-sub" data-ldm-spent>–</small>' +
            '      </div>' +
            '      <div class="ldm-card">' +
            '        <b class="ldm-num ldm-lucky" data-ldm-lucky>–</b>' +
            '        <span class="ldm-cap">幸运奖励</span>' +
            '        <small class="ldm-sub" data-ldm-gained>–</small>' +
            '      </div>' +
            '    </div>' +
            '    <div class="ldm-players" data-ldm-players hidden>' +
            '      <span class="ldm-players-cap" data-ldm-players-cap></span>' +
            '      <div class="ldm-players-list" data-ldm-players-list></div>' +
            '    </div>' +
            '    <div class="ldm-balance" data-ldm-balance>–</div>' +
            '    <div class="combo-foot">' +
            '      <button type="button" class="combo-link" data-ldm-refresh>刷新</button>' +
            '      <a class="combo-link" href="' + RULE_URL + '" target="_blank" rel="noopener">规则</a>' +
            '      <a class="combo-link" href="/user/' + uid + '?tab=points_rewards" target="_blank">明细</a>' +
            '      <span class="combo-time" data-ldm-time></span>' +
            '    </div>' +
            '  </div>' +
            /* ---- 称号监控面板 ---- */
            '  <div class="combo-pane" data-pane="market" hidden>' +
            '    <div class="market-alert" data-market-alert hidden></div>' +
            '    <div class="market-notif-opts">' +
            '      <label class="market-notif"><input type="checkbox" data-market-notif> 桌面通知</label>' +
            '      <label class="market-notif"><input type="checkbox" data-market-sound> 声音提示</label>' +
            '      <label class="market-notif"><input type="checkbox" data-market-voice> 语音播报</label>' +
            '    </div>' +
            '    <div class="market-add">' +
            '      <input type="text" class="market-input market-input-name" data-market-name list="market-pool-list" placeholder="称号名称（支持部分匹配）" autocomplete="off">' +
            '      <input type="number" class="market-input market-input-price" data-market-price placeholder="期望价格≤" min="1">' +
            '      <button type="button" class="combo-link market-add-btn" data-market-add>添加</button>' +
            '    </div>' +
            '    <datalist id="market-pool-list" data-market-pool></datalist>' +
            '    <div class="market-titles" data-market-titles></div>' +
            '    <div class="market-controls">' +
            '      <button type="button" class="combo-link" data-market-toggle>▶ 开始监控</button>' +
            '      <button type="button" class="combo-link" data-market-refresh-pool>刷新称号列表</button>' +
            '    </div>' +
            '    <div class="market-status" data-market-status>–</div>' +
            '    <div class="market-snap-cap">最新挂单快照</div>' +
            '    <div class="market-snap" data-market-snap></div>' +
            '  </div>' +
            /* ---- 称号合成统计面板 ---- */
            '  <div class="combo-pane" data-pane="syn" hidden>' +
            '    <div class="pda-filter" data-syn-filter>' +
            '      <button type="button" class="pda-filter-btn" data-range="today">今天</button>' +
            '      <button type="button" class="pda-filter-btn" data-range="yesterday">昨天</button>' +
            '      <button type="button" class="pda-filter-btn" data-range="week">近七天</button>' +
            '    </div>' +
            '    <div class="syn-concl">' +
            '      <div class="syn-card"><b class="syn-num" data-syn-count>–</b><span>合成次数</span></div>' +
            '      <div class="syn-card"><b class="syn-num" data-syn-total>–</b><span>消耗称号</span></div>' +
            '      <div class="syn-card"><b class="syn-num" data-syn-gain>–</b><span>获得称号</span></div>' +
            '    </div>' +
            '    <div class="pda-section" data-syn-rarity-section hidden>' +
            '      <div class="pda-section-cap">各稀有度消耗数量</div>' +
            '      <div class="pda-bars" data-syn-bars></div>' +
            '    </div>' +
            '    <div class="pda-section" data-syn-result-section hidden>' +
            '      <div class="pda-section-cap">合成所得<span class="pda-tl-count" data-syn-result-cap></span></div>' +
            '      <div class="pda-bars" data-syn-result-bars></div>' +
            '      <div class="pda-namelist" data-syn-names></div>' +
            '    </div>' +
            '    <div class="pda-section" data-syn-tl-section hidden>' +
            '      <div class="pda-section-cap">合成明细<span class="pda-tl-count" data-syn-tl-count></span></div>' +
            '      <div class="pda-timeline" data-syn-timeline></div>' +
            '    </div>' +
            '    <div class="pda-msg" data-syn-msg hidden></div>' +
            '    <div class="syn-filtered" data-syn-filtered hidden></div>' +
            '    <div class="combo-foot">' +
            '      <button type="button" class="combo-link" data-syn-refresh>刷新</button>' +
            '      <a class="combo-link" href="/user/' + uid + '?tab=notifications" target="_blank" rel="noopener">通知列表</a>' +
            '      <span class="combo-time" data-syn-time></span>' +
            '    </div>' +
            '  </div>' +
            '</div>';

        document.body.appendChild(el);
        widget = el; // 先挂到全局，确保 buildWidget 内 setTab(默认第二个 tab) 时 renderMarketPanel 可用 widget

        // 折叠（状态持久化：收起后刷新/重开页面仍保持收起）
        function setFold(folded) {
            el.classList.toggle('combo-folded', folded);
            el.querySelector('[data-combo-fold]').textContent = folded ? '⬆️' : '⬇️';
            try {
                localStorage.setItem(FOLD_KEY, folded ? '1' : '0');
            } catch (e) { /* 忽略 */ }
        }
        el.querySelector('[data-combo-fold]').addEventListener('click', function () {
            setFold(!el.classList.contains('combo-folded'));
        });

        // TAB 切换
        var tabs = el.querySelectorAll('.combo-tab');
        var panes = el.querySelectorAll('.combo-pane');
        function setTab(t) {
            var target = t.getAttribute('data-tab');
            tabs.forEach(function (x) { x.classList.toggle('combo-tab-active', x === t); });
            panes.forEach(function (p) {
                p.hidden = p.getAttribute('data-pane') !== target;
            });
            if (target === 'market') {
                renderMarketPanel();
                // 打开称号监控页时清零未读角标
                market.unread = 0;
                var badge = widget.querySelector('[data-tab-badge]');
                if (badge) badge.classList.remove('on');
            }
            if (target === 'syn') ensureSyn(); // 首次打开时按需抓取通知
            try { localStorage.setItem(TAB_KEY, target); } catch (e) { /* 忽略 */ }
        }
        tabs.forEach(function (t) {
            t.addEventListener('click', function () { setTab(t); });
        });
        // 默认：恢复上次激活的 TAB；无记录则第一个（积分分析）
        // 注意：buildWidget 返回 el 前就会执行 setTab，此时 widget 尚未被 start() 赋值，
        // 因此 setTab 内 renderMarketPanel 会取到 null → 需要全局 widget 在 setTab 前就绪（已在 append 后赋值）
        var savedTab = null;
        try { savedTab = localStorage.getItem(TAB_KEY); } catch (e) { /* 忽略 */ }
        var defaultTab = null;
        tabs.forEach(function (t) { if (t.getAttribute('data-tab') === savedTab) defaultTab = t; });
        setTab(defaultTab || tabs[0]);

        // 刷新按钮
        el.querySelector('[data-ldm-refresh]').addEventListener('click', function () {
            refreshData(detectUid() || '0', true);
        });
        el.querySelector('[data-pda-refresh]').addEventListener('click', function () {
            refreshData(detectUid() || '0', true);
        });

        /* ---- 积分分析：筛选范围 ---- */

        // 恢复上次选择的范围（默认今天）
        try {
            var savedRange = localStorage.getItem(RANGE_KEY);
            if (savedRange && RANGES[savedRange]) currentRange = savedRange;
        } catch (e) { /* 忽略 */ }
        el.querySelectorAll('[data-pda-filter] .pda-filter-btn').forEach(function (b) {
            b.classList.toggle('pda-filter-on', b.getAttribute('data-range') === currentRange);
            b.addEventListener('click', function () { setRange(b.getAttribute('data-range')); });
        });
        applyScopeLabels();

        /* ---- 称号合成：筛选范围 / 刷新 / 诊断 ---- */

        el.querySelectorAll('[data-syn-filter] .pda-filter-btn').forEach(function (b) {
            b.classList.toggle('pda-filter-on', b.getAttribute('data-range') === syn.range);
            b.addEventListener('click', function () { setSynRange(b.getAttribute('data-range')); });
        });
        renderSyn();

        on(el.querySelector('[data-syn-refresh]'), 'click', function () {
            loadSyn(lastUid, true);
        });

        /* ---- 称号监控控件 ---- */

        // 添加监听项（未开始时也能添加/配置，点开始后才轮询）
        on(el.querySelector('[data-market-add]'), 'click', function () {
            var nameEl = el.querySelector('[data-market-name]');
            var priceEl = el.querySelector('[data-market-price]');
            var kw = (nameEl.value || '').trim();
            var price = toNum(priceEl.value);
            if (!kw) { nameEl.focus(); return; }
            if (price <= 0) { priceEl.focus(); return; }
            var exists = market.config.titles.some(function (t) { return t.keyword === kw; });
            if (exists) {
                // 已存在：更新价格
                market.config.titles.forEach(function (t) { if (t.keyword === kw) t.price = price; });
            } else {
                market.config.titles.push({ keyword: kw, price: price });
            }
            nameEl.value = '';
            priceEl.value = '';
            saveMarket();
            renderMarketPanel();
        });

        // Enter 快捷添加
        on(el.querySelector('[data-market-name]'), 'keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); el.querySelector('[data-market-add]').click(); }
        });
        on(el.querySelector('[data-market-price]'), 'keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); el.querySelector('[data-market-add]').click(); }
        });

        // 删除监听项（事件委托）
        el.querySelector('[data-market-titles]').addEventListener('click', function (e) {
            var btn = e.target.closest('[data-market-del]');
            if (!btn) return;
            var i = toNum(btn.getAttribute('data-market-del'));
            var kw = market.config.titles[i] ? market.config.titles[i].keyword : '';
            if (kw) {
                market.config.titles.splice(i, 1);
                delete market.alerted[kw];
                delete market.notifying[kw];
                delete market.noLonger[kw];
                removeSnapshotRow(kw);
                saveMarket();
                renderMarketPanel();
            }
        });

        // 开始/停止
        on(el.querySelector('[data-market-toggle]'), 'click', function () {
            ensureAudio(); // 解锁音频
            toggleMonitor();
        });

        // 刷新称号列表（重新采集 /gacha 的全部称号名称）
        on(el.querySelector('[data-market-refresh-pool]'), 'click', function () {
            refreshPool(true);
        });

        // 声音/语音开关
        on(el.querySelector('[data-market-sound]'), 'change', function () {
            if (!market.config) return;
            market.config.sound = this.checked;
            saveMarket();
        });
        on(el.querySelector('[data-market-voice]'), 'change', function () {
            if (!market.config) return;
            market.config.voice = this.checked;
            saveMarket();
        });

        // 点击面板任意处也解锁音频（方便直接点开始后第一次触发即可出声）
        on(el, 'pointerdown', function () { ensureAudio(); });

        // 拖动（排除链接/按钮，保证作者链接可点击）
        var head = el.querySelector('.combo-head');
        var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
        head.addEventListener('pointerdown', function (e) {
            if (e.target.closest('a, button')) return; // 链接 / 按钮不触发拖动
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            var rect = el.getBoundingClientRect();
            ox = rect.left; oy = rect.top;
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            var nx = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, ox + e.clientX - sx));
            var ny = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, oy + e.clientY - sy));
            el.style.left = nx + 'px';
            el.style.top = ny + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        });
        head.addEventListener('pointerup', function () { dragging = false; });
        return el;
    }

    /* ================= 渲染 ================= */

    // 三个指标标题跟随筛选范围，返回当前范围展示名
    function applyScopeLabels() {
        var cap = (RANGES[currentRange] || RANGES.today).label;
        if (widget) {
            widget.querySelectorAll('[data-pda-cap]').forEach(function (el) {
                el.textContent = cap + el.getAttribute('data-pda-cap');
            });
        }
        return cap;
    }

    function renderLucky(stats, timeText, err, repliesToday) {
        if (!widget) return;
        var probEl = widget.querySelector('[data-ldm-prob]');
        var probNum = probEl.querySelector('.ldm-prob-num');
        var probNote = probEl.querySelector('.ldm-prob-note');
        var tipsEl = widget.querySelector('[data-ldm-tips]');
        var spentEl = widget.querySelector('[data-ldm-spent]');
        var luckyEl = widget.querySelector('[data-ldm-lucky]');
        var gainedEl = widget.querySelector('[data-ldm-gained]');
        var balanceEl = widget.querySelector('[data-ldm-balance]');
        var playersBox = widget.querySelector('[data-ldm-players]');
        var playersCap = widget.querySelector('[data-ldm-players-cap]');
        var playersList = widget.querySelector('[data-ldm-players-list]');

        if (err) {
            probNum.textContent = '–';
            probNote.textContent = '';
            probEl.className = 'ldm-prob';
            tipsEl.textContent = '–';
            spentEl.textContent = '–';
            luckyEl.textContent = '–';
            gainedEl.textContent = '–';
            balanceEl.textContent = err;
            balanceEl.className = 'ldm-balance ldm-err';
            playersBox.hidden = true;
        } else if (stats) {
            var p = estimateProb(stats, repliesToday);
            if (p.locked) {
                // 锁定状态：显示「已下架」，概率置灰，锁下面小字显示回帖进度
                probNum.textContent = '🔒 已下架';
                probNote.textContent = p.note;
                probEl.className = 'ldm-prob ldm-prob-locked';
            } else {
                probNum.textContent = (p.prob > 0 ? '约 ' : '') + p.prob + '%';
                probNote.textContent = p.mult === '不触发' ? p.note : '倍率 ' + p.mult + ' · ' + p.note;
                probEl.className = 'ldm-prob ldm-prob-' + p.tier;
            }

            tipsEl.textContent = stats.tips + ' 次';
            spentEl.textContent = '支出 ' + stats.spent + ' 分';
            luckyEl.textContent = stats.lucky + ' 次';
            gainedEl.textContent = '奖励 ' + fmt(stats.luckyGained) + ' 分';

            if (stats.players && stats.players.length) {
                var counts = {};
                stats.players.forEach(function (n) { counts[n] = (counts[n] || 0) + 1; });
                var names = Object.keys(counts).sort();
                var dup = stats.players.length - names.length;
                playersCap.textContent = '今日打赏玩家 ' + names.length + ' 位' + (dup > 0 ? '（重复 ' + dup + ' 次，同玩家不再触发）' : '（打赏新玩家才触发）');
                playersList.innerHTML = names.map(function (n) {
                    var c = counts[n];
                    var chip = '<span class="ldm-chip' + (c > 1 ? ' ldm-chip-dup' : '') + '">' +
                        '<span class="ldm-chip-name">' + escapeHtml(n) + '</span>' +
                        (c > 1 ? '<span class="ldm-chip-count">×' + c + '</span>' : '') +
                        '</span>';
                    return chip;
                }).join('');
                playersBox.hidden = false;
            } else {
                playersBox.hidden = true;
            }

            var net = stats.luckyGained - stats.spent;
            if (stats.spent === 0) {
                balanceEl.textContent = '今日未打赏';
                balanceEl.className = 'ldm-balance';
            } else if (net > 0) {
                var roi = Math.round(stats.luckyGained / stats.spent * 100);
                balanceEl.textContent = '净赚 ' + fmt(net) + ' 分 · 回报 ' + roi + '% ✅ 划算';
                balanceEl.className = 'ldm-balance ldm-good';
            } else if (net === 0) {
                balanceEl.textContent = '收支相抵（0 分）';
                balanceEl.className = 'ldm-balance';
            } else {
                balanceEl.textContent = '净亏 ' + net + ' 分 · 未回本 ⚠️';
                balanceEl.className = 'ldm-balance ldm-bad';
            }

            tipsEl.classList.toggle('ldm-hot', stats.tips >= CONFIG.luckyCap);
            luckyEl.classList.toggle('ldm-hot', stats.lucky >= CONFIG.luckyCap);
        }
        widget.querySelector('[data-ldm-time]').textContent = timeText || '';
    }

    function renderPoints(res, timeText, err) {
        if (!widget) return;
        var inEl = widget.querySelector('[data-pda-in]');
        var outEl = widget.querySelector('[data-pda-out]');
        var netEl = widget.querySelector('[data-pda-net]');
        var barsEl = widget.querySelector('[data-pda-bars]');
        var incEl = widget.querySelector('[data-pda-inc]');
        var expEl = widget.querySelector('[data-pda-exp]');
        var tlSection = widget.querySelector('[data-pda-tl-section]');
        var tlCount = widget.querySelector('[data-pda-tl-count]');
        var tlEl = widget.querySelector('[data-pda-timeline]');
        var expSection = widget.querySelector('[data-pda-exp-section]');
        var detailSection = widget.querySelector('[data-pda-detail]');
        var msgEl = widget.querySelector('[data-pda-msg]');

        // 指标标题跟随筛选范围（今日 / 昨日 / 近七天）
        var scopeCap = applyScopeLabels();

        if (err) {
            // 未监测到用户（或无数据）：三个指标都显示 "-"，底部提示
            inEl.textContent = '–';
            outEl.textContent = '–';
            netEl.textContent = '–';
            netEl.classList.remove('pda-net-pos', 'pda-net-neg');
            expSection.hidden = true;
            detailSection.hidden = true;
            tlSection.hidden = true;
            msgEl.textContent = err;
            msgEl.hidden = false;
        } else if (res) {
            inEl.textContent = fmt(res.totalIn);
            outEl.textContent = res.totalOut > 0 ? '-' + res.totalOut : '0';
            netEl.textContent = fmt(res.net);
            netEl.classList.remove('pda-net-pos', 'pda-net-neg');
            // 净变化为 0 时不加类（classList.add('') 会抛异常）
            if (res.net > 0) netEl.classList.add('pda-net-pos');
            else if (res.net < 0) netEl.classList.add('pda-net-neg');

            if (res.bars.length) {
                expSection.hidden = false;
                barsEl.innerHTML = res.bars.map(function (e) {
                    return '<div class="pda-bar-row">' +
                        '<span class="pda-bar-label" title="' + escapeHtml(e.label) + ' ' + e.amount + ' × ' + e.count + ' 次">' + escapeHtml(e.label) + '</span>' +
                        '<span class="pda-bar-track"><span class="pda-bar-fill" style="width:' + e.pct + '%"></span></span>' +
                        '<span class="pda-bar-val">' + e.amount + ' · ' + e.pct + '%</span>' +
                        '</div>';
                }).join('');
            } else {
                expSection.hidden = true;
            }

            detailSection.hidden = false;
            incEl.innerHTML = res.incList.length
                ? res.incList.map(function (e) {
                    return '<li><span class="pda-li-label">' + escapeHtml(e.label) + '</span><span class="pda-li-num pda-in">+' + e.amount + '</span></li>';
                }).join('')
                : '<li class="pda-li-empty">' + scopeCap + '无收入</li>';
            expEl.innerHTML = res.expList.length
                ? res.expList.map(function (e) {
                    return '<li><span class="pda-li-label">' + escapeHtml(e.label) + '</span><span class="pda-li-num pda-out">-' + e.amount + '</span></li>';
                }).join('')
                : '<li class="pda-li-empty">' + scopeCap + '无支出</li>';

            tlSection.hidden = false;
            tlCount.textContent = '共 ' + res.timeline.length + ' 段';
            var shown = res.timeline.slice(0, CONFIG.maxTimeline); // 降序：最近在前，取前 N 段
            tlEl.innerHTML = shown.map(function (g) {
                var cls = g.amount >= 0 ? 'pda-tl-in' : 'pda-tl-out';
                var labelTxt = g.count > 1 ? g.label + ' ×' + g.count : g.label;
                return '<div class="pda-tl-row">' +
                    '<span class="pda-tl-time">' + fmtTimeSmart(g.start) + '</span>' +
                    '<span class="pda-tl-reason" title="' + escapeHtml(g.label) + ' ×' + g.count + '">' + escapeHtml(labelTxt) + '</span>' +
                    '<span class="pda-tl-amt ' + cls + '">' + fmt(g.amount) + '</span>' +
                    '</div>';
            }).join('');
            msgEl.hidden = true;
        }
        widget.querySelector('[data-pda-time]').textContent = timeText || '';
    }

    /* ================= 称号合成：渲染 ================= */

    // 切换合成统计的筛选范围（纯本地重算）
    function setSynRange(range) {
        if (!RANGES[range]) return;
        syn.range = range;
        try { localStorage.setItem(SYN_RANGE_KEY, range); } catch (e) { /* 忽略 */ }
        renderSyn();
    }

    function renderSyn() {
        if (!widget) return;
        var cap = (RANGES[syn.range] || RANGES.today).label;
        widget.querySelectorAll('[data-syn-filter] .pda-filter-btn').forEach(function (b) {
            b.classList.toggle('pda-filter-on', b.getAttribute('data-range') === syn.range);
        });

        var countEl = widget.querySelector('[data-syn-count]');
        var totalEl = widget.querySelector('[data-syn-total]');
        var gainEl = widget.querySelector('[data-syn-gain]');
        var barSection = widget.querySelector('[data-syn-rarity-section]');
        var barsEl = widget.querySelector('[data-syn-bars]');
        var resSection = widget.querySelector('[data-syn-result-section]');
        var resCap = widget.querySelector('[data-syn-result-cap]');
        var resBars = widget.querySelector('[data-syn-result-bars]');
        var namesEl = widget.querySelector('[data-syn-names]');
        var tlSection = widget.querySelector('[data-syn-tl-section]');
        var tlCount = widget.querySelector('[data-syn-tl-count]');
        var tlEl = widget.querySelector('[data-syn-timeline]');
        var msgEl = widget.querySelector('[data-syn-msg]');
        var timeEl = widget.querySelector('[data-syn-time]');
        var filteredEl = widget.querySelector('[data-syn-filtered]');
        var refreshBtn = widget.querySelector('[data-syn-refresh]');

        if (timeEl) timeEl.textContent = syn.timeText || '';
        if (filteredEl) {
            filteredEl.hidden = !syn.filtered;
            filteredEl.textContent = syn.filtered
                ? '已过滤 ' + syn.filtered + ' 条非合成通知（回收 / 售出 / 打赏 / 提及 / 抽奖 / 赠送等不计入）'
                : '';
        }
        if (refreshBtn) {
            refreshBtn.disabled = syn.loading;
            refreshBtn.textContent = syn.loading ? '抓取中…' : '刷新';
        }

        function showMsg(text) {
            msgEl.textContent = text;
            msgEl.hidden = !text;
        }

        function emptyAll() {
            countEl.textContent = '–';
            totalEl.textContent = '–';
            gainEl.textContent = '–';
            barSection.hidden = true;
            resSection.hidden = true;
            tlSection.hidden = true;
        }

        function barHtml(label, val, total) {
            var pct = total > 0 ? Math.round(val / total * 100) : 0;
            return '<div class="pda-bar-row">' +
                '<span class="pda-bar-label" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span>' +
                '<span class="pda-bar-track"><span class="pda-bar-fill" style="width:' + pct + '%"></span></span>' +
                '<span class="pda-bar-val">' + val + ' · ' + pct + '%</span>' +
                '</div>';
        }

        if (syn.err) {
            emptyAll();
            showMsg(syn.err);
            return;
        }

        if (!syn.items) {
            emptyAll();
            showMsg(syn.loading ? '正在抓取通知列表…' : '点「刷新」加载通知并统计');
            return;
        }

        if (!syn.items.length) {
            emptyAll();
            countEl.textContent = '0';
            totalEl.textContent = '0';
            gainEl.textContent = '0';
            showMsg('通知里没匹配到「消耗了 N 个 X 称号」的记录。可能通知文案已变化，请把通知列表里的原始文案发我。');
            return;
        }

        var res = analyzeSyn(syn.items, syn.range);
        countEl.textContent = String(res.count);
        totalEl.textContent = String(res.total);
        gainEl.textContent = String(res.gainTotal);

        if (res.rarities.length) {
            barSection.hidden = false;
            barsEl.innerHTML = res.rarities.map(function (r) {
                return barHtml(r, res.byRarity[r], res.total);
            }).join('');
        } else {
            barSection.hidden = true;
        }

        // 合成所得：稀有度分布 + 称号明细（名称 × 数量）
        var hasGain = res.gainTotal > 0 || res.gainNames.length > 0;
        if (hasGain) {
            resSection.hidden = false;
            if (resCap) {
                resCap.textContent = '共 ' + res.gainTotal + ' 个' +
                    (res.gainKind ? ' · ' + res.gainKind + ' 种' : '');
            }
            var gainRarities = res.gainRarities.length ? res.gainRarities : [];
            resBars.innerHTML = gainRarities.length
                ? gainRarities.map(function (r) {
                    return barHtml(r, res.gainByRarity[r], res.gainTotal);
                }).join('')
                : '';
            if (res.gainNames.length) {
                var top = res.gainNames.slice(0, CONFIG.maxNames);
                namesEl.innerHTML = top.map(function (g) {
                    var cls = g.rarity ? ' r-' + g.rarity.toLowerCase() : '';
                    return '<div class="pda-name-row">' +
                        '<span class="pda-name-txt" title="' + escapeHtml(g.name) + '">' + escapeHtml(g.name) + '</span>' +
                        (g.rarity ? '<span class="pda-name-rar' + cls + '">' + escapeHtml(g.rarity) + '</span>' : '') +
                        '<span class="pda-name-cnt">×' + g.count + '</span>' +
                        '</div>';
                }).join('') + (res.gainNames.length > top.length
                    ? '<div class="pda-name-more">… 另有 ' + (res.gainNames.length - top.length) + ' 种没显示</div>' : '');
            } else {
                namesEl.innerHTML = '';
            }
            // 级别来自 /gacha 称号池：池还没到位时补一次加载，到货后重渲染补上级别
            if (!market.pool.length && !poolTriedForSyn) {
                poolTriedForSyn = true;
                loadPool().then(function () { renderSyn(); });
            }
        } else {
            resSection.hidden = true;
        }

        if (res.events.length) {
            tlSection.hidden = false;
            tlCount.textContent = '共 ' + res.events.length + ' 次';
            tlEl.innerHTML = res.events.slice(0, CONFIG.maxTimeline).map(function (ev) {
                var label = '消耗 ' + ev.consumed.map(function (c) { return c.count + ' ' + c.rarity; }).join(' + ');
                if (ev.gain && ev.gain.total) {
                    label += ' → 获得 ' + ev.gain.total + ' ' + (ev.gain.rarity || '称号');
                }
                var tip = ev.text || label;
                return '<div class="pda-tl-row">' +
                    '<span class="pda-tl-time">' + fmtTimeSmart(ev.time) + '</span>' +
                    '<span class="pda-tl-reason" title="' + escapeHtml(tip) + '">' + escapeHtml(label) + '</span>' +
                    '<span class="pda-tl-amt pda-tl-out">' + ev.sum + '</span>' +
                    '</div>';
            }).join('');
        } else {
            tlSection.hidden = true;
        }

        var hint = syn.note || (res.count === 0 ? cap + '没有合成记录' : '');
        if (!hint && res.unknownTime > 0) {
            hint = '有 ' + res.unknownTime + ' 条通知没解析出时间，未计入统计';
        }
        showMsg(hint);
    }

    // 抓取通知（手动刷新或首次打开该 TAB 时）
    function loadSyn(uid, manual) {
        if (!uid) {
            syn.err = '未登录或未识别到用户，请登录后刷新';
            renderSyn();
            return;
        }
        syn.loading = true;
        syn.err = '';
        renderSyn();
        collectSyn(uid).then(function (r) {
            syn.items = r.items;
            syn.note = r.note || '';
            syn.filtered = r.filtered || 0;
            syn.loadedUid = uid;
            var t = new Date();
            syn.timeText = t.getHours() + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
            syn.loading = false;
            try {
                localStorage.setItem(SYN_KEY, JSON.stringify({
                    day: new Date().toDateString(), items: r.items,
                    timeText: syn.timeText, note: syn.note, filtered: syn.filtered,
                }));
            } catch (e) { /* 忽略 */ }
            renderSyn();
        }).catch(function (e) {
            syn.loading = false;
            syn.items = null;
            syn.filtered = 0;
            syn.err = e.message + '，点「刷新」重试';
            renderSyn();
        });
    }

    // 打开 TAB 时按需抓取（已有同一用户的数据则直接复用）
    function ensureSyn() {
        if (syn.loading) return;
        var uid = lastUid;
        if (!uid) {
            syn.err = '未登录或未识别到用户，请登录后刷新';
            renderSyn();
            return;
        }
        if (syn.items && syn.loadedUid === uid) { renderSyn(); return; }
        loadSyn(uid, false);
    }

    /* ================= 刷新（共享一次抓取） ================= */

    // 切换筛选范围：优先用已抓取的记录本地重算，无数据时再抓取
    function setRange(range) {
        if (!RANGES[range]) return;
        currentRange = range;
        try { localStorage.setItem(RANGE_KEY, range); } catch (e) { /* 忽略 */ }
        if (widget) {
            widget.querySelectorAll('[data-pda-filter] .pda-filter-btn').forEach(function (b) {
                b.classList.toggle('pda-filter-on', b.getAttribute('data-range') === range);
            });
        }
        if (lastRecords) {
            renderPoints(analyze(filterRecords(lastRecords, range)), lastTimeText, null);
        } else if (lastUid) {
            refreshData(lastUid, false);
        }
    }

    function refreshData(uid, manual) {
        var btns = widget ? widget.querySelectorAll('[data-ldm-refresh],[data-pda-refresh]') : [];
        if (manual) {
            btns.forEach(function (b) {
                b.disabled = true;
                b.textContent = '抓取中…';
            });
        }
        // 并行抓取：积分明细 + 今日回帖数（1秒/页，两者独立翻页）
        Promise.all([collectAll(uid), collectReplies(uid)]).then(function (results) {
            var repliesToday = results[1];
            lastRecords = results[0].records;
            lastUid = uid;
            // 幸运打赏固定统计今日，不受筛选范围影响
            var lucky = computeLucky(filterRecords(lastRecords, 'today'));
            var t = new Date();
            var tt = t.getHours() + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
            lastTimeText = tt;
            renderLucky(lucky, tt, null, repliesToday);
            renderPoints(analyze(filterRecords(lastRecords, currentRange)), tt, null);
            try {
                var today = new Date().toDateString();
                localStorage.setItem(STORE_KEY, JSON.stringify({ day: today, records: lastRecords, repliesToday: repliesToday, savedAt: Date.now() }));
            } catch (e) { /* 忽略 */ }
        }).catch(function (e) {
            lastRecords = null;
            renderLucky(null, null, e.message + '，点「刷新」重试');
            renderPoints(null, null, e.message + '，点「刷新」重试');
        }).finally(function () {
            btns.forEach(function (b) {
                b.disabled = false;
                b.textContent = '刷新';
            });
        });
    }

    // 打赏提交成功后尽快刷新（监听 fetch 响应中的 donate ok）
    function hookDonateRefresh() {
        var origFetch = window.fetch;
        if (typeof origFetch !== 'function') return;
        window.fetch = function () {
            var args = arguments;
            return origFetch.apply(this, args).then(function (r) {
                try {
                    var u = String(args[0] || '');
                    if (u.indexOf('donate') !== -1 || (args[1] && String(args[1].url || '').indexOf('donate') !== -1)) {
                        r.clone().text().then(function (t) {
                            if (t && (t.indexOf('"ok":1') !== -1 || t.indexOf('"ok": 1') !== -1)) {
                                var now = Date.now();
                                if (widget && now - (widget.__lastRefresh || 0) > 3000) {
                                    widget.__lastRefresh = now;
                                    refreshData(detectUid() || '0', false);
                                }
                            }
                        }).catch(function () {});
                    }
                } catch (e) { /* 忽略 */ }
                return r;
            });
        };
    }

    /* ================= 启动 ================= */

    function start() {
        var uid = detectUid();
        lastUid = uid || null;

        // 恢复称号合成的筛选范围与当天缓存（需在 buildWidget 首次渲染/按需抓取前就绪）
        try {
            var savedSynRange = localStorage.getItem(SYN_RANGE_KEY);
            if (savedSynRange && RANGES[savedSynRange]) syn.range = savedSynRange;
            if (uid) {
                var sc = JSON.parse(localStorage.getItem(SYN_KEY) || 'null');
                if (sc && sc.day === new Date().toDateString() && sc.items) {
                    syn.items = sc.items;
                    syn.timeText = sc.timeText || '缓存';
                    syn.note = sc.note || '';
                    syn.filtered = sc.filtered || 0;
                    syn.loadedUid = uid;
                }
            }
        } catch (e) { /* 忽略 */ }

        widget = buildWidget(uid || '0');

        // 恢复折叠状态（收起状态保持，不展开）
        try {
            if (localStorage.getItem(FOLD_KEY) === '1') {
                widget.classList.add('combo-folded');
                var foldBtn = widget.querySelector('[data-combo-fold]');
                if (foldBtn) foldBtn.textContent = '⬆️';
            }
        } catch (e) { /* 忽略 */ }

        // 先展示缓存(当天，含近七天记录)再后台刷新
        try {
            var s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (s && s.day === new Date().toDateString() && s.records) {
                lastRecords = s.records;
                renderLucky(computeLucky(filterRecords(s.records, 'today')), '缓存', null, typeof s.repliesToday === 'number' ? s.repliesToday : 0);
                renderPoints(analyze(filterRecords(s.records, currentRange)), '缓存');
            }
        } catch (e) { /* 忽略 */ }

        if (!uid) {
            renderLucky(null, null, '未登录或未识别到用户，请登录后刷新');
            renderPoints(null, null, '未登录或未识别到用户，请登录后刷新');
            return;
        }

        // 称号监控初始化
        loadMarket();
        var notifEl = widget.querySelector('[data-market-notif]');
        if (notifEl) notifEl.checked = market.config.notif;
        var soundEl = widget.querySelector('[data-market-sound]');
        if (soundEl) soundEl.checked = market.config.sound;
        var voiceEl = widget.querySelector('[data-market-voice]');
        if (voiceEl) voiceEl.checked = market.config.voice;
        loadPool();
        if (market.config.running) startMonitor();
        else renderMarketPanel();

        // 定时任务刷新：仅当面板展开且页面可见时执行；收起状态跳过（用户要求）
        setInterval(function () {
            if (document.hidden) return;
            if (widget && widget.classList.contains('combo-folded')) return;
            refreshData(uid, false);
        }, CONFIG.refreshMs);

        refreshData(uid, false); // 默认先加载一次
        hookDonateRefresh();
    }

    /* ================= 幸运打赏计算 ================= */

    function computeLucky(records) {
        var stats = {
            tips: 0, spent: 0, lucky: 0, luckyGained: 0, received: 0,
            players: [], distinctPlayers: 0,
        };
        var distinct = {};
        records.forEach(function (it) {
            var tm = it.reason.match(TIP_RE);
            if (tm) {
                stats.tips++;
                stats.spent += Math.abs(it.delta);
                stats.players.push(tm[1]);
                distinct[tm[1]] = true;
            } else if (LUCKY_RE.test(it.reason)) {
                stats.lucky++;
                stats.luckyGained += Math.max(0, it.delta);
            } else if (RECEIVED_RE.test(it.reason)) {
                stats.received++;
            }
        });
        stats.distinctPlayers = Object.keys(distinct).length;
        return stats;
    }

    function estimateProb(stats, repliesToday) {
        // 回帖解锁：每日回帖不足 replyCap 次，概率锁定（置灰）；已对接 20953 新规则，回帖 99999 次才解锁
        var rp = typeof repliesToday === 'number' ? repliesToday : 0;
        if (rp < CONFIG.replyCap) {
            return {
                prob: 0, mult: '已下架', tier: 'locked',
                locked: true, replies: rp, cap: CONFIG.replyCap,
                note: '回帖 ' + rp + '/' + CONFIG.replyCap + ' 后解锁 · 已下架',
            };
        }
        if (stats.lucky >= CONFIG.luckyCap) {
            return { prob: 0, mult: '不触发', tier: 'over', note: '已达每日 ' + CONFIG.luckyCap + ' 次抽奖上限（' + stats.lucky + '/' + CONFIG.luckyCap + '）' };
        }
        if (stats.luckyGained >= CONFIG.highThreshold) {
            return { prob: 0, mult: '不触发', tier: 'over', note: '今日幸运奖励积分累计 ' + stats.luckyGained + ' ≥ ' + CONFIG.highThreshold + '，概率归 0' };
        }
        return { prob: 36, mult: '2-20', tier: 'low', note: '初始档 · 幸运奖励累计 ' + stats.luckyGained + '/' + CONFIG.highThreshold + ' 分 · 已打赏玩家 ' + (stats.distinctPlayers || 0) + ' 位' };
    }

    /* ================= 积分分析 ================= */

    function analyze(records) {
        function categorize(r) {
            for (var i = 0; i < RULES.length; i++) {
                if (RULES[i].re.test(r.reason)) return RULES[i];
            }
            return r.delta >= 0
                ? { key: 'other_in', label: '其他收入' }
                : { key: 'other_out', label: '其他支出' };
        }
        function bucketFor(cat, delta) {
            if (delta >= 0) {
                if (cat.key === 'lucky') return { key: 'in_lucky', label: '幸运奖励' };
                if (cat.key === 'donate_in') return { key: 'in_donate', label: '被打赏' };
                return { key: 'in_other', label: '其他收入' };
            }
            if (cat.key === 'gacha' || cat.key === 'title_buy') return { key: 'out_gacha', label: '称号系统' };
            if (cat.key === 'donate_out') return { key: 'out_donate', label: '打赏支出' };
            return { key: 'out_other', label: '其他支出' };
        }

        // 时间线：按时间降序（最近在前），连续同类合并
        var sorted = records.slice().sort(function (a, b) {
            return new Date(b.time).getTime() - new Date(a.time).getTime();
        });
        var timeline = [];
        sorted.forEach(function (r) {
            var cat = categorize(r);
            var last = timeline[timeline.length - 1];
            if (last && last.key === cat.key) {
                last.count++;
                last.amount += r.delta;
                last.end = r.time;
            } else {
                timeline.push({
                    key: cat.key, label: cat.label, count: 1, amount: r.delta,
                    start: r.time, end: r.time,
                });
            }
        });

        var inc = {}, exp = {};
        var totalIn = 0, totalOut = 0;
        records.forEach(function (r) {
            var b = bucketFor(categorize(r), r.delta);
            if (r.delta >= 0) {
                if (!inc[b.key]) inc[b.key] = { label: b.label, amount: 0, count: 0 };
                inc[b.key].amount += r.delta;
                inc[b.key].count++;
                totalIn += r.delta;
            } else {
                if (!exp[b.key]) exp[b.key] = { label: b.label, amount: 0, count: 0 };
                exp[b.key].amount += Math.abs(r.delta);
                exp[b.key].count++;
                totalOut += Math.abs(r.delta);
            }
        });

        var IN_ORDER = ['in_lucky', 'in_donate', 'in_other'];
        var OUT_ORDER = ['out_gacha', 'out_donate', 'out_other'];
        var incList = IN_ORDER.filter(function (k) { return inc[k]; }).map(function (k) { return inc[k]; });
        var expList = OUT_ORDER.filter(function (k) { return exp[k]; }).map(function (k) { return exp[k]; });

        var bars = expList.slice().sort(function (a, b) { return b.amount - a.amount; });
        bars.forEach(function (e) {
            e.pct = totalOut > 0 ? Math.round(e.amount / totalOut * 100) : 0;
        });

        return {
            timeline: timeline, incList: incList, expList: expList, bars: bars,
            totalIn: totalIn, totalOut: totalOut, net: totalIn - totalOut,
            count: records.length,
        };
    }

    /* ================= 样式 ================= */

    GM_addStyle([
        /* 面板骨架 */
        '#linuxsb-combo{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:272px;border:1px solid var(--line,#e5e7eb);border-radius:10px;background:var(--panel,#fff);color:var(--text,#1f2329);font:13px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.16);user-select:none}',
        '#linuxsb-combo .combo-head{padding:8px 10px 7px;cursor:move;border-bottom:1px solid var(--line,#eee)}',
        '#linuxsb-combo .combo-head-top{display:flex;align-items:center;justify-content:space-between;gap:6px}',
        '#linuxsb-combo .combo-title{font-size:13px;color:var(--text,#1f2329);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '#linuxsb-combo .combo-head-authors{display:flex;align-items:center;gap:6px;margin-top:5px}',
        '#linuxsb-combo .combo-author{color:var(--text-muted,#6b7280);font-size:11px;text-decoration:none;white-space:nowrap;padding:2px 6px;border:1px solid var(--line,#e5e7eb);border-radius:6px;background:var(--brand-soft,rgba(0,0,0,.03))}',
        '#linuxsb-combo .combo-author:hover{color:var(--brand,#2563eb);border-color:var(--brand,#2563eb)}',
        '#linuxsb-combo .combo-author-2{color:var(--brand,#2563eb);border-color:var(--brand,#2563eb);background:rgba(37,99,235,.08)}',
        '#linuxsb-combo .combo-author-2:hover{color:#fff;background:var(--brand,#2563eb)}',
        '#linuxsb-combo .combo-fold{width:26px;height:26px;border:1px solid var(--line,#e5e7eb);border-radius:6px;background:var(--brand-soft,rgba(0,0,0,.04));color:var(--text-muted,#6b7280);font-size:16px;line-height:1;cursor:pointer;text-align:center;padding:0}',
        '#linuxsb-combo .combo-fold:hover{color:var(--brand,#2563eb);border-color:var(--brand,#2563eb)}',
        /* TAB */
        '#linuxsb-combo .combo-tabs{display:flex;border-bottom:1px solid var(--line,#eee);background:var(--bg,#f9fafb)}',
        '#linuxsb-combo .combo-tab{flex:1 1 0;border:0;background:none;padding:7px 1px;font-size:12px;color:var(--text-muted,#6b7280);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;position:relative}',
        '#linuxsb-combo .combo-tab.combo-tab-active{color:var(--brand,#2563eb);border-bottom-color:var(--brand,#2563eb);font-weight:600}',
        /* TAB 角标（未读提醒，闪烁） */
        '#linuxsb-combo .combo-tab-badge{position:absolute;top:3px;right:2px;min-width:14px;height:14px;line-height:14px;padding:0 3px;border-radius:999px;background:var(--danger,#dc2626);color:#fff;font-size:10px;font-weight:700;text-align:center;font-variant-numeric:tabular-nums}',
        '#linuxsb-combo .combo-tab-badge.on{animation:combo-badge-blink .8s step-end infinite alternate}',
        '@keyframes combo-badge-blink{from{opacity:1}to{opacity:.35}}',
        '#linuxsb-combo .combo-body{padding:9px 10px 10px}',
        '#linuxsb-combo .combo-foot{display:flex;align-items:center;gap:10px;margin-top:8px;padding-top:6px;border-top:1px dashed var(--line,#e5e7eb)}',
        '#linuxsb-combo .combo-link{border:0;background:none;color:var(--brand,#2563eb);font-size:12px;cursor:pointer;text-decoration:none;padding:0}',
        '#linuxsb-combo .combo-link:hover{text-decoration:underline}',
        '#linuxsb-combo .combo-link:disabled{color:var(--text-subtle,#9ca3af);cursor:default;text-decoration:none}',
        '#linuxsb-combo .combo-time{margin-left:auto;color:var(--text-subtle,#9ca3af);font-size:11px}',
        '#linuxsb-combo .syn-filtered{margin-top:7px;color:var(--text-subtle,#9ca3af);font-size:11px;line-height:1.5}',
        '#linuxsb-combo.combo-folded .combo-body{display:none}',
        /* ---- 幸运打赏 ---- */
        '#linuxsb-combo .ldm-prob{display:flex;flex-direction:column;gap:1px;padding:8px 10px;margin-bottom:8px;border:1px solid var(--line,#e5e7eb);border-radius:8px;background:var(--brand-soft,rgba(37,99,235,.06))}',
        '#linuxsb-combo .ldm-prob-label{color:var(--text-muted,#6b7280);font-size:11px}',
        '#linuxsb-combo .ldm-prob-num{font-size:26px;font-weight:800;color:var(--brand,#2563eb);letter-spacing:.5px}',
        '#linuxsb-combo .ldm-prob-note{color:var(--text-subtle,#9ca3af);font-size:11px}',
        '#linuxsb-combo .ldm-prob.ldm-prob-over .ldm-prob-num{color:var(--danger,#dc2626)}',
        '#linuxsb-combo .ldm-prob.ldm-prob-over{background:var(--danger-soft,rgba(220,38,38,.07))}',
        /* 回帖未解锁：整行置灰锁定 */
        '#linuxsb-combo .ldm-prob.ldm-prob-locked{background:var(--bg,#f3f4f6);border-color:var(--line,#d1d5db);opacity:.75}',
        '#linuxsb-combo .ldm-prob.ldm-prob-locked .ldm-prob-num{color:var(--text-subtle,#9ca3af);font-size:20px;letter-spacing:1px}',
        '#linuxsb-combo .ldm-prob.ldm-prob-locked .ldm-prob-note{color:var(--text-muted,#6b7280);font-size:11px}',
        '#linuxsb-combo .ldm-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
        '#linuxsb-combo .ldm-card{display:grid;gap:1px;padding:7px 9px;border:1px solid var(--line,#eee);border-radius:8px;background:var(--bg,#f9fafb)}',
        '#linuxsb-combo .ldm-num{font-size:19px;font-weight:700;color:var(--text,#1f2329)}',
        '#linuxsb-combo .ldm-num.ldm-lucky{color:var(--success,#16a34a)}',
        '#linuxsb-combo .ldm-num.ldm-hot{color:var(--danger,#dc2626);animation:ldm-blink .6s step-end infinite alternate}',
        '#linuxsb-combo .ldm-cap{color:var(--text-muted,#6b7280);font-size:12px}',
        '#linuxsb-combo .ldm-sub{color:var(--text-subtle,#9ca3af);font-size:11px}',
        '@keyframes ldm-blink{from{opacity:1}to{opacity:.4}}',
        '#linuxsb-combo .ldm-players{margin-top:8px;padding:7px 9px 4px;border:1px solid var(--line,#eee);border-radius:8px;background:var(--bg,#f9fafb)}',
        '#linuxsb-combo .ldm-players-cap{display:block;color:var(--text-muted,#6b7280);font-size:11px;margin-bottom:5px}',
        '#linuxsb-combo .ldm-players-list{display:flex;flex-wrap:wrap;gap:4px;max-height:92px;overflow-y:auto}',
        '#linuxsb-combo .ldm-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0;padding:1px 7px;border:1px solid var(--line,#e5e7eb);border-radius:999px;background:var(--panel,#fff);color:var(--text,#1f2329);font-size:11px;line-height:1.6}',
        '#linuxsb-combo .ldm-chip .ldm-chip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
        '#linuxsb-combo .ldm-chip .ldm-chip-count{flex:0 0 auto;font-style:normal}',
        '#linuxsb-combo .ldm-chip.ldm-chip-dup{border-color:var(--danger,rgba(220,38,38,.4));color:var(--danger,#dc2626);background:var(--danger-soft,rgba(220,38,38,.06))}',
        '#linuxsb-combo .ldm-balance{margin-top:8px;padding:6px 9px;border-radius:6px;background:var(--bg,#f9fafb);color:var(--text-muted,#6b7280);font-size:12px;font-weight:600}',
        '#linuxsb-combo .ldm-balance.ldm-good{background:var(--success-soft,rgba(22,163,74,.08));color:var(--success,#16a34a)}',
        '#linuxsb-combo .ldm-balance.ldm-bad{background:var(--danger-soft,rgba(220,38,38,.08));color:var(--danger,#dc2626)}',
        '#linuxsb-combo .ldm-balance.ldm-err{background:var(--danger-soft,rgba(220,38,38,.08));color:var(--danger,#dc2626)}',
        /* ---- 积分分析 ---- */
        '#linuxsb-combo .pda-filter{display:flex;gap:4px;margin-bottom:8px;padding:3px;border:1px solid var(--line,#eee);border-radius:8px;background:var(--bg,#f9fafb)}',
        '#linuxsb-combo .pda-filter-btn{flex:1 1 0;border:0;border-radius:6px;padding:4px 0;background:none;color:var(--text-muted,#6b7280);font-size:12px;cursor:pointer;white-space:nowrap}',
        '#linuxsb-combo .pda-filter-btn:hover{color:var(--brand,#2563eb)}',
        '#linuxsb-combo .pda-filter-btn.pda-filter-on{background:var(--panel,#fff);color:var(--brand,#2563eb);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.12)}',
        '#linuxsb-combo .pda-concl{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px}',
        '#linuxsb-combo .pda-concl-row{display:grid;gap:1px;padding:6px 7px;border:1px solid var(--line,#eee);border-radius:8px;background:var(--bg,#f9fafb);text-align:center}',
        '#linuxsb-combo .pda-concl-row span{color:var(--text-muted,#6b7280);font-size:11px;white-space:nowrap}',
        '#linuxsb-combo .pda-concl-row b{font-size:15px;font-weight:700}',
        '#linuxsb-combo .pda-in{color:var(--success,#16a34a)}',
        '#linuxsb-combo .pda-out{color:var(--danger,#dc2626)}',
        '#linuxsb-combo .pda-net.pda-net-pos{color:var(--success,#16a34a)}',
        '#linuxsb-combo .pda-net.pda-net-neg{color:var(--danger,#dc2626);animation:ldm-blink .6s step-end infinite alternate}',
        '#linuxsb-combo .pda-section{margin-top:8px;padding:7px 9px 6px;border:1px solid var(--line,#eee);border-radius:8px;background:var(--bg,#f9fafb)}',
        '#linuxsb-combo .pda-section-cap{display:flex;align-items:center;gap:6px;color:var(--text-muted,#6b7280);font-size:11px;margin-bottom:5px}',
        '#linuxsb-combo .pda-bars{display:grid;gap:3px}',
        '#linuxsb-combo .pda-bar-row{display:flex;align-items:center;gap:6px;font-size:11px}',
        '#linuxsb-combo .pda-bar-label{flex:0 0 46px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted,#6b7280)}',
        '#linuxsb-combo .pda-bar-track{flex:1 1 auto;height:6px;border-radius:3px;background:var(--line,#eee);overflow:hidden}',
        '#linuxsb-combo .pda-bar-fill{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#f87171,#ef4444)}',
        '#linuxsb-combo .pda-bar-val{flex:0 0 auto;color:var(--text-subtle,#9ca3af);white-space:nowrap}',
        '#linuxsb-combo .pda-detail-cols{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
        '#linuxsb-combo .pda-col-cap{font-size:11px;margin-bottom:3px}',
        '#linuxsb-combo .pda-col-in{color:var(--success,#16a34a)}',
        '#linuxsb-combo .pda-col-out{color:var(--danger,#dc2626)}',
        '#linuxsb-combo .pda-list{margin:0;padding:0;list-style:none;display:grid;gap:2px}',
        '#linuxsb-combo .pda-list li{display:flex;align-items:center;gap:5px;font-size:11px}',
        '#linuxsb-combo .pda-li-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text,#1f2329)}',
        '#linuxsb-combo .pda-li-num{flex:0 0 auto;font-weight:700}',
        '#linuxsb-combo .pda-li-cnt{flex:0 0 auto;color:var(--text-subtle,#9ca3af);font-size:10px}',
        '#linuxsb-combo .pda-li-empty{color:var(--text-subtle,#9ca3af);font-style:italic}',
        '#linuxsb-combo .pda-msg{margin-top:8px;padding:6px 9px;border-radius:6px;background:var(--warning-soft,rgba(217,119,6,.08));color:var(--warning,#d97706);font-size:12px;font-weight:600}',
        '#linuxsb-combo .pda-tl-count{color:var(--text-subtle,#9ca3af)}',
        '#linuxsb-combo .pda-timeline{display:grid;gap:2px;max-height:180px;overflow-y:auto;margin-top:4px;padding-right:6px}',
        '#linuxsb-combo .pda-tl-row{display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0;border-bottom:1px dashed var(--line,#f0f0f0)}',
        '#linuxsb-combo .pda-tl-time{flex:0 0 auto;color:var(--text-subtle,#9ca3af);font-variant-numeric:tabular-nums;font-size:10px;white-space:nowrap}',
        '#linuxsb-combo .pda-tl-reason{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text,#1f2329)}',
        '#linuxsb-combo .pda-tl-amt{flex:0 0 auto;font-weight:700;font-variant-numeric:tabular-nums;padding-right:2px}',
        '#linuxsb-combo .pda-tl-in{color:var(--success,#16a34a)}',
        '#linuxsb-combo .pda-tl-out{color:var(--danger,#dc2626)}',
        /* ---- 称号合成 ---- */
        '#linuxsb-combo .syn-concl{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px}',
        '#linuxsb-combo .syn-card{display:grid;gap:1px;padding:6px 7px;border:1px solid var(--line,#eee);border-radius:8px;background:var(--bg,#f9fafb);text-align:center}',
        '#linuxsb-combo .syn-card span{color:var(--text-muted,#6b7280);font-size:11px;white-space:nowrap}',
        '#linuxsb-combo .syn-num{font-size:15px;font-weight:700;color:var(--text,#1f2329);font-variant-numeric:tabular-nums}',
        '#linuxsb-combo .pda-namelist{display:grid;gap:2px;margin-top:5px;max-height:170px;overflow-y:auto;padding-right:6px}',
        '#linuxsb-combo .pda-name-row{display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0;border-bottom:1px dashed var(--line,#f0f0f0)}',
        '#linuxsb-combo .pda-name-txt{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text,#1f2329)}',
        '#linuxsb-combo .pda-name-rar{flex:0 0 auto;font-size:10px;font-weight:700;line-height:1.5;padding:0 4px;border-radius:4px;background:var(--brand-soft,rgba(0,0,0,.05));color:var(--text-muted,#6b7280)}',
        '#linuxsb-combo .pda-name-rar.r-ur{background:rgba(220,38,38,.12);color:#dc2626}',
        '#linuxsb-combo .pda-name-rar.r-ssr{background:rgba(217,119,6,.14);color:#d97706}',
        '#linuxsb-combo .pda-name-rar.r-sr{background:rgba(37,99,235,.12);color:#2563eb}',
        '#linuxsb-combo .pda-name-rar.r-r{background:rgba(22,163,74,.12);color:#16a34a}',
        '#linuxsb-combo .pda-name-rar.r-n{background:rgba(107,114,128,.14);color:#6b7280}',
        '#linuxsb-combo .pda-name-cnt{flex:0 0 auto;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text-subtle,#9ca3af)}',
        '#linuxsb-combo .pda-name-more{font-size:11px;color:var(--text-subtle,#9ca3af);padding-top:2px}',
        /* ---- 称号监控 ---- */
        '#linuxsb-combo .market-alert{display:none;margin-bottom:8px;padding:8px 9px;border:1px solid var(--danger,#dc2626);border-radius:8px;background:var(--danger-soft,rgba(220,38,38,.1));color:var(--danger,#dc2626);font-size:12px;font-weight:600;line-height:1.6}',
        '#linuxsb-combo .market-alert-on{display:flex;align-items:flex-start;justify-content:space-between;gap:6px}',
        '#linuxsb-combo.market-alert-pulse .market-alert{border-width:2px;animation:market-alert-pulse 1s ease-in-out infinite}',
        '@keyframes market-alert-pulse{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.35)}50%{box-shadow:0 0 0 6px rgba(220,38,38,0)}}',
        '#linuxsb-combo .market-alert-close{flex:0 0 auto;border:0;background:none;color:var(--danger,#dc2626);font-size:13px;cursor:pointer;padding:0 2px}',
        '#linuxsb-combo .market-alert a.market-alert-link{color:inherit;text-decoration:none}',
        '#linuxsb-combo .market-alert a.market-alert-link:hover{color:var(--danger,#dc2626);text-decoration:underline}',
        // 轻提示
        '#linuxsb-combo .market-toast{display:none;margin-bottom:6px;padding:5px 8px;border-radius:6px;background:var(--warning-soft,rgba(217,119,6,.1));color:var(--warning,#d97706);font-size:12px;font-weight:600}',
        '#linuxsb-combo .market-toast.on{display:block}',
        '#linuxsb-combo .market-add{display:flex;gap:4px;margin-bottom:6px}',
        '#linuxsb-combo .market-input{flex:1 1 auto;min-width:0;border:1px solid var(--line,#d1d5db);border-radius:6px;padding:4px 6px;font-size:12px;background:var(--panel,#fff);color:var(--text,#1f2329)}',
        '#linuxsb-combo .market-input-name{flex:1 1 50%}',
        '#linuxsb-combo .market-input-price{flex:0 0 74px}',
        '#linuxsb-combo .market-input:focus{outline:none;border-color:var(--brand,#2563eb)}',
        '#linuxsb-combo .market-add-btn{flex:0 0 auto;border:1px solid var(--brand,#2563eb);border-radius:6px;padding:4px 8px;background:var(--brand-soft,rgba(37,99,235,.08))}',
        '#linuxsb-combo .market-titles{display:grid;gap:3px;max-height:120px;overflow-y:auto;margin-bottom:6px}',
        '#linuxsb-combo .market-item{display:flex;align-items:center;gap:6px;padding:3px 6px;border:1px solid var(--line,#eee);border-radius:6px;background:var(--bg,#f9fafb);font-size:12px}',
        '#linuxsb-combo .market-item-name{flex:1 1 auto;display:flex;align-items:center;gap:5px;min-width:0}',
        '#linuxsb-combo .market-item-keyword{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '#linuxsb-combo .market-rarity{font-size:10px;font-weight:700;padding:0 4px;border-radius:4px;line-height:1.5}',
        '#linuxsb-combo .market-rarity-ur{color:#a855f7;background:rgba(168,85,247,.12)}',
        '#linuxsb-combo .market-rarity-ssr{color:var(--warning,#d97706);background:var(--warning-soft,rgba(217,119,6,.12))}',
        '#linuxsb-combo .market-rarity-sr{color:var(--info,#0ea5e9);background:var(--info-soft,rgba(14,165,233,.12))}',
        '#linuxsb-combo .market-rarity-r{color:var(--brand,#2563eb);background:var(--brand-soft,rgba(37,99,235,.12))}',
        '#linuxsb-combo .market-rarity-n{color:var(--text-muted,#6b7280);background:var(--line-soft,rgba(0,0,0,.05))}',
        '#linuxsb-combo .market-item-th{flex:0 0 auto;color:var(--danger,#dc2626);font-weight:600;font-variant-numeric:tabular-nums}',
        '#linuxsb-combo .market-del{flex:0 0 auto;border:0;background:none;color:var(--text-subtle,#9ca3af);cursor:pointer;font-size:12px;padding:0 2px}',
        '#linuxsb-combo .market-del:hover{color:var(--danger,#dc2626)}',
        '#linuxsb-combo .market-empty{color:var(--text-subtle,#9ca3af);font-size:11px;padding:4px 2px}',
        '#linuxsb-combo .market-controls{display:flex;align-items:center;gap:10px;margin-bottom:4px}',
        '#linuxsb-combo .market-notif{display:inline-flex;align-items:center;gap:4px;color:var(--text-muted,#6b7280);font-size:11px;cursor:pointer;user-select:none}',
        '#linuxsb-combo .market-notif-opts{display:flex;flex-wrap:wrap;gap:6px 10px;margin-bottom:6px;padding:6px 7px;border:1px dashed var(--line,#e5e7eb);border-radius:6px;background:var(--bg,#f9fafb)}',
        '#linuxsb-combo .market-status{color:var(--text-subtle,#9ca3af);font-size:11px;margin-bottom:6px}',
        '#linuxsb-combo .market-status.market-status-hit{color:var(--danger,#dc2626);font-weight:600}',
        '#linuxsb-combo .market-item.market-item-hit{border-color:var(--danger,rgba(220,38,38,.5));background:var(--danger-soft,rgba(220,38,38,.06))}',
        '#linuxsb-combo .market-snap-cap{color:var(--text-muted,#6b7280);font-size:11px;margin-bottom:3px}',
        '#linuxsb-combo .market-snap{display:grid;gap:3px;max-height:130px;overflow-y:auto}',
        '#linuxsb-combo .market-snap-row{display:flex;align-items:center;gap:6px;padding:3px 6px;border:1px dashed var(--line,#e5e7eb);border-radius:6px;font-size:11px;background:var(--bg,#f9fafb)}',
        '#linuxsb-combo .market-snap-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text,#1f2329)}',
        '#linuxsb-combo .market-snap-meta{flex:0 0 auto;color:var(--text-muted,#6b7280);font-variant-numeric:tabular-nums;white-space:nowrap}',
        '#linuxsb-combo .market-snap-go{flex:0 0 auto;color:var(--brand,#2563eb);text-decoration:none;font-size:11px}',
        '#linuxsb-combo .market-snap-go:hover{text-decoration:underline}',
    ].join(''));

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
