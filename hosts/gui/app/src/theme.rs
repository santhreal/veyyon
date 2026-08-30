//! Colour, and the only place a colour is written down.
//!
//! One palette per appearance, resolved once and held as a global. Nothing else
//! in the app writes a colour literal: a module that needs one names a field
//! here, so a change to how the window reads is a change to this file.
//!
//! The window is a desktop app rather than a terminal, so the grounds are a
//! stack with real separation between them and the strokes are hairlines at low
//! alpha over that stack. Terminal theme files describe sixteen ANSI colours
//! and say nothing about a sidebar, a titlebar or a hover wash, so they are not
//! the source here; they will supply the transcript's syntax colours, which is
//! the one thing they do describe.

use std::sync::OnceLock;

use gpui::{App, Global, Hsla};

use crate::state::model::Appearance;

/// Every colour the window draws with.
#[derive(Debug, Clone, Copy)]
pub struct Theme {
	pub appearance: Appearance,

	/// Behind everything. The titlebar and the window's own ground.
	pub window:  Hsla,
	/// The sidebar and the terminal panel.
	pub panel:   Hsla,
	/// The conversation's ground, which is where the eye rests.
	pub canvas:  Hsla,
	/// A card lifted off the canvas: a message, a tool call, a settings row.
	pub raised:  Hsla,
	/// A well set into a card: code, terminal output, an input.
	pub sunken:  Hsla,
	/// A sheet floating over the window: the palette, a dialog.
	pub overlay: Hsla,

	/// A hairline between regions.
	pub stroke:        Hsla,
	/// A stroke that has to be seen: a focused input, a sheet's edge.
	pub stroke_strong: Hsla,
	/// The ring around a focused control.
	pub ring:          Hsla,

	pub text:           Hsla,
	pub text_muted:     Hsla,
	pub text_faint:     Hsla,
	/// Text on top of an accent fill.
	pub text_on_accent: Hsla,

	pub accent:  Hsla,
	pub success: Hsla,
	pub warning: Hsla,
	pub danger:  Hsla,

	/// Diff line grounds.
	pub added:   Hsla,
	pub removed: Hsla,

	pub font_ui:   &'static str,
	pub font_mono: &'static str,
}

impl Global for Theme {}

impl Theme {
	/// The palette for an appearance.
	pub fn of(appearance: Appearance) -> Theme {
		let mut theme = match appearance {
			Appearance::Dark => DARK,
			Appearance::Light => LIGHT,
		};
		let (ui, mono) = families();
		theme.font_ui = ui;
		theme.font_mono = mono;
		theme
	}

	/// The theme the app is currently drawing with.
	pub fn get(cx: &App) -> Theme {
		cx.try_global::<Theme>()
			.copied()
			.unwrap_or_else(|| Theme::of(Appearance::Dark))
	}

	pub fn set(appearance: Appearance, cx: &mut App) {
		cx.set_global(Theme::of(appearance));
	}

	/// The ground a row takes under the pointer.
	pub fn hover(self) -> Hsla {
		self.text.opacity(0.06)
	}

	/// The ground a selected row takes.
	pub fn selected(self) -> Hsla {
		match self.appearance {
			Appearance::Dark => self.text.opacity(0.10),
			Appearance::Light => self.accent.opacity(0.12),
		}
	}

	/// A role colour as a chip fill.
	pub fn wash(self, color: Hsla) -> Hsla {
		color.opacity(0.14)
	}

	/// A role colour as a chip edge.
	pub fn edge(self, color: Hsla) -> Hsla {
		color.opacity(0.32)
	}

	/// The window's background mode. Translucent where the platform blurs
	/// behind a window, opaque where blur is compositor roulette.
	pub fn window_background(self) -> gpui::WindowBackgroundAppearance {
		if cfg!(target_os = "macos") {
			gpui::WindowBackgroundAppearance::Blurred
		} else {
			gpui::WindowBackgroundAppearance::Opaque
		}
	}

