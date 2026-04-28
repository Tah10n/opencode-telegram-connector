export class LruSet {
  constructor(limit) {
    this.limit = limit
    this.map = new Map()
  }

  has(key) {
    return this.map.has(key)
  }

  add(key) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, true)
    this.trim()
  }

  delete(key) {
    return this.map.delete(key)
  }

  trim() {
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }
}

export class LruMap {
  constructor(limit) {
    this.limit = limit
    this.map = new Map()
  }

  get(key) {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key)
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    this.trim()
  }

  trim() {
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }
}

export function createParentSessionCache(limit = 5000) {
  return new LruMap(limit)
}
