//! The canonical conformance case record, its identity function, and the
//! materializer that writes a corpus of them.
//!
//! A case is a self-contained JSONL row. It says which subsystem and contract
//! it belongs to, which production target executes it (migrated Rust, or the
//! compiled release artifact), the normalized dimensions it occupies, the
//! stimulus to apply, and the exact oracle to judge the result against. It
//! never carries an observation: an execution result is a separate report, so a
//! run cannot rewrite the committed expectation it failed.
//!
//! The identity of a case is the BLAKE3 digest of its semantics — subsystem,
//! contract, target kind, dimensions, environment, stimulus, oracle — and of
//! nothing else. Generator metadata, coverage labels, provenance and the digest
//! itself are excluded, so two generators cannot claim distinct coverage for
//! one behaviour, and re-seeding a generator cannot inflate the corpus.

pub mod manifest;
pub mod shard;

use std::{collections::BTreeMap, fmt};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// The corpus schema version. Bumped when a field's meaning changes; a row
/// carrying an unknown version is refused rather than guessed at.
pub const SCHEMA_VERSION: u32 = 1;

/// Which production path executes a case.
///
/// There is no third kind on purpose. A case that neither calls migrated
/// production Rust nor launches the shipped artifact would be testing a
/// stand-in, which is the failure mode this whole crate exists to end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TargetKind {
	/// Calls a migrated production Rust crate in-process, under virtual time.
	DirectRust,
	/// Launches the unmodified release artifact across a process boundary.
	CompiledProduct,
}

impl TargetKind {
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::DirectRust => "direct-rust",
			Self::CompiledProduct => "compiled-product",
		}
	}
}

impl fmt::Display for TargetKind {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.as_str())
	}
}

/// The platform a case runs on. `Any` runs once on the Linux pool rather than
/// once per operating system; every other value runs only on a matching runner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Platform {
	Any,
	LinuxX64,
	LinuxArm64,
	MacosX64,
	MacosArm64,
	WindowsX64,
}

impl Platform {
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Any => "any",
			Self::LinuxX64 => "linux-x64",
			Self::LinuxArm64 => "linux-arm64",
			Self::MacosX64 => "macos-x64",
			Self::MacosArm64 => "macos-arm64",
			Self::WindowsX64 => "windows-x64",
		}
	}

	/// Every platform a case record may name, in manifest order.
	#[must_use]
	pub const fn all() -> [Self; 6] {
		[
			Self::Any,
			Self::LinuxX64,
			Self::LinuxArm64,
			Self::MacosX64,
			Self::MacosArm64,
			Self::WindowsX64,
		]
	}
}

impl fmt::Display for Platform {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.as_str())
	}
}

/// How time is delivered to a case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClockMode {
	/// Virtual monotonic time and a deterministic scheduler.
	Virtual,
	/// The production clock, with a short real deadline and a bound asserted
	/// rather than an exact elapsed time.
	RealBounded,
}

/// The subsystem a case belongs to. The discriminants are the manifest's ids
/// and are part of the case identity, so they are pinned rather than
/// positional.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Subsystem {
	RenderingTerminalUi,
	AiProvidersStreaming,
	ToolExecutionRuntime,
	SessionTreeEngine,
	PersistenceMnemopi,
	ConcurrencyAgentMesh,
	SecuritySandbox,
	CliEngineModes,
	InstallersDistribution,
	NativeServicesWorkers,
	ConfigurationSettings,
	ContextCompaction,
	MemoryEngineVectors,
	EditingHashlineEngine,
	LspClientDiagnostics,
	WireProtocolArgot,
}

/// Where a case came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provenance {
	/// Produced by one of the generator families.
	Generated,
	/// A structural fixture reduced from a production incident. The incident's
	/// text never enters the corpus; only its semantic key does.
	IncidentDerived,
}

/// A content-addressed fixture reference.
///
/// The corpus never inlines a fixture body: a row names a digest, and
/// materialization refuses a digest it cannot resolve, so a corpus cannot
/// reference bytes nobody has.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FixtureRef(pub String);

impl FixtureRef {
	/// The reference for a body, which is how a generator names what it just
	/// produced.
	#[must_use]
	pub fn of(bytes: &[u8]) -> Self {
		Self(format!("blake3:{}", blake3::hash(bytes).to_hex()))
	}

	#[must_use]
	pub fn as_str(&self) -> &str {
		&self.0
	}

