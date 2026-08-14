import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRadarRepository } from "./lib/radar-repository.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// RADAR_DB_INIT_ROOT يوجّه التهيئة إلى قاعدة مؤقتة مستقلة (للاختبارات)، دون لمس قاعدة المشروع.
const projectRoot = process.env.RADAR_DB_INIT_ROOT ? path.resolve(process.env.RADAR_DB_INIT_ROOT) : scriptRoot;
const baseline = JSON.parse(await readFile(path.join(scriptRoot, "scripts", "sync-baseline.json"), "utf8"));
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
