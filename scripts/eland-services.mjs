#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, existsSync, openSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.eland.dev-services';
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const USER_HOME = homedir();
const USER_ID = process.getuid?.();
const DOMAIN = `gui/${USER_ID}`;
const SERVICE_TARGET = `${DOMAIN}/${LABEL}`;
const PLIST_PATH = path.join(USER_HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = path.join(USER_HOME, 'Library', 'Logs', 'ELAND');
const STDOUT_LOG = path.join(LOG_DIR, 'services.out.log');
const STDERR_LOG = path.join(LOG_DIR, 'services.err.log');
const SUPERVISOR_PID_PATH = path.join(LOG_DIR, 'services.pid');
const DEFAULT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function isExecutable(candidate) {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function nodeForLaunchAgent() {
  const stableNode = path.join(USER_HOME, '.local', 'share', 'nodejs', 'current', 'bin', 'node');
  if (await isExecutable(stableNode)) return stableNode;
  return process.execPath;
}

function npmForSupervisor() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'npm'),
    path.join(USER_HOME, '.local', 'share', 'nodejs', 'current', 'bin', 'npm'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? 'npm';
}

function launchctl(args, { allowFailure = false, capture = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, {
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(`launchctl ${args[0]} 失败${detail ? `：${detail}` : ''}`);
  }
  return result;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function launchAgentIsLoaded() {
  return launchctl(['print', SERVICE_TARGET], { allowFailure: true, capture: true }).status === 0;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function currentSupervisorPid() {
  try {
    const pid = Number.parseInt((await readFile(SUPERVISOR_PID_PATH, 'utf8')).trim(), 10);
    if (!processExists(pid)) {
      await rm(SUPERVISOR_PID_PATH, { force: true });
      return null;
    }
    const command = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).stdout?.trim() ?? '';
    if (!command.includes(SCRIPT_PATH) || !command.includes('supervise')) return null;
    return pid;
  } catch {
    return null;
  }
}

async function stopLocalSupervisor() {
  const pid = await currentSupervisorPid();
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    await rm(SUPERVISOR_PID_PATH, { force: true });
    return;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processExists(pid)) {
      await rm(SUPERVISOR_PID_PATH, { force: true });
      return;
    }
    await delay(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The supervisor has already exited.
  }
  await rm(SUPERVISOR_PID_PATH, { force: true });
}

async function plistContents() {
  const nodePath = await nodeForLaunchAgent();
  const launchPath = `${path.dirname(nodePath)}:${DEFAULT_PATH}`;
  const values = {
    label: xmlEscape(LABEL),
    node: xmlEscape(nodePath),
    script: xmlEscape(SCRIPT_PATH),
    stdout: xmlEscape(STDOUT_LOG),
    stderr: xmlEscape(STDERR_LOG),
    path: xmlEscape(launchPath),
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${values.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${values.node}</string>
    <string>${values.script}</string>
    <string>supervise</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${values.path}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>20</integer>
  <key>StandardOutPath</key>
  <string>${values.stdout}</string>
  <key>StandardErrorPath</key>
  <string>${values.stderr}</string>
</dict>
</plist>
`;
}

async function writePlist() {
  await mkdir(path.dirname(PLIST_PATH), { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(PLIST_PATH, await plistContents(), { mode: 0o644 });
}

async function runLocally() {
  await bootout();
  const existingPid = await currentSupervisorPid();
  if (existingPid) {
    if (await waitForHealthyServices(3_000)) {
      console.log(`ELAND 本地守护器已在运行（PID ${existingPid}）。`);
      return;
    }
    await stopLocalSupervisor();
  }

  await mkdir(LOG_DIR, { recursive: true });
  const stdout = openSync(STDOUT_LOG, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o644);
  const stderr = openSync(STDERR_LOG, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o644);
  const child = spawn(process.execPath, [SCRIPT_PATH, 'supervise'], {
    cwd: REPO_ROOT,
    detached: true,
    env: process.env,
    stdio: ['ignore', stdout, stderr],
  });
  child.unref();
  closeSync(stdout);
  closeSync(stderr);

  if (!(await waitForHealthyServices())) {
    await stopLocalSupervisor();
    throw new Error(`本地守护器未能启动全部服务。\n日志：${STDOUT_LOG}\n错误日志：${STDERR_LOG}`);
  }
  console.log(`ELAND 三项服务已由本地守护器启动（PID ${child.pid}）。`);
  console.log('注意：本地守护可自动恢复进程，但退出登录或重启电脑后需要 launchd 登录自启。');
}

async function bootout() {
  launchctl(['bootout', SERVICE_TARGET], { allowFailure: true, capture: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!launchAgentIsLoaded()) return;
    await delay(100);
  }
  throw new Error(`等待 ${LABEL} 停止超时`);
}

async function bootstrap() {
  launchctl(['enable', SERVICE_TARGET], { allowFailure: true, capture: true });
  let lastResult = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    lastResult = launchctl(['bootstrap', DOMAIN, PLIST_PATH], { allowFailure: true, capture: true });
    if (lastResult.status === 0 || launchAgentIsLoaded()) return;
    await delay(250 * (attempt + 1));
  }
  const detail = (lastResult?.stderr || lastResult?.stdout || '').trim();
  throw new Error(`launchctl bootstrap 失败${detail ? `：${detail}` : ''}`);
}

async function install() {
  if (repoNeedsProtectedFolderPermission()) {
    console.warn(`注意：仓库位于 macOS 受保护目录 ${REPO_ROOT}，launchd 需要 Node 的“完全磁盘访问权限”。`);
  }
  await writePlist();
  await bootout();
  await stopLocalSupervisor();
  await bootstrap();
  try {
    await requireHealthyServices();
  } catch (error) {
    await bootout();
    throw error;
  }
  console.log(`ELAND 已安装为登录自启服务：${PLIST_PATH}`);
  console.log('游戏：http://127.0.0.1:3217/');
  console.log('后端：http://127.0.0.1:3220/health');
  console.log('素材：http://127.0.0.1:7100/');
}

async function start() {
  if (!existsSync(PLIST_PATH)) {
    await install();
    return;
  }
  await writePlist();
  if (!launchAgentIsLoaded()) {
    await stopLocalSupervisor();
    await bootstrap();
    try {
      await requireHealthyServices();
    } catch (error) {
      await bootout();
      throw error;
    }
    console.log('ELAND 服务已启动。');
    return;
  }
  if (!(await waitForHealthyServices(3_000))) {
    await restart();
    return;
  }
  console.log('ELAND 服务已启动。');
}

async function stop() {
  await bootout();
  await stopLocalSupervisor();
  console.log('ELAND 服务已停止；登录自启配置仍保留。');
}

async function restart() {
  await writePlist();
  await bootout();
  await stopLocalSupervisor();
  await bootstrap();
  try {
    await requireHealthyServices();
  } catch (error) {
    await bootout();
    throw error;
  }
  console.log('ELAND 服务已重启。');
}

async function uninstall() {
  await bootout();
  await stopLocalSupervisor();
  await rm(PLIST_PATH, { force: true });
  console.log('ELAND 登录自启已移除，日志文件保留。');
}

async function endpointIsHealthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const healthy = response.status >= 200 && response.status < 400;
    await response.body?.cancel();
    return { healthy, status: response.status };
  } catch {
    return { healthy: false, status: null };
  }
}

const ENDPOINTS = [
  ['游戏', 'http://127.0.0.1:3217/'],
  ['后端', 'http://127.0.0.1:3220/health'],
  ['素材网站', 'http://127.0.0.1:7100/'],
];

async function waitForHealthyServices(timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  do {
    const results = await Promise.all(ENDPOINTS.map(([, url]) => endpointIsHealthy(url)));
    if (results.every((result) => result.healthy)) return true;
    await delay(500);
  } while (Date.now() < deadline);
  return false;
}

function repoNeedsProtectedFolderPermission() {
  const protectedRoots = ['Desktop', 'Documents', 'Downloads']
    .map((directory) => path.join(USER_HOME, directory) + path.sep);
  return protectedRoots.some((root) => `${REPO_ROOT}${path.sep}`.startsWith(root));
}

async function requireHealthyServices() {
  if (await waitForHealthyServices()) return;
  const permissionHint = repoNeedsProtectedFolderPermission()
    ? `\n仓库位于 macOS 受保护目录 ${REPO_ROOT}；请给 ${await nodeForLaunchAgent()} “完全磁盘访问权限”，或把仓库移到 ~/Projects 后重新 install。`
    : '';
  throw new Error(`守护器已加载，但三个服务未能全部就绪。\n日志：${STDOUT_LOG}\n错误日志：${STDERR_LOG}${permissionHint}`);
}

async function endpointStatus(name, url) {
  const result = await endpointIsHealthy(url);
  if (result.healthy) {
    console.log(`运行中  ${name.padEnd(8)} ${url} (${result.status})`);
  } else if (result.status !== null) {
    console.log(`异常    ${name.padEnd(8)} ${url} (${result.status})`);
  } else {
    console.log(`未运行  ${name.padEnd(8)} ${url}`);
  }
  return result.healthy;
}

async function status() {
  const loaded = launchAgentIsLoaded();
  const localPid = await currentSupervisorPid();
  if (loaded) {
    console.log(`守护器  登录自启已加载 (${LABEL})`);
  } else if (localPid) {
    console.log(`守护器  本地后台运行中 (PID ${localPid})`);
  } else {
    console.log(`守护器  未运行 (${LABEL})`);
  }
  const results = await Promise.all(ENDPOINTS.map(([name, url]) => endpointStatus(name, url)));
  console.log(`日志    ${STDOUT_LOG}`);
  if (loaded && results.every(Boolean)) {
    console.log('汇总    登录自启已加载，三个服务均正常');
  } else if (localPid && results.every(Boolean)) {
    console.log('汇总    三个服务正常；本地守护有效，登录自启未加载');
  } else if (results.every(Boolean)) {
    console.log('汇总    三个服务正常，但没有受控守护器');
  } else if (loaded) {
    console.log('汇总    登录自启已加载，但服务不可用');
    process.exitCode = 1;
  } else {
    console.log('汇总    服务未就绪');
    process.exitCode = 1;
  }
}

function processGroupExists(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function terminateProcessGroup(processGroupId) {
  if (!processGroupExists(processGroupId)) return;
  try {
    process.kill(-processGroupId, 'SIGTERM');
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!processGroupExists(processGroupId)) return;
    await delay(100);
  }

  try {
    process.kill(-processGroupId, 'SIGKILL');
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!processGroupExists(processGroupId)) return;
    await delay(100);
  }
}

class ManagedService {
  constructor({ name, command, args, cwd, healthUrls }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.healthUrls = healthUrls;
    this.child = null;
    this.processGroupId = null;
    this.restartTimer = null;
    this.restarting = false;
    this.startedAt = 0;
    this.failedHealthChecks = 0;
  }

  start() {
    if (shuttingDown || this.child) return;
    log(`启动 ${this.name}`);
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: supervisorEnvironment,
      detached: true,
      stdio: 'inherit',
    });
    this.child = child;
    this.processGroupId = child.pid ?? null;
    this.startedAt = Date.now();
    this.failedHealthChecks = 0;

    const processGroupId = child.pid ?? null;
    let finalized = false;
    const finalize = (reason) => {
      if (finalized) return;
      finalized = true;
      if (this.child === child) {
        this.child = null;
        this.processGroupId = null;
      }
      if (shuttingDown || this.restarting) return;
      this.restarting = true;
      void terminateProcessGroup(processGroupId).finally(() => {
        this.restarting = false;
        this.scheduleRestart(reason);
      });
    };

    child.once('error', (error) => {
      finalize(`启动失败：${error.message}`);
    });
    child.once('close', (code, signal) => {
      finalize(`进程退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });
  }

  scheduleRestart(reason) {
    if (shuttingDown || this.restartTimer) return;
    log(`${this.name} ${reason}，2 秒后重启`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, 2_000);
  }

  async restart(reason) {
    if (shuttingDown || this.restarting) return;
    this.restarting = true;
    log(`${this.name} ${reason}，正在重启`);
    await this.stopChild();
    this.restarting = false;
    this.start();
  }

  async stopChild() {
    const child = this.child;
    const processGroupId = this.processGroupId ?? child?.pid ?? null;
    this.child = null;
    this.processGroupId = null;
    await terminateProcessGroup(processGroupId);
  }

  async checkHealth() {
    if (!this.child || this.restarting || Date.now() - this.startedAt < 15_000) return;
    const checks = await Promise.all(this.healthUrls.map(async (url) => (
      (await endpointIsHealthy(url)).healthy
    )));

    if (checks.every(Boolean)) {
      this.failedHealthChecks = 0;
      return;
    }

    this.failedHealthChecks += 1;
    if (this.failedHealthChecks >= 3) {
      this.failedHealthChecks = 0;
      await this.restart('连续三次健康检查失败');
    }
  }

  async stop() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this.stopChild();
  }
}

