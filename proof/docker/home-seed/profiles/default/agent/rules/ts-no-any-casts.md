---
description: Never silence the type checker with an any cast
condition:
  - ": any|as any"
scope:
  - "tool:edit(*.ts)"
  - "tool:write(*.ts)"
---
Never write `: any` or `as any`. Narrow with a type guard, a generic, or `unknown`.
