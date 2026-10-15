// Phelps tracker. Reads phelps_menu.json (from fetch_phelps.py) and keeps the
// food diary in localStorage. Swap the storage functions for Supabase later.

const MEALS = ["breakfast", "lunch", "dinner", "snacks"];
const MENU_MEALS = ["breakfast", "lunch", "dinner"]; // what Phelps actually serves
const SOURCES = [
  { key: "menu", label: "Phelps menu" },
  { key: "recent", label: "Recent" },
  { key: "mine", label: "My foods" },
  { key: "quick", label: "Quick add" },
];
const DEFAULT_GOAL = 2000;
const MACROS = [
  // kcal per gram, and the share of calories used for the default macro targets
  { key: "carbs_g", label: "Carbs", kcal: 4, share: 0.5, color: "#14b8a6" },
  { key: "fat_g", label: "Fat", kcal: 9, share: 0.3, color: "#a855f7" },
  { key: "protein_g", label: "Protein", kcal: 4, share: 0.2, color: "#f59e0b" },
];
// Items above this are almost certainly whole-container numbers (see CLAUDE.md), so we hide them.
const HIDE_ABOVE_KCAL = 1000;
const RECENT_LIMIT = 30;

const state = {
  view: "diary", // diary | add | week
  date: todayISO(),
  foods: new Map(), // component_id -> food
  menu: [],
  addMeal: "breakfast", // diary meal we're adding to
  source: "menu", // which tab of the add view
  browseMeal: "breakfast", // which Phelps menu is shown in the add view
  editing: null, // log entry being edited in the dialog, or null when adding
  pendingFood: null,
  editingCustom: null, // custom food being edited, or null when creating
};

// ---------- storage (localStorage for now) ----------

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
const loadLogs = () => load("logs", []);
const saveLogs = (logs) => store("logs", logs);
const loadCustomFoods = () => load("customFoods", []);
const saveCustomFoods = (foods) => store("customFoods", foods);
const loadGoal = () => Number(load("goal", DEFAULT_GOAL)) || DEFAULT_GOAL;
const saveGoal = (goal) => store("goal", goal);

function addLog(meal, servings, food) {
  // Store a copy of the nutrition so past days don't change when the menu data does.
  const logs = loadLogs();
  const entry = { id: crypto.randomUUID(), date: state.date, meal, servings, food, logged_at: Date.now() };
  logs.push(entry);
  saveLogs(logs);
  Cloud.logChanged(entry);
}

// ---------- helpers ----------

