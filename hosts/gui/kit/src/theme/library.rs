//! Built-in theme library, complete palette definitions, and resolution.
//!
//! Every theme is a complete palette with no token left to default. Switching
//! themes changes colors only and leaves all geometry and type sizes unchanged.

use gpui::{Hsla, Rgba};
use veyyon_gui_core::model::ThemeView;

use super::{Appearance, Syntax, Theme, palette};

/// A named theme in the library.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThemeEntry {
	pub id:         &'static str,
	pub name:       &'static str,
	pub appearance: Appearance,
	pub theme:      Theme,
}

impl ThemeEntry {
	pub fn view(&self) -> ThemeView {
		ThemeView {
			id:   self.id.to_string(),
			name: self.name.to_string(),
			dark: matches!(self.appearance, Appearance::Dark),
		}
	}
}

/// Midnight theme syntax palette.
pub static MIDNIGHT_SYNTAX: Syntax = Syntax {
	keyword:   Hsla { h: 0.80, s: 0.60, l: 0.75, a: 1.0 },
	kind:      Hsla { h: 0.12, s: 0.65, l: 0.72, a: 1.0 },
	function:  Hsla { h: 0.55, s: 0.70, l: 0.72, a: 1.0 },
	string:    Hsla { h: 0.35, s: 0.50, l: 0.65, a: 1.0 },
	number:    Hsla { h: 0.08, s: 0.65, l: 0.70, a: 1.0 },
	comment:   Hsla { h: 0.60, s: 0.15, l: 0.46, a: 1.0 },
	attribute: Hsla { h: 0.48, s: 0.50, l: 0.65, a: 1.0 },
	punct:     Hsla { h: 0.60, s: 0.10, l: 0.62, a: 1.0 },
	constant:  Hsla { h: 0.02, s: 0.65, l: 0.70, a: 1.0 },
};

/// Sand Light theme syntax palette.
pub static SAND_SYNTAX: Syntax = Syntax {
	keyword:   Hsla { h: 0.84, s: 0.58, l: 0.42, a: 1.0 },
	kind:      Hsla { h: 0.08, s: 0.70, l: 0.34, a: 1.0 },
	function:  Hsla { h: 0.58, s: 0.68, l: 0.40, a: 1.0 },
	string:    Hsla { h: 0.34, s: 0.55, l: 0.30, a: 1.0 },
	number:    Hsla { h: 0.05, s: 0.64, l: 0.40, a: 1.0 },
	comment:   Hsla { h: 0.10, s: 0.10, l: 0.50, a: 1.0 },
	attribute: Hsla { h: 0.46, s: 0.52, l: 0.32, a: 1.0 },
	punct:     Hsla { h: 0.10, s: 0.08, l: 0.42, a: 1.0 },
	constant:  Hsla { h: 0.01, s: 0.62, l: 0.42, a: 1.0 },
};

/// Midnight theme: deep navy dark palette with cyan accent.
pub static MIDNIGHT: Theme = Theme {
	appearance:     Appearance::Dark,
	ground:         Hsla { h: 0.60, s: 0.22, l: 0.060, a: 1.0 },
	chrome:         Hsla { h: 0.60, s: 0.18, l: 0.115, a: 1.0 },
	canvas:         Hsla { h: 0.60, s: 0.20, l: 0.082, a: 1.0 },
	raised:         Hsla { h: 0.60, s: 0.16, l: 0.140, a: 1.0 },
	sunken:         Hsla { h: 0.60, s: 0.22, l: 0.050, a: 1.0 },
	overlay:        Hsla { h: 0.60, s: 0.16, l: 0.165, a: 1.0 },
	stroke:         Hsla { h: 0.60, s: 0.25, l: 0.95, a: 0.38 },
	ring:           Hsla { h: 0.55, s: 0.85, l: 0.66, a: 0.85 },
	text:           Hsla { h: 0.60, s: 0.10, l: 0.96, a: 1.0 },
	text_muted:     Hsla { h: 0.60, s: 0.12, l: 0.68, a: 1.0 },
	text_faint:     Hsla { h: 0.60, s: 0.10, l: 0.48, a: 1.0 },
	text_on_accent: Hsla { h: 0.60, s: 0.30, l: 0.05, a: 1.0 },
	accent:         Hsla { h: 0.55, s: 0.85, l: 0.58, a: 1.0 },
	info:           Hsla { h: 0.52, s: 0.75, l: 0.58, a: 1.0 },
	danger:         Hsla { h: 0.98, s: 0.75, l: 0.64, a: 1.0 },
	ok:             Hsla { h: 0.40, s: 0.60, l: 0.56, a: 1.0 },
	warn:           Hsla { h: 0.12, s: 0.78, l: 0.62, a: 1.0 },
	added:          Hsla { h: 0.40, s: 0.60, l: 0.42, a: 0.20 },
	removed:        Hsla { h: 0.98, s: 0.65, l: 0.46, a: 0.20 },
	syntax:         MIDNIGHT_SYNTAX,
	font_ui:        palette::UI_FAMILY,
	font_mono:      palette::MONO_FAMILY,
};

