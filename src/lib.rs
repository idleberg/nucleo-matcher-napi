//! N-API bindings for `nucleo-matcher`.
//!
//! Two execution models:
//!   * sync (`matchIndexed`, `matchItems`, ...) — runs on the JS thread
//!   * async (`matchIndexedAsync`) — shards the haystack across OS threads on
//!     libuv's pool, so the event loop is never blocked
//!
//! The haystack is interned as `Utf32String` once, in `setItems`/the constructor.
//! Nothing but the pattern crosses the boundary per query, and results come back
//! as typed arrays.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use nucleo_matcher::pattern::{Atom, AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32String};
use std::sync::Arc;
use std::thread;

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

#[napi(object)]
#[derive(Clone)]
pub struct MatcherOptions {
	/// Treat `/` and `\` as word boundaries. Equivalent to zadeh's
	/// `usePathScoring`. Default: false.
	pub match_paths: Option<bool>,
	/// Boost matches near the start of the haystack. Recommended for
	/// autocompletion, not for a general fuzzy picker. Default: false.
	pub prefer_prefix: Option<bool>,
	/// `"ignore"` | `"smart"` | `"respect"`. Default: `"ignore"`.
	pub case_matching: Option<String>,
	/// `"smart"` | `"never"`. Default: `"smart"`.
	pub normalization: Option<String>,
}

#[napi(object)]
#[derive(Clone)]
pub struct MatchOptions {
	/// Cap the result set to the top N by score. Uses `select_nth_unstable`,
	/// so the tail is never sorted and never marshalled.
	pub max_results: Option<u32>,
	/// Threads to shard the haystack across. Async methods only. Defaults to
	/// `availableParallelism()`. Ignored (and meaningless) for sync methods.
	pub threads: Option<u32>,
	/// Treat the query as one literal needle: no `^`/`$`/`'`/`!` syntax, and
	/// whitespace is part of the needle rather than an atom separator.
	/// Default: false.
	pub literal: Option<bool>,
	/// Only meaningful with `literal: true`.
	/// `"fuzzy"` | `"substring"` | `"prefix"` | `"postfix"` | `"exact"`.
	/// Default: `"fuzzy"`.
	pub kind: Option<String>,
}

#[napi(object)]
pub struct IndexedMatchResult {
	pub indices: Uint32Array,
	pub scores: Uint32Array,
}

#[napi(object)]
pub struct MatchedItem {
	pub item: String,
	pub score: u32,
	/// Character offsets into `item`, ascending, deduplicated. For highlighting.
	pub indices: Vec<u32>,
}

// ---------------------------------------------------------------------------
// config plumbing
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Settings {
	case_matching: CaseMatching,
	normalization: Normalization,
	config: Config,
}

fn parse_case(s: Option<&str>) -> Result<CaseMatching> {
	Ok(match s.unwrap_or("ignore") {
		"ignore" => CaseMatching::Ignore,
		"smart" => CaseMatching::Smart,
		"respect" => CaseMatching::Respect,
		other => {
			return Err(Error::new(
				Status::InvalidArg,
				format!("caseMatching must be \"ignore\" | \"smart\" | \"respect\", got {other:?}"),
			))
		}
	})
}

fn parse_norm(s: Option<&str>) -> Result<Normalization> {
	Ok(match s.unwrap_or("smart") {
		"smart" => Normalization::Smart,
		"never" => Normalization::Never,
		other => {
			return Err(Error::new(
				Status::InvalidArg,
				format!("normalization must be \"smart\" | \"never\", got {other:?}"),
			))
		}
	})
}

impl Settings {
	fn from_options(o: Option<MatcherOptions>) -> Result<Self> {
		let o = o.unwrap_or(MatcherOptions {
			match_paths: None,
			prefer_prefix: None,
			case_matching: None,
			normalization: None,
		});
		let mut config = Config::DEFAULT;
		if o.match_paths.unwrap_or(false) {
			config = config.match_paths();
		}
		config.prefer_prefix = o.prefer_prefix.unwrap_or(false);
		Ok(Settings {
			case_matching: parse_case(o.case_matching.as_deref())?,
			normalization: parse_norm(o.normalization.as_deref())?,
			config,
		})
	}
}

// ---------------------------------------------------------------------------
// the match loop, shared by sync and async paths
// ---------------------------------------------------------------------------

type Hits = Vec<(u32, u32)>;

/// A parsed query. `Pattern` honours fzf syntax (`^`, `$`, `'`, `!`, whitespace
/// as an atom separator). `Atom` is a single literal needle — the whole query,
/// spaces and metacharacters included. zadeh has no query syntax, so the compat
/// layer uses `Atom`.
///
/// Note that string-escaping is *not* a substitute for this: nucleo only treats
/// `^ $ ' !` as special at atom boundaries, so `a\^b` matches a literal
/// backslash, not a caret.
enum Needle {
	Pat(Pattern),
	Lit(Atom),
}

