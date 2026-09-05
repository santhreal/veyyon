//! WHY: the operator bubble's right-aligned ground was laid out past the
//! session column's leading edge and clipped mid-word at 1180px. The width
//! suite (`a-narrow-window-never-sheds-the-surface-being-read.rs`) proves the
//! column's measure; it cannot see a child painted outside that measure.
//!
//! CLASS CLOSED: a transcript child whose painted bounds leave the session
//! column at a width where the shed squeezes the column below the
//! transcript's token measure. The squeezed widths are found by sweeping
//! `shell_widths`, so a breakpoint edit that moves the squeeze is covered
//! without touching this file.
//!
//! NOT CAUGHT: every other region's paint. Only the bubble's quad is read.

mod support;

use std::{collections::BTreeSet, path::Path};

use support::shed::{SWEPT_HEIGHT, shed, swept_widths};
use veyyon_desktop_kit::{TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	RgbaColor,
	headless::{RenderOptions, headless_context, render_view_captured},
};
use veyyon_desktop_surface::{
	ShellView, fixture, install_tokens,
	layout::{RightPanelPlacement, shell_widths},
	model::role_named,
};
use veyyon_gpui::{App, AppContext};

#[test]
fn the_operator_bubble_stays_inside_the_session_column_when_the_shed_narrows_it() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let set = TokenSet::from_tokens(&tokens, &theme).expect("the bundled token set resolves");
	let ground = role_named(&tokens.surface.transcript.user_turn_ground)
		.expect("the user turn ground names a colour role");
	let rgba = set.color(ground).to_rgb();
	let bubble_fill = RgbaColor {
		r: (rgba.r * 255.0).round().clamp(0.0, 255.0) as u8,
		g: (rgba.g * 255.0).round().clamp(0.0, 255.0) as u8,
		b: (rgba.b * 255.0).round().clamp(0.0, 255.0) as u8,
		a: (rgba.a * 255.0).round().clamp(0.0, 255.0) as u8,
	};

	let measure = tokens.surface.transcript.column_width_px;

	// The shed squeezes the session column below the transcript's token
	// measure wherever the panel stays inline into a narrow window. Prove the
	// bubble at the tightest, a middle and the widest squeezed width rather
	// than at one hand-picked row, so a breakpoint edit that moves the squeeze
	// is covered without touching this file.
	let squeezed: Vec<f32> = swept_widths()
		.into_iter()
		.filter(|width| {
			let widths = shell_widths(shed(*width, true), &tokens.surface);
			widths.queue_px.is_some()
				&& matches!(widths.right_panel, RightPanelPlacement::Inline { .. })
				&& widths.composer_px < measure
		})
		.collect();
	assert!(
		!squeezed.is_empty(),
		"no swept width squeezes the transcript below its measure, so this proves nothing"
	);
	let chosen: Vec<f32> = {
		let last = squeezed.len() - 1;
		BTreeSet::from([0, last / 2, last])
			.into_iter()
			.map(|index| squeezed[index])
			.collect()
	};
	if std::env::var_os("VEYYON_SHED_PROBE").is_some() {
		eprintln!(
			"measure {measure}, squeezed {}..={} ({} widths), chosen {chosen:?}",
			squeezed[0],
			squeezed[squeezed.len() - 1],
			squeezed.len()
		);
	}

	for width in chosen {
		let widths = shell_widths(shed(width, true), &tokens.surface);
		let session_left = widths.queue_px.unwrap_or(0.0);
		let session_right = session_left + widths.session_px;

		let mut cx = headless_context().expect("a headless renderer is required to render the shell");
		let captured = render_view_captured(
			&mut cx,
			&RenderOptions {
				width: width as u32,
				height: SWEPT_HEIGHT as u32,
				scale_factor: 1.0,
				..RenderOptions::default()
			},
			{
				let tokens = &tokens;
				let theme = &theme;
				move |_window, app: &mut App| {
					let installed = install_tokens(app, tokens, theme, Path::new("surface"))
						.expect("the bundled tokens and theme install");
					app.new(|_| ShellView::new(installed, fixture::populated()))
				}
			},
		)
		.expect("the shell renders offscreen");

		// The painted quad carries the bubble's full bounds even where the
		// content mask clips its raster, so the tree sees the overflow the
		// frame hides. A candidate must reach into the session column: the
		// rail and the panel may share the ground's colour and are not the
		// bubble.
		let bubbles: Vec<_> = captured
			.layout
			.iter()
			.filter(|b| {
				b.fill == Some(bubble_fill)
					&& b.bounds.right > session_left
					&& b.bounds.left < session_right
			})
			.collect();
		assert!(
			!bubbles.is_empty(),
			"at {width}px the operator bubble painted nothing in the session column, so this proves \
			 nothing"
		);
		for bubble in bubbles {
			if std::env::var_os("VEYYON_SHED_PROBE").is_some() {
				eprintln!(
					"width {width}: bubble {:?} vs session {session_left}..{session_right}",
					bubble.bounds
				);
			}
			assert!(
				bubble.bounds.left >= session_left - 0.5 && bubble.bounds.right <= session_right + 0.5,
				"at {width}px the operator bubble laid out at {:?}, outside the session column \
				 {session_left}..{session_right}, so its leading edge is clipped out of the surface \
				 being read",
				bubble.bounds
			);
		}
	}
}
