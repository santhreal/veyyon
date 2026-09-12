//! WHY: a reply arrives a few characters at a time and every frame drawn
//! mid-turn was handed a prefix of a document that the reader read as a
//! finished one. An arriving table drew as a row of pipes, an arriving bold
//! word drew its asterisks, and a list marker drew as a dash of prose until
//! its text landed -- then the whole reply reflowed under the reader's feet.
//!
//! The class this closes: a shape a prefix can leave open that nothing
//! closes. The sweep is built from `OpenShape` by an exhaustive match, so a
//! shape added without a prefix that opens it and a repair that closes it
//! does not compile, and the fuzz walks every split point of a document
//! carrying all of them at once.
//!
//! What this does NOT catch: how the mended text reads as blocks, which is
//! the drawing kit's reader and is asserted where the surface applies these
//! two functions. A target the mend invents for an unclosed link is `#`,
//! which draws the label and links nowhere; a mend is never shown to a host
//! or written to a session, only drawn.

use veyyon_desktop_model::text::markdown::{OpenShape, mend, open_shapes, settled_prefix_len};

/// A prefix that leaves `shape` open. Exhaustive by construction: a variant
/// added to `OpenShape` fails to compile here until it has a prefix.
const fn prefix_leaving_open(shape: OpenShape) -> &'static str {
	match shape {
		OpenShape::Fence => "before\n\n```rust\nlet held = 1;",
		OpenShape::Table => "| tool | when |",
		OpenShape::Item => "a list is coming\n\n-",
		OpenShape::Heading => "and then\n\n##",
		OpenShape::CodeSpan => "run `read",
		OpenShape::Strong => "**Cut",
		OpenShape::Emphasis => "*Cut",
		OpenShape::LinkTarget => "see [the plan](docs/pl",
	}
}

/// Documents that are finished. Nothing in them is open, and nothing about
/// them is rewritten.
const FINISHED: &[&str] = &[
	"plain prose with no marker in it",
	"# A heading\n\nA paragraph under it.\n",
	"- one\n- two\n",
	"| tool | when |\n|--|--:|\n| read | first |\n",
	"```rust\nlet held = 1;\n```\n",
	"a `code span`, a **strong** word, an *italic* one and [a link](docs/plan.md)\n",
	"see [not a link] here\n",
	"2 * 3 = 6 and snake_case_names\n",
	"1. **Word**\n2. __Word__\n3. `Word`\n",
	"***Nested*** and ___Nested___\n",
	"**Outer *inner*** and __outer _inner___\n",
	"***\n",
];

/// Every shape is seen when it is open, and closed when it is mended.
#[test]
fn every_shape_a_prefix_leaves_open_is_seen_and_closed() {
	for shape in OpenShape::all() {
		let prefix = prefix_leaving_open(shape);
		let open = open_shapes(prefix);
		assert!(open.contains(&shape), "{shape:?} must be seen in {prefix:?}, saw {open:?}");
		let mended = mend(prefix);
		assert_eq!(
			open_shapes(&mended),
			Vec::new(),
			"{shape:?}: nothing is open after the mend of {mended:?}"
		);
		assert!(keeps_every_character(prefix, &mended), "{shape:?}: {prefix:?} -> {mended:?}");
	}
}

/// The negative control: a finished document has nothing open and is handed
/// back byte for byte. Without it the mend could pass every row above by
/// appending every closer to everything.
#[test]
fn a_finished_document_is_left_exactly_as_it_is() {
	for source in FINISHED {
		assert_eq!(open_shapes(source), Vec::new(), "nothing is open in {source:?}");
		assert_eq!(mend(source), *source, "{source:?} is handed back as it is");
	}
}

