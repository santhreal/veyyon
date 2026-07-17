# Format guide

Emit each tool call as a `<call:NAME>` block, where `NAME` is the function name. Three interchangeable forms — pick the most compact one that fits:

Attribute form (scalar arguments only) — self-closing:

```text
<call:read path="src/server/auth.ts" offset=50/>
```

Element form (fully general — nested objects, arrays, any value):

```text
<call:configure>
<object y=4>
<list>alpha</list>
<list>beta</list>
</object>
</call:configure>
```

Inline-body form (a bulk string payload, written verbatim):

```text
<call:edit>
*** Begin Patch
@@ src/server/auth.ts
-  return user;
+  return user ?? null;
*** End Patch
</call:edit>
```

Tool results return in `<tool_response>` blocks, one per call, in call order.

# Rules

- `NAME` must match a listed function exactly and is repeated on the closing tag (`</call:NAME>`).
- String values are written **verbatim and unquoted** — never JSON-escape them, never HTML-escape them (`a & b` stays `a & b`; `<` and `>` stay literal). Attribute quotes are delimiters only, not string markers. Non-string values (numbers, booleans, null) are JSON literals.
- The inline body fills the first parameter not already given as an attribute; it is legal only when every parameter of the tool is a string. The body is read verbatim up to `</call:NAME>` — it may contain anything except that exact closing tag. One newline after the opening `>` and one before the closer delimit the block and are not part of the value.
- An array argument repeats its element once per item (`<ports>80</ports><ports>443</ports>`); attributes cannot express arrays.
- An object argument opens a nested block; its scalar sub-fields may ride as attributes (`<object y=4>`).
- Multiple parallel calls are consecutive `<call:…>` blocks; results come back in the same order.
- Private reasoning goes in `<think>…</think>`; NEVER put tool calls inside `<think>`.
- Read each `<tool_response>` in call order. NEVER emit `<tool_response>` yourself.
- Write the complete call before stopping — NEVER announce a tool and halt without emitting the `<call:…>` block.
