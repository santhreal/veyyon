//! WHY: the block reader had no table shape, so a model's reply carrying a
//! pipe table reached the transcript as paragraphs of `|` and `---` glyphs,
//! run together by the paragraph join. This suite reads a grid out of a real
//! frame: every cell on its own row, the header apart from the body, and each
//! column set against the edge its delimiter row names.
//!
//! The class this closes: a cell that never reaches the frame, a row that
//! collapses into the row above it, a delimiter row drawn as text, an
//! alignment that resolves to the same edge for every column, and the rule
//! under the header going missing.
//!
//! What this does NOT catch: the exact measure of a column, which is one
//! share of the row with a floor of zero rather than a stated width, and the
//! colour and weight the header row is set in, which are asserted as tokens
//! in the token suite rather than as pixels here. A source with no delimiter
//! row is prose, which the reader's own sweep pins.

mod common;

use common::{headless_context, render_frame};
use veyyon_desktop_kit::{ColorRole, TokenSet, text::Markdown};
use veyyon_gpui::{Context, IntoElement, Render, Window, div, prelude::*, px, size};

/// The measure every grid below is drawn into, so a column's share and a
/// right-hand edge are the same number in each assertion.
const GRID_W: f32 = 600.0;

/// One line of a drawn grid: the y it was set on, and its cells left to right.
struct Line {
	y:     f32,
	cells: Vec<(String, f32)>,
}

/// A grid drawn into a real frame: its lines, and the pixels of the frame.
struct Grid {
	lines:  Vec<Line>,
	pixels: Vec<u8>,
	width:  u32,
}

impl Grid {
	/// The texts of line `at`, left to right.
	fn texts(&self, at: usize) -> Vec<String> {
		self.lines[at]
			.cells
			.iter()
			.map(|(text, _)| text.clone())
			.collect()
	}

	/// Where cell `cell` of line `at` starts.
	fn x(&self, at: usize, cell: usize) -> f32 {
		self.lines[at].cells[cell].1
	}

	/// Whether any row of pixels in `top..bottom` is inked across at least
	/// four fifths of the grid's measure, which is a rule and not a line of
	/// text: a cell of a two-column grid cannot reach that far.
	fn ruled_between(&self, top: f32, bottom: f32) -> bool {
		self.widest_inked_row(top, bottom) > GRID_W * 0.8
	}

	/// The widest row of pixels inked in `top..bottom`, across the grid's own
	/// measure and against the ground the grid draws on.
	fn widest_inked_row(&self, top: f32, bottom: f32) -> f32 {
		#[expect(
			clippy::cast_possible_truncation,
			clippy::cast_sign_loss,
			reason = "the window rasterises at scale one, so a logical pixel is a pixel"
		)]
		let band = (top.max(0.0) as u32)..(bottom.max(0.0) as u32);
		let ground = self.at(0, 0);
		let measure = GRID_W as u32;
		let mut widest = 0;
		for y in band {
			let inked = (0..measure.min(self.width))
				.filter(|x| self.at(*x, y) != ground)
				.count();
			widest = widest.max(inked);
		}
		#[expect(clippy::cast_precision_loss, reason = "a measure of a few hundred pixels")]
		let widest = widest as f32;
		widest
	}

	/// The pixel at `x`, `y` as RGBA.
	fn at(&self, x: u32, y: u32) -> [u8; 4] {
		let at = ((y * self.width + x) * 4) as usize;
		self
			.pixels
			.get(at..at + 4)
			.map_or([0; 4], |bytes| [bytes[0], bytes[1], bytes[2], bytes[3]])
	}
}

/// One markdown source drawn on the surface colour, so a rule and a cell are
/// both a departure from one known ground.
struct Source(String);

impl Render for Source {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let resolved = TokenSet::for_app(cx);
		div()
			.w(px(GRID_W))
			.bg(resolved.color(ColorRole::Canvas))
			.child(Markdown::new(self.0.clone()))
	}
}

