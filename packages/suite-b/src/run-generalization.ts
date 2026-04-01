import { runGeneralizationBenchmark } from "./generalization-benchmark.js";

const args = new Set(process.argv.slice(2));

const visible = args.has("--visible") || args.has("--watch");
const verbose = args.has("--verbose");

runGeneralizationBenchmark({ visible, verbose })
  .then((summary) => {
    console.log(
      `Generalization benchmark: ${summary.passed}/${summary.total} cases passed · ` +
        `${summary.familyPasses}/${summary.totalFamilies} families fully passing`,
    );
    console.log(`Report: ${summary.reportPath}`);
    console.log(`Results: ${summary.resultsPath}`);
    if (summary.passed !== summary.total) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
