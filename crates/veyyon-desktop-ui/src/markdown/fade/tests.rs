//! A streamed document draws each piece of text at the opacity of the stop
//! that covers it: text before the first stop is opaque, a stop starts a
//! piece on a character boundary, and only text below full opacity changes.

use veyyon_gpui::{TextRun, hsla};

use super::{FadeStop, fade_highlights, fade_runs, fades};

fn run(len: usize) -> TextRun {
	TextRun { len, color: hsla(0.0, 0.0, 1.0, 1.0), ..TextRun::default() }
}

const fn stop(start: usize, opacity: f32) -> FadeStop {
	FadeStop { start, opacity }
}

/// Each run's length and alpha.
fn drawn(runs: &[TextRun]) -> Vec<(usize, f32)> {
	runs.iter().map(|run| (run.len, run.color.a)).collect()
}

#[test]
fn a_run_splits_where_a_stop_starts_and_each_piece_takes_its_stops_opacity() {
	let runs = fade_runs(vec![run(11)], "Hello world", 10, &[stop(10, 0.8), stop(15, 0.4)]);
	assert_eq!(drawn(&runs), [(5, 0.8), (6, 0.4)]);
}

#[test]
fn text_before_the_first_stop_is_drawn_opaque() {
	let runs = fade_runs(vec![run(5), run(6)], "Hello world", 0, &[stop(8, 0.4)]);
	assert_eq!(drawn(&runs), [(5, 1.0), (3, 1.0), (3, 0.4)]);
}

#[test]
fn a_stop_inside_a_character_starts_after_it() {
	// `é` is two bytes, so offset 2 falls inside it.
	let runs = fade_runs(vec![run(5)], "aé b", 0, &[stop(2, 0.4)]);
	assert_eq!(drawn(&runs), [(3, 1.0), (2, 0.4)]);
}

#[test]
fn only_code_below_full_opacity_is_highlighted() {
	let faded: Vec<_> = fade_highlights("let x = 1;", 20, &[stop(20, 1.0), stop(24, 0.5)])
		.map(|(range, style)| (range, style.fade_out))
		.collect();
	assert_eq!(faded, [(4..10, Some(0.5))]);
}

#[test]
fn text_fades_only_under_a_stop_below_full_opacity_that_starts_before_its_end() {
	assert!(fades(&[stop(9, 0.4)], 0, 10), "a stop inside the text");
	assert!(fades(&[stop(0, 0.4)], 5, 10), "a stop before the text");
	assert!(!fades(&[stop(10, 0.4)], 0, 10), "a stop past the text");
	assert!(!fades(&[stop(0, 1.0)], 0, 10), "an opaque stop");
	assert!(!fades(&[], 0, 10), "no stop");
}
