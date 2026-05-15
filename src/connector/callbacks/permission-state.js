import {
  permissionNoteIdempotencyPrefix,
  permissionReplyIdempotencyKey,
  permissionReplyIdempotencyPrefix,
} from "../idempotency.js"

export function parsePermissionParts(parts) {
  if (parts.length >= 5) return { projectAlias: parts[1], sessionID: parts[2] || "", permissionId: parts[3], action: parts[4], isOldShape: false }
  return { projectAlias: parts[1], sessionID: "", permissionId: parts[2], action: parts[3], isOldShape: true }
}

export function hasHandledPermission(store, projectAlias, sessionID, permissionId) {
  if (typeof store?.hasIdempotencyKeyPrefix !== "function") return false
  return store.hasIdempotencyKeyPrefix(permissionReplyIdempotencyPrefix(projectAlias, sessionID, permissionId)) ||
    store.hasIdempotencyKeyPrefix(permissionNoteIdempotencyPrefix(projectAlias, sessionID, permissionId)) ||
    store.hasIdempotencyKeyPrefix(permissionReplyIdempotencyPrefix(projectAlias, "", permissionId)) ||
    store.hasIdempotencyKeyPrefix(permissionNoteIdempotencyPrefix(projectAlias, "", permissionId))
}

export { permissionReplyIdempotencyKey }
