// WHY: this suite ships 65 tests that read a `test_data/` tree, and vendoring
// brought the tests across without the tree. Upstream keeps the plain files in
// git and the symlinks in `.gitignore`, created ad hoc by whichever test needs
// one, so a fresh checkout here ran `cargo test -p uu_find --lib` to 142 passed
// / 65 failed and had done since the crate landed. A third of the suite failing
// on every run is not a signal anyone reads: a real regression in `find` would
// have arrived inside that noise and been indistinguishable from it.
//
// CLASS: a vendored suite whose fixtures are not vendored is a dead gate. The
// fix is to provision the tree from code rather than from the index, so it
// cannot be lost by a copy, cannot drift from what the tests assert, and needs
// no `.gitignore` entry for the parts git will not carry (a symlink to a
// missing target, a 512-byte file, a mode). Every test that touches a fixture
// reaches it through `FakeDependencies::new` or `get_dir_entry_follow`, and
// both call `ensure_test_data`.
//
// NOT COVERED: `test_data/no_permission` (built by
// `test_no_permission_file_error` through `chmod`, because `std::fs` cannot
// drop to mode 000 as an ordinary user) and `test_data/get_or_create_file_test`
// (the subject of its own test) stay owned by their tests; this module only
// guarantees the `test_data` directory they write into exists. Nothing here
// asserts the tree is correct — the tests that read it do that, and a fixture
// that stops matching them fails them rather than this module.

use std::{fs, io, path::Path, sync::LazyLock};

/// A file the tests read but never write, and the exact size they expect of it.
const FILES: &[(&str, usize)] = &[
	("test_data/simple/abbbc", 0),
	("test_data/simple/subdir/ABBBC", 0),
	("test_data/depth/f0", 0),
	("test_data/depth/1/f1", 0),
	("test_data/depth/1/2/f2", 0),
	("test_data/depth/1/2/3/f3", 0),
	("test_data/links/abbbc", 0),
	("test_data/links/subdir/test", 0),
	("test_data/size/512bytes", 512),
];

/// A symlink the tests read, and the target it points at. The target of
/// `link-missing` does not exist and must not be created: `-L` over the tree is
/// asserted to exit 1 because of it. `link-loop` lives outside
/// `test_data/links` so that it stays out of the walks that assert the exact
/// contents of that directory.
#[cfg(unix)]
const LINKS: &[(&str, &str)] = &[
	("test_data/links/link-f", "abbbc"),
	("test_data/links/link-d", "subdir"),
	("test_data/links/link-missing", "missing"),
	("test_data/links/link-notdir", "abbbc/x"),
	("test_data/loop/link-loop", "link-loop"),
];

#[cfg(windows)]
const LINKS: &[(&str, &str)] = &[
	("test_data/links/link-f", "abbbc"),
	("test_data/links/link-missing", "missing"),
	("test_data/links/link-notdir", "abbbc/x"),
];

static PROVISIONED: LazyLock<()> = LazyLock::new(|| {
	provision().expect("could not provision the find test_data tree");
});

/// Create the `test_data` tree the suite reads, once per test process.
///
/// Cargo runs a test binary with its working directory set to the package root,
/// which is what makes the relative paths above resolve to the same tree the
/// tests name.
pub fn ensure_test_data() {
	LazyLock::force(&PROVISIONED);
}

fn provision() -> io::Result<()> {
	fs::create_dir_all("test_data")?;
	for (path, size) in FILES {
		let path = Path::new(path);
		if let Some(parent) = path.parent() {
			fs::create_dir_all(parent)?;
		}
		// Rewrite only when the size is wrong, so a run does not churn the
		// mtimes the `-newer` and `-mtime` tests compare against each other.
		let current = fs::metadata(path).map(|m| m.len() as usize).ok();
		if current != Some(*size) {
			fs::write(path, vec![0u8; *size])?;
		}
	}
	for (link, target) in LINKS {
		let link = Path::new(link);
		if let Some(parent) = link.parent() {
			fs::create_dir_all(parent)?;
		}
		match symlink(target, link) {
			Ok(()) => {},
			Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {},
			Err(e) => return Err(e),
		}
	}
	Ok(())
}

#[cfg(unix)]
fn symlink(target: &str, link: &Path) -> io::Result<()> {
	std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn symlink(target: &str, link: &Path) -> io::Result<()> {
	std::os::windows::fs::symlink_file(target, link)
}
