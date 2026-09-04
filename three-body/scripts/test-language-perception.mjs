import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-language-perception-'));
const bundlePath = path.join(temporaryDirectory, 'language-perception.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/language-perception.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const auditory = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const near = auditory.languageIntelligibility(17, 'talk-1', 'speaker', 'listener', 0);
  const middle = auditory.languageIntelligibility(17, 'talk-1', 'speaker', 'listener', 3);
  const far = auditory.languageIntelligibility(17, 'talk-1', 'speaker', 'listener', 12);
  assert(near > 0 && near < 1);
  assert(middle > 0 && middle < 1);
  assert(far > 0 && far < 1);
  assert(near > middle && middle > far,
    'distance must continuously lower expected intelligibility without a hard cutoff');

  const reception = auditory.sampleLanguageReception({
    seed: 17,
    talkFactId: 'talk-2',
    speakerId: 'speaker',
    listenerId: 'listener',
    speakerPosition: { cellId: 0, z: 5 },
    listenerPosition: { cellId: 3, z: 5 },
  });
  assert.deepEqual(reception, auditory.sampleLanguageReception({
    seed: 17,
    talkFactId: 'talk-2',
    speakerId: 'speaker',
    listenerId: 'listener',
    speakerPosition: { cellId: 0, z: 5 },
    listenerPosition: { cellId: 3, z: 5 },
  }), 'hearing must be replay-stable');

  const fragment = auditory.confusePerceivedLanguage(
    '我看见河边那块石头下面有东西',
    { listenerId: 'listener', intelligibility: 0.45, detected: true },
    17,
    'talk-2',
  );
  assert(fragment.length > 0);
  assert.match(fragment, /…/u);
  assert.equal(auditory.confusePerceivedLanguage(
    '我看见河边那块石头下面有东西',
    { listenerId: 'listener', intelligibility: 0.45, detected: false },
    17,
    'talk-2',
  ), '');

  const world = (fill = 0) => ({
    version: 2,
    width: 84,
    depth: 52,
    levels: 12,
    generator: { version: 'material-world-v4-regional-geology', seed: 1 },
    palette: [],
    voxels: new Uint16Array(84 * 52 * 12).fill(fill),
  });
  const source = { cellId: 10 * 84 + 1, z: 1 };
  const listener = { id: 'listener', position: { cellId: 10 * 84 + 3, z: 1 } };
  const openWorld = world();
  const openCost = auditory.minimumLanguagePathCosts(openWorld, source, [listener]).get('listener');
  const singleStoneWorld = world();
  singleStoneWorld.voxels[2 * 84 * 52 + 10 * 84 + 2] = 1;
  const aroundStoneCost = auditory.minimumLanguagePathCosts(singleStoneWorld, source, [listener]).get('listener');
  const leafyWorld = world();
  const stoneWorld = world();
  for (let y = 0; y < 52; y += 1) {
    for (let z = 0; z < 12; z += 1) {
      leafyWorld.voxels[z * 84 * 52 + y * 84 + 2] = 14;
      stoneWorld.voxels[z * 84 * 52 + y * 84 + 2] = 1;
    }
  }
  const leafyCost = auditory.minimumLanguagePathCosts(leafyWorld, source, [listener]).get('listener');
  const stoneCost = auditory.minimumLanguagePathCosts(stoneWorld, source, [listener]).get('listener');
  assert(openCost < leafyCost && leafyCost < stoneCost,
    'the minimum path must make foliage resist more than air and stone resist more than foliage');
  assert(openCost < aroundStoneCost && aroundStoneCost < stoneCost,
    'a local obstacle must be routed around when that is cheaper than crossing a sealed wall');

  const nearOutsideOpen = auditory.languageIntelligibility(17, 'open', 'speaker', 'listener', openCost);
  const nearOutsideStone = auditory.languageIntelligibility(17, 'stone', 'speaker', 'listener', stoneCost, 0.35);
  assert(nearOutsideOpen > nearOutsideStone,
    'a nearby listener across a wall should hear a whisper less clearly than across open air');

  console.log('language perception tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
