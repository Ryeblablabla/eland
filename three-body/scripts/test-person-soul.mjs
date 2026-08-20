import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-person-soul-'));
const bundlePath = path.join(temporaryDirectory, 'person-soul.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/person-soul.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });

  const { buildPersonSoul } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const person = {
    id: 'soul-test-person',
    name: '阿澜',
    personality: {
      baseline: {
        honestyHumility: 72,
        emotionality: 61,
        extraversion: 31,
        agreeableness: 68,
        conscientiousness: 76,
        openness: 57,
      },
      learnedDelta: {
        honestyHumility: 0,
        emotionality: 0,
        extraversion: 0,
        agreeableness: 0,
        conscientiousness: 0,
        openness: 0,
      },
      evidence: [],
      changes: [],
    },
    motiveSensitivity: { control: 67, status: 34 },
  };

  const first = buildPersonSoul(person);
  const repeated = buildPersonSoul(structuredClone(person));
  assert.deepEqual(repeated, first, '同一人物的 Soul 必须可确定性重建');
  assert.equal(first.version, 2);
  assert.equal(first.authority, 'derived-personality');
  assert.match(first.signature, /^soul-v2-/u);
  assert.match(first.innerVoice, /^我是阿澜。/u);
  assert.deepEqual(first.sceneFacets.map((facet) => facet.id), [
    'danger-and-loss',
    'autonomy-and-proposals',
    'trust-and-closeness',
    'commitment-and-work',
    'uncertainty-and-change',
  ], 'Soul 应提供可由处境命中的稳定人格侧面');
  assert.equal(first.styleMatrix.sentenceLength, 'short');
  assert.equal(first.styleMatrix.selfDisclosure, 'guarded');
  assert.match(
    first.sceneFacets.find((facet) => facet.id === 'autonomy-and-proposals').innerTension,
    /建议.*承诺/u,
    '高控制敏感人物面对建议时应保留自主张力',
  );
  assert.equal(first.speechStyle.some((line) => line.includes('助手')), true,
    'Soul 应明确阻止统一的助手式能力清单');

  const experienced = structuredClone(person);
  experienced.personality.learnedDelta.extraversion = 12;
  experienced.personality.learnedDelta.agreeableness = -9;
  assert.deepEqual(buildPersonSoul(experienced), first,
    '核心 Soul 只由 baseline 与稳定动机派生，经历后的当前语气另走动态上下文');

  const other = structuredClone(person);
  other.id = 'soul-test-person-2';
  other.name = '泊川';
  const otherSoul = buildPersonSoul(other);
  assert.notEqual(otherSoul.signature, first.signature,
    '即使人格数值相同，不同人物也必须拥有不同稳定签名');
  assert.notEqual(otherSoul.innerVoice, first.innerVoice);

  console.log('person soul tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
