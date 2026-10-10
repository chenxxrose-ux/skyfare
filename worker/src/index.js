/**
 * 航跡 Skyfare — Cloudflare Worker 後端
 *
 * 功能
 *   GET    /api/config              前端設定（Telegram 機器人名稱）
 *   GET    /api/search              即時查詢票價（SerpApi Google Flights，結果快取 20 分鐘）
 *   POST   /api/watch               建立票價追蹤
 *   GET    /api/watch/:id           取得追蹤與價格紀錄
 *   POST   /api/watch/:id/check     立即重新查價（每 10 分鐘最多一次）
 *   DELETE /api/watch/:id           刪除追蹤（需要建立時拿到的 key）
 *   POST   /telegram                Telegram webhook（/start、/list、/stop）
 *   cron                            定時檢查所有追蹤，降價就發 Telegram 通知
 *
 * 需要的設定（wrangler.toml / Cloudflare 後台）
 *   KV 綁定      SKYFARE
 *   Secret       SERPAPI_KEY、TELEGRAM_TOKEN、TELEGRAM_SECRET（自訂一串亂碼）
 *   變數         TELEGRAM_BOT（機器人帳號，不含 @）、SITE_URL、ALLOWED_ORIGIN、CURRENCY、MAX_WATCHES
 */

const SEARCH_TTL = 60 * 60; // 秒，同樣條件 1 小時內共用結果，省免費額度
const CHECK_COOLDOWN = 10 * 60 * 1000;
const HISTORY_CAP = 240;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/telegram" && request.method === "POST") {
        return await handleTelegram(request, env);
      }
      if (url.pathname === "/setup-telegram") {
        if (!env.TELEGRAM_TOKEN) return json({ ok: false, message: "後端還沒有 TELEGRAM_TOKEN。" }, 500, cors);
        const me = await tg(env, "getMe", {});
        if (!me?.ok) {
          return json({ ok: false, message: "Telegram 不認得這個 token，請到 GitHub 重新設定 TELEGRAM_TOKEN（從 BotFather 完整複製）。" }, 400, cors);
        }
        const hook = await tg(env, "setWebhook", {
          url: `${url.origin}/telegram`,
          secret_token: env.TELEGRAM_SECRET || undefined,
          allowed_updates: ["message"],
        });
        return json({
          ok: !!hook?.ok,
          bot: "@" + me.result.username,
          message: hook?.ok ? "設定完成！到 Telegram 傳訊息給機器人試試看。" : "設定失敗：" + (hook?.description || "未知錯誤"),
        }, hook?.ok ? 200 : 500, cors);
      }
      if (url.pathname === "/api/config") {
        return json({ telegramBot: env.TELEGRAM_BOT || null, currency: currency(env) }, 200, cors);
      }
      if (url.pathname === "/api/search" && request.method === "GET") {
        const q = parseQuery(Object.fromEntries(url.searchParams));
        const data = await searchFlights(q, env, { useCache: true });
        return json(data, 200, cors);
      }
      if (url.pathname === "/api/returns" && request.method === "GET") {
        const params = Object.fromEntries(url.searchParams);
        const q = parseQuery(params);
        if (!q.ret) throw fail(400, "單程票沒有回程可以選。");
        if (!params.token) throw fail(400, "請先選擇去程航班。");
        const data = await searchFlights(q, env, { useCache: true, departureToken: params.token });
        return json(data, 200, cors);
      }
      if (url.pathname === "/api/booking" && request.method === "GET") {
        const params = Object.fromEntries(url.searchParams);
        const q = parseQuery(params);
        if (!params.token) throw fail(400, "這個航班沒有訂票資訊。");
        return json(await bookingOptions(q, env, params.token), 200, cors);
      }
      if (url.pathname === "/api/holidays") {
        const cc = String(url.searchParams.get("country") || "").toUpperCase();
        const year = parseInt(url.searchParams.get("year"), 10);
        if (!/^[A-Z]{2}$/.test(cc) || !(year >= 2020 && year <= 2040)) throw fail(400, "參數錯誤");
        return json(await holidays(env, cc, year), 200, { ...cors, "cache-control": "public, max-age=21600" });
      }
      if (url.pathname === "/api/push/key") {
        const v = await getVapid(env);
        return json({ publicKey: v.pub }, 200, cors);
      }
      if (url.pathname === "/api/watches" && request.method === "GET") {
        const list = [];
        let cursor;
        do {
          const page = await env.SKYFARE.list({ prefix: "w:", cursor });
          for (const k of page.keys) {
            const w = await env.SKYFARE.get(k.name, "json");
            if (w) list.push({ id: w.id, query: w.query, flightKey: w.flightKey, returnKey: w.returnKey || null, price: w.current?.price ?? null, createdAt: w.createdAt });
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
        list.sort((a, b) => b.createdAt - a.createdAt);
        return json({ watches: list, max: parseInt(env.MAX_WATCHES || "60", 10) }, 200, cors);
      }
      if (url.pathname === "/api/watch" && request.method === "POST") {
        const body = await request.json();
        return json(await createWatch(body, env), 201, cors);
      }
      const m = url.pathname.match(/^\/api\/watch\/([a-z0-9]{10})(\/check|\/push)?$/);
      if (m && m[2] === "/push" && request.method === "POST") {
        const w = await getWatch(env, m[1]);
        if (!w) return json({ error: "找不到這個追蹤。" }, 404, cors);
        const { subscription } = await request.json();
        if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
          throw fail(400, "這個瀏覽器的通知資訊不完整，請重新開啟通知。");
        }
        const sub = { endpoint: String(subscription.endpoint), keys: { p256dh: String(subscription.keys.p256dh), auth: String(subscription.keys.auth) } };
        w.subs = (w.subs || []).filter((s) => s.endpoint !== sub.endpoint).concat(sub).slice(-10);
        await putWatch(env, w);
        const status = await sendPush(env, sub, {
          title: "✅ 已開啟降價通知",
          body: `${routeLabel(w)} ${w.query.depart}，降價時會通知你。`,
          url: watchUrl(env, w) || "./",
          tag: "w-" + w.id,
        }).catch(() => 0);
        return json({ ...publicWatch(w), pushStatus: status }, 200, cors);
      }
      if (m && m[2] !== "/push") {
        const id = m[1];
        if (request.method === "GET" && !m[2]) {
          const w = await getWatch(env, id);
          if (!w) return json({ error: "找不到這個追蹤，可能已經過期或被刪除。" }, 404, cors);
          return json(publicWatch(w), 200, cors);
        }
        if (request.method === "POST" && m[2]) {
          const w = await getWatch(env, id);
          if (!w) return json({ error: "找不到這個追蹤。" }, 404, cors);
          if (Date.now() - (w.checkedAt || 0) < CHECK_COOLDOWN) {
            return json({ ...publicWatch(w), note: "剛剛才更新過，10 分鐘後可以再查。" }, 200, cors);
          }
          const updated = await checkWatch(env, w);
          return json(publicWatch(updated), 200, cors);
        }
        if (request.method === "DELETE" && !m[2]) {
          const w = await getWatch(env, id);
          if (!w) return json({ ok: true }, 200, cors);
          if (request.headers.get("x-watch-key") !== w.key) {
            return json({ error: "只有建立這個追蹤的裝置可以刪除它。" }, 403, cors);
          }
          await env.SKYFARE.delete("w:" + id);
          return json({ ok: true }, 200, cors);
        }
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.publicMessage || "伺服器出了點問題，請稍後再試。", detail: String(err.message || err) }, status, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env));
  },
};

