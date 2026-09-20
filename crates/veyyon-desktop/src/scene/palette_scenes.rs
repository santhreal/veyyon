//! Builders for palette scenes across search and navigation modes (§5.8).

use veyyon_desktop_model::QueuePartition;
use veyyon_desktop_surface::{Intent, Overlay, PaletteMode, PaletteState, palette::PaletteItem};

use crate::scene::seed::{Built, Seed};

/// Command palette with active search query filtering commands.
pub fn palette_searching() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut palette = PaletteState::commands();
	palette.set_query("theme".to_string());
	seed.state.overlay = Some(Overlay::Palette(palette));
	seed.finish()
}

/// Command palette showing search results grouped by domain.
pub fn palette_results() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut palette = PaletteState::commands();
	palette.set_query("nav".to_string());
	seed.state.overlay = Some(Overlay::Palette(palette));
	seed.finish()
}

/// Command palette showing empty state when no items match.
pub fn palette_no_results() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut palette = PaletteState::commands();
	palette.set_query("xyznomatch".to_string());
	seed.state.overlay = Some(Overlay::Palette(palette));
	seed.finish()
}

/// Sessions palette listing active, pinned, and recent sessions.
pub fn palette_mode_sessions() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut palette = PaletteState::new(PaletteMode::Sessions);
	palette.set_items(vec![
		PaletteItem::session(1, "Fix authentication refresh cookies", "2m ago", None, None),
		PaletteItem::session(2, "Refactor desktop layout bridge", "15m ago", None, None),
		PaletteItem::session(3, "Update token ramp scale definitions", "1h ago", None, None),
	]);
	seed.state.overlay = Some(Overlay::Palette(palette));
	seed.finish()
}

/// Files palette searching files across workspace tree.
pub fn palette_mode_files() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut palette = PaletteState::new(PaletteMode::Files);
	palette.set_query("composer".to_string());
	palette.set_items(vec![
		PaletteItem::file(1, "crates/veyyon-desktop-surface/src/composer/mod.rs"),
		PaletteItem::file(2, "crates/veyyon-desktop-surface/src/composer/footer.rs"),
		PaletteItem::file(3, "crates/veyyon-desktop-tokens/tokens/surface/composer.toml"),
	]);
	seed.state.overlay = Some(Overlay::Palette(palette));
	seed.finish()
}

/// Browse project directories mode.
pub fn palette_mode_browse() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut palette = PaletteState::new(PaletteMode::Browse);
	palette.set_items(vec![
		PaletteItem::directory(1, "crates/"),
		PaletteItem::directory(2, "packages/"),
		PaletteItem::directory(3, "docs/"),
	]);
	seed.state.overlay = Some(Overlay::Palette(palette));
	seed.finish()
}

/// Models mode showing full unanchored catalogue.
pub fn palette_mode_models() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	let mut palette = PaletteState::new(PaletteMode::Models);
	palette.set_items(vec![
		PaletteItem::command(
			1,
			"Claude Sonnet 4.5",
			Intent::SelectModel {
				choice:  veyyon_desktop_surface::composer::ModelChoice::new(
					"anthropic".to_string(),
					"claude-sonnet-4.5".to_string(),
				),
				persist: true,
			},
			None,
		),
		PaletteItem::command(
			2,
			"GPT-5",
			Intent::SelectModel {
				choice:  veyyon_desktop_surface::composer::ModelChoice::new(
					"openai".to_string(),
					"gpt-5".to_string(),
				),
				persist: true,
			},
			None,
		),
		PaletteItem::command(
			3,
			"Gemini 2.5 Pro",
			Intent::SelectModel {
				choice:  veyyon_desktop_surface::composer::ModelChoice::new(
					"google".to_string(),
					"gemini-2.5-pro".to_string(),
				),
				persist: true,
			},
			None,
		),
	]);
	seed.state.overlay = Some(Overlay::Palette(palette));
	seed.finish()
}
