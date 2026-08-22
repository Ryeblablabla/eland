import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-agreement-id-index-'));
const bundlePath = path.join(temporaryDirectory, 'agreement.mjs');

function agreement(id, status = 'fulfilled', partyIds = ['alice']) {
  return {
    id,
    status,
    proposerId: partyIds[0],
    responderId: partyIds[1] ?? partyIds[0],
    partyIds,
    requiredResponderIds: partyIds.slice(1),
  };
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/agreement.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const { agreementById, agreementsForPerson } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const first = agreement('duplicate', 'fulfilled');
  const duplicate = agreement('duplicate', 'active');
  const tail = agreement('tail', 'proposed');
  const state = { agreements: [first, duplicate, tail] };
  assert.strictEqual(agreementById(state, 'duplicate'), first, '重复 id 必须保持 Array.find 的 first-wins 语义');
  assert.deepEqual(agreementsForPerson(state, 'alice'), [first, duplicate, tail], '参与者索引必须保持数组顺序');

  first.status = 'cancelled';
  assert.strictEqual(agreementById(state, 'duplicate'), first, '原地状态更新不得使索引返回旧副本');
  assert.equal(agreementById(state, 'duplicate').status, 'cancelled');

  const appended = agreement('appended', 'active', ['alice', 'bob']);
  state.agreements.push(appended);
  assert.strictEqual(agreementById(state, 'appended'), appended, 'cache prime 后 push 必须增量可见');
  assert.strictEqual(agreementById(state, 'duplicate'), first, 'append 不得改变既有 first-wins 结果');
  assert.deepEqual(agreementsForPerson(state, 'bob'), [appended], 'append 后新增参与者必须增量可见');

  const replacementArray = structuredClone(state.agreements);
  state.agreements = replacementArray;
  assert.strictEqual(agreementById(state, 'duplicate'), replacementArray[0], '数组替换必须建立独立索引');
  assert.notStrictEqual(agreementById(state, 'duplicate'), first, '数组替换不得泄漏旧对象');

  const removedTail = state.agreements.at(-1);
  state.agreements.pop();
  assert.equal(agreementById(state, removedTail.id), undefined, '数组缩短必须重建索引');

  const oldTail = state.agreements.at(-1);
  const replacementTail = agreement('replacement-tail', 'active');
  state.agreements[state.agreements.length - 1] = replacementTail;
  assert.equal(agreementById(state, oldTail.id), undefined, '同长度 tail 替换必须使旧 id 失效');
  assert.strictEqual(agreementById(state, 'replacement-tail'), replacementTail, '同长度 tail 替换必须重建到新对象');

  console.log('agreement id index tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