/// Sand Light theme: warm cream and sand light palette with terracotta accent.
pub static SAND_LIGHT: Theme = Theme {
	appearance:     Appearance::Light,
	ground:         Hsla { h: 0.10, s: 0.15, l: 0.880, a: 1.0 },
	chrome:         Hsla { h: 0.10, s: 0.12, l: 0.920, a: 1.0 },
	canvas:         Hsla { h: 0.10, s: 0.16, l: 0.950, a: 1.0 },
	raised:         Hsla { h: 0.10, s: 0.14, l: 0.990, a: 1.0 },
	sunken:         Hsla { h: 0.10, s: 0.14, l: 0.890, a: 1.0 },
	overlay:        Hsla { h: 0.10, s: 0.16, l: 1.000, a: 1.0 },
	stroke:         Hsla { h: 0.10, s: 0.20, l: 0.15, a: 0.54 },
	ring:           Hsla { h: 0.07, s: 0.78, l: 0.35, a: 0.80 },
	text:           Hsla { h: 0.10, s: 0.20, l: 0.14, a: 1.0 },
	text_muted:     Hsla { h: 0.10, s: 0.12, l: 0.40, a: 1.0 },
	text_faint:     Hsla { h: 0.10, s: 0.10, l: 0.58, a: 1.0 },
	text_on_accent: Hsla { h: 0.00, s: 0.00, l: 1.00, a: 1.0 },
	accent:         Hsla { h: 0.07, s: 0.78, l: 0.38, a: 1.0 },
	info:           Hsla { h: 0.55, s: 0.70, l: 0.36, a: 1.0 },
	danger:         Hsla { h: 0.98, s: 0.72, l: 0.40, a: 1.0 },
	ok:             Hsla { h: 0.38, s: 0.58, l: 0.30, a: 1.0 },
	warn:           Hsla { h: 0.09, s: 0.80, l: 0.36, a: 1.0 },
	added:          Hsla { h: 0.38, s: 0.58, l: 0.40, a: 0.18 },
	removed:        Hsla { h: 0.98, s: 0.65, l: 0.46, a: 0.16 },
	syntax:         SAND_SYNTAX,
	font_ui:        palette::UI_FAMILY,
	font_mono:      palette::MONO_FAMILY,
};

/// Default dark theme entry.
pub static VEYYON_DARK: ThemeEntry = ThemeEntry {
	id:         "dark",
	name:       "Dark",
	appearance: Appearance::Dark,
	theme:      palette::DARK,
};

/// Default light theme entry.
pub static VEYYON_LIGHT: ThemeEntry = ThemeEntry {
	id:         "light",
	name:       "Light",
	appearance: Appearance::Light,
	theme:      palette::LIGHT,
};

/// Midnight dark theme entry.
pub static VEYYON_MIDNIGHT: ThemeEntry = ThemeEntry {
	id:         "midnight",
	name:       "Midnight",
	appearance: Appearance::Dark,
	theme:      MIDNIGHT,
};

/// Sand light theme entry.
pub static VEYYON_SAND: ThemeEntry = ThemeEntry {
	id:         "sand",
	name:       "Sand Light",
	appearance: Appearance::Light,
	theme:      SAND_LIGHT,
};

/// All themes shipped with the application.
pub static THEMES: [ThemeEntry; 4] = [VEYYON_DARK, VEYYON_LIGHT, VEYYON_MIDNIGHT, VEYYON_SAND];

/// Returns all shipped theme entries.
pub fn entries() -> &'static [ThemeEntry] {
	&THEMES
}

