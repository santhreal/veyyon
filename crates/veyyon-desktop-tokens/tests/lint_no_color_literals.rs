//! WHY THIS SUITE EXISTS
//!
//! Section 6.4 of the desktop plan establishes that no component may reference
//! a hex value, a palette step, or a raw colour constructor. All visual colour
//! values must resolve through semantic `ColorRole` and `TintRole` tokens.
//! Hardcoded colour literals create competing sources of truth and decouple
//! components from the design system themes.
//!
//! THE CLASS THIS CLOSES: Hardcoded colour literals (such as `hsla(...)`,
//! `rgb(0x...)`, `rgba(0x...)`, or `Rgba { ... }` with literal components) in
//! non-test source code across desktop crates. The crate set is discovered at
//! runtime so newly added desktop crates are checked automatically.
//!
//! WHAT IT DOES NOT CATCH: Colour values constructed via dynamic arithmetic,
//! tokens loaded from theme TOML files, or string-based colour conversions outside
//! the scanner's pattern list.

use std::{
	fs,
	path::{Path, PathBuf},
};

/// The tokens crate's hex parser file is exempt as it converts hex strings to color types.
const EXEMPT_FILES: [&str; 1] = ["color.rs"];

#[test]
fn no_desktop_crate_writes_a_color_literal() {
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
			let is_exempt = EXEMPT_FILES.iter().any(|exempt| {
				file.file_name()
					.and_then(|n| n.to_str())
					.is_some_and(|name| name == *exempt)
			});
			if is_exempt {
				continue;
			}

			let Ok(content) = fs::read_to_string(&file) else {
				continue;
			};
			scanned_files += 1;
			scan_source(&file, &content, &mut violations);
		}
	}

	assert!(
		scanned_files > 0,
		"discovered {} desktop crate(s) but read no source file from them; the sweep is not \
		 reaching the code it claims to lint",
		targets.len(),
	);
	println!(
		"lint_no_color_literals scanned {scanned_files} file(s) across {} crate(s)",
		targets.len()
	);

	assert!(
		violations.is_empty(),
		"{} raw colour literal(s) across {scanned_files} scanned file(s). All colours must \
		 reference semantic tokens, per plan §6.4:\n{}",
		violations.len(),
		violations.join("\n"),
	);
}

#[test]
fn the_sweep_reaches_the_crates_that_hold_the_surfaces() {
	let crates_dir = workspace_crates_dir();
	let discovered: Vec<String> = discover_desktop_crates(&crates_dir)
		.iter()
		.filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(str::to_owned))
		.collect();

	assert!(
		discovered.iter().any(|name| name == "veyyon-desktop-kit"),
		"veyyon-desktop-kit is a desktop crate and must be swept; discovered {discovered:?}",
	);
	assert!(
		discovered.iter().any(|name| name == "veyyon-desktop-scene"),
		"veyyon-desktop-scene is a desktop crate and must be swept; discovered {discovered:?}",
	);
	assert!(
		discovered.iter().any(|name| name == "veyyon-desktop-surface"),
		"veyyon-desktop-surface is a desktop crate and must be swept; discovered {discovered:?}",
	);
}

