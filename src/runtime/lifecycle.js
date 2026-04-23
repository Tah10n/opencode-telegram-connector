function createDeferred() {
  let resolve = () => {}
  let reject = () => {}
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createObservedDone(promise, onSettled) {
  const raw = Promise.resolve(promise).finally(onSettled)
  return raw.catch(() => {})
}

export function createLifecycleManager() {
  const records = new Set()

  function registerRecord(record) {
    records.add(record)
    return {
      stop: record.stop,
      done: record.done,
      isActive() {
        return records.has(record)
      },
    }
  }

  function registerPromise(name, promise, { kind = "task", stop, metadata } = {}) {
    const record = {
      name,
      kind,
      metadata: metadata || null,
      createdAt: Date.now(),
      stopCalled: false,
      stop: null,
      done: null,
    }

    record.stop = async () => {
      if (record.stopCalled) return
      record.stopCalled = true
      await Promise.resolve(stop?.()).catch(() => {})
    }
    record.done = createObservedDone(promise, () => records.delete(record))
    return registerRecord(record)
  }

  function registerHandle(name, handle, { kind = "task", metadata } = {}) {
    const deferred = createDeferred()
    const stop = async () => {
      await Promise.resolve(handle?.stop?.()).catch(() => {})
      if (!handle?.done) deferred.resolve()
    }
    const done = handle?.done ? Promise.resolve(handle.done) : deferred.promise
    return registerPromise(name, done, { kind, stop, metadata })
  }

  function registerTimer(name, timerHandle, { clear = clearInterval, metadata } = {}) {
    return registerHandle(
      name,
      {
        stop() {
          clear?.(timerHandle)
        },
      },
      { kind: "timer", metadata },
    )
  }

  function registerStopHook(name, stop, { kind = "cleanup", metadata } = {}) {
    return registerHandle(
      name,
      {
        stop,
      },
      { kind, metadata },
    )
  }

  async function stopAll() {
    const snapshot = [...records]
    await Promise.allSettled(snapshot.map((record) => Promise.resolve(record.stop?.()).catch(() => {})))
    await Promise.allSettled(snapshot.map((record) => record.done))
  }

  function snapshot() {
    return [...records].map((record) => ({
      name: record.name,
      kind: record.kind,
      metadata: record.metadata,
      createdAt: record.createdAt,
      stopCalled: record.stopCalled,
    }))
  }

  return {
    registerPromise,
    registerHandle,
    registerTimer,
    registerStopHook,
    stopAll,
    snapshot,
  }
}
