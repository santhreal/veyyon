//! Reusable text transforms shared by minimizer filters.

use std::collections::BTreeMap;

use crate::minimizer::filters::git::DIFF_CHANGES_HEADER;

/// Opens every marker the minimizer splices into output it did not write.
///
/// One constant rather than the literal repeated at each `push_str`, because
/// the predicate that has to RECOGNIZE these lines needs to agree with the code
/// that WRITES them, and two copies of `"[…"` drift the moment somebody changes
/// one.
pub const ELISION_OPEN: &str = "[…";

/// Opens the repeated-line counter, as in `warning: unused (×4)`.
pub const REPEAT_OPEN: &str = " (×";

/// Closes a line-elision marker, as in `[…26ln elided…]`.
///
/// Split out for the same reason as [`ELISION_OPEN`]: [`push_elision_marker`]
/// writes it and [`elision_line_count`] reads it back, and a marker that can be
/// written but not read is how the count came to be wrong.
const ELISION_LINE_CLOSE: &str = "ln elided…]";

/// Write a `[…Nln elided…]` marker, followed by a newline.
///
/// The one writer. This shape was pasted at four call sites, which is how the
/// one thing they all got wrong (see [`elision_line_count`]) had to be found
/// four times.
fn push_elision_marker(out: &mut String, lines: usize) {
	out.push_str(ELISION_OPEN);
	out.push_str(&lines.to_string());
	out.push_str(ELISION_LINE_CLOSE);
	out.push('\n');
}

/// How many ORIGINAL lines `line` stands for.
///
/// One for ordinary text, and for a marker this module wrote, the count it
/// carries: `[…26ln elided…]` is one line of output standing in for 26.
///
/// WHY IT MATTERS. The head/tail helpers cap output that may already have been
/// capped, because filters chain and captures get replayed. Dropping a marker
/// and counting it as a single line loses everything behind it: an output of 97
/// lines capped to 50 head plus 21 tail carried `[…26ln elided…]`, and capping
/// that result again dropped the marker as one more line and wrote
/// `[…1ln elided…]`. Twenty-six hidden lines were reported as one, and the same
/// text produced a different answer every time it passed through, which
/// `fuzz/fuzz_targets/minimizer_filters.rs` found by asserting idempotence.
///
/// Counting the marker by what it represents makes the operation both truthful
/// and idempotent: re-capping already-capped output reproduces it exactly,
/// because the marker is the only line dropped and it puts its own count back.
fn represented_line_count(line: &str) -> usize {
	elision_line_count(line).unwrap_or(1)
}

/// The line count carried by a `[…Nln elided…]` marker, or `None` for any other
/// line.
///
/// Deliberately narrower than [`is_minimizer_annotation`], which recognizes
/// every marker shape including the `entries`/`names` variants that count
/// something other than lines. Only a line-counting marker can contribute to a
/// line total.
fn elision_line_count(line: &str) -> Option<usize> {
	line
		.trim()
		.strip_prefix(ELISION_OPEN)?
		.strip_suffix(ELISION_LINE_CLOSE)?
		.parse::<usize>()
		.ok()
}

/// True when this line was written by the minimizer rather than by the program.
///
/// WHY THIS EXISTS. Filters chain, and a captured output can be condensed again
/// by a wrapper or by a replayed capture. Condensing runs noise-stripping FIRST
/// and annotation LAST, so on a second pass the stripper reads the previous
/// pass's annotations as program output. It ate them: `condense_lint_output`
/// for eslint turned `"0 (×2)\n"` into `""`, because `0 (×2)` looks exactly
/// like a tsc code-frame body line (a line-number gutter followed by source).
/// Output that survived one pass vanished on the next, and what the agent saw
/// for a command that printed something was nothing at all. Found by
/// `fuzz/fuzz_targets/minimizer_lint_condense.rs` asserting idempotence.
///
/// The `N diagnostics in M files` header is the same hazard for the same
/// reason, and `Top codes:` / `Top rules:` and the per-file `path (N
/// diagnostics)` rows complete the set. Every shape below names where it is
/// produced.
#[must_use]
pub fn is_minimizer_annotation(line: &str) -> bool {
	let trimmed = line.trim();
	// `flush_repeated`, this file.
	if trimmed.ends_with(')') && trimmed.contains(REPEAT_OPEN) {
		return true;
	}
	// `head_tail_lines` and the cap helpers, this file.
	if trimmed.starts_with(ELISION_OPEN) {
		return true;
	}
	// `group_diagnostics`, filters/lint.rs: the header and the per-file rows.
	if is_diagnostic_count_header(trimmed) {
		return true;
	}
	if trimmed.ends_with(" diagnostics)") || trimmed.ends_with(" diagnostic)") {
		return true;
	}
	// `compact_find_output_inner`, filters/listing.rs.
	if is_find_summary_header(trimmed) {
		return true;
	}
	// `compact_table`, filters/docker.rs.
	if is_row_count_annotation(trimmed) {
		return true;
	}
	// `compact_listing`, this file.
	if is_entry_count_annotation(trimmed) {
		return true;
	}
	// `compact_log`, filters/system.rs.
	if is_log_summary_header(trimmed) {
		return true;
	}
	// The directory-listing tally, filters/listing.rs: `12 files, 3 dirs` with an
	// optional ` (9 .rs, 3 .toml)` extension breakdown.
	if trimmed.contains(" files, ") && (trimmed.ends_with(" dirs") || trimmed.contains(" dirs (")) {
		return true;
	}
	// `compact_diff_output`, filters/git.rs. Claimed here as well as guarded
	// there, because the header opens with `--- `, which every diff-aware filter
	// reads as a file marker.
	if trimmed == DIFF_CHANGES_HEADER {
		return true;
	}
	// `format_code_summary` callers, filters/lint.rs.
	trimmed.starts_with("Top codes: ") || trimmed.starts_with("Top rules: ")
}

