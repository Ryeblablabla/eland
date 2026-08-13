import fs from 'fs';
import path from 'path';
import type { ModelProvider } from '../src/game/llm';

function readKeyFromEnvFile(filePath: string, names: string[]): string {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const name of names) {
      const line = text.split('\n').find((item) => item.trim().startsWith(`${name}=`));
      if (line) return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // 环境文件不存在时由调用方决定如何回退。
  }
  return '';
}

/** 只在服务端读取模型密钥；密钥不会进入前端 bundle。 */
export function loadLlmKey(provider: ModelProvider): string {
  const names = provider === 'kimi' ? ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] : ['DEEPSEEK_API_KEY'];
  for (const name of names) {
    if (process.env[name]) return process.env[name] as string;
  }

  const envFile = process.env.THREEBODY_ENV_FILE
    ? path.resolve(process.env.THREEBODY_ENV_FILE)
    : path.resolve(process.cwd(), '.env.local');
  const localKey = readKeyFromEnvFile(envFile, names);
  if (localKey) return localKey;

  const legacyFile = path.resolve(process.cwd(), '../demo/.env.local');
  return readKeyFromEnvFile(legacyFile, names);
}

export function loadDeepseekKey(): string {
  return loadLlmKey('deepseek');
}

export function loadKimiKey(): string {
  return loadLlmKey('kimi');
}
