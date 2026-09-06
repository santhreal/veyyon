import type { ThemeJson } from "../color";

/**
 * The bundled themes, embedded as TEXT and parsed on demand.
 *
 * A launch resolves one theme, and `with { type: "json" }` on all 98 of them built every
 * object before the first frame: 3.5ms of module evaluation for data a run reads one entry of.
 * The same files imported as text cost 1.0ms to embed and 0.08ms to parse the one theme that is
 * used, so the launch pays for what it reads and the picker pays for the rest when it opens.
 *
 * Parsed themes are memoized, so a name resolves to one object for the life of the process: a
 * caller that held the record across two lookups still sees the same instance it did when these
 * were JSON modules.
 */
import alabaster from "./alabaster.json" with { type: "text" };
import amethyst from "./amethyst.json" with { type: "text" };
import anthracite from "./anthracite.json" with { type: "text" };
import basalt from "./basalt.json" with { type: "text" };
import birch from "./birch.json" with { type: "text" };
import dark_abyss from "./dark-abyss.json" with { type: "text" };
import dark_arctic from "./dark-arctic.json" with { type: "text" };
import dark_aurora from "./dark-aurora.json" with { type: "text" };
import dark_catppuccin from "./dark-catppuccin.json" with { type: "text" };
import dark_cavern from "./dark-cavern.json" with { type: "text" };
import dark_copper from "./dark-copper.json" with { type: "text" };
import dark_cosmos from "./dark-cosmos.json" with { type: "text" };
import dark_cyberpunk from "./dark-cyberpunk.json" with { type: "text" };
import dark_dracula from "./dark-dracula.json" with { type: "text" };
import dark_eclipse from "./dark-eclipse.json" with { type: "text" };
import dark_ember from "./dark-ember.json" with { type: "text" };
import dark_equinox from "./dark-equinox.json" with { type: "text" };
import dark_forest from "./dark-forest.json" with { type: "text" };
import dark_github from "./dark-github.json" with { type: "text" };
import dark_gruvbox from "./dark-gruvbox.json" with { type: "text" };
import dark_lavender from "./dark-lavender.json" with { type: "text" };
import dark_lunar from "./dark-lunar.json" with { type: "text" };
import dark_midnight from "./dark-midnight.json" with { type: "text" };
import dark_monochrome from "./dark-monochrome.json" with { type: "text" };
import dark_monokai from "./dark-monokai.json" with { type: "text" };
import dark_nebula from "./dark-nebula.json" with { type: "text" };
import dark_nord from "./dark-nord.json" with { type: "text" };
import dark_ocean from "./dark-ocean.json" with { type: "text" };
import dark_one from "./dark-one.json" with { type: "text" };
import dark_poimandres from "./dark-poimandres.json" with { type: "text" };
import dark_rainforest from "./dark-rainforest.json" with { type: "text" };
import dark_reef from "./dark-reef.json" with { type: "text" };
import dark_retro from "./dark-retro.json" with { type: "text" };
import dark_rose_pine from "./dark-rose-pine.json" with { type: "text" };
import dark_sakura from "./dark-sakura.json" with { type: "text" };
import dark_slate from "./dark-slate.json" with { type: "text" };
import dark_solarized from "./dark-solarized.json" with { type: "text" };
import dark_solstice from "./dark-solstice.json" with { type: "text" };
import dark_starfall from "./dark-starfall.json" with { type: "text" };
import dark_sunset from "./dark-sunset.json" with { type: "text" };
import dark_swamp from "./dark-swamp.json" with { type: "text" };
import dark_synthwave from "./dark-synthwave.json" with { type: "text" };
import dark_taiga from "./dark-taiga.json" with { type: "text" };
import dark_terminal from "./dark-terminal.json" with { type: "text" };
import dark_tokyo_night from "./dark-tokyo-night.json" with { type: "text" };
import dark_tundra from "./dark-tundra.json" with { type: "text" };
import dark_twilight from "./dark-twilight.json" with { type: "text" };
import dark_volcanic from "./dark-volcanic.json" with { type: "text" };
import graphite from "./graphite.json" with { type: "text" };
import light_arctic from "./light-arctic.json" with { type: "text" };
import light_aurora_day from "./light-aurora-day.json" with { type: "text" };
import light_canyon from "./light-canyon.json" with { type: "text" };
import light_catppuccin from "./light-catppuccin.json" with { type: "text" };
import light_cirrus from "./light-cirrus.json" with { type: "text" };
import light_coral from "./light-coral.json" with { type: "text" };
import light_cyberpunk from "./light-cyberpunk.json" with { type: "text" };
import light_dawn from "./light-dawn.json" with { type: "text" };
import light_dunes from "./light-dunes.json" with { type: "text" };
import light_eucalyptus from "./light-eucalyptus.json" with { type: "text" };
import light_forest from "./light-forest.json" with { type: "text" };
import light_frost from "./light-frost.json" with { type: "text" };
import light_github from "./light-github.json" with { type: "text" };
import light_glacier from "./light-glacier.json" with { type: "text" };
import light_gruvbox from "./light-gruvbox.json" with { type: "text" };
import light_haze from "./light-haze.json" with { type: "text" };
import light_honeycomb from "./light-honeycomb.json" with { type: "text" };
import light_lagoon from "./light-lagoon.json" with { type: "text" };
import light_lavender from "./light-lavender.json" with { type: "text" };
import light_meadow from "./light-meadow.json" with { type: "text" };
import light_mint from "./light-mint.json" with { type: "text" };
import light_monochrome from "./light-monochrome.json" with { type: "text" };
import light_ocean from "./light-ocean.json" with { type: "text" };
import light_one from "./light-one.json" with { type: "text" };
import light_opal from "./light-opal.json" with { type: "text" };
import light_orchard from "./light-orchard.json" with { type: "text" };
import light_paper from "./light-paper.json" with { type: "text" };
import light_poimandres from "./light-poimandres.json" with { type: "text" };
import light_prism from "./light-prism.json" with { type: "text" };
import light_retro from "./light-retro.json" with { type: "text" };
import light_sand from "./light-sand.json" with { type: "text" };
import light_savanna from "./light-savanna.json" with { type: "text" };
import light_solarized from "./light-solarized.json" with { type: "text" };
import light_soleil from "./light-soleil.json" with { type: "text" };
import light_sunset from "./light-sunset.json" with { type: "text" };
import light_synthwave from "./light-synthwave.json" with { type: "text" };
import light_tokyo_night from "./light-tokyo-night.json" with { type: "text" };
import light_wetland from "./light-wetland.json" with { type: "text" };
import light_zenith from "./light-zenith.json" with { type: "text" };
import limestone from "./limestone.json" with { type: "text" };
import mahogany from "./mahogany.json" with { type: "text" };
import marble from "./marble.json" with { type: "text" };
import obsidian from "./obsidian.json" with { type: "text" };
import onyx from "./onyx.json" with { type: "text" };
import pearl from "./pearl.json" with { type: "text" };
import porcelain from "./porcelain.json" with { type: "text" };
import quartz from "./quartz.json" with { type: "text" };
import sandstone from "./sandstone.json" with { type: "text" };
import titanium from "./titanium.json" with { type: "text" };