/// True for the bare `N rows` tally `compact_table` writes above a capped
/// table.
///
/// Shared with `compact_table` in filters/docker.rs, which uses it to recognize
/// its OWN output arriving for a second pass. The compactor counts every
/// non-blank line as a row, so on a second pass it counted this tally and its
/// own `[…N rows elided…]` marker as two more rows: `docker ps` output that had
/// been through once reported `13 rows` and, having been through twice,
/// reported `14 rows` with the old tally listed underneath as data. A count
/// that grows every time the output is re-minimized is worse than no count.
///
/// The bare form only. psql writes `(13 rows)` with parentheses, which is the
/// PROGRAM's own summary and must not be mistaken for ours.
#[must_use]
pub fn is_row_count_annotation(line: &str) -> bool {
	line
		.trim()
		.strip_suffix(" rows")
		.is_some_and(|count| !count.is_empty() && count.bytes().all(|byte| byte.is_ascii_digit()))
}

/// True for the bare `N entries` tally [`compact_listing`] writes above a
/// capped listing.
///
/// Shared with [`compact_listing`], which uses it to recognize its OWN output
/// arriving for a second pass. That function counts every non-blank line as an
/// entry, so a second pass counted this tally and the bare `…` separator as two
/// more entries and stacked a fresh header on top of the old one: a `ls -la`
/// capture that had been through once read `100 entries`, and having been
/// through twice read `82 entries` above `100 entries`. Two contradictory
/// counts on the same listing is worse than neither.
///
/// The bare form only, for the same reason as [`is_row_count_annotation`]: a
/// prefixed count like `package tree/list: 91 entries` belongs to a different
/// writer with its own guard.
#[must_use]
pub fn is_entry_count_annotation(line: &str) -> bool {
	line
		.trim()
		.strip_suffix(" entries")
		.is_some_and(|count| !count.is_empty() && count.bytes().all(|byte| byte.is_ascii_digit()))
}

/// True for the `log summary: …` header `compact_log` writes.
///
/// Shared with `compact_log` in filters/system.rs, which uses it to recognize
/// its OWN output arriving for a second pass. Every line there counts toward
/// the totals, and this header contains the word "error", so a second pass
/// counted the header itself as an error and stacked a fresh summary on top of
/// the old one: `log summary: 100 lines, 100 unique, 0 errors` gained
/// `log summary: 82 lines, 82 unique, 1 errors` above it. Two contradictory
/// summaries of one capture, the newer one reporting an error the program never
/// logged.
#[must_use]
pub fn is_log_summary_header(line: &str) -> bool {
	line.trim_start().starts_with("log summary: ")
}

/// True for the `N diagnostics in M files` header `group_diagnostics` writes.
///
/// Shared with `condense_lint_output` in filters/lint.rs, which uses it to
/// recognize its OWN output arriving for a second pass. Recognizing the header
/// and stopping is the only reliable guard, for the same reason it is with
/// `find`: the ENTRY rows under a `path (N diagnostics)` header are the tails
/// of real diagnostics with the file prefix removed, so they can look like
/// anything, including like the noise the condenser strips FIRST. A biome
/// diagnostic whose text began with digits came back as
/// `"  000  ))::0…"`, which is shaped exactly like a tsc code-frame gutter
/// line, so the second pass deleted the diagnostic and kept only the summary
/// saying it existed. Found by `fuzz/fuzz_targets/minimizer_filters.rs`.
#[must_use]
pub fn is_diagnostic_count_header(line: &str) -> bool {
	let trimmed = line.trim();
	trimmed.ends_with(" files") && trimmed.contains(" diagnostics in ")
}

/// True for the `find: N paths in M dirs` header the listing filter writes.
///
/// Shared with `compact_find_output` in filters/listing.rs, which uses it to
/// recognize its OWN output arriving for a second pass. The per-directory rows
/// below that header (`./ name1 name2`) look enough like paths that re-parsing
/// them is unavoidable once it starts, and it mangles both the count and the
/// names: a row `./ )` came back as the path `./ )`, whose file name is ` )`
/// with the leading space, so the row grew a space on every pass. Recognizing
/// the header and stopping is the only reliable guard, because a real find path
/// may legitimately contain spaces and cannot be told apart from a row by shape
/// alone.
#[must_use]
pub fn is_find_summary_header(line: &str) -> bool {
	let trimmed = line.trim();
	trimmed.starts_with("find: ") && trimmed.contains(" paths in ") && trimmed.ends_with(" dirs")
}

/// True when `text` holds anything the PROGRAM printed.
///
/// Blank lines do not count, and neither do the markers this module splices in,
/// because a filter asking "did anything survive?" is asking about the
/// program's output, not about its own bookkeeping.
///
/// WHY THE SECOND HALF MATTERS. Filters branch on this: pytest's success path
/// returns the filtered text when something survived and falls back to the last
/// twenty lines of the raw capture when nothing did. A marker counted as
/// content flips that branch on a second pass. A capture of ninety blank lines
/// gave `[…70ln elided…]` followed by twenty blank lines on the first pass
/// (nothing survived, so the fallback ran) and just `[…70ln elided…]` on the
/// second (the marker "survived", so the fallback did not), which is the same
/// output deciding to be two different things depending on how many times it
/// had been filtered. Found by `fuzz/fuzz_targets/minimizer_filters.rs`.
///
/// This was four byte-identical private copies, in the pytest, jest, rspec, and
/// listing filters, none of which knew about markers. One owner instead, so the
/// rule cannot be fixed in one filter and left wrong in the other three.
#[must_use]
pub fn has_program_content(text: &str) -> bool {
	text.lines().any(|line| is_program_content(line))
}

