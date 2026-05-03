import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { loadProjectsConfig } from "../src/config/projects.js"

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `telegram-connector-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function swapEnv(t, patch) {
  const previous = new Map()
  for (const key of Object.keys(patch)) previous.set(key, process.env[key])
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test("loadProjectsConfig resolves relative directories from the projects file and derives baseUrl from port", async () => {
  const dir = await makeTempDir()
  const projectsFile = path.join(dir, "projects.json")
  await fs.writeFile(
    projectsFile,
    JSON.stringify({
      demo: {
        directory: "./repo",
        port: 4312,
        autoStart: true,
      },
    }),
    "utf8",
  )

  const projects = await loadProjectsConfig({ projectsFile })

  assert.deepEqual(projects.demo, {
    baseUrl: "http://127.0.0.1:4312",
    directory: path.resolve(dir, "repo"),
    port: 4312,
    autoStart: true,
    serverLaunchMode: "background",
    openTuiOnAutoStart: true,
    openAttachOnNewMode: "same-window",
    username: "",
    password: "",
    displayName: undefined,
  })
})

test("loadProjectsConfig reads basic auth from usernameEnv/passwordEnv", async (t) => {
  swapEnv(t, {
    PROJECT_USER: "alice",
    PROJECT_PASSWORD: "secret",
  })

  const projects = await loadProjectsConfig({
    baseDir: path.join("workspace", "configs"),
    projectsJson: JSON.stringify({
      demo: {
        baseUrl: "https://example.com/api",
        directory: "../repo",
        usernameEnv: "PROJECT_USER",
        passwordEnv: "PROJECT_PASSWORD",
      },
    }),
  })

  assert.equal(projects.demo.username, "alice")
  assert.equal(projects.demo.password, "secret")
  assert.equal(projects.demo.directory, path.resolve(path.join("workspace", "configs"), "../repo"))
})

test("loadProjectsConfig rejects baseUrl query strings and fragments", async () => {
  await assert.rejects(
    loadProjectsConfig({
      projectsJson: JSON.stringify({
        demo: { baseUrl: "http://127.0.0.1:4312?token=abc" },
      }),
    }),
    /invalid baseUrl.*must not include query strings or fragments/,
  )

  await assert.rejects(
    loadProjectsConfig({
      projectsJson: JSON.stringify({
        demo: { baseUrl: "http://127.0.0.1:4312#frag" },
      }),
    }),
    /invalid baseUrl.*must not include query strings or fragments/,
  )
})

test("loadProjectsConfig rejects baseUrl userinfo", async () => {
  await assert.rejects(
    loadProjectsConfig({
      projectsJson: JSON.stringify({
        demo: { baseUrl: "http://user:pass@example.com:4312" },
      }),
    }),
    /invalid baseUrl.*must not include username or password/,
  )
})

test("loadProjectsConfig rejects project aliases with colons", async () => {
  await assert.rejects(
    loadProjectsConfig({
      projectsJson: JSON.stringify({
        "demo:prod": { baseUrl: "http://127.0.0.1:4312" },
      }),
    }),
    /Project alias 'demo:prod' must not contain ':'/,
  )
})

test("loadProjectsConfig reports a Windows backslash hint for invalid JSON", async () => {
  await assert.rejects(
    loadProjectsConfig({
      projectsJson: '{"demo":{"directory":"C:\\Users\\dev\\repo"}}',
    }),
    /Common on Windows: JSON strings cannot contain unescaped backslashes/,
  )
})

test("loadProjectsConfig rejects autoStart projects without a port", async () => {
  await assert.rejects(
    loadProjectsConfig({
      projectsJson: JSON.stringify({
        demo: {
          baseUrl: "http://127.0.0.1:3000",
          directory: "./repo",
          autoStart: true,
        },
      }),
    }),
    /Project 'demo' autoStart requires 'port'/,
  )
})

test("loadProjectsConfig rejects non-boolean autoStart and openTuiOnAutoStart", async () => {
  await assert.rejects(
    loadProjectsConfig({
      projectsJson: JSON.stringify({
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          autoStart: "true",
        },
      }),
    }),
    /Project 'demo' autoStart must be a boolean/,
  )

  await assert.rejects(
    loadProjectsConfig({
      projectsJson: JSON.stringify({
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          openTuiOnAutoStart: "false",
        },
      }),
    }),
    /Project 'demo' openTuiOnAutoStart must be a boolean/,
  )
})

test("loadProjectsConfig rejects invalid serverLaunchMode", async () => {
  await assert.rejects(
    loadProjectsConfig({
      projectsJson: JSON.stringify({
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          serverLaunchMode: "popup",
        },
      }),
    }),
    /invalid serverLaunchMode/,
  )
})

test("loadProjectsConfig rejects removed startMode", async () => {
  await assert.rejects(
    loadProjectsConfig({
      projectsJson: JSON.stringify({
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          startMode: "tui",
        },
      }),
    }),
    /removed setting 'startMode'/,
  )
})

test("loadProjectsConfig rejects removed openAttachOnNew", async () => {
  await assert.rejects(
    loadProjectsConfig({
      projectsJson: JSON.stringify({
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          openAttachOnNew: true,
        },
      }),
    }),
    /removed setting 'openAttachOnNew'/,
  )
})

test("loadProjectsConfig rejects invalid openAttachOnNewMode", async () => {
  await assert.rejects(
    loadProjectsConfig({
      projectsJson: JSON.stringify({
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          openAttachOnNewMode: "reuse",
        },
      }),
    }),
    /invalid openAttachOnNewMode/,
  )
})