	/// The colour of a session's activity word.
	pub fn activity(self, activity: crate::state::model::Activity) -> Hsla {
		use crate::state::model::Activity;
		match activity {
			Activity::Waiting => self.warning,
			Activity::Failed => self.danger,
			Activity::Working => self.accent,
			Activity::Done => self.success,
			Activity::Idle => self.text_faint,
		}
	}
}

// The palettes are written as hue, saturation and luminance rather than as
// hex, because the two of them are one stack read twice: a ground is a
// luminance step at a fixed hue, and a step is only checkable against its
// neighbour when the numbers say what they are.

/// The dark palette. Near-black grounds with a cool tint, so a card lifting off
/// the canvas reads as depth rather than as a grey patch.
static DARK: Theme = Theme {
	appearance:     Appearance::Dark,
	window:         Hsla { h: 0.63, s: 0.06, l: 0.075, a: 1.0 },
	panel:          Hsla { h: 0.63, s: 0.06, l: 0.105, a: 1.0 },
	canvas:         Hsla { h: 0.63, s: 0.06, l: 0.085, a: 1.0 },
	raised:         Hsla { h: 0.63, s: 0.05, l: 0.135, a: 1.0 },
	sunken:         Hsla { h: 0.63, s: 0.07, l: 0.055, a: 1.0 },
	overlay:        Hsla { h: 0.63, s: 0.05, l: 0.155, a: 1.0 },
	stroke:         Hsla { h: 0.63, s: 0.10, l: 0.95, a: 0.09 },
	stroke_strong:  Hsla { h: 0.63, s: 0.10, l: 0.95, a: 0.18 },
	ring:           Hsla { h: 0.62, s: 0.85, l: 0.62, a: 0.55 },
	text:           Hsla { h: 0.63, s: 0.10, l: 0.96, a: 1.0 },
	text_muted:     Hsla { h: 0.63, s: 0.08, l: 0.68, a: 1.0 },
	text_faint:     Hsla { h: 0.63, s: 0.06, l: 0.48, a: 1.0 },
	text_on_accent: Hsla { h: 0.0, s: 0.0, l: 1.0, a: 1.0 },
	accent:         Hsla { h: 0.62, s: 0.85, l: 0.66, a: 1.0 },
	success:        Hsla { h: 0.38, s: 0.55, l: 0.55, a: 1.0 },
	warning:        Hsla { h: 0.10, s: 0.80, l: 0.62, a: 1.0 },
	danger:         Hsla { h: 0.99, s: 0.72, l: 0.62, a: 1.0 },
	added:          Hsla { h: 0.38, s: 0.55, l: 0.55, a: 0.14 },
	removed:        Hsla { h: 0.99, s: 0.72, l: 0.62, a: 0.14 },
	font_ui:        UI_FAMILY,
	font_mono:      MONO_FAMILY,
};

/// The light palette. Warm white grounds; the stack runs the other way in
/// luminance and the same way in depth.
static LIGHT: Theme = Theme {
	appearance:     Appearance::Light,
	window:         Hsla { h: 0.63, s: 0.10, l: 0.940, a: 1.0 },
	panel:          Hsla { h: 0.63, s: 0.12, l: 0.962, a: 1.0 },
	canvas:         Hsla { h: 0.63, s: 0.10, l: 0.976, a: 1.0 },
	raised:         Hsla { h: 0.63, s: 0.14, l: 0.997, a: 1.0 },
	sunken:         Hsla { h: 0.63, s: 0.10, l: 0.918, a: 1.0 },
	overlay:        Hsla { h: 0.63, s: 0.14, l: 1.0, a: 1.0 },
	stroke:         Hsla { h: 0.63, s: 0.20, l: 0.15, a: 0.11 },
	stroke_strong:  Hsla { h: 0.63, s: 0.20, l: 0.15, a: 0.22 },
	ring:           Hsla { h: 0.62, s: 0.80, l: 0.50, a: 0.50 },
	text:           Hsla { h: 0.63, s: 0.20, l: 0.12, a: 1.0 },
	text_muted:     Hsla { h: 0.63, s: 0.10, l: 0.40, a: 1.0 },
	text_faint:     Hsla { h: 0.63, s: 0.08, l: 0.58, a: 1.0 },
	text_on_accent: Hsla { h: 0.0, s: 0.0, l: 1.0, a: 1.0 },
	accent:         Hsla { h: 0.62, s: 0.80, l: 0.50, a: 1.0 },
	success:        Hsla { h: 0.38, s: 0.60, l: 0.36, a: 1.0 },
	warning:        Hsla { h: 0.08, s: 0.75, l: 0.42, a: 1.0 },
	danger:         Hsla { h: 0.99, s: 0.70, l: 0.48, a: 1.0 },
	added:          Hsla { h: 0.38, s: 0.60, l: 0.36, a: 0.12 },
	removed:        Hsla { h: 0.99, s: 0.70, l: 0.48, a: 0.12 },
	font_ui:        UI_FAMILY,
	font_mono:      MONO_FAMILY,
};

