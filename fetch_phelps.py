"""
Pull Phelps Dining Hall menus + nutrition from FD MealPlanner (Gordon Food Service).

Usage:
    pip install requests
    python fetch_phelps.py              # next 7 days -> phelps_menu.json
    python fetch_phelps.py --days 14

Output JSON has two lists you can load straight into the database (see schema.sql):
    foods: one row per recipe (componentId), with nutrition PER SERVING and the serving size
    menu:  which food is served on which date, meal, and station

Be a good citizen: this makes one request per meal period per month, so run it
once a day at most and serve your app from your own database.
"""
import argparse
import json
import time
from datetime import date, timedelta

import requests

TENANT, ACCOUNT, LOCATION = 7, 10033, 10112  # Hope College / Phelps Dining Hall
MEALS_URL = f"https://apiservicelocatorstenant.fdmealplanner.com/api/v1/data-locator-webapi/{TENANT}/meals"
HEADERS = {
    "User-Agent": "HopeMacros/0.1 (student project; contact: YOUR_EMAIL_HERE)",
    "Accept": "application/json",
    "x-jsonresponsecase": "camel",
}
# 3 is confirmed as dinner ("Phelps Dinner ..." in the response). Check 1 and 2.
MEAL_PERIODS = {1: "breakfast", 2: "lunch", 3: "dinner"}

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
        resp = requests.get(
            MEALS_URL,
            params={
                "menuId": 0,
                "accountId": ACCOUNT,
                "locationId": LOCATION,
                "mealPeriodId": meal_period_id,
                "tenantId": TENANT,
                "monthId": f"{s.month:02d}",
                "startDate": s.strftime("%Y/%m/%d"),
                "endDate": e.strftime("%Y/%m/%d"),
                "timeOffset": 0,
            },
            headers=HEADERS,
            timeout=30,
        )
        resp.raise_for_status()
        rows.extend(resp.json().get("result") or [])
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--out", default="phelps_menu.json")
    args = ap.parse_args()

    start = date.today()
    end = start + timedelta(days=args.days - 1)
    all_foods, all_menu = {}, []

    for period_id, meal_name in MEAL_PERIODS.items():
        rows = fetch_rows(period_id, start, end)
        # Station names (conceptData) only come back on some days' rows, so pool them.
        concepts = [c for row in rows for c in row.get("conceptData") or []]
        for row in rows:
            day = row.get("strMenuForDate", "")
            if not (start.isoformat() <= day <= end.isoformat()):
                continue
            foods, menu = parse_day(row, meal_name, concepts)
            all_foods.update(foods)
            # The same recipe can appear at two stations; keep one entry per station.
            seen = {(m["date"], m["meal"], m["station"], m["component_id"]) for m in all_menu}
            all_menu += [m for m in menu if (m["date"], m["meal"], m["station"], m["component_id"]) not in seen]

    with open(args.out, "w") as f:
        json.dump({"foods": list(all_foods.values()), "menu": all_menu}, f, indent=2)

    flagged = [f["name"] for f in all_foods.values() if f["needs_review"]]
    print(f"{len(all_foods)} foods, {len(all_menu)} menu entries -> {args.out}")
    if flagged:
        print(f"{len(flagged)} need a manual check: {', '.join(sorted(flagged))}")


if __name__ == "__main__":
    main()
