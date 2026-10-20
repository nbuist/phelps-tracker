"""
Check FD MealPlanner menus against Hope Dining's own menu feed (the data behind
https://hope.edu/offices/dining-services/menus-locations/phelps.html).

Hope's feed is the source of truth for what is actually served: items, stations, and meals
(including Sunday brunch and the Express station). It has no nutrition, so each Hope item is
matched by name to an FD MealPlanner food, whose nutrition the app uses.

Everything here is pure (no network), so it can be run against saved data.
"""
import difflib
import html
import re
from datetime import datetime, timedelta

HOPE_FEED_URL = "https://diningbucket.hope.edu/menus-and-hours.json"

# Hope's hour names -> the app's meals. Brunch is stored as "lunch" (the app labels it Brunch).
MEAL_FOR_HOURS = {"breakfast": "breakfast", "brunch": "lunch", "lunch": "lunch", "dinner": "dinner"}
# A station's time window has to overlap a meal's hours by this much to count as part of it.
MIN_OVERLAP = timedelta(minutes=30)
# Hope's legend: [V] vegan, [G] vegetarian, [CG] contains gluten, ** fried.
TAG_NAMES = {"V": "Vegan", "G": "Vegetarian", "CG": "Contains Gluten"}

STOPWORDS = {"with", "and", "the", "of", "a", "on", "in", "w"}
# Words that describe a dish without changing what it is, so they don't count against a match:
# cooking/prep words and the station or brand labels FD puts in front of names.
MODIFIERS = {
    "roasted", "baked", "grilled", "steamed", "sauteed", "fried", "braised", "slow", "oven",
    "sliced", "chopped", "diced", "crispy", "fresh", "spiced", "seasoned", "marinated", "pulled",
    "smoky", "taqueria", "dashi", "zone", "hope", "bakery", "traditional", "indian", "classic",
    "house", "homestyle", "soup", "sauce",
}
# Cooking methods. For a one-word dish they can be what makes it a different food
# ("Rice" vs "Fried Rice", "Cheese" vs "Grilled Cheese"), so FD may not add one Hope doesn't have.
METHODS = {"roasted", "baked", "grilled", "steamed", "sauteed", "fried", "braised", "slow", "oven",
           "pulled", "crispy"}
SPELLING = {"shitake": "shiitake", "smokey": "smoky", "veggie": "vegetable", "veggies": "vegetables",
            "parm": "parmesan", "bbq": "barbecue", "firecrakers": "firecrackers"}


def stem(word):
    """Crude plural/past-tense folding so "potatoes"/"potato" and "herbed"/"herb" compare equal."""
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith("oes"):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    if len(word) > 5 and word.endswith("ed"):
        return word[:-2]
    return word


# ---------- parsing Hope's feed ----------

def norm(name):
    """Lowercase, & -> and, drop punctuation, collapse spaces."""
    s = html.unescape(name).lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _raw_words(name):
    out = []
    for t in norm(name).split():
        t = SPELLING.get(t, t)
        if t not in STOPWORDS and not t.isdigit():
            out.append(t)
    return out


def words(name):
    """Meaningful words of a name, in order: stopwords and numbers dropped, spelling and plurals folded."""
    return [stem(t) for t in _raw_words(name)]


def core(name):
    """Words that identify the dish (descriptive modifiers removed before stemming)."""
    raw = _raw_words(name)
    kept = [stem(t) for t in raw if t not in MODIFIERS]
    return kept or [stem(t) for t in raw]


def tokens(name):
    return set(core(name))


def tidy_station(name):
    """"ZONE 1" -> "Zone 1"; leave mixed-case names as they are."""
    name = re.sub(r"\s+", " ", name).strip()
    return name.title() if name.isupper() else name


