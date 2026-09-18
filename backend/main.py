from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any, Optional
import asyncio
import os
import json
from openai import AsyncOpenAI
from dotenv import load_dotenv
from fire_data import fetch_and_process_fire_data
from hermes_agent import assess_location, make_client as make_hermes_client, HERMES_MODEL
from simulated_clock import clock

# Load OPENROUTER_API_KEY (and any other secrets) from backend/.env for local dev.
# On Render the variable is set in the dashboard, so this is a no-op there.
load_dotenv()

if not os.getenv("OPENROUTER_API_KEY"):
    print("WARNING: OPENROUTER_API_KEY is not set. Copy backend/.env.example to backend/.env and add your key.")

# Model is configurable so it can be swapped (e.g. to a Hermes model) without a code change.
OPENROUTER_MODEL="thinkingmachines/inkling:free"
MODEL = os.getenv("OPENROUTER_MODEL", OPENROUTER_MODEL)

app = FastAPI()

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Update with your Vercel URL in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# OpenRouter Client (OpenAI SDK is compatible with OpenRouter)
client = AsyncOpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.getenv("OPENROUTER_API_KEY", "your-openrouter-key")
)

# Hermes situational-awareness agent (reads fire data, judges wildfire risk at a location).
hermes_client = make_hermes_client()

BASE_SYSTEM_PROMPT = (
    "You are a crisis-response AI agent for a wildfire emergency in Washington State. "
    "Use simple, plain-language steps. Provide verified, personalized guidance based on the "
    "user's persona (citizen, caregiver, firefighter)."
)

PERSONA_GUIDANCE = {
    "citizen": "The user is a citizen. Prioritize evacuation routes, go-bag checklists, and where to get official updates.",
    "caregiver": "The user is a caregiver responsible for others (children, elderly, patients). Prioritize mobility, medication, and shelter needs.",
    "firefighter": "The user is a firefighter. Use operational language: staging areas, containment lines, wind and terrain considerations.",
}


# Chatbot Request Model.
# The Vercel AI SDK posts UI messages shaped like {id, role, parts: [{type: 'text', text}]}
# along with extra fields (id, trigger, messageId). Pydantic ignores the extras.
class ChatRequest(BaseModel):
    messages: list[dict[str, Any]]
    persona: Optional[str] = None


class AssessRequest(BaseModel):
    lat: float
    lng: float
    persona: Optional[str] = None


def ui_message_to_openai(message: dict[str, Any]) -> Optional[dict[str, str]]:
    """
    Convert a Vercel AI SDK UI message (or a plain {role, content} message)
    into the {role, content} shape the OpenAI-compatible API expects.
    Returns None for messages with no text.
    """
    role = message.get("role")
    if role not in ("user", "assistant"):
        return None

    content = message.get("content")
    if not isinstance(content, str):
        parts = message.get("parts") or []
        content = "".join(
            part.get("text", "")
            for part in parts
            if isinstance(part, dict) and part.get("type") == "text"
        )

    content = content.strip()
    if not content:
        return None
    return {"role": role, "content": content}


@app.websocket("/ws/fire-data")
async def websocket_endpoint(websocket: WebSocket):
    """
    Streams live processed fire data to the frontend Mapbox UI.
    """
    await websocket.accept()
    try:
        while True:
            data = fetch_and_process_fire_data()
            data["simulated_time"] = clock.isoformat()
            await websocket.send_json(data)
            # Fetch and update every 10 seconds (simulated live feed)
            await asyncio.sleep(10)
    except WebSocketDisconnect:
        print("Client disconnected")

@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    """
    Endpoint for Vercel AI SDK frontend. Streams AI responses as plain text,
    which matches the frontend's TextStreamChatTransport.
    """
    system_content = BASE_SYSTEM_PROMPT
    persona = (request.persona or "").lower().strip()
    if persona in PERSONA_GUIDANCE:
        system_content += " " + PERSONA_GUIDANCE[persona]

    system_msg = {"role": "system", "content": system_content}
    history = [m for m in (ui_message_to_openai(msg) for msg in request.messages) if m]
    messages = [system_msg] + history

    async def generate():
        try:
            response = await client.chat.completions.create(
                model=MODEL,
                messages=messages,
                stream=True,
            )
            async for chunk in response:
                # Some providers send keep-alive chunks with no choices.
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    yield delta
        except Exception as exc:  # noqa: BLE001 - surface any provider error to the user
            print(f"Chat error: {exc!r}")
            yield f"\n[Agent error: {type(exc).__name__}: {exc}]"

    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")

@app.post("/api/assess")
async def assess_endpoint(request: AssessRequest):
    """
    Hermes agent: is there a wildfire at / near this location?
    Deterministic geometry decides; Hermes writes the guidance. Always returns JSON.
    """
    zones = fetch_and_process_fire_data()
    return await assess_location(
        hermes_client,
        lat=request.lat,
        lng=request.lng,
        zones=zones,
        persona=request.persona,
    )

@app.get("/")
def read_root():
    return {
        "status": "Backend is running live",
        "model": MODEL,
        "hermes_model": HERMES_MODEL,
        "simulated_time": clock.isoformat(),
    }


@app.get("/api/time")
def read_simulated_time():
    return {"simulated_time": clock.isoformat()}