/// A table's delimiter row goes under its header, not after the rows that
/// have arrived: appended at the end it would state the shape of nothing.
/// A run of marks at the end of a line is the closer being written, not a
/// second opener: `**strong*` owes one more `*`, and a finished pair owes
/// nothing. Without this the mend would write `**strong***`.
#[test]
fn a_closer_half_written_is_finished_and_not_doubled() {
	for (prefix, whole) in [
		("**strong*", "**strong**"),
		("**both**", "**both**"),
		("a **word** and *one", "a **word** and *one*"),
		("__held_", "__held__"),
	] {
		assert_eq!(mend(prefix), whole, "{prefix:?} closes in the marks it still owes");
	}
}

#[test]
fn a_table_gains_its_delimiter_row_under_the_header() {
	assert_eq!(mend("| tool | when |"), "| tool | when |\n|---|---|\n");
	assert_eq!(mend("| tool | when |\n| read |"), "| tool | when |\n|---|---|\n| read |");
	// A header that already has its delimiter row is not given a second one,
	// however short the row under it is.
	assert_eq!(mend("| a |\n|--|\n| par"), "| a |\n|--|\n| par");
}

/// A line of prose with a pipe in it is no table, so nothing is inserted
/// under it: a delimiter row under a sentence would draw the sentence as a
/// grid.
#[test]
fn a_pipe_in_a_sentence_opens_no_table() {
	let source = "pass a | b to it";
	assert!(!open_shapes(source).contains(&OpenShape::Table), "{:?}", open_shapes(source));
	assert_eq!(mend(source), source);
}

/// A code span's interior is literal, so a marker inside one opens nothing,
/// and an unclosed span makes the rest of the line literal too.
#[test]
fn a_marker_inside_a_code_span_opens_nothing() {
	assert_eq!(open_shapes("the `**held**` field"), Vec::new());
	assert_eq!(open_shapes("run `read **now"), vec![OpenShape::CodeSpan]);
	assert_eq!(mend("run `read **now"), "run `read **now`");
}

/// A label that closed is not guessed into a link: `[not a link]` is the text
/// it is, and inventing a target for it would restyle finished text.
#[test]
fn a_closed_label_is_not_guessed_into_a_link() {
	assert_eq!(open_shapes("see [not a link]"), Vec::new());
	// A label with no bracket yet is the text it is: a target nobody wrote
	// would be drawn beside it, because the kit draws a link's target.
	assert_eq!(open_shapes("see [the pl"), Vec::new());
	assert_eq!(mend("see [the pl"), "see [the pl");
	// A label that closed with a target still arriving needs only its
	// bracket, not a target nobody wrote.
	assert_eq!(open_shapes("see [the plan](docs/pl"), vec![OpenShape::LinkTarget]);
	assert_eq!(mend("see [the plan](docs/pl"), "see [the plan](docs/pl)");
}

/// An open fence is the whole answer: a table row, a heading or an asterisk
/// inside code is text, and mending it would rewrite the code the reply is
/// quoting.
#[test]
fn nothing_inside_an_open_fence_is_mended_but_the_fence() {
	let source = "```md\n| a | b |\n## not a heading\n**not strong\n";
	assert_eq!(open_shapes(source), vec![OpenShape::Fence]);
	assert_eq!(mend(source), format!("{source}\n```"));
}

/// Every split point of a document that carries every shape is mended
/// without a panic, closes what it opened, and keeps every character that
/// arrived.
#[test]
fn every_prefix_of_a_document_is_mended_and_loses_nothing() {
	for document in documents() {
		for split in split_points(document) {
			let prefix = &document[..split];
			let mended = mend(prefix);
			assert!(
				keeps_every_character(prefix, &mended),
				"split {split} of {document:?}: {prefix:?} -> {mended:?}"
			);
			assert_eq!(
				open_shapes(&mended),
				Vec::new(),
				"split {split}: nothing is open after mending {prefix:?} into {mended:?}"
			);
		}
	}
}

