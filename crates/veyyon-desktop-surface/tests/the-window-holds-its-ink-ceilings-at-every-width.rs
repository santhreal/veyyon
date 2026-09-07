//! WHY: §6.6 gives the whole window four ceilings — 16 edges, 8 distinct gaps,
//! 6 text sizes, 105 interactive elements — and M7 makes them a gate: the
//! populated window is measured at every breakpoint width in both appearances,
//! and a surface that crept past its allowance fails here rather than in a
//! review months later, when the clutter has spread to every neighbour.
//!
//! The widths are the four `breakpoints.toml` tiers (1440, 1180, 980, 800), so
//! a shed decision that adds a control, a gap or a text size at one tier is
//! measured at that tier. The metrics are computed from the rendered frame and
//! its layout tree by the scene crate's six-metric suite; the interactive
//! count is the frame's registered hit rects, the set a click can reach.
//!
//! A breach names its cell (width × appearance) and the `MetricReport`'s own
//! accounting, so the surface that overspent is found from the failure alone.

use std::path::{Path, PathBuf};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context, render_view_captured},
	measure::{measure, rhythm_spans, text_sizes, theme_ground},
	metrics::{Ceilings, DENSEST_REGION_CEILING, SurfaceClass, ceilings},
	write_png,
};
use veyyon_desktop_surface::{ShellView, fixture, install_tokens};
use veyyon_gpui::{App, AppContext};

/// The four breakpoint tiers, wide to collapsed.
const WIDTHS: [u32; 4] = [1440, 1180, 980, 800];
const HEIGHT: u32 = 900;
const APPEARANCES: [&str; 2] = ["dark", "light"];

/// §6.6's whole-window interactive ceiling: the most hit rects one frame may
/// register and still be aimable.
const INTERACTIVE_CEILING: usize = 105;

#[test]
fn the_window_holds_its_ink_ceilings_at_every_width_in_both_appearances() {
	let mut failures = Vec::new();

	for appearance in APPEARANCES {
		let mut cx = headless_context().expect("a headless renderer is required to render the shell");
		let tokens = load_bundled_tokens().expect("the bundled tokens load");
		let theme = load_bundled_theme(appearance).expect("the bundled theme loads");
		let ground = theme_ground(&theme, Path::new("surface"))
			.expect("the bundled theme states a ground");
		for width in WIDTHS {
			let options =
				RenderOptions { width, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
			let state = fixture::populated();
			let tokens = tokens.clone();
			let theme = theme.clone();
			let captured = render_view_captured(&mut cx, &options, move |_window, app: &mut App| {
				let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
					.expect("the bundled tokens and theme install");
				app.new(|_| ShellView::new(installed, state))
			})
			.expect("the shell renders offscreen");

			// Each channel from the source that carries it: edges and ink from
			// the frame, gaps from the recovered tree with the shaped runs
			// suppressing the spans that cross prose, text sizes from those
			// runs, interactive from the registered hit rects. `measure` owns
			// that derivation; this gate owns the ceilings.
			let cell = format!("{width}x{HEIGHT} {appearance}");
			let ceiling: Ceilings = ceilings(SurfaceClass::WholeWindow);
			let measured = measure(&captured, ground);

			let edges = measured.metrics.edge_count;
			if edges > ceiling.edges {
				failures
					.push(format!("{cell}: {edges:.1} edges over the {:.0} ceiling", ceiling.edges));
			}

			let spans = rhythm_spans(&captured);
			if spans.len() > ceiling.distinct_gaps {
				failures.push(format!(
					"{cell}: {} distinct gaps over the {} ceiling: {:?}",
					spans.len(),
					ceiling.distinct_gaps,
					spans.keys().collect::<Vec<_>>()
				));
			}
			if std::env::var_os("VEYYON_CONVERGENCE_PROBE").is_some() {
				for (gap, rects) in &spans {
					println!("{cell} gap {gap}px ×{}: {rects:?}", rects.len());
				}
			}

			let text_sizes_seen = measured.metrics.distinct_text_sizes;
			if text_sizes_seen > ceiling.text_sizes {
				let mut distinct = text_sizes(&captured);
				distinct.dedup_by(|a, b| (*a - *b).abs() <= 0.1);
				failures.push(format!(
					"{cell}: {text_sizes_seen} text sizes over the {} ceiling: {distinct:?}",
					ceiling.text_sizes
				));
			}

			let interactive = measured.interactive;
			if interactive > INTERACTIVE_CEILING {
				failures.push(format!(
					"{cell}: {interactive} interactive elements over the {INTERACTIVE_CEILING} ceiling"
				));
			}

			let density = measured.metrics.element_density;
			if density > DENSEST_REGION_CEILING {
				failures.push(format!(
					"{cell}: densest region {density:.1} over the {DENSEST_REGION_CEILING} ceiling"
				));
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
