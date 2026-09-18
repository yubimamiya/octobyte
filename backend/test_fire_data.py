import unittest

from fire_data import fetch_and_process_fire_data, get_fire_window_records


class FireDataWindowTests(unittest.TestCase):
    def test_window_selects_records_within_four_minutes(self):
        records = [
            {"Time": "10:58", "Latitude": 39.7, "Longitude": -121.6, "Fire Behavior Observations": "earlier"},
            {"Time": "10:59", "Latitude": 39.71, "Longitude": -121.61, "Fire Behavior Observations": "near"},
            {"Time": "11:00", "Latitude": 39.72, "Longitude": -121.62, "Fire Behavior Observations": "current"},
            {"Time": "11:01", "Latitude": 39.73, "Longitude": -121.63, "Fire Behavior Observations": "current2"},
            {"Time": "11:02", "Latitude": 39.74, "Longitude": -121.64, "Fire Behavior Observations": "current3"},
            {"Time": "11:03", "Latitude": 39.75, "Longitude": -121.65, "Fire Behavior Observations": "after"},
            {"Time": "11:04", "Latitude": 39.76, "Longitude": -121.66, "Fire Behavior Observations": "too late"},
        ]

        selected = get_fire_window_records(records, "11:00")
        self.assertEqual([row["Time"] for row in selected], ["10:58", "10:59", "11:00", "11:01", "11:02"])

    def test_fetch_processes_live_fire_hotspots_from_csvs(self):
        payload = fetch_and_process_fire_data("2018-11-08T11:00:00")
        self.assertIn("red_hotspots", payload)
        self.assertIn("incident_summary", payload)
        self.assertGreater(len(payload["red_hotspots"]), 0)
        self.assertTrue(all("latitude" in spot and "longitude" in spot for spot in payload["red_hotspots"]))


if __name__ == "__main__":
    unittest.main()
