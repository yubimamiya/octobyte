from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import asyncio
import os
import json
from openai import AsyncOpenAI
from fire_data import fetch_and_process_fire_data

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

# Chatbot Request Model
class ChatRequest(BaseModel):
    messages: list

@app.websocket("/ws/fire-data")
async def websocket_endpoint(websocket: WebSocket):
    """
    Streams live processed fire data to the frontend Mapbox UI.
    """
    await websocket.accept()
    try:
        while True:
            data = fetch_and_process_fire_data()
            await websocket.send_json(data)
            # Fetch and update every 10 seconds (simulated live feed)
            await asyncio.sleep(10)
    except WebSocketDisconnect:
        print("Client disconnected")

@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    """
    Endpoint for Vercel AI SDK frontend. Streams AI responses.
    """
    async def generate():
        # Inject system prompt with context about the current fire
        system_msg = {
            "role": "system", 
            "content": "You are a crisis-response AI agent. Use simple, plain-language steps. "
                       "Provide verified, personalized guidance based on user persona (citizen, caregiver, firefighter)."
        }
        messages = [system_msg] + request.messages

        response = await client.chat.completions.create(
            model="meta-llama/llama-3-8b-instruct:free", # Change to a stronger model using your $100 budget
            messages=messages,
            stream=True
        )
        async for chunk in response:
            if chunk.choices[0].delta.content is not None:
                # Vercel AI SDK expects standard text streams by default, or specific data protocols.
                # A simple text stream works for basic use cases.
                yield chunk.choices[0].delta.content

    return StreamingResponse(generate(), media_type="text/plain")

@app.get("/")
def read_root():
    return {"status": "Backend is running live"}