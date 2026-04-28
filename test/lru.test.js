import test from "node:test"
import assert from "node:assert/strict"
import { createParentSessionCache, LruMap, LruSet } from "../src/util/lru.js"

test("LruSet evicts the oldest entry", () => {
  const set = new LruSet(2)

  set.add("a")
  set.add("b")
  set.add("c")

  assert.equal(set.has("a"), false)
  assert.equal(set.has("b"), true)
  assert.equal(set.has("c"), true)
})

test("LruSet refreshes recency when adding an existing entry", () => {
  const set = new LruSet(2)

  set.add("a")
  set.add("b")
  set.add("a")
  set.add("c")

  assert.equal(set.has("a"), true)
  assert.equal(set.has("b"), false)
  assert.equal(set.has("c"), true)
})

test("LruMap get refreshes recency and preserves undefined miss semantics", () => {
  const map = new LruMap(2)

  map.set("a", 1)
  map.set("b", 2)
  assert.equal(map.get("missing"), undefined)
  assert.equal(map.get("a"), 1)
  map.set("c", 3)

  assert.equal(map.get("a"), 1)
  assert.equal(map.get("b"), undefined)
  assert.equal(map.get("c"), 3)
})

test("parent-session cache can store empty-string no-parent sentinel", () => {
  const cache = createParentSessionCache(2)

  cache.set("demo:child", "")

  assert.equal(cache.get("demo:child"), "")
  assert.equal(cache.get("demo:missing"), undefined)
})
