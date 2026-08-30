//! Colour, and the only place a colour is written down.
//!
//! One palette per appearance, resolved once and held as a global. Nothing else
//! in the app writes a colour literal: a module that needs one names a field
//! here, so a change to how the window reads is a change to this file.
//!
//! Six grounds, two strokes, one accent. A boundary is a change of ground, not
//! a line: the window has one hairline in it, between the chrome and the
//! content, and everything else separates by its own fill and the space around
//! it. Terminal theme files describe sixteen ANSI colours and say nothing about
//! a sidebar or a titlebar, so they are not the source here; they will supply
//! the transcript's syntax colours, which is the one thing they do describe.

use std::sync::OnceLock;

use gpui::{App, Global, Hsla};

use crate::state::model::Appearance;

/// Every colour the window draws with.
#[derive(Debug, Clone, Copy)]
pub struct Theme {
	pub appearance: Appearance,

	/// The titlebar and the sidebar: one continuous region, so the window reads
	/// as chrome around content rather than as three panes.
	pub chrome:  Hsla,
	/// The content ground, which is where the eye rests.
	pub canvas:  Hsla,
	/// A surface on the canvas: a message, a settings row.
	pub raised:  Hsla,
	/// A well set into a surface: code, an input.
	pub sunken:  Hsla,
	/// A sheet floating over the window.
	pub overlay: Hsla,

	/// The window's one hairline: chrome against content, and a sheet's edge.
	pub stroke: Hsla,
	/// The ring around a focused control.
	pub ring:   Hsla,

	pub text:           Hsla,
	pub text_muted:     Hsla,
	pub text_faint:     Hsla,
	/// Text on top of an accent fill.
	pub text_on_accent: Hsla,

	pub accent: Hsla,
	pub danger: Hsla,

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
		self.text.opacity(0.05)
	}

	/// The ground a selected row takes.
	pub fn selected(self) -> Hsla {
		match self.appearance {
			Appearance::Dark => self.text.opacity(0.09),
			Appearance::Light => self.accent.opacity(0.11),
		}
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
}

// The palettes are written as hue, saturation and luminance rather than as
// hex, because the two of them are one stack read twice: a ground is a
// luminance step at a fixed hue, and a step is only checkable against its
// neighbour when the numbers say what they are.

/// The dark palette. The chrome sits above the content in luminance, so the
/// content well is the darkest large area and the sidebar frames it.
static DARK: Theme = Theme {
	appearance:     Appearance::Dark,
	chrome:         Hsla { h: 0.63, s: 0.05, l: 0.132, a: 1.0 },
	canvas:         Hsla { h: 0.63, s: 0.06, l: 0.094, a: 1.0 },
	raised:         Hsla { h: 0.63, s: 0.05, l: 0.152, a: 1.0 },
	sunken:         Hsla { h: 0.63, s: 0.08, l: 0.062, a: 1.0 },
	overlay:        Hsla { h: 0.63, s: 0.05, l: 0.178, a: 1.0 },
	stroke:         Hsla { h: 0.63, s: 0.10, l: 0.95, a: 0.07 },
	ring:           Hsla { h: 0.62, s: 0.80, l: 0.62, a: 0.45 },
	text:           Hsla { h: 0.63, s: 0.08, l: 0.95, a: 1.0 },
	text_muted:     Hsla { h: 0.63, s: 0.06, l: 0.66, a: 1.0 },
	text_faint:     Hsla { h: 0.63, s: 0.05, l: 0.46, a: 1.0 },
	text_on_accent: Hsla { h: 0.0, s: 0.0, l: 1.0, a: 1.0 },
	accent:         Hsla { h: 0.62, s: 0.78, l: 0.60, a: 1.0 },
	danger:         Hsla { h: 0.99, s: 0.70, l: 0.62, a: 1.0 },
	font_ui:        UI_FAMILY,
	font_mono:      MONO_FAMILY,
};

/// The light palette. Content is the brightest area and the chrome recedes
/// behind it, which is the same depth order read the other way.
static LIGHT: Theme = Theme {
	appearance:     Appearance::Light,
	chrome:         Hsla { h: 0.63, s: 0.10, l: 0.950, a: 1.0 },
	canvas:         Hsla { h: 0.63, s: 0.12, l: 0.982, a: 1.0 },
	raised:         Hsla { h: 0.63, s: 0.10, l: 0.960, a: 1.0 },
	sunken:         Hsla { h: 0.63, s: 0.10, l: 0.930, a: 1.0 },
	overlay:        Hsla { h: 0.63, s: 0.14, l: 1.0, a: 1.0 },
	stroke:         Hsla { h: 0.63, s: 0.20, l: 0.15, a: 0.09 },
	ring:           Hsla { h: 0.62, s: 0.78, l: 0.50, a: 0.40 },
	text:           Hsla { h: 0.63, s: 0.18, l: 0.13, a: 1.0 },
	text_muted:     Hsla { h: 0.63, s: 0.09, l: 0.42, a: 1.0 },
	text_faint:     Hsla { h: 0.63, s: 0.07, l: 0.60, a: 1.0 },
	text_on_accent: Hsla { h: 0.0, s: 0.0, l: 1.0, a: 1.0 },
	accent:         Hsla { h: 0.62, s: 0.74, l: 0.50, a: 1.0 },
	danger:         Hsla { h: 0.99, s: 0.68, l: 0.48, a: 1.0 },
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
	match FAMILIES.get() {
		Some((ui, mono)) => (ui.as_str(), mono.as_str()),
		None => (UI_FAMILY, MONO_FAMILY),
	}
}

