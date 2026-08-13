import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "npm.cmd" : "npm";
const service = spawn(process.execPath, ["scripts/etimad-sync-service.mjs"], { stdio: "inherit" });
const site = spawn(command, ["run", "start"], { stdio: "inherit", shell: process.platform === "win32" });

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  service.kill("SIGTERM");
  site.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}

service.on("exit", (code) => { if (!closing) shutdown(code ?? 1); });
site.on("exit", (code) => { if (!closing) shutdown(code ?? 1); });
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