#[test]
fn a_color_literal_is_recognised_and_a_token_reference_is_not() {
	let mut violations = Vec::new();
	scan_source(
		Path::new("probe.rs"),
		"let c = hsla(0.12, 0.80, 0.52, 1.0);",
		&mut violations,
	);
	assert_eq!(violations.len(), 1, "hsla literal must be caught: {violations:?}");

	let mut hex_rgb = Vec::new();
	scan_source(Path::new("probe.rs"), "let c = rgb(0xff0000);", &mut hex_rgb);
	assert_eq!(hex_rgb.len(), 1, "rgb(0x...) literal must be caught: {hex_rgb:?}");

	let mut hex_rgba = Vec::new();
	scan_source(Path::new("probe.rs"), "let c = rgba(0xff0000ff);", &mut hex_rgba);
	assert_eq!(hex_rgba.len(), 1, "rgba(0x...) literal must be caught: {hex_rgba:?}");

	let mut struct_rgba = Vec::new();
	scan_source(
		Path::new("probe.rs"),
		"let c = Rgba { r: 1.0, g: 0.0, b: 0.0, a: 1.0 };",
		&mut struct_rgba,
	);
	assert_eq!(struct_rgba.len(), 1, "Rgba {{ ... }} struct literal must be caught: {struct_rgba:?}");

	let mut ok_fn_sig = Vec::new();
	scan_source(
		Path::new("probe.rs"),
		"pub fn ground(&self) -> Rgba { self.color(ColorRole::Ground) }",
		&mut ok_fn_sig,
	);
	assert!(ok_fn_sig.is_empty(), "fn signature returning -> Rgba {{ is not a struct literal: {ok_fn_sig:?}");

	let mut ok_field_copy = Vec::new();
	scan_source(
		Path::new("probe.rs"),
		"Rgba { r: rgb.r, g: rgb.g, b: rgb.b, a: rgb.a }",
		&mut ok_field_copy,
	);
	assert!(ok_field_copy.is_empty(), "Rgba conversion from variables is not a literal: {ok_field_copy:?}");

	let mut ok = Vec::new();
	scan_source(
		Path::new("probe.rs"),
		"let c = tokens.color(ColorRole::Foreground);",
		&mut ok,
	);
	assert!(ok.is_empty(), "a token reference is not a violation: {ok:?}");

	let mut ok_helper = Vec::new();
	scan_source(
		Path::new("probe.rs"),
		"fn rgb_to_hsla(rgb: RgbColor) -> Hsla {",
		&mut ok_helper,
	);
	assert!(ok_helper.is_empty(), "helper function name is not a color literal: {ok_helper:?}");

	let mut commented = Vec::new();
	scan_source(
		Path::new("probe.rs"),
		"// hsla(0.12, 0.80, 0.52, 1.0) in comment",
		&mut commented,
	);
	assert!(commented.is_empty(), "a comment is not a violation: {commented:?}");
}

fn workspace_crates_dir() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.map_or_else(|| PathBuf::from("crates"), Path::to_path_buf)
}

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
			name.starts_with("veyyon-desktop") || name == "veyyon-gpui"
		})
		.collect();

	found.sort();
	found
}

fn is_banned_color_pattern(line: &str) -> Option<&'static str> {
	// 1. hsla(...) function call
	let mut start = 0;
	while let Some(pos) = line[start..].find("hsla(") {
		let abs_pos = start + pos;
		let is_ident = if abs_pos > 0 {
			let prev = line[..abs_pos].chars().next_back().unwrap_or(' ');
			prev.is_alphanumeric() || prev == '_'
		} else {
			false
		};
		if !is_ident {
			return Some("hsla(");
		}
		start = abs_pos + 5;
	}

	// 2. rgb(0x...
	if line.contains("rgb(0x") || line.contains("rgb(0X") {
		return Some("rgb(0x");
	}

	// 3. rgba(0x...
	if line.contains("rgba(0x") || line.contains("rgba(0X") {
		return Some("rgba(0x");
	}

	// 4. Rgba { r: ... (struct literal with literal values, not fn return type -> Rgba { or impl)
	for pattern in &["Rgba {", "Rgba{"] {
		if let Some(pos) = line.find(pattern) {
			let before = &line[..pos];
			if !before.contains("->") && !before.contains("impl") && !before.contains("struct") {
				let after = &line[pos + pattern.len()..];
				if after.chars().any(|c| c.is_ascii_digit()) {
					return Some("Rgba {");
				}
			}
		}
	}

	None
}

fn scan_source(file: &Path, content: &str, violations: &mut Vec<String>) {
	let mut in_test_module = false;

	for (line_idx, line) in content.lines().enumerate() {
		let trimmed = line.trim();
		if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') {
			continue;
		}

		if trimmed.contains("#[cfg(test)]") || trimmed.starts_with("mod tests {") || trimmed.starts_with("mod tests;") {
			in_test_module = true;
		}
		if in_test_module {
			continue;
		}

		if let Some(pattern) = is_banned_color_pattern(trimmed) {
			violations.push(format!(
				"{}:{}: contains banned colour pattern '{}'; reference semantic tokens instead",
				file.display(),
				line_idx + 1,
				pattern,
			));
		}
	}
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
