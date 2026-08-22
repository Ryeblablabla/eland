import { DatabaseSync } from 'node:sqlite';

import {
  decodeSegmentedRunState,
  type RunStateChunk,
} from '/private/tmp/eland-gen3-candidate.1ejlGu/three-body/server/run-state-codec';
import {
  buildDecisionContext,
} from '/private/tmp/eland-gen3-candidate.1ejlGu/three-body/src/game/eland/application/action-options';

const database = new DatabaseSync('data/eland.sqlite3', { readOnly: true });
const runId = 'candidate-gen3-social-v3-20260821-s185-y100-r1';
const month = 528;
const checkpoint = database.prepare(
  'SELECT state_hash FROM run_checkpoints WHERE run_id = ? AND month = ?',
).get(runId, month) as { state_hash: string };
const rowForHash = database.prepare(
  'SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?',
);
const readChunk = (hash: string): RunStateChunk => {
  const row = rowForHash.get(hash) as {
    hash: string;
    codec: string;
    raw_size: number;
    data: Uint8Array;
  };
  return {
    hash: row.hash,
    codec: row.codec,
    rawSize: row.raw_size,
    data: row.data,
  };
};
const decoded = await decodeSegmentedRunState(readChunk(checkpoint.state_hash), readChunk);
const actorIds = ['socrates', 'born-159-marie-curie-12'];
const result = actorIds.map((personId) => {
  const person = decoded.state.people.find((candidate) => candidate.id === personId)!;
  const context = buildDecisionContext(decoded.state, person, month);
  return {
    personId,
    name: person.name,
    visiblePeople: context.visiblePeople.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
    })),
    reproductionOptions: context.options
      .filter((option) => option.id.includes('reproduce'))
      .map((option) => ({ id: option.id, summary: option.summary, reason: option.reason })),
  };
});
console.log(JSON.stringify({ runId, month, result }, null, 2));
database.close();
