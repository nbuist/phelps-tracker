# Phelps Tracker

A MyFitnessPal-style calorie and macro tracker for Hope College students, built around the real
menus at Phelps Dining Hall. Instead of guessing what's in "chicken from the Homestyle line," you
pick the actual item off today's menu and log it by the serving.

> Student project. Not affiliated with Hope College Dining Services. Nutrition numbers come from
> the dining hall's public menu data and can contain errors.

## Features

- **Diary**: daily goal − food = remaining, carb/fat/protein progress bars, and Breakfast, Lunch,
  Dinner, and Snacks sections. Tap any entry to change servings, move it to another meal, or remove it.
- **Phelps menu**: the day's breakfast, lunch, and dinner menus grouped by station (Homestyle,
  Trattoria, Global Bowls, Zone, Deli, Plant Forward, Greens, American Grille), with search and a
  servings picker that updates nutrition as you go.
- **Recent foods**: things you've logged before, newest first, with your last serving amount.
- **My foods**: create your own foods for anything Phelps doesn't serve.
- **Quick add**: log calories (and optionally macros) directly.
- **Week view**: a 7-day calorie chart against your goal, a daily macro table, and averages.
- **Daily goal**: adjustable, with a reminder that Hope's Health Center and athletic trainers can
  help figure out what's right for you.

## Use it

Open **<https://nbuist.github.io/phelps-tracker/>** and add it to your home screen:

- **iPhone (Safari):** Share → Add to Home Screen
- **Android (Chrome):** ⋮ menu → Add to Home screen / Install app

It opens full-screen like a regular app and keeps working when the Phelps Wi-Fi drops out (it
shows the last menu it downloaded).

Your diary, custom foods, and goal are saved on your device in that browser, so they don't sync
between devices yet.

## Run it locally

You need Python 3.

```bash
pip install requests
python fetch_phelps.py              # next 7 days of menus -> web/phelps_menu.json
python -m http.server 8000 -d web   # serve the app
```

Then open <http://127.0.0.1:8000/>. Re-run `fetch_phelps.py` to pick up new menus (`--days 14` for
a longer range). Please keep it to about once a day; see [Data source](#data-source).

## Deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) fetches the next 14 days of menus
and publishes `web/` to GitHub Pages on every push to `main` and every morning at 10:00 UTC. You
can also run it by hand from the Actions tab (**Fetch menus and deploy → Run workflow**).

GitHub pauses scheduled workflows after 60 days without a commit; re-enable it from the Actions
tab if the menu stops updating.

## Project structure

| Path | What it is |
|---|---|
| `fetch_phelps.py` | Downloads Phelps menus and nutrition and writes `web/phelps_menu.json` (`foods` + `menu`). |
| `web/` | The app: plain HTML, CSS, and JavaScript with no build step. Includes a web app manifest, icons, and a service worker (`sw.js`) for install and offline use. |
| `.github/workflows/deploy.yml` | Daily menu fetch + GitHub Pages deploy. |
| `schema.sql` | Postgres/Supabase schema for the planned backend (`foods`, `menu_items`, `food_logs`, `daily_totals`). |
| `CLAUDE.md` | Detailed developer notes: API response shape, known data issues, decisions. |

`web/phelps_menu.json` is generated, so it isn't checked in.

## Data source

Menus come from FD MealPlanner (Gordon Food Service's menu platform), the same public data behind
the [Phelps menu calendar](https://www.fdmealplanner.com/pages/calendar/?tenantId=7&accountId=10033&locationId=10112&mealPeriodId=3).
The fetcher makes one request per meal per month and the app only reads the saved file, so
traffic to their servers stays minimal.

### Known data issues

- Some salad-bar condiments are listed with whole-container nutrition (e.g. Thousand Island at
  14,080 kcal). The app hides anything over 1,000 kcal per serving and marks other suspect items
  with a **check** badge.
- A few recipe values look off (basmati rice at 404 kcal per 4 oz vs. white rice at 109 kcal per 3 oz).

## Roadmap

- [x] Menu fetcher
- [x] Diary, menu browsing, servings picker, daily goal
- [x] Recent foods, custom foods, quick add, weekly history
- [x] Hosted on GitHub Pages, installable on phones, works offline
- [x] Daily automatic menu sync
- [ ] Supabase backend with accounts so logs sync across devices
- [ ] Contact Hope Dining Services for permission before a campus-wide launch, and report data issues