/// True when this single line is something the PROGRAM printed.
///
/// The per-line form of [`has_program_content`], and its definition, so the two
/// cannot disagree about what counts. Filters that COLLECT lines need this one:
/// the find filter gathered every non-blank line as a path, so on a second pass
/// it read its own `find: 1 paths in 1 dirs` header as a path named `dirs`,
/// counted it, and printed `find: 2 paths in 1 dirs` with the old header
/// spliced into a row. Found by `fuzz/fuzz_targets/minimizer_filters.rs`.
#[must_use]
pub fn is_program_content(line: &str) -> bool {
	!line.trim().is_empty() && !is_minimizer_annotation(line)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapClass {
	Errors,
	Warnings,
	List,
	Inventory,
}

impl CapClass {
	#[must_use]
	pub const fn lines(self) -> usize {
		match self {
			Self::Errors => 160,
			Self::Warnings => 120,
			Self::List => 80,
			Self::Inventory => 40,
		}
	}
}

#[must_use]
pub const fn reduced(cap: usize, by: usize) -> usize {
	let reduced = cap.saturating_sub(by);
	if reduced == 0 && cap > 0 { 1 } else { reduced }
}

/// Length in bytes of the CSI sequence starting at `bytes[start]`, if there is
/// one.
///
/// A CSI sequence is `ESC [`, then parameter bytes `0x30..=0x3f`, then
/// intermediate bytes `0x20..=0x2f`, then exactly one final byte `0x40..=0x7e`.
/// Anything else after the introducer means this is not a sequence, and the
/// answer is `None`.
///
/// Written as a bounded parse because the alternative loses data. See
/// [`strip_ansi`].
fn csi_sequence_len(bytes: &[u8], start: usize) -> Option<usize> {
	if bytes.get(start) != Some(&0x1b) || bytes.get(start + 1) != Some(&b'[') {
		return None;
	}
	let mut idx = start + 2;
	while matches!(bytes.get(idx), Some(0x30..=0x3f)) {
		idx += 1;
	}
	while matches!(bytes.get(idx), Some(0x20..=0x2f)) {
		idx += 1;
	}
	match bytes.get(idx) {
		Some(0x40..=0x7e) => Some(idx + 1 - start),
		_ => None,
	}
}

/// Trim every trailing carriage return from each line, keeping the final
/// line's ending as it was.
///
/// THE ONE OWNER of "what a carriage return means to this crate". A CR
/// surviving into a rendered row moves the cursor to column 0 and corrupts the
/// line, so `MinimizerOutput::transformed` strips them on the way OUT and has
/// since the first idempotence fix. Nothing stripped them on the way IN, and
/// that asymmetry is a bug generator: a filter's line predicates see `"00)\r"`
/// on the first pass and `"00)"` on the second, because the first pass wrote a
/// normalized answer. `bun test` read `"00)\r"` as ordinary output, fell back
/// to head/tail, and then read the same line as a playwright failure header on
/// the next pass and answered with a different, much shorter capture. Found by
/// `fuzz/fuzz_targets/minimizer_filters.rs`.
///
/// Per LINE rather than a `replace("\r\n", "\n")`, which is not the same
/// thing and not idempotent: `"\r\r\n"` would become `"\r\n"` and the next
/// pass would change it again. Real captures do contain doubled carriage
/// returns.
#[must_use]
pub fn normalize_carriage_returns(text: &str) -> String {
	if !text.contains('\r') {
		return text.to_string();
	}
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	loop {
		match rest.find('\n') {
			Some(idx) => {
				out.push_str(rest[..idx].trim_end_matches('\r'));
				out.push('\n');
				rest = &rest[idx + 1..];
			},
			None => {
				out.push_str(rest.trim_end_matches('\r'));
				break;
			},
		}
	}
	out
}

/// Remove ANSI CSI escape sequences while preserving line endings verbatim.
///
/// A byte run that is not a well-formed sequence is passed through as text.
/// This used to treat any `ESC [` as an introducer and then skip forward to the
/// next byte in `0x40..=0x7e`, which has two failure modes and both lose real
/// output. A capture TRUNCATED mid-escape has no final byte, so the skip ran to
/// the end and deleted everything after the escape: buffer boundaries cut
/// output mid-sequence all the time, and the whole tail vanished with nothing
/// to say so. And the skip was not idempotent, because it consumed a different
/// amount depending on what happened to follow: `"\x1b\x1b\x1b\x1b[[["` became
/// `"\x1b\x1b\x1b["` on one pass and `"\x1b\x1b"` on the next, so a filter's
/// answer depended on how many times it had run. Found by
/// `fuzz/fuzz_targets/minimizer_filters.rs`.
///
/// What survives a malformed run is everything EXCEPT the escape byte itself.
/// The text after it is kept, which is the thing that was being lost; the
/// escape is dropped, which is what makes this function a fixed point by
/// construction. No escape byte survives a pass, so a second pass takes the
/// fast path and cannot change anything. Keeping the stray escape as text was
/// tried first and does not hold up, because removing a sequence can push a
/// stray escape against a following `[` and MAKE a sequence: see the comment on
/// the drop below.
#[must_use]
pub fn strip_ansi(input: &str) -> String {
	if !input.contains('\x1b') {
		return input.to_string();
	}
	let bytes = input.as_bytes();
	let mut out = String::with_capacity(input.len());
	let mut idx = 0usize;
	while idx < bytes.len() {
		if let Some(len) = csi_sequence_len(bytes, idx) {
			idx += len;
			continue;
		}
		// An escape byte that did not open a complete sequence is DROPPED, and
		// only the escape byte: whatever follows it is text and is kept. That is
		// what makes this function a fixed point, and by construction rather than
		// by inspection -- no escape byte survives a pass, so a second pass takes
		// the fast path above and cannot change anything.
		//
		// Keeping the stray escape as text was the obvious reading of "pass a
		// malformed run through", and it does not hold up: removing a sequence
		// can push a stray escape up against a following `[` and MAKE a sequence
		// that was not there before. `" ][:\x1b\x1b[[[["` settled at
		// `" ][:\x1b[["` on one pass and `" ][:"` on the next, so the same
		// capture minimized to two different things depending on how many passes
		// it had been through. Dropping the byte costs nothing an operator can
		// see -- a lone escape renders as nothing -- while the tail after it,
		// which is the thing that was actually being lost, is still kept in full.
		// Found by `fuzz/fuzz_targets/minimizer_filters.rs`.
		if bytes[idx] == 0x1b {
			idx += 1;
			continue;
		}
		// Copy one CHARACTER (not one byte) so the string stays valid UTF-8.
		// Every byte a CSI sequence can contain is ASCII, so the skip above never
		// lands inside a multi-byte character.
		let ch = input[idx..].chars().next().unwrap_or('\u{fffd}');
		out.push(ch);
		idx += ch.len_utf8();
	}
	out
}

/// Collapse consecutive identical lines as `line (×N)`.
///
/// A run of blank lines collapses to a single blank line and carries no count.
/// The `(×N)` annotation tells you a program repeated a message, which is worth
/// knowing; applied to whitespace it invents a message that was never printed.
/// Before this, two blank lines came back as the literal text ` (×2)`, and
/// because blank lines separate sections in the output of cargo, tsc, eslint,
/// git, and gh, that marker was being spliced into most of what the agent read.
/// Found by `fuzz/fuzz_targets/minimizer_lint_condense.rs`, which noticed that
/// two bytes of input had become seven bytes of output.
#[must_use]
pub fn dedup_consecutive_lines(input: &str) -> String {
	let mut out = String::new();
	let mut previous: Option<&str> = None;
	let mut count = 0usize;
	for line in input.lines() {
		// `str::lines` strips ONE carriage return before the newline, and this
		// function writes every line back terminated by a bare `\n`. So a line that
		// arrived as `warn\r\r\n` came out as `warn\r\n` and lost another `\r` on the
		// next pass, which made the whole filter chain depend on how many times it
		// had run. Worse for the common case: `warn\r` and `warn` compare unequal, so
		// CRLF output from a Windows toolchain did not dedup at all until something
		// had already rewritten it once. Strip the carriage returns here, where the
		// line ending is being normalized anyway.
		let line = line.trim_end_matches('\r');
		if previous == Some(line) {
			count += 1;
			continue;
		}
		flush_repeated(&mut out, previous, count);
		previous = Some(line);
		count = 1;
	}
	flush_repeated(&mut out, previous, count);
	out
}

fn flush_repeated(out: &mut String, line: Option<&str>, count: usize) {
	let Some(line) = line else {
		return;
	};
	// A LINE THAT ALREADY CARRIES A COUNTER GETS ITS COUNTER MULTIPLIED, NOT A
	// SECOND ONE APPENDED. Feed this function its own output and the repeated
	// line is `warn (×3)`; appending produced `warn (×3) (×2)`, which says
	// nothing an operator can read -- is that three, two, five, or six? -- and
	// grows another bracket on every pass. Two runs of three identical lines is
	// six identical lines, so the answer is `warn (×6)`, which is what the
	// capture would have said had it been minimized once instead of twice.
	// Found by `fuzz/fuzz_targets/minimizer_primitives.rs`.
	if let Some((body, existing)) = split_repeat_counter(line) {
		let total = existing.saturating_mul(count.max(1));
		out.push_str(body);
		out.push_str(REPEAT_OPEN);
		out.push_str(&total.to_string());
		out.push(')');
		out.push('\n');
		return;
	}
	out.push_str(line);
	// `line.trim().is_empty()` rather than `line.is_empty()`, because a run of
	// lines containing only spaces or tabs is blank to a reader and annotating it
	// is the same invented message. The line itself is preserved as written; only
	// the counter is suppressed.
	if count > 1 && !line.trim().is_empty() {
		out.push_str(REPEAT_OPEN);
		out.push_str(&count.to_string());
		out.push(')');
	}
	out.push('\n');
}

/// Split a line this minimizer already annotated into its body and its count.
///
/// Returns `None` for a line that carries no counter, and for one whose counter
/// is not a number this function wrote, so a program that happens to print
/// `total (×n)` keeps its own text.
fn split_repeat_counter(line: &str) -> Option<(&str, usize)> {
	let rest = line.strip_suffix(')')?;
	let open = rest.rfind(REPEAT_OPEN)?;
	let digits = &rest[open + REPEAT_OPEN.len()..];
	if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	Some((&line[..open], digits.parse().ok()?))
}

/// Keep the first `head` and last `tail` lines with an omission marker.
#[must_use]
pub fn head_tail_lines(input: &str, head: usize, tail: usize) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= head + tail {
		return input.to_string();
	}
	let omitted: usize = lines[head..lines.len() - tail]
		.iter()
		.copied()
		.map(represented_line_count)
		.sum();
	let mut out = String::new();
	for line in lines.iter().take(head) {
		out.push_str(line);
		out.push('\n');
	}
	push_elision_marker(&mut out, omitted);
	for line in lines.iter().skip(lines.len() - tail) {
		out.push_str(line);
		out.push('\n');
	}
	out
}