/// The boundary between settled and arriving text only moves forward, sits at
/// a character boundary of the source, and is never past its end. A boundary
/// that moved back would reflow text that had already settled, which is the
/// reflow this whole module exists to stop.
#[test]
fn the_settled_boundary_only_moves_forward_and_lands_on_a_line() {
	for document in documents() {
		let mut held = 0;
		for split in split_points(document) {
			let prefix = &document[..split];
			let settled = settled_prefix_len(prefix);
			assert!(settled <= prefix.len(), "{settled} is inside {split} bytes");
			assert!(prefix.is_char_boundary(settled), "split {split}: {settled} splits a character");
			assert!(
				settled >= held,
				"split {split} of {document:?}: the boundary moved back from {held} to {settled}"
			);
			assert!(
				settled == 0 || prefix[..settled].ends_with('\n'),
				"split {split}: {:?} does not end a line",
				&prefix[..settled]
			);
			held = settled;
		}
	}
}

/// A block the next line can extend is not settled, and a block one line
/// finishes is settled as soon as its own line ends.
#[test]
fn a_growing_block_is_not_settled_and_a_finished_one_is() {
	assert_eq!(settled_prefix_len("one\ntwo"), 0, "a paragraph the next line can extend");
	assert_eq!(settled_prefix_len("one\n\ntwo"), 5, "a paragraph a blank line closed");
	assert_eq!(settled_prefix_len("# H\n"), 4, "a heading is one line and cannot grow");
	assert_eq!(settled_prefix_len("# H\nbody"), 4, "the arriving line is not settled");
	assert_eq!(settled_prefix_len("- one\n- two\n"), 12, "each item is its own block");
	assert_eq!(settled_prefix_len("| a |\n|--|\n| 1 |\n"), 0, "a table the next row extends");
	assert_eq!(settled_prefix_len("```\nx\n"), 0, "an open fence grows with every line");
	assert_eq!(settled_prefix_len("```\nx\n```\n"), 10, "a closed fence is settled");
	assert_eq!(settled_prefix_len("intro\n\n```\nx\n"), 7, "the paragraph above a fence settled");
}

/// Nothing is open on the settled side of the boundary, so a surface draws
/// it as it is and mends only the block still arriving. Every shape lives
/// inside one block, and the boundary is a block boundary: if this ever fails
/// the two halves disagree and the settled text would be repaired under the
/// reader.
#[test]
fn the_settled_side_of_the_boundary_needs_no_repair() {
	for document in documents() {
		for split in split_points(document) {
			let prefix = &document[..split];
			let settled = &prefix[..settled_prefix_len(prefix)];
			assert_eq!(
				open_shapes(settled),
				Vec::new(),
				"split {split} of {document:?}: {settled:?} is settled with a shape open"
			);
			assert_eq!(mend(settled), settled, "the settled side is handed back as it is");
		}
	}
}

/// The documents every sweep walks: one of each shape, and one carrying all
/// of them, so a split point lands inside each shape in turn.
fn documents() -> Vec<&'static str> {
	let mut held: Vec<&'static str> = OpenShape::all()
		.iter()
		.copied()
		.map(prefix_leaving_open)
		.collect();
	held.extend_from_slice(FINISHED);
	held.push(
		"# Report\n\nA paragraph with **strong**, *italic*, a `span` and [a link](docs/p.md).\n\n| \
		 tool | when |\n|:--|--:|\n| read | first |\n| write | after |\n\n- one\n- \
		 two\n\n```rust\nlet held = 1;\n```\n\n> and a quote\n",
	);
	held.push("| a | b |\n| c | d |\n");
	held.push("**a *b `c` d* e**\n");
	held.push("text with an emoji \u{1f9ea} and a wide char \u{4e2d} in it\n");
	held
}

/// Every character boundary of `document`, so the fuzz splits between bytes
/// of a multi-byte character as well as between characters.
fn split_points(document: &str) -> Vec<usize> {
	(0..=document.len())
		.filter(|at| document.is_char_boundary(*at))
		.collect()
}

/// Whether `mended` holds every character of `source`, in order: the mend
/// adds and never drops, so the source is a subsequence of its mend.
fn keeps_every_character(source: &str, mended: &str) -> bool {
	let mut held = mended.chars();
	source.chars().all(|want| held.any(|have| have == want))
}
