import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const verifyScript = fileURLToPath(new URL("../scripts/verify-callback-data.mjs", import.meta.url))

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `telegram-connector-callback-guard-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

test("callback data guard rejects raw callback payload literals", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "bad.js"), "const data = `s|${projectAlias}|${sessionId}`\nconst button = { callback_data: data }\n", "utf8")

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw callback payload literal/)
      assert.match(err.stderr, /bad\.js:1/)
      return true
    },
  )
})

test("callback data guard rejects line-wrapped raw callback payload literals", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "bad.js"), "const data = `s|${projectAlias}|${\n  sessionId\n}`\nconst button = { callback_data: data }\n", "utf8")

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw callback payload literal/)
      assert.match(err.stderr, /bad\.js:1/)
      return true
    },
  )
})

test("callback data guard rejects pipe-joined callback payload variables", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "bad.js"), "const data = [\"s\", projectAlias, sessionId].join(\"|\")\nconst button = { callback_data: data }\n", "utf8")

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:2/)
      return true
    },
  )
})

test("callback data guard rejects raw second callback payloads on one line", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    "const buttons = [{ callback_data: packCallback(\"s\", projectAlias, sessionId) }, { callback_data: [\"s\", projectAlias, sessionId].join(\"|\") }]\n",
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:1/)
      return true
    },
  )
})

test("callback data guard rejects raw second callback literals on one line", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    "const buttons = [{ callback_data: packCallback(\"s\", projectAlias, sessionId) }, { callback_data: `s|${projectAlias}|${sessionId}` }]\n",
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-delimited callback_data/)
      assert.match(err.stderr, /bad\.js:1/)
      return true
    },
  )
})

test("callback data guard rejects aliased raw pipe-joined callback variables", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    [
      "const raw = [\"s\", projectAlias, sessionId].join(\"|\")",
      "const data = raw",
      "const button = { callback_data: data }",
    ].join("\n"),
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:3/)
      return true
    },
  )
})

test("callback data guard rejects tainted aliases in ternary assignments", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    [
      "const raw = [\"s\", projectAlias, sessionId].join(\"|\")",
      "const safePayload = packCallback(\"s\", projectAlias, sessionId)",
      "const data = condition ? safePayload : raw",
      "const button = { callback_data: data }",
    ].join("\n"),
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:4/)
      return true
    },
  )
})

test("callback data guard rejects pipe-joined cb.pack payload variables", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "bad.js"), "const payload = [\n  \"s\",\n  projectAlias,\n  sessionId,\n].join(\"|\")\nconst button = { callback_data: cb.pack(payload) }\n", "utf8")

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:6/)
      return true
    },
  )
})

test("callback data guard rejects raw pipe-delimited cb.pack literals", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "bad.js"), "const packed = cb.pack(\"s|demo|ses\")\nString(packed)\n", "utf8")

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw callback payload literal/)
      assert.match(err.stderr, /bad\.js:1/)
      return true
    },
  )
})

test("callback data guard allows encoded cb.pack arguments with pipe-bearing parts", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "good.js"), "const packed = cb.pack(encodeCallback([\"m|not-raw\"]))\nString(packed)\n", "utf8")

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard rejects formatted pipe-joined callback variables", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "bad.js"), "const data = [\"s\", projectAlias, sessionId].join(\"|\")\nconst button = {\n  callback_data:\n    data,\n}\n", "utf8")

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:3/)
      return true
    },
  )
})

test("callback data guard rejects long formatted inline pipe joins", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    [
      "const button = {",
      "  callback_data: [",
      "    \"s\",",
      "    projectAlias,",
      "    sessionId,",
      "    String(Date.now()),",
      "    \"extra\",",
      "  ].join(\"|\"),",
      "}",
    ].join("\n"),
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:2/)
      return true
    },
  )
})

test("callback data guard rejects operator-continuation pipe joins", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    [
      "const button = {",
      "  callback_data: condition",
      "    ? [\"s\", projectAlias, sessionId].join(\"|\")",
      "    : packCallback(\"s\", projectAlias, sessionId),",
      "}",
    ].join("\n"),
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:2/)
      return true
    },
  )
})

test("callback data guard rejects ternary alternate pipe joins after safe branch", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    [
      "const button = {",
      "  callback_data: condition ? packCallback(\"s\", projectAlias, sessionId)",
      "    : [\"s\", projectAlias, sessionId].join(\"|\"),",
      "}",
    ].join("\n"),
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:2/)
      return true
    },
  )
})

test("callback data guard rejects ternary raw pipe-joined variables", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    [
      "const data = [\"s\", projectAlias, sessionId].join(\"|\")",
      "const safePayload = packCallback(\"s\", projectAlias, sessionId)",
      "const button = { callback_data: condition ? data : safePayload }",
    ].join("\n"),
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:3/)
      return true
    },
  )
})

test("callback data guard rejects raw pipe variables passed to packer helpers", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    [
      "const payload = [\"s\", projectAlias, sessionId].join(\"|\")",
      "const button = { callback_data: packCallback(payload) }",
    ].join("\n"),
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:2/)
      return true
    },
  )
})

test("callback data guard rejects nested arrow raw pipe-joined variables", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    [
      "const keyboard = () => {",
      "  const data = [\"s\", projectAlias, sessionId].join(\"|\")",
      "  return { callback_data: data }",
      "}",
    ].join("\n"),
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:3/)
      return true
    },
  )
})

test("callback data guard rejects raw pipe joins after wrapped assignment equals", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    [
      "const payload =",
      "  [\"s\", projectAlias, sessionId].join(\"|\")",
      "const button = { callback_data: payload }",
    ].join("\n"),
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:3/)
      return true
    },
  )
})

test("callback data guard rejects raw pipe joins after wrapped ternary assignment", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    [
      "const payload =",
      "  condition",
      "    ? [\"s\", projectAlias, sessionId].join(\"|\")",
      "    : packCallback(\"s\", projectAlias, sessionId)",
      "const button = { callback_data: payload }",
    ].join("\n"),
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:5/)
      return true
    },
  )
})

test("callback data guard rejects reassigned raw pipe callback payloads", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "bad.js"),
    [
      "let payload = packCallback(\"s\", projectAlias, sessionId)",
      "payload = [\"s\", projectAlias, sessionId].join(\"|\")",
      "const button = { callback_data: payload }",
    ].join("\n"),
    "utf8",
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:3/)
      return true
    },
  )
})

test("callback data guard rejects template-literal pipe joins", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "bad.js"), "const data = [\"s\", projectAlias, sessionId].join(`|`)\nconst button = { callback_data: data }\n", "utf8")

  await assert.rejects(
    execFileAsync(process.execPath, [verifyScript, dir]),
    (err) => {
      assert.match(err.stderr, /raw pipe-joined callback payload/)
      assert.match(err.stderr, /bad\.js:2/)
      return true
    },
  )
})

test("callback data guard allows non-callback pipe joins", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "good.js"), "const alternation = [\"token\", \"secret\"].join(\"|\")\nconst re = new RegExp(alternation)\nconst button = { callback_data: packCallback(\"s\", projectAlias, sessionId) }\n", "utf8")

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard avoids semicolonless assignment false positives", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    "const data = packCallback(\"s\", projectAlias, sessionId)\nconst alternation = parts.join(\"|\")\nconst button = { callback_data: data }\n",
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard uses the nearest assignment for same-name variables", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "function regexSource(parts) {",
      "  const data = parts.join(\"|\")",
      "  return data",
      "}",
      "function keyboard(projectAlias, sessionId, packCallback) {",
      "  const data = packCallback(\"s\", projectAlias, sessionId)",
      "  return { callback_data: data }",
      "}",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard ignores non-callback joins after complete callback payloads", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "const button = { callback_data: packCallback(\"s\", projectAlias, sessionId) }",
      "const alternation = parts.join(\"|\")",
      "export default button",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard ignores pipe-joined text labels next to safe payload variables", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "const label = parts.join(\"|\")",
      "const payload = packCallback(\"s\", projectAlias, sessionId)",
      "const button = { text: label, callback_data: payload }",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard ignores pipe-joined text labels after safe payload variables", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "const label = parts.join(\"|\")",
      "const payload = packCallback(\"s\", projectAlias, sessionId)",
      "const button = { callback_data: payload, text: label }",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard ignores inline pipe-joined text after safe callback payload", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    "const button = { callback_data: packCallback(\"s\", projectAlias, sessionId), text: parts.join(\"|\") }\n",
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard ignores bracket strings in safe callback payloads", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    "const button = { callback_data: packCallback(\"(\"), text: parts.join(\"|\") }\n",
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard allows encoded callback parts containing pipes", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "const modelButton = { callback_data: packCallback(\"m\", \"apply\", \"provider/model|with-pipe\") }",
      "const prefixedPart = { callback_data: packCallback(\"m|not-raw\") }",
      "const ternaryPart = { callback_data: packCallback(condition ? \"s|value\" : \"x\") }",
      "const wrappedPart = {",
      "  callback_data:",
      "    packCallback(",
      "      \"m|wrapped\",",
      "    ),",
      "}",
      "const runtimePacked = cb.pack(\"m\", \"apply\", \"provider/model|with-pipe\")",
      "String(runtimePacked)",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard ignores comment brackets after complete callback payloads", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "const button = { callback_data: packCallback(\"s\", projectAlias, sessionId) } // unmatched ({[ in comment",
      "const alternation = parts.join(\"|\")",
      "export default button",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard ignores block-commented raw pipe joins", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "/*",
      "const data = [\"s\", projectAlias, sessionId].join(\"|\")",
      "*/",
      "const data = packCallback(\"s\", projectAlias, sessionId)",
      "const button = { callback_data: data }",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard ignores shadowed pipe joins outside callback scope", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "function keyboard(parts, projectAlias, sessionId, packCallback) {",
      "  const data = packCallback(\"s\", projectAlias, sessionId)",
      "  if (parts.length) {",
      "    const data = parts.join(\"|\")",
      "    String(data)",
      "  }",
      "  return { callback_data: data }",
      "}",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard ignores same-name variables in sibling scopes", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "function regexSource(parts) {",
      "  const data = parts.join(\"|\")",
      "  return data",
      "}",
      "function keyboard(data) {",
      "  return { callback_data: data }",
      "}",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard treats function parameters as shadowing outer pipe joins", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "const data = parts.join(\"|\")",
      "function keyboard(data) {",
      "  return { callback_data: data }",
      "}",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard treats wrapped function parameters as shadowing outer pipe joins", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "const data = parts.join(\"|\")",
      "function keyboard(",
      "  data,",
      ") {",
      "  return { callback_data: data }",
      "}",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard treats async arrow parameters as shadowing outer pipe joins", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "const data = parts.join(\"|\")",
      "const keyboard = async (data) => {",
      "  return { callback_data: data }",
      "}",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard treats concise arrow parameters as shadowing outer pipe joins", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(
    path.join(dir, "good.js"),
    [
      "const data = parts.join(\"|\")",
      "const keyboard = async (data) => ({ callback_data: data })",
    ].join("\n"),
    "utf8",
  )

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})

test("callback data guard allows encoded callback usage", async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, "good.js"), "const button = { callback_data: packCallback(\"s\", projectAlias, sessionId) }\n", "utf8")

  const result = await execFileAsync(process.execPath, [verifyScript, dir])

  assert.match(result.stdout, /Callback data guard passed/)
})