/// The UI family, by name. A list is not accepted here, so the app resolves the
/// first family present at startup and installs it; this is the request.
pub const UI_FAMILY: &str = "Inter";
pub const MONO_FAMILY: &str = "JetBrains Mono";

/// Families tried in order for UI text, first one installed wins.
pub const UI_CANDIDATES: [&str; 6] =
	["Inter", "SF Pro Text", "Helvetica Neue", "Segoe UI Variable", "Ubuntu", "sans-serif"];

/// Families tried in order for monospace.
pub const MONO_CANDIDATES: [&str; 6] =
	["JetBrains Mono", "SF Mono", "Menlo", "Cascadia Code", "DejaVu Sans Mono", "monospace"];

/// The families the machine turned out to have, set once at startup.
///
/// gpui takes one family name per style, so the candidate lists above are
/// resolved against the installed fonts before the first frame and the answer
/// is held here. A palette read before that resolution carries the requested
/// names, which is what a test wants.
static FAMILIES: OnceLock<(String, String)> = OnceLock::new();

/// Install the resolved families. Called once, before a window exists.
pub fn set_families(ui: &str, mono: &str) {
	let _ = FAMILIES.set((ui.to_owned(), mono.to_owned()));
}

/// The families in force, or the requested ones if nothing resolved them.
fn families() -> (&'static str, &'static str) {
	FAMILIES
		.get()
		.map_or((UI_FAMILY, MONO_FAMILY), |(ui, mono)| (ui.as_str(), mono.as_str()))
}

/// The sizes the window uses, in pixels at the default font size.
pub mod size {
	pub const MICRO: f32 = 10.0;
	pub const META: f32 = 11.0;
	pub const SMALL: f32 = 12.0;
	pub const BODY: f32 = 13.0;
	pub const TITLE: f32 = 15.0;
	pub const DISPLAY: f32 = 22.0;
}

/// Spacing, in pixels. Every gap and pad in the window is one of these.
pub mod space {
	pub const HAIR: f32 = 2.0;
	pub const TIGHT: f32 = 4.0;
	pub const SNUG: f32 = 6.0;
	pub const BASE: f32 = 8.0;
	pub const WIDE: f32 = 12.0;
	pub const LOOSE: f32 = 16.0;
	pub const HUGE: f32 = 24.0;
}

/// Corner radii.
pub mod radius {
	pub const CHIP: f32 = 4.0;
	pub const ROW: f32 = 7.0;
	pub const CARD: f32 = 10.0;
	pub const SHEET: f32 = 14.0;
	pub const PILL: f32 = 22.0;
}

