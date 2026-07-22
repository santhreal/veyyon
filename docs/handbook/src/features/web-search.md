# Web search

The `web_search` tool runs a multi-provider search and returns ranked results (and, for some
providers, answer-plus-citations). Use it for current docs, package versions, and online references.

## Configuration

Two settings control the tool:

| Setting | Behavior |
| --- | --- |
| `web_search.enabled` | Boolean, default `true`. When `false`, the `web_search` tool is not offered to the model at all. |
| `providers.webSearch` | Which search backend to use. Default `auto` walks the configured provider chain; pin a provider id or use `providers.webSearchExclude` to drop providers. |

Both are in **settings → Tools / Providers**, or in `config.yml`:

```yaml
web_search:
  enabled: true
providers:
  webSearch: auto
```

You can also scope this to a [profile](./profiles.md), so one profile searches the web and
another stays offline. A profile stores its own settings under its agent dir; set the key in
that profile's `config.yml`:

```yaml
# ~/.veyyon/profiles/research/agent/config.yml
web_search:
  enabled: false
```

## Provider support

The tool queries a configurable search backend, API-backed providers (using keys you have
configured) or credential-free engines (Ecosia, Google, Mojeek, or `public`, which fans out
to every credential-free engine and consolidates deduplicated results). `auto` resolves the
first available provider in the built-in priority order; `providers.webSearchExclude` removes
providers from that chain entirely.

## Exa research and webset tools

Beyond ranked search, Exa hosts two MCP servers that Veyyon can turn into agent tools. Both
are off by default, because each one adds tools to every session and costs a discovery
request at startup.

```yaml
exa:
  enableResearcher: true
  enableWebsets: true
```

`exa.enableResearcher` adds `exa_deep_researcher_start` and `exa_deep_researcher_check`. The
model starts a research run and then polls it, so a single question can take minutes and
returns a written report rather than a result list.

`exa.enableWebsets` adds one tool per webset operation the server offers, named
`exa_<operation>`. The list comes from the server, so new operations appear without a Veyyon
release. Websets require `EXA_API_KEY` in your environment; if it is missing, Veyyon logs the
reason at startup and registers no webset tools rather than failing later inside a tool call.

`exa.enabled: false` turns off all of it, including search.

## Approvals

With web search enabled, the tool runs without a per-call approval prompt, because it reads
public web content rather than touching your machine. If you want the model to never reach
the web, set `web_search.enabled: false`. See [Sandbox and approvals](./sandbox.md).
