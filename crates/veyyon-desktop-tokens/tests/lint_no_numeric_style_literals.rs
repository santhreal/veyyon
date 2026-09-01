//! WHY THIS SUITE EXISTS
//!
//! Section 9.3 of the desktop plan rests the whole iteration engine on one
//! rule: no numeric literal sits in a style position outside the token loader.
//! A single `.gap(11.0)` is invisible in review, survives every spacing pass,
//! and is exactly how a surface ends up with nine gap values.
//!
//! The first version of this lint named two crates that do not exist yet,
//! `veyyon-desktop-kit` and `veyyon-desktop-surface`, and skipped a target
//! directory that was missing. It therefore scanned zero files and passed for
//! that reason alone. A lint that cannot fail is worse than no lint, because it
//! reports the property as defended.
//!
//! THE CLASS THIS CLOSES: a style literal anywhere in the desktop crates, and
//! the lint going quiet. The crate set is discovered from the workspace at run
//! time rather than hardcoded, so a desktop crate added next month is swept
//! without anyone remembering this file. The sweep asserts it actually read
//! something, so an empty scan is a failure rather than a pass.
//!
//! WHAT IT DOES NOT CATCH: a literal bound to a variable first
//! (`let g = 11.0; ... .gap(g)`), arithmetic that is not a style call, a call
//! written across two lines, and a nested call whose argument list contains
//! parentheses, where the argument is read up to the first `)` and simply does
//! not parse as a number. Those are false negatives by construction: this scan
//! is a line-oriented lint, not a parse of the crate. It also cannot judge
//! whether a token reference is the *right* token, only that a raw number is
//! not standing in for one.

use std::{
	fs,
	path::{Path, PathBuf},
};

/// Style-position methods a raw number must never reach.
const BANNED_METHODS: [&str; 6] =
	["margin", "padding", "rounded", "border", "gap", "corner_radius"];

/// The tokens crate is the loader: numbers are its subject matter, and the
/// scale it defines is the thing every other crate references instead.
const EXEMPT_CRATES: [&str; 1] = ["veyyon-desktop-tokens"];

#[test]
fn no_desktop_crate_puts_a_raw_number_in_a_style_position() {
	let crates_dir = workspace_crates_dir();
	let targets = discover_desktop_crates(&crates_dir);

	assert!(
		!targets.is_empty(),
		"discovered no desktop crates under {}. The lint scanned nothing, which is a failure and \
		 not a pass.",
		crates_dir.display(),
	);

	let mut scanned_files = 0usize;
	let mut violations = Vec::new();

	for crate_dir in &targets {
		let src = crate_dir.join("src");
		if !src.is_dir() {
			continue;
		}
		let mut files = Vec::new();
		collect_rs_files(&src, &mut files);
		files.sort();

		for file in files {
			let Ok(content) = fs::read_to_string(&file) else {
				continue;
			};
			scanned_files += 1;
			scan_source(&file, &content, &mut violations);
		}
	}
	println!(
		"lint_no_numeric_style_literals scanned {scanned_files} file(s) across {} crate(s)",
		targets.len()
	);

	assert!(
		scanned_files > 0,
		"discovered {} desktop crate(s) but read no source file from them; the sweep is not \
		 reaching the code it claims to lint",
		targets.len(),
	);

	assert!(
		violations.is_empty(),
		"{} raw numeric style literal(s) across {scanned_files} scanned file(s). Every style value \
		 references the scale in tokens/, per plan §9.3:\n{}",
		violations.len(),
		violations.join("\n"),
	);
}

#[test]
fn the_sweep_reaches_the_crates_that_hold_the_surfaces() {
	// The lint is only meaningful over the crates that draw. This pins the
	// discovery rule itself: a desktop crate is in scope unless it is exempt,
	// so renaming or adding one cannot quietly drop it from the sweep.
	let crates_dir = workspace_crates_dir();
	let discovered: Vec<String> = discover_desktop_crates(&crates_dir)
		.iter()
		.filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(str::to_owned))
		.collect();

	assert!(
		discovered.iter().any(|name| name == "veyyon-desktop-scene"),
		"veyyon-desktop-scene is a desktop crate and must be swept; discovered {discovered:?}",
	);
	assert!(
		discovered
			.iter()
			.any(|name| name == "veyyon-desktop-surface"),
		"veyyon-desktop-surface is a desktop crate and must be swept; discovered {discovered:?}",
	);
	assert!(
		!discovered
			.iter()
			.any(|name| name == "veyyon-desktop-tokens"),
		"the tokens crate defines the scale and is exempt; discovered {discovered:?}",
	);
}

