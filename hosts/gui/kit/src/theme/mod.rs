//! Colour, and the only place a colour is written down.
//!
//! One palette per appearance, resolved once and held as a global. Nothing else
//! in the app writes a colour literal: a module that needs one names a field
//! here, so a change to how the window reads is a change to this directory.
//!
//! Five grounds, two strokes, one accent, four states, one syntax set. A
//! boundary is a change of ground, not a line: the window has one hairline in
//! it, between the chrome and the content, and everything else separates by its
//! own fill and the space around it.
//!
//! Terminal theme files describe sixteen ANSI colours and say nothing about a
//! sidebar or a titlebar, so they are not the source for chrome. They will
//! supply [`syntax`], which is the one thing they do describe.

#[cfg(test)]
mod a_larger_interface_size_moves_text_and_its_boxes_together;
pub mod geometry;
pub mod palette;
pub mod scale;
pub mod syntax;
#[cfg(test)]
mod tests;
pub mod tokens;

pub use geometry::{ResponsiveLayout, control, diff, icon, layout, responsive_layout, row};
use gpui::{App, BoxShadow, Global, Hsla, Pixels, point, px};
pub use palette::{MONO_CANDIDATES, MONO_FAMILY, UI_CANDIDATES, UI_FAMILY, families, set_families};
pub use scale::{base_font, interface, scaled, scaled_type, set_base_font};
pub use syntax::Syntax;
pub use tokens::{opacity, radius, size, space, weight};

/// Window appearance. This presentation preference is defined in kit so the
/// visual layer does not import product or store state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appearance {
	Dark,
	Light,
}

impl Appearance {
	pub const fn flipped(self) -> Self {
		match self {
			Self::Dark => Self::Light,
			Self::Light => Self::Dark,
		}
	}
}

