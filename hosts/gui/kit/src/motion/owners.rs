//! One retained key per named object, and one place that hands them out.
//!
//! A motion track is keyed by its owner, so two objects a window can draw at
//! once must not resolve to one [`RetainedKey`]. Every surface used to derive
//! its own: a counter here, a hash there, a hand-picked number in a third file,
//! all inside one namespace. Five pairs collided - a sidebar control with a
//! toolbar control, a settings switch with a settings filter field, a toolbar
//! button with an inspector tab, a window control with a dock tab, an agent row
//! with a task row - and each one read as a control lighting up while the
//! pointer was somewhere else.
//!
//! A caller names an object instead: `owner(Shell, "titlebar", "dock")`. The
//! namespace picks the table, `kind` says what sort of object the name belongs
//! to, and `id` is the object. Nobody picks a number, so nobody picks the same
//! number twice, and two objects that do share a key share a name a reader can
//! see. Every object holds a block of [`BLOCK`] ids, so a row's controls sit
//! inside its own block through [`control`].
//!
//! An object that is a name and a number - a search hit at a line, an outline
//! row over a range - asks through [`owner_at`], which holds one table per
//! `(kind, number)` so the caller never formats the two into a string.
//!
//! `kind` is `&'static str` and `id` is borrowed, so a lookup allocates nothing
//! per frame; a name allocates once, the first frame it is drawn.
//!
//! WHAT THIS IS NOT. It is not a cache of drawn state: it holds a `u64` and a
//! name per object for the life of the process and nothing that grows per
//! frame. Nor does it retire a name - a track settles and leaves the motion
//! registry on its own, and a name drawn again keeps the key it had.

use std::{cell::RefCell, collections::HashMap};

use super::model::{OwnerNamespace, RetainedKey};

/// Ids one object claims: itself at offset zero, and its controls above it.
pub const BLOCK: u64 = 16;

/// The first block, leaving offset zero of a namespace to
/// [`RetainedKey::reserved`].
const FIRST: u64 = BLOCK;

/// The block each name in one table holds. `Box<str>` rather than `String`
/// because a name is written once and read every frame.
type Named = HashMap<Box<str>, u64>;

/// Those tables, one per kind of object, so a lookup borrows the caller's
/// strings instead of building a key.
type ByKind = HashMap<&'static str, Named>;

/// And one per kind and number, for a name that carries one.
type ByNumber = HashMap<(&'static str, u64), Named>;

thread_local! {
	static NAMES: RefCell<Names> = RefCell::new(Names::default());
}

#[derive(Default)]
struct Names {
	/// One table per namespace, indexed by the namespace's own discriminant, and
	/// inside it one table per kind.
	blocks: [ByKind; OwnerNamespace::COUNT],
	/// The same, for a name that carries a number: one table per `(kind,
	/// number)`, so a lookup hashes the pair instead of building a string.
	subs:   [ByNumber; OwnerNamespace::COUNT],
	next:   [u64; OwnerNamespace::COUNT],
}

impl Names {
	fn block(&mut self, namespace: OwnerNamespace, kind: &'static str, id: &str) -> u64 {
		let slot = namespace.index();
		if let Some(local) = self.blocks[slot].get(kind).and_then(|names| names.get(id)) {
			return *local;
		}
		let local = self.claim(slot);
		self.blocks[slot]
			.entry(kind)
			.or_default()
			.insert(id.into(), local);
		local
	}

	fn sub_block(
		&mut self,
		namespace: OwnerNamespace,
		kind: &'static str,
		id: &str,
		sub: u64,
	) -> u64 {
		let slot = namespace.index();
		if let Some(local) = self.subs[slot]
			.get(&(kind, sub))
			.and_then(|names| names.get(id))
		{
			return *local;
		}
		let local = self.claim(slot);
		self.subs[slot]
			.entry((kind, sub))
			.or_default()
			.insert(id.into(), local);
		local
	}

	/// The next block of [`BLOCK`] ids in this namespace.
	fn claim(&mut self, slot: usize) -> u64 {
		let next = &mut self.next[slot];
		let local = if *next == 0 { FIRST } else { *next };
		*next = local.saturating_add(BLOCK);
		local
	}
}

fn key(namespace: OwnerNamespace, local: u64) -> RetainedKey {
	RetainedKey::scoped(namespace, local, 0).unwrap_or_else(|| RetainedKey::reserved(namespace))
}

/// The key for the `kind` object named `id` in `namespace`.
///
/// The same name returns the same key for the life of the process, and two
/// different names in one namespace never return the same key.
pub fn owner(namespace: OwnerNamespace, kind: &'static str, id: &str) -> RetainedKey {
	let local = NAMES.with(|names| names.borrow_mut().block(namespace, kind, id));
	key(namespace, local)
}

/// The key for the `kind` object named `id` and the number `sub`.
///
/// For an object a name alone does not identify: a search hit is a file and a
/// line, an outline row a file and a range. Two `sub` values under one name are
/// two objects, and neither shares a key with the name on its own.
pub fn owner_at(namespace: OwnerNamespace, kind: &'static str, id: &str, sub: u64) -> RetainedKey {
	let local = NAMES.with(|names| names.borrow_mut().sub_block(namespace, kind, id, sub));
	key(namespace, local)
}

/// The key for a control of that object, at `slot` inside its block.
///
/// Slot zero is the object itself, so a control asks for one above it. A slot
/// at or beyond [`BLOCK`] would land in the next object's block and is held at
/// the top of this one instead; a surface states its slots as an enum and
/// proves they fit the block.
pub fn control(namespace: OwnerNamespace, kind: &'static str, id: &str, slot: u8) -> RetainedKey {
	let held = u64::from(slot).min(BLOCK - 1);
	let local = NAMES.with(|names| names.borrow_mut().block(namespace, kind, id));
	key(namespace, local.saturating_add(held))
}
