import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { buildRuntimeConfig, parseCliArgs } from "../src/config/runtime.js"

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

test("buildRuntimeConfig loads connector.config.mjs and resolves relative paths", async (t) => {
  const dir = await makeTempDir()
  swapEnv(t, {
    TELEGRAM_BOT_TOKEN: undefined,
    TELEGRAM_ALLOWED_USER_ID: undefined,
    DEFAULT_PROJECT: undefined,
    STATE_FILE: undefined,
    TG_PREFIX: undefined,
    ECHO_FILTER_MODE: undefined,
    OPENCODE_ALLOW_INSECURE_HTTP: undefined,
    PROJECTS_FILE: undefined,
    PROJECTS_JSON: undefined,
  })
  await fs.writeFile(
    path.join(dir, "connector.config.mjs"),
    `export default {
      telegram: { botToken: "cfg-token", allowedUserId: 42 },
      defaultProject: "demo",
      stateFile: "./state/custom.json",
      tgPrefix: "[TG] ",
      echoFilterMode: "recent",
      allowInsecureHttp: true,
      projects: {
        demo: {
          directory: "./repo",
          port: 4312,
          autoStart: true
        }
      }
    }
    `,
    "utf8",
  )

  const { config, loadedConfigFile } = await buildRuntimeConfig({ cwd: dir })

  assert.equal(loadedConfigFile, true)
  assert.equal(config.telegram.botToken, "cfg-token")
  assert.equal(config.telegram.allowedUserId, 42)
  assert.equal(config.defaultProject, "demo")
  assert.equal(config.stateFile, path.resolve(dir, "state/custom.json"))
  assert.equal(config.cwd, dir)
  assert.equal(config.projects.demo.directory, path.resolve(dir, "repo"))
  assert.equal(config.allowInsecureHttp, true)
})

test("buildRuntimeConfig loads .env before evaluating connector.config.mjs", async (t) => {
  const dir = await makeTempDir()
  swapEnv(t, {
    TELEGRAM_BOT_TOKEN: undefined,
    TELEGRAM_ALLOWED_USER_ID: undefined,
    PROJECT_PASSWORD: undefined,
    PROJECTS_FILE: undefined,
    PROJECTS_JSON: undefined,
  })
  await fs.writeFile(path.join(dir, ".env"), "TELEGRAM_BOT_TOKEN=env-token\nTELEGRAM_ALLOWED_USER_ID=77\nPROJECT_PASSWORD=secret\n", "utf8")
  await fs.writeFile(
    path.join(dir, "connector.config.mjs"),
    `export default {
      telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        allowedUserId: process.env.TELEGRAM_ALLOWED_USER_ID
      },
      projects: {
        demo: {
          baseUrl: "http://127.0.0.1:4312",
          username: "opencode",
          passwordEnv: "PROJECT_PASSWORD"
        }
      }
    }
    `,
    "utf8",
  )

  const { config } = await buildRuntimeConfig({ cwd: dir })

  assert.equal(config.telegram.botToken, "env-token")
  assert.equal(config.telegram.allowedUserId, 77)
  assert.equal(config.projects.demo.password, "secret")
})

test("buildRuntimeConfig lets connector.config.mjs override legacy env and projects json", async (t) => {
  const dir = await makeTempDir()
  swapEnv(t, {
    TELEGRAM_BOT_TOKEN: undefined,
    TELEGRAM_ALLOWED_USER_ID: undefined,
    DEFAULT_PROJECT: undefined,
    TG_PREFIX: undefined,
    PROJECTS_JSON: undefined,
  })
  await fs.writeFile(
    path.join(dir, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=env-token",
      "TELEGRAM_ALLOWED_USER_ID=99",
      "DEFAULT_PROJECT=env-default",
      "TG_PREFIX=[ENV] ",
      'PROJECTS_JSON={"envdemo":{"baseUrl":"http://127.0.0.1:4999"}}',
    ].join("\n"),
    "utf8",
  )
  await fs.writeFile(
    path.join(dir, "connector.config.mjs"),
    `export default {
      telegram: { botToken: "cfg-token", allowedUserId: 42 },
      defaultProject: "cfg-default",
      tgPrefix: "[CFG] ",
      projects: {
        cfgdemo: {
          baseUrl: "http://127.0.0.1:4312"
        }
      }
    }
    `,
    "utf8",
  )

  const { config } = await buildRuntimeConfig({ cwd: dir })

  assert.equal(config.telegram.botToken, "cfg-token")
  assert.equal(config.telegram.allowedUserId, 42)
  assert.equal(config.defaultProject, "cfg-default")
  assert.equal(config.tgPrefix, "[CFG] ")
  assert.deepEqual(Object.keys(config.projects), ["cfgdemo"])
})

