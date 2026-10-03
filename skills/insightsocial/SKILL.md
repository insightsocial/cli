---
name: insightsocial
description: |
  Use this skill whenever the user wants live public data from Instagram, TikTok, LinkedIn, Facebook, YouTube, X/Twitter, Reddit, Threads or Pinterest: profiles, follower counts, public emails, posts, reels, videos, comments, followers, likers, hashtags, search results, company pages, jobs, ads, transcripts. Also when they mention InsightSocial, the insightsocial CLI, an isk_live_ key, or ask to find influencers, creators, leads or competitor content on a social platform.
allowed-tools: [Bash(insightsocial *), Bash(npx insightsocial *), Bash(npx -y insightsocial *)]
---

# InsightSocial API

239 endpoints across 9 social platforms behind one key, priced per endpoint in
credits. If the `insightsocial` command is missing, use `npx -y insightsocial`.

## 1. Find the endpoint (free)

```sh
insightsocial search instagram followers
insightsocial search comments --platform tiktok
insightsocial describe /v1/instagram/profile     # inputs, example, price
```

Paths look like `/v1/<platform>/<resource>`; `ig/profile` and `x/user/tweets`
are accepted too. Search lines show the price in credits, the required inputs
and whether the endpoint pages. A range like `20–340 cr` means metered: you pay
what the call actually cost, never more than the top of the range.

## 2. Run it (costs credits)

```sh
insightsocial run /v1/instagram/profile -p handle=natgeo
insightsocial run /v1/tiktok/post/comments -p url=https://www.tiktok.com/@nasa/video/7665075736742530317
```

`run` saves the FULL response to `./.insightsocial/<endpoint>-<time>.json` and
prints the file, the item count, credits used and left, and a ready-made `next`
command when there are more pages. Work from the file instead of pasting large
JSON into the conversation. Inputs are checked before anything is charged.

Guard spend on metered endpoints: `--max-credits 100` refuses to run one that
could cost more.

## 3. Read the result again for free

Shaping is local. Never re-run an endpoint just to see a different part of a
result you already have.

```sh
insightsocial view --last --summary                       # structure + byte sizes
insightsocial view --last --fields post.url,post.engagement.likes --max-items 5
insightsocial view --last --jq '.data.items[] | {url: .post.url, likes: .post.engagement.likes}'
insightsocial view --last instagram/profile               # newest result for one endpoint
```

`--jq` runs real jq over the saved response, so paths start at `.data`.
List endpoints share one shape across platforms: rows are in `.data.items`, each
row has `post` (id, url, content, author, engagement, published_at, ext) and
`computed` (engagement_rate, language, labels, …). Profiles are under
`.data.author`. Check `--summary` before guessing field names.

## Paging

Each page is a separate, charged call. Use the `next` line `run` prints: it
passes the response's `next_cursor` back as `cursor`. Stop as soon as you have
enough rows.

## Retrying safely

`--idempotency-key <key>`: repeating a call with the same key returns the
original response and charges 0. Use it when a run might be repeated.

## What is free

`search`, `list`, `describe`, `view`, `credits`, empty results, failed calls and
idempotent replays.

## Errors

- `401` / no key: run `insightsocial login` (keys at https://www.insightsocial.app/portal/api/keys).
- `402`: not enough credits; top up at https://www.insightsocial.app/portal/billing. Nothing was charged.
- `INVALID_REQUEST`: `insightsocial describe <path>` lists every input.
- `429`: wait for the seconds given, then retry with the same idempotency key.

Quote the `request` id from the output when reporting a problem to
support@insightsocial.app.

## MCP instead of the CLI

The same tools are available over MCP (`insightsocial mcp`): `search_endpoints`,
`describe_endpoint`, `call_endpoint`, `read_result`, `get_credits`. If they are
connected, prefer them; the rules above are the same.