/// Draws `source` and reads the lines it set, grouped by the y each run was
/// drawn on: runs within two pixels of each other are one line.
fn grid(source: &str) -> Grid {
	let held = source.to_owned();
	let (mut cx, _permit) = headless_context();
	let window = cx
		.open_window(size(px(GRID_W + 40.0), px(320.0)), |window, app| {
			// The frame is read next to the run bounds the same frame reported, so
			// it is rasterised at the scale it was laid out at.
			window.set_scale_factor(1.0);
			let mut set = TokenSet::default();
			let available = app.text_system().all_font_names();
			set.resolve_mono_family(&available)
				.expect("this machine must have one of the authored monospace families");
			app.set_global(set);
			app.new(|_cx| Source(held))
		})
		.expect("headless window opens");
	render_frame(&mut cx, &window);
	let frame = cx
		.capture_frame(window.into(), 1.0)
		.expect("the frame rasterises");
	let mut runs: Vec<(f32, f32, String)> = frame
		.text_runs()
		.iter()
		.map(|run| {
			(f32::from(run.bounds.origin.y), f32::from(run.bounds.origin.x), run.text.to_string())
		})
		.collect();
	runs.sort_by(|left, right| left.partial_cmp(right).expect("no run is set at a NaN"));
	let mut lines: Vec<Line> = Vec::new();
	for (y, x, text) in runs {
		match lines.last_mut() {
			Some(line) if (line.y - y).abs() < 2.0 => line.cells.push((text, x)),
			_ => lines.push(Line { y, cells: vec![(text, x)] }),
		}
	}
	Grid { lines, pixels: frame.as_bytes().to_vec(), width: frame.width() }
}

/// Every cell reaches the frame, on the line its row states, and no pipe or
/// delimiter dash is drawn as a glyph.
#[test]
fn every_cell_is_drawn_on_the_line_of_the_row_it_belongs_to() {
	let read = grid("| tool | when |\n|--|--|\n| read | before an edit |\n| write | after one |");
	assert_eq!(read.lines.len(), 3, "a header and two rows are three lines: {:?}", read.texts(0));
	assert_eq!(read.texts(0), ["tool", "when"]);
	assert_eq!(read.texts(1), ["read", "before an edit"]);
	assert_eq!(read.texts(2), ["write", "after one"]);
	assert!(read.lines[0].y < read.lines[1].y, "the header is set above the rows");
	assert!(read.lines[1].y < read.lines[2].y, "a row is set below the row before it");
	for line in &read.lines {
		for (text, _) in &line.cells {
			assert!(!text.contains('|'), "a pipe is the grid, not a glyph: {text}");
			assert!(!text.contains("--"), "a delimiter row is the grid, not a glyph: {text}");
		}
	}
}

/// A column is set against the edge its delimiter row names. The same cell
/// text is drawn in each of the three, so nothing but the alignment differs
/// between the three readings.
#[test]
fn a_column_is_set_against_the_edge_its_delimiter_row_names() {
	let at = |delimiter: &str| {
		let read = grid(&format!("| head | head |\n|--|{delimiter}|\n| x | y |"));
		assert_eq!(read.texts(1), ["x", "y"], "{delimiter}");
		read.x(1, 1)
	};
	let (start, centre, end) = (at("--"), at(":-:"), at("--:"));
	assert!(
		start < centre && centre < end,
		"the second column must move right as its delimiter moves: start {start}px, centre \
		 {centre}px, end {end}px"
	);
	assert!(
		end - start > 40.0,
		"a right-set column ends at the row's right edge: start {start}px, end {end}px"
	);
}

/// The header is separated from the body by a rule across the grid, and
/// nothing separates one body row from the next: a grid is not a boxed table.
#[test]
fn a_rule_is_drawn_under_the_header_and_between_no_two_rows() {
	let read = grid("| head | head |\n|--|--|\n| one | one |\n| two | two |");
	let (header, first, second) = (read.lines[0].y, read.lines[1].y, read.lines[2].y);
	assert!(
		read.ruled_between(header + 14.0, first),
		"a rule is drawn between the header at {header}px and the first row at {first}px"
	);
	assert!(
		!read.ruled_between(first + 14.0, second),
		"no rule is drawn between the rows at {first}px and {second}px"
	);
}

/// A row that arrived short draws the cells it has, in the columns it has,
/// rather than padding the row or dropping it: mid-stream a row is short for
/// as long as it takes the next cell to arrive.
#[test]
fn a_row_shorter_than_the_header_draws_its_cells_in_the_first_columns() {
	let read = grid("| a | b | c |\n|--|--|--|\n| one |");
	assert_eq!(read.texts(1), ["one"]);
	assert!(
		(read.x(1, 0) - read.x(0, 0)).abs() < 1.0,
		"the one cell that arrived is in the first column: header at {}px, row at {}px",
		read.x(0, 0),
		read.x(1, 0)
	);
}

/// A header with no body row yet is a header: the grid is drawn from the rows
/// that have arrived.
#[test]
fn a_header_with_no_row_under_it_is_still_drawn_as_a_header() {
	let read = grid("| only | header |\n|--|--|");
	assert_eq!(read.lines.len(), 1, "one line and no phantom row: {:?}", read.texts(0));
	assert_eq!(read.texts(0), ["only", "header"]);
	let header = read.lines[0].y;
	assert!(read.ruled_between(header + 14.0, header + 30.0), "the rule is drawn under it");
}
