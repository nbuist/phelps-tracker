// Accounts and sync, talking to Supabase's REST APIs directly (no third-party library).
//
// Sign-in: email a one-time code to an @hope.edu address, then verify it. No passwords, and no
// magic links (they open in Safari instead of an installed iPhone app).
//
// Sync: the device stays the working copy. Every change goes into an outbox and is uploaded when
// online; pulls fetch rows changed on the server since the last sync. A row with a pending local
// change always wins over the server copy until it's uploaded. Deletes are soft (deleted = true)
// so other devices hear about them.

const Cloud = (() => {
  const cfg = window.PHELPS_CONFIG || {};
  const URL_BASE = (cfg.supabaseUrl || "").replace(/\/+$/, "");
  const KEY = cfg.supabaseKey || "";
  const configured = Boolean(URL_BASE && KEY);
  const HOPE_EMAIL = /^[^\s@]+@hope\.edu$/i;
  const PAGE = 1000;
  const OVERLAP_MS = 2 * 60 * 1000; // re-read a little behind the cursor; merging is idempotent

  const listeners = new Set();
  let status = { state: "idle", message: "" }; // idle | syncing | ok | offline | error
  let refreshing = null;
  let syncing = null;
  let syncTimer = null;

  // ---------- local storage ----------

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function store(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }
  const DATA_KEYS = ["logs", "customFoods", "goal", "outbox", "syncCursor", "dataOwner"];

  function setStatus(state, message = "") {
    status = { state, message, at: Date.now() };
    for (const fn of listeners) fn(status);
  }

  // ---------- auth ----------

  const getSession = () => load("session", null);
  const user = () => getSession()?.user || null;

  async function authRequest(path, body, token) {
    const res = await fetch(`${URL_BASE}/auth/v1/${path}`, {
      method: "POST",
      headers: {
        apikey: KEY,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.msg || data.error_description || data.message || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function saveSession(data) {
    store("session", {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      user: { id: data.user.id, email: data.user.email },
    });
  }

  async function requestCode(email) {
    email = email.trim().toLowerCase();
    if (!HOPE_EMAIL.test(email)) throw new Error("Use your @hope.edu email address.");
    await authRequest("otp", { email, create_user: true });
    return email;
  }

  async function verifyCode(email, code) {
    const data = await authRequest("verify", { type: "email", email, token: code.trim() });
    const owner = load("dataOwner", null);
    if (owner && owner !== data.user.id) {
      // Someone else's diary is on this device (their session expired); don't mix accounts.
      for (const k of DATA_KEYS) store(k, undefined);
    }
    saveSession(data);
    if (!owner || owner !== data.user.id) {
      // Diary kept on this device before signing in: upload it to the new account.
      queueEverything();
      store("syncCursor", undefined);
    }
    store("dataOwner", data.user.id);
    setStatus("idle");
    await sync();
  }

  // Returns a valid access token, refreshing it if it's about to expire. null = signed out.
  async function token() {
    const s = getSession();
    if (!s) return null;
    if (s.expires_at * 1000 - 60_000 > Date.now()) return s.access_token;
    refreshing ??= authRequest("token?grant_type=refresh_token", { refresh_token: s.refresh_token })
      .then((data) => { saveSession(data); return data.access_token; })
      .catch((e) => {
        if (e.status >= 400 && e.status < 500) {
          // Refresh token revoked or expired: sign out but keep the diary and outbox on the device.
          store("session", undefined);
          setStatus("error", "You were signed out. Sign in again to keep syncing.");
          return null;
        }
        throw e; // network trouble: try again later
      })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  function wipeLocal() {
    for (const k of [...DATA_KEYS, "session"]) store(k, undefined);
  }

  async function signOut() {
    await flush().catch(() => {});
    const t = getSession()?.access_token;
    if (t) authRequest("logout?scope=local", {}, t).catch(() => {});
    wipeLocal(); // shared laptops: don't leave the diary behind
    setStatus("idle");
  }

  async function deleteAccount() {
    await rest("rpc/delete_my_account", { method: "POST", body: {} });
    wipeLocal();
    setStatus("idle");
  }

  // ---------- REST ----------

  async function rest(path, { method = "GET", body, headers = {} } = {}, retried = false) {
    const t = await token();
    if (!t) throw Object.assign(new Error("Not signed in"), { signedOut: true });
    const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried) {
      const s = getSession();
      if (s) store("session", { ...s, expires_at: 0 }); // force a refresh, then retry once
      return rest(path, { method, body, headers }, true);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.message || `Sync failed (${res.status})`), { status: res.status });
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  // ---------- outbox ----------

  // outbox: { "<table>:<id>": { table, row, v } }; v lets us tell if it changed during an upload.
  function queue(table, id, row) {
    if (!configured) return;
    const outbox = load("outbox", {});
    const key = `${table}:${id}`;
    outbox[key] = { table, row, v: (outbox[key]?.v || 0) + 1 };
    store("outbox", outbox);
    scheduleSync();
  }

  const logRow = (entry, deleted = false) => ({
    id: entry.id,
    date: entry.date,
    meal: entry.meal,
    servings: entry.servings,
    food: entry.food,
    logged_at: entry.logged_at ? new Date(entry.logged_at).toISOString() : null,
    deleted,
  });

  const logChanged = (entry) => queue("food_logs", entry.id, logRow(entry));
  const logDeleted = (entry) => queue("food_logs", entry.id, logRow(entry, true));
  const customFoodChanged = (food) => queue("custom_foods", food.custom_id, { id: food.custom_id, food, deleted: false });
  const customFoodDeleted = (food) => queue("custom_foods", food.custom_id, { id: food.custom_id, food, deleted: true });
  const goalChanged = (goal) => queue("profiles", "me", { goal });

  function queueEverything() {
    for (const e of load("logs", [])) logChanged(e);
    for (const f of load("customFoods", [])) customFoodChanged(f);
    const goal = load("goal", null);
    if (goal != null) goalChanged(goal);
  }

  async function flush() {
    const outbox = load("outbox", {});
    const entries = Object.entries(outbox);
    if (!entries.length) return;
    const uid = user()?.id;
    const byTable = {};
    for (const [key, item] of entries) (byTable[item.table] ??= []).push([key, item]);

    let rejected = 0;
    for (const [table, items] of Object.entries(byTable)) {
      const toRow = ([, item]) => (table === "profiles" ? { ...item.row, user_id: uid } : item.row);
      const upload = (rows) => rest(`${table}?on_conflict=${table === "profiles" ? "user_id" : "id"}`, {
        method: "POST",
        body: rows,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      });
      let done = items;
      try {
        await upload(items.map(toRow));
      } catch (e) {
        if (!(e.status >= 400 && e.status < 500)) throw e; // offline/server trouble: keep everything queued
        // The server refused something in the batch. Retry one by one and drop rows it rejects,
        // so a single bad row can't block syncing forever.
        done = [];
        for (const item of items) {
          try { await upload([toRow(item)]); } catch (err) {
            if (!(err.status >= 400 && err.status < 500)) throw err;
            rejected++;
          }
          done.push(item);
        }
      }
      // Drop what we handled, unless it changed again while we were uploading.
      const now = load("outbox", {});
      for (const [key, item] of done) if (now[key]?.v === item.v) delete now[key];
      store("outbox", now);
    }
    if (rejected) console.warn(`Sync: the server rejected ${rejected} change(s); they were skipped.`);
  }

  // ---------- pull ----------

  async function pullTable(table, cursors) {
    const since = cursors[table] ? new Date(Date.parse(cursors[table]) - OVERLAP_MS).toISOString() : null;
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const filter = since ? `&updated_at=gte.${encodeURIComponent(since)}` : "";
      const page = await rest(`${table}?select=*${filter}&order=updated_at.asc,${table === "profiles" ? "user_id" : "id"}.asc&limit=${PAGE}&offset=${offset}`);
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    if (rows.length) cursors[table] = rows[rows.length - 1].updated_at;
    return rows;
  }

  async function pull() {
    const cursors = load("syncCursor", {});
    const outbox = load("outbox", {});
    const pending = (table, id) => Boolean(outbox[`${table}:${id}`]);
    let changed = false;

    const logRows = await pullTable("food_logs", cursors);
    if (logRows.length) {
      const logs = new Map(load("logs", []).map((l) => [l.id, l]));
      for (const r of logRows) {
        if (pending("food_logs", r.id)) continue;
        if (r.deleted) logs.delete(r.id);
        else logs.set(r.id, {
          id: r.id, date: r.date, meal: r.meal, servings: Number(r.servings), food: r.food,
          logged_at: r.logged_at ? Date.parse(r.logged_at) : 0,
        });
      }
      // Keep oldest-first order; "Recent foods" relies on it.
      store("logs", [...logs.values()].sort((a, b) => (a.logged_at || 0) - (b.logged_at || 0)));
      changed = true;
    }

    const foodRows = await pullTable("custom_foods", cursors);
    if (foodRows.length) {
      const foods = new Map(load("customFoods", []).map((f) => [f.custom_id, f]));
      for (const r of foodRows) {
        if (pending("custom_foods", r.id)) continue;
        if (r.deleted) foods.delete(r.id);
        else foods.set(r.id, { ...r.food, custom: true, custom_id: r.id });
      }
      store("customFoods", [...foods.values()]);
      changed = true;
    }

    const profile = (await pullTable("profiles", cursors))[0];
    if (profile && !pending("profiles", "me")) {
      store("goal", profile.goal);
      changed = true;
    }

    store("syncCursor", cursors);
    return changed;
  }

  // ---------- sync ----------

  // Upload pending changes, then download others. Resolves true if local data changed.
  function sync() {
    if (!configured || !getSession()) return Promise.resolve(false);
    if (!navigator.onLine) {
      setStatus("offline", "Offline. Changes will sync when you're back online.");
      return Promise.resolve(false);
    }
    syncing ??= (async () => {
      setStatus("syncing", "Syncing…");
      try {
        await flush();
        const changed = await pull();
        setStatus("ok", "Synced");
        return changed;
      } catch (e) {
        if (e.signedOut) return false;
        setStatus(navigator.onLine ? "error" : "offline",
          navigator.onLine ? `Couldn't sync: ${e.message}` : "Offline. Changes will sync when you're back online.");
        return false;
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  function scheduleSync(delay = 1500) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sync().then((changed) => changed && notifyData()), delay);
  }

  const dataListeners = new Set();
  const notifyData = () => { for (const fn of dataListeners) fn(); };

  function start() {
    if (!configured) return;
    addEventListener("online", () => scheduleSync(0));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") scheduleSync(0);
    });
    scheduleSync(0);
  }

  return {
    configured,
    user,
    status: () => status,
    pendingCount: () => Object.keys(load("outbox", {})).length,
    onStatus: (fn) => listeners.add(fn),
    onData: (fn) => dataListeners.add(fn),
    requestCode,
    verifyCode: (email, code) => verifyCode(email, code).then(notifyData),
    signOut: () => signOut().then(notifyData),
    deleteAccount: () => deleteAccount().then(notifyData),
    syncNow: () => sync().then((changed) => { if (changed) notifyData(); }),
    start,
    logChanged,
    logDeleted,
    customFoodChanged,
    customFoodDeleted,
    goalChanged,
  };
})();