/// Every colour the window draws with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Theme {
	pub appearance: Appearance,
	/// The deepest graphite ground, used by the titlebar and activity rail.
	pub ground:     Hsla,

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
	/// Informational state that is not a selection or primary action.
	pub info:   Hsla,
	pub danger: Hsla,
	/// Something finished and did what it said.
	pub ok:     Hsla,
	/// Something needs an answer before it can go on.
	pub warn:   Hsla,

	/// The ground a diff's added line takes, over the well it sits in.
	pub added:   Hsla,
	/// The ground a diff's removed line takes.
	pub removed: Hsla,

	/// The colours a fenced block is drawn in.
	pub syntax: Syntax,

	pub font_ui:   &'static str,
	pub font_mono: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Elevation {
	Ground,
	Chrome,
	Canvas,
	Raised,
	Overlay,
	Sunken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlState {
	Rest,
	Hovered,
	Pressed,
	Focused,
	Selected,
	Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusRole {
	Neutral,
	Info,
	Success,
	Warning,
	Danger,
}
impl Global for Theme {}

impl Theme {
	/// The palette for an appearance.
	pub fn of(appearance: Appearance) -> Theme {
		let mut theme = match appearance {
			Appearance::Dark => palette::DARK,
			Appearance::Light => palette::LIGHT,
		};
		let (ui, mono) = palette::families();
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

	/// Every large fill the window draws, for a sweep over all of them.
	///
	/// A fixed array rather than a list a caller writes: a sixth ground has to
	/// be added here, and the suites that sweep this go red until it is.
	pub fn grounds(self) -> [(&'static str, Hsla); 6] {
		[
			("ground", self.ground),
			("chrome", self.chrome),
			("canvas", self.canvas),
			("raised", self.raised),
			("sunken", self.sunken),
			("overlay", self.overlay),
		]
	}

	pub fn elevation(self, elevation: Elevation) -> Hsla {
		match elevation {
			Elevation::Ground => self.ground,
			Elevation::Chrome => self.chrome,
			Elevation::Canvas => self.canvas,
			Elevation::Raised => self.raised,
			Elevation::Overlay => self.overlay,
			Elevation::Sunken => self.sunken,
		}
	}

	pub fn status(self, role: StatusRole) -> Hsla {
		match role {
			StatusRole::Neutral => self.text_muted,
			StatusRole::Info => self.info,
			StatusRole::Success => self.ok,
			StatusRole::Warning => self.warn,
			StatusRole::Danger => self.danger,
		}
	}

	pub fn control_fill(self, state: ControlState) -> Hsla {
		match state {
			ControlState::Rest => Hsla { a: 0.0, ..self.text },
			ControlState::Hovered => self.hover(),
			ControlState::Pressed => self.pressed(),
			ControlState::Focused => self.ring.opacity(0.12),
			ControlState::Selected => self.selected(),
			ControlState::Disabled => self.text.opacity(0.025),
		}
	}

	/// The ground a hoverable surface takes under the pointer.
	pub fn hover(self) -> Hsla {
		self.text.opacity(0.05)
	}

	/// The ground a surface takes while it is being pressed.
	pub fn pressed(self) -> Hsla {
		self.text.opacity(0.09)
	}

	/// The ground a selected row takes.
	pub fn selected(self) -> Hsla {
		match self.appearance {
			Appearance::Dark => self.text.opacity(0.09),
			Appearance::Light => self.accent.opacity(0.11),
		}
	}

	pub fn selected_hover(self) -> Hsla {
		match self.appearance {
			Appearance::Dark => self.text.opacity(0.15),
			Appearance::Light => self.accent.opacity(0.18),
		}
	}

	/// The fill a status takes behind a badge, at the weight a fill can carry
	/// text.
	pub fn tint(self, color: Hsla) -> Hsla {
		match self.appearance {
			Appearance::Dark => color.opacity(0.18),
			Appearance::Light => color.opacity(0.14),
		}
	}

	pub fn focus_ring(self) -> Vec<BoxShadow> {
		vec![BoxShadow {
			color:         self.ring,
			offset:        point(Pixels::ZERO, Pixels::ZERO),
			blur_radius:   Pixels::ZERO,
			spread_radius: px(control::FOCUS_RING),
			inset:         false,
		}]
	}

	/// A card lifted off the canvas: a menu row's parent, a banner.
	pub fn shadow_card(self) -> Vec<BoxShadow> {
		vec![shadow(0.0, 1.0, 3.0, self.shadow_ink(0.30))]
	}

	/// A menu or a popover, which is close to what it came from.
	pub fn shadow_menu(self) -> Vec<BoxShadow> {
		vec![
			shadow(0.0, 4.0, 12.0, self.shadow_ink(0.34)),
			shadow(0.0, 1.0, 2.0, self.shadow_ink(0.24)),
		]
	}

	/// A sheet over the whole window, which is the furthest anything floats.
	pub fn shadow_sheet(self) -> Vec<BoxShadow> {
		vec![
			shadow(0.0, 18.0, 48.0, self.shadow_ink(0.44)),
			shadow(0.0, 2.0, 6.0, self.shadow_ink(0.26)),
		]
	}

	/// A shadow's ink. Dark rooms need a denser shadow than light ones, because
	/// the fill under it is already dark and a soft shadow disappears into it.
	fn shadow_ink(self, alpha: f32) -> Hsla {
		match self.appearance {
			Appearance::Dark => Hsla { h: 0.63, s: 0.30, l: 0.02, a: alpha },
			Appearance::Light => Hsla { h: 0.63, s: 0.24, l: 0.20, a: alpha * 0.5 },
		}
	}

	/// The ground behind a sheet, which dims what is under it.
	///
	/// A dim, not a blur: blur behind a window is a compositor decision on
	/// Linux, and a sheet whose ground is supposed to blur and does not reads as
	/// a defect. The caller multiplies this by the sheet's arrival.
	pub fn scrim(self) -> Hsla {
		match self.appearance {
			Appearance::Dark => Hsla { h: 0.63, s: 0.30, l: 0.02, a: opacity::SCRIM_DARK },
			Appearance::Light => Hsla { h: 0.63, s: 0.16, l: 0.28, a: opacity::SCRIM_LIGHT },
		}
	}

	/// The window's background mode. Translucent where the platform blurs behind
	/// a window, opaque where blur is compositor roulette.
	pub fn window_background(self) -> gpui::WindowBackgroundAppearance {
		if cfg!(target_os = "macos") {
			gpui::WindowBackgroundAppearance::Blurred
		} else {
			gpui::WindowBackgroundAppearance::Opaque
		}
	}
}

fn shadow(x: f32, y: f32, blur: f32, color: Hsla) -> BoxShadow {
	BoxShadow {
		color,
		offset: point(px(x), px(y)),
		blur_radius: px(blur),
		spread_radius: Pixels::ZERO,
		inset: false,
	}
}