/// Fixed region sizes.
pub mod layout {
	/// The titlebar. Tall enough for macOS traffic lights inset at 14.
	pub const TITLEBAR: f32 = 40.0;
	/// The status strip along the bottom, reserved always so content never
	/// shifts when something appears in it.
	pub const STATUS: f32 = 26.0;
	/// The terminal panel's tab strip, which is what a closed panel collapses
	/// to. A closed panel that hid a running command would hide the one thing
	/// the panel exists to report.
	pub const TERMINAL_STRIP: f32 = 30.0;
	/// The reading column for a conversation.
	pub const READING: f32 = 720.0;
	/// The palette sheet.
	pub const SHEET: f32 = 560.0;
	/// How wide the drag handle between two regions is.
	pub const HANDLE: f32 = 5.0;
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! Two palettes, one set of fields, and the failure is silent: a field left
	//! at the other appearance's value paints one region invisible in one mode
	//! only, which nobody sees until they flip. The greys also have to run the
	//! right way, or a card sinks into the canvas it is supposed to lift off.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the colours are pleasant.

	use super::*;

	fn lum(color: Hsla) -> f32 {
		color.l
	}

	#[test]
	fn the_dark_stack_lifts_and_the_light_stack_lifts_too() {
		// Depth is the same order in both: the well is behind the canvas, and
		// each surface above it is lifted from the one below toward the fore.
		let dark = Theme::of(Appearance::Dark);
		assert!(lum(dark.sunken) < lum(dark.window));
		assert!(lum(dark.canvas) > lum(dark.window));
		assert!(lum(dark.raised) > lum(dark.canvas));
		assert!(lum(dark.overlay) > lum(dark.raised));

		let light = Theme::of(Appearance::Light);
		assert!(lum(light.sunken) < lum(light.window));
		assert!(lum(light.canvas) > lum(light.window));
		assert!(lum(light.raised) >= lum(light.canvas));
		assert!(lum(light.overlay) >= lum(light.raised));
	}

	#[test]
	fn a_card_is_separated_from_its_canvas_by_enough_to_see() {
		// 3/255 is the floor at which a boundary between two large fills is
		// visible on an ordinary panel; below it the card needs its stroke to
		// exist at all.
		const FLOOR: f32 = 3.0 / 255.0;
		for appearance in [Appearance::Dark, Appearance::Light] {
			let theme = Theme::of(appearance);
			assert!(
				(lum(theme.raised) - lum(theme.canvas)).abs() >= FLOOR,
				"{appearance:?}: a card and its canvas are the same colour"
			);
			assert!(
				(lum(theme.panel) - lum(theme.canvas)).abs() >= FLOOR,
				"{appearance:?}: the sidebar and the conversation are the same colour"
			);
		}
	}

	#[test]
	fn text_reads_against_the_ground_it_sits_on_in_both_appearances() {
		for appearance in [Appearance::Dark, Appearance::Light] {
			let theme = Theme::of(appearance);
			let gap = (lum(theme.text) - lum(theme.canvas)).abs();
			assert!(gap > 0.5, "{appearance:?}: body text has no contrast against the canvas");
			let faint = (lum(theme.text_faint) - lum(theme.canvas)).abs();
			assert!(faint > 0.15, "{appearance:?}: the faintest text is invisible");
		}
	}

	#[test]
	fn every_activity_has_a_colour_and_only_idle_recedes() {
		use crate::state::model::Activity;
		let theme = Theme::of(Appearance::Dark);
		let mut seen = Vec::new();
		for activity in Activity::ALL {
			let color = theme.activity(activity);
			if activity != Activity::Idle {
				assert_ne!(
					color, theme.text_faint,
					"{activity:?} reads as receded, so it does not announce itself"
				);
			}
			seen.push((activity, color));
		}
		let waiting = theme.activity(Activity::Waiting);
		let failed = theme.activity(Activity::Failed);
		assert_ne!(waiting, failed, "waiting and failed are the same colour");
	}

	#[test]
	fn flipping_the_appearance_selects_the_other_palette() {
		assert_eq!(Theme::of(Appearance::Dark).appearance, Appearance::Dark);
		assert_eq!(Theme::of(Appearance::Dark.flipped()).appearance, Appearance::Light);
	}
}
