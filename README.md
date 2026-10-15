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
- The key in `web/config.js` is Supabase's *publishable* key, which is meant to be public; the
  database rules are what protect the data. The secret key is never used by the app.
- Security problems can be reported privately through GitHub's
  [private vulnerability reporting](https://github.com/nbuist/phelps-tracker/security/advisories/new).

## Run it locally

You need Python 3.

```bash
pip install -r requirements.txt
python fetch_phelps.py              # next 7 days of menus -> web/phelps_menu.json
python -m http.server 8000 -d web   # serve the app
```

Then open <http://127.0.0.1:8000/>. Re-run `fetch_phelps.py` to pick up new menus (`--days 14` for
a longer range). Please keep it to about once a day; see [Data source](#data-source).

## Setting up your own Supabase project

To run a copy with your own backend (the app works without one; leave `web/config.js` empty):

1. Create a Supabase project and run [`schema.sql`](schema.sql) in its SQL Editor.
2. **Authentication → Auth Hooks**: add a *Before User Created* Postgres hook using
   `public.hook_restrict_signup_to_hope`.
3. **Authentication → Emails → SMTP Settings**: configure a custom SMTP sender (Supabase's
   built-in sender only emails project team members). Then edit the *Magic Link* and *Confirm
   signup* templates to show the code with `{{ .Token }}`.
4. Put the project URL and publishable key in `web/config.js`, and add the project URL to
   `connect-src` in the Content Security Policy in `web/index.html`.

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
| `web/cloud.js` | Sign-in and sync with Supabase (talks to its REST APIs directly, no library). |
| `web/config.js` | Supabase project URL and publishable key. |
| `schema.sql` | Supabase tables, Row Level Security policies, account deletion, and the @hope.edu sign-up hook. |

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
