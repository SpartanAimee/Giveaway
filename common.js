(function () {
  const C = window.WG_CONFIG || {};
  const FN = String(C.supabaseUrl || "").replace(/\/$/, "") + "/functions/v1/web-giveaway";
  const BASE = new URL(".", location.href).href;
  const TOKEN = "wg_token";

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  function randomId() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  function configured() {
    return /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(C.supabaseUrl || "") && /^[a-z0-9]{20,40}$/i.test(C.twitchClientId || "");
  }

  async function api(action, data = {}) {
    const body = { action, ...data };
    const t = store.get(TOKEN);
    if (t && !("token" in body)) body.token = t;
    let res;
    try {
      res = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      return { ok: false, error: "Couldn't reach the giveaway server. Check your internet and try again." };
    }
    let j;
    try { j = await res.json(); } catch { j = { ok: false, error: `The giveaway server answered with an error (${res.status}). Is the web-giveaway function deployed?` }; }
    if (!j.ok && !j.error) {
      const code = String(j.code || "");
      if (res.status === 401 && /AUTH|JWT/i.test(code + (j.message || ""))) {
        j.error = "Supabase is blocking the giveaway. In Supabase, open Edge Functions > web-giveaway and turn off Verify JWT.";
      } else if (res.status === 404) {
        j.error = "Supabase can't find the web-giveaway function. Check it's deployed with exactly that name, and the Supabase address in config.js.";
      } else {
        j.error = `Supabase said: ${j.message || j.msg || "error " + res.status}`;
      }
    }
    if (j.reason === "login") store.del(TOKEN);
    return j;
  }

  function login() {
    const state = randomId();
    store.set("wg_state", JSON.stringify({ state, back: location.href.split("#")[0] }));
    location.href = "https://id.twitch.tv/oauth2/authorize?" + new URLSearchParams({
      client_id: C.twitchClientId,
      redirect_uri: BASE + "login.html",
      response_type: "token",
      scope: "",
      state,
    });
  }

  function logout() {
    store.del(TOKEN);
    location.reload();
  }

  function hexToRgb(h) {
    const n = parseInt(String(h || "#000000").slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
  }
  function lum(h) {
    const [r, g, b] = hexToRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function theme(page) {
    const bg = /^#[0-9a-f]{6}$/i.test(page?.background || "") ? page.background : "#0c0d10";
    const accent = /^#[0-9a-f]{6}$/i.test(page?.accent || "") ? page.accent : "#1fb5ec";
    const light = lum(bg) > 0.35;
    const fg = light ? "#161922" : "#eef0f5";
    const s = document.documentElement.style;
    s.setProperty("--bg", bg);
    s.setProperty("--fg", fg);
    s.setProperty("--muted", mix(fg, bg, 0.42));
    s.setProperty("--panel", mix(bg, fg, light ? 0.04 : 0.06));
    s.setProperty("--band", mix(bg, fg, light ? 0.07 : 0.04));
    s.setProperty("--line", mix(bg, fg, light ? 0.14 : 0.13));
    s.setProperty("--accent", accent);
    s.setProperty("--accent-fg", lum(accent) > 0.45 ? "#111111" : "#ffffff");
    document.documentElement.style.colorScheme = light ? "light" : "dark";
  }

  function chance(mine, total) {
    if (!mine || !total) return "0%";
    const p = (mine / total) * 100;
    if (p >= 99.95) return "100%";
    if (p >= 10) return Math.round(p) + "%";
    if (p >= 1) return p.toFixed(1) + "%";
    return p.toFixed(2) + "%";
  }

  const fmt = (n) => Number(n || 0).toLocaleString();
  const plural = (n, word) => `${fmt(n)} ${word}${Number(n) === 1 ? "" : "s"}`;
  const safeUrl = (u) => (typeof u === "string" && /^https:\/\/[^\s"'()<>\\]+$/.test(u) ? u : "");

  function untilText(iso) {
    const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
    if (s < 3600) return Math.ceil(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h " + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + "m";
    return Math.floor(s / 86400) + "d " + String(Math.floor((s % 86400) / 3600)).padStart(2, "0") + "h";
  }

  function whenText(iso) {
    return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  window.WG = { api, login, logout, configured, theme, chance, fmt, plural, safeUrl, untilText, whenText, store, TOKEN, BASE, FN, config: C };
})();