/// Keep head/tail lines using a named cap class.
#[must_use]
pub fn head_tail_cap(input: &str, class: CapClass) -> String {
	let cap = class.lines();
	let head = reduced(cap, cap / 3);
	let tail = cap - head;
	head_tail_lines(input, head, tail)
}

/// Drop lines matching any of the supplied predicates.
pub fn strip_lines(input: &str, predicates: &[fn(&str) -> bool]) -> String {
	let mut out = String::new();
	for line in input.lines() {
		if predicates.iter().any(|predicate| predicate(line)) {
			continue;
		}
		out.push_str(line);
		out.push('\n');
	}
	out
}

/// The indent [`group_by_file`] gives an entry under its `path:` header.
///
/// Two spaces, and the single owner of that fact: [`is_grouped_listing`] has to
/// recognize exactly what [`group_by_file`] writes, and a listing whose reader
/// and writer disagree by one space is a listing that never settles.
const GROUP_ENTRY_INDENT: &str = "  ";

/// True when `text` is already a [`group_by_file`] listing.
///
/// The shape is a `path:` header at column zero immediately followed by an
/// entry indented by [`GROUP_ENTRY_INDENT`]. One such pair is enough: the rest
/// of a listing is headers, entries, and whatever was ungroupable.
///
/// WHY THIS EXISTS. Filters chain and captures get replayed, so a filter runs
/// over its own output routinely, and the filters that group also normalize
/// each line with `trim()` on the way in. That trim removes the indent this
/// listing uses to say "this entry belongs to the header above", so a second
/// pass saw a bare header with no entries under it, grouped nothing, and handed
/// back a flattened listing. `golangci-lint` turned `"\x1b:0"` into
/// `"\x1b:\n  0\n"` on one pass and `"\x1b:\n0\n"` on the next. On a real
/// capture the same thing flattens the per-file grouping of a cargo or dotnet
/// diagnostic block, which is the whole point of the grouping. Found by
/// `fuzz/fuzz_targets/minimizer_filters.rs`.
#[must_use]
pub fn is_grouped_listing(text: &str) -> bool {
	let mut lines = text.lines().peekable();
	while let Some(line) = lines.next() {
		if line.len() < 2 || line.starts_with(' ') || !line.ends_with(':') {
			continue;
		}
		let entry_follows = lines.peek().is_some_and(|next| {
			next
				.strip_prefix(GROUP_ENTRY_INDENT)
				.is_some_and(|rest| !rest.starts_with(' ') && !rest.trim().is_empty())
		});
		if entry_follows {
			return true;
		}
	}
	false
}

