import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-sourced-mass-measurement-'));
const bundlePath = path.join(temporaryDirectory, 'sourced-mass-measurement.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { addInventory, executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/history.ts'))};
    export { Material, MATERIAL_PALETTE, materialHas } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { inventoryCombinationFor, inventoryCombinationForOutput } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export {
      MASS_CALIBRATION_RECEIPT_VERSION,
      MASS_MEASUREMENT_RECEIPT_VERSION,
      MASS_MEASUREMENT_RESOLUTION,
      SOURCED_MASS_MEASUREMENT_ACTION_VERSION,
      isMassCalibrationReceipt,
      isMassMeasurementReceipt,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/measurement.ts'))};
    export { observeCapabilityMilestones } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/projection/capability-milestones.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=sourced-mass-measurement-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    MASS_CALIBRATION_RECEIPT_VERSION,
    MASS_MEASUREMENT_RECEIPT_VERSION,
    MASS_MEASUREMENT_RESOLUTION,
    MATERIAL_PALETTE,
    Material,
    SOURCED_MASS_MEASUREMENT_ACTION_VERSION,
    addInventory,
    appendCommittedEvents,
    createInitialState,
    executePrimitiveAction,
    inventoryCombinationFor,
    inventoryCombinationForOutput,
    isMassCalibrationReceipt,
    isMassMeasurementReceipt,
    materialHas,
    observeCapabilityMilestones,
  } = api;

  // Existing persisted IDs are untouched; apparatus materials append at the tail.
  assert.equal(Material.SteelDriveShaft, 69);
  assert.equal(Material.BeamBalance, 70);
  assert.equal(Material.StandardWeight, 71);
  assert.equal(MATERIAL_PALETTE.some((definition) => definition.id === Material.StandardWeight), true);
  assert.equal(materialHas(Material.BeamBalance, 'instrument'), true);
  assert.equal(materialHas(Material.StandardWeight, 'mass-reference'), true);
  assert.deepEqual(inventoryCombinationFor([Material.Plank, Material.Plank, Material.Rope]), {
    id: 'assemble-beam-balance',
    inputs: [
      { materialId: Material.Plank, quantity: 2 },
      { materialId: Material.Rope, quantity: 1 },
    ],
    output: { materialId: Material.BeamBalance, quantity: 1 },
  });
  assert.equal(inventoryCombinationFor([Material.Bronze, Material.Rope]).id, 'shape-standard-weight');
  assert.equal(inventoryCombinationForOutput(Material.StandardWeight).id, 'shape-standard-weight');

  const state = createInitialState(20260825, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
  const [actor, other] = state.people;
  actor.inventory = [];
  other.inventory = [];
  addInventory(actor, Material.Plank, 2, [], 'raw-balance-plank');
  addInventory(actor, Material.Rope, 2, [], 'raw-cord');
  addInventory(actor, Material.Bronze, 1, [], 'raw-reference-bronze');
  addInventory(actor, Material.Wood, 2, [], 'raw-subject-wood');

  const execute = (action, atMonth, orderInMonth) => executePrimitiveAction(
    state,
    actor,
    action,
    atMonth,
    orderInMonth,
    { cause: 'intent', actionTick: Math.max(1, Math.min(15, orderInMonth)) },
  );
  const commit = (action, atMonth, orderInMonth) => {
    const fact = execute(action, atMonth, orderInMonth);
    assert.equal(fact.status, 'completed', fact.result);
    appendCommittedEvents(state, [fact]);
    return fact;
  };

  const balanceManufacture = commit({
    kind: 'act', operation: 'combine', targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: 'raw-balance-plank' },
      { kind: 'inventory-stack', personId: actor.id, stackId: 'raw-balance-plank' },
      { kind: 'inventory-stack', personId: actor.id, stackId: 'raw-cord' },
    ],
  }, 1, 1);
  const referenceManufacture = commit({
    kind: 'act', operation: 'combine', targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: 'raw-reference-bronze' },
      { kind: 'inventory-stack', personId: actor.id, stackId: 'raw-cord' },
    ],
  }, 1, 2);
  const subjectManufacture = commit({
    kind: 'act', operation: 'combine', targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: 'raw-subject-wood' },
      { kind: 'inventory-stack', personId: actor.id, stackId: 'raw-subject-wood' },
    ],
  }, 1, 3);

  const instrument = actor.inventory.find((stack) => stack.materialId === Material.BeamBalance);
  const reference = actor.inventory.find((stack) => stack.materialId === Material.StandardWeight);
  const subject = actor.inventory.find((stack) => stack.materialId === Material.Plank);
  assert.ok(instrument && reference && subject, '实体制造动作必须留下三件有来源库存');
  assert.deepEqual(instrument.sourceEventIds, [balanceManufacture.id]);
  assert.deepEqual(reference.sourceEventIds, [referenceManufacture.id]);
  assert.deepEqual(subject.sourceEventIds, [subjectManufacture.id]);

  const stackUse = (stack, quantity = 1, personId = actor.id, sourceEventIds = stack.sourceEventIds) => ({
    personId,
    stackId: stack.id,
    quantity,
    sourceEventIds: [...sourceEventIds],
  });
  const instrumentUse = () => stackUse(instrument, 1);
  const subjectUse = (quantity = subject.quantity) => stackUse(subject, quantity);
  const calibrationAction = (referenceUse = stackUse(reference, 1)) => ({
    kind: 'attend',
    target: { kind: 'inventory-stack', personId: actor.id, stackId: reference.id },
    instrumentStackId: instrument.id,
    measurement: {
      version: SOURCED_MASS_MEASUREMENT_ACTION_VERSION,
      mode: 'calibrate-mass',
      instrument: instrumentUse(),
      reference: referenceUse,
    },
  });
  const measurementAction = (calibrationEventId, overrides = {}) => ({
    kind: 'attend',
    target: { kind: 'inventory-stack', personId: actor.id, stackId: subject.id },
    instrumentStackId: instrument.id,
    measurement: {
      version: SOURCED_MASS_MEASUREMENT_ACTION_VERSION,
      mode: 'measure-mass',
      instrument: instrumentUse(),
      subject: subjectUse(),
      calibrationEventId,
      ...overrides,
    },
  });
  const inventorySnapshot = () => JSON.stringify(actor.inventory);
  const rejectedWithoutInventoryMutation = (action, atMonth, orderInMonth, message) => {
    const before = inventorySnapshot();
    const fact = execute(action, atMonth, orderInMonth);
    assert.equal(fact.status, 'blocked', message);
    assert.equal(inventorySnapshot(), before, `${message}: 拒绝不得消费、合并或改写实体栈`);
    return fact;
  };

  rejectedWithoutInventoryMutation(measurementAction('missing-calibration'), 2, 1, '没有本人校准事实不能测量');
  rejectedWithoutInventoryMutation({
    kind: 'attend',
    target: { kind: 'inventory-stack', personId: actor.id, stackId: subject.id },
    instrumentStackId: instrument.id,
  }, 2, 2, '任意 instrumentStackId 空壳必须被领域动作拒绝');
  rejectedWithoutInventoryMutation(calibrationAction(stackUse(reference, 1, other.id)), 2, 3, '不能拿他人持有者引用冒充本人参考物');
  rejectedWithoutInventoryMutation(calibrationAction(stackUse(reference, 1, actor.id, ['forged-source'])), 2, 4, '伪造来源必须被拒绝');
  rejectedWithoutInventoryMutation(calibrationAction({ ...stackUse(reference, 1), sourceEventIds: [] }), 2, 5, '缺来源必须被拒绝');
  rejectedWithoutInventoryMutation(measurementAction('missing-calibration', {
    instrument: stackUse(reference, 1),
  }), 2, 6, '普通物件不能冒充 instrument tag');

  reference.recordPayloadId = 'record:reference-fixture';
  rejectedWithoutInventoryMutation(calibrationAction(), 2, 7, '记录载体不能作为校准参考物');
  delete reference.recordPayloadId;

  const legacyShell = {
    id: 'legacy-instrument-shell', kind: 'action', actionTick: 1,
    atMonth: 2, orderInMonth: 20, cellId: actor.position.cellId,
    who: actor.id, cause: 'intent',
    action: {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: actor.id, stackId: subject.id },
      instrumentStackId: instrument.id,
    },
    fromCellId: actor.position.cellId, toCellId: actor.position.cellId,
    fromZ: actor.position.z, toZ: actor.position.z, pathSegment: [actor.position.cellId],
    status: 'completed', result: 'legacy shell', diff: { factId: 'legacy-shell' },
  };
  appendCommittedEvents(state, [legacyShell]);
  state.clock.elapsedMonths = 2;
  assert.equal(observeCapabilityMilestones(state).some((item) => item.id.includes('sourced-mass-measurement')), false,
    '旧 completed attend + 任意 instrumentStackId 不能再被观察器计为仪器测量');

  const calibration = commit(calibrationAction(), 2, 21);
  assert.equal(calibration.diff.version, MASS_CALIBRATION_RECEIPT_VERSION);
  assert.equal(isMassCalibrationReceipt(calibration.diff), true);
  assert.equal(calibration.diff.calibrationEventId, calibration.id);
  assert.equal(calibration.diff.calibratedByPersonId, actor.id);
  assert.equal(Object.isFrozen(calibration.diff), true);
  assert.equal(Object.isFrozen(calibration.diff.instrument.sourceEventIds), true);

  rejectedWithoutInventoryMutation(measurementAction(calibration.id, {
    subject: subjectUse(subject.quantity + 1),
  }), 3, 1, '被测数量超过真实持有量必须被拒绝');
  rejectedWithoutInventoryMutation(measurementAction(calibration.id, {
    subject: stackUse(subject, subject.quantity, other.id),
  }), 3, 2, '跨人物被测栈必须被拒绝');

  subject.recordPayloadId = 'record:subject-fixture';
  rejectedWithoutInventoryMutation(measurementAction(calibration.id), 3, 3, '记录载体不能作为普通被测物');
  delete subject.recordPayloadId;

  const measurement = commit(measurementAction(calibration.id), 3, 4);
  assert.equal(measurement.diff.version, MASS_MEASUREMENT_RECEIPT_VERSION);
  assert.equal(isMassMeasurementReceipt(measurement.diff), true);
  assert.equal(measurement.diff.measurementEventId, measurement.id);
  assert.equal(measurement.diff.calibrationEventId, calibration.id);
  assert.equal(measurement.diff.dimension, 'mass');
  assert.equal(measurement.diff.resolution, MASS_MEASUREMENT_RESOLUTION);
  assert.equal(measurement.diff.interval.upperInclusive - measurement.diff.interval.lowerInclusive,
    MASS_MEASUREMENT_RESOLUTION);
  assert.equal('exactMass' in measurement.diff, false, '回执不得泄漏内部精确质量');
  assert.equal('mass' in measurement.diff.subject, false, '实体回执只冻结来源与用量，不泄漏物质隐藏质量');
  assert.equal(Object.isFrozen(measurement.diff), true);
  assert.equal(Object.isFrozen(measurement.diff.interval), true);
  assert.deepEqual(measurement.diff.instrument.sourceEventIds, [balanceManufacture.id]);
  assert.deepEqual(measurement.diff.reference.sourceEventIds, [referenceManufacture.id]);
  assert.deepEqual(measurement.diff.subject.sourceEventIds, [subjectManufacture.id]);

  state.clock.elapsedMonths = 3;
  const milestone = observeCapabilityMilestones(state)
    .find((item) => item.id.includes('sourced-mass-measurement'));
  assert.ok(milestone, 'typed 测量回执和可解析校准链应形成事后观察里程碑');
  for (const eventId of [
    balanceManufacture.id,
    referenceManufacture.id,
    subjectManufacture.id,
    calibration.id,
    measurement.id,
  ]) assert.ok(milestone.evidenceEventIds.includes(eventId), `里程碑缺少来源事实 ${eventId}`);

  console.log(JSON.stringify({
    ok: true,
    materialIds: [Material.BeamBalance, Material.StandardWeight],
    calibrationEventId: calibration.id,
    measurementEventId: measurement.id,
    interval: measurement.diff.interval,
    evidenceEventCount: milestone.evidenceEventIds.length,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
