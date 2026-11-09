"""FDE-only daily token admission. Mount DB directory persistently on the gateway.

Single gateway host, multi-worker safe through SQLite BEGIN IMMEDIATE. Unknown
outcomes retain their reservation until the next day; restarting never forgives
usage. No request text, provider key, or virtual key is stored here.
"""
import asyncio
import base64
import binascii
import hmac
import json
import os
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Header, HTTPException
from litellm.integrations.custom_logger import CustomLogger

DEFAULT_LIMIT = 2_000_000
MODEL = "fde-station-deepseek-flash"
QWEN_MODEL = "fde-station-qwen3.8-flash-next"
TEAM = os.environ.get("FDE_QUOTA_TEAM_ID", "")
# Trusted deployment contract: this FDE alias has a 131072-token context window.
# Reserve the full window for image requests instead of guessing visual tokens
# from compressed bytes. Actual provider usage releases the unused reservation.
IMAGE_CONTEXT_BOUNDS = {"fde-station-qwen3.8-flash-next": 131072}
SHANGHAI = timezone(timedelta(hours=8))


class QuotaLedger:
    def __init__(self, filename):
        self.filename = filename
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS limits(user_id TEXT PRIMARY KEY, daily_limit INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,day TEXT NOT NULL,
                  reserved INTEGER NOT NULL,used INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
                CREATE INDEX IF NOT EXISTS calls_user_day ON calls(user_id,day);
            """)

    def connect(self):
        db = sqlite3.connect(self.filename, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    @staticmethod
    def day():
        return datetime.now(SHANGHAI).strftime("%Y-%m-%d")

    def snapshot(self, user_id, db=None):
        if db is None:
            with self.connect() as connection:
                return self.snapshot(user_id, connection)
        day = self.day()
        row = db.execute("SELECT daily_limit FROM limits WHERE user_id=?", (user_id,)).fetchone()
        limit = row[0] if row else DEFAULT_LIMIT
        usage = db.execute("""SELECT COALESCE(SUM(used),0),
          COALESCE(SUM(CASE WHEN used IS NULL THEN reserved ELSE 0 END),0)
          FROM calls WHERE user_id=? AND day=?""", (user_id, day)).fetchone()
        return dict(daily_limit=limit, used=usage[0], reserved=usage[1],
                    remaining=max(0, limit-usage[0]-usage[1]), day=day, timezone="Asia/Shanghai")

    def set_limit(self, user_id, value):
        if type(value) is not int or not 0 <= value <= 1_000_000_000:
            raise HTTPException(400, "daily_limit must be an integer between 0 and 1000000000")
        with self.connect() as db:
            db.execute("INSERT INTO limits VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET daily_limit=excluded.daily_limit", (user_id, value))
        return self.snapshot(user_id)

    def reserve(self, user_id, prompt_bound, output_limit):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            snapshot = self.snapshot(user_id, db)
            available = snapshot["remaining"] - prompt_bound
            if available < 1:
                raise HTTPException(429, "今日 Token 额度不足，请申请提高额度或等待北京时间 00:00 重置")
            output_limit = min(output_limit, available)
            reservation = str(uuid.uuid4())
            db.execute("INSERT INTO calls(id,user_id,day,reserved) VALUES(?,?,?,?)",
                       (reservation, user_id, snapshot["day"], prompt_bound + output_limit))
            return reservation, output_limit

    def settle(self, reservation, tokens):
        if not isinstance(tokens, int) or tokens < 0:
            return  # fail closed: keep the existing reservation on invalid usage
        with self.connect() as db:
            db.execute("UPDATE calls SET used=? WHERE id=? AND used IS NULL", (tokens, reservation))


def prompt_upper_bound(data):
    messages = data.get("messages")
    if not isinstance(messages, list):
        raise HTTPException(400, "FDE quota supports chat completions only")
    normalized = []
    image_count = 0
    image_bytes = 0
    for message in messages:
        if not isinstance(message, dict):
            raise HTTPException(400, "invalid chat message")
        content = message.get("content")
        message_images = 0
        if isinstance(content, list):
            blocks = []
            for block in content:
                if not isinstance(block, dict):
                    raise HTTPException(400, "invalid content block")
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    blocks.append(block)
                elif block.get("type") == "image_url":
                    image = block.get("image_url")
                    url = image.get("url") if isinstance(image, dict) else None
                    if not isinstance(url, str) or not url.startswith(("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,")):
                        raise HTTPException(400, "FDE images require inline PNG, JPEG or WebP data")
                    encoded = url.split(",", 1)[1]
                    if len(encoded) > 13981016:
                        raise HTTPException(400, "FDE images are limited to 10 MiB each")
                    try:
                        raw = base64.b64decode(encoded, validate=True)
                    except (ValueError, binascii.Error):
                        raise HTTPException(400, "invalid image encoding") from None
                    image_count += 1
                    message_images += 1
                    image_bytes += len(raw)
                    if not raw or len(raw) > 10485760 or message_images > 10 or image_bytes > 226492416:
                        raise HTTPException(400, "FDE image count or size limit exceeded")
                    blocks.append({"type": "text", "text": "[image]"})
                else:
                    raise HTTPException(400, "unsupported FDE content block")
            normalized.append({**message, "content": blocks})
            continue
        if content is not None and not isinstance(content, str):
            raise HTTPException(400, "invalid chat content")
        normalized.append(message)
    # DeepSeek text tokenizer is byte based. Serialized UTF-8 bytes plus generous
    # per-message framing reserve an upper bound; actual provider usage settles it.
    payload = {k: data[k] for k in ("tools", "tool_choice", "response_format") if k in data}
    payload["messages"] = normalized
    serialized = json.dumps(payload, ensure_ascii=False)
    bound = len(serialized.encode("utf-8")) + 512 + 64 * len(messages)
    if image_count:
        context_bound = IMAGE_CONTEXT_BOUNDS.get(data.get("model"))
        if not context_bound:
            raise HTTPException(400, "image quota is not configured for this model")
        return max(bound, context_bound)
    return bound


def apply_qwen_output_policy(data, mode, output_limit):
    """Only called after trusted FDE key validation. Never raise the output limit.

    Qwen's reasoning tokens share max_tokens with its answer. Chat uses the
    official instruct settings; work reserves at least 3/4 for answer/tool calls.
    Flatten only our controlled extensions so extra_body cannot shadow them.
    """
    if data.get("model") != QWEN_MODEL:
        return
    extra = data.get("extra_body")
    if extra is None:
        extra = {}
    if not isinstance(extra, dict):
        raise HTTPException(400, "invalid extra_body")
    template = extra.get("chat_template_kwargs", data.get("chat_template_kwargs", {}))
    if not isinstance(template, dict):
        raise HTTPException(400, "invalid chat_template_kwargs")
    template = dict(template)
    extra = dict(extra)
    for name in ("chat_template_kwargs", "thinking_token_budget", "reasoning_effort"):
        extra.pop(name, None)
        data.pop(name, None)
    if mode == "chat" or output_limit < 128:
        template["enable_thinking"] = False
        # Qwen3.8 model card's instruct defaults, applied only to this FDE alias.
        for name, value in {"temperature": 0.7, "top_p": 0.8, "presence_penalty": 1.5}.items():
            extra.pop(name, None)
            data[name] = value
    else:
        data["thinking_token_budget"] = min(1024, output_limit // 4)
    if template:
        data["chat_template_kwargs"] = template
    if "extra_body" in data:
        data["extra_body"] = extra


class FdeQuota(CustomLogger):
    def __init__(self, ledger):
        super().__init__()
        self.ledger = ledger

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        metadata = user_api_key_dict.metadata or {}
        if TEAM:
            if user_api_key_dict.team_id != TEAM:
                return data
        else:
            # Internal gateway uplink is an administrator-created service key;
            # individual daily accounting happens at the internal team boundary.
            if metadata.get("fde_station_uplink") is True:
                return data
            if data.get("model") != MODEL and not metadata.get("fde_id"):
                return data
        user_id = metadata.get("fde_id")
        try:
            uuid.UUID(user_id)
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(403, "FDE model requires a personal FDE Station key")
        if call_type not in ("completion", "acompletion"):
            raise HTTPException(400, "FDE model supports chat completions only")
        if data.get("n", 1) != 1:
            raise HTTPException(400, "FDE quota requires n=1")
        output = data.get("max_completion_tokens", data.get("max_tokens", 8192))
        if type(output) is not int or output < 1:
            raise HTTPException(400, "invalid max_tokens")
        output = min(output, 8192)
        apply_qwen_output_policy(data, metadata.get("mode"), output)
        reservation, output = await asyncio.to_thread(self.ledger.reserve, user_id, prompt_upper_bound(data), output)
        data.pop("max_completion_tokens", None)
        data["max_tokens"] = output
        # Overwrite any client value. Log callbacks use the same per-request ID.
        data.setdefault("metadata", {})["fde_quota_reservation"] = reservation
        return data

    async def record(self, metadata, response):
        reservation = (metadata or {}).get("fde_quota_reservation")
        usage = getattr(response, "usage", None)
        if isinstance(response, dict):
            usage = response.get("usage")
        if not reservation or usage is None:
            return
        total = usage.get("total_tokens") if isinstance(usage, dict) else getattr(usage, "total_tokens", None)
        await asyncio.to_thread(self.ledger.settle, reservation, total)

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        await self.record(data.get("metadata"), response)
        return response

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        await self.record(kwargs.get("litellm_params", {}).get("metadata"),
                          kwargs.get("complete_streaming_response") or response_obj)


def install():
    from litellm.proxy.proxy_server import app
    filename = os.environ.get("FDE_QUOTA_DB", "/var/lib/fde-quota/quota.sqlite3")
    ledger = QuotaLedger(filename)
    secret = os.environ["FDE_QUOTA_ADMIN_KEY"]
    if len(secret) < 32:
        raise RuntimeError("FDE quota management secret is too short")

    def authorize(user_id, authorization):
        if not authorization or not hmac.compare_digest(authorization, "Bearer " + secret):
            raise HTTPException(401, "unauthorized")
        try:
            uuid.UUID(user_id)
        except ValueError:
            raise HTTPException(400, "invalid user id")

    @app.get("/fde-station/quota/{user_id}", include_in_schema=False)
    async def get_quota(user_id: str, authorization: str = Header(default="")):
        authorize(user_id, authorization)
        return await asyncio.to_thread(ledger.snapshot, user_id)

    @app.put("/fde-station/quota/{user_id}", include_in_schema=False)
    async def put_quota(user_id: str, body: dict, authorization: str = Header(default="")):
        authorize(user_id, authorization)
        return await asyncio.to_thread(ledger.set_limit, user_id, body.get("daily_limit"))

    return FdeQuota(ledger)


# Unit tests import only the ledger; production explicitly opts in at startup.
if os.environ.get("FDE_QUOTA_ENABLED") == "1":
    quota_handler = install()
