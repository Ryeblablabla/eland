import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-auditory-perception-'));
const bundlePath = path.join(temporaryDirectory, 'auditory-perception.mjs');

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

  console.log('auditory perception tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
