// مشغل المقارنة Offline — P4-M0A.
// يقيّم تقرير analysis-report-v3 جاهزًا (ملف JSON محلي) مقابل حالة benchmark
// دون استدعاء أي نموذج أو خدمة. لا يبني التقارير من نموذج إطلاقًا؛ مصدر
// التقرير ملف محلي فقط (مثل benchmark/samples/*.json أو ناتج مرحلة لاحقة
// مسموح بها صراحة). modelId سلسلة محايدة لا تؤثر في النتيجة.
// الاستخدام:
//   node scripts/run-analysis-benchmark.mjs --case m0a-clear \
//     --report benchmark/samples/valid-report.json --model model-a \
//     [--telemetry path/to/telemetry.json]
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadBenchmarkCase } from "./lib/analysis-benchmark-manifest.mjs";
import { evaluateBenchmarkRun } from "./lib/analysis-benchmark-evaluator.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const benchmarkRoot = args.benchmarkRoot ? path.resolve(args.benchmarkRoot) : path.join(repoRoot, "benchmark");
  if (!args.case || !args.report || !args.model) {
    console.error("الاستخدام: --case <caseId> --report <مسار JSON محلي> --model <modelId محايد> [--telemetry <مسار JSON>] [--benchmarkRoot <مسار>]");
    process.exitCode = 2;
    return;
  }
  const loaded = loadBenchmarkCase(benchmarkRoot, args.case);
  const report = JSON.parse(readFileSync(path.resolve(args.report), "utf8"));
  const telemetry = args.telemetry ? JSON.parse(readFileSync(path.resolve(args.telemetry), "utf8")) : undefined;
  const result = evaluateBenchmarkRun({
    benchmarkCase: {
      caseId: loaded.manifestEntry.caseId,
      fixtureSha256: loaded.manifestEntry.fixtureSha256,
      catalogSha256: loaded.manifestEntry.catalogSha256,
      document: loaded.document,
      chunks: loaded.chunks,
    },
    groundTruth: loaded.groundTruth,
    catalog: loaded.catalog,
    report,
    modelId: args.model,
    telemetry,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.classification !== "PASS") process.exitCode = 1;
}

main();
