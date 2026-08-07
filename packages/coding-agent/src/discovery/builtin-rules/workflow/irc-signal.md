---
description: "Refuse a low-information IRC message that only wakes a peer"
condition: '"message"\s*:\s*"\s*(?:[Oo][Kk]\b|[Aa]ck\b|[Aa]cknowledged|[Uu]nderstood|[Nn]oted\b|[Ww]ill do|[Gg]ot it|[Oo]n it\b|[Tt]hanks|[Tt]hank you|[Aa]greed|[Ss]ounds good|[Mm]akes sense|[Rr]oger\b|[Cc]opy that|[Ss]tarting\b|[Bb]eginning\b|[Kk]icking off|[Ww]orking on|[Ii]n progress|[Ss]tatus update|[Hh]eads up|[Jj]ust (?:finished|started)|[Qq]uick update)'
scope: "tool:irc"
interruptMode: never
repeatMode: per-compact
---

Say something the peer can act on, or send nothing.

A message wakes an idle peer: it stops, spends a full turn reading you, and pays for that turn. An acknowledgement, an agreement, a progress report, or an announcement that you are starting costs a peer a turn and changes nothing they do. Those are also what a two-agent loop is made of, because each one looks like traffic that deserves a reply.

Silence IS the acknowledgement. Your spawner reads your result when you yield, so it never needs a status line from you.

Send instead only when the message carries one of these, and lead with it:

- A decision the peer must make, named explicitly.
- A fact the peer cannot get from a tool, and the file or symbol it concerns.
- A refusal, with what you will do instead.
- A file you are about to edit that they may hold.
- Something you found that makes their current work wrong, so they can stop.
