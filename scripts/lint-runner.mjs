#!/usr/bin/env node
/**
 * Unified lint runner supporting:
 *  pnpm lint            -> next lint (no fix) + biome check
 *  pnpm lint --write    -> next lint --fix + biome format+lint --write
 *  pnpm lint --fix      -> alias of --write
 * Additional flags are passed through only to next lint (for now).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const writeMode = args.includes('--write') || args.includes('--fix');

// Filter out our meta flags so they are not forwarded unexpectedly
const passThrough = args.filter(a => a !== '--write' && a !== '--fix');

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
      console.log('[lint-runner] Running web lint --fix ...');
      await run('pnpm', ['-C', 'apps/web', 'run', 'lint:fix', ...passThrough]);
      console.log('[lint-runner] Running biome format & lint --write ...');
      await run('pnpm', ['-C', 'apps/web', 'biome:fix']);
    } else {
      console.log('[lint-runner] Running web lint (check only) ...');
      await run('pnpm', ['-C', 'apps/web', 'run', 'lint', ...passThrough]);
      console.log('[lint-runner] Running biome check ...');
      await run('pnpm', ['-C', 'apps/web', 'biome:check']);
    }
    console.log('[lint-runner] Completed successfully.');
  } catch (err) {
    console.error('[lint-runner] Failed:', err.message);
    process.exit(1);
  }
}

main();
