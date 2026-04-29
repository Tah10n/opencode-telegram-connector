import test from "node:test"
import assert from "node:assert/strict"
import { OpenCodeClient } from "../src/opencode/client.js"
import { redactCmdlineSecrets, redactSensitiveText, sanitizeBaseUrlForCli, sanitizeBaseUrlForDisplay } from "../src/url-utils.js"

test("sanitizeBaseUrlForDisplay removes credentials, hash, and query values", () => {
  const sanitized = sanitizeBaseUrlForDisplay("https://user:pass@example.com/api?token=abc&foo=bar#frag")
  assert.equal(sanitized, "https://example.com/api?token=***&foo=***")
})

test("sanitizeBaseUrlForCli flags URLs with query strings as sensitive", () => {
  const result = sanitizeBaseUrlForCli("https://example.com/api?opaque=secret-value#frag")
  assert.equal(result.url, "https://example.com/api?opaque=secret-value")
  assert.equal(result.displayUrl, "https://example.com/api?opaque=***")
  assert.equal(result.seemsSensitive, true)
  assert.equal(result.hadUserInfo, false)
})

test("sanitizeBaseUrlForCli flags URL userinfo as sensitive", () => {
  const result = sanitizeBaseUrlForCli("https://user:pass@example.com/api")
  assert.equal(result.hadUserInfo, true)
  assert.equal(result.seemsSensitive, true)
  assert.equal(result.displayUrl, "https://***:***@example.com/api")
})

test("redactCmdlineSecrets redacts auth-like command line data", () => {
  const redacted = redactCmdlineSecrets(
    'opencode attach "https://user:pass@example.com/api?token=abc#frag" --password hunter2 Authorization: Bearer abc',
  )
  assert.match(redacted, /https:\/\/\*\*\*:\*\*\*@example\.com\/api\?token=\*\*\*/)
  assert.match(redacted, /--password=\*\*\*/)
  assert.match(redacted, /Authorization: Bearer \*\*\*/)
})

test("redactSensitiveText redacts bot tokens and sensitive state/config paths", () => {
  const text = [
    "https://api.telegram.org/bot123456789:replace_me/sendMessage",
    "C:\\repo\\project\\connector.config.mjs",
    "C:\\repo\\project\\.data\\state.json.backup.20260425",
    "C:\\repo\\project\\.env",
    "token=123456789:replace_me",
  ].join(" ")

  const redacted = redactSensitiveText(text, { knownSecrets: ["123456789:replace_me"] })

  assert.match(redacted, /\/bot\*\*\*/)
  assert.match(redacted, /<config-file>/)
  assert.match(redacted, /<state-file>/)
  assert.match(redacted, /<env-file>/)
  assert.doesNotMatch(redacted, /123456789:replace_me|C:\\repo|backup\.20260425/)
})

test("redactSensitiveText masks high-entropy tokens via entropy heuristic", () => {
  // GitHub PAT (40 chars, high entropy) — must be redacted
  const githubPat = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234"
  assert.doesNotMatch(redactSensitiveText(githubPat), new RegExp(githubPat))

  // Anthropic-style key (long, high entropy) — must be redacted
  const anthropicKey = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456"
  assert.doesNotMatch(redactSensitiveText(anthropicKey), new RegExp("sk-ant-api03-ABCD"))

  const jwtToken = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  assert.doesNotMatch(redactSensitiveText(jwtToken), /eyJhbGci/)

  // ULID (26 chars) — must NOT be redacted (below 32-char length threshold)
  const ulid = "01HZ9VY3T6KQYMEXZJ5XTMK4WR"
  assert.match(redactSensitiveText(ulid), new RegExp(ulid))

  // UUID hex without dashes (32 chars, low entropy ~3.3 bits/char) — must NOT be redacted
  // This specific UUID has many repeated digits, keeping entropy below the 4.0 threshold.
  const uuid = "550e8400e29b41d4a716446655440000"
  assert.match(redactSensitiveText(uuid), new RegExp(uuid))

  // Repeated char string (very low entropy) — must NOT be redacted
  const lowEntropy = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  assert.match(redactSensitiveText(lowEntropy), new RegExp("AAAA"))
})

test("OpenCodeClient rejects insecure basic auth to non-loopback http", () => {
  assert.throws(
    () => new OpenCodeClient({ baseUrl: "http://example.com", username: "u", password: "p" }),
    /Refusing to send Basic Auth credentials over insecure HTTP/,
  )
  assert.throws(
    () => new OpenCodeClient({ baseUrl: "http://127.attacker.example", username: "u", password: "p" }),
    /Refusing to send Basic Auth credentials over insecure HTTP/,
  )
})

test("OpenCodeClient rejects credentials embedded in baseUrl", () => {
  assert.throws(
    () => new OpenCodeClient({ baseUrl: "http://user:pass@example.com" }),
    /OpenCode baseUrl must not include username or password/,
  )
})

test("OpenCodeClient allows insecure basic auth only for literal loopback hosts", () => {
  assert.equal(new OpenCodeClient({ baseUrl: "http://localhost:4312", password: "p" }).baseUrl, "http://localhost:4312")
  assert.equal(new OpenCodeClient({ baseUrl: "http://127.0.0.1:4312", password: "p" }).baseUrl, "http://127.0.0.1:4312")
  assert.equal(new OpenCodeClient({ baseUrl: "http://[::1]:4312", password: "p" }).baseUrl, "http://[::1]:4312")
})

test("OpenCodeClient allows insecure basic auth override", () => {
  const client = new OpenCodeClient({
    baseUrl: "http://example.com",
    username: "u",
    password: "p",
    allowInsecureHttp: true,
  })
  assert.equal(client.baseUrl, "http://example.com")
})
