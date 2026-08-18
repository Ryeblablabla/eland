import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { context } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let backend = null;
let frontend = null;
let stopping = false;
let restartQueue = Promise.resolve();

function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5_000).unref();
  });
}

async function restartBackend() {
  await stopChild(backend);
  if (stopping) return;
  const child = spawn(process.execPath, ['dist-server/main.mjs'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  backend = child;
  child.once('exit', (code, signal) => {
    if (backend === child) backend = null;
    if (!stopping && code && code !== 0) {
      console.error(`[dev] 后端异常退出（code=${code}${signal ? `, signal=${signal}` : ''}）；前端继续运行，修正代码并保存后会自动重启后端。`);
    }
  });
}

const backendBuild = await context({
  entryPoints: {
    main: 'server/main.ts',
    'eland-worker': 'server/eland-worker.ts',
  },
  outdir: 'dist-server',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  packages: 'external',
  plugins: [{
    name: 'restart-eland-backend',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length) return;
        restartQueue = restartQueue.then(restartBackend);
        return restartQueue;
      });
    },
  }],
});

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all([stopChild(frontend), stopChild(backend)]);
  await backendBuild.dispose();
  process.exit(code);
}

process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });

await backendBuild.watch();
frontend = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
frontend.once('exit', (code) => {
  if (!stopping) void shutdown(code ?? 0);
});
