"""
Hermes wildfire assessment agent.

Reads the processed fire data (red = active fire perimeters, yellow = high-risk
zones), works out deterministically whether a location is inside or near a
wildfire, then asks a Hermes model on OpenRouter to turn those facts into a
plain-language assessment with recommended actions.

The geometry is the source of truth. The model only writes the narrative, so a
model outage or a bad reply can never flip "wildfire detected" the wrong way.
"""
import json
import math
import os
import re
from typing import Any, Optional

from openai import AsyncOpenAI

# Any OpenRouter model id works here. Hermes 3 70B is the default; override with HERMES_MODEL.
HERMES_MODEL = os.getenv("HERMES_MODEL", "nousresearch/hermes-3-llama-3.1-70b")

# Distance thresholds (km) used to grade risk when a point is outside every zone.
WARNING_DISTANCE_KM = 5.0
WATCH_DISTANCE_KM = 25.0

RISK_ORDER = ["none", "watch", "warning", "evacuate"]


def make_client() -> AsyncOpenAI:
    """
    OpenRouter client for the Hermes agent. Uses HERMES_API_KEY if set so the
    agent can run on its own key, otherwise falls back to OPENROUTER_API_KEY.
    """
    api_key = os.getenv("HERMES_API_KEY") or os.getenv("OPENROUTER_API_KEY") or "missing-hermes-key"
    return AsyncOpenAI(base_url="https://openrouter.ai/api/v1", api_key=api_key)


# ---------------------------------------------------------------------------
# Geometry (deterministic ground truth)
# ---------------------------------------------------------------------------

