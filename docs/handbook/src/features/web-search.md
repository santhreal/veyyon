# Web search

Web search lets the model look things up while it works, using the provider's native `web_search`
tool. It is useful for current library versions, API details, and error messages that need a
reference the model was not trained on.

## Modes

Web search has four modes, set with the `web_search` config value:

| Mode | Behavior |
| --- | --- |
| `disabled` | No web access. |
| `cached` | The default. Uses cached results only, so no live network call is made for a search. |
| `indexed` | Uses an indexed corpus. |
| `live` | Full live web search: the model may issue real-time queries. |

## Enabling it

For a single session, override the config value at launch:

```console
$ veyyon -c web_search=live
$ veyyon -p -c web_search=live "what is the current stable Rust release?"
```

The `web_search` tool is then available to the model without a per-call approval prompt.

To set it persistently, put it in `config.yml`:

```yaml
web_search: live
```

You can also scope it to a [profile](./profiles.md), so one profile searches live and another
stays offline. A profile stores its own settings under its agent dir; set the key in that
profile's `config.yml`:

```yaml
# ~/.veyyon/profiles/research/agent/config.yml
web_search: live
```

## Provider support

Web search relies on the provider exposing the `web_search` tool. It is available on providers and
models that implement it; on providers that do not, the setting has no effect. See
[Models and providers](../using/models.md).

## Approvals

With web search enabled, the tool runs without a per-call approval prompt, because it reads public
web content rather than touching your machine. It is bounded by the selected mode: `cached` never
makes a live request, `live` does. If you want the model to never reach the network, use `disabled`.
See [Sandbox and approvals](./sandbox.md).