let shuttingDown = false;
let supervisorEnvironment = process.env;

async function supervise() {
  await mkdir(LOG_DIR, { recursive: true });
  const existingPid = await currentSupervisorPid();
  if (existingPid && existingPid !== process.pid) {
    log(`已有守护器在运行（PID ${existingPid}），本进程退出`);
    return;
  }
  await writeFile(SUPERVISOR_PID_PATH, `${process.pid}\n`, { mode: 0o644 });

  const nodeBin = path.dirname(process.execPath);
  supervisorEnvironment = {
    ...process.env,
    PATH: `${nodeBin}:${process.env.PATH ?? DEFAULT_PATH}`,
    THREEBODY_DATA_DIR: process.env.THREEBODY_DATA_DIR
      ?? path.join(REPO_ROOT, 'three-body', 'data'),
  };

  const services = [
    new ManagedService({
      name: '三体前端与后端',
      command: process.execPath,
      args: [path.join(REPO_ROOT, 'three-body', 'scripts', 'dev.mjs'), '--host', '127.0.0.1'],
      cwd: path.join(REPO_ROOT, 'three-body'),
      healthUrls: ['http://127.0.0.1:3217/', 'http://127.0.0.1:3220/health'],
    }),
    new ManagedService({
      name: '素材网站',
      command: npmForSupervisor(),
      args: ['run', 'dev'],
      cwd: path.join(REPO_ROOT, 'knowledge-base'),
      healthUrls: ['http://127.0.0.1:7100/'],
    }),
  ];

  for (const service of services) service.start();

  const healthTimer = setInterval(() => {
    for (const service of services) void service.checkHealth();
  }, 5_000);

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(healthTimer);
    log(`收到 ${signal}，停止子服务`);
    await Promise.all(services.map((service) => service.stop()));
    await rm(SUPERVISOR_PID_PATH, { force: true });
    process.exit(0);
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

function help() {
  console.log(`用法：node scripts/eland-services.mjs <命令>

命令：
  install     安装登录自启、启动并守护全部服务
  start       启动已安装的服务（未安装时会自动安装）
  run         立即在本地后台启动，不修改登录自启配置
  stop        停止服务，但保留登录自启配置
  restart     重启全部服务
  status      查看守护器与 3217、3220、7100 状态
  uninstall   停止服务并移除登录自启配置
  supervise   内部守护入口，由 launchd 调用

日志：
  ${STDOUT_LOG}
  ${STDERR_LOG}`);
}

const command = process.argv[2] ?? 'status';

switch (command) {
  case 'install':
    await install();
    break;
  case 'start':
    await start();
    break;
  case 'run':
    await runLocally();
    break;
  case 'stop':
    await stop();
    break;
  case 'restart':
    await restart();
    break;
  case 'status':
    await status();
    break;
  case 'uninstall':
    await uninstall();
    break;
  case 'supervise':
    await supervise();
    break;
  case 'help':
  case '--help':
  case '-h':
    help();
    break;
  default:
    console.error(`未知命令：${command}`);
    help();
    process.exitCode = 1;
}
