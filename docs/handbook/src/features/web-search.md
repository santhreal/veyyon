# Web search

Web search lets the model look things up while it works, using Veyyon's own `web_search`
tool. It is useful for current library versions, API details, and error messages that need a
reference the model was not trained on.

## Configuration

Two settings control the tool:

| Setting | Behavior |
| --- | --- |
| `web_search.enabled` | Boolean, default `true`. When `false`, the `web_search` tool is not offered to the model at all. |
| `providers.webSearch` | Which search backend to use. Default `auto` picks the best available; you can pin a specific provider or exclude providers with `providers.webSearchExclude`. |

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

The tool queries a configurable search backend — API-backed providers (using keys you have
configured) or credential-free engines (Ecosia, Google, Mojeek, or `public`, which fans out
to every credential-free engine and consolidates deduplicated results). `auto` resolves the
first available provider in the built-in priority order; `providers.webSearchExclude` removes
providers from that chain entirely.

## Approvals

With web search enabled, the tool runs without a per-call approval prompt, because it reads
public web content rather than touching your machine. If you want the model to never reach
the web, set `web_search.enabled: false`. See [Sandbox and approvals](./sandbox.md).
