#!/usr/bin/env python3
"""Runway local server: no installs needed, Python 3.9+ standard library only.

    python3 server.py            # then open http://localhost:8080

It does two things:
  1. Serves the Runway web app from this folder.
  2. Runs Watson: POST /v1/plan calls IBM watsonx.ai (Granite) when credentials
     are set, and falls back to safe built-in templates when they are not.

Credentials come from environment variables or a .env file next to this script
(copy .env.example to .env). Never put keys in the HTML or commit .env.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEMPLATES = json.loads((ROOT / "data" / "plan_templates.json").read_text(encoding="utf-8"))
WHEN = {"two_days_before", "night_before", "one_hour_before", "during_outage"}


# --------------------------------------------------------------------------- config
def load_env(path: Path) -> None:
    """Minimal .env reader: KEY=value lines, # comments, optional quotes."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env(ROOT / ".env")
API_KEY = os.getenv("WATSONX_API_KEY", "")
PROJECT_ID = os.getenv("WATSONX_PROJECT_ID", "")
REGION = os.getenv("WATSONX_REGION", "us-south")
MODEL_ID = os.getenv("WATSONX_MODEL_ID", "ibm/granite-4-h-small")
PORT = int(os.getenv("PORT", "8080"))

SYSTEM_PROMPT = """\
You are a household power-outage planning assistant. Respond to the resident's latest message.
Use the resident profile and forecast as background, but focus on what they just asked or told you.
Do not repeat unrelated actions from the profile. Do not invent facts, prices, battery run times,
nearby facilities, or outage predictions. Do not give medical treatment advice, dosing or diagnosis;
for device or medicine storage specifics, direct the resident to their supplier or pharmacist.
For an insulin fridge, suggest reviewing the medicine's storage instructions and asking a pharmacist
about backup cooling. Do not assume a safe storage duration or temperature, suggest moving an
appliance to a public facility, or promise that a battery or cooler will keep medicine safe.
Write a brief, direct "reply" in plain language, without a greeting or salutation. Answer the
latest message with a useful next step when possible. If the message is outside power-outage planning,
briefly explain what you can help with. Suggest 0 to 3 new plan items only when useful for the
latest message; an empty items array is valid. If a backup battery is known to cover fewer hours
than the expected outage, include a second power source or place to go when relevant.
Return only JSON matching the schema. Write "reply", "title" and "reason" in the resident's
language code, and provide English copies of item titles and reasons.
When the language code is "en", every string in the response must be in English.
Make every plan item title an action the resident can take, starting with a verb. Do not put a
number, duration, price, or place in a plan item unless it was given in the latest message or forecast.

Schema:
{
  "reply": "string",
  "items": [
    {
      "title": "string",
      "title_en": "string",
      "when": "two_days_before | night_before | one_hour_before | during_outage",
      "reason": "string",
      "reason_en": "string"
    }
  ]
}
"""


# --------------------------------------------------------------------------- watsonx
class WatsonxError(Exception):
    def __init__(self, reason: str, detail: str = ""):
        super().__init__(detail or reason)
        self.reason = reason


_token = {"value": "", "expires": 0.0}


def http_json(url: str, *, data: bytes, headers: dict, timeout: int) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            code = json.loads(body).get("errors", [{}])[0].get("code")
        except (ValueError, IndexError, AttributeError):
            code = None
        if code == "no_associated_service_instance_error":
            raise WatsonxError("runtime_unavailable", body) from None
        if code == "model_not_supported":
            raise WatsonxError("model_unavailable", body) from None
        if exc.code == 404:
            raise WatsonxError("project_unavailable", body) from None
        if exc.code in (401, 403):
            raise WatsonxError("access_denied", body) from None
        raise WatsonxError("watsonx_error", body) from None
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise WatsonxError("watsonx_error", str(exc)) from None


def iam_token() -> str:
    if _token["value"] and time.time() < _token["expires"] - 120:
        return _token["value"]
    data = urllib.parse.urlencode({"grant_type": "urn:ibm:params:oauth:grant-type:apikey", "apikey": API_KEY}).encode()
    resp = http_json("https://iam.cloud.ibm.com/identity/token", data=data,
                     headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}, timeout=20)
    _token["value"] = resp["access_token"]
    _token["expires"] = time.time() + int(resp.get("expires_in", 3600))
    return _token["value"]


