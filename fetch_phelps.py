"""
Build the app's Phelps menu: nutrition from FD MealPlanner (Gordon Food Service), checked
against Hope Dining's own menu feed so the menu matches hope.edu (see hope_menu.py).

Usage (Python 3.9+, standard library only):
    python fetch_phelps.py              # next 7 days -> web/phelps_menu.json
    python fetch_phelps.py --days 14

Output JSON:
    foods:  one row per FD recipe (componentId), with nutrition PER SERVING and the serving size
    menu:   what is served on which date, meal, and station; component_id is null when an item
            has no FD nutrition match
    checks: per date and meal, whether it was verified against Hope's menu and how well it matched

Be a good citizen: this makes one request per FD meal period per month plus one to Hope,
so run it once a day at most.
"""
import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import hope_menu

TENANT, ACCOUNT, LOCATION = 7, 10033, 10112  # Hope College / Phelps Dining Hall
MEALS_URL = f"https://apiservicelocatorstenant.fdmealplanner.com/api/v1/data-locator-webapi/{TENANT}/meals"
HEADERS = {
    "User-Agent": "PhelpsTracker/1.0 (student project; +https://github.com/nbuist/phelps-tracker)",
    "Accept": "application/json",
    "x-jsonresponsecase": "camel",
}
MEAL_PERIODS = {1: "breakfast", 2: "lunch", 3: "dinner"}  # FD mealPeriodId -> meal (confirmed)


def today_in_holland():
    """Today's date at Hope (Eastern time). The deploy server runs on UTC, so using its date
    would make an evening deploy start the menu at tomorrow and drop today's."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/New_York")).date()
    except Exception:  # no time zone database (e.g. some Windows installs): EST is close enough
        return datetime.now(timezone(timedelta(hours=-5))).date()


def get_json(url, params=None):
    """GET a URL and parse JSON, with the project's headers and a timeout."""
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as resp:
        return json.load(resp)

# FD foods from this many days back are kept as a nutrition library, so items whose FD menu cycle
# has ended (e.g. breakfast between cycles) can still be matched by name.
LIBRARY_DAYS_BACK = 35
ALIASES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "name_aliases.json")

# Items above this per-serving calorie count, or with no serving size, get
# flagged for a human to check (the salad-bar dressings come back with
# whole-container numbers, e.g. Thousand Island at 14,080 kcal).
REVIEW_CALORIE_LIMIT = 1000


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def split_list(value):
    return [p.strip() for p in (value or "").split(",") if p.strip()]


def month_spans(start, end):
    """The API only returns one month per request."""
    spans, cur = [], start
    while cur <= end:
        next_month = (cur.replace(day=1) + timedelta(days=32)).replace(day=1)
        spans.append((cur, min(end, next_month - timedelta(days=1))))
        cur = next_month
    return spans


def fetch_rows(meal_period_id, start, end):
    rows = []
    for s, e in month_spans(start, end):
        data = get_json(MEALS_URL, {
            "menuId": 0,
            "accountId": ACCOUNT,
            "locationId": LOCATION,
            "mealPeriodId": meal_period_id,
            "tenantId": TENANT,
            "monthId": f"{s.month:02d}",
            "startDate": s.strftime("%Y/%m/%d"),
            "endDate": e.strftime("%Y/%m/%d"),
            "timeOffset": 0,
        })
        rows.extend(data.get("result") or [])
        time.sleep(1)
    return rows


def stations_for(concepts, day):
    """Map rowId -> station name (HOMESTYLE, TRATTORIA, ...) for the week containing `day`."""
    out = {}
    for c in concepts:
        if c.get("strWeekStartDate", "") <= day <= c.get("strWeekEndDate", ""):
            out[c.get("rowId")] = (c.get("conceptName") or "").strip().title()
    return out


def parse_day(row, meal_name, concepts):
    day = row.get("strMenuForDate")
    if not day or row.get("isLocationClosed"):
        return {}, []
    details = {r.get("componentId"): r for r in row.get("allMenuRecipes") or []}
    stations = stations_for(concepts, day)
    foods, menu = {}, []

    for item in row.get("menuRecipiesData") or []:
        if item.get("isShowOnMenu") != 1:
            continue
        cid = item.get("componentId")
        extra = details.get(cid, {})
        name = (item.get("componentEnglishName") or item.get("componentName") or "").strip()
        size = num(extra.get("recipePortionSize"))
        calories = num(item.get("calories"))

        foods[cid] = {
            "component_id": cid,
            "name": name,
            "description": (item.get("componentEnglishDescription") or "").strip(),
            "category": (item.get("category") or "").strip(),
            "serving_size": size or None,
            "serving_unit": (extra.get("recipePortionSizeUnit") or "").strip() or None,
            "calories": calories,
            "protein_g": num(item.get("protein")),
            "carbs_g": num(item.get("carbohydrates")),
            "fat_g": num(item.get("fat")),
            "saturated_fat_g": num(item.get("saturatedFat")),
            "trans_fat_g": num(item.get("transFattyAcid")),
            "fiber_g": num(item.get("dietaryFiber")),
            "sugar_g": num(item.get("totalSugars")),
            "sodium_mg": num(item.get("sodium")),
            "cholesterol_mg": num(item.get("cholesterol")),
            "allergens": split_list(item.get("allergenName")),
            "dietary_tags": split_list(item.get("dietaryName")),
            "ingredients": (extra.get("ingredientStatement") or "").strip() or None,
            "image_path": item.get("recipeImagePath") or None,
            "needs_review": not size or (calories or 0) > REVIEW_CALORIE_LIMIT,
        }
        menu.append({
            "date": day,
            "meal": meal_name,
            "station": stations.get(item.get("rowId"), "Other"),
            "component_id": cid,
            "is_entree": item.get("isEntreeType") == 1,
            "sort_order": item.get("sequenceNumber"),
        })
    return foods, menu


