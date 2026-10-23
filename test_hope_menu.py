"""Tests for hope_menu.py. Run: python -m unittest -v
The deploy workflow runs these before publishing, so a matching change that would attach the
wrong nutrition to a food stops the deploy instead of reaching students."""
import unittest

import hope_menu as H


class Matching(unittest.TestCase):
    # (Hope's name, FD's name): should these share nutrition?
    SAME = [
        ("Roasted Ham", "Ham"),
        ("Steamed Broccoli", "Broccoli"),
        ("Beef Pot Roast", "Pot Roast"),
        ("Mashed Yukon Potatoes", "Mashed Potatoes"),
        ("Balsamic Portobello", "Balsamic Portobello with Quinoa and Kale"),
        ("Hot & Sour Pork Broth", "Dashi Smokey Hot and Sour Pork Broth"),
        ("Grilled Sliced Chicken", "Grilled Chicken"),
        ("Tea Soaked Eggs", "Dashi Spiced Tea-Soaked Eggs"),
        ("Fajita Peppers & Onions", "Peppers and Onions"),
        ("Sesame Shiitake Mushrooms", "Dashi Sesame Shitake Mushrooms"),
        ("Garlic Parm Sauce", "Parmesan Garlic Sauce"),
        ("Flour Tortillas", '6" Flour Tortillas'),
        ("Jalapeno Bacon Firecrakers", "Jalapeno Bacon Firecrackers"),
    ]
    DIFFERENT = [
        ("Rice", "Fried Rice"),
        ("Rice Noodles", "Rice"),
        ("Sliced Cheese", "Grilled Cheese"),
        ("Roasted Chicken", "Pulled Chicken"),
        ("Roasted Chicken", "Grilled Chicken"),
        ("Sliced Red Onion", "Roasted Broccoli and Red Onion"),
        ("Slow Braised Beef", "Taqueria Pulled Beef"),
        ("Bacon", "Brussel Sprouts with Bacon"),
        ("Ranch", "Chicken Bacon Ranch Pizza"),
        ("Butter", "Butter Chicken"),
        ("Cheesy Ham Potato Bake", "Ham"),
        ("Baked Potatoes", "Baked Sweet Potatoes"),
        ("Crispy Chicken Hot Honey Pizza", "Hot Honey Chicken"),
        ("Veggie Vegan Cheese Pizza", "Cheese Pizza"),
        ("Buffalo Pulled Chicken", "Buffalo Chicken Sandwich"),
        ("Withered Greens", "Greens"),
    ]

    def test_same_dish(self):
        for hope, fd in self.SAME:
            with self.subTest(hope=hope, fd=fd):
                self.assertGreaterEqual(H.similarity(hope, fd), 0.6)

    def test_different_dish(self):
        for hope, fd in self.DIFFERENT:
            with self.subTest(hope=hope, fd=fd):
                self.assertLess(H.similarity(hope, fd), 0.6)


