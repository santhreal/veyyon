//! WHY: §6.6 gives the whole window four ceilings, and M7 makes them a gate:
//! the populated window is measured at every breakpoint width in both
//! appearances, and a surface that crept past its allowance fails here rather
//! than in a review months later, when the clutter has spread to every
//! neighbour.
//!
//! The widths are the four `breakpoints.toml` tiers, read from the token file
//! rather than restated, so a retuned tier moves the gate with it. The
//! ceilings come from `ceilings.toml` through `metrics::check` for the same
//! reason: a number restated here would pass while the app loaded the other
//! copy. The metrics are computed from the rendered frame and its layout tree
//! by the scene crate's six-metric suite; the interactive count is the frame's
//! registered hit rects, the set a click can reach.
//!
//! A breach names its cell (width × appearance), the column and both numbers,
//! so the surface that overspent is found from the failure alone.

use std::path::{Path, PathBuf};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context, render_view_captured},
	measure::{measure, rhythm_spans, text_sizes, theme_ground},
	metrics::{SurfaceClass, check},
	write_png,
};
use veyyon_desktop_surface::{ShellView, fixture, install_tokens};
use veyyon_gpui::{App, AppContext};

const HEIGHT: u32 = 900;
const APPEARANCES: [&str; 2] = ["dark", "light"];

#[test]
fn the_window_holds_its_ink_ceilings_at_every_width_in_both_appearances() {
	let mut failures = Vec::new();

	for appearance in APPEARANCES {
		let mut cx = headless_context().expect("a headless renderer is required to render the shell");
		let tokens = load_bundled_tokens().expect("the bundled tokens load");
		let theme = load_bundled_theme(appearance).expect("the bundled theme loads");
		let ground =
			theme_ground(&theme, Path::new("surface")).expect("the bundled theme states a ground");
		let breakpoints = &tokens.surface.breakpoints;
		let widths = [
			breakpoints.wide.min_width_px,
			breakpoints.standard.min_width_px,
			breakpoints.compact.min_width_px,
			breakpoints.collapsed.min_width_px,
		];
		for width in widths {
			let width = width.round() as u32;
			let options =
				RenderOptions { width, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
			let state = fixture::populated();
			let tokens_for_render = tokens.clone();
			let theme = theme.clone();
			let captured = render_view_captured(&mut cx, &options, move |_window, app: &mut App| {
				let installed = install_tokens(app, &tokens_for_render, &theme, Path::new("surface"))
					.expect("the bundled tokens and theme install");
				app.new(|_| ShellView::new(installed, state))
			})
			.expect("the shell renders offscreen");

			// Each channel from the source that carries it: edges and ink from
			// the frame, gaps from the recovered tree with the shaped runs
			// suppressing the spans that cross prose, text sizes from those
			// runs, interactive from the registered hit rects. `measure` owns
			// that derivation and `check` owns the ceilings; this gate owns
			// only the cell and the diagnosis.
			let cell = format!("{width}x{HEIGHT} {appearance}");
			let measured = measure(&captured, ground);
			let verdict = check(&measured, SurfaceClass::WholeWindow, &tokens.ceilings);

			for breach in verdict.breaches() {
				let detail = match breach.metric {
					"distinct_gaps" => {
						let spans = rhythm_spans(&captured);
						format!(": {:?}", spans.keys().collect::<Vec<_>>())
					},
					"distinct_text_sizes" => {
						let mut distinct = text_sizes(&captured);
						distinct.dedup_by(|a, b| (*a - *b).abs() <= 0.1);
						format!(": {distinct:?}")
					},
					_ => String::new(),
				};
				failures.push(format!(
					"{cell}: {} measured {} over the {} ceiling{detail}",
					breach.metric, breach.actual, breach.ceiling
				));
			}

			if std::env::var_os("VEYYON_CONVERGENCE_PROBE").is_some() {
				for (gap, rects) in &rhythm_spans(&captured) {
					println!("{cell} gap {gap}px ×{}: {rects:?}", rects.len());
				}
			}

			// The judgement half of the pass: a person reads the frames, and no
			// assertion substitutes for that. Written only when asked, to a
			// directory outside the tree (a proof frame is never committed).
			if let Ok(dir) = std::env::var("VEYYON_CONVERGENCE_FRAMES") {
				// `cargo test` runs with the package root as the working
				// directory, so a relative path is anchored at the workspace
				// root: the frames are judged beside the plan, not beside the
				// crate.
				let dir = PathBuf::from(dir);
				let dir = if dir.is_absolute() {
					dir
				} else {
					Path::new(env!("CARGO_MANIFEST_DIR"))
						.join("../..")
						.join(dir)
				};
				std::fs::create_dir_all(&dir).expect("the frame directory is creatable");
				write_png(
					&captured.frame,
					&dir.join(format!("window-{width}x{HEIGHT}-{appearance}.png")),
				)
				.expect("the frame writes as a PNG");
			}
		}
	}

	assert!(failures.is_empty(), "the window overspent its §6.6 ceilings:\n{}", failures.join("\n"));
}