def fetch_hope_feed():
    return get_json(hope_menu.HOPE_FEED_URL, {"t": int(time.time() * 1000)})


def load_aliases():
    with open(ALIASES_FILE, encoding="utf-8") as f:
        raw = json.load(f)
    return {hope_menu.norm(k): v for k, v in raw.items() if not k.startswith("_")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--out", default="web/phelps_menu.json")
    args = ap.parse_args()

    start = today_in_holland()
    end = start + timedelta(days=args.days - 1)
    lib_start = start - timedelta(days=LIBRARY_DAYS_BACK)
    all_foods, fd_menu = {}, []

    for period_id, meal_name in MEAL_PERIODS.items():
        rows = fetch_rows(period_id, lib_start, end)
        # Station names (conceptData) only come back on some days' rows, so pool them.
        concepts = [c for row in rows for c in row.get("conceptData") or []]
        for row in sorted(rows, key=lambda r: r.get("strMenuForDate", "")):
            day = row.get("strMenuForDate", "")
            foods, menu = parse_day(row, meal_name, concepts)
            all_foods.update(foods)  # later days win, so nutrition is the most recent version
            if start.isoformat() <= day <= end.isoformat():
                # The same recipe can appear at two stations; keep one entry per station.
                seen = {(m["date"], m["meal"], m["station"], m["component_id"]) for m in fd_menu}
                fd_menu += [m for m in menu if (m["date"], m["meal"], m["station"], m["component_id"]) not in seen]

    try:
        feed = fetch_hope_feed()
    except (OSError, ValueError) as e:  # network errors and bad JSON
        feed = None
        print(f"::warning title=Hope menu unavailable::Couldn't load Hope Dining's menu feed ({e}). "
              "Using FD MealPlanner's menu, unverified.")
    fd_data = (list(all_foods.values()), fd_menu)
    try:
        menu, checks = hope_menu.reconcile(*fd_data, feed, load_aliases(), start.isoformat(), end.isoformat())
    except Exception as e:  # Hope changed its feed's format: keep the site up with FD's menu
        print(f"::warning title=Hope menu unreadable::Couldn't read Hope Dining's menu feed "
              f"({type(e).__name__}: {e}). Using FD MealPlanner's menu, unverified.")
        menu, checks = hope_menu.reconcile(*fd_data, None, {}, start.isoformat(), end.isoformat())

    # Ship only the foods the menu uses (the library is just for matching).
    used = {m["component_id"] for m in menu if m.get("component_id") is not None}
    foods_out = [f for f in all_foods.values() if f["component_id"] in used]
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"foods": foods_out, "menu": menu, "checks": list(checks.values())}, f, indent=2)

    print(f"{len(foods_out)} foods, {len(menu)} menu entries -> {args.out}")
    report(checks, start, end)


def report(checks, start, end):
    """Print the menu check and raise GitHub Actions warnings for things worth a look."""
    print("\nMenu check (Hope's menu vs FD MealPlanner):")
    verified = [c for c in checks.values() if c["source"] == "hope"]
    for c in checks.values():
        if c["source"] == "hope":
            print(f"  {c['date']} {c['meal']:9} verified: {c['matched']}/{c['items']} items have nutrition"
                  + (f"; {len(c['fd_only'])} FD items not on Hope's menu" if c["fd_only"] else ""))
        else:
            print(f"  {c['date']} {c['meal']:9} FD only ({c['reason']}): {c['items']} items")
    if not verified:
        print("::warning title=Menu not verified::No meals could be checked against Hope's menu.")
    else:
        items = sum(c["items"] for c in verified)
        matched = sum(c["matched"] for c in verified)
        print(f"\n{len(verified)} meals verified; {matched}/{items} items ({matched / items:.0%}) have nutrition.")
        for c in verified:
            if c["items"] >= 5 and c["matched"] / c["items"] < 0.3:
                print(f"::warning title=Low nutrition match {c['date']} {c['meal']}::Only {c['matched']} of "
                      f"{c['items']} items on Hope's menu matched FD MealPlanner nutrition.")
        unmatched = sorted({n for c in verified for n in c["unmatched"]})
        if unmatched:
            print(f"No nutrition match ({len(unmatched)}; add to name_aliases.json if an FD food fits): "
                  + ", ".join(unmatched))
    # Menus are published in cycles (e.g. "Phelps Bfast 9.28-10.18"). A meal missing from both
    # sources for the whole range usually means a cycle ended and the next isn't posted.
    for meal in MEAL_PERIODS.values():
        if not any(c["meal"] == meal for c in checks.values()):
            print(f"::warning title=No {meal} menu::Neither Hope nor FD MealPlanner listed {meal} "
                  f"for {start} to {end}.")


if __name__ == "__main__":
    main()
