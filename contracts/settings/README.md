# @veyyon/settings

The vocabulary a Veyyon package writes its settings schema in.

A setting is declared once, by the package that owns the behaviour it controls: its type, its
default, and where a host places it. The store that reads a config file and the panel that draws a
row both consume that declaration; neither is named here. The package has no dependencies.

## Exports

```ts
import { isSettingType, SETTING_TYPES } from "@veyyon/settings";
import type {
  AnyUiMetadata,
  SettingDef,
  SettingTab,
  SettingType,
  SubmenuOption,
} from "@veyyon/settings";
```

## Model

- `SettingDef` — one declared setting: a `boolean`, `string`, `modelChain`, `number`, `enum`,
  `array` or `record` definition, each with its default and an optional `ui` block. A `record`
  definition may carry `validateEntry` for a map whose entries have a shape the bare type cannot
  express, and any definition may name the key that `retiredBy` replaced it.
- `SettingType` — the `type` tag a definition carries; `SETTING_TYPES` lists every tag and
  `isSettingType` recognises one.
- `SettingTab` — the tab a host places the setting under. Which tabs exist is part of the contract;
  their order, labels and icons are the host's.
- `AnyUiMetadata` — the `ui` block read generically: tab, group, label, description, keywords,
  `advanced`, `hidden`, `scope`, the name of a `condition` predicate the host registers, and for a
  number or string the `options` or bounds its control uses.
- `SubmenuOption` — one choice in a submenu: a value, a label, an optional description.

## Declaring a setting

```ts
const MY_SETTINGS = {
  "feature.enabled": {
    type: "boolean",
    default: false,
    ui: { tab: "experimental", label: "Feature", description: "Turns the feature on." },
  },
  "feature.depth": {
    type: "number",
    default: 3,
    ui: {
      tab: "experimental",
      label: "Depth",
      description: "How far the feature looks.",
      condition: "featureEnabled",
      min: 1,
      max: 10,
    },
  },
} as const;
```

`condition` is a name, not a function: a host registers the predicate under that name and hides the
row while it returns false. A declaration therefore never holds the store it would need to answer.
