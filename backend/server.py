"""
APEX-02 — thin API gateway.

This process exists only because the hosted preview routes every `/api/*` request
to port 8001. It forwards them verbatim to the Node decision engine that owns all
the market state (default 127.0.0.1:8790) and streams the answer straight back.

Running the project anywhere else (locally, VPS, Railway, Fly…) does NOT need
this file: `frontend/next.config.mjs` already rewrites `/api/*` to the engine,
so the dashboard code is identical in both environments.

No business logic, no database, no state: if you are looking for the brain, it is
in `engine/src`.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path

load_dotenv(Path(__file__).parent / ".env")

ENGINE_URL = os.environ.get("ENGINE_URL", "http://127.0.0.1:8790").rstrip("/")
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "content-encoding",
}

client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global client
    client = httpx.AsyncClient(base_url=ENGINE_URL, timeout=httpx.Timeout(90.0, connect=5.0))
    try:
        yield
    finally:
        await client.aclose()


app = FastAPI(title="APEX-02 gateway", docs_url=None, redoc_url=None, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.api_route(
    "/api/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def gateway(path: str, request: Request) -> Response:
    assert client is not None
    body = await request.body()
    url = f"/api/{path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"

    headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in HOP_BY_HOP and k.lower() != "host"
    }

    try:
        upstream = await client.request(request.method, url, content=body or None, headers=headers)
    except httpx.ConnectError:
        return Response(
            content=(
                '{"error":"decision engine unreachable",'
                '"hint":"start it with: cd engine && yarn start"}'
            ),
            status_code=503,
            media_type="application/json",
        )
    except httpx.ReadTimeout:
        return Response(
            content='{"error":"engine timeout"}',
            status_code=504,
            media_type="application/json",
        )

    out_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP_BY_HOP}
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=out_headers,
        media_type=upstream.headers.get("content-type", "application/json"),
    )
