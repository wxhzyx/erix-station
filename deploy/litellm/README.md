# LiteLLM gateway (issue #117)

LiteLLM is the platform's LLM gateway: the **single source of truth for the
model catalogue and upstream credentials** (`store_model_in_db: true`).

`station-litellm` is opt-in (`--profile litellm`). **The portal routes LLM
traffic through it** as of phase 2: the LLM Traefik section publishes a single
`llm-gateway` service pointing at LiteLLM, and the admin console's LLM tab is a
thin proxy over the LiteLLM admin API.

LiteLLM is published on `127.0.0.1:4100` by default (`LITELLM_HOST_PORT`, host
loopback). The admin API has no
separate published port; the proxy listener is reachable from the host only
through loopback, and in-network clients (the portal) use
`http://station-litellm:4000` via `LLM_GATEWAY_ADMIN_URL`. Admin routes share
that listener, so host-local clients can reach them with the master key; they
are not exposed on a separate port or to the LAN.

The image is pinned to the official `v1.103.2` release and its resolved
manifest digest: [`BerriAI/litellm v1.103.2`](https://github.com/BerriAI/litellm/releases/tag/v1.103.2).

## Create the database

On a **new, empty** `station-db` data directory, `deploy/db-init/01-litellm.sh`
creates the dedicated `litellm` role and database during first initialization,
using `LITELLM_DB_PASSWORD` from `deploy/.env`. Set a non-empty password before
starting the stack. The script does not run against an existing database
directory; for an existing station DB, create the role and database once:

```sql
CREATE ROLE litellm LOGIN PASSWORD '<LITELLM_DB_PASSWORD>';
CREATE DATABASE litellm OWNER litellm;
```

For an existing development stack, open a `psql` session with:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec station-db psql -U station -d postgres
```

The compose service connects as that dedicated role to
`postgresql://litellm:...@station-db:5432/litellm`; it does not use the portal
database or the Postgres superuser.

Set `LITELLM_MASTER_KEY` (must start with `sk-`), `LITELLM_SALT_KEY`, and
`LITELLM_DB_PASSWORD` in `deploy/.env`, then restrict the file to mode `600`.
Do not commit the file or any of these values.

## Start and seed a model

```sh
docker compose --env-file deploy/.env --profile litellm \
  -f deploy/docker-compose.yml up -d station-litellm
curl -fsS http://127.0.0.1:4100/health/readiness
```

The config deliberately has no `model_list`; register models through the
LiteLLM admin API so the database remains the source of truth. For a local
no-upstream smoke model:

```sh
export LITELLM_MASTER_KEY='<the LITELLM_MASTER_KEY from deploy/.env>'
curl -fsS http://127.0.0.1:4100/model/new \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"model_name":"mock-model","litellm_params":{"model":"openai/gpt-4o","mock_response":"hello from mock"}}'
```

When registering a named provider credential, LiteLLM `v1.103.2` requires both
`credential_values` and `credential_info` (an empty object is accepted). Its
`GET /credentials` and `GET /credentials/by_name/<name>` responses mask an API
key (for example `sk****ke`) but return `api_base` unmasked.

**Do not change `LITELLM_SALT_KEY` after creating models or credentials.**
LiteLLM uses it to encrypt stored credential values; changing it can make
existing encrypted values unusable.

## FDE Qwen output policy (0.1.54)

`fde_quota.py` applies a bounded output policy only after validating the personal
FDE key, and only for `fde-station-qwen3.8-flash-next`. The mode comes from the
gateway key's trusted metadata, never request metadata. Other teams, aliases,
credentials and daily limits retain their existing behavior.

* Chat: `chat_template_kwargs.enable_thinking=false`, with the Qwen3.8 instruct
  defaults `temperature=0.7`, `top_p=0.8`, `presence_penalty=1.5`.
* Work (including legacy keys without mode): reasoning stays available, but
  `thinking_token_budget=min(1024, max_tokens // 4)`. Very small requests below
  128 output tokens use direct output. Explicit non-thinking and the router's
  image defaults are retained.
* `max_tokens` and quota reservation/settlement are unchanged. Request-level
  duplicate extensions in `extra_body` cannot override the controlled parameters.

Root-cause reproduction on the deployed Qwen3.8/vLLM 0.30.0: a request for 20
numbered recommendations, sent directly to vLLM, consumed all 4096 completion
tokens as reasoning (`finish_reason=length`, zero content). This bypassed LiteLLM
and the portal. Raising the total limit alone did not reliably fix it. vLLM's
separate reasoning budget produced content through the existing router; the
instruct profile returned all 20 items with 383 completion tokens in 3.7 seconds
through the personal LiteLLM key. These are observed samples, not latency guarantees.

References: [Qwen3.8 model card](https://huggingface.co/Qwen/Qwen3.8-Flash-Next#instruct-or-non-thinking-mode),
[vLLM thinking budget](https://docs.vllm.ai/en/stable/features/reasoning_outputs/#thinking-budget-control).
Do not substitute `include_reasoning=false`: that hides reasoning without limiting
its generation, so it does not solve output-budget exhaustion.

Deployment targets the existing persistent callback mount, not the model weights
or shared router. Compare the live callback with the expected baseline, back up
the callback and SQLite ledger, run the tests below in an isolated directory with
the installed LiteLLM image, replace the mounted file in place, then gracefully
restart the gateway. Check readiness, unchanged daily limits/history, and real
chat/work responses. Restore the previous callback and restart if readiness or
behavior fails. Do not reset the ledger, model IDs or personal keys.

```sh
FDE_QUOTA_ENABLED=0 LITELLM_LOCAL_MODEL_COST_MAP=True \
  python -m unittest -v test_fde_quota test_qwen_policy
```

Post-deployment acceptance also covered a 6920-character input, a follow-up in
the same conversation, and a work run performing a read-only calculation tool.
Both modes emitted content before completion and retained per-user accounting.
