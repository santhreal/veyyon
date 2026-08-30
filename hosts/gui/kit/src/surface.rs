//! The one ground primitive.
//!
//! Every filled region in the window comes from [`surface`]: the window itself,
//! the panel, the transcript canvas, a message card, a dialog, the composer
//! well. Nothing else calls `.bg(...)` with a surface role.
//!
//! # Why it is one function
//!
//! A ground is not only a colour. It is a colour, an edge, a radius, and — the
//! moment a blurred backdrop or a shadow is added — a stack of layers under the
//! content. Writing `.bg(cx.color(Role::SurfaceRaised))` at forty call sites
//! makes adding the second layer a forty-file change, and the forty will not
//! all get it. So the ground is chosen by naming a [`Level`], and this file is
//! where a level's appearance is decided.
//!
//! # The decision is separate from the element
//!
//! [`Ground`] resolves a level against a palette with no gpui window involved,
//! so what a level looks like is checked directly. [`surface`] is the thin part
//! that applies the result.

use gpui::{App, Div, Hsla, Pixels, Styled, div};
use veyyon_gui_theme::{Palette, Role};

use crate::{
	theme::ActiveTheme,
	tokens::{radius, stroke},
};

/// Which ground a region sits on.
///
/// Ordered from the back of the window forward. A level is a position in the
/// stack, not a colour: the palette decides what each one looks like, and on a
/// light theme the stack runs the other way in luminance while staying the same
/// stack here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
	/// The window's own ground. Behind everything, no edge, no radius.
	Window,
	/// The side panel and rail.
	Panel,
	/// The transcript's ground.
	Canvas,
	/// A card on the canvas: a message, a tool call.
	Raised,
	/// A well set into its ground: the composer input, a code block.
	Sunken,
	/// A popover, menu or dialog above everything.
	Overlay,
}

impl Level {
	/// Every level, back to front.
	pub const ALL: &'static [Level] =
		&[Level::Window, Level::Panel, Level::Canvas, Level::Raised, Level::Sunken, Level::Overlay];

	/// The palette role this level fills with.
	pub const fn fill(self) -> Role {
		match self {
			Level::Window => Role::SurfaceWindow,
			Level::Panel => Role::SurfacePanel,
			Level::Canvas => Role::SurfaceCanvas,
			Level::Raised => Role::SurfaceRaised,
			Level::Sunken => Role::SurfaceSunken,
			Level::Overlay => Role::SurfaceOverlay,
		}
	}

	/// The palette role this level's edge draws with, or `None` when it has no
	/// edge.
	///
	/// A full-bleed ground has no edge: there is nothing on the other side of it
	/// to separate from. A card and a well take a hairline, a dialog takes a
	/// visible one, because a dialog floats over content of unknown colour and
	/// its own fill may not be enough to bound it.
	pub const fn edge(self) -> Option<Role> {
		match self {
			Level::Window | Level::Canvas => None,
			Level::Panel | Level::Raised | Level::Sunken => Some(Role::StrokeSubtle),
			Level::Overlay => Some(Role::StrokeDefault),
		}
	}

	/// The corner radius of this level.
	pub const fn radius(self) -> Pixels {
		match self {
			Level::Window | Level::Panel | Level::Canvas => radius::NONE,
			Level::Raised | Level::Sunken => radius::MEDIUM,
			Level::Overlay => radius::LARGE,
		}
	}
}

/// A level resolved against a palette: what it actually looks like.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ground {
	pub fill:   Hsla,
	pub edge:   Option<Hsla>,
	pub radius: Pixels,
}

impl Ground {
	pub fn resolve(level: Level, palette: &Palette) -> Ground {
		Ground {
			fill:   palette[level.fill()],
			edge:   level.edge().map(|role| palette[role]),
			radius: level.radius(),
		}
	}

	/// Apply this ground to an element.
	pub fn apply<E: Styled>(self, element: E) -> E {
		let element = element.bg(self.fill).rounded(self.radius);
		match self.edge {
			None => element,
			Some(color) => element.border(stroke::HAIRLINE).border_color(color),
		}
	}
}

/// A `div` filled as `level`.
///
/// The start of every region in the window.
pub fn surface(level: Level, cx: &App) -> Div {
	Ground::resolve(level, &cx.theme().palette).apply(div())
}

#[cfg(test)]
mod tests {
	use veyyon_gui_theme::builtin;

	use super::*;

	fn palette(name: &str) -> Palette {
		builtin::load(name).expect("bundled").expect("resolves")
	}

	/// A full-bleed ground has no edge and no radius. A rounded window corner
	/// over an unrounded frame shows the desktop through the gap.
	#[test]
	fn full_bleed_grounds_have_no_edge_and_no_radius() {
		for level in [Level::Window, Level::Canvas] {
			assert_eq!(level.edge(), None, "{level:?} has an edge");
			assert_eq!(level.radius(), radius::NONE, "{level:?} is rounded");
		}
	}

	/// A floating level has both. A dialog with no edge over a card of similar
	/// colour has no visible boundary at all.
	#[test]
	fn floating_levels_have_an_edge_and_a_radius() {
		for level in [Level::Raised, Level::Sunken, Level::Overlay] {
			assert!(level.edge().is_some(), "{level:?} has no edge");
			assert!(level.radius() > radius::NONE, "{level:?} is not rounded");
		}
	}

