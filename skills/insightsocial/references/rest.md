# InsightSocial API - building it into an application

Reference for putting the InsightSocial API inside a product or an agent you build. The main skill is `SKILL.md` next to this file.

There is no SDK. The whole protocol is one `GET` request with one header, so use the HTTP client your project already has.

Build workflow:

1. Decide where the call belongs. For browser apps, keep the key on your server and expose only your own backend route to the browser.
2. Create a **dedicated key for this app** at https://www.insightsocial.app/portal/api/keys, named for where it runs (`production`, `local-dev`). Store it only in the `INSIGHTSOCIAL_API_KEY` environment variable. Never hardcode it and never commit it.
3. Read the endpoint's parameters from `GET https://api.insightsocial.app/v1/endpoints?platform=<platform>` and mirror them in your form or job.
4. Write the call site, check `success`, and branch on `error.type`.
5. Handle `INSUFFICIENT_CREDITS` (402) by surfacing a top-up link (https://www.insightsocial.app/pricing) to the human.
6. Smoke-test one cheap call (a 20-credit profile lookup) and verify the envelope, `credits_used` and `credits_remaining`.

## Python

    import os
    import requests

    BASE = "https://api.insightsocial.app/v1"
    KEY = os.environ["INSIGHTSOCIAL_API_KEY"]

    res = requests.get(
        f"{BASE}/instagram/profile",
        params={"handle": "natgeo"},
        headers={"x-api-key": KEY},
        timeout=120,
    )
    body = res.json()
    if not body["success"]:
        raise RuntimeError(f'{body["error"]["type"]}: {body["error"]["message"]}')
    print(body["data"], body["credits_used"], body["credits_remaining"])

## Node.js / TypeScript

    const BASE = "https://api.insightsocial.app/v1";

    const res = await fetch(`${BASE}/tiktok/profile?handle=khaby.lame`, {
      headers: { "x-api-key": process.env.INSIGHTSOCIAL_API_KEY! },
    });
    const body = await res.json();
    if (!body.success) throw new Error(`${body.error.type}: ${body.error.message}`);
    console.log(body.data, body.credits_used, body.credits_remaining);

## Walking every page

    cursor = None
    rows = []
    while True:
        params = {"handle": "khaby.lame"}
        if cursor:
            params["cursor"] = cursor  # send it back unchanged
        body = requests.get(f"{BASE}/tiktok/profile/videos", params=params,
                            headers={"x-api-key": KEY}, timeout=120).json()
        if not body["success"]:
            break
        rows.extend(body["data"]["items"])  # each row wraps one entity: {"post": {...}}
        page = body.get("pagination") or {}
        if not page.get("has_more"):
            break
        cursor = page["next_cursor"]  # v2c.…, valid 24 hours with these same params

## One tool for your own agent

When you build the agent yourself, one generic HTTP tool is enough: the model picks the path and parameters from the catalogue, and your tool makes the call. Keep the key in your code, not in the model's context.

    CATALOGUE = requests.get(f"{BASE}/endpoints", timeout=30).json()

    def insightsocial_get(path: str, params: dict) -> dict:
        """Tool: call one InsightSocial endpoint, e.g. path='tiktok/profile'."""
        res = requests.get(f"{BASE}/{path.removeprefix('/v1/').lstrip('/')}",
                           params=params, headers={"x-api-key": KEY}, timeout=120)
        body = res.json()
        if not body["success"]:
            # Hand the model a short instruction, not the raw error envelope.
            return {"error": body["error"]["type"], "message": body["error"]["message"],
                    "param": body["error"].get("param"),
                    "retry_after_seconds": res.headers.get("Retry-After")}
        return {"data": body["data"], "pagination": body.get("pagination"),
                "unavailable": body.get("unavailable", []),
                "credits_used": body["credits_used"],
                "credits_remaining": body["credits_remaining"]}

Describe the tool with two parameters, `path` (string, for example `tiktok/profile`) and `params` (object of query parameters). It works with Claude tool use, OpenAI function calling or any agent framework, because it is only an HTTP request.

Four habits keep an agent loop cheap and correct:

- **Return a short error, not the envelope.** Hand the model `error.type` (and `error.param`, which names the input to remove or fix) and let your code decide whether to retry.
- **Pass `unavailable` along.** It lists fields this response could not fill, so the model reads their `null` as unknown, not zero.
- **Watch the budget.** Stop the loop on a credit budget you set, and cap the number of tool steps.
- **Price before you call.** For metered endpoints the catalogue's `max` is the most any call can cost; what a call holds up front depends on its parameters (`limit`, `include`), and `dry_run=1` returns that exact quote for free.

## Retrying safely

Retry only on 429, 503, `IDEMPOTENCY_IN_PROGRESS` and `INTERNAL_ERROR`, honouring `Retry-After` and backing off with jitter. Send an `Idempotency-Key` header with any call you might retry: a replay of a call that already succeeded returns the same body and costs 0.