def point_in_ring(lng: float, lat: float, ring: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon. Ring is [[lng, lat], ...]."""
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            x_cross = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
            if lng < x_cross:
                inside = not inside
    return inside


def haversine_km(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def distance_to_ring_km(lng: float, lat: float, ring: list[list[float]]) -> float:
    """Approximate distance from a point to a polygon: 0 if inside, else nearest vertex/edge-midpoint."""
    if point_in_ring(lng, lat, ring):
        return 0.0
    candidates = list(ring)
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        candidates.append([(x1 + x2) / 2, (y1 + y2) / 2])
    return min(haversine_km(lng, lat, x, y) for x, y in candidates)


def geometric_assessment(lat: float, lng: float, zones: dict[str, Any]) -> dict[str, Any]:
    """Facts about a location relative to the current red/yellow zones."""
    red = zones.get("red_zones") or []
    yellow = zones.get("yellow_zones") or []

    red_hits = [z["id"] for z in red if point_in_ring(lng, lat, z["coordinates"])]
    yellow_hits = [z["id"] for z in yellow if point_in_ring(lng, lat, z["coordinates"])]
    nearest_red_km = min((distance_to_ring_km(lng, lat, z["coordinates"]) for z in red), default=None)
    nearest_yellow_km = min((distance_to_ring_km(lng, lat, z["coordinates"]) for z in yellow), default=None)

    if red_hits:
        risk = "evacuate"
    elif yellow_hits or (nearest_red_km is not None and nearest_red_km <= WARNING_DISTANCE_KM):
        risk = "warning"
    elif nearest_red_km is not None and nearest_red_km <= WATCH_DISTANCE_KM:
        risk = "watch"
    else:
        risk = "none"

    return {
        "location": {"lat": lat, "lng": lng},
        "wildfire_detected": risk != "none",
        "risk_level": risk,
        "inside_active_fire": bool(red_hits),
        "inside_high_risk_zone": bool(yellow_hits),
        "active_fire_ids": red_hits,
        "high_risk_zone_ids": yellow_hits,
        "nearest_active_fire_km": None if nearest_red_km is None else round(nearest_red_km, 1),
        "nearest_high_risk_zone_km": None if nearest_yellow_km is None else round(nearest_yellow_km, 1),
        "active_fire_count": len(red),
        "high_risk_zone_count": len(yellow),
    }


# ---------------------------------------------------------------------------
# Hermes narrative
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are Hermes, a wildfire situational-awareness agent for Washington State. "
    "You receive verified geometric facts about a location relative to active fire "
    "perimeters (red zones) and high-risk zones (yellow zones). Never contradict the facts. "
    "Respond with ONLY a JSON object, no prose, with keys: "
    '"headline" (max 12 words), "summary" (2-3 plain sentences), '
    '"recommended_actions" (array of 2-4 short imperative steps).'
)

PERSONA_HINTS = {
    "citizen": "Write for a resident: evacuation routes, go-bag, official alerts.",
    "caregiver": "Write for a caregiver: mobility, medications, moving dependents early.",
    "firefighter": "Write for a firefighter: staging, containment, wind and terrain.",
}


def _fallback_narrative(facts: dict[str, Any]) -> dict[str, Any]:
    """Used when the model is unavailable or returns something unparseable."""
    risk = facts["risk_level"]
    km = facts["nearest_active_fire_km"]
    if risk == "evacuate":
        return {
            "headline": "Inside an active fire perimeter. Evacuate now.",
            "summary": "This location is inside an active wildfire perimeter. Leave immediately by the safest route away from the fire.",
            "recommended_actions": ["Leave now; do not wait for further alerts.", "Head away from red zones on the map.", "Call 911 if you cannot leave."],
        }
    if risk == "warning":
        return {
            "headline": "Wildfire nearby. Prepare to evacuate.",
            "summary": f"An active fire is about {km} km away or this location is in a high-risk zone. Conditions can change quickly.",
            "recommended_actions": ["Pack essentials and keep your vehicle fueled.", "Monitor official alerts continuously.", "Be ready to leave within minutes."],
        }
    if risk == "watch":
        return {
            "headline": "Wildfire in the region. Stay alert.",
            "summary": f"The nearest active fire is about {km} km away. There is no immediate threat, but keep watching conditions.",
            "recommended_actions": ["Check official updates every hour.", "Review your evacuation route.", "Keep phones charged."],
        }
    return {
        "headline": "No wildfire threat detected here.",
        "summary": "No active fire or high-risk zone is near this location in the current data.",
        "recommended_actions": ["Continue normal activities.", "Stay aware of regional fire updates."],
    }


def _extract_json(text: str) -> Optional[dict[str, Any]]:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
    return None


async def assess_location(
    client: AsyncOpenAI,
    lat: float,
    lng: float,
    zones: dict[str, Any],
    persona: Optional[str] = None,
    model: str = HERMES_MODEL,
) -> dict[str, Any]:
    """
    Full assessment: deterministic facts + Hermes narrative.
    Always returns a usable result; `source` tells you whether Hermes answered.
    """
    facts = geometric_assessment(lat, lng, zones)

    persona_key = (persona or "").lower().strip()
    user_prompt = (
        f"Facts (JSON): {json.dumps(facts)}\n"
        f"{PERSONA_HINTS.get(persona_key, '')}\n"
        "Return the JSON object now."
    )

    narrative: Optional[dict[str, Any]] = None
    source = "fallback"
    error: Optional[str] = None
    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
            max_tokens=400,
        )
        text = response.choices[0].message.content or ""
        parsed = _extract_json(text)
        if parsed and isinstance(parsed.get("headline"), str) and isinstance(parsed.get("summary"), str):
            actions = parsed.get("recommended_actions")
            if not isinstance(actions, list):
                actions = [str(actions)] if actions else []
            narrative = {
                "headline": parsed["headline"].strip(),
                "summary": parsed["summary"].strip(),
                "recommended_actions": [str(a).strip() for a in actions if str(a).strip()][:4],
            }
            source = "hermes"
        else:
            error = "Model reply was not valid JSON"
    except Exception as exc:  # noqa: BLE001 - any provider failure falls back to deterministic text
        error = f"{type(exc).__name__}: {exc}"
        print(f"Hermes agent error: {error}")

    if narrative is None:
        narrative = _fallback_narrative(facts)

    return {**facts, **narrative, "model": model, "source": source, "error": error}
