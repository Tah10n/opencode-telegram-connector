import { createConnectorLifecycleTools } from "./connector-lifecycle.js"
import { createTelegramUpdateLoop } from "./telegram-loop.js"
import { createTelegramContextTools } from "./telegram-context.js"
import { createTuiSessionSyncTools } from "./tui-session-sync.js"

export function createRuntimeFoundation({
  lifecycle,
  abortController,
  logger,
  onFatalError,
  runtimeObservability,
  sleep,
  config,
  store,
  tg,
} = {}) {
  return {
    lifecycle: createConnectorLifecycleTools({
      lifecycle,
      abortController,
      logger,
      onFatalError,
      runtimeObservability,
      sleep,
    }),
    telegramContext: createTelegramContextTools({ config, store, tg }),
  }
}

export function createRuntimeTuiSync(options = {}) {
  return createTuiSessionSyncTools(options)
}

export function createRuntimeTelegramLoop(options = {}) {
  return createTelegramUpdateLoop(options)
}
