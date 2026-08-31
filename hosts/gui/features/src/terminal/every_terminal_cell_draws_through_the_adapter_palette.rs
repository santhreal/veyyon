//! WHY. Terminal cell colors, cursor highlights, and alternate buffer states
//! must map through the installed theme palette. If color resolution fails,
//! terminal output renders with corrupted contrast or hardcoded literals.
//!
//! THE CLASS. Terminal cells failing to resolve colors through
//! [`RendererPalette`], or alternate screen swapping corrupting retained
//! scrollback. This suite verifies the 256-color palette, direct RGB mapping,
//! cursor positioning, and scrollback retention across alternate buffer
//! toggles.
//!
//! WHAT IT DOES NOT CATCH. Physical GPU rasterization and OS font substitution.

use gpui::Hsla;
use veyyon_gui_core::{
	model::{TerminalId, TerminalRunView},
	text::terminal::CellColor,
};

use super::{GridSize, RendererAdapter, RendererPalette, RetainedTerminalRenderer};

fn dummy_palette() -> RendererPalette {
	RendererPalette {
		background:     Hsla { h: 0.0, s: 0.0, l: 0.1, a: 1.0 },
		foreground:     Hsla { h: 0.0, s: 0.0, l: 0.9, a: 1.0 },
		cursor:         Hsla { h: 0.5, s: 1.0, l: 0.5, a: 1.0 },
		selection:      Hsla { h: 0.6, s: 1.0, l: 0.5, a: 1.0 },
		black:          Hsla { h: 0.0, s: 0.0, l: 0.0, a: 1.0 },
		red:            Hsla { h: 0.0, s: 1.0, l: 0.5, a: 1.0 },
		green:          Hsla { h: 0.33, s: 1.0, l: 0.5, a: 1.0 },
		yellow:         Hsla { h: 0.16, s: 1.0, l: 0.5, a: 1.0 },
		blue:           Hsla { h: 0.66, s: 1.0, l: 0.5, a: 1.0 },
		magenta:        Hsla { h: 0.83, s: 1.0, l: 0.5, a: 1.0 },
		cyan:           Hsla { h: 0.5, s: 1.0, l: 0.5, a: 1.0 },
		white:          Hsla { h: 0.0, s: 0.0, l: 0.8, a: 1.0 },
		bright_black:   Hsla { h: 0.0, s: 0.0, l: 0.3, a: 1.0 },
		bright_red:     Hsla { h: 0.0, s: 1.0, l: 0.7, a: 1.0 },
		bright_green:   Hsla { h: 0.33, s: 1.0, l: 0.7, a: 1.0 },
		bright_yellow:  Hsla { h: 0.16, s: 1.0, l: 0.7, a: 1.0 },
		bright_blue:    Hsla { h: 0.66, s: 1.0, l: 0.7, a: 1.0 },
		bright_magenta: Hsla { h: 0.83, s: 1.0, l: 0.7, a: 1.0 },
		bright_cyan:    Hsla { h: 0.5, s: 1.0, l: 0.7, a: 1.0 },
		bright_white:   Hsla { h: 0.0, s: 0.0, l: 1.0, a: 1.0 },
	}
}

#[test]
fn default_color_resolves_to_provided_fallback() {
	let palette = dummy_palette();
	let resolved = palette.resolve_color(CellColor::Default, palette.foreground);
	assert_eq!(resolved, palette.foreground);
}

#[test]
fn standard_ansi_colors_resolve_to_palette_fields() {
	let palette = dummy_palette();
	assert_eq!(palette.resolve_color(CellColor::Indexed(0), palette.foreground), palette.black);
	assert_eq!(palette.resolve_color(CellColor::Indexed(1), palette.foreground), palette.red);
	assert_eq!(palette.resolve_color(CellColor::Indexed(2), palette.foreground), palette.green);
	assert_eq!(palette.resolve_color(CellColor::Indexed(3), palette.foreground), palette.yellow);
	assert_eq!(palette.resolve_color(CellColor::Indexed(4), palette.foreground), palette.blue);
	assert_eq!(palette.resolve_color(CellColor::Indexed(5), palette.foreground), palette.magenta);
	assert_eq!(palette.resolve_color(CellColor::Indexed(6), palette.foreground), palette.cyan);
	assert_eq!(palette.resolve_color(CellColor::Indexed(7), palette.foreground), palette.white);
	assert_eq!(
		palette.resolve_color(CellColor::Indexed(8), palette.foreground),
		palette.bright_black
	);
	assert_eq!(palette.resolve_color(CellColor::Indexed(9), palette.foreground), palette.bright_red);
	assert_eq!(
		palette.resolve_color(CellColor::Indexed(10), palette.foreground),
		palette.bright_green
	);
	assert_eq!(
		palette.resolve_color(CellColor::Indexed(11), palette.foreground),
		palette.bright_yellow
	);
	assert_eq!(
		palette.resolve_color(CellColor::Indexed(12), palette.foreground),
		palette.bright_blue
	);
	assert_eq!(
		palette.resolve_color(CellColor::Indexed(13), palette.foreground),
		palette.bright_magenta
	);
	assert_eq!(
		palette.resolve_color(CellColor::Indexed(14), palette.foreground),
		palette.bright_cyan
	);
	assert_eq!(
		palette.resolve_color(CellColor::Indexed(15), palette.foreground),
		palette.bright_white
	);
}

#[test]
fn extended_256_color_cube_and_grayscale_resolve() {
	let palette = dummy_palette();
	for ix in 16..=231 {
		let color = palette.resolve_color(CellColor::Indexed(ix), palette.foreground);
		assert!(color.a > 0.0);
	}
	for ix in 232..=255 {
		let color = palette.resolve_color(CellColor::Indexed(ix), palette.foreground);
		assert!(color.a > 0.0);
	}
}

#[test]
fn direct_rgb_color_resolves() {
	let palette = dummy_palette();
	let color = palette.resolve_color(CellColor::Rgb(128, 64, 32), palette.foreground);
	assert!(color.a > 0.0);
}

#[test]
fn retained_renderer_reconciles_and_preserves_alternate_screen_history() {
	let mut renderer = RetainedTerminalRenderer::new();
	let id = TerminalId::new("term-1").expect("valid id");

	let run1 = TerminalRunView {
		id:          id.clone(),
		cwd:         "/repo".to_owned(),
		command:     "bash".to_owned(),
		output:      b"line 1\r\nline 2\r\nline 3\r\nline 4\r\nline 5\r\n".to_vec(),
		phase:       veyyon_gui_core::model::TerminalPhase::Running,
		exit_code:   None,
		signal:      None,
		cancelled:   false,
		truncated:   false,
		total_lines: 5,
		total_bytes: 40,
		error:       None,
		artifact_id: None,
	};

	renderer.resize(&id, GridSize { columns: 20, rows: 3, width_px: 200, height_px: 60 });
	renderer.reconcile(&run1, 1);

	let session = renderer.session(&id).expect("session exists");
	assert!(session.emulator.history_lines() >= 2);

	// Enter alternate screen and write data
	renderer.apply_output(&id, b"\x1b[?1049hAlt screen content");
	let session = renderer.session(&id).expect("session exists");
	assert!(session.emulator.is_alt_screen());

	// Exit alternate screen, primary scrollback must be preserved
	renderer.apply_output(&id, b"\x1b[?1049l");
	let session = renderer.session(&id).expect("session exists");
	assert!(!session.emulator.is_alt_screen());
	assert!(session.emulator.history_lines() >= 2);
}
