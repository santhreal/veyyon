use crate::{FontRun, Pixels, SharedString};
use collections::FxHashMap;
use smallvec::SmallVec;
use std::{
    borrow::Borrow,
    hash::{Hash, Hasher},
};

/// Key for lookups in the persistent advance cache.
#[derive(Clone, Debug, Eq)]
pub(crate) struct AdvanceCacheKey {
    /// The text string.
    pub text: SharedString,
    /// The font size in pixels.
    pub font_size: Pixels,
    /// The styled font runs.
    pub runs: SmallVec<[FontRun; 2]>,
}

impl PartialEq for AdvanceCacheKey {
    fn eq(&self, other: &Self) -> bool {
        self.text == other.text && self.font_size == other.font_size && self.runs == other.runs
    }
}

impl Hash for AdvanceCacheKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.text.hash(state);
        self.font_size.hash(state);
        self.runs.hash(state);
    }
}

/// A borrowed reference to an advance cache key for allocation-free lookups.
#[derive(Copy, Clone, PartialEq, Eq, Hash)]
pub(crate) struct AdvanceCacheKeyRef<'a> {
    /// The borrowed text slice.
    pub text: &'a str,
    /// The font size in pixels.
    pub font_size: Pixels,
    /// The font runs.
    pub runs: &'a [FontRun],
}

pub(crate) trait AsAdvanceCacheKeyRef {
    fn as_advance_cache_key_ref(&self) -> AdvanceCacheKeyRef<'_>;
}

impl AsAdvanceCacheKeyRef for AdvanceCacheKey {
    fn as_advance_cache_key_ref(&self) -> AdvanceCacheKeyRef<'_> {
        AdvanceCacheKeyRef {
            text: self.text.as_ref(),
            font_size: self.font_size,
            runs: self.runs.as_slice(),
        }
    }
}

impl AsAdvanceCacheKeyRef for AdvanceCacheKeyRef<'_> {
    fn as_advance_cache_key_ref(&self) -> AdvanceCacheKeyRef<'_> {
        *self
    }
}

impl<'a> Borrow<dyn AsAdvanceCacheKeyRef + 'a> for AdvanceCacheKey {
    fn borrow(&self) -> &(dyn AsAdvanceCacheKeyRef + 'a) {
        self
    }
}

impl PartialEq for dyn AsAdvanceCacheKeyRef + '_ {
    fn eq(&self, other: &Self) -> bool {
        self.as_advance_cache_key_ref() == other.as_advance_cache_key_ref()
    }
}

impl Eq for dyn AsAdvanceCacheKeyRef + '_ {}

impl Hash for dyn AsAdvanceCacheKeyRef + '_ {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.as_advance_cache_key_ref().hash(state)
    }
}

const NIL: usize = usize::MAX;

struct LruNode<K, V> {
    key: K,
    value: V,
    prev: usize,
    next: usize,
}

/// A bounded LRU cache mapping keys to values.
pub(crate) struct LruCache<K, V> {
    capacity: usize,
    entries: Vec<Option<LruNode<K, V>>>,
    map: FxHashMap<K, usize>,
    free_indices: Vec<usize>,
    head: usize,
    tail: usize,
}

