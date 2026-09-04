# @veyyon/plugin

The vocabulary a package writes its plugin manifest in.

A plugin is a package whose `package.json` holds a `veyyon` field. That field states the entry
points the plugin contributes, the optional features an installer may select, and the settings the
plugin reads. The loader that installs a plugin and the host that draws its settings both consume
that declaration; neither is named here. The package has no dependencies.

## Exports

```ts
import type {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  PluginFeature,
  PluginManifest,
  PluginSettingSchema,
  PluginSettingType,
  StringSetting,
} from "@veyyon/plugin";
```

## Model

- `PluginManifest` — the `veyyon` field: a display name, the version, a description, the `tools`
  and `hooks` entry points, the `extensions` and `commands` entry lists, the `features` an installer
  selects and the `settings` the plugin reads.
- `PluginFeature` — one optional feature: a description, whether it is on by default, and the
  extension, tool, hook and command entries it adds when selected.
- `PluginSettingSchema` — one declared setting: a `string`, `number`, `boolean` or `enum`
  definition with its default, an optional `env` fallback and a `secret` mark that masks the value.
- `PluginSettingType` — the `type` tag a plugin setting carries.

## Declaring a plugin

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "veyyon": {
    "extensions": ["./extension.ts"],
    "tools": "./tools.ts",
    "features": {
      "search": { "default": false, "tools": ["./search-tools.ts"] }
    },
    "settings": {
      "apiKey": { "type": "string", "secret": true, "env": "MY_PLUGIN_API_KEY" }
    }
  }
}
```

Every path is relative to the package root. A feature's entries load only when the feature is
selected at install time or on by default.

## What stays behind

`PluginSettingSchema` is the shape a plugin manifest carries on disk and is distinct from the
`SettingDef` vocabulary in `@veyyon/settings`, which a first-party package writes in code. The two
are separate declarations with separate consumers; folding one into the other changes the manifest
format and is a later step.
