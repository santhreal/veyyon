//! WHY: §6.6 caps eight surface classes and the whole window is one of them.
//! The other seven are the tighter half of the table and the half where
//! clutter is decided, because a window reads as dense when forty surfaces
//! each carry one extra edge rather than because its total is high. Only the
//! whole-window row reached a gate: the queue row, the transcript turn, the
//! block chrome, the composer, the right panel and the terminal drawer were
//! capped in `ceilings.toml` and measured nowhere, so a row that grew a third
//! text size passed as long as the window's own six-size budget had slack.
//!
//! CLASS CLOSED: a §6.6 row that reaches no verdict. The sweep enumerates
//! `SurfaceClass::ALL` at run time, so a class added to the table fails to
//! compile until it states which recorded box carries it, and a class whose
//! box the frame never drew fails as an unmeasured hole rather than passing on
//! an empty set. The one absence the sweep accepts is the one §5.7 causes:
//! where the frame recorded no rail, the row classes have nothing to measure,
//! and the sweep then requires them to be absent rather than merely allowing
//! it. Both appearances and all four breakpoint widths are measured, because a
//! shed decision moves controls between tiers and an appearance changes what
//! counts as an edge. Each class is measured in the one state where nothing
//! floats over it, and over the boxes the measured frame itself laid out.
//!
//! NOT CAUGHT: whether the authored numbers are the right ones, which M7
//! retunes; the ink and alignment metrics, which §6.6 reports rather than
//! caps; and any surface with no recorded box of its own — the titlebar, the
//! run bar and the card stack are not §6.6 rows and are measured only inside
//! the window's own total.

#[path = "support/surface-ceilings/mod.rs"]
mod surface_ceilings;

use std::path::Path;

use surface_ceilings::{
	APPEARANCES, HEIGHT, Pass, blocks_of, breaches_of, measured_frame, on_screen, open_shell,
	pass_of, rides_the_rail, scope_of, tier_widths,
};
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::headless_context, logical_box, measure::theme_ground, metrics::SurfaceClass,
	region::within_excluding,
};
use veyyon_desktop_surface::damage::Region;
use veyyon_gpui::{Bounds, Pixels};

#[test]
fn every_surface_holds_the_ink_ceiling_its_own_row_authors() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let mut failures = Vec::new();
	let mut unmeasured = Vec::new();

	for appearance in APPEARANCES {
		let theme = load_bundled_theme(appearance).expect("the bundled theme loads");
		let ground =
			theme_ground(&theme, Path::new("surface")).expect("the bundled theme states a ground");
		for width in tier_widths() {
			for pass in Pass::ALL {
				let mut cx = headless_context().expect("a headless renderer is required");
				let mut session = open_shell(&mut cx, width, appearance, pass);
				let (mut captured, mut recorded) = measured_frame(&mut session);
				// The rail is the one surface a width sheds, and the frame
				// states whether it drew one: it records its own box only
				// where §5.7 keeps it.
				let rail_drawn = recorded.contains(&Region::Queue);
				let cell = format!("{width}x{HEIGHT} {appearance} {pass:?}");

				for class in SurfaceClass::ALL {
					if pass_of(class) != pass {
						continue;
					}
					let Some(regions) = scope_of(class, &recorded) else {
						failures.extend(breaches_of(
							&captured,
							ground,
							class,
							&tokens.ceilings,
							&cell,
							"window",
						));
						continue;
					};
					let expected = rail_drawn || !rides_the_rail(class);
					if regions.is_empty() {
						if expected {
							unmeasured.push(format!("{cell}: {} drew no box to measure", class.name()));
						}
						continue;
					}
					if !expected {
						failures.push(format!(
							"{cell}: {} drew {} boxes where the rail is shed",
							class.name(),
							regions.len()
						));
						continue;
					}
					let region_count = regions.len();
					let mut on_frame = 0usize;
					for region in regions {
						// A box the frame laid out beyond its own edges draws
						// nothing to charge, and the pointer cannot be put on
						// it either.
						let aim = session
							.update(|view, _window, _cx| view.laid_out().drawn_bounds(region))
							.expect("the view is live");
						let Some(aim) = aim else {
							unmeasured.push(format!("{cell}: {region:?} recorded no box"));
							continue;
						};
						if !on_screen(aim, &captured) {
							continue;
						}
						on_frame += 1;
						// The pointer goes on the box before the frame that
						// judges it, so a surface whose actions §5.3 reveals
						// under the pointer is read where they are drawn.
						if pass.is_per_box() {
							session.hover(aim.center()).expect("the pointer moves");
							let (hovered, laid_now) = measured_frame(&mut session);
							captured = hovered;
							recorded = laid_now;
						}
						let laid: Option<(Bounds<Pixels>, Vec<Bounds<Pixels>>)> = session
							.update(|view, _window, _cx| {
								let boxes = view.laid_out();
								boxes.drawn_bounds(region).map(|bounds| {
									let nested = match region {
										Region::Turn(turn) => blocks_of(turn, &recorded, boxes),
										_ => Vec::new(),
									};
									(bounds, nested)
								})
							})
							.expect("the view is live");
						let Some((bounds, nested)) = laid else {
							unmeasured.push(format!("{cell}: {region:?} recorded no box"));
							continue;
						};
						if std::env::var_os("VEYYON_SURFACE_SPEND").is_some() {
							let held = logical_box(bounds);
							let (mut inside, mut crossing) = (0, 0);
							for run in &captured.text_runs {
								let run = logical_box(run.bounds);
								if run.left >= held.left - 1.0
									&& run.right <= held.right + 1.0
									&& run.top >= held.top - 1.0
									&& run.bottom <= held.bottom + 1.0
								{
									inside += 1;
								} else if run.overlap_x(&held) > 0.0 && run.overlap_y(&held) > 0.0 {
									crossing += 1;
								}
							}
							println!(
								"      {region:?} box {held:?}: {inside} runs inside, {crossing} crossing"
							);
						}
						match within_excluding(&captured, bounds, &nested, ground) {
							Ok(part) => failures.extend(breaches_of(
								&part,
								ground,
								class,
								&tokens.ceilings,
								&cell,
								&format!("{region:?}"),
							)),
							Err(error) => unmeasured
								.push(format!("{cell}: {region:?} could not be measured: {error}")),
						}
					}
					if on_frame == 0 {
						unmeasured.push(format!(
							"{cell}: {} laid out {} boxes and drew none on screen",
							class.name(),
							region_count
						));
					}
				}
			}
		}
	}

	assert_eq!(unmeasured, Vec::<String>::new(), "a §6.6 row reached no measurement");
	assert!(
		failures.is_empty(),
		"a surface overspent the ceiling its own §6.6 row authors:\n{}",
		failures.join("\n")
	);
}
