import { spawnSync } from "node:child_process";

const tests = ["tests/terminal-interaction.exp", "tests/terminal-secret.exp"];
let failed = false;
for (const test of tests) {
  const result = spawnSync("expect", [test], { encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