impl Needle {
	fn score(&self, haystack: nucleo_matcher::Utf32Str<'_>, m: &mut Matcher) -> Option<u32> {
		match self {
			Needle::Pat(p) => p.score(haystack, m),
			Needle::Lit(a) => a.score(haystack, m).map(u32::from),
		}
	}

	fn indices(&self, haystack: nucleo_matcher::Utf32Str<'_>, m: &mut Matcher, out: &mut Vec<u32>) {
		match self {
			Needle::Pat(p) => {
				p.indices(haystack, m, out);
			}
			Needle::Lit(a) => {
				a.indices(haystack, m, out);
			}
		}
	}
}

fn parse_kind(s: Option<&str>) -> Result<AtomKind> {
	Ok(match s.unwrap_or("fuzzy") {
    "fuzzy" => AtomKind::Fuzzy,
    "substring" => AtomKind::Substring,
    "prefix" => AtomKind::Prefix,
    "postfix" => AtomKind::Postfix,
    "exact" => AtomKind::Exact,
    other => {
      return Err(Error::new(
        Status::InvalidArg,
        format!("kind must be \"fuzzy\" | \"substring\" | \"prefix\" | \"postfix\" | \"exact\", got {other:?}"),
      ))
    }
  })
}

impl Settings {
	fn pattern(&self, query: &str) -> Needle {
		Needle::Pat(Pattern::parse(
			query,
			self.case_matching,
			self.normalization,
		))
	}
	fn literal(&self, query: &str, kind: AtomKind) -> Needle {
		// escape_whitespace = true: the query is one atom, spaces and all.
		Needle::Lit(Atom::new(
			query,
			self.case_matching,
			self.normalization,
			kind,
			true,
		))
	}
	fn needle(&self, query: &str, options: Option<&MatchOptions>) -> Result<Needle> {
		if options.and_then(|o| o.literal).unwrap_or(false) {
			Ok(self.literal(query, parse_kind(options.and_then(|o| o.kind.as_deref()))?))
		} else {
			Ok(self.pattern(query))
		}
	}
}

/// Descending score, ties broken by ascending haystack index.
///
/// The tiebreak is not cosmetic: on a large corpus most results tie, and
/// `sort_unstable` alone lets equal-scored rows reorder between calls.
#[inline]
fn cmp_hit(a: &(u32, u32), b: &(u32, u32)) -> std::cmp::Ordering {
	b.1.cmp(&a.1).then(a.0.cmp(&b.0))
}

fn truncate_and_sort(mut hits: Hits, max_results: Option<u32>) -> Hits {
	let k = max_results.map(|k| k as usize).unwrap_or(usize::MAX);
	if k == 0 {
		return Vec::new();
	}
	if k < hits.len() {
		// O(n) average, versus O(n log n) to sort a tail we are about to drop.
		hits.select_nth_unstable_by(k - 1, cmp_hit);
		hits.truncate(k);
	}
	hits.sort_unstable_by(cmp_hit);
	hits
}

fn score_range(items: &[Utf32String], needle: &Needle, matcher: &mut Matcher, base: u32) -> Hits {
	items
		.iter()
		.enumerate()
		.filter_map(|(i, h)| {
			needle
				.score(h.slice(..), matcher)
				.map(|s| (base + i as u32, s))
		})
		.collect()
}

fn score_parallel(
	items: &Arc<Vec<Utf32String>>,
	needle: &Needle,
	cfg: &Config,
	threads: usize,
) -> Hits {
	if threads <= 1 || items.len() < 4096 {
		let mut m = Matcher::new(cfg.clone());
		return score_range(items, needle, &mut m, 0);
	}
	let chunk = items.len().div_ceil(threads);
	thread::scope(|s| {
		let handles: Vec<_> = items
			.chunks(chunk)
			.enumerate()
			.map(|(c, slice)| {
				s.spawn(move || {
					// Matcher owns ~a few hundred KB of scratch; one per shard, not one
					// per item. Allocation is amortised across `slice.len()` scores.
					let mut m = Matcher::new(cfg.clone());
					score_range(slice, needle, &mut m, (c * chunk) as u32)
				})
			})
			.collect();
		handles
			.into_iter()
			.flat_map(|h| h.join().unwrap())
			.collect()
	})
}

// ---------------------------------------------------------------------------
// async task
// ---------------------------------------------------------------------------

pub struct MatchTask {
	items: Arc<Vec<Utf32String>>,
	needle: Needle,
	config: Config,
	max_results: Option<u32>,
	threads: usize,
}

impl Task for MatchTask {
	type Output = Hits;
	type JsValue = IndexedMatchResult;

	fn compute(&mut self) -> Result<Self::Output> {
		let hits = score_parallel(&self.items, &self.needle, &self.config, self.threads);
		Ok(truncate_and_sort(hits, self.max_results))
	}

	fn resolve(&mut self, _env: Env, hits: Self::Output) -> Result<Self::JsValue> {
		Ok(IndexedMatchResult {
			indices: Uint32Array::new(hits.iter().map(|h| h.0).collect()),
			scores: Uint32Array::new(hits.iter().map(|h| h.1).collect()),
		})
	}
}