def parse_items(fragment):
    """Hope's foodAtStation HTML -> [{name, tags, allergens, fried}]. Text only; never kept as HTML."""
    items = []
    for li in re.findall(r"<li[^>]*>(.*?)</li>", fragment or "", flags=re.S | re.I):
        parts = re.split(r"<br\s*/?>", li, flags=re.I)
        text = lambda h: html.unescape(re.sub(r"<[^>]+>", " ", h)).replace("�", " ")
        raw = re.sub(r"\s+", " ", text(parts[0])).strip()
        tags = [TAG_NAMES[t] for t in re.findall(r"\[(CG|G|V)\]", raw)]
        fried = "**" in raw
        name = re.sub(r"\[(CG|G|V)\]\s*", "", raw).replace("**", "")
        name = re.split(r"CONTAINS:", name)[0].strip()
        rest = text(" ".join(parts[1:]))
        m = re.search(r"CONTAINS:\s*([A-Z ,]+)", rest)
        allergens = [a.strip().title() for a in m.group(1).split(",") if a.strip()] if m else []
        if name:
            items.append({"name": name, "tags": tags, "allergens": allergens, "fried": fried})
    return items


def meal_windows(hours):
    """Hope's hours list -> {date: [(meal, start, end)]}. All Day Dining joins the meal before it."""
    by_day = {}
    for h in sorted(hours, key=lambda h: h["start"]):
        start, end = datetime.fromisoformat(h["start"]), datetime.fromisoformat(h["end"])
        day = start.date().isoformat()
        windows = by_day.setdefault(day, [])
        meal = MEAL_FOR_HOURS.get(h["name"].strip().lower())
        if meal:
            windows.append([meal, start, end])
        elif windows:  # "All Day Dining" right after a meal: same food is usually still out
            windows.append([windows[-1][0], start, end])
    return by_day


def hope_menu(feed, location="phelps"):
    """Hope's feed -> (entries, posted) where entries are {date, meal, station, ...item} and
    posted is the set of (date, meal) pairs Hope has published hours for."""
    loc = next((x for x in feed if x.get("name") == location), None)
    if loc is None:
        raise ValueError(f"location {location!r} not in Hope's feed")
    windows = meal_windows(loc.get("hours") or [])
    posted = {(day, w[0]) for day, ws in windows.items() for w in ws}
    entries, seen = [], set()
    for order, m in enumerate(loc.get("menus") or []):
        start, end = datetime.fromisoformat(m["start"]), datetime.fromisoformat(m["end"])
        day = start.date().isoformat()
        meals = {meal for meal, ws, we in windows.get(day, [])
                 if min(end, we) - max(start, ws) >= MIN_OVERLAP
                 or (ws <= start and end <= we)}
        station = tidy_station(m.get("stationName") or "Other")
        for item in parse_items(m.get("foodAtStation")):
            for meal in meals:
                key = (day, meal, station, norm(item["name"]))
                if key not in seen:
                    seen.add(key)
                    entries.append({"date": day, "meal": meal, "station": station, "order": order, **item})
    return entries, posted


# ---------- matching Hope items to FD foods ----------

def similarity(hope, fd):
    """How confidently a Hope menu name and an FD food name are the same dish, 0..1.

    1.0  same name once case, punctuation, plurals and spelling are folded (or a tiny typo)
    0.9  same identifying words, ignoring descriptive ones ("Chopped Cilantro" = "Cilantro";
         "Tea Soaked Eggs" = "Dashi Spiced Tea-Soaked Eggs"), or the same dish before "with"
    else word overlap (Jaccard), allowed only when every identifying FD word is in Hope's name
         and the main noun (last word) agrees. Hope often adds description ("Beef Pot Roast" for
         "Pot Roast"); extra FD words usually mean another dish ("Roasted Broccoli and Red Onion"
         is not "Sliced Red Onion"), and "Hot Honey Chicken" never matches a pizza."""
    wa, wb = words(hope), words(fd)
    if not wa or not wb:
        return 0.0
    if wa == wb or difflib.SequenceMatcher(None, " ".join(wa), " ".join(wb)).ratio() >= 0.93:
        return 1.0
    ca, cb = set(core(hope)), set(core(fd))
    if ca == cb:
        if len(ca) == 1:
            methods = lambda n: {t for t in _raw_words(n) if t in METHODS}
            if methods(fd) - methods(hope):  # "Rice" vs "Fried Rice", "Roasted" vs "Grilled Chicken"
                return 0.0
        return 0.9
    before_with = lambda n: re.split(r"\bwith\b", norm(n))[0]
    if set(core(before_with(hope))) == set(core(before_with(fd))) and len(core(before_with(hope))) >= 2:
        return 0.9
    if len(cb) < 2 or not cb <= ca or core(hope)[-1] != core(fd)[-1]:
        return 0.0
    return len(ca & cb) / len(ca | cb)


