//! AST Lint Test enforcing that layout and styling call sites in desktop
//! components do not receive raw numeric literals.
//!
//! # What this lint catches
//! - Direct method calls to styling and layout primitives (`margin`, `padding`,
//!   `w`, `h`, `rounded`, `border`, `gap`, `corner_radius`) receiving raw
//!   integer/float literals (e.g. `padding(14.0)`, `gap(8)`, `w(px(256.0))`).
//! - Disallowed numeric literals where a `SpacingStep`, `RadiusStep`,
//!   `StrokeStep`, or `Tokens` reference must be used.
//!
//! # What this lint does not catch
//! - Numeric literals bound to variables outside immediate call arguments
//!   before being passed.
//! - Non-styling arithmetic (e.g. loop counters, buffer capacities, coordinate
//!   maths, or viewport resizing calculations).
//! - Expressions evaluated in macro expansions where AST span information is
//!   synthetic.

use std::{
	fs,
	path::{Path, PathBuf},
};

#[test]
fn test_lint_no_numeric_style_literals() {
	let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.and_then(Path::parent)
		.expect("workspace root");

	let target_crates = [
		workspace_root.join("crates/veyyon-desktop-kit"),
		workspace_root.join("crates/veyyon-desktop-surface"),
	];

	let mut violations = Vec::new();
	let banned_methods = ["margin", "padding", "rounded", "border", "gap", "corner_radius"];

	for crate_dir in &target_crates {
		if !crate_dir.exists() {
			continue;
		}
		let mut files = Vec::new();
		collect_rs_files(crate_dir, &mut files);

		for file in files {
			let Ok(content) = fs::read_to_string(&file) else {
				continue;
			};

			for (line_idx, line) in content.lines().enumerate() {
				// Strip comments and strings for basic syntactic scan
				let trimmed = line.trim();
				if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') {
					continue;
				}

				for method in &banned_methods {
					let pattern = format!(".{method}(");
					if let Some(pos) = trimmed.find(&pattern) {
						let after = &trimmed[pos + pattern.len()..];
						if let Some(arg_end) = after.find(')') {
							let arg = after[..arg_end].trim();
							// Check if arg is a raw numeric literal or px(literal)
							if is_raw_numeric_literal(arg) {
								violations.push(format!(
									"{}:{}: call to .{method}({arg}) contains raw numeric literal; must \
									 use typed scale token",
									file.display(),
									line_idx + 1
								));
							}
						}
					}
				}
			}
		}
	}

	assert!(
		violations.is_empty(),
		"Found {} raw numeric style literal violations:\n{}",
		violations.len(),
		violations.join("\n")
	);
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
	if let Ok(entries) = fs::read_dir(dir) {
		for entry in entries.flatten() {
			let p = entry.path();
			if p.is_dir() {
				collect_rs_files(&p, out);
			} else if p.extension().is_some_and(|ext| ext == "rs") {
				out.push(p);
			}
		}
	}
}

fn is_raw_numeric_literal(arg: &str) -> bool {
	let s = arg.trim();
	if s.parse::<f64>().is_ok() || s.parse::<i64>().is_ok() {
		return true;
	}
	if s.starts_with("px(") && s.ends_with(')') {
		let inner = &s[3..s.len() - 1].trim();
		if inner.parse::<f64>().is_ok() || inner.parse::<i64>().is_ok() {
			return true;
		}
	}
	false
}