test("buildRuntimeConfig lets CLI projects json override config file projects", async (t) => {
  const dir = await makeTempDir()
  swapEnv(t, {
    TELEGRAM_BOT_TOKEN: undefined,
    TELEGRAM_ALLOWED_USER_ID: undefined,
    PROJECTS_JSON: undefined,
  })
  await fs.writeFile(
    path.join(dir, "connector.config.mjs"),
    `export default {
      telegram: { botToken: "cfg-token", allowedUserId: 42 },
      projects: {
        demo: { baseUrl: "http://127.0.0.1:4312" }
      }
    }
    `,
    "utf8",
  )

  const { config } = await buildRuntimeConfig({
    cwd: dir,
    args: {
      projectsJson: JSON.stringify({
        override: { baseUrl: "http://127.0.0.1:4999" },
      }),
    },
  })

  assert.deepEqual(Object.keys(config.projects), ["override"])
  assert.equal(config.projects.override.baseUrl, "http://127.0.0.1:4999")
})

test("buildRuntimeConfig falls back to legacy env and projects json when config file is absent", async (t) => {
  const dir = await makeTempDir()
  swapEnv(t, {
    TELEGRAM_BOT_TOKEN: undefined,
    TELEGRAM_ALLOWED_USER_ID: undefined,
    PROJECTS_JSON: undefined,
  })
  await fs.writeFile(
    path.join(dir, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=env-token",
      "TELEGRAM_ALLOWED_USER_ID=77",
      'PROJECTS_JSON={"demo":{"baseUrl":"http://127.0.0.1:4312"}}',
    ].join("\n"),
    "utf8",
  )

  const { config, loadedConfigFile } = await buildRuntimeConfig({ cwd: dir })

  assert.equal(loadedConfigFile, false)
  assert.equal(config.telegram.botToken, "env-token")
  assert.equal(config.telegram.allowedUserId, 77)
  assert.equal(config.projects.demo.baseUrl, "http://127.0.0.1:4312")
})

test("parseCliArgs parses supported flags and help aliases", () => {
  const parsed = parseCliArgs([
    "--env-file",
    "./.env.custom",
    "--config-file",
    "./config/connector.config.mjs",
    "--projects-file",
    "./projects.json",
    "--projects-json",
    '{"demo":{"baseUrl":"http://127.0.0.1:4312"}}',
    "--state-file",
    "./.data/state.json",
    "-h",
    "--unknown",
  ])

  assert.deepEqual(parsed, {
    envFile: "./.env.custom",
    configFile: "./config/connector.config.mjs",
    projectsFile: "./projects.json",
    projectsJson: '{"demo":{"baseUrl":"http://127.0.0.1:4312"}}',
    stateFile: "./.data/state.json",
    help: true,
  })

  assert.deepEqual(parseCliArgs(["--help"]), { help: true })
  assert.deepEqual(parseCliArgs([]), {})
})

test("parseCliArgs rejects missing flag values", () => {
  assert.throws(() => parseCliArgs(["--env-file"]), /Missing value for --env-file/)
  assert.throws(() => parseCliArgs(["--projects-file", "--state-file", "state.json"]), /Missing value for --projects-file/)
})

test("buildRuntimeConfig resolves explicit CLI env, config, projects, and state paths from cwd", async (t) => {
  const dir = await makeTempDir()
  const nestedDir = path.join(dir, "nested")
  await fs.mkdir(nestedDir, { recursive: true })
  swapEnv(t, {
    TELEGRAM_BOT_TOKEN: undefined,
    TELEGRAM_ALLOWED_USER_ID: undefined,
    PROJECTS_JSON: undefined,
    PROJECTS_FILE: undefined,
    STATE_FILE: undefined,
  })
  await fs.writeFile(path.join(nestedDir, "custom.env"), "TELEGRAM_BOT_TOKEN=env-token\nTELEGRAM_ALLOWED_USER_ID=77\n", "utf8")
  await fs.writeFile(
    path.join(nestedDir, "connector.config.mjs"),
    `export default {
      projects: {
        cfgdemo: {
          baseUrl: "http://127.0.0.1:4312"
        }
      }
    }
    `,
    "utf8",
  )
  await fs.writeFile(
    path.join(nestedDir, "projects.json"),
    JSON.stringify({ filedemo: { directory: "./repo", port: 4999 } }, null, 2),
    "utf8",
  )

  const { config, envFile, configFile, loadedConfigFile } = await buildRuntimeConfig({
    cwd: dir,
    args: {
      envFile: path.relative(process.cwd(), path.join(nestedDir, "custom.env")),
      configFile: path.relative(process.cwd(), path.join(nestedDir, "connector.config.mjs")),
      projectsFile: path.relative(process.cwd(), path.join(nestedDir, "projects.json")),
      stateFile: path.relative(process.cwd(), path.join(nestedDir, "state.json")),
    },
  })

  assert.equal(envFile, path.resolve(dir, "nested", "custom.env"))
  assert.equal(configFile, path.resolve(dir, "nested", "connector.config.mjs"))
  assert.equal(loadedConfigFile, true)
  assert.equal(config.telegram.botToken, "env-token")
  assert.equal(config.telegram.allowedUserId, 77)
  assert.equal(config.stateFile, path.resolve(dir, "nested", "state.json"))
  assert.deepEqual(Object.keys(config.projects), ["filedemo"])
  assert.equal(config.projects.filedemo.directory, path.resolve(dir, "nested", "repo"))
})
