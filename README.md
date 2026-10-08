# insightsocial

The official CLI and MCP server for the [InsightSocial API](https://www.insightsocial.app/docs):
live public data from **25 platforms** through one key: Instagram, TikTok, LinkedIn, Facebook,
YouTube, X, Reddit, Threads, Pinterest, Bluesky, Truth Social, Snapchat, Telegram, Twitch, Kick,
Rumble, Kwai, Douyin, Xiaohongshu (RedNote), Quora, TikTok Shop, Weibo, Zhihu, Substack and Nextdoor.

- **300+ endpoints**: profiles, public emails, posts, reels, comments, followers, likers, hashtags,
  search, company pages, jobs, ads, transcripts, shop products and local business listings.
- **One schema across platforms**: a TikTok video and an Instagram post come back with the same fields
  (`post.url`, `post.kind`, `post.engagement.likes`, `post.language`), and `unavailable` lists any
  field a response could not fill. The CLI and MCP server ask for
  [schema 2](https://www.insightsocial.app/docs/schema-2) on every call.
- **Priced per endpoint, charged per call.** Empty results, failed calls and idempotent replays are
  free.
- **Built for agents.** Every result is saved in full, and you re-slice it locally with jq for free, so
  a 50 KB page never ends up in your context.

## Quick start

```sh
npx -y insightsocial init              # sign in through your browser, install the agent skill, show MCP setup
npx -y insightsocial search instagram followers
npx -y insightsocial run /v1/instagram/profile -p handle=natgeo
npx -y insightsocial view --last --jq '.data.author | {username, followers}'
```

`init` and `login` sign you in through your browser: they open the sign-in page and print a short
code, you type the code there and click Allow, and a key named after this machine is saved. The CLI
then prints which account it signed into. To use a key you already have, pass `--api-key`. New
accounts include free calls.

## Use it from an AI agent

### Claude Code plugin

```
/plugin marketplace add insightsocial/skills
/plugin install insightsocial@insightsocial
```

This installs the skill and the MCP server together, from
[insightsocial/skills](https://github.com/insightsocial/skills). Run `npx -y insightsocial login` once so
the server can find your key.

### MCP server (any client)

```sh
claude mcp add insightsocial --scope user -- npx -y insightsocial mcp
```

```json
{
  "mcpServers": {
    "insightsocial": { "command": "npx", "args": ["-y", "insightsocial", "mcp"] }
  }
}
```

The server reads the key saved by `insightsocial login`, so the config holds no secret. You can
also pass `INSIGHTSOCIAL_API_KEY` in its `env`. Without a key, search and describe still work.

Nothing to install: the same tools are hosted at `https://api.insightsocial.app/mcp`. Claude,
ChatGPT and other clients that support it sign in with OAuth; others send the key as
`Authorization: Bearer`. See [MCP docs](https://www.insightsocial.app/docs/mcp).

| Tool | What it does |
| --- | --- |
| `search_endpoints` | Find endpoints by keywords and platform. Free. |
| `describe_endpoint` | Inputs, allowed values, an example and the price for one endpoint. Free. |
| `call_endpoint` | Fetch data. Saves the full response and returns a `result_id` with a trimmed view (10 items by default) and a ready `next_call` for the next page. |
| `read_result` | Re-slice a saved result with jq, fields, max_items or an outline with sizes. Free. |
| `get_credits` | Balance, plan and usage. Free. |

`insightsocial init --yes` writes the MCP entry into Claude Code, Codex and Cursor for you.

## Commands

| Command | |
| --- | --- |
| `init [--yes] [--no-skills]` | Save a key, install the skill for detected agents, print or write the MCP config. |
| `login [--api-key k] [--no-browser]` / `logout` | Sign in through your browser (or save a key you pass) / remove the key. |
| `search <words> [--platform p]` | Find endpoints. Free. |
| `list [--platform p]` | Every endpoint with its price. Free. |
| `describe <path>` | Inputs, example and price. Free. |
| `run <path> -p name=value …` | Call an endpoint. Saves to `./.insightsocial/`. Options: `--input <json>`, `-i file`, `--idempotency-key`, `--fresh`, `--max-credits N`, `-o file`, `--json`, and the shaping flags below. |
| `view [file] [--last [endpoint]]` | Re-shape a saved result. No network, no charge. |
| `credits` | Balance and usage. Free. |
| `mcp` | Start the MCP server over stdio. |

Shaping flags (`run` and `view`) trim only what is printed; the saved file is always complete:

- `--jq <expr>`: real jq (bundled, nothing to install) over the saved response. Paths start at `.data`.
- `--fields a,b.c`: keep these keys on each item. Dotted paths descend.
- `--max-items N`: show at most N items.
- `--summary`: the structure with byte sizes, so you can see what is large before pulling it.

Paging: when there is another page, `run` prints the exact `next` command. Each page is a
separate charged call.

Pricing a call first: `-p dry_run=1` (or `true`) on any endpoint returns the quote and charges
nothing. When a response could not fill a field the platform normally has, `run` prints it under
`missing`; that null means unknown, not zero.

## Configuration

| | |
| --- | --- |
| Key | `--api-key`, then `INSIGHTSOCIAL_API_KEY`, then `~/.insightsocial/config.json` (mode 600) |
| `INSIGHTSOCIAL_BASE_URL` | Defaults to `https://api.insightsocial.app` |
| `INSIGHTSOCIAL_HOME` | Defaults to `~/.insightsocial` (config, catalogue cache, MCP results) |

## Develop

```sh
npm install
npm run check      # build + unit tests, no network and no key needed
```

## License

MIT
