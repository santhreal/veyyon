//! One of every [`ViewKind`], for drawing a tool result without a tool.
//!
//! The sweep in this module's tests is what makes the vocabulary real: a kind
//! with no fixture has never been drawn, and since the TypeScript side is React
//! components rather than a data model, this sweep is the only check the view
//! layer has.

use crate::view::{
	Agent, Badge, Choice, Code, Diff, DiffFile, DiffHunk, DiffLine, Fields, Files, Image, Invalid,
	Markdown, Note, Output, Pair, PathEntry, Progress, Question, Table, TableRow, Tone, View,
	ViewKind,
};

/// A part of every kind, in [`ViewKind::ALL`] order.
pub fn views() -> Vec<View> {
	ViewKind::ALL.into_iter().map(view).collect()
}

/// One part of the kind `kind` names.
pub fn view(kind: ViewKind) -> View {
	match kind {
		ViewKind::Fields => View::Fields(fields()),
		ViewKind::Output => View::Output(output()),
		ViewKind::Code => View::Code(code()),
		ViewKind::Markdown => View::Markdown(markdown()),
		ViewKind::Note => View::Note(note()),
		ViewKind::Table => View::Table(table()),
		ViewKind::Files => View::Files(files()),
		ViewKind::Image => View::Image(image()),
		ViewKind::Diff => View::Diff(diff()),
		ViewKind::Progress => View::Progress(progress()),
		ViewKind::Question => View::Question(question()),
		ViewKind::Agent => View::Agent(agent()),
		ViewKind::Invalid => View::Invalid(invalid()),
	}
}

/// Named values, including a path and a value carrying a verdict.
pub fn fields() -> Fields {
	Fields::new(vec![
		Pair::path("path", "hosts/gui/shell/src/window.rs"),
		Pair::new("lines", "412"),
		Pair::new("exit", "0")
			.tone(Tone::Ok)
			.badge(Badge::new("ok", Tone::Ok)),
		Pair::new("elapsed", "1.4s"),
	])
}

/// Captured text, capped, with lines the producer had already dropped.
pub fn output() -> Output {
	Output::new(
		"   Compiling veyyon-gui-contract v0.1.0\n   Compiling veyyon-gui-kit v0.1.0\n   Compiling \
		 veyyon-gui-views v0.1.0\n   Compiling veyyon-gui-shell v0.1.0\n    Finished `dev` profile \
		 in 8.31s",
	)
	.title("cargo check")
	.max_lines(3)
	.omitted(12)
}

/// Output that reports a failure.
pub fn error_output() -> Output {
	Output::error(
		"error[E0432]: unresolved import `veyyon_gui_contract::transcript`\n  --> \
		 shell/src/status.rs:11:2",
	)
	.title("stderr")
}

/// Source, with a language and a starting line.
pub fn code() -> Code {
	Code::new(
		"pub fn route(id: RouteId) -> Route {\n\tmatch id {\n\t\tRouteId::Session => \
		 Route::Session,\n\t}\n}",
	)
	.language("rust")
	.first_line(19)
	.title("hosts/gui/contract/src/fixtures/routes.rs")
}

/// Prose the model wrote.
pub fn markdown() -> Markdown {
	Markdown::new(
		"The window draws one page per route. A route carries its own data, so a page and its data \
		 cannot disagree.\n\n- `Route::Session` is the transcript.\n- Every other route is drawn \
		 over it.",
	)
}

/// A remark with a verdict.
pub fn note() -> Note {
	Note::new(
		"The theme files are read from the terminal host; nothing here copies them.",
		Tone::Warn,
	)
}

/// Columns and rows, with a row that stands out.
pub fn table() -> Table {
	Table::new(vec!["crate".to_owned(), "tests".to_owned(), "status".to_owned()], vec![
		TableRow::new(vec!["veyyon-gui-contract".to_owned(), "58".to_owned(), "green".to_owned()])
			.tone(Tone::Ok),
		TableRow::new(vec!["veyyon-gui-theme".to_owned(), "57".to_owned(), "green".to_owned()])
			.tone(Tone::Ok),
		TableRow::new(vec!["veyyon-gui-views".to_owned(), "0".to_owned(), "empty".to_owned()])
			.tone(Tone::Warn)
			.badge(Badge::new("new", Tone::Accent)),
		TableRow::new(vec!["total".to_owned(), "115".to_owned(), String::new()]).emphasis(),
	])
}

/// Paths and what happened to each, with entries the producer dropped.
pub fn files() -> Files {
	Files::new(vec![
		PathEntry::new("hosts/gui/contract/src/view/mod.rs")
			.detail("+218")
			.tone(Tone::Ok),
		PathEntry::new("hosts/gui/contract/src/screen/report.rs").detail("+61 −48"),
		PathEntry::new("hosts/gui/app/src/blocks.rs")
			.detail("moved to shell/src/transcript.rs")
			.badge(Badge::plain("renamed")),
		PathEntry::new("assets/icon.png")
			.detail("skipped: binary")
			.tone(Tone::Warn),
	])
	.omitted(3)
}

/// A raster with known dimensions.
pub fn image() -> Image {
	Image::new(".scratch/gui-smoke/frame.png", "image/png")
		.size(1440, 900)
		.caption("The session route at 1440×900.")
}