	/// A reference is well formed when it names an algorithm this crate can
	/// check. Anything else is refused at materialization rather than resolved
	/// later against whatever happens to be on disk.
	#[must_use]
	pub fn is_well_formed(&self) -> bool {
		let Some(hex) = self.0.strip_prefix("blake3:") else {
			return false;
		};
		hex.len() == 64
			&& hex
				.bytes()
				.all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeneratorInfo {
	/// The generator family that produced the row, for triage and for
	/// regenerating one family without touching the rest.
	pub family: String,
	/// The deterministic seed the row came from.
	pub seed:   u64,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Contract {
	/// Stable dotted id, e.g. `provider.clean-eof.complete-tool-batch`.
	pub id:                String,
	/// The structured error this case expects, or `None` for a success contract.
	/// The count of rows carrying one is part of the manifest.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub expected_error_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Target {
	pub kind:  TargetKind,
	/// The production entry point: a migrated Rust path, or the artifact name.
	pub entry: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Environment {
	pub platform:           Platform,
	pub clock:              ClockMode,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub filesystem_fixture: Option<FixtureRef>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub provider_fixture:   Option<FixtureRef>,
}

/// One thing done to the product, in order.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Stimulus {
	pub kind:  String,
	pub value: String,
}

/// The exact expectation. Every field a contract does not constrain is absent
/// rather than defaulted, so an oracle cannot silently accept a wider outcome
/// than the one it was written for.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Oracle {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub exit_code:               Option<i32>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub stop_reason:             Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub error_id:                Option<String>,
	/// The bound a deadline case terminates within. Present on every case whose
	/// contract has a deadline, retry, or queue: a case that can only observe a
	/// wrong value cannot see a hang.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub max_ms:                  Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub stdout_fixture:          Option<FixtureRef>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub persisted_state_fixture: Option<FixtureRef>,
	/// Tool name to exact execution count. A map rather than a list so the
	/// expectation is order-free and cannot be satisfied by a different tool.
	#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
	pub tool_executions:         BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Coverage {
	/// Registry members this case claims, enumerated from production at
	/// generation time (`api:openai-completions`, `tool:bash`).
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub registry_members: Vec<String>,
	/// Requirement ids this case discharges.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub requirements:     Vec<String>,
}

/// One materialized conformance case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformanceCase {
	pub schema_version: u32,
	/// `blake3:<hex>` over the identity payload. Recomputed and compared on
	/// load; a row whose id does not match its own semantics is refused.
	pub case_id:        String,
	pub generator:      GeneratorInfo,
	pub subsystem:      Subsystem,
	pub contract:       Contract,
	pub target:         Target,
	/// Normalized dimension axes. A `BTreeMap` because the identity digest is
	/// taken over the serialized form: an insertion-ordered map would give one
	/// case two ids depending on which generator built it.
	pub dimensions:     BTreeMap<String, String>,
	pub environment:    Environment,
	pub stimulus:       Vec<Stimulus>,
	pub oracle:         Oracle,
	#[serde(default)]
	pub coverage:       Coverage,
	pub provenance:     Provenance,
}

/// The semantics a case id is taken over. Serialized on its own so the excluded
/// fields cannot drift back in by accident: adding a field to
/// [`ConformanceCase`] does not change any id unless it is named here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityPayload<'a> {
	schema_version: u32,
	subsystem:      &'a Subsystem,
	contract:       &'a Contract,
	target_kind:    TargetKind,
	dimensions:     &'a BTreeMap<String, String>,
	environment:    &'a Environment,
	stimulus:       &'a [Stimulus],
	oracle:         &'a Oracle,
}

impl ConformanceCase {
	/// The id this case's semantics imply, whatever `case_id` currently says.
	#[must_use]
	pub fn computed_case_id(&self) -> String {
		let payload = IdentityPayload {
			schema_version: self.schema_version,
			subsystem:      &self.subsystem,
			contract:       &self.contract,
			target_kind:    self.target.kind,
			dimensions:     &self.dimensions,
			environment:    &self.environment,
			stimulus:       &self.stimulus,
			oracle:         &self.oracle,
		};
		// `serde_json` writes struct fields in declaration order and `BTreeMap`
		// in key order, so this byte string is canonical for a given payload
		// without a separate canonicalizer.
		let bytes = serde_json::to_vec(&payload)
			.expect("identity payload is plain data and always serializes");
		format!("blake3:{}", blake3::hash(&bytes).to_hex())
	}

	/// Stamp the id the semantics imply. Called by a generator once, at the end
	/// of building a row.
	pub fn seal(mut self) -> Self {
		self.case_id = self.computed_case_id();
		self
	}