	/// A dialog reads as further forward than a card: a stronger edge and a
	/// larger radius. This is the whole depth cue, since gpui divs have no
	/// shadow under a rounded rect and no scale transform.
	#[test]
	fn an_overlay_reads_as_further_forward_than_a_card() {
		assert!(Level::Overlay.radius() > Level::Raised.radius());
		assert_eq!(Level::Raised.edge(), Some(Role::StrokeSubtle));
		assert_eq!(Level::Overlay.edge(), Some(Role::StrokeDefault));
	}

	/// Levels that meet on screen are separated in every bundled theme.
	///
	/// The failure this closes: two adjacent regions the same colour, so the
	/// boundary between them is invisible and a card looks like part of the
	/// page. It can only be checked across the whole bundled set, because a
	/// theme's own `export` block decides three of the six grounds — and three
	/// bundled themes (`dark`, `light`, `titanium`) export one flat colour for
	/// all three, which is exactly the case that breaks.
	///
	/// Only pairs that touch are checked. A dialog never sits beside the panel,
	/// so `dark-solarized` giving both the same colour is not a defect, and
	/// asserting every pair distinct would reject it.
	#[test]
	fn adjacent_levels_are_separated_in_every_bundled_theme() {
		for name in builtin::names() {
			let palette = palette(name);
			for (back, front) in ADJACENT {
				let separation = separation(*back, *front, &palette);
				assert!(
					separation >= MIN_SEPARATION,
					"{name}: {back:?} and {front:?} differ by {separation} steps, under \
					 {MIN_SEPARATION}"
				);
			}
		}
	}

	/// The well is set into the page rather than raised off it, in every theme.
	///
	/// Direction is asserted for the well and nowhere else. A card's elevation
	/// runs toward white on both appearances, which is a property of the colour
	/// helpers and is asserted there; here the only claim is that the composer
	/// goes the other way from a card. A well that rises reads as a card, and
	/// the composer stops looking like an input.
	#[test]
	fn the_well_is_set_into_the_page_in_every_bundled_theme() {
		for name in builtin::names() {
			let palette = palette(name);
			let canvas = luma(Level::Canvas, &palette);
			let sunken = luma(Level::Sunken, &palette);
			// A page with nowhere darker to go lightens its well instead, which
			// stays a well through its edge. `dark` is one flat `#000000`, and a
			// page that black is the only shape of theme this exempts.
			if canvas <= f32::from(MIN_SEPARATION) / 255.0 {
				assert!(sunken > canvas, "{name}: a black page did not separate its well");
				continue;
			}
			assert!(sunken < canvas, "{name}: the well is not set into the page");
		}
	}

	/// Level pairs that share a boundary on screen.
	const ADJACENT: &[(Level, Level)] = &[
		// The panel runs down the side of the window.
		(Level::Window, Level::Panel),
		// A card sits on the transcript.
		(Level::Canvas, Level::Raised),
		// A dialog floats over a card.
		(Level::Raised, Level::Overlay),
		// The composer is set into the page.
		(Level::Canvas, Level::Sunken),
	];

	/// Smallest per-channel difference that reads as a boundary, in 8-bit steps.
	///
	/// Per channel rather than by luma: `birch` puts a warm page (`#f9f7f1`)
	/// under a cool panel (`#f5f8f3`), which land within 0.0001 luma of each
	/// other and are plainly two colours. A luma measure calls that boundary
	/// invisible and would have the derivation destroy what the theme states.
	///
	/// In whole steps rather than a float: a palette holds `Hsla`, so a fill
	/// read back as `Rgba` is off the byte the GPU rasterizes by a rounding
	/// error, and `quartz`, whose page and panel differ by exactly two steps,
	/// measured 0.0078 against a threshold of 0.00784.
	const MIN_SEPARATION: u8 = 2;

	fn luma(level: Level, palette: &Palette) -> f32 {
		let rgba = gpui::Rgba::from(Ground::resolve(level, palette).fill);
		0.2126 * rgba.r + 0.7152 * rgba.g + 0.0722 * rgba.b
	}

	/// A level's fill as the three bytes it is rasterized as.
	fn channels(level: Level, palette: &Palette) -> [u8; 3] {
		let rgba = gpui::Rgba::from(Ground::resolve(level, palette).fill);
		[rgba.r, rgba.g, rgba.b].map(|channel| (channel * 255.0).round().clamp(0.0, 255.0) as u8)
	}

	fn separation(back: Level, front: Level, palette: &Palette) -> u8 {
		let back = channels(back, palette);
		let front = channels(front, palette);
		(0..3)
			.map(|channel| back[channel].abs_diff(front[channel]))
			.max()
			.unwrap_or(0)
	}

	/// A ground applies its fill, radius and edge to the element, and applies no
	/// border when the level has none. Asserted through the resolved values
	/// rather than the built element, because a `Div`'s style is not readable
	/// back out — the element path is exercised by the app's smoke test.
	#[test]
	fn a_ground_carries_exactly_what_its_level_decided() {
		let palette = palette("dark-gruvbox");

		let window = Ground::resolve(Level::Window, &palette);
		assert_eq!(window.fill, palette[Role::SurfaceWindow]);
		assert_eq!(window.edge, None);
		assert_eq!(window.radius, radius::NONE);

		let overlay = Ground::resolve(Level::Overlay, &palette);
		assert_eq!(overlay.fill, palette[Role::SurfaceOverlay]);
		assert_eq!(overlay.edge, Some(palette[Role::StrokeDefault]));
		assert_eq!(overlay.radius, radius::LARGE);
	}
}
