import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-project-request-renewal-'));
const bundlePath = path.join(temporaryDirectory, 'project-request-renewal.mjs');

try {
  const testEntry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildProjectOptions, ensureProject, recordProjectAction, recompileProjectNextAction } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { contributedQuantityForProjectMaterialRequest, inspectProjectMaterialContributionRequest } from ${JSON.stringify(path.resolve('src/game/eland/domain/project-material-request.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, voxelAt } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=project-request-renewal-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    Material,
    buildProjectOptions,
    cellX,
    cellY,
    contributedQuantityForProjectMaterialRequest,
    createInitialState,
    ensureProject,
    executePrimitiveAction,
    inspectProjectMaterialContributionRequest,
    neighbors4,
    recompileProjectNextAction,
    setVoxel,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function createFixture(seed) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 5;
    state.world.past = [];
    const [owner, firstContributor, replacementContributor] = state.people;
    state.people = [owner, firstContributor, replacementContributor];
    for (const person of state.people) {
      person.body = { health: 100, hydration: 100, nutrition: 100 };
      person.conditions = [];
      person.position = structuredClone(owner.position);
      person.inventory = [];
    }
    owner.inventory = [{ id: `tin-${seed}`, materialId: Material.Tin, quantity: 1, sourceEventIds: ['known-tin'] }];
    const facility = neighbors4(owner.position.cellId).map((cellId) => ({
      cellId,
      x: cellX(cellId),
      y: cellY(cellId),
      z: owner.position.z,
    })).find((position) => voxelAt(state.world.grid, position.x, position.y, position.z) === Material.Air
      && voxelAt(state.world.grid, position.x, position.y, position.z - 1) !== Material.Air);
    assert.ok(facility, '材料续发夹具需要一个相邻且可工作的固定窑炉位置');
    setVoxel(state.world.grid, facility.x, facility.y, facility.z, Material.Kiln);
    const demand = {
      materialId: Material.Copper,
      requiredQuantity: 1,
      availableQuantity: 0,
      outstandingQuantity: 1,
      branchKey: 'test:bronze-alloying:copper',
      sourceFactIds: ['known-copper-gap'],
    };
    const project = ensureProject(state, {
      id: `request-renewal-${seed}`,
      kind: 'production',
      need: 'alloy-capability',
      desiredFunction: 'bronze-alloying',
      summary: '在固定窑炉汇合铜与锡',
      ownerId: owner.id,
      beneficiaryIds: state.people.map((person) => person.id),
      triggerFactIds: ['known-copper-gap'],
      pressure: 80,
      createdAtMonth: 1,
      reviewAtMonth: 48,
      site: { cellId: facility.cellId, z: facility.z },
      initialMaterialDemands: [structuredClone(demand)],
    });
    project.materialDemands = [structuredClone(demand)];
    const request = {
      version: 'project-material-contribution-request-v1',
      requestEventId: `old-request-${seed}`,
      projectId: project.id,
      requesterId: owner.id,
      contributorIds: [firstContributor.id],
      materialId: Material.Copper,
      requestedQuantity: 1,
      site: { ...project.site },
      expiresAtMonth: 18,
      atMonth: 2,
    };
    project.materialContributionRequests = [request];
    return { state, owner, firstContributor, replacementContributor, project, request, demand };
  }

  function requestAction(project, owner, listener, expiresAtMonth = 18) {
    return {
      kind: 'communicate',
      content: {
        id: `project-material-request:${project.id}:${Material.Copper}`,
        kind: 'request',
        summary: '项目仍缺铜，请送到固定工地',
        projectMaterialContribution: {
          version: 'project-material-contribution-request-v1',
          projectId: project.id,
          requesterId: owner.id,
          materialId: Material.Copper,
          quantity: 1,
          site: { ...project.site },
          expiresAtMonth,
        },
      },
      audience: [listener.id],
      channel: 'gesture',
    };
  }

  {
    const fixture = createFixture(9301);
    fixture.firstContributor.inventory = [{ id: 'dead-copper', materialId: Material.Copper, quantity: 1, sourceEventIds: ['dead-copper'] }];
    fixture.firstContributor.diedAtMonth = 5;
    fixture.replacementContributor.inventory = [{ id: 'replacement-copper', materialId: Material.Copper, quantity: 1, sourceEventIds: ['replacement-copper'] }];
    const oldView = inspectProjectMaterialContributionRequest(
      fixture.state, fixture.project, fixture.request, 6, fixture.demand,
    );
    assert.equal(oldView.status, 'contributors-unavailable', '死亡的旧听者不能让历史请求继续占用 open 状态');
    const renewal = recompileProjectNextAction(fixture.state, fixture.owner, fixture.project.id);
    assert.equal(renewal?.kind, 'communicate', `旧听者失效后，owner 应立即续发材料请求：${JSON.stringify(renewal)}`);
    assert.deepEqual(renewal?.kind === 'communicate' ? renewal.audience : [], [fixture.replacementContributor.id]);
    assert.equal(fixture.project.materialContributionRequests.length, 1, '规划续发不得删除或改写旧请求 basis');
    const renewalFact = executePrimitiveAction(
      fixture.state, fixture.owner, renewal, 6, 0, { cause: 'intent', actionTick: 1 },
    );
    assert.equal(renewalFact.status, 'completed', renewalFact.result);
    assert.equal(fixture.project.materialContributionRequests.length, 2, 'executor 应允许 unavailable 请求之后形成新的独立 basis');
    assert.equal(fixture.project.materialContributionRequests[1].contributorIds[0], fixture.replacementContributor.id);

    const roundTripped = JSON.parse(JSON.stringify(fixture.state));
    const roundTripProject = roundTripped.projects.find((candidate) => candidate.id === fixture.project.id);
    const roundTripOld = roundTripProject.materialContributionRequests[0];
    assert.equal(inspectProjectMaterialContributionRequest(
      roundTripped, roundTripProject, roundTripOld, 6, roundTripProject.materialDemands[0],
    ).status, 'contributors-unavailable', '派生 open 状态必须能从 JSON 往返后的事实重建');
  }

  {
    const fixture = createFixture(9302);
    fixture.firstContributor.inventory = [{ id: 'open-copper', materialId: Material.Copper, quantity: 1, sourceEventIds: ['open-copper'] }];
    fixture.replacementContributor.inventory = [{ id: 'other-copper', materialId: Material.Copper, quantity: 1, sourceEventIds: ['other-copper'] }];
    assert.equal(inspectProjectMaterialContributionRequest(
      fixture.state, fixture.project, fixture.request, 6, fixture.demand,
    ).status, 'open');
    const plannerResult = recompileProjectNextAction(fixture.state, fixture.owner, fixture.project.id);
    assert.ok(!(plannerResult?.kind === 'communicate'
      && plannerResult.content.kind === 'request'
      && plannerResult.content.projectMaterialContribution), '同项目同材料已有 open 请求时，planner 不得续发重复请求');
    fixture.project.materialDemands = [structuredClone(fixture.demand)];
    const duplicateFact = executePrimitiveAction(
      fixture.state,
      fixture.owner,
      requestAction(fixture.project, fixture.owner, fixture.replacementContributor),
      6,
      0,
      { cause: 'intent', actionTick: 1 },
    );
    assert.equal(duplicateFact.status, 'blocked', 'executor 必须用同一 open 判定阻止绕过 planner 的重复请求');
  }

  {
    const fixture = createFixture(9303);
    fixture.request.expiresAtMonth = 5;
    fixture.firstContributor.inventory = [{ id: 'expired-copper', materialId: Material.Copper, quantity: 1, sourceEventIds: ['expired-copper'] }];
    assert.equal(inspectProjectMaterialContributionRequest(
      fixture.state, fixture.project, fixture.request, 6, fixture.demand,
    ).status, 'expired');
    const renewal = recompileProjectNextAction(fixture.state, fixture.owner, fixture.project.id);
    assert.equal(renewal?.kind, 'communicate', '过期请求不得永久封死同材料续发');
    fixture.project.materialDemands = [structuredClone(fixture.demand)];
    const renewalFact = executePrimitiveAction(
      fixture.state,
      fixture.owner,
      requestAction(fixture.project, fixture.owner, fixture.firstContributor, 20),
      6,
      0,
      { cause: 'intent', actionTick: 1 },
    );
    assert.equal(renewalFact.status, 'completed', renewalFact.result);
  }

  {
    const fixture = createFixture(9304);
    fixture.firstContributor.inventory = [{ id: 'already-satisfied-copper', materialId: Material.Copper, quantity: 3, sourceEventIds: ['already-satisfied-copper'] }];
    fixture.owner.inventory.push({ id: 'owner-copper', materialId: Material.Copper, quantity: 1, sourceEventIds: ['owner-self-acquired'] });
    const view = inspectProjectMaterialContributionRequest(
      fixture.state, fixture.project, fixture.request, 6, fixture.project.materialDemands[0],
    );
    assert.equal(view.status, 'fulfilled', '当前 branch 缺口归零时旧请求应从 open 状态退出');
    assert.equal(recompileProjectNextAction(fixture.state, fixture.firstContributor, fixture.project.id), null,
      'owner 已自采补齐后，贡献者不得继续运输旧请求材料');
    const options = buildProjectOptions(
      fixture.state,
      fixture.firstContributor,
      [fixture.owner.position.cellId, fixture.project.site.cellId],
      [],
      [fixture.owner],
    );
    assert.ok(!options.some((option) => option.projectId === fixture.project.id),
      'owner 自采补齐后，请求项目不应继续出现在贡献者候选中');
  }

  {
    const fixture = createFixture(9305);
    fixture.request.requestedQuantity = 5;
    fixture.firstContributor.inventory = [{ id: 'large-copper-stack', materialId: Material.Copper, quantity: 3, sourceEventIds: ['large-copper-stack'] }];
    fixture.project.materialDemands = [structuredClone(fixture.demand)];
    const delivery = recompileProjectNextAction(fixture.state, fixture.firstContributor, fixture.project.id);
    assert.equal(delivery?.kind, 'transfer', `工地相邻持料者应形成直接交付：${JSON.stringify(delivery)}`);
    assert.equal(delivery?.kind === 'transfer' ? delivery.quantity : 0, 1,
      '交付量必须同时截断到 request remaining 与当前 branch outstanding');
    assert.equal(delivery?.kind === 'transfer' ? delivery.authorizationRef : undefined, fixture.request.requestEventId,
      '新交付必须精确绑定触发它的 requestEventId');
  }

  {
    const fixture = createFixture(9306);
    fixture.request.requestedQuantity = 5;
    fixture.request.expiresAtMonth = 3;
    fixture.project.actionEventIds = ['inside-legacy', 'outside-legacy', 'inside-wrong-ref', 'inside-exact-ref'];
    const actionFact = (id, atMonth, authorizationRef) => ({
      id,
      kind: 'action',
      actionTick: 1,
      atMonth,
      orderInMonth: 0,
      cellId: fixture.firstContributor.position.cellId,
      who: fixture.firstContributor.id,
      cause: 'intent',
      action: {
        kind: 'transfer',
        materialId: Material.Copper,
        quantity: 1,
        from: { kind: 'person', personId: fixture.firstContributor.id },
        to: { kind: 'person', personId: fixture.owner.id },
        ...(authorizationRef ? { authorizationRef } : {}),
      },
      fromCellId: fixture.firstContributor.position.cellId,
      toCellId: fixture.firstContributor.position.cellId,
      fromZ: fixture.firstContributor.position.z,
      toZ: fixture.firstContributor.position.z,
      pathSegment: [fixture.firstContributor.position.cellId],
      status: 'completed',
      result: '测试交付',
      diff: { quantity: 1 },
    });
    fixture.state.world.past.push(
      actionFact('inside-legacy', 2),
      actionFact('outside-legacy', 4),
      actionFact('inside-wrong-ref', 2, 'another-request'),
      actionFact('inside-exact-ref', 3, fixture.request.requestEventId),
    );
    assert.equal(contributedQuantityForProjectMaterialRequest(fixture.state, fixture.project, fixture.request), 2,
      '旧无 ref 的有效期内交付保持兼容；有效期外、错误 ref 不得串账；精确 ref 应计入');
  }

  process.stdout.write('project material request renewal tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
