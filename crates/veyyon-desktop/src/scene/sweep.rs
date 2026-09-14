//! One token, k values, k token directories (§9.5).
//!
//! A candidate is the authored token set with one key rewritten, loaded
//! through the same loader the window uses. That is what keeps a sweep
//! honest: an off-scale value fails to load, naming the file and key, rather
//! than rendering a cell nothing could ship.

use std::{fs, path::Path};

use veyyon_desktop_tokens::{TokenError, Tokens, load_from_dir};

/// Why a sweep produced no candidates.
#[derive(Debug, thiserror::Error)]
pub enum SweepError {
	#[error("token must be spelled <file>:<dotted.key>, got {0}")]
	Spelling(String),
	#[error("{file} has no key {key}")]
	KeyMissing { file: String, key: String },
	#[error("{file} at {key} is a table, not a value")]
	KeyIsTable { file: String, key: String },
	#[error("{file} at {key} is a number and {value} is not")]
	NotANumber { file: String, key: String, value: String },
	#[error("{file}: {source}")]
	Toml { file: String, source: toml::de::Error },
	#[error("{file} could not be serialised: {source}")]
	Serialise { file: String, source: toml::ser::Error },
	#[error("--from {from} and --to {to} are not both numbers nor both steps of one scale")]
	Range { from: String, to: String },
	#[error("a numeric range needs at least two steps")]
	Steps,
	#[error("{path}: {source}")]
	Io { path: String, source: std::io::Error },
	#[error(transparent)]
	Tokens(#[from] TokenError),
}

/// The key one sweep rewrites.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenKey {
	/// Path relative to the tokens directory, e.g. `surface/queue.toml`.
	pub file: String,
	/// Dotted path inside the file, e.g. `geometry.card_layout.header_gap`.
	pub key:  String,
}

impl TokenKey {
	pub fn parse(spec: &str) -> Result<Self, SweepError> {
		let (file, key) = spec
			.split_once(':')
			.filter(|(file, key)| {
				Path::new(file).extension().is_some_and(|ext| ext == "toml") && !key.is_empty()
			})
			.ok_or_else(|| SweepError::Spelling(spec.to_string()))?;
		Ok(Self { file: file.to_string(), key: key.to_string() })
	}
}

/// The candidate values a range spells out.
///
/// Two numbers with `steps` produce a linear range, inclusive at both ends.
/// Two step names sharing one alphabetic prefix (`s1`, `s5`) produce every
/// step between them, inclusive; the scale decides at load whether each is
/// authored.
pub fn candidates(from: &str, to: &str, steps: u32) -> Result<Vec<String>, SweepError> {
	if let (Ok(lo), Ok(hi)) = (from.parse::<f64>(), to.parse::<f64>()) {
		if steps < 2 {
			return Err(SweepError::Steps);
		}
		let span = hi - lo;
		let last = f64::from(steps - 1);
		return Ok((0..steps)
			.map(|i| format!("{}", trim_float(lo + span * f64::from(i) / last)))
			.collect());
	}
	match (split_step(from), split_step(to)) {
		(Some((p1, lo)), Some((p2, hi))) if p1 == p2 && lo <= hi => {
			Ok((lo..=hi).map(|n| format!("{p1}{n}")).collect())
		},
		_ => Err(SweepError::Range { from: from.to_string(), to: to.to_string() }),
	}
}

/// A step name as its alphabetic prefix and its number: `s3` is `("s", 3)`.
fn split_step(s: &str) -> Option<(String, u32)> {
	let digits_at = s.find(|c: char| c.is_ascii_digit())?;
	let (prefix, digits) = s.split_at(digits_at);
	if prefix.is_empty() {
		return None;
	}
	Some((prefix.to_string(), digits.parse().ok()?))
}

/// A float with the trailing noise of a division removed.
fn trim_float(value: f64) -> f64 {
	(value * 1_000_000.0).round() / 1_000_000.0
}

/// Writes one candidate: the authored set copied under `dir`, with `key`
/// rewritten to `value`, then loaded.
pub fn materialise(
	tokens_dir: &Path,
	dir: &Path,
	key: &TokenKey,
	value: &str,
) -> Result<Tokens, SweepError> {
	copy_tree(tokens_dir, dir)?;
	let path = dir.join(&key.file);
	let io = |source| SweepError::Io { path: path.display().to_string(), source };
	let text = fs::read_to_string(&path).map_err(io)?;
	let mut table: toml::Table = text
		.parse()
		.map_err(|source| SweepError::Toml { file: key.file.clone(), source })?;
	rewrite(&mut table, key, value)?;
	let text = toml::to_string(&table)
		.map_err(|source| SweepError::Serialise { file: key.file.clone(), source })?;
	fs::write(&path, text).map_err(io)?;
	Ok(load_from_dir(dir)?)
}

/// Sets the value at a dotted key, keeping the value's authored type: a
/// number stays a number, a step name stays a string.
fn rewrite(table: &mut toml::Table, key: &TokenKey, value: &str) -> Result<(), SweepError> {
	let missing = || SweepError::KeyMissing { file: key.file.clone(), key: key.key.clone() };
	let mut parts = key.key.split('.').peekable();
	let mut current = table;
	while let Some(part) = parts.next() {
		if parts.peek().is_some() {
			current = current
				.get_mut(part)
				.and_then(toml::Value::as_table_mut)
				.ok_or_else(missing)?;
			continue;
		}
		let slot = current.get_mut(part).ok_or_else(missing)?;
		*slot = match (&*slot, value.parse::<i64>(), value.parse::<f64>()) {
			(toml::Value::Integer(_), Ok(n), _) => toml::Value::Integer(n),
			(toml::Value::Integer(_) | toml::Value::Float(_), _, Ok(f)) => toml::Value::Float(f),
			(toml::Value::Integer(_) | toml::Value::Float(_), _, Err(_)) => {
				return Err(SweepError::NotANumber {
					file:  key.file.clone(),
					key:   key.key.clone(),
					value: value.to_string(),
				});
			},
			(toml::Value::String(_), ..) => toml::Value::String(value.to_string()),
			(toml::Value::Boolean(_), ..) => toml::Value::Boolean(value == "true"),
			(toml::Value::Table(_), ..) => {
				return Err(SweepError::KeyIsTable { file: key.file.clone(), key: key.key.clone() });
			},
			(toml::Value::Array(_) | toml::Value::Datetime(_), ..) => return Err(missing()),
		};
		return Ok(());
	}
	Err(missing())
}

/// Copies every `.toml` file at the top level and under `surface/`, which is
/// the whole authored set the loader reads.
fn copy_tree(from: &Path, to: &Path) -> Result<(), SweepError> {
	let io = |path: &Path, source| SweepError::Io { path: path.display().to_string(), source };
	for sub in ["", "surface"] {
		let src = from.join(sub);
		let dst = to.join(sub);
		fs::create_dir_all(&dst).map_err(|e| io(&dst, e))?;
		for entry in fs::read_dir(&src).map_err(|e| io(&src, e))? {
			let entry = entry.map_err(|e| io(&src, e))?;
			let path = entry.path();
			if path.extension().is_some_and(|ext| ext == "toml") {
				let target = dst.join(entry.file_name());
				fs::copy(&path, &target).map_err(|e| io(&target, e))?;
			}
		}
	}
	Ok(())
}
