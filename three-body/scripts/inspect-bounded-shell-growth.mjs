import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deserialize } from 'node:v8';
import { brotliDecompressSync } from 'node:zlib';

const [dataDirectoryInput, runId] = process.argv.slice(2);
if (!dataDirectoryInput || !runId) {
  throw new Error('用法: node --expose-gc scripts/inspect-bounded-shell-growth.mjs <data-dir> <run-id>');
}

const databaseFile = path.join(path.resolve(dataDirectoryInput), 'eland.sqlite3');
const database = new DatabaseSync(databaseFile, { readOnly: true });

function chunk(hash) {
  const row = database.prepare(`
    SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?
  `).get(hash);
  assert.ok(row, `缺少 chunk ${hash}`);
  const data = Buffer.from(row.data);
  assert.equal(Number(row.raw_size), data.byteLength);
  const actualHash = createHash('sha256')
    .update(String(row.codec))
    .update('\0')
    .update(data)
    .digest('hex');
  assert.equal(actualHash, String(row.hash));
  return { hash: String(row.hash), codec: String(row.codec), data };
}

function decodePlain(hash) {
  return deserialize(chunk(hash).data);
}

function decodeCompressed(hash) {
  const stored = chunk(hash);
  assert.equal(stored.codec, 'eland-run-state-shell-part-v1');
  return deserialize(brotliDecompressSync(stored.data));
}

const run = database.prepare(`
  SELECT state_hash, elapsed_months FROM runs WHERE id = ?
`).get(runId);
assert.ok(run, `运行不存在: ${runId}`);
const root = decodePlain(String(run.state_hash));
assert.equal(root.schemaVersion, 3, '只检查 schema3 segmented shell');
const manifestChunk = chunk(root.shellHash);
assert.equal(manifestChunk.codec, 'eland-run-state-shell-manifest-v1');
const manifest = deserialize(manifestChunk.data);
const allFields = [...manifest.fields, ...manifest.worldFields];

function field(name) {
  const selected = allFields.find((candidate) => candidate.name === name);
  assert.ok(selected, `shell 缺少字段 ${name}`);
  return selected;
}

