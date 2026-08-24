import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptsDirectory, '..');

const coreTests = [
  ['architecture boundaries', 'check-eland-boundaries.mjs'],
  ['simulation regression', 'test-simulation.mjs'],
  ['shared-living regression', 'test-shared-living.mjs'],
];

for (const [label, script] of coreTests) {
  process.stdout.write(`\n[core] ${label}\n`);
  const result = spawnSync(process.execPath, [path.join(scriptsDirectory, script)], {
    cwd: projectDirectory,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`[core] ${label} could not start:`, result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? 1}`;
    console.error(`[core] ${label} failed (${reason}); remaining checks were skipped.`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n[core] all core checks passed.');