// ---------------------------------------------------------------------------
// public class
// ---------------------------------------------------------------------------

#[napi]
pub struct NucleoMatcher {
	raw: Arc<Vec<String>>,
	items: Arc<Vec<Utf32String>>,
	matcher: Matcher,
	settings: Settings,
	default_threads: usize,
}

#[napi]
impl NucleoMatcher {
	#[napi(constructor)]
	pub fn new(items: Vec<String>, options: Option<MatcherOptions>) -> Result<Self> {
		let settings = Settings::from_options(options)?;
		let interned: Vec<Utf32String> = items.iter().map(|s| s.as_str().into()).collect();
		Ok(Self {
			raw: Arc::new(items),
			items: Arc::new(interned),
			matcher: Matcher::new(settings.config.clone()),
			settings,
			default_threads: thread::available_parallelism().map_or(4, |n| n.get()),
		})
	}

	/// Replace the haystack. Re-interns; O(total bytes).
	#[napi]
	pub fn set_items(&mut self, items: Vec<String>) {
		self.items = Arc::new(items.iter().map(|s| s.as_str().into()).collect());
		self.raw = Arc::new(items);
	}

	#[napi(getter)]
	pub fn size(&self) -> u32 {
		self.raw.len() as u32
	}

	/// Look up an item by haystack index. Cheaper than shipping the whole
	/// corpus back and forth.
	#[napi]
	pub fn item_at(&self, index: u32) -> Option<String> {
		self.raw.get(index as usize).cloned()
	}

	/// Synchronous match. Returns parallel typed arrays of haystack indices and
	/// scores, sorted by descending score. No strings cross the boundary.
	#[napi]
	pub fn match_indexed(
		&mut self,
		query: String,
		options: Option<MatchOptions>,
	) -> Result<IndexedMatchResult> {
		let needle = self.settings.needle(&query, options.as_ref())?;
		let max = options.and_then(|o| o.max_results);
		let hits = score_range(&self.items, &needle, &mut self.matcher, 0);
		let hits = truncate_and_sort(hits, max);
		Ok(IndexedMatchResult {
			indices: Uint32Array::new(hits.iter().map(|h| h.0).collect()),
			scores: Uint32Array::new(hits.iter().map(|h| h.1).collect()),
		})
	}

	/// Asynchronous match, sharded across OS threads on libuv's pool. The JS
	/// thread is free for the duration.
	///
	/// Note: libuv's pool defaults to 4 threads. Raise `UV_THREADPOOL_SIZE`
	/// before requiring this module if you set `threads` above 4.
	#[napi(ts_return_type = "Promise<IndexedMatchResult>")]
	pub fn match_indexed_async(
		&self,
		query: String,
		options: Option<MatchOptions>,
	) -> Result<AsyncTask<MatchTask>> {
		let needle = self.settings.needle(&query, options.as_ref())?;
		let threads = options
			.as_ref()
			.and_then(|o| o.threads)
			.map(|t| t as usize)
			.unwrap_or(self.default_threads)
			.max(1);
		Ok(AsyncTask::new(MatchTask {
			items: Arc::clone(&self.items),
			needle,
			config: self.settings.config.clone(),
			max_results: options.and_then(|o| o.max_results),
			threads,
		}))
	}

	/// Match and return the matched strings, their scores, and the character
	/// offsets that matched — for highlighting. Costs a second pass over the
	/// survivors, so prefer `matchIndexed` when you do not need offsets.
	#[napi]
	pub fn match_items(
		&mut self,
		query: String,
		options: Option<MatchOptions>,
	) -> Result<Vec<MatchedItem>> {
		let needle = self.settings.needle(&query, options.as_ref())?;
		let max = options.and_then(|o| o.max_results);
		let hits = score_range(&self.items, &needle, &mut self.matcher, 0);
		let hits = truncate_and_sort(hits, max);

		let mut buf: Vec<u32> = Vec::new();
		Ok(hits
			.into_iter()
			.map(|(i, score)| {
				buf.clear();
				needle.indices(
					self.items[i as usize].slice(..),
					&mut self.matcher,
					&mut buf,
				);
				buf.sort_unstable();
				buf.dedup();
				MatchedItem {
					item: self.raw[i as usize].clone(),
					score,
					indices: buf.clone(),
				}
			})
			.collect())
	}

	/// Score one haystack against one query. `undefined` when there is no match.
	///
	/// This is the one entry point where N-API is measurably slower than a
	/// wasm-bindgen equivalent (~290ns vs ~150ns per call), because every string
	/// argument costs a two-pass `napi_get_value_string_utf8`. Batch through
	/// `matchIndexed` in hot paths.
	#[napi]
	pub fn score(
		&mut self,
		query: String,
		haystack: String,
		options: Option<MatchOptions>,
	) -> Result<Option<u32>> {
		let needle = self.settings.needle(&query, options.as_ref())?;
		let hs: Utf32String = haystack.as_str().into();
		Ok(needle.score(hs.slice(..), &mut self.matcher))
	}
}
