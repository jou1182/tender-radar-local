import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRadarRepository } from "./lib/radar-repository.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(await readFile(path.join(projectRoot, "scripts", "sync-baseline.json"), "utf8"));
const repository = await createRadarRepository({ projectRoot });
repository.seedBaseline(baseline);
const snapshot = repository.getDashboardSnapshot();

console.log(JSON.stringify({
  ready: true,
  databasePath: repository.databasePath,
  schemaVersion: repository.schemaVersion,
  liveTenders: snapshot.items.length,
  lastSyncAt: snapshot.lastSyncAt,
}, null, 2));

repository.close();