#[test]
fn a_raw_style_literal_is_recognised_and_a_token_reference_is_not() {
	// Mutation gate for the matcher itself. Without this, the sweep could scan
	// every file and still recognise nothing.
	let mut violations = Vec::new();
	scan_source(Path::new("probe.rs"), "let x = div().gap(11.0);", &mut violations);
	assert_eq!(violations.len(), 1, "a raw literal must be caught: {violations:?}");

	let mut integer = Vec::new();
	scan_source(Path::new("probe.rs"), "let x = div().padding(8);", &mut integer);
	assert_eq!(integer.len(), 1, "a bare integer must be caught: {integer:?}");

	let mut wrapped = Vec::new();
	scan_source(Path::new("probe.rs"), "let x = div().margin(px(4.0));", &mut wrapped);
	assert_eq!(wrapped.len(), 1, "px() around a literal must be caught: {wrapped:?}");

	let mut ok = Vec::new();
	scan_source(Path::new("probe.rs"), "let x = div().gap(tokens.spacing(S3));", &mut ok);
	assert!(ok.is_empty(), "a token reference is not a violation: {ok:?}");

	let mut commented = Vec::new();
	scan_source(Path::new("probe.rs"), "// .gap(11.0) in a comment is not code", &mut commented);
	assert!(commented.is_empty(), "a comment is not a violation: {commented:?}");
}

fn workspace_crates_dir() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.map_or_else(|| PathBuf::from("crates"), Path::to_path_buf)
}

/// Every desktop crate present in the workspace, minus the exempt ones. Derived
/// from the directory rather than a list, so a new crate is covered on sight.
fn discover_desktop_crates(crates_dir: &Path) -> Vec<PathBuf> {
	let Ok(entries) = fs::read_dir(crates_dir) else {
		return Vec::new();
	};

	let mut found: Vec<PathBuf> = entries
		.flatten()
		.map(|entry| entry.path())
		.filter(|path| path.is_dir())
		.filter(|path| {
			let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
				return false;
			};
			let is_desktop = name.starts_with("veyyon-desktop") || name == "veyyon-gpui";
			is_desktop && !EXEMPT_CRATES.contains(&name)
		})
		.collect();

	found.sort();
	found
}

fn scan_source(file: &Path, content: &str, violations: &mut Vec<String>) {
	for (line_idx, line) in content.lines().enumerate() {
		let trimmed = line.trim();
		if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') {
			continue;
		}

		for method in &BANNED_METHODS {
			let pattern = format!(".{method}(");
			let Some(pos) = trimmed.find(&pattern) else {
				continue;
			};
			let after = &trimmed[pos + pattern.len()..];
			let Some(arg) = balanced_argument(after) else {
				continue;
			};
			if is_raw_numeric_literal(arg) {
				violations.push(format!(
					"{}:{}: .{method}({arg}) is a raw number in a style position; reference the scale \
					 instead",
					file.display(),
					line_idx + 1,
				));
			}
		}
	}
}

/// The argument text up to the `)` that closes the call, so a nested call such
/// as `px(4.0)` arrives whole rather than truncated at its own parenthesis.
fn balanced_argument(after_open: &str) -> Option<&str> {
	let mut depth = 0usize;
	for (index, ch) in after_open.char_indices() {
		match ch {
			'(' => depth += 1,
			')' if depth == 0 => return after_open.get(..index).map(str::trim),
			')' => depth -= 1,
			_ => {},
		}
	}
	None
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.is_dir() {
			collect_rs_files(&path, out);
		} else if path.extension().is_some_and(|ext| ext == "rs") {
			out.push(path);
		}
	}
}

fn is_raw_numeric_literal(arg: &str) -> bool {
	let candidate = arg.trim();
	if candidate.parse::<f64>().is_ok() {
		return true;
	}

	// `px(4.0)` is the same defect wearing a constructor.
	let Some(inner) = candidate
		.strip_prefix("px(")
		.and_then(|rest| rest.strip_suffix(')'))
	else {
		return false;
	};
	inner.trim().parse::<f64>().is_ok()
}