function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function shiftDate(iso, days) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function shortDate(iso) {
  return new Date(iso + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function prettyDate(iso) {
  const t = todayISO();
  if (iso === t) return "Today";
  if (iso === shiftDate(t, -1)) return "Yesterday";
  if (iso === shiftDate(t, 1)) return "Tomorrow";
  return new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
const weekday = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" });
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const round = (n) => Math.round(n || 0);
const fmt = (n) => round(n).toLocaleString();
function servingText(f) {
  if (f.quick) return "Quick add";
  if (!f.serving_size) return f.custom ? `1 ${f.serving_unit || "serving"}` : "serving size unknown";
  return `${+f.serving_size} ${(f.serving_unit || "").toLowerCase()}`.trim();
}
// Identity for "recent foods": Phelps recipe id or custom food id. Quick adds have none.
function foodKey(f) {
  if (f.quick) return null;
  return f.custom ? `c:${f.custom_id}` : `p:${f.component_id}`;
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v); // via CSSOM, which the CSP allows
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}
const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}
function numOrNull(id) {
  const v = document.getElementById(id).value.trim();
  return v === "" ? null : Number(v);
}
function totals(logs) {
  const sum = (key) => logs.reduce((s, l) => s + (l.food[key] || 0) * l.servings, 0);
  return { calories: sum("calories"), protein_g: sum("protein_g"), carbs_g: sum("carbs_g"), fat_g: sum("fat_g") };
}

// ---------- views ----------

function show(view) {
  state.view = view;
  for (const v of ["diary", "add", "week", "account"]) document.getElementById(`${v}-view`).hidden = v !== view;
  document.getElementById("bottom-nav").hidden = view === "add";
  for (const b of document.querySelectorAll("#bottom-nav button")) b.classList.toggle("active", b.dataset.view === view);
  window.scrollTo(0, 0);
  refresh();
}

function refresh() {
  document.querySelector(".topbar").classList.toggle("no-nav", state.view === "account");
  if (state.view === "account") {
    document.getElementById("date-label").textContent = "Account";
    renderAccount();
  } else if (state.view === "week") {
    const start = shiftDate(state.date, -6);
    document.getElementById("date-label").textContent = `${shortDate(start)} – ${shortDate(state.date)}`;
    renderWeek();
  } else {
    document.getElementById("date-label").textContent = prettyDate(state.date);
    if (state.view === "diary") renderDiary();
    else renderAdd();
  }
}

// ---------- diary ----------

function renderDiary() {
  const logs = loadLogs().filter((l) => l.date === state.date);
  const goal = loadGoal();
  const t = totals(logs);

  document.getElementById("goal-cal").textContent = round(goal);
  document.getElementById("food-cal").textContent = round(t.calories);
  document.getElementById("remaining-cal").textContent = round(goal) - round(t.calories); // so the row adds up

  document.getElementById("macros").replaceChildren(...MACROS.map((m) => {
    const target = (goal * m.share) / m.kcal;
    const pct = Math.min(100, (t[m.key] / target) * 100);
    return el("div", { class: "macro" },
      el("div", {}, `${m.label} `, el("span", { class: "muted" }, `${round(t[m.key])} / ${round(target)} g`)),
      el("div", { class: "bar" }, el("div", { style: { width: `${pct}%`, background: m.color } })));
  }));

  document.getElementById("meals").replaceChildren(...MEALS.map((meal) => {
    const entries = logs.filter((l) => l.meal === meal);
    return el("section", { class: "meal" },
      el("h2", {}, cap(meal), el("span", {}, round(totals(entries).calories))),
      entries.map((l) => el("button", { class: "entry", onclick: () => openFood(l.food, l) },
        el("div", {}, l.food.name,
          el("div", { class: "sub" }, l.food.quick ? "Quick add" : `${+l.servings} × ${servingText(l.food)}`)),
        el("span", { class: "kcal" }, round(l.food.calories * l.servings)))),
      el("button", { class: "link", onclick: () => openAdd(meal) }, "+ Add food"));
  }));
}

// ---------- add food ----------

function openAdd(meal) {
  state.addMeal = meal;
  // For snacks, default to whatever's being served at this time of day.
  const hour = new Date().getHours();
  state.browseMeal = meal !== "snacks" ? meal : hour < 11 ? "breakfast" : hour < 16 ? "lunch" : "dinner";
  document.getElementById("add-title").textContent = `Add to ${cap(meal)}`;
  document.getElementById("search").value = "";
  show("add");
}

function renderAdd() {
  document.getElementById("source-tabs").replaceChildren(...SOURCES.map((s) =>
    el("button", { class: s.key === state.source ? "active" : "", onclick: () => { state.source = s.key; renderAdd(); } },
      s.label)));
  const search = document.getElementById("search");
  search.hidden = state.source === "quick";
  search.placeholder = state.source === "menu" ? "Search the Phelps menu" : "Search";
  document.getElementById("add-meal-tabs").hidden = state.source !== "menu";

  if (state.source === "menu") renderMenu();
  else if (state.source === "recent") renderRecent();
  else if (state.source === "mine") renderCustomFoods();
  else renderQuickAdd();
}

const query = () => document.getElementById("search").value.trim().toLowerCase();
const matches = (food, q) => !q || food.name.toLowerCase().includes(q);

function foodRow(food, { sub = servingText(food), servings = 1 } = {}) {
  return el("button", { class: "food-row", onclick: () => openFood(food, null, servings) },
    el("div", {}, food.name, food.needs_review ? el("span", { class: "badge" }, "check") : null,
      el("div", { class: "sub" }, sub)),
    el("span", { class: "kcal" }, `${round(food.calories)} cal`));
}

function renderMenu() {
  document.getElementById("add-meal-tabs").replaceChildren(...MENU_MEALS.map((m) =>
    el("button", { class: m === state.browseMeal ? "active" : "", onclick: () => { state.browseMeal = m; renderMenu(); } },
      cap(m))));

  const q = query();
  const items = state.menu
    .filter((m) => m.date === state.date && m.meal === state.browseMeal)
    .map((m) => ({ ...m, food: state.foods.get(m.component_id) }))
    .filter((m) => m.food && (m.food.calories || 0) <= HIDE_ABOVE_KCAL && matches(m.food, q));

  const list = document.getElementById("menu-list");
  if (!items.length) {
    list.replaceChildren(el("p", { class: "muted center" },
      q ? "No matches." : `No Phelps ${state.browseMeal} menu for ${prettyDate(state.date).toLowerCase()}.`));
    return;
  }

  const byStation = new Map();
  for (const it of items) {
    if (!byStation.has(it.station)) byStation.set(it.station, []);
    byStation.get(it.station).push(it);
  }
  list.replaceChildren(...[...byStation].map(([station, rows]) =>
    el("section", { class: "station" },
      el("h3", {}, station),
      rows
        .sort((a, b) => b.is_entree - a.is_entree || (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map(({ food }) => foodRow(food)))));
}

function renderRecent() {
  const q = query();
  const seen = new Set();
  const recent = [];
  // Logs are appended in the order they're added, so walk backwards for most recent first.
  for (const l of loadLogs().reverse()) {
    const key = foodKey(l.food);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (matches(l.food, q)) recent.push(l);
    if (recent.length >= RECENT_LIMIT) break;
  }
  const list = document.getElementById("menu-list");
  if (!recent.length) {
    list.replaceChildren(el("p", { class: "muted center" }, q ? "No matches." : "Foods you log will show up here."));
    return;
  }
  list.replaceChildren(el("section", { class: "station" },
    recent.map((l) => foodRow(l.food, { sub: `last: ${+l.servings} × ${servingText(l.food)}`, servings: l.servings }))));
}

function renderCustomFoods() {
  const q = query();
  const foods = loadCustomFoods().filter((f) => matches(f, q)).sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById("menu-list").replaceChildren(
    el("section", { class: "station" },
      el("button", { class: "link", onclick: () => openCustom(null) }, "+ Create a food"),
      foods.length
        ? foods.map((f) => el("div", { class: "row-wrap" },
            foodRow(f),
            el("button", { class: "link", onclick: () => openCustom(f) }, "Edit")))
        : el("p", { class: "muted small" },
            q ? "No matches." : "Add things Phelps doesn't list, like snacks from your room or Kletz.")));
}

function renderQuickAdd() {
  const field = (id, label, attrs = {}) =>
    el("label", {}, label, el("input", { id, type: "number", min: "0", step: "any", ...attrs }));
  const submit = (e) => {
    e.preventDefault();
    const calories = numOrNull("qa-cal");
    if (!(calories > 0)) return;
    addLog(state.addMeal, 1, {
      quick: true,
      name: document.getElementById("qa-name").value.trim() || "Quick add",
      calories,
      protein_g: numOrNull("qa-protein"),
      carbs_g: numOrNull("qa-carbs"),
      fat_g: numOrNull("qa-fat"),
    });
    show("diary");
  };
  document.getElementById("menu-list").replaceChildren(
    el("form", { class: "card form-grid", onsubmit: submit },
      el("p", { class: "muted small" }, "Know the calories but don't want to look it up? Log them directly."),
      field("qa-cal", "Calories", { required: "", min: "1" }),
      field("qa-protein", "Protein (g)"),
      field("qa-carbs", "Carbs (g)"),
      field("qa-fat", "Fat (g)"),
      el("label", {}, "Label", el("input", { id: "qa-name", maxlength: "60", placeholder: "optional" })),
      el("div", { class: "actions" }, el("button", { class: "primary", type: "submit" }, `Add to ${cap(state.addMeal)}`))));
  document.getElementById("qa-cal").focus();
}

// ---------- custom food dialog ----------

function openCustom(food) {
  state.editingCustom = food;
  document.getElementById("cf-title").textContent = food ? "Edit food" : "Create a food";
  const set = (id, v) => { document.getElementById(id).value = v ?? ""; };
  set("cf-name", food?.name);
  set("cf-size", food?.serving_size);
  set("cf-unit", food?.serving_unit);
  set("cf-cal", food?.calories);
  set("cf-protein", food?.protein_g);
  set("cf-carbs", food?.carbs_g);
  set("cf-fat", food?.fat_g);
  document.getElementById("cf-delete").hidden = !food;
  document.getElementById("custom-dialog").showModal();
}

function onCustomDialogClose() {
  const action = document.getElementById("custom-dialog").returnValue;
  let foods = loadCustomFoods();
  const editing = state.editingCustom;

  if (action === "save") {
    const food = {
      custom: true,
      custom_id: editing ? editing.custom_id : crypto.randomUUID(),
      name: document.getElementById("cf-name").value.trim(),
      serving_size: numOrNull("cf-size"),
      serving_unit: document.getElementById("cf-unit").value.trim() || null,
      calories: numOrNull("cf-cal") ?? 0,
      protein_g: numOrNull("cf-protein"),
      carbs_g: numOrNull("cf-carbs"),
      fat_g: numOrNull("cf-fat"),
    };
    foods = editing ? foods.map((f) => (f.custom_id === food.custom_id ? food : f)) : [...foods, food];
    saveCustomFoods(foods);
    Cloud.customFoodChanged(food);
  } else if (action === "delete" && editing) {
    saveCustomFoods(foods.filter((f) => f.custom_id !== editing.custom_id));
    Cloud.customFoodDeleted(editing);
  }
  renderAdd();
}

// ---------- food dialog ----------

function openFood(food, entry, servings = 1) {
  state.pendingFood = food;
  state.editing = entry;
  document.getElementById("fd-name").textContent = food.name;
  document.getElementById("fd-serving").textContent = food.quick ? "Quick add" : `1 serving = ${servingText(food)}`;
  document.getElementById("fd-warn").hidden = !food.needs_review;
  document.getElementById("fd-servings").value = entry ? entry.servings : servings;
  const mealSel = document.getElementById("fd-meal");
  mealSel.replaceChildren(...MEALS.map((m) => el("option", { value: m }, cap(m))));
  mealSel.value = entry ? entry.meal : state.addMeal;
  document.getElementById("fd-delete").hidden = !entry;
  document.getElementById("fd-save").textContent = entry ? "Save" : "Add";
  const tags = [...(food.dietary_tags || []), ...(food.allergens || []).map((a) => `contains ${a}`)];
  document.getElementById("fd-tags").textContent = tags.join(" · ");
  renderNutrition();
  document.getElementById("food-dialog").showModal();
}

function renderNutrition() {
  const f = state.pendingFood;
  const s = Number(document.getElementById("fd-servings").value) || 0;
  const rows = [
    ["Calories", f.calories, ""],
    ["Protein", f.protein_g, " g"],
    ["Carbs", f.carbs_g, " g"],
    ["Fat", f.fat_g, " g"],
    ["Fiber", f.fiber_g, " g"],
    ["Sugar", f.sugar_g, " g"],
    ["Sodium", f.sodium_mg, " mg"],
  ].filter(([, v], i) => i < 4 || v != null); // custom/quick foods only have the basics
  document.getElementById("fd-nutrition").replaceChildren(...rows.map(([label, v, unit]) =>
    el("tr", {}, el("td", {}, label), el("td", {}, v == null ? "–" : `${round(v * s)}${unit}`))));
}

function onFoodDialogClose() {
  const action = document.getElementById("food-dialog").returnValue;
  const servings = Number(document.getElementById("fd-servings").value);
  const meal = document.getElementById("fd-meal").value;

  if (action === "save" && servings > 0) {
    if (state.editing) {
      const updated = { ...state.editing, servings, meal };
      saveLogs(loadLogs().map((l) => (l.id === updated.id ? updated : l)));
      Cloud.logChanged(updated);
    } else {
      addLog(meal, servings, state.pendingFood);
    }
    show("diary");
  } else if (action === "delete" && state.editing) {
    saveLogs(loadLogs().filter((l) => l.id !== state.editing.id));
    Cloud.logDeleted(state.editing);
    renderDiary();
  }
}

// ---------- week ----------

function renderWeek() {
  const goal = loadGoal();
  const logs = loadLogs();
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = shiftDate(state.date, i - 6);
    const dayLogs = logs.filter((l) => l.date === date);
    return { date, logged: dayLogs.length > 0, ...totals(dayLogs) };
  });
  const logged = days.filter((d) => d.logged);
  const avg = (key) => (logged.length ? logged.reduce((s, d) => s + d[key], 0) / logged.length : 0);

  document.getElementById("week-stats").replaceChildren(
    el("div", {}, el("span", {}, logged.length ? fmt(avg("calories")) : "–"), el("small", {}, "Avg calories")),
    el("div", {}, el("span", {}, fmt(goal)), el("small", {}, "Daily goal")),
    el("div", {}, el("span", {}, `${logged.length}/7`), el("small", {}, "Days logged")));

  renderWeekChart(days, goal);

  const cell = (d, key, unit = "") => (d.logged ? `${fmt(d[key])}${unit}` : "–");
  document.getElementById("week-table").replaceChildren(...[
    el("tr", {}, ["Day", "Calories", "Protein", "Carbs", "Fat"].map((h) => el("th", {}, h))),
    days.map((d) => el("tr", { class: "day", onclick: () => { state.date = d.date; show("diary"); } },
      el("td", {}, `${weekday(d.date)} ${shortDate(d.date)}`),
      el("td", {}, cell(d, "calories")),
      el("td", {}, cell(d, "protein_g", " g")),
      el("td", {}, cell(d, "carbs_g", " g")),
      el("td", {}, cell(d, "fat_g", " g")))),
    logged.length
      ? el("tr", {},
          el("td", {}, el("strong", {}, "Average")),
          ["calories", "protein_g", "carbs_g", "fat_g"].map((k) =>
            el("td", {}, el("strong", {}, `${fmt(avg(k))}${k === "calories" ? "" : " g"}`))))
      : null,
  ].flat().filter(Boolean));
}

function renderWeekChart(days, goal) {
  const W = 520, H = 200, m = { top: 18, right: 8, bottom: 26, left: 40 };
  const plotW = W - m.left - m.right, plotH = H - m.top - m.bottom;
  const max = Math.max(goal * 1.15, ...days.map((d) => d.calories * 1.08));
  const step = [250, 500, 1000, 2000].find((s) => max / s <= 5) || 2500;
  const yMax = Math.ceil(max / step) * step;
  const y = (v) => m.top + plotH - (v / yMax) * plotH;
  const band = plotW / days.length;
  const barW = Math.min(28, band * 0.5);

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `Daily calories for the week vs a goal of ${fmt(goal)}` });

  for (let v = 0; v <= yMax; v += step) {
    root.append(svg("line", { class: "grid", x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }));
    root.append(svg("text", { class: "axis", x: m.left - 6, y: y(v) + 4, "text-anchor": "end" },
      v >= 1000 ? `${v / 1000}k` : v));
  }

  const chart = document.getElementById("week-chart");
  const tip = el("div", { class: "chart-tip", hidden: "" });
  const today = todayISO();

  days.forEach((d, i) => {
    const cx = m.left + band * i + band / 2;
    if (d.calories > 0) {
      // Bar with a 4px rounded top, square at the baseline.
      const x = cx - barW / 2, top = y(d.calories), bottom = y(0), r = Math.min(4, bottom - top);
      root.append(svg("path", { class: "bar",
        d: `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${bottom} Z` }));
    }
    root.append(svg("text", { class: `axis${d.date === today ? " today" : ""}`, x: cx, y: H - 8, "text-anchor": "middle" },
      weekday(d.date)));

    // Full-height hit area: bigger than the bar, so hover and tap are easy.
    const hit = svg("rect", { class: "hit", x: cx - band / 2, y: m.top, width: band, height: plotH, rx: 4 });
    hit.addEventListener("pointerenter", () => {
      tip.textContent = `${weekday(d.date)} ${shortDate(d.date)} · ${d.logged ? `${fmt(d.calories)} cal` : "nothing logged"}`;
      tip.hidden = false;
      const box = chart.getBoundingClientRect(), scale = box.width / W;
      tip.style.left = `${cx * scale}px`;
      tip.style.top = `${Math.min(y(d.calories), y(goal)) * scale - 6}px`;
    });
    hit.addEventListener("pointerleave", () => { tip.hidden = true; });
    hit.addEventListener("click", () => { state.date = d.date; show("diary"); });
    root.append(hit);
  });

  // Goal reference line, drawn on top of the bars.
  root.append(svg("line", { class: "goal", x1: m.left, x2: W - m.right, y1: y(goal), y2: y(goal) }));
  root.append(svg("text", { class: "goal-label", x: W - m.right, y: y(goal) - 5, "text-anchor": "end" },
    `Goal ${fmt(goal)}`));

  chart.replaceChildren(root, tip);
}