def best_match(name, candidates, threshold):
    """Best FD food for a Hope item name among candidates, or (None, 0). Ties go to the closer length."""
    best, best_key = None, None
    for food in candidates:
        score = similarity(name, food["name"])
        if score < threshold:
            continue
        key = (score, -abs(len(words(food["name"])) - len(words(name))))
        if best_key is None or key > best_key:
            best, best_key = food, key
    return best, (best_key[0] if best_key else 0.0)


def match_item(item, day, meal, fd_today, fd_library, aliases):
    """Find the FD food for a Hope item. Returns (food or None, how).
    Order: manual alias, then the same day+meal on FD (looser, since the dish is probably there),
    then every FD food seen recently (stricter, to avoid wrong nutrition)."""
    alias = aliases.get(norm(item["name"]))
    if alias:
        if alias == "-":  # explicitly "no match"
            return None, "alias:none"
        hit = next((f for f in fd_library if norm(f["name"]) == norm(alias)), None)
        if hit:
            return hit, "alias"
    same_meal = fd_today.get((day, meal), [])
    same_day = [f for (d, _), fs in fd_today.items() if d == day for f in fs]
    for pool in (same_meal, same_day):
        food, score = best_match(item["name"], pool, threshold=0.6)
        if food:
            return food, "exact" if score == 1.0 else "same-day"
    food, score = best_match(item["name"], fd_library, threshold=0.75)
    if food:
        return food, "exact" if score == 1.0 else "library"
    return None, "none"


def reconcile(fd_foods, fd_menu, feed, aliases, start, end):
    """Combine the two sources into the app's menu.

    Where Hope has posted a meal, Hope's items are the menu (with FD nutrition when matched).
    Where it hasn't (Hope's feed only looks about a week ahead), FD's menu is used, marked
    unverified. Returns (menu, checks) where checks summarizes each (date, meal)."""
    foods_by_id = {f["component_id"]: f for f in fd_foods}
    fd_today = {}
    for m in fd_menu:
        food = foods_by_id.get(m["component_id"])
        if food:
            fd_today.setdefault((m["date"], m["meal"]), []).append(food)
    fd_library = list(foods_by_id.values())

    hope_entries, posted = hope_menu(feed) if feed else ([], set())
    hope_by_meal = {}
    for e in hope_entries:
        if start <= e["date"] <= end:
            hope_by_meal.setdefault((e["date"], e["meal"]), []).append(e)

    menu, checks = [], {}
    meals = sorted({k for k in fd_today if start <= k[0] <= end} | set(hope_by_meal))
    for day, meal in meals:
        hope_items = hope_by_meal.get((day, meal))
        check = {"date": day, "meal": meal}
        if hope_items:
            matched_ids, unmatched = set(), []
            for e in hope_items:
                food, how = match_item(e, day, meal, fd_today, fd_library, aliases)
                menu.append({
                    "date": day, "meal": meal, "station": e["station"],
                    "component_id": food["component_id"] if food else None,
                    "name": e["name"], "tags": e["tags"], "allergens": e["allergens"],
                    "fried": e["fried"], "sort_order": e["order"], "verified": True, "match": how,
                })
                if food:
                    matched_ids.add(food["component_id"])
                else:
                    unmatched.append(e["name"])
            fd_only = sorted({f["name"] for f in fd_today.get((day, meal), [])
                              if f["component_id"] not in matched_ids})
            check.update(source="hope", items=len(hope_items), matched=len(hope_items) - len(unmatched),
                         unmatched=sorted(set(unmatched)), fd_only=fd_only)
        else:
            for m in fd_menu:
                if m["date"] == day and m["meal"] == meal:
                    menu.append({**m, "verified": False, "match": "fd"})
            reason = "not posted on Hope's menu yet" if (day, meal) not in posted else "Hope lists no items"
            check.update(source="fd", items=len(fd_today.get((day, meal), [])), reason=reason)
        checks[f"{day} {meal}"] = check
    return menu, checks