	/// Every reason this row cannot be materialized, in the order they are
	/// checked. Empty means the row is admissible.
	#[must_use]
	pub fn violations(&self) -> Vec<String> {
		let mut problems = Vec::new();
		if self.schema_version != SCHEMA_VERSION {
			problems.push(format!(
				"unknown schemaVersion {} (this build materializes {SCHEMA_VERSION})",
				self.schema_version
			));
		}
		let computed = self.computed_case_id();
		if self.case_id != computed {
			problems
				.push(format!("caseId {} does not match its semantics ({computed})", self.case_id));
		}
		if self.contract.id.is_empty() {
			problems.push("contract id is empty".to_owned());
		}
		if self.target.entry.is_empty() {
			problems.push("target entry is empty".to_owned());
		}
		if self.stimulus.is_empty() {
			problems.push("a case with no stimulus cannot exercise anything".to_owned());
		}
		for fixture in self.fixtures() {
			if !fixture.is_well_formed() {
				problems.push(format!("fixture reference {} is not a blake3 digest", fixture.as_str()));
			}
		}
		match (self.target.kind, self.environment.clock) {
			// A compiled case cannot be given virtual time: the harness is
			// outside the process and cannot advance a clock it does not own.
			(TargetKind::CompiledProduct, ClockMode::Virtual) => {
				problems.push("a compiled-product case cannot run on virtual time".to_owned());
			},
			// The mirror of the same rule: a direct case runs under the
			// deterministic scheduler, so a real-time bound would make it flaky
			// by construction.
			(TargetKind::DirectRust, ClockMode::RealBounded) => {
				problems.push("a direct-rust case cannot run on real bounded time".to_owned());
			},
			_ => {},
		}
		if self.target.kind == TargetKind::CompiledProduct
			&& self.environment.platform == Platform::Any
		{
			problems.push("a compiled-product case must name the platform it launches on".to_owned());
		}
		if self.contract.expected_error_id.is_some() != self.oracle.error_id.is_some() {
			problems
				.push("expectedErrorId and the oracle's errorId must be present together".to_owned());
		}
		if let (Some(contract_error), Some(oracle_error)) =
			(&self.contract.expected_error_id, &self.oracle.error_id)
			&& contract_error != oracle_error
		{
			problems.push(format!(
				"contract expects {contract_error} but the oracle expects {oracle_error}"
			));
		}
		problems
	}

	/// Every fixture this row references.
	fn fixtures(&self) -> Vec<&FixtureRef> {
		let mut refs = Vec::new();
		refs.extend(self.environment.filesystem_fixture.as_ref());
		refs.extend(self.environment.provider_fixture.as_ref());
		refs.extend(self.oracle.stdout_fixture.as_ref());
		refs.extend(self.oracle.persisted_state_fixture.as_ref());
		refs
	}

	/// True when this row carries an exact expected-error contract, which the
	/// manifest counts separately from the case total.
	#[must_use]
	pub const fn is_expected_error(&self) -> bool {
		self.contract.expected_error_id.is_some()
	}
}

/// A corpus in memory, sorted by case id and free of semantic duplicates.
#[derive(Debug, Default)]
pub struct Corpus {
	cases: Vec<ConformanceCase>,
}

impl Corpus {
	#[must_use]
	pub const fn new() -> Self {
		Self { cases: Vec::new() }
	}

	/// Admit one case, or say why not.
	///
	/// A duplicate is an error rather than a silent replace: two generators
	/// producing the same semantic case means the corpus is smaller than its
	/// count claims, and that is exactly the drift the count exists to catch.
	pub fn insert(&mut self, case: ConformanceCase) -> Result<()> {
		let problems = case.violations();
		if !problems.is_empty() {
			bail!("case {} is not admissible: {}", case.case_id, problems.join("; "));
		}
		match self
			.cases
			.binary_search_by(|existing| existing.case_id.cmp(&case.case_id))
		{
			Ok(_) => bail!("duplicate semantic case {}", case.case_id),
			Err(index) => {
				self.cases.insert(index, case);
				Ok(())
			},
		}
	}

	#[must_use]
	pub const fn len(&self) -> usize {
		self.cases.len()
	}

	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.cases.is_empty()
	}

	#[must_use]
	pub const fn cases(&self) -> &[ConformanceCase] {
		self.cases.as_slice()
	}

	/// The corpus as JSONL, sorted by case id, one row per line.
	#[must_use]
	pub fn to_jsonl(&self) -> String {
		let mut out = String::new();
		for case in &self.cases {
			let line =
				serde_json::to_string(case).expect("a case is plain data and always serializes");
			out.push_str(&line);
			out.push('\n');
		}
		out
	}

	/// Read a corpus back, checking every row against the same rules
	/// materialization applied.
	pub fn from_jsonl(text: &str) -> Result<Self> {
		let mut corpus = Self::new();
		for (index, line) in text.lines().enumerate() {
			if line.trim().is_empty() {
				continue;
			}
			let case: ConformanceCase = serde_json::from_str(line)
				.with_context(|| format!("corpus line {} is not a case record", index + 1))?;
			corpus
				.insert(case)
				.with_context(|| format!("corpus line {}", index + 1))?;
		}
		Ok(corpus)
	}
}