// ---------- account ----------

const account = { email: "", codeSent: false, busy: false, error: "" };

function renderAccount() {
  const root = document.getElementById("account-view");
  const u = Cloud.user();
  const privacy = el("p", { class: "muted small" },
    "Your diary is private: only you can see it. Phelps Tracker stores your email and what you log, nothing else.");

  if (!Cloud.configured) {
    root.replaceChildren(el("section", { class: "card" },
      el("h2", { class: "card-title" }, "Accounts aren't set up yet"),
      el("p", { class: "muted" }, "Your diary is saved on this device only."),
      exportButton()));
    return;
  }

  if (u) {
    const st = Cloud.status();
    const pending = Cloud.pendingCount();
    const line = st.state === "syncing" ? "Syncing…"
      : st.state === "ok" ? `Synced at ${new Date(st.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : st.message || (pending ? `${pending} change${pending === 1 ? "" : "s"} waiting to sync` : "Not synced yet");
    root.replaceChildren(
      el("section", { class: "card" },
        el("h2", { class: "card-title" }, "Signed in"),
        el("p", {}, u.email),
        el("p", { class: `small ${st.state === "error" ? "warn" : "muted"}` }, line),
        el("div", { class: "actions start" },
          el("button", { class: "primary", onclick: () => Cloud.syncNow() }, "Sync now"),
          exportButton(),
          el("button", { onclick: signOut }, "Sign out"))),
      el("section", { class: "card" }, privacy,
        el("button", { class: "link danger-link", onclick: deleteAccount }, "Delete my account and data")));
    return;
  }

  // Signed out: email -> code.
  const msg = account.error ? el("p", { class: "warn" }, account.error) : null;
  const form = account.codeSent
    ? el("form", { class: "form-grid", onsubmit: submitCode },
        el("p", {}, `We emailed a code to ${account.email}. It can take a minute to arrive.`),
        el("label", {}, "Code", el("input", { id: "acct-code", inputmode: "numeric", autocomplete: "one-time-code",
          pattern: "[0-9]{6,10}", maxlength: "10", required: "" })),
        msg,
        el("div", { class: "actions" },
          el("button", { type: "button", onclick: () => { account.codeSent = false; account.error = ""; renderAccount(); } },
            "Use a different email"),
          el("button", { class: "primary", type: "submit" }, account.busy ? "Signing in…" : "Sign in")))
    : el("form", { class: "form-grid", onsubmit: submitEmail },
        el("label", {}, "Hope email", el("input", { id: "acct-email", type: "email", autocomplete: "email",
          placeholder: "you@hope.edu", required: "", value: account.email })),
        msg,
        el("div", { class: "actions" },
          el("button", { class: "primary", type: "submit" }, account.busy ? "Sending…" : "Email me a code")));

  root.replaceChildren(
    el("section", { class: "card" },
      el("h2", { class: "card-title" }, "Sync your diary"),
      el("p", { class: "muted small" },
        "Sign in with your Hope email to back up your diary and use it on your phone and laptop. " +
        "Anything you've already logged on this device comes with you."),
      form),
    el("section", { class: "card" }, privacy, exportButton()));
  document.getElementById(account.codeSent ? "acct-code" : "acct-email")?.focus();
}

async function submitEmail(e) {
  e.preventDefault();
  if (account.busy) return;
  const email = document.getElementById("acct-email").value; // read before re-rendering clears it
  account.email = email.trim();
  account.busy = true; account.error = ""; renderAccount();
  try {
    account.email = await Cloud.requestCode(email);
    account.codeSent = true;
  } catch (err) {
    account.error = err.message;
  }
  account.busy = false; renderAccount();
}

async function submitCode(e) {
  e.preventDefault();
  if (account.busy) return;
  const code = document.getElementById("acct-code").value; // read before re-rendering clears it
  account.busy = true; account.error = ""; renderAccount();
  try {
    await Cloud.verifyCode(account.email, code);
    account.codeSent = false;
  } catch (err) {
    account.error = /expired|invalid/i.test(err.message) ? "That code is wrong or has expired. Try again or request a new one." : err.message;
  }
  account.busy = false; renderAccount();
}

async function signOut() {
  const pending = Cloud.pendingCount();
  const warn = pending ? `\n\n${pending} change(s) haven't synced yet and will be lost if you're offline.` : "";
  if (!confirm(`Sign out? Your diary will be removed from this device (it stays in your account).${warn}`)) return;
  await Cloud.signOut();
}

async function deleteAccount() {
  if (!confirm("Delete your account and everything you've logged? This can't be undone.")) return;
  try {
    await Cloud.deleteAccount();
    alert("Your account and data have been deleted.");
  } catch (err) {
    alert(`Couldn't delete your account: ${err.message}`);
  }
}

