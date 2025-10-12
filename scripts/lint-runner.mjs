#!/usr/bin/env node
/**
 * Unified lint runner supporting:
 *  pnpm lint         -> biome check (read-only)
 *  pnpm lint --write -> biome format + lint with --write
 *  pnpm lint --fix   -> alias of --write
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const writeMode = args.includes('--write') || args.includes('--fix');

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: 'inherit', shell: false, ...opts });
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} ${cmdArgs.join(' ')} exited with code ${code}`));
    });
  });
}

async function main() {
  try {
    if (writeMode) {
      console.log('[lint-runner] Running biome format --write ...');
      await run('pnpm', ['-C', 'apps/web', 'exec', 'biome', 'format', '--write', '.']);
      console.log('[lint-runner] Running biome lint --write ...');
      await run('pnpm', ['-C', 'apps/web', 'exec', 'biome', 'lint', '--write', '.']);
    } else {
      console.log('[lint-runner] Running biome check ...');
      await run('pnpm', ['-C', 'apps/web', 'exec', 'biome', 'check', '--ci', '.']);
    }
    console.log('[lint-runner] Completed successfully.');
  } catch (err) {
    console.error('[lint-runner] Failed:', err.message);
    process.exit(1);
  }
}

main();