/* ---------- 共用 ---------- */

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim());
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-watch-key",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function fail(status, publicMessage) {
  const e = new Error(publicMessage);
  e.status = status;
  e.publicMessage = publicMessage;
  return e;
}

const currency = (env) => env.CURRENCY || "TWD";

function randomId(len = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function todayISO() {
  // 以台灣時間計算今天
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ---------- 查詢參數 ---------- */

function parseQuery(p) {
  const iata = (s) => String(s || "").trim().toUpperCase();
  const q = {
    from: iata(p.from),
    to: iata(p.to),
    depart: String(p.depart || ""),
    ret: p.return ? String(p.return) : "",
    adults: clampInt(p.adults, 1, 9, 1),
    children: clampInt(p.children, 0, 8, 0),
    cabin: clampInt(p.cabin, 1, 4, 1),
    stops: clampInt(p.stops, 0, 3, 0), // 0 不限、1 直飛、2 最多轉一次、3 最多轉兩次
  };
  if (!/^[A-Z0-9]{3}(,[A-Z0-9]{3})*$/.test(q.from) || !/^[A-Z0-9]{3}(,[A-Z0-9]{3})*$/.test(q.to)) {
    throw fail(400, "請選擇出發地與目的地機場。");
  }
  if (q.from === q.to) throw fail(400, "出發地和目的地不能一樣。");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.depart)) throw fail(400, "請選擇出發日期。");
  if (q.depart < todayISO()) throw fail(400, "出發日期已經過了。");
  if (q.ret && (!/^\d{4}-\d{2}-\d{2}$/.test(q.ret) || q.ret < q.depart)) throw fail(400, "回程日期要在出發日期之後。");
  if (q.adults + q.children > 9) throw fail(400, "一次最多查 9 位乘客。");
  return q;
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

const queryKey = (q) =>
  [q.from, q.to, q.depart, q.ret || "-", q.adults, q.children, q.cabin, q.stops].join("|");

/* ---------- SerpApi Google Flights ---------- */

async function searchFlights(q, env, { useCache, departureToken } = {}) {
  if (!env.SERPAPI_KEY) throw fail(500, "後端還沒設定 SERPAPI_KEY。");
  const cacheKey = "s2:" + queryKey(q) + (departureToken ? "|r:" + (await sha(departureToken)) : "");
  if (useCache) {
    const hit = await env.SKYFARE.get(cacheKey, "json");
    // 舊版快取沒有回程用的 token，來回票遇到時重新查詢
    const stale = hit && q.ret && !departureToken && hit.flights.length && !hit.flights.some((f) => f.token);
    if (hit && !stale) return { ...hit, cached: true };
  }

  const params = new URLSearchParams({
    engine: "google_flights",
    departure_id: q.from,
    arrival_id: q.to,
    outbound_date: q.depart,
    type: q.ret ? "1" : "2",
    adults: String(q.adults),
    children: String(q.children),
    travel_class: String(q.cabin),
    currency: currency(env),
    hl: "zh-TW",
    gl: "tw",
    api_key: env.SERPAPI_KEY,
  });
  if (q.ret) params.set("return_date", q.ret);
  if (q.stops) params.set("stops", String(q.stops));
  if (departureToken) params.set("departure_token", departureToken);

  const res = await fetch("https://serpapi.com/search.json?" + params.toString());
  const raw = await res.json().catch(() => ({}));
  if (!res.ok || raw.error) {
    const msg = String(raw.error || res.status);
    if (/hasn't returned any results/i.test(msg)) {
      const empty = normalize({}, q, env, !!departureToken);
      await env.SKYFARE.put(cacheKey, JSON.stringify(empty), { expirationTtl: SEARCH_TTL });
      return empty;
    }
    if (/run out of searches|plan/i.test(msg)) throw fail(503, "這個月的免費查詢次數用完了，下個月會重置。");
    throw fail(502, "票價來源暫時沒有回應，請稍後再試。");
  }

  const data = normalize(raw, q, env, !!departureToken);
  await env.SKYFARE.put(cacheKey, JSON.stringify(data), { expirationTtl: SEARCH_TTL });
  return data;
}

async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalize(raw, q, env, isReturn = false) {
  const list = [
    ...(raw.best_flights || []).map((f) => ({ f, best: true })),
    ...(raw.other_flights || []).map((f) => ({ f, best: false })),
  ];
  const flights = list
    .filter(({ f }) => typeof f.price === "number" && Array.isArray(f.flights) && f.flights.length)
    .map(({ f, best }) => {
      const segments = f.flights.map((s) => ({
        from: s.departure_airport?.id,
        fromName: s.departure_airport?.name,
        to: s.arrival_airport?.id,
        toName: s.arrival_airport?.name,
        dep: s.departure_airport?.time,
        arr: s.arrival_airport?.time,
        duration: s.duration,
        airline: s.airline,
        logo: s.airline_logo,
        flightNo: s.flight_number,
        plane: s.airplane,
        overnight: !!s.overnight,
        legroom: s.legroom,
      }));
      return {
        key: flightKey(segments),
        price: f.price,
        best,
        duration: f.total_duration,
        stops: segments.length - 1,
        segments,
        layovers: (f.layovers || []).map((l) => ({ airport: l.id, name: l.name, duration: l.duration, overnight: !!l.overnight })),
        emissions: f.carbon_emissions
          ? { grams: f.carbon_emissions.this_flight, typical: f.carbon_emissions.typical_for_this_route, diff: f.carbon_emissions.difference_percent }
          : null,
        logo: f.airline_logo || segments[0].logo,
        token: f.departure_token || null,
        bookingToken: f.booking_token || null,
      };
    });

  const pi = raw.price_insights || {};
  return {
    query: { ...q },
    leg: isReturn ? "return" : "outbound",
    currency: currency(env),
    insights: {
      lowest: pi.lowest_price ?? (flights.length ? Math.min(...flights.map((f) => f.price)) : null),
      level: pi.price_level || null, // low | typical | high
      typical: pi.typical_price_range || null,
      history: (pi.price_history || []).slice(-60).map(([t, p]) => ({ t: t * 1000, p })),
    },
    flights,
    bookingUrl: raw.search_metadata?.google_flights_url || googleFlightsUrl(q),
    fetchedAt: Date.now(),
    cached: false,
  };
}

function flightKey(segments) {
  return segments.map((s) => String(s.flightNo || "").replace(/\s+/g, "")).join("+");
}

function googleFlightsUrl(q) {
  const t = `Flights from ${q.from} to ${q.to} on ${q.depart}` + (q.ret ? ` returning ${q.ret}` : " one way");
  return "https://www.google.com/travel/flights?hl=zh-TW&q=" + encodeURIComponent(t);
}

/* ---------- 追蹤 ---------- */

async function getWatch(env, id) {
  return env.SKYFARE.get("w:" + id, "json");
}

async function putWatch(env, w) {
  // 出發日後兩天自動過期
  const exp = Math.floor(new Date(w.query.depart + "T00:00:00+08:00").getTime() / 1000) + 2 * 86400;
  await env.SKYFARE.put("w:" + w.id, JSON.stringify(w), { expiration: Math.max(exp, Math.floor(Date.now() / 1000) + 3600) });
}

function publicWatch(w) {
  const { key, chats, subs, ...rest } = w;
  return { ...rest, notify: (chats || []).length + (subs || []).length > 0 };
}

async function createWatch(body, env) {
  const q = parseQuery(body || {});
  const max = parseInt(env.MAX_WATCHES || "60", 10);
  const flightKeyIn = body.flightKey ? String(body.flightKey).slice(0, 80) : null;
  const returnKeyIn = body.returnKey && flightKeyIn ? String(body.returnKey).slice(0, 80) : null;
  const sig = (x) => [queryKey(x.query), x.flightKey || "", x.returnKey || ""].join("#");
  const mySig = sig({ query: q, flightKey: flightKeyIn, returnKey: returnKeyIn });

  // 同樣的追蹤只保留一筆：已存在就直接沿用，順便刪掉重複的
  const all = [];
  let cursor;
  do {
    const page = await env.SKYFARE.list({ prefix: "w:", cursor });
    for (const k of page.keys) {
      const w = await env.SKYFARE.get(k.name, "json");
      if (w) all.push(w);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const same = all.filter((w) => sig(w) === mySig).sort((a, b) => a.createdAt - b.createdAt);
  if (same.length) {
    const keep = same[0];
    for (const dup of same.slice(1)) {
      keep.subs = [...(keep.subs || []), ...(dup.subs || [])].filter((s, i, arr) => arr.findIndex((t) => t.endpoint === s.endpoint) === i);
      keep.chats = Array.from(new Set([...(keep.chats || []), ...(dup.chats || [])]));
      await env.SKYFARE.delete("w:" + dup.id);
    }
    if (body.target) keep.target = Math.max(1, parseInt(body.target, 10) || 0) || keep.target;
    await putWatch(env, keep);
    return { ...publicWatch(keep), key: keep.key, reused: true };
  }
  if (all.length >= max) throw fail(429, `目前最多同時追蹤 ${max} 筆，請先刪掉一些舊的。`);

  const w = {
    id: randomId(10),
    key: randomId(24),
    query: q,
    flightKey: flightKeyIn,
    returnKey: returnKeyIn,
    label: body.label ? String(body.label).slice(0, 80) : null,
    target: body.target ? Math.max(1, parseInt(body.target, 10) || 0) || null : null,
    createdAt: Date.now(),
    checkedAt: 0,
    history: [],
    chats: [],
    lastNotified: null,
    currency: currency(env),
  };
  const checked = await checkWatch(env, w, { save: false, initialPrice: body.price });
  await putWatch(env, checked);
  return { ...publicWatch(checked), key: w.key };
}

async function checkWatch(env, w, { save = true, initialPrice } = {}) {
  let data;
  try {
    data = await searchFlights(w.query, env, { useCache: true });
  } catch (err) {
    w.lastError = err.publicMessage || "查價失敗";
    w.checkedAt = Date.now();
    if (save) await putWatch(env, w);
    return w;
  }

  let match = null, retMatch = null, retError = null;
  if (w.flightKey) match = data.flights.find((f) => f.key === w.flightKey) || null;
  if (w.returnKey && match) {
    if (!match.token) retError = "暫時查不到回程票價。";
    else {
      try {
        const rd = await searchFlights(w.query, env, { useCache: true, departureToken: match.token });
        retMatch = rd.flights.find((f) => f.key === w.returnKey) || null;
        if (!retMatch) retError = "選的回程航班暫時查不到可售票價，可能已售完或改了時間。";
      } catch (err) {
        retError = err.publicMessage || "回程查價失敗";
      }
    }
  }
  const lowest = data.insights.lowest;
  const price = w.returnKey ? (retMatch ? retMatch.price : null) : w.flightKey ? (match ? match.price : null) : lowest;

  w.lastError = w.flightKey && !match ? `這班查不到 ${w.query.adults + w.query.children} 張可售的票，可能位子不夠或已售完。` : retError;
  w.current = { price, lowest, level: data.insights.level, typical: data.insights.typical, flight: match || data.flights[0] || null, returnFlight: retMatch };
  w.bookingUrl = data.bookingUrl;
  w.checkedAt = Date.now();

  if (price != null) {
    const last = w.history[w.history.length - 1];
    if (!last || last.p !== price || Date.now() - last.t > 6 * 3600 * 1000) {
      w.history.push({ t: Date.now(), p: price });
      if (w.history.length > HISTORY_CAP) w.history = w.history.slice(-HISTORY_CAP);
    }
  } else if (!w.history.length && initialPrice) {
    w.history.push({ t: Date.now(), p: Number(initialPrice) });
  }

  if (save) await putWatch(env, w);
  return w;
}

async function runChecks(env) {
  let cursor;
  do {
    const page = await env.SKYFARE.list({ prefix: "w:", cursor });
    for (const k of page.keys) {
      const w = await env.SKYFARE.get(k.name, "json");
      if (!w) continue;
      if (w.query.depart < todayISO()) {
        await env.SKYFARE.delete(k.name);
        continue;
      }
      const before = w.history.length ? w.history[w.history.length - 1].p : null;
      const updated = await checkWatch(env, w, { save: false });
      const now = updated.current?.price;
      const reason = shouldNotify(updated, before, now);
      if (reason) {
        await notifyAll(env, updated, reason, before, now);
        if (reason === "seats") updated.seatAlerted = true;
        else updated.lastNotified = { t: Date.now(), p: now };
      }
      if (now != null) updated.seatAlerted = false;
      await putWatch(env, updated);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

function shouldNotify(w, before, now) {
  if (!w.chats?.length && !w.subs?.length) return null;
  if (now == null) {
    // 追蹤的航班查不到足夠的票：可能剩下的位子不夠全部乘客，或已售完
    if (w.flightKey && before != null && !w.seatAlerted) return "seats";
    return null;
  }
  const lastP = w.lastNotified?.p ?? before;
  if (w.target && now <= w.target && (lastP == null || lastP > w.target)) return "target";
  if (lastP != null && now < lastP) return "drop";
  return null;
}

/* ---------- Telegram ---------- */

async function tg(env, method, payload) {
  if (!env.TELEGRAM_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => null);
}

const money = (env, n) => `${currency(env)} ${Math.round(n).toLocaleString("en-US")}`;

function routeLabel(w) {
  const q = w.query;
  return `${q.from} → ${q.to}${q.ret ? "（來回）" : ""}`;
}

function watchUrl(env, w) {
  return env.SITE_URL ? `${env.SITE_URL.replace(/\/$/, "")}/#w-${w.id}` : null;
}

async function notifyAll(env, w, reason, before, now) {
  const q = w.query;
  const pax = q.adults + q.children;
  const head = reason === "seats" ? `⚠️ 這班可能不到 ${pax} 個位子了` : reason === "target" ? "🎯 到達你設定的目標價" : "📉 票價下降了";
  const lines = [
    `<b>${head}</b>`,
    `${routeLabel(w)}　${q.depart}${q.ret ? " – " + q.ret : ""}`,
    w.flightKey ? `去程 ${w.flightKey.replace(/\+/g, " / ")}${w.returnKey ? `\n回程 ${w.returnKey.replace(/\+/g, " / ")}` : ""}` : "這條航線的最低價",
    reason === "seats" ? `查不到 ${pax} 張同價位的票，可能快賣完了，建議盡快確認或訂票。` : (before != null ? `${money(env, before)} → <b>${money(env, now)}</b>` : `現在 <b>${money(env, now)}</b>`) + (pax > 1 ? `\n每人約 ${money(env, now / pax)}` : ""),
  ];
  const buttons = [];
  if (w.bookingUrl) buttons.push({ text: "去 Google 航班訂票", url: w.bookingUrl });
  const site = watchUrl(env, w);
  if (site) buttons.push({ text: "看價格走勢", url: site });
  const plain = `${routeLabel(w)} ${q.depart}${q.ret ? "–" + q.ret.slice(5) : ""}\n` + (reason === "seats"
    ? `查不到 ${pax} 張票，可能快賣完了，建議盡快確認。`
    : `${before != null ? money(env, before) + " → " : "現在 "}${money(env, now)}${pax > 1 ? `（每人約 ${money(env, now / pax)}）` : ""}`);
  const alive = [];
  for (const sub of w.subs || []) {
    const status = await sendPush(env, sub, { title: head, body: plain, url: site || w.bookingUrl || "./", tag: "w-" + w.id }).catch(() => 0);
    if (status !== 404 && status !== 410) alive.push(sub); // 404/410 代表使用者已取消通知
  }
  w.subs = alive;
  for (const chat of w.chats || []) {
    await tg(env, "sendMessage", {
      chat_id: chat,
      text: lines.join("\n"),
      parse_mode: "HTML",
      reply_markup: buttons.length ? { inline_keyboard: [buttons] } : undefined,
    });
  }
}

async function handleTelegram(request, env) {
  if (env.TELEGRAM_SECRET && request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json().catch(() => ({}));
  const msg = update.message;
  if (!msg || !msg.text) return new Response("ok");
  const chat = msg.chat.id;
  const [cmd, arg] = msg.text.trim().split(/\s+/, 2);

  if (cmd === "/start" && arg) {
    const w = await getWatch(env, arg);
    if (!w) {
      await tg(env, "sendMessage", { chat_id: chat, text: "找不到這個追蹤，可能已經過期了。回網頁重新建立一次就好。" });
    } else {
      w.chats = Array.from(new Set([...(w.chats || []), chat]));
      await putWatch(env, w);
      const p = w.current?.price;
      await tg(env, "sendMessage", {
        chat_id: chat,
        parse_mode: "HTML",
        text: `✅ 已開啟通知\n<b>${routeLabel(w)}</b>　${w.query.depart}\n目前 ${p != null ? money(env, p) : "查價中"}${w.target ? `，目標 ${money(env, w.target)}` : ""}\n降價時我會傳訊息給你。輸入 /list 看全部，/stop 關閉通知。`,
      });
    }
  } else if (cmd === "/list" || cmd === "/stop") {
    const mine = [];
    let cursor;
    do {
      const page = await env.SKYFARE.list({ prefix: "w:", cursor });
      for (const k of page.keys) {
        const w = await env.SKYFARE.get(k.name, "json");
        if (w && (w.chats || []).includes(chat)) mine.push(w);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);

    if (cmd === "/stop") {
      for (const w of mine) {
        w.chats = w.chats.filter((c) => c !== chat);
        await putWatch(env, w);
      }
      await tg(env, "sendMessage", { chat_id: chat, text: `已關閉 ${mine.length} 筆追蹤的通知。` });
    } else {
      const text = mine.length
        ? mine.map((w) => `• ${routeLabel(w)} ${w.query.depart}　${w.current?.price != null ? money(env, w.current.price) : "—"}`).join("\n")
        : "你目前沒有開啟通知的追蹤。";
      await tg(env, "sendMessage", { chat_id: chat, text });
    }
  } else {
    await tg(env, "sendMessage", {
      chat_id: chat,
      text: "嗨！在網頁上追蹤航班後，按「用 Telegram 接收通知」就會連到這裡。\n/list 看你追蹤的航班\n/stop 關閉所有通知",
    });
  }
  return new Response("ok");
}

/* ---------- 訂票比價 ---------- */

async function bookingOptions(q, env, token) {
  if (!env.SERPAPI_KEY) throw fail(500, "後端還沒設定 SERPAPI_KEY。");
  const cacheKey = "b:" + (await sha(token));
  const hit = await env.SKYFARE.get(cacheKey, "json");
  if (hit) return { ...hit, cached: true };

  const params = new URLSearchParams({
    engine: "google_flights",
    departure_id: q.from,
    arrival_id: q.to,
    outbound_date: q.depart,
    type: q.ret ? "1" : "2",
    adults: String(q.adults),
    children: String(q.children),
    travel_class: String(q.cabin),
    currency: currency(env),
    hl: "zh-TW",
    gl: "tw",
    booking_token: token,
    api_key: env.SERPAPI_KEY,
  });
  if (q.ret) params.set("return_date", q.ret);
  const res = await fetch("https://serpapi.com/search.json?" + params.toString());
  const raw = await res.json().catch(() => ({}));
  if (!res.ok || raw.error) {
    const msg = String(raw.error || res.status);
    if (/run out of searches|plan/i.test(msg)) throw fail(503, "這個月的免費查詢次數用完了，下個月會重置。");
    throw fail(502, "暫時查不到訂票選項，請稍後再試。");
  }

  const leg = (x, label) =>
    x && {
      label,
      seller: x.book_with,
      price: x.price,
      logos: x.airline_logos || [],
      url: x.booking_request?.url || null,
      post: x.booking_request?.post_data || null,
      phone: x.booking_phone || null,
    };
  const options = (raw.booking_options || [])
    .map((o) => {
      if (o.together) {
        const t = leg(o.together, null);
        return { seller: t.seller, price: t.price, airline: !!o.together.airline, separate: false, legs: [t] };
      }
      const d = leg(o.departing, "去程"), r = leg(o.returning, "回程");
      const legs = [d, r].filter(Boolean);
      if (!legs.length) return null;
      return {
        seller: legs.map((l) => l.seller).join(" ＋ "),
        price: legs.every((l) => typeof l.price === "number") ? legs.reduce((a, l) => a + l.price, 0) : null,
        separate: true,
        legs,
      };
    })
    .filter((o) => o && typeof o.price === "number")
    .sort((a, b) => a.price - b.price);

  const data = { options, currency: currency(env), bookingUrl: raw.search_metadata?.google_flights_url || googleFlightsUrl(q), fetchedAt: Date.now() };
  await env.SKYFARE.put(cacheKey, JSON.stringify(data), { expirationTtl: SEARCH_TTL });
  return data;
}

/* ---------- 手機推播（Web Push，金鑰自動產生並存在 KV） ---------- */

const te = new TextEncoder();
const b64u = {
  enc(buf) {
    let s = "";
    for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  },
};
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of arrs) { out.set(a, i); i += a.length; }
  return out;
}

async function getVapid(env) {
  let v = await env.SKYFARE.get("vapid", "json");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u.enc(await crypto.subtle.exportKey("raw", kp.publicKey)) };
    await env.SKYFARE.put("vapid", JSON.stringify(v));
  }
  return v;
}

async function vapidHeader(env, endpoint) {
  const v = await getVapid(env);
  const head = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.enc(te.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.SITE_URL || "https://github.com",
  })));
  const key = await crypto.subtle.importKey("jwk", v.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(head + "." + body));
  return `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${v.pub}`;
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

// RFC 8291 aes128gcm 加密
async function encryptPush(sub, text) {
  const uaPub = b64u.dec(sub.keys.p256dh);
  const auth = b64u.dec(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(te.encode(text), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPub.length]), asPub, ct);
}

async function sendPush(env, sub, data) {
  const body = await encryptPush(sub, JSON.stringify(data));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "high",
      authorization: await vapidHeader(env, sub.endpoint),
    },
    body,
  });
  return res.status;
}


