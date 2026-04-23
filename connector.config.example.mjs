export default {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedUserId: Number(process.env.TELEGRAM_ALLOWED_USER_ID),
  },

  // Optional global defaults
  defaultProject: "pocket",
  stateFile: "./.data/state.json",
  tgPrefix: "",
  echoFilterMode: "recent",
  allowInsecureHttp: false,

  projects: {
    pocket: {
      directory: "./project-a",
      port: 4100,
      autoStart: true,

      // Server launch mode:
      // - "background" => start the server in the background
      // - "window" => start the server in a visible terminal window
      serverLaunchMode: "background",

      // TUI behavior after autoStart / Start button:
      // - true  => open opencode attach --continue after the server becomes healthy
      // - false => do not open a TUI window automatically
      openTuiOnAutoStart: true,

      // /new session behavior:
      // - "new-window" => open a fresh attach window for the new session
      // - "same-window" => do not open another window; try to switch an existing attached TUI to the new session (best-effort)
      //                    and switch Telegram only after the server reports the new active TUI session
      openAttachOnNewMode: "new-window",

      username: "opencode",
      passwordEnv: "PROJECT_A_OPENCODE_PASSWORD",
    },

    // Example: visible server window, but do not auto-open TUI.
    foo: {
      directory: "./project-b",
      port: 4101,
      autoStart: true,
      serverLaunchMode: "window",
      openTuiOnAutoStart: false,
      openAttachOnNewMode: "same-window",
    },

    // Common presets you can copy per project:
    // quietBackground: {
    //   directory: "./project-c",
    //   port: 4102,
    //   autoStart: true,
    //   serverLaunchMode: "background",
    //   openTuiOnAutoStart: false,
    //   openAttachOnNewMode: "same-window",
    // },
    //
    // fullWindowedUx: {
    //   directory: "./project-d",
    //   port: 4103,
    //   autoStart: true,
    //   serverLaunchMode: "window",
    //   openTuiOnAutoStart: true,
    //   openAttachOnNewMode: "new-window",
    // },
  },
}
