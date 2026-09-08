//! WHY THIS SUITE EXISTS: a §6.6 row caps four columns, and a verdict that
//! reads three of them lets the fourth drift with nothing to stop it. The
//! interactive column was that fourth: `ceilings.toml` capped the whole window
//! at 105 controls and no code read the number.
//!
//! THE CLASS THIS CLOSES: a column of the §6.6 table that reaches no verdict,
//! and a ceiling read from a second copy of the table rather than from the
//! token file. Every case below takes its numbers from the loaded
//! `CeilingTokens`, so a retuned ceiling moves the test with the product
//! instead of failing it.
//!
//! WHAT IT DOES NOT CATCH: whether the numbers are the right ones, and whether
//! a rendered surface stays under them. The width-and-appearance gate in
//! `crates/veyyon-desktop/tests` owns that.

use veyyon_desktop_scene::metrics::{
	ClutterMetrics, Measured, MetricReport, SurfaceClass, check, density_ceiling,
};
use veyyon_desktop_tokens::{CeilingTokens, Tokens, load_bundled_tokens};

fn tokens() -> Tokens {
	load_bundled_tokens().expect("the bundled token set loads")
}

/// A measurement sitting exactly on every ceiling `surface` authors.
fn at_the_ceiling(surface: SurfaceClass, ceilings: &CeilingTokens) -> Measured {
	let authored = surface.of(ceilings);
	Measured {
		metrics:     ClutterMetrics {
			distinct_gaps:       authored.distinct_gaps,
			distinct_text_sizes: authored.text_sizes,
			edge_count:          authored.edges as f32,
			ink_ratio:           0.85,
			element_density:     density_ceiling(ceilings),
			alignment_residue:   0.45,
		},
		interactive: authored.interactive_elements,
	}
}

/// One step over a column, applied to a measurement that sits on its ceiling.
type PushOver = fn(&mut Measured);

#[test]
fn every_surface_class_passes_when_it_sits_exactly_on_its_own_ceilings() {
	let tokens = tokens();
	for surface in SurfaceClass::ALL {
		let verdict = check(&at_the_ceiling(surface, &tokens.ceilings), surface, &tokens.ceilings);
		assert!(
			verdict.passed(),
			"{} must pass at its authored ceilings, got {verdict}",
			surface.name()
		);
	}
}

#[test]
fn every_capped_column_breaches_one_step_above_its_ceiling() {
	let tokens = tokens();
	let ceilings = &tokens.ceilings;
	let surface = SurfaceClass::QueueRowCard;

	let over: [(&str, PushOver); 5] = [
		("distinct_gaps", |m| m.metrics.distinct_gaps += 1),
		("distinct_text_sizes", |m| m.metrics.distinct_text_sizes += 1),
		("edge_count", |m| m.metrics.edge_count += 0.1),
		("interactive_elements", |m| m.interactive += 1),
		("element_density", |m| m.metrics.element_density += 0.1),
	];

	for (metric, push_over) in over {
		let mut measured = at_the_ceiling(surface, ceilings);
		push_over(&mut measured);
		let verdict = check(&measured, surface, ceilings);
		assert!(!verdict.passed(), "{metric} one step over its ceiling must breach");
		let breached: Vec<&str> = verdict.breaches().iter().map(|b| b.metric).collect();
		assert_eq!(breached, vec![metric], "only {metric} may be reported");
	}
}

#[test]
fn the_two_diagnostic_metrics_never_breach_at_their_extremes() {
	let tokens = tokens();
	let mut measured = at_the_ceiling(SurfaceClass::BlockChrome, &tokens.ceilings);
	measured.metrics.ink_ratio = 1.0;
	measured.metrics.alignment_residue = 1.0;

	let verdict = check(&measured, SurfaceClass::BlockChrome, &tokens.ceilings);
	assert!(verdict.passed(), "ink and alignment are reported, not capped: {verdict}");
}

#[test]
fn a_breach_names_the_surface_the_metric_and_both_numbers() {
	let tokens = tokens();
	let surface = SurfaceClass::WholeWindow;
	let mut measured = at_the_ceiling(surface, &tokens.ceilings);
	measured.interactive += 7;

	let report = MetricReport::new(measured, surface, &tokens.ceilings);
	let breach = report
		.verdict
		.breaches()
		.first()
		.expect("an over-count reports a breach");
	assert_eq!(breach.metric, "interactive_elements");
	assert_eq!(breach.ceiling, tokens.ceilings.whole_window.interactive_elements as f64);
	assert_eq!(breach.actual, breach.ceiling + 7.0);

	let stated = format!("{}", report.verdict);
	assert!(stated.contains("whole window"), "the verdict names the surface: {stated}");
	assert!(stated.contains("interactive_elements"), "and the column: {stated}");

	let line = format!("{report}");
	assert!(line.contains("[FAIL]"), "the report states the verdict: {line}");
	assert!(
		line.contains(&format!("controls: {}", measured.interactive)),
		"and the count it measured: {line}"
	);
}

#[test]
fn the_density_ceiling_is_the_authored_rate_over_the_authored_box() {
	let tokens = tokens();
	let region = tokens.ceilings.density_region;
	let expected = region.max_interactive_per_1000px2 * region.sample_box_px.powi(2) / 1000.0;
	assert!(
		(density_ceiling(&tokens.ceilings) - expected).abs() < f32::EPSILON,
		"the ceiling is derived from both authored values, not restated"
	);
}
