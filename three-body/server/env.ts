import fs from 'fs';
import path from 'path';

function readValueFromEnvFile(filePath: string, name: string): string {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    const line = text.split('\n').find((item) => item.trim().startsWith(`${name}=`));
    if (line) return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
  } catch {
    // 环境文件不存在时由调用方决定如何回退。
  }
  return '';
}

function envFiles(): string[] {
  const envFile = process.env.THREEBODY_ENV_FILE
    ? path.resolve(process.env.THREEBODY_ENV_FILE)
    : path.resolve(process.cwd(), '.env.local');
  const legacyFile = path.resolve(process.cwd(), '../demo/.env.local');
  return [envFile, legacyFile];
}

/** 读取服务端环境值；不会进入前端 bundle。 */
export function loadServerEnvValue(name: string): string {
  const processValue = process.env[name]?.trim();
  if (processValue) return processValue;
  for (const filePath of envFiles()) {
    const value = readValueFromEnvFile(filePath, name);
    if (value) return value;
  }
  return '';
}

export function loadFirstServerEnvValue(names: string[]): string {
  for (const name of names) {
    const value = loadServerEnvValue(name);
    if (value) return value;
  }
  return '';
}

/** 旧 Kimi 接口的兼容读取；新接入应使用 model-config 中端点声明的 apiKeyEnv。 */
export function loadLlmKey(provider: string): string {
  void provider;
  return loadFirstServerEnvValue(['KIMI_API_KEY', 'MOONSHOT_API_KEY']);
}

export function loadKimiKey(): string {
  return loadLlmKey('kimi');
}