/// Group `file:line:message` style diagnostics by file.
///
/// A listing that is already grouped is returned untouched. Regrouping one is
/// never right: the entries have had their `file:` prefix moved to a header
/// already, so a second pass reads `line:col: message` as a file named after
/// the line number. See [`is_grouped_listing`] for how the flattening was
/// found.
#[must_use]
pub fn group_by_file(input: &str, max_per_file: usize) -> String {
	if is_grouped_listing(input) {
		return input.to_string();
	}
	let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
	let mut ungrouped = Vec::new();
	for line in input.lines() {
		if let Some((file, rest)) = split_file_line(line) {
			grouped
				.entry(file.to_string())
				.or_default()
				.push(rest.to_string());
		} else {
			ungrouped.push(line.to_string());
		}
	}
	if grouped.is_empty() {
		return input.to_string();
	}
	let mut out = String::new();
	for (file, entries) in grouped {
		out.push_str(&file);
		out.push_str(":\n");
		for entry in entries.iter().take(max_per_file) {
			out.push_str(GROUP_ENTRY_INDENT);
			out.push_str(entry);
			out.push('\n');
		}
		if entries.len() > max_per_file {
			out.push_str(GROUP_ENTRY_INDENT);
			out.push_str("… ");
			out.push_str(&(entries.len() - max_per_file).to_string());
			out.push_str(" more\n");
		}
	}
	// Grouping LIFTS lines out of the middle of the capture, so two blanks that
	// were separated by a diagnostic land next to each other in the remainder.
	// That run is an artifact of the grouping, not something the program printed,
	// and every filter downstream squeezes blank runs, so leaving it here makes
	// the answer depend on which filter runs next: the pass that groups emits the
	// run and the pass after it removes one, and the two passes disagree forever.
	let tail: String = ungrouped
		.iter()
		.flat_map(|line| [line.as_str(), "\n"])
		.collect();
	out.push_str(&collapse_blank_runs(&tail, false));
	out
}

fn split_file_line(line: &str) -> Option<(&str, &str)> {
	let (file, rest) = line.split_once(':')?;
	if file.is_empty()
		|| file.starts_with(' ')
		|| !rest.chars().next().is_some_and(|c| c.is_ascii_digit())
	{
		return None;
	}
	Some((file, rest))
}

#[must_use]
pub fn command_has_ordered_tokens(command: &str, first: &str, second: &str) -> bool {
	let mut saw_first = false;
	for part in command.split_whitespace() {
		if saw_first && part == second {
			return true;
		}
		if part == first {
			saw_first = true;
		}
	}
	false
}

#[must_use]
pub fn command_has_any_token(command: &str, tokens: &[&str]) -> bool {
	command.split_whitespace().any(|part| {
		tokens.iter().any(|token| {
			part == *token
				|| part
					.strip_prefix(*token)
					.is_some_and(|suffix| suffix.starts_with('='))
		})
	})
}

