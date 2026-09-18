import csv
import math
from datetime import datetime
from pathlib import Path
from typing import Any

from simulated_clock import clock

DATA_DIR = Path(__file__).resolve().parent / "data"
WINDOW_MINUTES = 2


def _parse_time_to_minutes(value: str) -> int:
    """Convert a HH:MM or HH:MM:SS timestamp to minutes since midnight."""
    text = (value or "").strip()
    if not text:
        raise ValueError("Missing time value")
    parts = text.split(":")
    if len(parts) < 2:
        raise ValueError(f"Unsupported time format: {value!r}")
    hour = int(parts[0])
    minute = int(parts[1])
    return hour * 60 + minute


def _as_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _window_current_time(current_time: str | datetime | None) -> str:
    if current_time is None:
        current_time = clock.isoformat()
    if isinstance(current_time, datetime):
        return current_time.strftime("%H:%M")
    if "T" in str(current_time):
        return datetime.fromisoformat(str(current_time)).strftime("%H:%M")
    return str(current_time).strip()


def get_fire_window_records(records: list[dict[str, Any]], current_time: str | datetime | None) -> list[dict[str, Any]]:
    """Return records whose time falls within +/- 2 minutes of the current simulated time."""
    target_time = _window_current_time(current_time)
    target_minutes = _parse_time_to_minutes(target_time)
    selected: list[dict[str, Any]] = []
    for row in records:
        time_value = row.get("Time") or row.get("time")
        if not time_value:
            continue
        try:
            delta_minutes = abs(_parse_time_to_minutes(str(time_value)) - target_minutes)
        except ValueError:
            continue
        if delta_minutes <= WINDOW_MINUTES:
            selected.append(row)
    return selected


def _build_point_zone(lat: float, lng: float, radius_km: float = 0.35, points: int = 12) -> list[list[float]]:
    """Create a small polygon around a point so it can act like an active-fire footprint."""
    ring: list[list[float]] = []
    for i in range(points):
        angle = (i / points) * 2 * math.pi
        offset_lat = radius_km * 0.008983 / 1.0
        offset_lng = radius_km * 0.008983 / math.cos(math.radians(lat))
        ring.append([
            lng + offset_lng * math.cos(angle),
            lat + offset_lat * math.sin(angle),
        ])
    return ring


def _read_csv_rows(csv_path: Path) -> list[dict[str, str]]:
    """Read CSVs robustly across the dataset's Latin-1/CP1252 text encoding."""
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            with csv_path.open(newline="", encoding=encoding) as handle:
                return list(csv.DictReader(handle))
        except (UnicodeDecodeError, ValueError):
            continue
    with csv_path.open(newline="", encoding="utf-8", errors="replace") as handle:
        return list(csv.DictReader(handle))


def fetch_and_process_fire_data(current_time: str | datetime | None = None) -> dict[str, Any]:
    """Load the CSV incident feed for the current simulated time and convert it to map-ready hotspots."""
    current_time_label = _window_current_time(current_time)
    all_records: list[dict[str, Any]] = []
    for csv_path in sorted(DATA_DIR.glob("*.csv")):
        for row in _read_csv_rows(csv_path):
            if not row:
                continue
            lat = _as_float(row.get("Latitude"))
            lng = _as_float(row.get("Longitude"))
            if not (math.isfinite(lat) and math.isfinite(lng)):
                continue
            normalized = {
                "source_file": csv_path.name,
                "Date": row.get("Date", "11/8"),
                "Time": (row.get("Time") or "").strip(),
                "Obs Window (min)": row.get("Obs Window (min)", "0"),
                "Latitude": lat,
                "Longitude": lng,
                "Location Source": row.get("Location Source", ""),
                "Fire Behavior Observations": row.get("Fire Behavior Observations", ""),
                "Type of Fire": row.get("Type of Fire", ""),
                "Residual Fire": row.get("Residual Fire", row.get("Residual Fire?", "")),
            }
            all_records.append(normalized)

    window_records = get_fire_window_records(all_records, current_time_label)
    red_hotspots: list[dict[str, Any]] = []
    incident_summary: list[dict[str, Any]] = []
    unsafe_rows: list[dict[str, Any]] = []

    for item in window_records:
        lat = float(item["Latitude"])
        lng = float(item["Longitude"])
        observation = (item.get("Fire Behavior Observations") or "fire incident").strip()
        row_summary = {
            "time": item.get("Time"),
            "latitude": lat,
            "longitude": lng,
            "fire_type": item.get("Type of Fire"),
            "residual_fire": item.get("Residual Fire") or "",
            "observation": observation,
        }
        incident_summary.append(row_summary)

        if observation:
            unsafe_rows.append(item)

        red_hotspots.append({
            "id": f"fire-{lat}-{lng}-{item.get('Time', '')}",
            "latitude": lat,
            "longitude": lng,
            "time": item.get("Time"),
            "fire_type": item.get("Type of Fire"),
            "residual_fire": item.get("Residual Fire") or "",
            "observation": observation,
        })

    red_zones = [
        {"id": f"fire-zone-{index}", "coordinates": _build_point_zone(float(spot["latitude"]), float(spot["longitude"]))}
        for index, spot in enumerate(red_hotspots)
    ]

    yellow_zones = [
        {"id": f"watch-zone-{index}", "coordinates": _build_point_zone(float(spot["latitude"]), float(spot["longitude"]), radius_km=0.6)}
        for index, spot in enumerate(red_hotspots[:10])
    ]

    return {
        "red_zones": red_zones,
        "yellow_zones": yellow_zones,
        "red_hotspots": red_hotspots,
        "yellow_hotspots": [],
        "current_time": current_time_label,
        "incident_summary": incident_summary[:30],
        "active_incidents": len(red_hotspots),
        "records_in_window": len(window_records),
        "source_files": sorted({item["source_file"] for item in window_records}),
        "simulated_time": current_time_label,
    }