/// A raster whose dimensions are not known yet, which is the state a host has
/// to reserve space for.
pub fn undecoded_image() -> Image {
	Image::new(".scratch/gui-smoke/tall.png", "image/png")
}

/// Changed lines: an edit and a rename.
pub fn diff() -> Diff {
	Diff::new("veyyon-gui-contract", vec![
		DiffFile::new("hosts/gui/contract/src/lib.rs", vec![DiffHunk::new(
			"@@ -30,6 +52,7 @@",
			vec![
				DiffLine::context(30, 52, "pub mod fixtures;"),
				DiffLine::removed(31, "pub mod capabilities;"),
				DiffLine::added(53, "pub mod host;"),
				DiffLine::added(54, "pub mod screen;"),
			],
		)]),
		DiffFile::renamed(
			"hosts/gui/contract/src/capabilities.rs",
			"hosts/gui/contract/src/host/capabilities.rs",
			Vec::new(),
		),
	])
}

/// A determinate operation.
pub fn progress() -> Progress {
	Progress::new("Indexing", 148)
		.total(412)
		.current("hosts/gui/shell/src/window.rs")
}

/// An operation with no total, which a host draws as a moving bar rather than a
/// filled one.
pub fn indeterminate_progress() -> Progress {
	Progress::new("Reading the shell", 9).current("hosts/gui/views/src/lib.rs")
}

/// A question that is still open.
pub fn question() -> Question {
	Question::new("The file has changed on disk since it was read. Overwrite it?", vec![
		Choice::new("Re-read and apply")
			.detail("Read the file again, then reapply the patch.")
			.recommended(),
		Choice::new("Overwrite").detail("Discard what changed on disk."),
		Choice::new("Cancel"),
	])
}

/// A question that has been answered, which is what a transcript redrawn from
/// history shows.
pub fn answered_question() -> Question {
	question().answered(0)
}

/// A running sub-agent.
pub fn agent() -> Agent {
	Agent::new("ViewsLane", "ViewsLane")
		.kind("deep")
		.summary("Drawing the output and code kinds.")
		.badge(Badge::plain("2 files"))
		.running()
}

/// An argument that did not parse.
pub fn invalid() -> Invalid {
	Invalid::new("\"tail\"")
		.name("mode")
		.expected("one of: head, range, raw")
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The view vocabulary has no TypeScript table to compare against, because
	//! the other host draws it from React components rather than from data. This
	//! sweep is the whole check: [`view`] is exhaustive so a new kind cannot
	//! compile without a fixture, and the fixtures assert the states that
	//! otherwise go undrawn — a capped block, an undecoded image, an answered
	//! question, an indeterminate bar.
	//!
	//! WHAT IT DOES NOT CATCH. Anything about the TypeScript side, and whether a
	//! host draws a kind at all. A renderer that ignored a kind entirely would
	//! pass here.

	use super::*;

	#[test]
	fn every_kind_has_a_fixture_of_its_own_kind() {
		for kind in ViewKind::ALL {
			assert_eq!(view(kind).kind(), kind, "{kind:?} returned another kind's payload");
		}
		assert_eq!(views().len(), ViewKind::ALL.len());
	}

	#[test]
	fn the_output_fixtures_cover_truncation_and_failure() {
		let output = output();
		let (lines, hidden) = output.visible();
		assert_eq!(lines.len(), 3);
		assert_eq!(hidden, 14, "the more line has to add the producer's own omissions");
		assert_eq!(error_output().variant, crate::view::OutputVariant::Error);
	}

	#[test]
	fn the_image_fixtures_cover_a_known_and_an_unknown_size() {
		assert!(image().fitted(720.0).is_some());
		assert_eq!(undecoded_image().fitted(720.0), None);
	}

	#[test]
	fn the_progress_fixtures_cover_determinate_and_not() {
		assert!(progress().fraction().is_some());
		assert_eq!(indeterminate_progress().fraction(), None);
	}

	#[test]
	fn the_question_fixtures_cover_open_and_answered() {
		assert!(question().is_open());
		assert!(!answered_question().is_open());
		assert!(answered_question().answer().is_some());
		assert!(
			question().choices.iter().any(|choice| choice.recommended),
			"no recommendation to draw"
		);
	}

	#[test]
	fn the_table_fixture_is_aligned() {
		assert!(table().is_aligned(), "a fixture table is a shifted table");
	}

	#[test]
	fn the_fields_fixture_carries_a_path_and_a_verdict() {
		let fields = fields();
		assert!(fields.pairs.iter().any(|pair| pair.is_path), "no path to shorten");
		assert!(fields.pairs.iter().any(|pair| pair.tone.is_some()), "no verdict to colour");
		assert_eq!(fields.get("lines"), Some("412"));
		assert_eq!(fields.get("absent"), None);
	}

	#[test]
	fn the_diff_fixture_carries_a_rename_with_no_lines() {
		let diff = diff();
		let renamed = diff
			.files
			.iter()
			.find(|file| file.old_path.is_some())
			.expect("no renamed file to draw");
		assert!(renamed.hunks.is_empty(), "the rename fixture is meant to have no line changes");
		assert_eq!((renamed.added, renamed.removed), (0, 0));
	}
}