/// Dedup consecutive lines, then keep a head+tail window.
///
/// Canonical owner for the "collapse consecutive dupes, then keep head+tail"
/// shape used across the command filters; callers pass their own caps (they
/// vary per command).
#[must_use]
pub fn head_tail_dedup_capped(input: &str, head: usize, tail: usize) -> String {
	head_tail_lines(&dedup_consecutive_lines(input), head, tail)
}

/// Dedup consecutive lines then apply the default 120-head / 80-tail cap.
#[must_use]
pub fn head_tail_dedup(input: &str) -> String {
	head_tail_dedup_capped(input, 120, 80)
}

/// Keep `compacted`, unless it threw away everything a non-empty capture had.
///
/// A filter may shrink output as far as it likes. It may not answer NOTHING for
/// a command that printed something: the agent reading that output has no way
/// to tell "the command was quiet" from "the minimizer deleted it", and the
/// second reading is the one that loses work.
///
/// The paths that reshape a table are the ones that can do it. They drop border
/// lines on the way in and normalize the rest, and normalizing can turn a line
/// into a border: `aws` reduced `"-----+-- ---------\t|"` to
/// `"-----+-- ---------"` on the first pass, which is nothing but dashes,
/// pluses and spaces, so the second pass classified it as a border, dropped it,
/// and returned the empty string. Filters chain and captures get replayed, so
/// that second pass is an ordinary event.
///
/// Handing back the original is not a silent fallback: the caller's own
/// `text == input` check then reports the output as a passthrough rather than
/// as a rewrite, so the telemetry says the filter declined to minimize this
/// capture. Found by `fuzz/fuzz_targets/minimizer_filters.rs`, which asserts
/// separately from its idempotence property that a filter never turns output
/// into nothing.
#[must_use]
pub fn or_original(compacted: String, original: &str) -> String {
	// "Nothing survived" means no PROGRAM content survived, not no bytes.
	//
	// A compaction can come back holding only the minimizer's own annotations --
	// a repeat counter, an elision marker -- and that is the same answer as
	// nothing: the annotations describe output that is no longer there. Checking
	// for emptiness alone made the decision depend on whether a previous pass had
	// happened to leave an annotation in the capture, so the same text compacted
	// one way on the first pass and another on the second.
	// `"|\n|||\n-+----\n|\n|\n"` declined to compact, deduped to `"| (×2)"`, and
	// then the second pass saw that counter as the one surviving row and answered
	// `"\t(×2)"`, throwing the rest away.
	//
	// The capture it is compared against is measured on BYTES, not on program
	// content, and the difference is a second pass of the same bug. A capture that
	// has already been through a pass can be nothing but annotations itself: a psql
	// table of only borders compacts to nothing, so the capture stands, and the
	// dedup that runs after it leaves `"| -+---- (×2)"` and nothing else. Requiring
	// program content in the ORIGINAL let that capture through, and the reshaped
	// annotation won, which dropped the whitespace-only line the first pass had
	// kept. The rule is the plain one the doc comment states: a capture that
	// printed anything at all is never answered with nothing, and a repeat counter
	// standing in for output that was dropped is something. Found by
	// `fuzz/fuzz_targets/minimizer_filters.rs`.
	if !has_program_content(&compacted) && !original.trim().is_empty() {
		return original.to_string();
	}
	compacted
}

/// Collapse every run of blank lines down to a single blank line.
///
/// Canonical owner for the "squeeze repeated blank lines" shape. When
/// `trim_whitespace_only` is set, a line containing only whitespace counts as
/// blank and is emitted as an empty line (Docker/compose logs indent their
/// blank separators); when clear, only genuinely empty lines collapse and
/// whitespace-only lines pass through verbatim (the glab filter relies on
/// that). Output is line-normalized: every retained line ends in `\n`.
#[must_use]
pub fn collapse_blank_runs(input: &str, trim_whitespace_only: bool) -> String {
	let mut out = String::new();
	let mut saw_blank = false;
	for line in input.lines() {
		let is_blank = if trim_whitespace_only {
			line.trim().is_empty()
		} else {
			line.is_empty()
		};
		if is_blank {
			if !saw_blank {
				out.push('\n');
			}
			saw_blank = true;
			continue;
		}
		saw_blank = false;
		out.push_str(line);
		out.push('\n');
	}
	out
}

#[must_use]
pub fn is_markdown_badge_or_image(line: &str) -> bool {
	line.starts_with("![") || line.starts_with("[![") || line.contains("img.shields.io")
}

/// True when the line is nothing but braille spinner glyphs and spaces.
///
/// ONE OWNER FOR THE SPINNER QUESTION. `filters/js_tools.rs` had this, and
/// `filters/pkg.rs` asked it the other way round, by testing whether the line
/// CONTAINED the word `"spinner"`. That deletes program output: npm prints
/// package names, so `npm WARN deprecated cli-spinners@1.0.0` and every line
/// naming a package with `spinner` in it were dropped from what the agent saw.
/// A spinner is a GLYPH, not a word, and the glyph is what this tests.
///
/// A line with no glyphs at all answers true, which is the behaviour every
/// caller was written against: they classify already-trimmed lines and treat an
/// empty one as nothing to keep. Callers that need a blank line to survive must
/// test for it before asking this.
#[must_use]
pub fn is_spinner_frame(line: &str) -> bool {
	line
		.chars()
		.all(|ch| matches!(ch, '⠋' | '⠙' | '⠹' | '⠸' | '⠼' | '⠴' | '⠦' | '⠧' | '⠇' | '⠏' | ' '))
}