impl<K, V> LruCache<K, V>
where
    K: Clone + Eq + Hash,
{
    /// Creates a new LRU cache with the specified maximum capacity.
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: Vec::new(),
            map: FxHashMap::default(),
            free_indices: Vec::new(),
            head: NIL,
            tail: NIL,
        }
    }

    /// Returns the number of entries currently stored in the cache.
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// Sets a new capacity for the cache, evicting the least recently used entries if necessary.
    pub fn set_capacity(&mut self, new_capacity: usize) {
        self.capacity = new_capacity;
        while self.map.len() > self.capacity && self.tail != NIL {
            self.pop_tail();
        }
    }

    /// Clears all entries from the cache.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.map.clear();
        self.free_indices.clear();
        self.head = NIL;
        self.tail = NIL;
    }

    fn detach(&mut self, idx: usize) {
        let prev = self.entries[idx].as_ref().unwrap().prev;
        let next = self.entries[idx].as_ref().unwrap().next;

        if prev != NIL {
            self.entries[prev].as_mut().unwrap().next = next;
        } else {
            self.head = next;
        }

        if next != NIL {
            self.entries[next].as_mut().unwrap().prev = prev;
        } else {
            self.tail = prev;
        }

        let node = self.entries[idx].as_mut().unwrap();
        node.prev = NIL;
        node.next = NIL;
    }

    fn attach_head(&mut self, idx: usize) {
        self.entries[idx].as_mut().unwrap().prev = NIL;
        self.entries[idx].as_mut().unwrap().next = self.head;

        if self.head != NIL {
            self.entries[self.head].as_mut().unwrap().prev = idx;
        }
        self.head = idx;

        if self.tail == NIL {
            self.tail = idx;
        }
    }

    fn move_to_head(&mut self, idx: usize) {
        if self.head == idx {
            return;
        }
        self.detach(idx);
        self.attach_head(idx);
    }

    fn pop_tail(&mut self) -> Option<(K, V)> {
        if self.tail == NIL {
            return None;
        }
        let tail_idx = self.tail;
        self.detach(tail_idx);
        let entry = self.entries[tail_idx].take().unwrap();
        self.map.remove(&entry.key);
        self.free_indices.push(tail_idx);
        Some((entry.key, entry.value))
    }

    /// Retrieves a value by key, marking it as most recently used.
    pub fn get<Q>(&mut self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let &idx = self.map.get(key)?;
        self.move_to_head(idx);
        Some(&self.entries[idx].as_ref().unwrap().value)
    }

    /// Inserts a key-value pair into the cache, evicting the least recently used entry if at capacity.
    pub fn insert(&mut self, key: K, value: V) -> Option<V> {
        if self.capacity == 0 {
            return None;
        }

        if let Some(&idx) = self.map.get(&key) {
            let entry = self.entries[idx].as_mut().unwrap();
            let old = std::mem::replace(&mut entry.value, value);
            self.move_to_head(idx);
            return Some(old);
        }

        while self.map.len() >= self.capacity {
            self.pop_tail();
        }

        let idx = if let Some(free_idx) = self.free_indices.pop() {
            self.entries[free_idx] = Some(LruNode {
                key: key.clone(),
                value,
                prev: NIL,
                next: NIL,
            });
            free_idx
        } else {
            let new_idx = self.entries.len();
            self.entries.push(Some(LruNode {
                key: key.clone(),
                value,
                prev: NIL,
                next: NIL,
            }));
            new_idx
        };

        self.map.insert(key, idx);
        self.attach_head(idx);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lru_cache_eviction() {
        let mut cache = LruCache::new(2);
        assert_eq!(cache.len(), 0);

        cache.insert("a", 1);
        cache.insert("b", 2);
        assert_eq!(cache.len(), 2);

        assert_eq!(cache.get(&"a"), Some(&1));

        cache.insert("c", 3);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get(&"b"), None); // "b" was least recently used and evicted
        assert_eq!(cache.get(&"a"), Some(&1));
        assert_eq!(cache.get(&"c"), Some(&3));
    }

    #[test]
    fn test_lru_cache_set_capacity() {
        let mut cache = LruCache::new(4);
        cache.insert(1, "one");
        cache.insert(2, "two");
        cache.insert(3, "three");
        cache.insert(4, "four");
        assert_eq!(cache.len(), 4);

        cache.set_capacity(2);
        assert_eq!(cache.len(), 2);
        // 1 and 2 were oldest, so they should be evicted
        assert_eq!(cache.get(&1), None);
        assert_eq!(cache.get(&2), None);
        assert_eq!(cache.get(&3), Some(&"three"));
        assert_eq!(cache.get(&4), Some(&"four"));
    }
}
