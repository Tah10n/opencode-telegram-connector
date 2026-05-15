export default {
  cwd: ".",

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedUserId: Number(process.env.TELEGRAM_ALLOWED_USER_ID),
  },

  // Optional global defaults
  defaultProject: "localDesktop",
  // Optional: mirror user messages typed directly in opencode TUI to Telegram.
  // mirrorTuiUserMessages: true,
  logFormat: "text", // "text" or "json"

  // Optional localization. Supported locales in this release: "en", "ru".
  // Telegram language is detected automatically per chat/topic unless the user
  // chooses a language with /language.
  i18n: {
    defaultLocale: "en",
    supportedLocales: ["en", "ru"],
    autoDetectTelegramLanguage: true,
    botCommandLocales: ["en", "ru"],
  },

  // Optional local health endpoints for supervisors/probes.
  // Disabled by default and loopback-bound by default; not a Telegram webhook.
  // healthServer: { enabled: true, host: "127.0.0.1", port: 8787 },

  // Uncomment only if you intentionally use Basic Auth over
  // non-loopback http:// for a configured project.
  // allowInsecureHttp: process.env.OPENCODE_ALLOW_INSECURE_HTTP === "1",

  // Optional Telegram workflow limits. These defaults are used when omitted.
  limits: {
    userAttachmentConfirmBytes: 32 * 1024,
    userAttachmentMaxBytes: 256 * 1024,
    changedFilesLimit: 10,
    inlineDiffTextMaxChars: 2500,
    streamPreviewMaxChars: 3500,
    textAttachmentThreshold: 12_000,
  },

  // Optional auto-start watchdog tuning. Env fallbacks are also supported:
  // OPENCODE_WATCHDOG_FAILURE_THRESHOLD, OPENCODE_WATCHDOG_WINDOW_MS,
  // and OPENCODE_WATCHDOG_COOLDOWN_MS.
  // opencodeWatchdog: { failureThreshold: 6, windowMs: 120_000, cooldownMs: 60_000 },

  // Keep only the projects you plan to use, then run:
  // npm run setup:check
  projects: {
    localDesktop: {
      displayName: "Local desktop project",
      directory: "./project-a",
      port: 4100,
      autoStart: true,
      serverLaunchMode: "background",
      openTuiOnAutoStart: true,
      openAttachOnNewMode: "new-window",
    },

    remoteTeam: {
      displayName: "Remote shared server",
      baseUrl: "https://opencode.example.com",
      // Required by the default /global/event SSE stream so events can be
      // scoped safely. Omit only when using OPENCODE_SSE_EVENT_PATH=/event
      // for an older opencode build.
      directory: "/srv/workspaces/team-project",
      usernameEnv: "REMOTE_OPENCODE_USERNAME",
      passwordEnv: "REMOTE_OPENCODE_PASSWORD",
    },

    serverOnly: {
      displayName: "Headless local server",
      directory: "./project-b",
      port: 4101,
      autoStart: true,
      serverLaunchMode: "background",
      openTuiOnAutoStart: false,
      openAttachOnNewMode: "same-window",
    },
  },
}
