//! WHY: the desktop crates carry a 400-line file ceiling, and nothing held it.
//! Five suites grew to 501–844 lines and one source module to 414 before an
//! audit read the tree by hand. A ceiling that a reader enforces is not one.
//!
//! CLASS CLOSED: any Rust file under the eight desktop crates that exceeds
//! the ceiling, in `src`, `tests`, `benches`, `examples` or a build script.
//! The crates are found by walking `crates/` for the `veyyon-desktop` prefix
//! and the renderer fork, so a ninth crate is held to the ceiling the moment
//! it exists; a file is found by walking each crate, so a new module is held
//! without an edit here.
//!
//! NOT CAUGHT: a file that keeps under the ceiling by putting many statements
//! on one line, and the vendored crates under `crates/vendor`, which are not
//! this product's to shape.

use std::{
	fs,
	path::{Path, PathBuf},
};

/// The line count a file may reach; the count above it fails.
const CEILING: usize = 400;

/// The crates the ceiling covers, by directory name.
fn is_desktop_crate(name: &str) -> bool {
	name.starts_with("veyyon-desktop") || name == "veyyon-gpui"
}

/// The directories under a crate that hold Rust the ceiling covers.
const SOURCE_ROOTS: [&str; 4] = ["src", "tests", "benches", "examples"];

fn rust_files_under(dir: &Path, out: &mut Vec<PathBuf>) {
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.is_dir() {
			rust_files_under(&path, out);
		} else if path.extension().is_some_and(|ext| ext == "rs") {
			out.push(path);
		}
	}
}

#[test]
fn every_rust_file_in_the_desktop_crates_is_at_or_under_the_ceiling() {
	let crates_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.expect("the crate sits under crates/")
		.to_path_buf();

	let mut crates: Vec<PathBuf> = fs::read_dir(&crates_dir)
		.expect("crates/ is readable")
		.flatten()
		.map(|entry| entry.path())
		.filter(|path| {
			path.is_dir()
				&& path
					.file_name()
					.and_then(|name| name.to_str())
					.is_some_and(is_desktop_crate)
		})
		.collect();
	crates.sort();
	assert_eq!(crates.len(), 8, "the eight desktop crates of §8.1 were not all found: {crates:?}");

	let mut files = Vec::new();
	for krate in &crates {
		for root in SOURCE_ROOTS {
			rust_files_under(&krate.join(root), &mut files);
		}
		let build = krate.join("build.rs");
		if build.is_file() {
			files.push(build);
		}
	}
	files.sort();
	assert!(
		files.len() > 100,
		"the walk found {} files, which is not the desktop tree",
		files.len()
	);

	let mut over: Vec<String> = files
		.iter()
		.filter_map(|path| {
			let lines = fs::read_to_string(path)
				.unwrap_or_else(|err| panic!("{} is unreadable: {err}", path.display()))
				.lines()
				.count();
			(lines > CEILING).then(|| {
				format!("{} is {lines} lines", path.strip_prefix(&crates_dir).unwrap_or(path).display())
			})
		})
		.collect();
	over.sort();
	assert!(
		over.is_empty(),
		"{} file(s) exceed the {CEILING}-line ceiling; split each into modules that own one \
		 concern:\n{}",
		over.len(),
		over.join("\n")
	);
}
