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
//! A breach names its cell (width × appearance) and the MetricReport's own
//! accounting, so the surface that overspent is found from the failure alone.

use std::path::{Path, PathBuf};

use veyyon_desktop_kit::{ColorRole, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	RgbaColor,
	headless::{RenderOptions, headless_context, render_view_captured},
	metrics::{
		Ceilings, DENSEST_REGION_CEILING, SurfaceClass, ceilings, cluster_text_sizes,
		compute_edge_count, element_density_of_centers, gap_spans,
	},
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
		let ground_rgb = theme
			.role(Path::new("bundled"), ColorRole::Ground)
			.expect("the theme declares a ground");
		let ground = RgbaColor::opaque(
			(ground_rgb.r * 255.0).round() as u8,
			(ground_rgb.g * 255.0).round() as u8,
			(ground_rgb.b * 255.0).round() as u8,
		);

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

			// Each channel from the source that carries it on the quad path:
			// edges and ink from the frame, gaps from the recovered tree, text
			// sizes from the shaped runs (the tree's text leaves exist only on
			// the primitive-scene path), interactive from the registered hit
			// rects, the set a click can reach.
			let cell = format!("{width}x{HEIGHT} {appearance}");
			let ceiling: Ceilings = ceilings(SurfaceClass::WholeWindow);

			let edges = compute_edge_count(&captured.layout, &captured.frame);
			if edges > ceiling.edges {
				failures
					.push(format!("{cell}: {edges:.1} edges over the {:.0} ceiling", ceiling.edges));
			}

			let text_boxes: Vec<veyyon_desktop_scene::BoxBounds> = captured
				.text_runs
				.iter()
				.map(|run| {
					let left = f32::from(run.bounds.origin.x);
					let top = f32::from(run.bounds.origin.y);
					veyyon_desktop_scene::BoxBounds::new(
						left,
						top,
						left + f32::from(run.bounds.size.width),
						top + f32::from(run.bounds.size.height),
					)
				})
				.collect();
			let mut spans = gap_spans(&captured.layout, &text_boxes);
			// §6.6 caps the rhythm VOCABULARY. Two filters keep the count on
			// rhythm and off geometry:
			//
			// - A span past the largest step `scale.toml` authors (s13 = 64) is a layout
			//   remainder — the canvas under a short transcript, the rail below its last
			//   row — because §9.3 makes a bigger AUTHORED gap impossible. Counting one
			//   would fail a window for being taller than its content.
			// - A value backed by exactly one span is a placement accident — the slack
			//   `justify_between` or `justify_end` distributes, the margin a centred column
			//   leaves — whose size comes from the window, not from a spacing decision. A
			//   rhythm step is reused.
			//
			// What this does not catch: an off-scale gap authored once, in one
			// place; the scale lint owns that, not this gate.
			spans.retain(|gap, rects| *gap <= 64 && rects.len() >= 2);
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

			let mut sizes: Vec<f32> = captured
				.text_runs
				.iter()
				.map(|run| f32::from(run.font_size))
				.collect();
			sizes.sort_by(f32::total_cmp);
			let text_sizes = cluster_text_sizes(&sizes);
			if text_sizes > ceiling.text_sizes {
				let mut distinct = sizes.clone();
				distinct.dedup_by(|a, b| (*a - *b).abs() <= 0.1);
				failures.push(format!(
					"{cell}: {text_sizes} text sizes over the {} ceiling: {distinct:?}",
					ceiling.text_sizes
				));
			}

			let interactive = captured.hitboxes.len();
			if interactive > INTERACTIVE_CEILING {
				failures.push(format!(
					"{cell}: {interactive} interactive elements over the {INTERACTIVE_CEILING} ceiling"
				));
			}

			let centers: Vec<(f32, f32)> = captured
				.hitboxes
				.iter()
				.map(|rect| {
					(
						f32::from(rect.origin.x) + f32::from(rect.size.width) / 2.0,
						f32::from(rect.origin.y) + f32::from(rect.size.height) / 2.0,
					)
				})
				.collect();
			let density = element_density_of_centers(&centers, width, HEIGHT);
			if density > DENSEST_REGION_CEILING {
				failures.push(format!(
					"{cell}: densest region {density:.1} over the {DENSEST_REGION_CEILING} ceiling"
				));
			}

			// The judgement half of the pass: a person reads the frames, and no
			// assertion substitutes for that. Written only when asked, to a
			// directory outside the tree (a proof frame is never committed).
			if let Ok(dir) = std::env::var("VEYYON_CONVERGENCE_FRAMES") {
				let dir = PathBuf::from(dir);
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
