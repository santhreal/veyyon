//! The colors a terminal cell is drawn in, resolved against the palette.
//!
//! The sixteen named colors take the palette's roles, so a program's red is
//! the window's error red in either appearance; the 256-color cube, the gray
//! ramp and truecolor are the fixed values a program asked for.

use veyyon_desktop_model::text::terminal::{Ink, NamedColor};
use veyyon_desktop_ui::theme::Palette;
use veyyon_gpui::{Hsla, Rgba};

/// How much a dim cell's color keeps of its alpha.
const DIM: f32 = 0.6;

/// The color `ink` names, `None` for the default the caller supplies.
pub fn resolve(ink: Ink, palette: &Palette) -> Option<Hsla> {
	match ink {
		Ink::Default => None,
		Ink::Named(named) => Some(named_color(named, palette)),
		Ink::Indexed(index) => Some(indexed(index, palette)),
		Ink::Rgb(r, g, b) => Some(rgb(r, g, b)),
	}
}

/// The palette role one of the sixteen named colors takes.
pub const fn named_color(color: NamedColor, palette: &Palette) -> Hsla {
	match color {
		NamedColor::Black => palette.bg.surface,
		NamedColor::Red | NamedColor::BrightRed => palette.status.error,
		NamedColor::Green | NamedColor::BrightGreen => palette.status.success,
		NamedColor::Yellow | NamedColor::BrightYellow => palette.status.waiting,
		NamedColor::Blue | NamedColor::BrightBlue => palette.status.info,
		NamedColor::Magenta | NamedColor::BrightMagenta => palette.syntax.keyword,
		NamedColor::Cyan | NamedColor::BrightCyan => palette.syntax.type_name,
		NamedColor::White => palette.text.secondary,
		NamedColor::BrightBlack => palette.text.muted,
		NamedColor::BrightWhite => palette.text.primary,
	}
}

/// An xterm 256-color index: the sixteen named colors, the 6x6x6 cube and
/// the 24-step gray ramp.
pub fn indexed(index: u8, palette: &Palette) -> Hsla {
	if let Some(named) = NamedColor::from_index(index) {
		return named_color(named, palette);
	}
	if index >= 232 {
		let gray = (index - 232) * 10 + 8;
		return rgb(gray, gray, gray);
	}
	let cube = index - 16;
	let level = |step: u8| if step == 0 { 0 } else { step * 40 + 55 };
	rgb(level(cube / 36), level(cube / 6 % 6), level(cube % 6))
}

/// The foreground and background a cell is drawn in: the default ink is the
/// primary text on no fill, inverse swaps the two, and dim fades the
/// foreground.
pub fn cell_colors(
	fg: Ink,
	bg: Ink,
	inverse: bool,
	dim: bool,
	palette: &Palette,
) -> (Hsla, Option<Hsla>) {
	let fore = resolve(fg, palette).unwrap_or(palette.text.primary);
	let back = resolve(bg, palette);
	let (mut fore, back) = if inverse {
		(back.unwrap_or(palette.bg.app), Some(fore))
	} else {
		(fore, back)
	};
	if dim {
		fore.a *= DIM;
	}
	(fore, back)
}

fn rgb(r: u8, g: u8, b: u8) -> Hsla {
	Hsla::from(Rgba {
		r: f32::from(r) / 255.0,
		g: f32::from(g) / 255.0,
		b: f32::from(b) / 255.0,
		a: 1.0,
	})
}
