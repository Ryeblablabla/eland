import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-speech-playback-'));
const bundlePath = path.join(temporaryDirectory, 'speech-playback.mjs');

try {
  buildSync({
    entryPoints: ['src/components/society-scene/speechPlayback.ts'],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  const {
    activeSpeechLineAtProgress,
    speechLinesInPlaybackOrder,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const line = (id, speakerId, planningTick, source = 'speech-model', text = id) => ({
    id,
    speakerId,
    planningTick,
    source,
    text,
  });
  const lines = [
    line('late', 'person-c', 12),
    line('opening', 'person-a', 3),
    line('response', 'person-b', 3),
    line('legacy-rule-copy', 'person-d', 1, 'rule'),
    line('empty', 'person-e', 2, 'speech-model', '   '),
  ];

  assert.deepEqual(
    speechLinesInPlaybackOrder(lines).map(({ id }) => id),
    ['opening', 'response', 'late'],
    'playback should preserve real turn order and ignore non-model display text',
  );
  assert.equal(activeSpeechLineAtProgress(lines, 0)?.id, 'opening');
  assert.equal(activeSpeechLineAtProgress(lines, 0.34)?.id, 'response');
  assert.equal(activeSpeechLineAtProgress(lines, 0.75)?.id, 'late');
  assert.equal(activeSpeechLineAtProgress(lines, 1)?.id, 'late');
  assert.equal(activeSpeechLineAtProgress([], 0.5), undefined);

  console.log('speech playback tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