class Parsing(unittest.TestCase):
    def test_items_tags_and_allergens(self):
        html = ("<b>Pizza!</b><ul><li>[CG] [G] Biscuits<br><i>CONTAINS: WHEAT, MILK</i></li>"
                "<li>[V] Tater Tots**</li><li>CONTAINS: EGG</li><li>Smoked Sausage&amp;Peppers�</li></ul>")
        items = H.parse_items(html)
        self.assertEqual([i["name"] for i in items], ["Biscuits", "Tater Tots", "Smoked Sausage&Peppers"])
        self.assertEqual(items[0]["tags"], ["Contains Gluten", "Vegetarian"])
        self.assertEqual(items[0]["allergens"], ["Wheat", "Milk"])
        self.assertTrue(items[1]["fried"])

    def test_meals_from_hours(self):
        hours = [
            {"name": "Breakfast", "start": "2026-10-20T07:30:00-04:00", "end": "2026-10-20T09:30:00-04:00"},
            {"name": "All Day Dining", "start": "2026-10-20T09:30:00-04:00", "end": "2026-10-20T10:30:00-04:00"},
            {"name": "Lunch", "start": "2026-10-20T10:30:00-04:00", "end": "2026-10-20T13:30:00-04:00"},
            {"name": "Brunch", "start": "2026-10-25T10:30:00-04:00", "end": "2026-10-25T13:30:00-04:00"},
        ]
        feed = [{"name": "phelps", "hours": hours, "menus": [
            # Served during All Day Dining right after breakfast -> breakfast.
            {"stationName": "Express", "foodAtStation": "<ul><li>Scrambled Eggs</li></ul>",
             "start": "2026-10-20T09:30:00-04:00", "end": "2026-10-20T10:30:00-04:00"},
            # Sunday 7am with no breakfast hours: not served, dropped.
            {"stationName": "Breakfast 1", "foodAtStation": "<ul><li>Waffles</li></ul>",
             "start": "2026-10-25T07:00:00-04:00", "end": "2026-10-25T08:30:00-04:00"},
            {"stationName": "ZONE 1", "foodAtStation": "<ul><li>Ham</li></ul>",
             "start": "2026-10-25T10:00:00-04:00", "end": "2026-10-25T13:30:00-04:00"},
        ]}]
        entries, posted = H.hope_menu(feed)
        got = {(e["date"], e["meal"], e["station"], e["name"]) for e in entries}
        self.assertEqual(got, {("2026-10-20", "breakfast", "Express", "Scrambled Eggs"),
                               ("2026-10-25", "lunch", "Zone 1", "Ham")})
        self.assertIn(("2026-10-25", "lunch"), posted)


class Reconcile(unittest.TestCase):
    def test_hope_wins_and_fd_fills_unposted_days(self):
        fd_foods = [{"component_id": 1, "name": "Pot Roast"}, {"component_id": 2, "name": "Meatloaf"},
                    {"component_id": 3, "name": "Tacos"}]
        fd_menu = [{"date": "2026-10-20", "meal": "dinner", "station": "Zone", "component_id": 1},
                   {"date": "2026-10-20", "meal": "dinner", "station": "Zone", "component_id": 2},
                   {"date": "2026-10-21", "meal": "dinner", "station": "Zone", "component_id": 3}]
        feed = [{"name": "phelps",
                 "hours": [{"name": "Dinner", "start": "2026-10-20T17:00:00-04:00", "end": "2026-10-20T19:00:00-04:00"}],
                 "menus": [{"stationName": "Homestyle 2",
                            "foodAtStation": "<ul><li>Beef Pot Roast</li><li>Pickles</li></ul>",
                            "start": "2026-10-20T16:30:00-04:00", "end": "2026-10-20T19:00:00-04:00"}]}]
        menu, checks = H.reconcile(fd_foods, fd_menu, feed, {}, "2026-10-20", "2026-10-21")
        day1 = {m["name"]: m for m in menu if m["date"] == "2026-10-20"}
        self.assertEqual(set(day1), {"Beef Pot Roast", "Pickles"})  # Meatloaf isn't on Hope's menu
        self.assertEqual(day1["Beef Pot Roast"]["component_id"], 1)
        self.assertEqual(day1["Beef Pot Roast"]["station"], "Homestyle 2")
        self.assertIsNone(day1["Pickles"]["component_id"])
        self.assertEqual(checks["2026-10-20 dinner"]["fd_only"], ["Meatloaf"])
        day2 = [m for m in menu if m["date"] == "2026-10-21"]
        self.assertEqual([(m["component_id"], m["verified"]) for m in day2], [(3, False)])

    def test_unreadable_feed_raises(self):
        # fetch_phelps.py catches this and falls back to FD's menu with a warning.
        broken = [{"name": "phelps", "hours": [{"name": "Dinner"}], "menus": []}]
        with self.assertRaises(Exception):
            H.reconcile([], [], broken, {}, "2026-10-20", "2026-10-20")

    def test_feed_unavailable_falls_back_to_fd(self):
        fd_foods = [{"component_id": 1, "name": "Pot Roast"}]
        fd_menu = [{"date": "2026-10-20", "meal": "dinner", "station": "Zone", "component_id": 1}]
        menu, checks = H.reconcile(fd_foods, fd_menu, None, {}, "2026-10-20", "2026-10-20")
        self.assertEqual([m["verified"] for m in menu], [False])
        self.assertEqual(checks["2026-10-20 dinner"]["source"], "fd")


if __name__ == "__main__":
    unittest.main()