#[must_use]
pub fn is_horizontal_rule(line: &str) -> bool {
	line.len() >= 3
		&& line.chars().all(|ch| matches!(ch, '-' | '*' | '_' | ' '))
		&& line.chars().any(|ch| matches!(ch, '-' | '*' | '_'))
}

/// Compact a long plain listing to head/tail form.
///
/// A listing that already carries this function's `N entries` tally is returned
/// untouched. Every non-blank line counts as an entry below, including the
/// tally and the `…` separator, so re-compacting stacked a second header with a
/// smaller count on top of the first. See [`is_entry_count_annotation`].
#[must_use]
pub fn compact_listing(input: &str, max_lines: usize) -> String {
	if input.lines().any(is_entry_count_annotation) {
		return input.to_string();
	}
	let lines: Vec<&str> = input
		.lines()
		.filter(|line| !line.trim().is_empty())
		.collect();
	if lines.len() <= max_lines {
		return input.to_string();
	}
	let mut out = String::new();
	out.push_str(&lines.len().to_string());
	out.push_str(" entries\n");
	for line in lines.iter().take(max_lines / 2) {
		out.push_str(line);
		out.push('\n');
	}
	out.push_str("…\n");
	for line in lines.iter().skip(lines.len() - max_lines / 2) {
		out.push_str(line);
		out.push('\n');
	}
	out
}

/// Truncate a single line to at most `max_chars` characters (Unicode scalars,
/// not bytes).
///
/// When truncation happens, appends a `…[+N]` marker where `N` is the number
/// of dropped Unicode scalars. The bracketed tally lets agents and humans
/// distinguish minimizer truncation from genuine `…` in the source data
/// (see issue #1046), and gives a concrete count so the agent can decide
/// whether the missing tail is recoverable inline or needs the
/// `artifact://<id>` footer surfaced by the bash wrapper.
///
/// `max_chars == 0` is treated as "drop the line"; no marker is emitted in
/// that case since the caller asked for an empty result.
#[must_use]
pub fn truncate_line(line: &str, max_chars: usize) -> String {
	if max_chars == 0 {
		return String::new();
	}
	let mut chars = line.chars();
	let mut out = String::new();
	for _ in 0..max_chars {
		match chars.next() {
			Some(ch) => out.push(ch),
			None => return out,
		}
	}
	let dropped = chars.count();
	if dropped > 0 {
		use std::fmt::Write as _;
		// 5–6 bytes typical; this avoids pulling `itoa` for a marker tally.
		let _ = write!(out, "…[+{dropped}]");
	}
	out
}

/// Keep only the first `head` lines; append a summary marker when truncated.
#[must_use]
pub fn head_lines_only(input: &str, head: usize) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= head {
		return input.to_string();
	}
	let omitted: usize = lines[head..]
		.iter()
		.copied()
		.map(represented_line_count)
		.sum();
	let mut out = String::new();
	for line in lines.iter().take(head) {
		out.push_str(line);
		out.push('\n');
	}
	push_elision_marker(&mut out, omitted);
	out
}

/// Keep only the last `tail` lines; prepend a summary marker when truncated.
#[must_use]
pub fn tail_lines_only(input: &str, tail: usize) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= tail {
		return input.to_string();
	}
	let dropped = lines.len() - tail;
	let omitted: usize = lines[..dropped]
		.iter()
		.copied()
		.map(represented_line_count)
		.sum();
	let mut out = String::new();
	push_elision_marker(&mut out, omitted);
	for line in lines.iter().skip(dropped) {
		out.push_str(line);
		out.push('\n');
	}
	out
}

/// Hard cap: keep at most `max` lines, append a truncation marker otherwise.
#[must_use]
pub fn max_lines(input: &str, max: usize) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= max {
		return input.to_string();
	}
	let dropped: usize = lines[max..]
		.iter()
		.copied()
		.map(represented_line_count)
		.sum();
	let mut out = String::new();
	for line in lines.iter().take(max) {
		out.push_str(line);
		out.push('\n');
	}
	push_elision_marker(&mut out, dropped);
	out
}

