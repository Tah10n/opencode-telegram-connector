import { t as translate } from "../i18n/index.js"

export const CALLBACK_TOAST_KEYS = Object.freeze({
  Closed: "closed",
  Invalid: "invalid",
  "Private chat only": "privateChatOnly",
  Cancelled: "cancelled",
  "Confirm restart": "confirmRestart",
  "Confirm stop": "confirmStop",
  Unavailable: "unavailable",
  "Restarting…": "restarting",
  "Stopping…": "stopping",
  "Not bound": "notBound",
  Sessions: "sessions",
  "Creating…": "creating",
  "Binding changed": "bindingChanged",
  "Already current": "alreadyCurrent",
  Switched: "switched",
  Projects: "projects",
  "Unknown project": "unknownProject",
  "Starting…": "starting",
  "Binding…": "binding",
  "Checking…": "checking",
  Repaired: "repaired",
  "Already clean": "alreadyClean",
  Kept: "kept",
  Confirm: "confirm",
  Unbound: "unbound",
  Rebound: "rebound",
  Created: "created",
  "Action failed": "actionFailed",
  Feed: "feed",
  Model: "model",
  Back: "back",
  "Pick model": "pickModel",
  "Model: inherit": "modelInherit",
  "Model: project default": "modelProjectDefault",
  "Pick variant": "pickVariant",
  "Sending…": "sending",
  "Already handled": "alreadyHandled",
  "No longer active": "noLongerActive",
  "Temporarily unavailable": "temporarilyUnavailable",
  OK: "ok",
  "Send note": "sendNote",
  Selected: "selected",
  Done: "done",
  Unsupported: "unsupported",
  "Wrong thread": "wrongThread",
  Expired: "expired",
  "Agent busy": "agentBusy",
  "Already sending": "alreadySending",
  "Already sent": "alreadySent",
  "Too large": "tooLarge",
  "Try again": "tryAgain",
  "Download failed": "downloadFailed",
  Sent: "sent",
  "No project default": "noProjectDefault",
  Rejected: "rejected",
  "Not found": "notFound",
  "Out of date": "outOfDate",
  "Custom disabled": "customDisabled",
  "Send answer": "sendAnswer",
})

const CALLBACK_TOAST_KIND = "callback-toast"

export function callbackToast(key, params = {}) {
  return { kind: CALLBACK_TOAST_KIND, key, params }
}

function isCallbackToast(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && value.kind === CALLBACK_TOAST_KIND && typeof value.key === "string"
}

export function localizeCallbackToast(text, locale) {
  if (isCallbackToast(text)) return translate(locale, `callbacks.${text.key}`, text.params || {})
  if (typeof text !== "string") return text
  const key = CALLBACK_TOAST_KEYS[text]
  if (key) return translate(locale, `callbacks.${key}`)
  if (text.startsWith("Model: ")) return translate(locale, "callbacks.modelValue", { value: text.slice("Model: ".length) })
  if (text.startsWith("Feed: ")) return translate(locale, "callbacks.feedValue", { value: text.slice("Feed: ".length) })
  return text
}
