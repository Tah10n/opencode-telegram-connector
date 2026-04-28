// Back-compat entrypoint.
// Prefer: npm start / node src/cli.js
import { isModuleEntrypoint, runCliEntrypoint } from "./src/cli.js"

if (isModuleEntrypoint(import.meta.url)) {
  void runCliEntrypoint()
}