/// Line filter combining an optional keep set and an optional strip set.
///
/// A line survives iff it matches the keep set (when present) AND does not
/// match the strip set (when present) — i.e. keep is `K AND NOT S`. An
/// absent set imposes no constraint, so pure strip and pure keep filtering
/// are the degenerate single-set cases.
#[must_use]
pub fn filter_lines_regex(
	input: &str,
	strip: Option<&regex::RegexSet>,
	keep: Option<&regex::RegexSet>,
) -> String {
	let mut out = String::new();
	for line in input.lines() {
		if keep.is_none_or(|set| set.is_match(line)) && !strip.is_some_and(|set| set.is_match(line)) {
			out.push_str(line);
			out.push('\n');
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn strips_ansi_sequences() {
		assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
	}

	#[test]
	fn strip_ansi_preserves_carriage_returns() {
		assert_eq!(strip_ansi("a\r\nb\rc"), "a\r\nb\rc");
	}

	#[test]
	fn dedups_consecutive_lines() {
		assert_eq!(dedup_consecutive_lines("a\na\nb\n"), "a (×2)\nb\n");
	}

	#[test]
	fn head_tail_marks_omitted_lines() {
		let out = head_tail_lines("1\n2\n3\n4\n5\n", 2, 1);
		assert_eq!(out, "1\n2\n[…2ln elided…]\n5\n");
	}

	#[test]
	fn named_caps_have_nonzero_reductions() {
		assert_eq!(CapClass::Errors.lines(), 160);
		assert_eq!(reduced(1, 10), 1);
		assert_eq!(reduced(0, 10), 0);
	}

	#[test]
	fn head_tail_cap_uses_named_budget() {
		let input = (0..100)
			.map(|idx| idx.to_string())
			.collect::<Vec<_>>()
			.join("\n");
		let out = head_tail_cap(&input, CapClass::List);
		assert!(out.contains("ln elided…]"));
		assert!(out.lines().count() <= CapClass::List.lines() + 1);
	}

	#[test]
	fn groups_file_diagnostics() {
		let out = group_by_file("src/a.ts:1:2 error one\nsrc/a.ts:2:3 error two\n", 10);
		assert_eq!(out, "src/a.ts:\n  1:2 error one\n  2:3 error two\n");
	}

	#[test]
	fn truncate_line_short_passes_through() {
		assert_eq!(truncate_line("hi", 10), "hi");
	}

	#[test]
	fn truncate_line_at_exact_length_emits_no_marker() {
		assert_eq!(truncate_line("abcde", 5), "abcde");
	}

	#[test]
	fn truncate_line_appends_dropped_char_tally() {
		// "abcdefghij" (10 chars) capped at 4 drops 6 chars.
		assert_eq!(truncate_line("abcdefghij", 4), "abcd\u{2026}[+6]");
	}

	#[test]
	fn truncate_line_counts_unicode_scalars_not_bytes() {
		// "aaaα" is 4 scalars, 5 bytes. Cap at 2 drops 2 scalars.
		assert_eq!(truncate_line("aaaα", 2), "aa\u{2026}[+2]");
	}

	#[test]
	fn truncate_line_max_zero_yields_empty() {
		assert_eq!(truncate_line("anything", 0), "");
	}

	#[test]
	fn filter_lines_regex_combines_keep_and_strip() {
		let strip = regex::RegexSet::new(["noise"]).unwrap();
		let keep = regex::RegexSet::new(["^task"]).unwrap();
		let input = "task ok\ntask noise\nnoise only\nunrelated\n";

		// Combined: survives iff matches keep AND NOT strip.
		assert_eq!(filter_lines_regex(input, Some(&strip), Some(&keep)), "task ok\n");
		// Strip only: absent keep set imposes no constraint.
		assert_eq!(filter_lines_regex(input, Some(&strip), None), "task ok\nunrelated\n");
		// Keep only: absent strip set imposes no constraint.
		assert_eq!(filter_lines_regex(input, None, Some(&keep)), "task ok\ntask noise\n");
		// Neither: identity modulo trailing-newline normalization.
		assert_eq!(filter_lines_regex(input, None, None), input);
	}

	#[test]
	fn test_command_has_ordered_tokens_basic() {
		assert!(command_has_ordered_tokens("glab mr diff 42", "mr", "diff"));
		assert!(
			!command_has_ordered_tokens("glab diff mr 42", "mr", "diff"),
			"wrong order must be false"
		);
		assert!(
			!command_has_ordered_tokens("glab mr", "mr", "diff"),
			"missing second token must be false"
		);
	}

	#[test]
	fn test_command_has_ordered_tokens_first_equals_second() {
		// edge case: first == second — both must appear in order
		assert!(command_has_ordered_tokens("git push push", "push", "push"));
		assert!(
			!command_has_ordered_tokens("git push", "push", "push"),
			"only one occurrence — must be false"
		);
	}

	#[test]
	fn test_command_has_any_token_equals_form() {
		// Exact token match and non-match.
		assert!(command_has_any_token("eslint --format json src", &["json"]));
		assert!(!command_has_any_token("eslint --format json src", &["xml"]));
		// Equals-form: --flag=value matches when the search token is the flag prefix.
		assert!(command_has_any_token("eslint --format=json src", &["--format"]));
		// Value-only search does NOT match an equals-form part (token is prefix, not
		// suffix).
		assert!(
			!command_has_any_token("eslint --format=json src", &["json"]),
			"value after = must not match when token is not the flag prefix"
		);
		// Substring of a standalone word must not match.
		assert!(
			!command_has_any_token("eslint --format foobar src", &["bar"]),
			"substring of a token must not match"
		);
	}

	#[test]
	fn test_horizontal_rule_requires_non_space() {
		assert!(is_horizontal_rule("---"));
		assert!(is_horizontal_rule("- - -"));
		assert!(is_horizontal_rule("***"));
		assert!(!is_horizontal_rule("   "), "whitespace-only must not be a rule");
		assert!(!is_horizontal_rule("  "), "short whitespace must not be a rule");
	}

	#[test]
	fn collapse_blank_runs_squeezes_and_respects_trim_mode() {
		// Any run of blank lines collapses to exactly one blank line; every
		// retained line is newline-terminated.
		assert_eq!(collapse_blank_runs("a\n\n\n\nb\n", true), "a\n\nb\n");
		// A single interior blank is preserved (not dropped) in both modes.
		assert_eq!(collapse_blank_runs("a\n\nb\n", false), "a\n\nb\n");
		// trim=true: a whitespace-only line counts as blank and is emitted empty
		// (the Docker/compose log semantics that owned the old private helper).
		assert_eq!(collapse_blank_runs("a\n   \n\t\nb\n", true), "a\n\nb\n");
		// trim=false: whitespace-only lines pass through verbatim and only
		// genuinely empty lines collapse (the glab filter semantics).
		assert_eq!(collapse_blank_runs("a\n   \nb\n", false), "a\n   \nb\n");
		assert_eq!(collapse_blank_runs("a\n\n\nb\n", false), "a\n\nb\n");
	}
}
