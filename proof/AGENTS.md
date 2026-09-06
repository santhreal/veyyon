# Pull Request Visual Evidence Harness (`proof/`)

## Purpose
This directory owns the containerized X11 capture pipeline for generating **Before and After visual evidence pairs** required for Pull Requests.

> **Note for Product Demos:** If you are recording the product landing-page demo (`assets/demo-hd.webp`), see [`demo/AGENTS.md`](../demo/AGENTS.md). `proof/` is exclusively for PR visual proof and regression scenes.

---

## Which Artifact Proves Which Change
The artifact class MUST match the change class (a mismatch is a failed proof):

| Change Class | Required Artifact | Capture Flag |
| :--- | :--- | :--- |
| **Static UI change** | Two PNG frames (**Before** and **After**) | `proof/record.sh --still <mark> <scene>` |
| **Animation / timing** | Two animated clips (**Before** and **After** WebP/MP4) | `proof/record.sh --pair <scene>` |
| **Settings change** | Two PNG frames (**Off** and **On** differential) | `proof/record.sh --settings '<setting>: <val>' <scene>` |
| **Responsive degradation** | One Before/After pair for every terminal width (960px, 1200px, 1440px) | `proof/record.sh --width <px> <scene>` |

---

## Canonical Commands

### 1. Recording After & Before Pair
```sh
# Record After arm (writes to proof/captures/x11/)
proof/record.sh proof/scenes/<name>.sh

# Record Before arm (writes to proof/captures/x11/before/)
proof/record.sh --before proof/scenes/<name>.sh

# Or record both arms in one command:
proof/record.sh --pair proof/scenes/<name>.sh
```

### 2. Settings Differential (Off vs On)
```sh
# Off arm (default):
proof/record.sh proof/scenes/<name>.sh

# On arm (with setting enabled):
proof/record.sh --settings '<domain>.<key>: true' proof/scenes/<name>.sh
```

### 3. Responsive Layout / Degradation Sweeps
```sh
for px in 960 1200 1440; do
    proof/record.sh --width ${px} --before proof/scenes/<name>.sh
    proof/record.sh --width ${px} proof/scenes/<name>.sh
done
```

---

## Standardized Configuration Specification (`proof/docker/scene-config.sh`)
Every proof run uses the single, standardized configuration (sourced automatically from `proof/docker/scene-config.sh`):

| Property | Standardized Default | Rule |
| :--- | :--- | :--- |
| **Terminal** | `kitty` | Single terminal emulator across all proofs |
| **Font** | `JetBrains Mono 15` | Required font and size |
| **Geometry** | `1600x1000` | Standard default resolution (unless responsive width sweep like 960/1200/1440 is mandated) |
| **Framerate** | `30 FPS` | Standard capture rate |
| **Ground / Text** | `#1e2127` / `#d7dae0` | Standardized palette, 8px padding |
| **Chrome** | `plain` (PR proofs) / `night` (themed) | Standard window styling |

---

## What is NOT Evidence
None of the following is evidence and none satisfies PR visual requirements:
- **Off-screen ANSI PNG rasters** (`scripts/demos/render-proof.ts`)
- **tmux captures** (`capture-pane`)
- **Mock-ups, hand-built frames, or unpaired images**

Always embed proof frames inline into the PR body via GitHub upload references (`gh image proof/captures/x11/before/<scene>.png proof/captures/x11/<scene>.png`).
