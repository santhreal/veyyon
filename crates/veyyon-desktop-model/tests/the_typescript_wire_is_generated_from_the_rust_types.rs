//! WHY THIS SUITE EXISTS
//!
//! The TypeScript GUI host compiles against a description of the wire, and the
//! desktop reads that wire through the serde derives in this crate. Two
//! descriptions written by hand drift: a field made optional on one side, an
//! action listed in one order here and another there, a variant the host
//! declared as `string | Record<string, unknown>` so that nothing it sent was
//! checked at all.
//!
//! THE CLASS THIS CLOSES: any difference between a type reachable from
//! `HostEvent` or `HostRequest` and the declaration the host compiles against,
//! and any difference between a Rust enum and the runtime array the host sweeps
//! it with. `packages/coding-agent/src/gui-host/wire.generated.ts` is produced
//! here by walking the dependency graph of the two roots, so a type, field,
//! variant or array member added in Rust changes the expected bytes and fails
//! this test until the file is regenerated and the host type-checks against it.
//!
//! WHAT IT DOES NOT CATCH: a `#[ts(type = "...")]` override that names the
//! wrong TypeScript type. Three types are owned by TypeScript and imported
//! rather than generated (`ToolView`, `TodoStatus`, `AgentDisplayState`), and
//! the fields that hold them, the base64 attachment payload and every
//! `serde_json::Value` state their TypeScript type by hand. The shared corpus
//! in `tests/fixtures/snapshot-sections.json` is decoded on both sides, which
//! is what checks those overrides against real frames.

use std::{
	any::TypeId,
	collections::{BTreeMap, HashSet},
	fmt::Write as _,
	fs,
	path::PathBuf,
};

use serde::Serialize;
use strum::IntoEnumIterator;
use ts_rs::{Config, TS, TypeVisitor};
use veyyon_desktop_model::{
	AgentMessageOutcome, AutoswarmAction, AutoswarmFieldKind, Capability, DictationState,
	GoalControl, GoalStatus, HostActionKind, HostEvent, HostRequest, PROTOCOL_VERSION,
	SessionTreeEntryKind, SessionTreeFilter, SettableMode, SharePhase, ShareRole,
	SnapshotSectionKind, action_to_capability, domain::ExportFormat,
};

/// The command that rewrites the generated file.
const REGENERATE: &str = concat!(
	"UPDATE_WIRE=1 cargo test -p veyyon-desktop-model ",
	"--test the_typescript_wire_is_generated_from_the_rust_types",
);

/// Types TypeScript owns, with the module each is imported from. The fields
/// that hold them carry a `#[ts(type)]` override naming them.
const IMPORTED: [(&str, &str); 3] = [
	("ToolView", "@veyyon/view"),
	("TodoStatus", "@veyyon/wire"),
	("AgentDisplayState", "../registry/live-roster"),
];

fn generated_path() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../../packages/coding-agent/src/gui-host/wire.generated.ts")
}

/// Walks the dependency graph from the roots and keeps one declaration per
/// TypeScript identifier, ordered by identifier so the output is stable.
struct Collect<'a> {
	cfg:     &'a Config,
	seen:    HashSet<TypeId>,
	decls:   BTreeMap<String, String>,
	clashes: Vec<String>,
}

impl TypeVisitor for Collect<'_> {
	fn visit<T: TS + 'static + ?Sized>(&mut self) {
		if !self.seen.insert(TypeId::of::<T>()) {
			return;
		}
		if T::output_path().is_some() {
			let ident = T::ident(self.cfg);
			let decl = format!("{}export {}", T::docs().unwrap_or_default(), T::decl(self.cfg));
			if let Some(previous) = self.decls.insert(ident.clone(), decl.clone())
				&& previous != decl
			{
				self.clashes.push(ident);
			}
		}
		T::visit_dependencies(self);
		T::visit_generics(self);
	}
}

/// The wire spelling of every variant of a unit-only enum, in declaration
/// order.
fn wire_names<T: IntoEnumIterator + Serialize>() -> Vec<String> {
	T::iter()
		.map(|variant| match serde_json::to_value(variant) {
			Ok(serde_json::Value::String(name)) => name,
			other => panic!("a unit variant serializes to a string, got {other:?}"),
		})
		.collect()
}

fn push_array(out: &mut String, name: &str, members: &[String], element: Option<&str>) {
	writeln!(out, "export const {name} = [").unwrap();
	for member in members {
		writeln!(out, "\t{member:?},").unwrap();
	}
	match element {
		Some(element) => writeln!(out, "] as const satisfies readonly {element}[];\n").unwrap(),
		None => writeln!(out, "] as const;\n").unwrap(),
	}
}

