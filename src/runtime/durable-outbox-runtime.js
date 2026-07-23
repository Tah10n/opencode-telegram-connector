import { createDurableOutbox } from "../connector/outbox.js"

export function createDurableOutboxRuntime({
  store,
  logger,
  observability,
  abortSignal,
  sleep,
  startManagedTask,
  maxEntries,
  maxCapacityWaiters,
} = {}) {
  const outbox = createDurableOutbox({
    store,
    logger,
    observability,
    abortSignal,
    sleep,
    maxEntries,
    maxCapacityWaiters,
  })
  observability?.setOutboxSnapshotProvider?.(() => outbox.snapshot())
  return {
    outbox,
    start(deliver) {
      outbox.setDeliver(deliver)
      return startManagedTask(
        "durableOutbox",
        () => outbox.run(),
        { kind: "loop", metadata: { source: "telegram", operation: "durable outbox delivery" }, fatalOnError: true },
      )
    },
    async drain({ timeoutMs = 5000 } = {}) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
      try {
        return await outbox.drain({ signal: controller.signal })
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
