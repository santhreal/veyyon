//! ANSI Select Graphic Rendition (SGR) parser.
//!
//! Applies text styles (bold, dim, italic, underline, blink, inverse, hidden,
//! strike) and colour modifications (16 standard colours, 256-colour index,
//! 24-bit truecolour RGB) to terminal cells.

use super::cell::{CellStyle, Ink, NamedColor};

/// Applies a sequence of SGR parameter codes to the current cell style and
/// colours.
pub fn apply_sgr(params: &[u16], style: &mut CellStyle, fg: &mut Ink, bg: &mut Ink) {
	if params.is_empty() {
		style.reset();
		*fg = Ink::Default;
		*bg = Ink::Default;
		return;
	}

	let mut i = 0;
	while i < params.len() {
		let code = params[i];
		match code {
			0 => {
				style.reset();
				*fg = Ink::Default;
				*bg = Ink::Default;
			},
			1 => style.bold = true,
			2 => style.dim = true,
			3 => style.italic = true,
			4 => style.underline = true,
			5 | 6 => style.blink = true,
			7 => style.inverse = true,
			8 => style.hidden = true,
			9 => style.strike = true,
			21 => style.bold = false,
			22 => {
				style.bold = false;
				style.dim = false;
			},
			23 => style.italic = false,
			24 => style.underline = false,
			25 => style.blink = false,
			27 => style.inverse = false,
			28 => style.hidden = false,
			29 => style.strike = false,
			30..=37 => {
				if let Some(color) = NamedColor::from_index((code - 30) as u8) {
					*fg = Ink::Named(color);
				}
			},
			38 => {
				if let Some((ink, advance)) = parse_extended_color(&params[i + 1..]) {
					*fg = ink;
					i += advance;
				}
			},
			39 => *fg = Ink::Default,
			40..=47 => {
				if let Some(color) = NamedColor::from_index((code - 40) as u8) {
					*bg = Ink::Named(color);
				}
			},
			48 => {
				if let Some((ink, advance)) = parse_extended_color(&params[i + 1..]) {
					*bg = ink;
					i += advance;
				}
			},
			49 => *bg = Ink::Default,
			90..=97 => {
				if let Some(color) = NamedColor::from_index((code - 90 + 8) as u8) {
					*fg = Ink::Named(color);
				}
			},
			100..=107 => {
				if let Some(color) = NamedColor::from_index((code - 100 + 8) as u8) {
					*bg = Ink::Named(color);
				}
			},
			_ => {},
		}
		i += 1;
	}
}

/// Parses extended colour parameters following SGR 38 or 48.
/// Returns the parsed `Ink` and the number of subsequent parameter tokens
/// consumed.
const fn parse_extended_color(params: &[u16]) -> Option<(Ink, usize)> {
	if params.is_empty() {
		return None;
	}
	match params[0] {
		5 if params.len() >= 2 => {
			let idx = (params[1] & 0xff) as u8;
			Some((Ink::Indexed(idx), 2))
		},
		2 if params.len() >= 4 => {
			let r = (params[1] & 0xff) as u8;
			let g = (params[2] & 0xff) as u8;
			let b = (params[3] & 0xff) as u8;
			Some((Ink::Rgb(r, g, b), 4))
		},
		_ => None,
	}
}