function exportButton() {
  return el("button", { onclick: exportData }, "Export my data");
}

function exportData() {
  const data = { exported_at: new Date().toISOString(), goal: loadGoal(), logs: loadLogs(), customFoods: loadCustomFoods() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = el("a", { href: url, download: `phelps-tracker-${todayISO()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- wiring ----------

async function init() {
  try {
    const res = await fetch("phelps_menu.json");
    const data = await res.json();
    for (const f of data.foods) state.foods.set(f.component_id, f);
    state.menu = data.menu;
  } catch (e) {
    document.getElementById("status").textContent =
      "Couldn't load the menu. Check your connection, or locally run fetch_phelps.py and `python -m http.server -d web`.";
  }

  const step = () => (state.view === "week" ? 7 : 1);
  document.getElementById("prev-day").onclick = () => { state.date = shiftDate(state.date, -step()); refresh(); };
  document.getElementById("next-day").onclick = () => { state.date = shiftDate(state.date, step()); refresh(); };
  document.getElementById("add-back").onclick = () => show("diary");
  document.getElementById("search").oninput = renderAdd;
  document.getElementById("fd-servings").oninput = renderNutrition;
  document.getElementById("food-dialog").addEventListener("close", onFoodDialogClose);
  document.getElementById("custom-dialog").addEventListener("close", onCustomDialogClose);
  for (const b of document.querySelectorAll("#bottom-nav button")) b.onclick = () => show(b.dataset.view);

  const goalDialog = document.getElementById("goal-dialog");
  document.getElementById("edit-goal").onclick = () => {
    document.getElementById("goal-input").value = loadGoal();
    goalDialog.showModal();
  };
  goalDialog.addEventListener("close", () => {
    if (goalDialog.returnValue === "save") {
      const goal = Number(document.getElementById("goal-input").value);
      saveGoal(goal);
      Cloud.goalChanged(goal);
    }
    refresh();
  });

  Cloud.onData(refresh); // a sync brought in changes from another device
  Cloud.onStatus(() => { if (state.view === "account") renderAccount(); });
  show("diary");
  Cloud.start();
}

init();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {}); // the app still works without it
}
