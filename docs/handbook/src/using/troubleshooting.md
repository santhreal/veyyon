# Troubleshooting

Most Veyyon failures should tell you what failed and what to change. This page gives the public reading
path for the common cases.

## Install or startup fails

Run:

```shell
veyyon --version
veyyon plugin doctor
```

`veyyon plugin doctor` checks extension health and warns about missing optional binaries or provider
keys. Treat a non-zero result as actionable: fix the line it reports, then run the command again.

## A provider does not work

Check the provider key first. The supported environment variables are listed in
[Models and providers](./models.md). Confirm that the configured base URL and API key are correct for your chosen provider.

## A command or edit is blocked

Check [Configuration](./configuration.md). The approval policy decides when Veyyon must ask before acting,
and the sandbox policy decides what a command may read, write, or reach. Veyyon should fail closed when a
safety decision is unclear.

## Output looks truncated

Truncation is intentional when output exceeds a tool budget. The output should include the next action, such
as increasing a limit, using an offset, or narrowing a search. See [Lower token cost and faster turns](../benefits/lower-cost.md)
and [Bounded reads and instant search](../context/reads-search.md).

## Where to go next

- [Safety you can see](../benefits/safety-honesty.md) explains the fail-loud design.
- [Observability](../observability/overview.md) explains runtime signals and exporter configuration.