/// Text sizes, in pixels at the default font size. Three of them: anything a
/// fourth size would say is said by weight or colour instead.
pub mod size {
	pub const META: f32 = 11.0;
	pub const SMALL: f32 = 12.0;
	pub const BODY: f32 = 13.5;
	/// The line height every run of text takes, as a multiple of its size.
	pub const LINE: f32 = 1.55;
}

/// Spacing, in pixels. Every gap and pad in the window is one of these.
pub mod space {
	pub const TIGHT: f32 = 4.0;
	pub const SNUG: f32 = 6.0;
	pub const BASE: f32 = 10.0;
	pub const WIDE: f32 = 14.0;
	pub const LOOSE: f32 = 20.0;
	pub const HUGE: f32 = 32.0;
}

/// Corner radii. Nothing in the window is square.
pub mod radius {
	pub const CHIP: f32 = 6.0;
	pub const ROW: f32 = 9.0;
	pub const CARD: f32 = 14.0;
	pub const SHEET: f32 = 18.0;
	pub const PILL: f32 = 999.0;
}

/// Fixed region sizes.
pub mod layout {
	/// The titlebar. Tall enough for macOS traffic lights inset at 14, and for
	/// the same controls drawn by the app elsewhere.
	pub const TITLEBAR: f32 = 46.0;
	/// The reading column for a conversation.
	pub const READING: f32 = 680.0;
	/// The palette sheet.
	pub const SHEET: f32 = 560.0;
	/// How wide the drag handle between two regions is.
	pub const HANDLE: f32 = 5.0;
	/// A window control: the three circles on the titlebar's left.
	pub const CONTROL: f32 = 12.0;
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! Two palettes, one set of fields, and the failure is silent: a field left
	//! at the other appearance's value paints one region invisible in one mode
	//! only, which nobody sees until they flip. With one hairline left in the
	//! window, every other boundary is carried by the difference between two
	//! fills, so two fills that converge erase a boundary outright.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the colours are pleasant.

	use super::*;

	fn lum(color: Hsla) -> f32 {
		color.l
	}

	/// 3/255 is the floor at which a boundary between two large fills is
	/// visible on an ordinary panel.
	const FLOOR: f32 = 3.0 / 255.0;

	#[test]
	fn every_boundary_the_window_draws_without_a_line_is_visible_as_a_fill() {
		for appearance in [Appearance::Dark, Appearance::Light] {
			let theme = Theme::of(appearance);
			for (left, right, what) in [
				(theme.chrome, theme.canvas, "the sidebar and the conversation"),
				(theme.raised, theme.canvas, "a surface and its canvas"),
				(theme.sunken, theme.raised, "a well and the surface it is cut into"),
				(theme.overlay, theme.canvas, "a sheet and what is behind it"),
			] {
				assert!(
					(lum(left) - lum(right)).abs() >= FLOOR,
					"{appearance:?}: {what} are the same colour"
				);
			}
		}
	}

	#[test]
	fn the_depth_order_is_the_same_shape_in_both_appearances() {
		// A well is always behind the surface it is cut into, and a sheet is
		// always in front of the canvas. Dark lifts toward white and light
		// lifts toward black, so the comparison is against the canvas rather
		// than an absolute.
		let dark = Theme::of(Appearance::Dark);
		assert!(lum(dark.sunken) < lum(dark.canvas));
		assert!(lum(dark.overlay) > lum(dark.canvas));
		assert!(lum(dark.chrome) > lum(dark.canvas));

		let light = Theme::of(Appearance::Light);
		assert!(lum(light.sunken) < lum(light.canvas));
		assert!(lum(light.overlay) >= lum(light.canvas));
		assert!(lum(light.chrome) < lum(light.canvas));
	}

	#[test]
	fn text_reads_against_the_ground_it_sits_on_in_both_appearances() {
		for appearance in [Appearance::Dark, Appearance::Light] {
			let theme = Theme::of(appearance);
			let gap = (lum(theme.text) - lum(theme.canvas)).abs();
			assert!(gap > 0.5, "{appearance:?}: body text has no contrast against the canvas");
			let faint = (lum(theme.text_faint) - lum(theme.canvas)).abs();
			assert!(faint > 0.15, "{appearance:?}: the faintest text is invisible");
			let on_accent = (lum(theme.text_on_accent) - lum(theme.accent)).abs();
			assert!(on_accent > 0.25, "{appearance:?}: text on an accent fill is invisible");
		}
	}

	#[test]
	fn flipping_the_appearance_selects_the_other_palette() {
		assert_eq!(Theme::of(Appearance::Dark).appearance, Appearance::Dark);
		assert_eq!(Theme::of(Appearance::Dark.flipped()).appearance, Appearance::Light);
	}
}
