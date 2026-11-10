import { runDesktopSmoke } from "./lib/desktop-smoke.mjs";
await runDesktopSmoke("core-policies");
await runDesktopSmoke("events");
