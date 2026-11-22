// FFY Web Giveaway
// One function for everything: the viewer page, the streamer's control page, the OBS overlay,
// the points timer and the Twitch login. Deploy with "Verify JWT" OFF.
// Secrets: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_CHANNEL (the streamer's Twitch name).

const CLIENT_ID = Deno.env.get("TWITCH_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("TWITCH_CLIENT_SECRET") || "";
const CHANNEL = (Deno.env.get("TWITCH_CHANNEL") || "").trim().toLowerCase().replace(/^[#@]/, "");
const SB_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const FN_URL = `${SB_URL}/functions/v1/web-giveaway`;
const BUCKET = "web-giveaway";
const SCOPES = ["user:write:chat", "moderator:read:chatters"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ ok: false, error, ...extra }, status);

type Row = Record<string, any>;

// ---------- Database ----------

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Database ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const rpc = (name: string, args: Row) => db(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

async function getConfig(): Promise<Row> {
  const rows = await db("wg_config?id=eq.1&select=*");
  if (!rows?.[0]) throw new Error("wg_config is empty. Run setup.sql again.");
  return rows[0];
}

const saveConfig = (patch: Row) =>
  db("wg_config?id=eq.1", { method: "PATCH", body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });

// ---------- Twitch ----------

let appToken = { token: "", expires: 0 };

async function getAppToken(force = false) {
  if (!force && appToken.token && Date.now() < appToken.expires) return appToken.token;
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Twitch app token ${res.status}: ${await res.text()}`);
  const data = await res.json();
  appToken = { token: data.access_token, expires: Date.now() + (data.expires_in - 300) * 1000 };
  return appToken.token;
}

async function helixApp(path: string, retry = true): Promise<Response> {
  const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${await getAppToken()}` },
  });
  if (res.status === 401 && retry) {
    await getAppToken(true);
    return helixApp(path, false);
  }
  return res;
}

// The streamer's own token (from "Connect Twitch"), refreshed when it runs out
async function streamerToken(cfg: Row, force = false): Promise<string | null> {
  if (!cfg.refresh_token) return null;
  if (!force && cfg.access_token && cfg.token_expires && Date.parse(cfg.token_expires) - Date.now() > 120000) {
    return cfg.access_token;
  }
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: cfg.refresh_token,
    }),
  });
  if (!res.ok) {
    console.error("Token refresh failed", res.status, await res.text());
    if (res.status === 400 || res.status === 401) {
      await saveConfig({ access_token: null, refresh_token: null, token_expires: null });
      cfg.refresh_token = null;
    }
    return null;
  }
  const data = await res.json();
  cfg.access_token = data.access_token;
  cfg.refresh_token = data.refresh_token || cfg.refresh_token;
  cfg.token_expires = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  await saveConfig({ access_token: cfg.access_token, refresh_token: cfg.refresh_token, token_expires: cfg.token_expires });
  return cfg.access_token;
}

async function helixUser(cfg: Row, path: string, init: RequestInit = {}, retry = true): Promise<Response | null> {
  const token = await streamerToken(cfg, !retry);
  if (!token) return null;
  const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
    ...init,
    headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (res.status === 401 && retry) return helixUser(cfg, path, init, false);
  return res;
}

