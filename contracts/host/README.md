# @veyyon/host

What a host offers a plugin.

A host is the program a plugin runs inside: a terminal, a graphical window, a browser guest, a
headless print or RPC run. Each capability here is optional and reported: a host that cannot deliver
one installs nothing for it, and a plugin reads `undefined` and takes the other branch, rather than
calling a no-op that reports success. The package imports nothing.

## Exports

```ts
import type { HostNotification, HostNotifier } from "@veyyon/host";
```

## Model

- `HostNotification` — an out-of-band message for the operator: `title`, `body`, a free-form `type`
  the host may route on, `urgency`, and the `actions` activating it should take. Every field is a
  statement about the message, never about a terminal; a terminal's own payload extends this one.
- `HostNotifier` — the host's delivery function, installed by whichever host is running.

## The pattern the rest follow

A capability is a value the host installs, typed here, absent when the host cannot honour it. A
tool session carries `notify?: HostNotifier`; the terminal installs one that emits OSC 99, a
graphical host raises its own toast, and a headless run installs none. A capability a host declares
and no-ops is a defect: the caller cannot tell delivery from silence.
