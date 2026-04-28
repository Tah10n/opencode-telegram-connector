export function callbackPacker(cb) {
  return typeof cb?.pack === "function" ? (value) => cb.pack(value) : (value) => value
}