async function sendChat(cfg: Row, message: string) {
  if (!cfg.channel_id) return false;
  try {
    const res = await helixUser(cfg, "chat/messages", {
      method: "POST",
      body: JSON.stringify({ broadcaster_id: cfg.channel_id, sender_id: cfg.channel_id, message: message.slice(0, 480) }),
    });
    if (!res) return false;
    if (!res.ok) console.error("Chat message failed", res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error("Chat message failed", err);
    return false;
  }
}

// Viewers and the streamer log in on the web pages with Twitch. This checks who they are.
const seen = new Map<string, { info: { login: string; user_id: string }; until: number }>();

async function whoIs(token: unknown) {
  if (typeof token !== "string" || token.length < 10 || token.length > 200) return null;
  const hit = seen.get(token);
  if (hit && hit.until > Date.now()) return hit.info;
  const res = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${token}` } });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.client_id !== CLIENT_ID || !data.user_id) return null;
  const info = { login: String(data.login).toLowerCase(), user_id: String(data.user_id) };
  if (seen.size > 500) seen.clear();
  seen.set(token, { info, until: Date.now() + 60000 });
  return info;
}

// ---------- Page settings ----------

const DEFAULT_PAGE = {
  points_name: "Points",
  points_icon: "",
  earn_amount: 10,
  earn_minutes: 10,
  about: "",
  accent: "#1fb5ec",
  background: "#0c0d10",
  banner: "",
  avatar: "",
  background_image: "",
  chat_start: true,
  chat_entry: false,
  chat_winner: true,
  site_url: "",
  points_source: "builtin",
};

type Page = typeof DEFAULT_PAGE;

// Pages saved before cyan became the default get the new colour too
const pageOf = (cfg: Row): Page => {
  const p = { ...DEFAULT_PAGE, ...(cfg.page || {}) };
  if (String(p.accent).toLowerCase() === "#4a7bf7") p.accent = DEFAULT_PAGE.accent;
  return p;
};

const isColor = (v: unknown) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const isUrl = (v: unknown) => typeof v === "string" && v.length <= 500 && /^https:\/\/[^\s"'()<>\\]+$/.test(v);
const text = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function cleanPage(input: Row, current: Page): Page {
  const p = { ...current };
  if ("points_name" in input) p.points_name = text(input.points_name, 20) || "Points";
  if ("about" in input) p.about = text(input.about, 300);
  if ("earn_amount" in input) p.earn_amount = Math.round(num(input.earn_amount, 0, 100000, 10));
  if ("earn_minutes" in input) p.earn_minutes = Math.round(num(input.earn_minutes, 1, 60, 10));
  if ("accent" in input && isColor(input.accent)) p.accent = input.accent;
  if ("background" in input && isColor(input.background)) p.background = input.background;
  for (const k of ["banner", "avatar", "background_image", "points_icon"] as const) {
    if (k in input) p[k] = isUrl(input[k]) ? input[k] : "";
  }
  for (const k of ["chat_start", "chat_entry", "chat_winner"] as const) {
    if (k in input) p[k] = input[k] === true;
  }
  if ("site_url" in input && isUrl(input.site_url)) p.site_url = input.site_url;
  if (input.points_source === "builtin" || input.points_source === "streamerbot") p.points_source = input.points_source;
  return p;
}

// What everyone may see about the channel and its page
function publicPage(cfg: Row) {
  const p = pageOf(cfg);
  const sb = p.points_source === "streamerbot";
  const info = (cfg.sb_info || {}) as Row;
  return {
    channel: { login: cfg.channel_login || CHANNEL, name: cfg.channel_name || CHANNEL, image: cfg.channel_image || "" },
    page: {
      points_source: p.points_source,
      points_name: sb && info.points_name ? text(info.points_name, 30) : p.points_name,
      points_icon: p.points_icon,
      earn_amount: sb ? Math.max(0, Number(info.lurk_points) || 0) : p.earn_amount,
      earn_minutes: sb ? Math.max(1, Number(info.lurk_minutes) || 1) : p.earn_minutes,
      chat_points: sb ? Math.max(0, Number(info.chat_points) || 0) : 0,
      about: p.about, accent: p.accent, background: p.background,
      banner: p.banner, avatar: p.avatar, background_image: p.background_image,
    },
  };
}

const GIVEAWAY_FIELDS = "id,title,description,prize_image,ticket_cost,max_tickets,draw_at,status,winner_name,winner_tickets,total_tickets,created_at,drawn_at";

// The giveaway the page shows: the open one, or the last one drawn
async function currentGiveaway(): Promise<Row | null> {
  const rows = await db(`wg_giveaways?status=in.(open,drawn)&select=${GIVEAWAY_FIELDS}&order=created_at.desc&limit=1`);
  return rows?.[0] || null;
}

// ---------- Viewer page ----------

async function handleInfo(body: Row) {
  const cfg = await getConfig();
  const g = await currentGiveaway();
  const stats = g ? await rpc("wg_stats", { p_giveaway: g.id }) : { entrants: 0, tickets: 0 };
  let me = null;
  const who = body.token ? await whoIs(body.token) : null;
  if (body.token && !who) return json({ ok: true, ...publicPage(cfg), giveaway: g, stats, me: null, loggedOut: true, ready: !!cfg.channel_id });
  if (who) {
    const v = pageOf(cfg).points_source === "streamerbot"
      ? await db(`wg_sb_points?login=eq.${encodeURIComponent(who.login)}&select=points,display_name`)
      : await db(`wg_viewers?user_id=eq.${encodeURIComponent(who.user_id)}&select=points,display_name`);
    let tickets = 0;
    if (g) {
      const e = await db(`wg_entries?giveaway_id=eq.${g.id}&user_id=eq.${encodeURIComponent(who.user_id)}&select=tickets`);
      tickets = e?.[0]?.tickets || 0;
    }
    me = { login: who.login, name: v?.[0]?.display_name || who.login, points: v?.[0]?.points || 0, tickets };
  }
  return json({ ok: true, ...publicPage(cfg), giveaway: g, stats, me, ready: !!cfg.channel_id });
}

async function handleBuy(body: Row) {
  const who = await whoIs(body.token);
  if (!who) return fail("Log in with Twitch again.", 401, { reason: "login" });
  const g = await currentGiveaway();
  if (!g || g.status !== "open") return fail("This giveaway isn't taking entries.", 400, { reason: "closed" });

  const max = body.qty === "max";
  const qty = max ? 1 : Math.floor(Number(body.qty));
  if (!max && (!Number.isFinite(qty) || qty < 1 || qty > 100000)) return fail("Choose how many tickets to buy.");

  const r = await rpc("wg_buy", { p_giveaway: g.id, p_user: who.user_id, p_login: who.login, p_qty: qty, p_max: max });
  if (!r?.ok) {
    const cfg = await getConfig();
    const pn = publicPage(cfg).page.points_name;
    const extra = { tickets: r?.tickets ?? 0, points: r?.points ?? 0 };
    if (r?.error === "closed") return fail("Entries for this giveaway are closed.", 400, { reason: "closed" });
    if (r?.error === "max") {
      return fail(r.room ? `You can only buy ${r.room} more ticket${r.room === 1 ? "" : "s"}.` : "You already have the most tickets allowed.", 400, { reason: "max", ...extra });
    }
    return fail(`Not enough ${pn}. A ticket costs ${g.ticket_cost} and you have ${r?.points ?? 0}.`, 400, { reason: "points", ...extra });
  }

  const cfg = await getConfig();
  const p = pageOf(cfg);
  if (p.chat_entry && cfg.channel_id) {
    const e = await db(`wg_entries?giveaway_id=eq.${g.id}&user_id=eq.${encodeURIComponent(who.user_id)}&select=display_name`);
    const name = e?.[0]?.display_name || who.login;
    const t = (n: number) => `${n} ticket${n === 1 ? "" : "s"}`;
    await sendChat(cfg, r.first ? `@${name} entered the giveaway with ${t(r.bought)}!` : `@${name} bought ${t(r.bought)} more (${r.tickets} total).`);
  }
  return json({ ok: true, ...r });
}

// ---------- OBS overlay ----------

async function handleOverlay(body: Row) {
  const cfg = await getConfig();
  if (typeof body.key !== "string" || body.key !== cfg.overlay_key) return fail("This overlay link is old. Copy it again from the control page.", 403);
  const rows = await db(`wg_giveaways?status=eq.drawn&select=id,title,winner_name,winner_tickets,total_tickets,drawn_at&order=drawn_at.desc&limit=1`);
  const p = pageOf(cfg);
  return json({ ok: true, winner: rows?.[0] || null, test: cfg.overlay_test, accent: p.accent, points_name: p.points_name, now: new Date().toISOString() });
}

// ---------- Points timer ----------

async function handleCron(body: Row) {
  const cfg = await getConfig();
  if (typeof body.key !== "string" || body.key !== cfg.cron_key) return fail("Bad key", 403);
  const p = pageOf(cfg);
  if (p.points_source === "streamerbot") {
    await rpc("wg_unschedule", {});
    return json({ ok: true, skipped: "streamerbot" });
  }
  if (!cfg.channel_id || p.earn_amount <= 0) return json({ ok: true, skipped: "off" });
  if (cfg.last_award && Date.now() - Date.parse(cfg.last_award) < p.earn_minutes * 60000 - 20000) {
    return json({ ok: true, skipped: "wait" });
  }

  const live = await helixUser(cfg, `streams?user_id=${cfg.channel_id}`);
  if (!live) return json({ ok: true, skipped: "not-connected" });
  if (!live.ok) return json({ ok: true, skipped: `streams ${live.status}` });
  if (!(await live.json()).data?.length) return json({ ok: true, skipped: "offline" });

  const people = new Map<string, Row>();
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const res = await helixUser(cfg, `chat/chatters?broadcaster_id=${cfg.channel_id}&moderator_id=${cfg.channel_id}&first=1000${cursor ? `&after=${cursor}` : ""}`);
    if (!res || !res.ok) {
      if (res) console.error("Chatters failed", res.status, await res.text());
      break;
    }
    const data = await res.json();
    for (const c of data.data || []) {
      if (c.user_id !== cfg.channel_id) people.set(c.user_id, { id: c.user_id, login: c.user_login, name: c.user_name });
    }
    cursor = data.pagination?.cursor || "";
    if (!cursor) break;
  }

  const count = people.size ? await rpc("wg_award", { p_rows: [...people.values()], p_amount: p.earn_amount, p_sub_mult: 1 }) : 0;
  await saveConfig({ last_award: new Date().toISOString(), last_award_count: count });
  return json({ ok: true, awarded: count });
}

// ---------- Streamer.bot (FFY_Points) sync ----------

async function handleSbSync(body: Row) {
  const cfg = await getConfig();
  if (typeof body.key !== "string" || body.key !== cfg.sync_key) {
    return fail("Wrong Web Giveaway link. Copy it again from the control page into the FFY_Points Builder.", 403);
  }
  const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 50000).map((r: Row) => ({
    login: text(r?.login, 25).toLowerCase(),
    name: text(r?.name, 25),
    points: Math.max(0, Math.floor(Number(r?.points) || 0)),
  })).filter((r: Row) => /^[a-z0-9_]{1,25}$/.test(r.login));
  const acks = (Array.isArray(body.acks) ? body.acks : []).map(Number).filter((x: number) => Number.isInteger(x) && x > 0).slice(0, 5000);
  const r = await rpc("wg_sync", { p_rows: rows, p_acks: acks });
  const i = (body.info || {}) as Row;
  const info = {
    points_name: text(i.points_name, 30),
    lurk_points: Math.max(0, Math.floor(Number(i.lurk_points) || 0)),
    lurk_minutes: Math.max(1, Math.floor(Number(i.lurk_minutes) || 1)),
    chat_points: Math.max(0, Math.floor(Number(i.chat_points) || 0)),
  };
  await saveConfig({ last_sync: new Date().toISOString(), sb_info: info });
  return json({ ok: true, pending: r?.pending || [], acked: r?.acked || [] });
}

// ---------- Control page (streamer only) ----------

async function handleAdmin(body: Row) {
  const who = await whoIs(body.token);
  if (!who) return fail("Log in with Twitch again.", 401, { reason: "login" });
  if (who.login !== CHANNEL) return fail(`This control page is only for ${CHANNEL}. You're logged in as ${who.login}.`, 403, { reason: "not-owner" });

  const cfg = await getConfig();
  const action = body.action;
  const p = pageOf(cfg);

  if (action === "admin") {
    const g = await currentGiveaway();
    const entries = g ? await db(`wg_entries?giveaway_id=eq.${g.id}&tickets=gt.0&select=login,display_name,tickets,spent&order=tickets.desc&limit=500`) : [];
    const stats = g ? await rpc("wg_stats", { p_giveaway: g.id }) : { entrants: 0, tickets: 0 };
    const missing = SCOPES.filter((s) => !(cfg.scopes || []).includes(s));
    return json({
      ok: true,
      ...publicPage(cfg),
      settings: p,
      connected: !!cfg.refresh_token,
      missingScopes: cfg.refresh_token ? missing : SCOPES,
      overlayKey: cfg.overlay_key,
      syncLink: `${FN_URL}#${cfg.sync_key}`,
      lastSync: cfg.last_sync,
      sbInfo: cfg.sb_info || {},
      lastAward: cfg.last_award,
      lastAwardCount: cfg.last_award_count,
      giveaway: g,
      stats,
      entries,
    });
  }

  if (action === "connect") {
    const state = crypto.randomUUID();
    const back = isUrl(body.back) ? body.back : "";
    await saveConfig({ oauth_state: state, oauth_back: back });
    const url = `https://id.twitch.tv/oauth2/authorize?${new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: FN_URL,
      response_type: "code",
      scope: SCOPES.join(" "),
      state,
      force_verify: "true",
    })}`;
    return json({ ok: true, url });
  }

  if (action === "save-page") {
    const next = cleanPage(body.page || {}, p);
    await saveConfig({ page: next });
    if (next.points_source !== p.points_source) {
      try {
        if (next.points_source === "streamerbot") await rpc("wg_unschedule", {});
        else if (cfg.channel_id) await rpc("wg_schedule", { p_url: FN_URL });
      } catch (err) {
        console.error("Couldn't change the points timer", err);
      }
    }
    return json({ ok: true, settings: next });
  }

  if (action === "upload") {
    const slots = ["banner", "avatar", "background_image", "points_icon", "prize"];
    const slot = String(body.slot || "");
    if (!slots.includes(slot)) return fail("Unknown image slot");
    const m = /^data:(image\/(png|jpeg|gif|webp));base64,([a-z0-9+/=]+)$/i.exec(String(body.data || ""));
    if (!m) return fail("Use a PNG, JPG, GIF or WebP image.");
    const bytes = Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0));
    if (bytes.length > 3 * 1024 * 1024) return fail("That image is too big. The limit is 3 MB.");
    const ext = m[2].toLowerCase() === "jpeg" ? "jpg" : m[2].toLowerCase();
    // Prize images get a new name each time so an old giveaway keeps its picture
    const name = slot === "prize" ? `prize-${Date.now()}.${ext}` : `${slot}.${ext}`;
    const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${name}`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": m[1], "x-upsert": "true", "Cache-Control": "3600" },
      body: bytes,
    });
    if (!up.ok) {
      console.error("Upload failed", up.status, await up.text());
      return fail("Couldn't save the image. Check the web-giveaway storage bucket exists (run setup.sql).", 500);
    }
    const url = `${SB_URL}/storage/v1/object/public/${BUCKET}/${name}?v=${Date.now()}`;
    if (slot !== "prize") await saveConfig({ page: { ...p, [slot]: url } });
    return json({ ok: true, url });
  }

  if (action === "start") {
    const open = await db("wg_giveaways?status=eq.open&select=id");
    if (open?.length) return fail("A giveaway is already running. Draw or cancel it first.");
    const title = text(body.title, 80);
    if (!title) return fail("Give the giveaway a name, like what the prize is.");
    const cost = Math.round(num(body.ticket_cost, 0, 10000000, 0));
    let maxT = Math.round(num(body.max_tickets, 0, 100000, 10));
    if (cost === 0 && maxT === 0) maxT = 1;
    const drawAt = body.draw_at ? new Date(String(body.draw_at)) : null;
    if (drawAt && (isNaN(drawAt.getTime()) || drawAt.getTime() < Date.now() + 60000)) return fail("Pick a draw time in the future.");

    const [g] = await db("wg_giveaways", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        title,
        description: text(body.description, 500) || null,
        prize_image: isUrl(body.prize_image) ? body.prize_image : null,
        ticket_cost: cost,
        max_tickets: maxT,
        draw_at: drawAt ? drawAt.toISOString() : null,
        points_source: p.points_source,
      }),
    });

    if (isUrl(body.site_url) && body.site_url !== p.site_url) await saveConfig({ page: { ...p, site_url: body.site_url } });
    const site = isUrl(body.site_url) ? body.site_url : p.site_url;
    if (p.chat_start) {
      const how = cost > 0 ? `Tickets cost ${cost} ${publicPage(cfg).page.points_name}` : "Entry is free";
      await sendChat(cfg, `🎁 A giveaway for ${title} has started! ${how}.${site ? ` Enter here: ${site}` : ""}`);
    }
    return json({ ok: true, giveaway: g });
  }

  if (action === "draw") {
    const g = await currentGiveaway();
    if (!g) return fail("There's no giveaway to draw.");
    const r = await rpc("wg_draw", { p_giveaway: g.id });
    if (!r?.ok) return fail(r?.error === "empty" ? (g.status === "drawn" ? "Nobody else is left to draw." : "Nobody has entered yet.") : "Couldn't draw a winner.");
    if (p.chat_winner) {
      const chance = r.total ? formatChance((r.tickets / r.total) * 100) : "";
      await sendChat(cfg, `🎉 The winner of ${g.title} is @${r.winner}${chance ? ` with a ${chance} chance` : ""}!`);
    }
    return json({ ok: true, ...r });
  }

  if (action === "cancel") {
    const g = await currentGiveaway();
    if (!g || g.status !== "open") return fail("There's no running giveaway to cancel.");
    const r = await rpc("wg_cancel", { p_giveaway: g.id });
    if (!r?.ok) return fail("Couldn't cancel it.");
    if (p.chat_start) await sendChat(cfg, `The giveaway for ${g.title} was cancelled. Everyone got their ${publicPage(cfg).page.points_name} back.`);
    return json({ ok: true, ...r });
  }

  if (action === "finish") {
    // Hide the last winner so the page shows "no giveaway right now"
    const g = await currentGiveaway();
    if (g && g.status === "drawn") await db(`wg_giveaways?id=eq.${g.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
    return json({ ok: true });
  }

  if (action === "points") {
    const login = text(body.login, 40).toLowerCase().replace(/^@/, "");
    const amount = Math.round(num(body.amount, -100000000, 100000000, 0));
    if (!/^[a-z0-9_]{2,25}$/.test(login)) return fail("Type a Twitch name.");
    if (!amount) return fail("Type an amount, like 500 or -500.");
    const res = await helixApp(`users?login=${encodeURIComponent(login)}`);
    const user = res.ok ? (await res.json()).data?.[0] : null;
    if (!user) return fail(`Couldn't find ${login} on Twitch.`);
    const pts = p.points_source === "streamerbot"
      ? await rpc("wg_give_sb", { p_login: user.login, p_name: user.display_name, p_amount: amount })
      : await rpc("wg_give", { p_user: user.id, p_login: user.login, p_name: user.display_name, p_amount: amount });
    return json({ ok: true, name: user.display_name, points: pts });
  }

  if (action === "lookup") {
    const login = text(body.login, 40).toLowerCase().replace(/^@/, "");
    const rows = await db(`${p.points_source === "streamerbot" ? "wg_sb_points" : "wg_viewers"}?login=eq.${encodeURIComponent(login)}&select=display_name,login,points`);
    return json({ ok: true, viewer: rows?.[0] || null });
  }

  if (action === "test-overlay") {
    await saveConfig({ overlay_test: new Date().toISOString() });
    return json({ ok: true });
  }

  if (action === "test-chat") {
    const sent = await sendChat(cfg, "✅ FFY Web Giveaway can post in chat.");
    return sent ? json({ ok: true }) : fail("Couldn't post in chat. Click Connect Twitch and allow everything it asks for.");
  }

  if (action === "new-sync-key") {
    const key = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
    await saveConfig({ sync_key: key });
    return json({ ok: true, syncLink: FN_URL + "#" + key });
  }

  if (action === "new-overlay-key") {
    const key = crypto.randomUUID().replace(/-/g, "");
    await saveConfig({ overlay_key: key });
    return json({ ok: true, overlayKey: key });
  }

  return fail("Unknown action");
}

