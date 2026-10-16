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
- **Daily goal and macro targets**: set your calories and how they split between carbs, fat, and
  protein (as percentages, with the grams shown as you type). Hope's Health Center and athletic
  trainers can help figure out what's right for you.
- **FAQ**: answers to common questions, on the Account tab.
- **Account and sync (optional)**: sign in with your @hope.edu email and a one-time code to back
  up your diary and use it on more than one device. Works offline and syncs when you reconnect.
  Export your data or delete your account any time from the Account tab.

## Use it

Open **<https://nbuist.github.io/phelps-tracker/>** and add it to your home screen:

- **iPhone (Safari):** Share → Add to Home Screen
- **Android (Chrome):** ⋮ menu → Add to Home screen / Install app

It opens full-screen like a regular app and keeps working when the Phelps Wi-Fi drops out (it
shows the last menu it downloaded).

Without an account, your diary, custom foods, and goal stay on that device. Sign in from the
**Account** tab to sync them. Signing out removes the diary from that device (it stays in your
account), so it's safe to use on a shared computer.

## Privacy and security

- Only @hope.edu addresses can sign up, and you sign in with a one-time code (no passwords).
- Each student can only read and change their own data. This is enforced by the database
  itself (Postgres Row Level Security), not just the app.
- The app stores your email and what you log, nothing else. No names, weights, or photos.
- Security problems can be reported privately through GitHub's
  [private vulnerability reporting](https://github.com/nbuist/phelps-tracker/security/advisories/new).

## Project structure

| Path | What it is |
|---|---|
| `fetch_phelps.py` | Downloads Phelps menus and nutrition and writes `web/phelps_menu.json` (`foods` + `menu`). |
| `web/` | The app: plain HTML, CSS, and JavaScript with no build step. Includes a web app manifest, icons, and a service worker (`sw.js`) for install and offline use. |
| `web/cloud.js` | Sign-in and sync. |
| `schema.sql` | Database tables and the rules that keep each student's data private. |
| `.github/workflows/deploy.yml` | Updates the menu every morning and publishes the site. |

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
- [x] Accounts with @hope.edu sign-in and sync across devices
- [ ] Contact Hope Dining Services for permission before a campus-wide launch, and report data issues