fn generate() -> String {
	let cfg = Config::new().with_large_int("number");
	let mut collect = Collect {
		cfg:     &cfg,
		seen:    HashSet::new(),
		decls:   BTreeMap::new(),
		clashes: Vec::new(),
	};
	collect.visit::<HostEvent>();
	collect.visit::<HostRequest>();
	assert!(
		collect.clashes.is_empty(),
		"two Rust types generate different declarations under one TypeScript name: {:?}",
		collect.clashes
	);
	let mut out = String::from(
		"// Generated from the wire types in crates/veyyon-desktop-model. Do not edit by hand.\n",
	);
	writeln!(out, "// Regenerate with: {REGENERATE}\n").unwrap();
	for (name, module) in IMPORTED {
		assert!(
			!collect.decls.contains_key(name),
			"{name} is owned by TypeScript and imported, but a Rust type generated it too"
		);
		writeln!(out, "import type {{ {name} }} from {module:?};").unwrap();
	}
	out.push('\n');
	for decl in collect.decls.values() {
		writeln!(out, "{decl}\n").unwrap();
	}

	writeln!(out, "export const GUI_HOST_PROTOCOL_VERSION = {PROTOCOL_VERSION};\n").unwrap();
	let sections: Vec<String> = SnapshotSectionKind::iter()
		.map(|kind| format!("{kind:?}"))
		.collect();
	push_array(&mut out, "ALL_SNAPSHOT_SECTIONS", &sections, None);
	out.push_str("export type SnapshotSectionTag = (typeof ALL_SNAPSHOT_SECTIONS)[number];\n\n");

	let actions = wire_names::<HostActionKind>();
	push_array(&mut out, "ALL_HOST_ACTIONS", &actions, None);
	out.push_str("export type HostActionTag = (typeof ALL_HOST_ACTIONS)[number];\n\n");
	out.push_str("export const ACTION_TO_CAPABILITY: Record<HostActionTag, Capability> = {\n");
	for (kind, name) in HostActionKind::iter().zip(&actions) {
		let capability = serde_json::to_value(action_to_capability(kind)).unwrap();
		writeln!(out, "\t{name}: {capability},").unwrap();
	}
	out.push_str("};\n\n");

	let phases: Vec<String> = SharePhase::iter()
		.filter(|phase| *phase != SharePhase::Unknown)
		.map(|phase| phase.as_str().to_owned())
		.collect();
	push_array(&mut out, "SHARE_PHASES", &phases, None);
	out.push_str("export type SharePhase = (typeof SHARE_PHASES)[number];\n\n");

	push_array(&mut out, "ALL_CAPABILITIES", &wire_names::<Capability>(), Some("Capability"));
	push_array(&mut out, "ALL_GOAL_CONTROLS", &wire_names::<GoalControl>(), Some("GoalControl"));
	push_array(&mut out, "SETTABLE_MODES", &wire_names::<SettableMode>(), Some("SettableMode"));
	push_array(&mut out, "ALL_GOAL_STATUSES", &wire_names::<GoalStatus>(), Some("GoalStatus"));
	push_array(
		&mut out,
		"ALL_AUTOSWARM_ACTIONS",
		&wire_names::<AutoswarmAction>(),
		Some("AutoswarmAction"),
	);
	push_array(
		&mut out,
		"ALL_AUTOSWARM_FIELD_KINDS",
		&wire_names::<AutoswarmFieldKind>(),
		Some("AutoswarmFieldKind"),
	);
	push_array(
		&mut out,
		"AGENT_MESSAGE_OUTCOMES",
		&wire_names::<AgentMessageOutcome>(),
		Some("AgentMessageOutcome"),
	);
	push_array(
		&mut out,
		"DICTATION_STATES",
		&wire_names::<DictationState>(),
		Some("DictationState"),
	);
	push_array(&mut out, "SHARE_ROLES", &wire_names::<ShareRole>(), Some("ShareRole"));
	push_array(&mut out, "ALL_EXPORT_FORMATS", &wire_names::<ExportFormat>(), Some("ExportFormat"));
	push_array(
		&mut out,
		"SESSION_TREE_FILTERS",
		&wire_names::<SessionTreeFilter>(),
		Some("SessionTreeFilter"),
	);
	push_array(
		&mut out,
		"SESSION_TREE_ENTRY_KINDS",
		&wire_names::<SessionTreeEntryKind>(),
		Some("SessionTreeEntryKind"),
	);

	out.truncate(out.trim_end().len());
	out.push('\n');
	out
}

#[test]
fn the_typescript_wire_is_the_one_the_rust_types_generate() {
	let expected = generate();
	let path = generated_path();
	if std::env::var_os("UPDATE_WIRE").is_some() {
		fs::write(&path, &expected)
			.unwrap_or_else(|error| panic!("cannot write {}: {error}", path.display()));
		return;
	}
	let on_disk = fs::read_to_string(&path).unwrap_or_default();
	if on_disk != expected {
		let line = on_disk
			.lines()
			.zip(expected.lines())
			.position(|(have, want)| have != want)
			.unwrap_or_else(|| on_disk.lines().count().min(expected.lines().count()));
		panic!(
			"{} is not what the Rust wire types generate (first difference at line {}). Regenerate \
			 it with `{REGENERATE}` and commit the result.",
			path.display(),
			line + 1
		);
	}
}