// `resolveJsonModule` types a `.json` specifier as its parsed object, and the import attribute is
// not part of that type. The attribute is what decides the runtime value, which is the file's text,
// so the map is cast once here rather than each entry being cast at its use.
const THEME_TEXT = {
	alabaster: alabaster,
	amethyst: amethyst,
	anthracite: anthracite,
	basalt: basalt,
	birch: birch,
	"dark-abyss": dark_abyss,
	"dark-arctic": dark_arctic,
	"dark-aurora": dark_aurora,
	"dark-catppuccin": dark_catppuccin,
	"dark-cavern": dark_cavern,
	"dark-copper": dark_copper,
	"dark-cosmos": dark_cosmos,
	"dark-cyberpunk": dark_cyberpunk,
	"dark-dracula": dark_dracula,
	"dark-eclipse": dark_eclipse,
	"dark-ember": dark_ember,
	"dark-equinox": dark_equinox,
	"dark-forest": dark_forest,
	"dark-github": dark_github,
	"dark-gruvbox": dark_gruvbox,
	"dark-lavender": dark_lavender,
	"dark-lunar": dark_lunar,
	"dark-midnight": dark_midnight,
	"dark-monochrome": dark_monochrome,
	"dark-monokai": dark_monokai,
	"dark-nebula": dark_nebula,
	"dark-nord": dark_nord,
	"dark-ocean": dark_ocean,
	"dark-one": dark_one,
	"dark-poimandres": dark_poimandres,
	"dark-rainforest": dark_rainforest,
	"dark-reef": dark_reef,
	"dark-retro": dark_retro,
	"dark-rose-pine": dark_rose_pine,
	"dark-sakura": dark_sakura,
	"dark-slate": dark_slate,
	"dark-solarized": dark_solarized,
	"dark-solstice": dark_solstice,
	"dark-starfall": dark_starfall,
	"dark-sunset": dark_sunset,
	"dark-swamp": dark_swamp,
	"dark-synthwave": dark_synthwave,
	"dark-taiga": dark_taiga,
	"dark-terminal": dark_terminal,
	"dark-tokyo-night": dark_tokyo_night,
	"dark-tundra": dark_tundra,
	"dark-twilight": dark_twilight,
	"dark-volcanic": dark_volcanic,
	graphite: graphite,
	"light-arctic": light_arctic,
	"light-aurora-day": light_aurora_day,
	"light-canyon": light_canyon,
	"light-catppuccin": light_catppuccin,
	"light-cirrus": light_cirrus,
	"light-coral": light_coral,
	"light-cyberpunk": light_cyberpunk,
	"light-dawn": light_dawn,
	"light-dunes": light_dunes,
	"light-eucalyptus": light_eucalyptus,
	"light-forest": light_forest,
	"light-frost": light_frost,
	"light-github": light_github,
	"light-glacier": light_glacier,
	"light-gruvbox": light_gruvbox,
	"light-haze": light_haze,
	"light-honeycomb": light_honeycomb,
	"light-lagoon": light_lagoon,
	"light-lavender": light_lavender,
	"light-meadow": light_meadow,
	"light-mint": light_mint,
	"light-monochrome": light_monochrome,
	"light-ocean": light_ocean,
	"light-one": light_one,
	"light-opal": light_opal,
	"light-orchard": light_orchard,
	"light-paper": light_paper,
	"light-poimandres": light_poimandres,
	"light-prism": light_prism,
	"light-retro": light_retro,
	"light-sand": light_sand,
	"light-savanna": light_savanna,
	"light-solarized": light_solarized,
	"light-soleil": light_soleil,
	"light-sunset": light_sunset,
	"light-synthwave": light_synthwave,
	"light-tokyo-night": light_tokyo_night,
	"light-wetland": light_wetland,
	"light-zenith": light_zenith,
	limestone: limestone,
	mahogany: mahogany,
	marble: marble,
	obsidian: obsidian,
	onyx: onyx,
	pearl: pearl,
	porcelain: porcelain,
	quartz: quartz,
	sandstone: sandstone,
	titanium: titanium,
} as unknown as Readonly<Record<string, string>>;

/** Every bundled theme name, sorted. Reading this parses nothing. */
export const DEFAULT_THEME_NAMES: readonly string[] = Object.freeze(Object.keys(THEME_TEXT));

const parsed = new Map<string, ThemeJson>();

/** One bundled theme by name, parsed on first ask and shared after it. */
export function getDefaultTheme(name: string): ThemeJson | undefined {
	const memo = parsed.get(name);
	if (memo !== undefined) return memo;
	const text = THEME_TEXT[name];
	if (text === undefined) return undefined;
	const theme = JSON.parse(text) as ThemeJson;
	parsed.set(name, theme);
	return theme;
}

/** Every bundled theme, parsed. For a caller that enumerates them all, such as the theme picker. */
export function getDefaultThemes(): Record<string, ThemeJson> {
	const all: Record<string, ThemeJson> = {};
	for (const name of DEFAULT_THEME_NAMES) all[name] = getDefaultTheme(name) as ThemeJson;
	return all;
}
