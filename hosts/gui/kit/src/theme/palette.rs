//! The two palettes, and the families they are drawn in.
//!
//! Written as hue, saturation and luminance rather than as hex, because the two
//! of them are one stack read twice: a ground is a luminance step at a fixed
//! hue, and a step is only checkable against its neighbour when the numbers say
//! what they are.

use std::sync::OnceLock;

use super::{Appearance, Theme, syntax};

/// Dark. The chrome sits above the content in luminance, so the content well is
/// the darkest large area and the sidebar frames it.
pub static DARK: Theme = Theme {
	appearance:     Appearance::Dark,
	ground:         Hsla { h: 0.63, s: 0.08, l: 0.070, a: 1.0 },
	chrome:         Hsla { h: 0.63, s: 0.05, l: 0.132, a: 1.0 },
	canvas:         Hsla { h: 0.63, s: 0.06, l: 0.094, a: 1.0 },
	raised:         Hsla { h: 0.63, s: 0.05, l: 0.152, a: 1.0 },
	sunken:         Hsla { h: 0.63, s: 0.08, l: 0.062, a: 1.0 },
	overlay:        Hsla { h: 0.63, s: 0.05, l: 0.178, a: 1.0 },
	stroke:         Hsla { h: 0.63, s: 0.10, l: 0.95, a: 0.38 },
	// Lighter than the accent it echoes: composited over the overlay, the
	// lightest ground in this theme, the ring is the one token that has to clear
	// 3:1 against a surface almost as light as itself, and 0.62 lands on 3.0
	// exactly.
	ring:           Hsla { h: 0.62, s: 0.80, l: 0.66, a: 0.85 },
	text:           Hsla { h: 0.63, s: 0.08, l: 0.95, a: 1.0 },
	text_muted:     Hsla { h: 0.63, s: 0.06, l: 0.66, a: 1.0 },
	text_faint:     Hsla { h: 0.63, s: 0.05, l: 0.46, a: 1.0 },
	text_on_accent: Hsla { h: 0.0, s: 0.0, l: 1.0, a: 1.0 },
	accent:         Hsla { h: 0.62, s: 0.78, l: 0.60, a: 1.0 },
	info:           Hsla { h: 0.57, s: 0.70, l: 0.58, a: 1.0 },
	danger:         Hsla { h: 0.99, s: 0.70, l: 0.62, a: 1.0 },
	ok:             Hsla { h: 0.35, s: 0.52, l: 0.56, a: 1.0 },
	warn:           Hsla { h: 0.11, s: 0.72, l: 0.62, a: 1.0 },
	added:          Hsla { h: 0.35, s: 0.60, l: 0.42, a: 0.20 },
	removed:        Hsla { h: 0.99, s: 0.60, l: 0.46, a: 0.20 },
	syntax:         syntax::DARK,
	font_ui:        UI_FAMILY,
	font_mono:      MONO_FAMILY,
};

/// Light. A card is the brightest area, the canvas the grey it lifts off, and
/// the chrome recedes behind both: the same depth order as dark, read the other
/// way.
///
/// The canvas is not at the top of the range, because a canvas at the top
/// leaves a surface nothing to lift into. Held there, a bubble stood six parts
/// in 255 off its ground against the dark palette's fifteen, and the window
/// read as outlines drawn on one flat sheet.
pub static LIGHT: Theme = Theme {
	appearance:     Appearance::Light,
	ground:         Hsla { h: 0.63, s: 0.12, l: 0.855, a: 1.0 },
	chrome:         Hsla { h: 0.63, s: 0.10, l: 0.905, a: 1.0 },
	canvas:         Hsla { h: 0.63, s: 0.12, l: 0.940, a: 1.0 },
	raised:         Hsla { h: 0.63, s: 0.10, l: 0.994, a: 1.0 },
	sunken:         Hsla { h: 0.63, s: 0.10, l: 0.888, a: 1.0 },
	overlay:        Hsla { h: 0.63, s: 0.14, l: 1.0, a: 1.0 },
	stroke:         Hsla { h: 0.63, s: 0.20, l: 0.15, a: 0.54 },
	ring:           Hsla { h: 0.62, s: 0.78, l: 0.50, a: 0.76 },
	text:           Hsla { h: 0.63, s: 0.18, l: 0.13, a: 1.0 },
	text_muted:     Hsla { h: 0.63, s: 0.09, l: 0.42, a: 1.0 },
	text_faint:     Hsla { h: 0.63, s: 0.07, l: 0.60, a: 1.0 },
	text_on_accent: Hsla { h: 0.0, s: 0.0, l: 1.0, a: 1.0 },
	accent:         Hsla { h: 0.62, s: 0.74, l: 0.50, a: 1.0 },
	info:           Hsla { h: 0.57, s: 0.68, l: 0.43, a: 1.0 },
	danger:         Hsla { h: 0.99, s: 0.68, l: 0.48, a: 1.0 },
	ok:             Hsla { h: 0.36, s: 0.54, l: 0.36, a: 1.0 },
	warn:           Hsla { h: 0.09, s: 0.72, l: 0.42, a: 1.0 },
	added:          Hsla { h: 0.35, s: 0.60, l: 0.42, a: 0.16 },
	removed:        Hsla { h: 0.99, s: 0.62, l: 0.48, a: 0.14 },
	syntax:         syntax::LIGHT,
	font_ui:        UI_FAMILY,
	font_mono:      MONO_FAMILY,
};

use gpui::Hsla;

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
pub fn families() -> (&'static str, &'static str) {
	match FAMILIES.get() {
		Some((ui, mono)) => (ui.as_str(), mono.as_str()),
		None => (UI_FAMILY, MONO_FAMILY),
	}
}