/* ---------- 國定假日（台灣：政府行事曆；其他國家：Nager.Date） ---------- */

const HOLIDAY_ZH = [
  [/new year'?s? eve/i, "跨年夜"], [/new year'?s? day|^new year$/i, "元旦"],
  [/lunar new year|chinese new year|tet|seollal|spring festival/i, "農曆新年"],
  [/hung king/i, "雄王紀念日"], [/reunification|liberation day.*south/i, "南方解放日"],
  [/labou?r day|workers'? day|may day/i, "勞動節"], [/national day|independence day/i, "國慶日"],
  [/christmas eve/i, "平安夜"], [/christmas/i, "聖誕節"], [/good friday/i, "耶穌受難日"], [/easter monday/i, "復活節星期一"], [/easter/i, "復活節"],
  [/buddha|vesak|visakha/i, "佛誕"], [/chuseok/i, "中秋節（秋夕）"], [/mid-?autumn/i, "中秋節"], [/dragon boat|tuen ng/i, "端午節"],
  [/ching ming|qingming|tomb/i, "清明節"], [/independence movement/i, "三一節"], [/children'?s day/i, "兒童節"],
  [/memorial day/i, "紀念日"], [/national foundation/i, "開天節"], [/hangul/i, "韓文日"],
  [/songkran/i, "潑水節"], [/hari raya puasa|eid al-?fitr/i, "開齋節"], [/hari raya haji|eid al-?adha/i, "哈芝節"],
  [/deepavali|diwali/i, "屠妖節"], [/thanksgiving/i, "感恩節"], [/constitution/i, "憲法紀念日"], [/king'?s birthday/i, "國王誕辰"],
  [/queen'?s birthday/i, "王后誕辰"], [/chakri/i, "卻克里王朝紀念日"], [/coronation/i, "加冕紀念日"],
];
const hasCJK = (t) => /[\u3040-\u30ff\u3400-\u9fff]/.test(t || "");

async function holidays(env, cc, year) {
  const key = `h2:${cc}:${year}`;
  const hit = await env.SKYFARE.get(key, "json");
  if (hit) return hit;

  const list = [];
  const off = new Set();
  let ok = false;
  try {
    if (cc === "TW") {
      const res = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`);
      if (res.ok) {
        for (const e of await res.json()) {
          const d = `${e.date.slice(0, 4)}-${e.date.slice(4, 6)}-${e.date.slice(6, 8)}`;
          if (e.isHoliday) off.add(d);
          if (e.isHoliday && e.description) list.push({ date: d, name: e.description });
        }
        ok = true;
      }
    } else {
      const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${cc}`);
      if (res.ok) {
        for (const h of await res.json()) {
          if (h.global === false) continue;
          const zh = HOLIDAY_ZH.find(([re]) => re.test(h.name) || re.test(h.localName));
          const name = hasCJK(h.localName) ? h.localName : zh ? zh[1] : h.name;
          if (!list.some((x) => x.date === h.date)) list.push({ date: h.date, name });
          off.add(h.date);
        }
        // 一般國家：週末也算休假
        for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 86400000) {
          const d = new Date(t);
          if (d.getUTCDay() === 0 || d.getUTCDay() === 6) off.add(d.toISOString().slice(0, 10));
        }
        ok = true;
      }
    }
  } catch {}

  // 有過農曆新年的國家，資料來源沒列出時，用台灣的除夕日期補上
  const LNY = { VN: [-1, 5, "農曆新年（Tết）"], KR: [-1, 1, "農曆新年"], CN: [0, 7, "春節"], HK: [1, 3, "農曆新年"], MO: [1, 3, "農曆新年"], SG: [1, 2, "農曆新年"], MY: [1, 2, "農曆新年"], ID: [1, 1, "農曆新年"], PH: [1, 1, "農曆新年"] };
  if (cc !== "TW" && LNY[cc] && !list.some((h) => /新年|春節|tết|설날/i.test(h.name))) {
    try {
      const tw = await holidays(env, "TW", year);
      const eve = tw.holidays.find((h) => h.name.includes("除夕"));
      if (eve) {
        const [from, to, name] = LNY[cc];
        for (let i = from; i <= to; i++) {
          const d = new Date(Date.parse(eve.date) + i * 86400000).toISOString().slice(0, 10);
          off.add(d);
          if (i === from) list.push({ date: d, name });
        }
      }
    } catch {}
  }

  // 連假：連續 3 天以上的休假日，且其中至少有一天是節日
  const breaks = [];
  const days = [...off].sort();
  let run = [];
  const flush = () => {
    if (run.length >= 3) {
      const named = list.filter((h) => run.includes(h.date) && !/補假|補班|小年夜/.test(h.name));
      if (named.length) {
        const short = (n) => n.replace(/[（(].*$/, "").replace(/暨.*$/, "").replace(/^開國紀念日$/, "元旦").replace(/^農曆除夕$/, "春節");
        const lny = named.find((h) => /春節|新年|除夕/.test(h.name));
        const names = lny ? [short(lny.name).replace(/^春節$/, cc === "TW" ? "春節" : "農曆新年")] : Array.from(new Set(named.map((h) => short(h.name)))).slice(0, 2);
        breaks.push({ start: run[0], end: run[run.length - 1], name: names.join("・") });
      }
    }
    run = [];
  };
  for (const d of days) {
    if (run.length && Date.parse(d) - Date.parse(run[run.length - 1]) !== 86400000) flush();
    run.push(d);
  }
  flush();

  const data = { country: cc, year, holidays: list.sort((a, b) => a.date.localeCompare(b.date)), breaks };
  await env.SKYFARE.put(key, JSON.stringify(data), { expirationTtl: ok ? 30 * 86400 : 3600 });
  return data;
}
