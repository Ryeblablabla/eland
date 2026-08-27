import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-item-lineage-test-'));
const bundlePath = path.join(temporaryDirectory, 'item-lineage.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation-runtime.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export {
      ITEM_SOURCE_EVENT_LIMIT,
      addContainerInventory,
      addDrop,
      addInventory,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/actions/inventory.ts'))};
    export { personalMassCalibrationLeaseKey }
      from ${JSON.stringify(path.resolve('src/game/eland/domain/actions/measurement-actions.ts'))};
    export { currentMassMeasurementInstrument }
      from ${JSON.stringify(path.resolve('src/game/eland/application/measurement-options.ts'))};
    export {
      beginHistoryRetentionProjection,
      finishHistoryRetentionProjection,
      foldHistoryRetentionSegment,
    } from ${JSON.stringify(path.resolve('server/history-retention-projection.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=item-lineage-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    ITEM_SOURCE_EVENT_LIMIT,
    Material,
    addContainerInventory,
    addDrop,
    addInventory,
    beginHistoryRetentionProjection,
    createInitialState,
    currentMassMeasurementInstrument,
    finishHistoryRetentionProjection,
    foldHistoryRetentionSegment,
    personalMassCalibrationLeaseKey,
  } = api;

  const state = createInitialState(185);
  const producer = state.people[0];
  const receiver = state.people[1];
  const unsupportedHolder = state.people[2];
  const wrongMaterialHolder = state.people[3];
  const wrongBindingHolder = state.people[4];
  assert.ok(producer && receiver && unsupportedHolder && wrongMaterialHolder && wrongBindingHolder,
    'fixture requires five living people');

  const productionFacts = Array.from({ length: ITEM_SOURCE_EVENT_LIMIT }, (_, index) => ({
    id: `lineage-manufacture-${index}`,
    kind: 'action',
    atMonth: 1,
    orderInMonth: index,
    planningTick: 0,
    orderInTick: index,
    who: producer.id,
    cellId: producer.position.cellId,
    status: 'completed',
    action: { kind: 'act', operation: 'combine', targets: [] },
    result: 'manufactured a sourced beam balance',
    diff: {
      outputMaterialId: Material.BeamBalance,
      outputQuantity: 1,
      outputStackId: 'lineage-original-instrument',
      sourceEventId: `lineage-manufacture-${index}`,
    },
  }));
  const manufactureIds = productionFacts.map((event) => event.id);
  const original = addInventory(
    producer,
    Material.BeamBalance,
    1,
    [...manufactureIds, manufactureIds[0]],
    'lineage-original-instrument',
  );
  assert.deepEqual(original.sourceEventIds, manufactureIds,
    'new inventory stack must deduplicate sources without disturbing stable input order');

  const deathFact = {
    id: 'lineage-owner-death',
    kind: 'environment',
    atMonth: 2,
    orderInMonth: 0,
    who: producer.id,
    cellId: producer.position.cellId,
    change: 'death',
    result: 'the instrument was left in the estate',
    diff: { personId: producer.id },
  };
  const estateDrop = addDrop(
    state,
    Material.BeamBalance,
    1,
    producer.position.cellId,
    2,
    [...original.sourceEventIds, deathFact.id],
    'lineage-estate',
    undefined,
    producer.position.z,
    [`inventory:${producer.id}:${original.id}`],
    producer.id,
  );
  deathFact.diff.estateInventory = [{
    sourceStackId: original.id,
    dropId: estateDrop.id,
    materialId: Material.BeamBalance,
    quantity: 1,
    estateOfPersonId: producer.id,
  }];
  assert.deepEqual(
    estateDrop.sourceEventIds,
    [...manufactureIds.slice(1), deathFact.id],
    'new ground drop must retain the newest 24 real sources',
  );

  const pickupFact = {
    id: 'lineage-estate-pickup',
    kind: 'action',
    atMonth: 3,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    who: receiver.id,
    cellId: producer.position.cellId,
    status: 'completed',
    action: {
      kind: 'transfer', materialId: Material.BeamBalance, quantity: 1,
      from: { kind: 'ground', cellId: producer.position.cellId, z: producer.position.z },
      to: { kind: 'person', personId: receiver.id },
      dropId: estateDrop.id,
    },
    result: 'picked up the estate instrument',
    diff: {
      materialId: Material.BeamBalance,
      quantity: 1,
      estateOfPersonId: producer.id,
      sourceLineageKeys: [`drop:${estateDrop.id}`, ...(estateDrop.sourceLineageKeys ?? [])],
    },
  };
  const received = addInventory(
    receiver,
    Material.BeamBalance,
    1,
    [...estateDrop.sourceEventIds, pickupFact.id],
    'lineage-received-instrument',
    undefined,
    [`drop:${estateDrop.id}`, ...(estateDrop.sourceLineageKeys ?? [])],
  );
  assert.deepEqual(
    received.sourceEventIds,
    [...manufactureIds.slice(2), deathFact.id, pickupFact.id],
    'new receiver stack must remain bounded while preserving death and pickup witnesses',
  );

  const container = {
    id: 'lineage-container', position: { x: 0, y: 0, z: 1 }, inventory: [],
    createdAtMonth: 0, sourceEventIds: [],
  };
  const containerStack = addContainerInventory(
    container,
    Material.BeamBalance,
    1,
    [...manufactureIds, deathFact.id],
    'lineage-container-instrument',
  );
  assert.deepEqual(containerStack.sourceEventIds, [...manufactureIds.slice(1), deathFact.id]);
  assert.equal(received.sourceEventIds.length, ITEM_SOURCE_EVENT_LIMIT);
  assert.ok(received.sourceEventIds.every((eventId) => (
    manufactureIds.includes(eventId) || eventId === deathFact.id || eventId === pickupFact.id
  )), 'bounded selector must never invent a provenance source');

  const transferOnlyFacts = Array.from({ length: ITEM_SOURCE_EVENT_LIMIT + 1 }, (_, index) => ({
    id: `lineage-transfer-only-${index}`,
    kind: 'action',
    atMonth: 4,
    orderInMonth: index,
    planningTick: 0,
    orderInTick: index,
    who: unsupportedHolder.id,
    cellId: unsupportedHolder.position.cellId,
    status: 'completed',
    action: {
      kind: 'transfer', materialId: Material.BeamBalance, quantity: 1,
      from: { kind: 'person', personId: producer.id },
      to: { kind: 'person', personId: unsupportedHolder.id },
    },
    result: 'transferred an instrument without a production witness',
    diff: { materialId: Material.BeamBalance, quantity: 1 },
  }));
  addInventory(
    unsupportedHolder,
    Material.BeamBalance,
    1,
    transferOnlyFacts.map((event) => event.id),
    'lineage-unsupported-instrument',
  );

  const wrongMaterialDeathFact = {
    id: 'lineage-wrong-material-death',
    kind: 'environment',
    atMonth: 5,
    orderInMonth: 0,
    who: producer.id,
    cellId: producer.position.cellId,
    change: 'death',
    result: 'a death fact bound to a different material',
    diff: {
      personId: producer.id,
      estateInventory: [{
        sourceStackId: original.id,
        dropId: 'drop-lineage-wrong-material',
        materialId: Material.StandardWeight,
        quantity: 1,
        estateOfPersonId: producer.id,
      }],
    },
  };
  const wrongMaterialPickupFact = {
    id: 'lineage-wrong-material-pickup',
    kind: 'action',
    atMonth: 6,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    who: wrongMaterialHolder.id,
    cellId: producer.position.cellId,
    status: 'completed',
    action: {
      kind: 'transfer', materialId: Material.BeamBalance, quantity: 1,
      from: { kind: 'ground', cellId: producer.position.cellId, z: producer.position.z },
      to: { kind: 'person', personId: wrongMaterialHolder.id },
      dropId: 'drop-lineage-wrong-material',
    },
    result: 'picked up an instrument with a wrong-material death witness',
    diff: { materialId: Material.BeamBalance, quantity: 1, estateOfPersonId: producer.id },
  };
  addInventory(
    wrongMaterialHolder,
    Material.BeamBalance,
    1,
    [manufactureIds.at(-1), wrongMaterialDeathFact.id, wrongMaterialPickupFact.id],
    'lineage-wrong-material-instrument',
  );

  const wrongBindingDeathFact = {
    id: 'lineage-wrong-binding-death',
    kind: 'environment',
    atMonth: 7,
    orderInMonth: 0,
    who: producer.id,
    cellId: producer.position.cellId,
    change: 'death',
    result: 'a death fact bound to a different estate drop',
    diff: {
      personId: producer.id,
      estateInventory: [{
        sourceStackId: original.id,
        dropId: 'drop-lineage-bound-estate',
        materialId: Material.BeamBalance,
        quantity: 1,
        estateOfPersonId: producer.id,
      }],
    },
  };
  const wrongBindingPickupFact = {
    id: 'lineage-wrong-binding-pickup',
    kind: 'action',
    atMonth: 8,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    who: wrongBindingHolder.id,
    cellId: producer.position.cellId,
    status: 'completed',
    action: {
      kind: 'transfer', materialId: Material.BeamBalance, quantity: 1,
      from: { kind: 'ground', cellId: producer.position.cellId, z: producer.position.z },
      to: { kind: 'person', personId: wrongBindingHolder.id },
      dropId: 'drop-lineage-other-estate',
    },
    result: 'picked up an instrument from a drop not bound by the death fact',
    diff: { materialId: Material.BeamBalance, quantity: 1, estateOfPersonId: producer.id },
  };
  addInventory(
    wrongBindingHolder,
    Material.BeamBalance,
    1,
    [manufactureIds.at(-1), wrongBindingDeathFact.id, wrongBindingPickupFact.id],
    'lineage-wrong-binding-instrument',
  );

  state.world.past.push(
    ...productionFacts,
    deathFact,
    pickupFact,
    ...transferOnlyFacts,
    wrongMaterialDeathFact,
    wrongMaterialPickupFact,
    wrongBindingDeathFact,
    wrongBindingPickupFact,
  );
  state.world.historyCursor = {
    version: 1,
    eventCount: state.world.past.length,
    hotStartIndex: 0,
    tailEventId: wrongBindingPickupFact.id,
  };
  assert.equal(currentMassMeasurementInstrument(state, producer)?.id, original.id,
    'bounded production witnesses must remain a usable physical instrument');
  assert.equal(currentMassMeasurementInstrument(state, receiver)?.id, received.id,
    'a precisely bound death and pickup lifecycle must preserve the real inherited instrument');
  assert.equal(currentMassMeasurementInstrument(state, unsupportedHolder), undefined,
    'truncation must not manufacture evidence for a transfer-only artifact');
  assert.equal(currentMassMeasurementInstrument(state, wrongMaterialHolder), undefined,
    'a death witness for another material must not validate the current instrument');
  assert.equal(currentMassMeasurementInstrument(state, wrongBindingHolder), undefined,
    'a death witness for another estate drop must not validate the current instrument');
  const fold = beginHistoryRetentionProjection(state, { stateHash: 'a'.repeat(64) });
  foldHistoryRetentionSegment(fold, state.world.past, 0);
  const retention = finishHistoryRetentionProjection(fold);
  const receiverLease = personalMassCalibrationLeaseKey(receiver.id, received.id);
  const pinsById = new Map(retention.pins.map((pin) => [pin.eventId, pin]));
  for (const eventId of received.sourceEventIds) {
    assert.ok(pinsById.get(eventId)?.leaseKeys.includes(receiverLease),
      `bounded retention must preserve receiver instrument source ${eventId}`);
  }

  console.log(JSON.stringify({
    itemSourceEventLimit: ITEM_SOURCE_EVENT_LIMIT,
    receivedSources: received.sourceEventIds.length,
    retentionPins: retention.pins.length,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
