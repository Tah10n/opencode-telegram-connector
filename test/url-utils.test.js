import test from "node:test"
import assert from "node:assert/strict"
import { OpenCodeClient } from "../src/opencode/client.js"
import { redactCmdlineSecrets, sanitizeBaseUrlForCli, sanitizeBaseUrlForDisplay } from "../src/url-utils.js"

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

test("OpenCodeClient rejects insecure basic auth to non-loopback http", () => {
  assert.throws(
    () => new OpenCodeClient({ baseUrl: "http://example.com", username: "u", password: "p" }),
    /Refusing to send Basic Auth credentials over insecure HTTP/,
  )
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