def call_watsonx(req: dict) -> dict:
    if not API_KEY or not PROJECT_ID:
        raise WatsonxError("missing_credentials")
    user = json.dumps({
        "latest_message": req.get("message", ""),
        "recent_conversation": (req.get("history") or [])[-6:],
        "resident": req.get("resident") or {},
        "forecast": req.get("forecast") or {},
        "runwayHoursAtFullCharge": req.get("runwayHoursAtFullCharge"),
        "nearestCoolPlace": req.get("nearestCoolPlace", ""),
    }, indent=2)
    payload = {
        "model_id": MODEL_ID,
        "project_id": PROJECT_ID,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}],
        "parameters": {"max_new_tokens": 1024, "temperature": 0},
    }
    resp = http_json(f"https://{REGION}.ml.cloud.ibm.com/ml/v1/text/chat?version=2024-05-01",
                     data=json.dumps(payload).encode(),
                     headers={"Authorization": f"Bearer {iam_token()}", "Content-Type": "application/json", "Accept": "application/json"},
                     timeout=60)
    try:
        text = resp["choices"][0]["message"]["content"]
        if "```" in text:
            text = text.split("```")[1]
            text = text[4:] if text.startswith("json") else text
        parsed = json.loads(text)
    except (KeyError, IndexError, ValueError) as exc:
        raise WatsonxError("watsonx_error", f"unreadable model output: {exc}") from None
    items = [clean_item(i) for i in parsed.get("items") or [] if isinstance(i, dict)]
    return {"reply": str(parsed.get("reply", "")).strip(), "items": filter_items(req, [i for i in items if i]), "source": "llm", "fallback_reason": None}


def clean_item(item: dict) -> dict | None:
    title = str(item.get("title_en") or item.get("title") or "").strip()
    reason = str(item.get("reason_en") or item.get("reason") or "").strip()
    if not title:
        return None
    when = item.get("when") if item.get("when") in WHEN else "night_before"
    return {"title": str(item.get("title") or title), "title_en": title, "when": when,
            "reason": str(item.get("reason") or reason), "reason_en": reason}


def filter_items(req: dict, items: list[dict]) -> list[dict]:
    """Drop plan items that state numbers nobody gave us, or send insulin to a public facility."""
    message = req.get("message", "")
    allowed = set(re.findall(r"\d+(?:\.\d+)?", message))
    fc = req.get("forecast") or {}
    for v in (fc.get("durationLowHours"), fc.get("durationHighHours"), req.get("runwayHoursAtFullCharge")):
        if v is not None:
            allowed.add(str(v).removesuffix(".0"))
    kept = []
    for it in items:
        copy = " ".join((it["title"], it["title_en"], it["reason"], it["reason_en"]))
        if set(re.findall(r"\d+(?:\.\d+)?", copy)) - allowed:
            continue
        if "insulin" in message.lower() and re.search(r"cooling center|public facilit", copy, re.I):
            continue
        kept.append(it)
    return kept[:3]


def fallback(req: dict, reason: str) -> dict:
    """Safe, relevant templates when watsonx can't be reached."""
    message = (req.get("message") or "").lower()
    topics = {"insulin_fridge": ("insulin",), "oxygen_concentrator": ("oxygen", "concentrator"),
              "cpap": ("cpap",), "home_dialysis": ("dialysis",), "power_wheelchair": ("wheelchair",)}
    items = []
    for key, words in topics.items():
        if any(w in message for w in words):
            items += TEMPLATES.get(key, [])
    if not items and any(w in message for w in ("outage", "prepare", "power", "plan")):
        items = TEMPLATES.get("general", [])[:2]
    items = [{"title": t["title"], "title_en": t["title"], "when": t.get("when", "night_before"),
              "reason": t["reason"], "reason_en": t["reason"]} for t in items[:3]]
    reply = ("I can't answer that personally while watsonx is unavailable. "
             + ("These are general preparation steps for what you mentioned." if items else "Please try again when the service is connected."))
    return {"reply": reply, "items": items, "source": "fallback", "fallback_reason": reason}


# --------------------------------------------------------------------------- http
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Let the page call this server even when it was opened as a local file.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def send_json(self, status: int, body: dict):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/healthz":
            return self.send_json(200, {"status": "ok", "watsonx": bool(API_KEY and PROJECT_ID)})
        if path.startswith("/v1/"):
            return self.send_json(404, {"detail": "Not available in the lite server"})
        name = urllib.parse.unquote(path).rstrip("/").split("/")[-1]
        if name.startswith(".") or name.endswith(".py"):     # never serve .env or source files
            return self.send_json(404, {"detail": "Not found"})
        return super().do_GET()

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/v1/plan":
            return self.send_json(404, {"detail": "Not found"})
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 100_000)
            req = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(req, dict) or not str(req.get("message", "")).strip():
                return self.send_json(422, {"detail": "message is required"})
        except ValueError:
            return self.send_json(400, {"detail": "Body must be JSON"})
        try:
            body = call_watsonx(req)
        except WatsonxError as exc:
            if exc.reason != "missing_credentials":
                sys.stderr.write(f"watsonx: {exc.reason}: {str(exc)[:300]}\n")
            body = fallback(req, exc.reason)
        self.send_json(200, body)

    def log_message(self, fmt, *args):
        if "/v1/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    state = f"on, model {MODEL_ID}" if API_KEY and PROJECT_ID else "off (no credentials: Watson uses built-in answers)"
    print(f"Runway is running at http://localhost:{PORT}\nwatsonx: {state}\nPress Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