function streamArray(name, visit) {
  const selected = field(name);
  assert.equal(selected.kind, 'array');
  let count = 0;
  for (const reference of selected.segments) {
    {
      const values = decodeCompressed(reference.hash);
      assert.equal(Array.isArray(values), true);
      assert.equal(values.length, reference.itemCount);
      for (const value of values) visit(value, count++);
    }
    globalThis.gc?.();
  }
  assert.equal(count, selected.length);
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

const people = {
  statuses: {},
  memories: 0,
  knowledge: 0,
  relations: 0,
  personalityEvidence: 0,
  outcomeBeliefs: 0,
  goalOutcomeBeliefs: 0,
  needResolutionEpisodes: 0,
  knowledgeById: {},
  inventoryByMaterialId: {},
  byId: {},
};
const livingIds = new Set();
streamArray('people', (person) => {
  const alive = person.diedAtMonth === undefined && Number(person.body?.health ?? 0) > 0;
  increment(people.statuses, alive ? 'living' : 'dead');
  if (alive) livingIds.add(person.id);
  people.memories += person.memories?.length ?? 0;
  people.knowledge += person.knowledge?.length ?? 0;
  people.relations += person.relations?.length ?? 0;
  people.personalityEvidence += person.personality?.evidence?.length ?? 0;
  people.outcomeBeliefs += person.cognition?.outcomeBeliefs?.length ?? 0;
  people.goalOutcomeBeliefs += person.cognition?.goalOutcomeBeliefs?.length ?? 0;
  people.needResolutionEpisodes += person.cognition?.needResolutionEpisodes?.length ?? 0;
  for (const fact of person.knowledge ?? []) increment(people.knowledgeById, String(fact.id));
  for (const stack of person.inventory ?? []) {
    const key = String(stack.materialId);
    people.inventoryByMaterialId[key] = (people.inventoryByMaterialId[key] ?? 0)
      + Math.max(0, Number(stack.quantity) || 0);
  }
  people.byId[person.id] = {
    alive,
    position: person.position,
    inventory: (person.inventory ?? []).filter((stack) => Number(stack.quantity) > 0).map((stack) => ({
      id: stack.id,
      materialId: stack.materialId,
      quantity: stack.quantity,
      sourceEventIds: stack.sourceEventIds ?? [],
      sourceLineageKeys: stack.sourceLineageKeys ?? [],
    })),
    knowledgeIds: (person.knowledge ?? []).map((fact) => fact.id),
  };
});

const intents = {
  statuses: {},
  live: 0,
  unresolvedReturns: 0,
  recent24Months: 0,
  terminalOwnedByLiving: 0,
  lifeReviewOwnedByLiving: 0,
};
streamArray('intents', (intent) => {
  increment(intents.statuses, String(intent.status));
  if (intent.status === 'active' || intent.status === 'suspended') intents.live += 1;
  if (intent.returnToIntentId && intent.returnOutcome === undefined) intents.unresolvedReturns += 1;
  if (Number(intent.createdAtMonth) >= Number(run.elapsed_months) - 24) intents.recent24Months += 1;
  if (intent.status !== 'active' && intent.status !== 'suspended' && livingIds.has(intent.ownerId)) {
    intents.terminalOwnedByLiving += 1;
    if (intent.lifeReview || intent.relationshipBasis) intents.lifeReviewOwnedByLiving += 1;
  }
});

const agreements = { statuses: {}, live: 0, terminalTouchingLiving: 0 };
streamArray('agreements', (agreement) => {
  increment(agreements.statuses, String(agreement.status));
  if (agreement.status === 'active' || agreement.status === 'proposed') agreements.live += 1;
  else if ((agreement.partyIds ?? []).some((personId) => livingIds.has(personId))) {
    agreements.terminalTouchingLiving += 1;
  }
});

const projects = {
  statuses: {},
  active: 0,
  terminalTouchingLiving: 0,
  terminalOwnedByLiving: 0,
  inquiryMemoryOwnedByLiving: 0,
  recentCompleted12Months: 0,
  terminalInquiryMemory: 0,
  actionEventIds: 0,
  completionEventIds: 0,
  failureEventIds: 0,
  triggerFactIds: 0,
  logisticsEpisodes: 0,
  searchCampaigns: 0,
  hypothesisAttempts: 0,
  byFunctionAndStatus: {},
  byNeedAndStatus: {},
  blockedReasons: {},
  capabilityProjects: [],
};
const capabilityProjectActionIds = new Map();
streamArray('projects', (project) => {
  increment(projects.statuses, String(project.status));
  if (project.status === 'active') projects.active += 1;
  else if ([project.ownerId, ...(project.beneficiaryIds ?? []), ...(project.contributorIds ?? [])]
    .some((personId) => livingIds.has(personId))) projects.terminalTouchingLiving += 1;
  if (project.status !== 'active' && livingIds.has(project.ownerId)) {
    projects.terminalOwnedByLiving += 1;
  }
  if (project.status === 'completed'
    && Number(project.completedAtMonth) >= Number(run.elapsed_months) - 12) {
    projects.recentCompleted12Months += 1;
  }
  if (project.terminalInquiryOpportunityBasis
    || project.inquiryOpportunityBasis
    || project.hypothesisCampaign?.attempts?.length
    || project.searchCampaigns?.length) {
    projects.terminalInquiryMemory += 1;
    if (livingIds.has(project.ownerId)) projects.inquiryMemoryOwnedByLiving += 1;
  }
  projects.actionEventIds += project.actionEventIds?.length ?? 0;
  projects.completionEventIds += project.completionEventIds?.length ?? 0;
  projects.failureEventIds += project.failureEventIds?.length ?? 0;
  projects.triggerFactIds += project.triggerFactIds?.length ?? 0;
  projects.logisticsEpisodes += project.logisticsEpisodes?.length ?? 0;
  projects.searchCampaigns += project.searchCampaigns?.length ?? 0;
  projects.hypothesisAttempts += project.hypothesisCampaign?.attempts?.length ?? 0;
  increment(projects.byFunctionAndStatus, `${project.desiredFunction}:${project.status}`);
  increment(projects.byNeedAndStatus, `${project.need}:${project.status}`);
  if (project.status === 'blocked') increment(projects.blockedReasons, String(project.blockedReason ?? 'unknown'));
  if (/settled-cultivation|crop-processing|charge|smelting|alloy|foundry|smith|mechanical|electrical|measurement|record/u.test(
    String(project.desiredFunction),
  )) {
    capabilityProjectActionIds.set(project.id, new Set(project.actionEventIds ?? []));
    projects.capabilityProjects.push({
      id: project.id,
      ownerId: project.ownerId,
      status: project.status,
      need: project.need,
      desiredFunction: project.desiredFunction,
      createdAtMonth: project.createdAtMonth,
      completedAtMonth: project.completedAtMonth ?? null,
      blockedAtMonth: project.blockedAtMonth ?? null,
      blockedReason: project.blockedReason ?? null,
      missingMaterialIds: project.missingMaterialIds ?? [],
      actionEvents: project.actionEventIds?.length ?? 0,
      failures: project.failureEventIds?.length ?? 0,
      triggerFactIds: project.triggerFactIds ?? [],
      pressureBasis: project.pressureBasis ?? null,
      inquiryOpportunityBasis: project.inquiryOpportunityBasis ?? null,
      hypothesisStatus: project.hypothesisCampaign?.status ?? null,
      hypothesisEndingReason: project.hypothesisCampaign?.endingReason ?? null,
      hypothesisAttempts: project.hypothesisCampaign?.attempts?.length ?? 0,
      hypothesisCandidates: (project.hypothesisCampaign?.candidates ?? []).map((candidate) => ({
        key: candidate.key,
        operation: candidate.operation,
        materialIds: candidate.materialIds,
        reasonKeys: candidate.reasonKeys,
        seededRank: candidate.seededRank,
      })),
      attempts: (project.hypothesisCampaign?.attempts ?? []).map((attempt) => ({
        candidateKey: attempt.candidateKey,
        outcome: attempt.outcome,
        eventId: attempt.eventId,
        verifiedEventId: attempt.verifiedEventId ?? null,
      })),
      searchCampaigns: (project.searchCampaigns ?? []).map((campaign) => ({
        id: campaign.id,
        status: campaign.status,
        targetMaterialId: campaign.targetMaterialId,
        targetMaterialIds: campaign.targetMaterialIds,
        visited: campaign.visitedCellIds?.length ?? 0,
        visitedCellIds: campaign.visitedCellIds ?? [],
        endingReason: campaign.endingReason ?? null,
      })),
      logisticsEpisodes: project.logisticsEpisodes ?? [],
      events: [],
    });
  }
});

const requestedCapabilityEventIds = new Set(
  [...capabilityProjectActionIds.values()].flatMap((ids) => [...ids]),
);
const recordReuse = {
  stages: {},
  facts: [],
  projectKnowledgeRequests: [],
  writtenRecords: [],
};
if (requestedCapabilityEventIds.size > 0) {
  const reversedHistoryNodes = [];
  for (let hash = root.historyHeadHash; hash;) {
    const stored = chunk(hash);
    assert.equal(stored.codec, 'eland-run-history-node-v1');
    const node = deserialize(stored.data);
    reversedHistoryNodes.push(node);
    hash = node.parentHash;
  }
  const eventsById = new Map();
  for (const node of reversedHistoryNodes.reverse()) {
    for (const reference of node.segments) {
      const stored = chunk(reference.hash);
      assert.equal(stored.codec, 'eland-run-state-events-v1');
      const events = deserialize(brotliDecompressSync(stored.data));
      for (const event of events) {
        if (event.kind === 'action') {
          if (typeof event.diff?.recordUseStage === 'string') {
            increment(recordReuse.stages, event.diff.recordUseStage);
            recordReuse.facts.push({
              id: event.id,
              atMonth: event.atMonth,
              who: event.who,
              status: event.status,
              stage: event.diff.recordUseStage,
              projectId: event.diff.recordUseProjectId ?? null,
              recordId: event.diff.recordUseRecordId ?? null,
              knowledgeId: event.diff.recordUseKnowledgeId ?? null,
              confidenceBefore: event.diff.recordUseKnowledgeConfidenceBefore ?? null,
              confidenceAfter: event.diff.recordUseKnowledgeConfidenceAfter ?? null,
              outputMaterialId: event.diff.outputMaterialId ?? null,
            });
          }
          if (event.action.kind === 'communicate'
            && event.action.content.kind === 'request'
            && event.action.content.projectKnowledgeRequest) {
            recordReuse.projectKnowledgeRequests.push({
              id: event.id,
              atMonth: event.atMonth,
              who: event.who,
              status: event.status,
              audience: event.action.audience,
              heardAudience: event.diff.audience ?? [],
              request: event.action.content.projectKnowledgeRequest,
            });
          }
          if (typeof event.diff?.recordPayloadId === 'string') {
            recordReuse.writtenRecords.push({
              id: event.id,
              atMonth: event.atMonth,
              who: event.who,
              status: event.status,
              recordId: event.diff.recordPayloadId,
              knowledgeId: event.diff.knowledgeId ?? null,
            });
          }
        }
        if (requestedCapabilityEventIds.has(event.id)) eventsById.set(event.id, event);
      }
    }
  }
  for (const project of projects.capabilityProjects) {
    const actionIds = capabilityProjectActionIds.get(project.id) ?? new Set();
    project.events = [...actionIds].map((eventId) => eventsById.get(eventId)).filter(Boolean);
  }
}

const worldCapability = {
  dropQuantityByMaterialId: {},
  containerQuantityByMaterialId: {},
  records: field('records').kind === 'array' ? field('records').length : 0,
  mechanicalSources: 0,
  mechanicalNetworks: 0,
  electricalNetworks: 0,
  physicalStructures: 0,
};
streamArray('drops', (drop) => {
  const key = String(drop.materialId);
  worldCapability.dropQuantityByMaterialId[key] = (worldCapability.dropQuantityByMaterialId[key] ?? 0)
    + Math.max(0, Number(drop.quantity) || 0);
});
streamArray('containers', (container) => {
  for (const stack of container.inventory ?? []) {
    const key = String(stack.materialId);
    worldCapability.containerQuantityByMaterialId[key] = (worldCapability.containerQuantityByMaterialId[key] ?? 0)
      + Math.max(0, Number(stack.quantity) || 0);
  }
});
const mechanicalPower = decodeCompressed(field('mechanicalPower').hash);
worldCapability.mechanicalSources = mechanicalPower?.sources?.length ?? 0;
worldCapability.mechanicalNetworks = mechanicalPower?.networks?.length ?? 0;
const electricalField = allFields.find((candidate) => candidate.name === 'electricalPower');
if (electricalField?.kind === 'value') {
  const electricalPower = decodeCompressed(electricalField.hash);
  worldCapability.electricalNetworks = electricalPower?.networks?.length ?? 0;
}
const physicalStructureIndex = decodeCompressed(field('physicalStructureIndex').hash);
worldCapability.physicalStructures = physicalStructureIndex?.structures?.filter(
  (structure) => structure.complete,
)?.length ?? 0;
const civilization = decodeCompressed(field('civilization').hash);
const observerBasisField = allFields.find((candidate) => candidate.name === 'lastMaterializedObserverBasis');
const lastMaterializedObserverBasis = observerBasisField?.kind === 'value'
  ? decodeCompressed(observerBasisField.hash)
  : null;

const footprint = allFields.map((selected) => {
  const hashes = selected.kind === 'array'
    ? selected.segments.map((segment) => segment.hash)
    : [selected.hash];
  const compressedBytes = hashes.reduce((sum, hash) => sum + chunk(hash).data.byteLength, 0);
  return {
    name: selected.name,
    kind: selected.kind,
    ...(selected.kind === 'array' ? { length: selected.length, segments: selected.segments.length } : {}),
    compressedBytes,
  };
}).sort((left, right) => right.compressedBytes - left.compressedBytes);

console.log(JSON.stringify({
  run: {
    id: runId,
    month: Number(run.elapsed_months),
    stateHash: String(run.state_hash),
    eventCount: Number(root.eventCount),
  },
  people,
  intents,
  agreements,
  projects,
  recordReuse,
  worldCapability,
  civilization,
  lastMaterializedObserverBasis,
  footprint,
  maxRssBytes: process.resourceUsage().maxRSS * 1024,
}, null, 2));
database.close();