/// Look up a theme by identifier.
pub fn get(id: &str) -> Option<&'static ThemeEntry> {
	let query = id.trim().to_lowercase();
	THEMES.iter().find(|entry| {
		entry.id.eq_ignore_ascii_case(&query) || entry.name.eq_ignore_ascii_case(&query)
	})
}

/// Fallback report when resolving a requested theme identifier.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolutionReport {
	pub entry:   &'static ThemeEntry,
	pub refused: Option<String>,
}

/// Resolves a requested theme identifier with honest fallback reporting.
pub fn resolve(requested: Option<&str>) -> ResolutionReport {
	let Some(id) = requested else {
		return ResolutionReport { entry: &VEYYON_DARK, refused: None };
	};

	let trimmed = id.trim();
	if trimmed.is_empty() {
		return ResolutionReport { entry: &VEYYON_DARK, refused: None };
	}

	if let Some(entry) = get(trimmed) {
		ResolutionReport { entry, refused: None }
	} else {
		ResolutionReport { entry: &VEYYON_DARK, refused: Some(trimmed.to_string()) }
	}
}
/// Returns view models for all available library themes.
pub fn views() -> Vec<ThemeView> {
	THEMES.iter().map(|entry| entry.view()).collect()
}

/// Calculate standard sRGB channel linear luminance.
fn channel_luminance(channel: f32) -> f32 {
	if channel <= 0.04045 {
		channel / 12.92
	} else {
		((channel + 0.055) / 1.055).powf(2.4)
	}
}

/// Relative luminance of an HSLA color.
pub fn relative_luminance(color: Hsla) -> f32 {
	let rgba = Rgba::from(color);
	0.2126 * channel_luminance(rgba.r)
		+ 0.7152 * channel_luminance(rgba.g)
		+ 0.0722 * channel_luminance(rgba.b)
}

/// WCAG contrast ratio between two colors.
pub fn contrast_ratio(left: Hsla, right: Hsla) -> f32 {
	let (a, b) = (relative_luminance(left), relative_luminance(right));
	(a.max(b) + 0.05) / (a.min(b) + 0.05)
}

/// Composite a top color with alpha over an opaque ground.
pub fn composite_over(top: Hsla, ground: Hsla) -> Hsla {
	let (top_rgba, ground_rgba) = (Rgba::from(top), Rgba::from(ground));
	Hsla::from(Rgba {
		r: ground_rgba.r + top_rgba.a * (top_rgba.r - ground_rgba.r),
		g: ground_rgba.g + top_rgba.a * (top_rgba.g - ground_rgba.g),
		b: ground_rgba.b + top_rgba.a * (top_rgba.b - ground_rgba.b),
		a: 1.0,
	})
}

/// Sweepable foreground-on-background contrast pair descriptor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContrastPair {
	pub role:          &'static str,
	pub foreground:    Hsla,
	pub background:    Hsla,
	pub minimum_ratio: f32,
}

/// Collects every foreground-on-background pair in a theme that carries a
/// contrast contract.
pub fn contrast_pairs(theme: &Theme) -> Vec<ContrastPair> {
	let mut pairs = Vec::new();
	for (ground_name, ground) in theme.grounds() {
		pairs.push(ContrastPair {
			role:          ground_name,
			foreground:    theme.text,
			background:    ground,
			minimum_ratio: 4.5,
		});
		let stroke = composite_over(theme.stroke, ground);
		pairs.push(ContrastPair {
			role:          "stroke",
			foreground:    stroke,
			background:    ground,
			minimum_ratio: 3.0,
		});
		let ring = composite_over(theme.ring, ground);
		pairs.push(ContrastPair {
			role:          "ring",
			foreground:    ring,
			background:    ground,
			minimum_ratio: 3.0,
		});
	}
	pairs.push(ContrastPair {
		role:          "text_on_accent",
		foreground:    theme.text_on_accent,
		background:    theme.accent,
		minimum_ratio: 4.0,
	});
	pairs.push(ContrastPair {
		role:          "text_muted_on_canvas",
		foreground:    theme.text_muted,
		background:    theme.canvas,
		minimum_ratio: 3.0,
	});
	for (_token, color) in theme.syntax.all() {
		pairs.push(ContrastPair {
			role:          "syntax_on_sunken",
			foreground:    color,
			background:    theme.sunken,
			minimum_ratio: 2.0,
		});
	}
	pairs
}