function formatChance(p: number) {
  if (p >= 99.95) return "100%";
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 1) return `${p.toFixed(1)}%`;
  return `${p.toFixed(2)}%`;
}

// ---------- "Connect Twitch" (code flow, needs the client secret) ----------

async function handleOAuth(url: URL) {
  const cfg = await getConfig();
  const back = cfg.oauth_back || "";
  const go = (params: Record<string, string>) => {
    if (!back) return new Response(params.error ? `Twitch connect failed: ${params.error}` : "Connected. You can close this tab.", { status: 200 });
    const target = new URL(back);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { Location: target.toString() } });
  };

  const state = url.searchParams.get("state") || "";
  if (!cfg.oauth_state || state !== cfg.oauth_state) return go({ error: "That login link is old. Click Connect Twitch again." });
  await saveConfig({ oauth_state: null });
  if (url.searchParams.get("error")) return go({ error: url.searchParams.get("error_description") || "Twitch login cancelled" });

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: url.searchParams.get("code") || "",
      grant_type: "authorization_code",
      redirect_uri: FN_URL,
    }),
  });
  if (!res.ok) {
    console.error("Code exchange failed", res.status, await res.text());
    return go({ error: "Twitch login failed. Check TWITCH_CLIENT_SECRET in Supabase, then try again." });
  }
  const tok = await res.json();
  const v = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${tok.access_token}` } });
  const info = v.ok ? await v.json() : null;
  if (!info?.user_id) return go({ error: "Twitch login failed. Try again." });
  if (String(info.login).toLowerCase() !== CHANNEL) {
    return go({ error: `You logged in as ${info.login}, but this giveaway is set up for ${CHANNEL}. Log out of Twitch and try again.` });
  }

  const u = await fetch(`https://api.twitch.tv/helix/users?id=${info.user_id}`, {
    headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${tok.access_token}` },
  });
  const user = u.ok ? (await u.json()).data?.[0] : null;

  await saveConfig({
    channel_id: info.user_id,
    channel_login: info.login,
    channel_name: user?.display_name || info.login,
    channel_image: user?.profile_image_url || null,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    token_expires: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
    scopes: info.scopes || [],
  });

  try {
    await rpc("wg_schedule", { p_url: FN_URL });
  } catch (err) {
    console.error("Couldn't start the points timer", err);
    return go({ connected: "1", warning: "Connected, but the points timer couldn't start. Run setup.sql again, then click Connect Twitch." });
  }
  return go({ connected: "1" });
}

// ---------- Entry point ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const isLogin = req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"));
  if (req.method !== "POST" && !isLogin) return new Response("FFY Web Giveaway is running.", { status: 200, headers: CORS });

  if (!CLIENT_ID || !CLIENT_SECRET || !CHANNEL || !SB_URL || !SB_KEY) {
    console.error("Missing TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET or TWITCH_CHANNEL");
    return fail("The giveaway isn't set up yet. Add TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET and TWITCH_CHANNEL in Supabase > Edge Functions > Secrets.", 500, { reason: "setup" });
  }

  try {
    if (isLogin) return await handleOAuth(url);

    let body: Row;
    try {
      body = await req.json();
    } catch {
      return fail("Bad request");
    }
    switch (body.action) {
      case "info": return await handleInfo(body);
      case "buy": return await handleBuy(body);
      case "overlay": return await handleOverlay(body);
      case "cron": return await handleCron(body);
      case "sb-sync": return await handleSbSync(body);
      default: return await handleAdmin(body);
    }
  } catch (err) {
    console.error(err);
    return fail("Something went wrong on the server. Try again in a moment.", 500);
  }
});
