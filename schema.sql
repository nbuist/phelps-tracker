-- Postgres / Supabase schema for the Phelps calorie tracker.
-- `foods` and `menu_items` are filled by fetch_phelps.py; `food_logs` is what students create.

create table foods (
  component_id     integer primary key,       -- FD MealPlanner's recipe id; stable across days
  name             text not null,
  description      text,
  category         text,                      -- Entree, Side, Condiment, Appetizers
  serving_size     numeric,                   -- e.g. 4
  serving_unit     text,                      -- e.g. Ounce, Slice, Each, Fluid Ounce
  calories         numeric,                   -- all nutrition values are PER SERVING
  protein_g        numeric,
  carbs_g          numeric,
  fat_g            numeric,
  saturated_fat_g  numeric,
  trans_fat_g      numeric,
  fiber_g          numeric,
  sugar_g          numeric,
  sodium_mg        numeric,
  cholesterol_mg   numeric,
  allergens        text[] default '{}',
  dietary_tags     text[] default '{}',       -- Vegan, Vegetarian, Halal, Gluten Free...
  ingredients      text,
  image_path       text,
  needs_review     boolean default false,     -- bad/missing serving data; hide or fix by hand
  manual_override  boolean default false,     -- set true after you fix a row so the sync won't overwrite it
  updated_at       timestamptz default now()
);

create table menu_items (
  date          date not null,
  meal          text not null check (meal in ('breakfast', 'lunch', 'dinner')),
  station       text not null,                -- Homestyle, Trattoria, Global Bowls, Zone, Deli, Plant Forward, Greens
  component_id  integer not null references foods(component_id),
  is_entree     boolean default false,
  sort_order    integer,
  primary key (date, meal, station, component_id)
);

create table food_logs (
  id            bigint generated always as identity primary key,
  user_id       uuid not null,                -- auth.users(id) in Supabase
  date          date not null,
  meal          text not null,                -- breakfast, lunch, dinner, snack
  component_id  integer references foods(component_id),
  servings      numeric not null default 1 check (servings > 0),  -- 1.5 = one and a half servings
  logged_at     timestamptz default now()
);

create index on food_logs (user_id, date);

-- Daily totals: servings x per-serving nutrition, the same way MyFitnessPal does it.
create view daily_totals as
select l.user_id, l.date,
       round(sum(l.servings * f.calories))  as calories,
       round(sum(l.servings * f.protein_g)) as protein_g,
       round(sum(l.servings * f.carbs_g))   as carbs_g,
       round(sum(l.servings * f.fat_g))     as fat_g
from food_logs l
join foods f using (component_id)
group by l.user_id, l.date;
