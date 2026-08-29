import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleDirectory = path.join(projectDirectory, 'src/game/eland');
const serverDirectory = path.join(projectDirectory, 'server');
const sourceExtensions = ['.ts', '.tsx'];

const serverDependencyRules = [
  {
    source: 'run-api.ts',
    forbidden: [
      {
        module: 'sqlite-run-store',
        reason: 'HTTP must depend on the RunAccessStore port from run-persistence',
      },
    ],
  },
  {
    source: 'run-evolution-executor.ts',
    forbidden: [
      {
        module: 'sqlite-run-store',
        reason: 'evolution execution must depend on the EvolutionExecutionStore port',
      },
    ],
  },
  {
    source: 'run-evolution-service.ts',
    forbidden: [
      {
        module: 'sqlite-run-store',
        reason: 'evolution scheduling must depend on the EvolutionStatusStore port',
      },
      {
        module: 'run-evolution-worker-client',
        reason: 'the Worker launcher must be injected by the composition root',
      },
    ],
  },
  {
    source: 'elandSession.ts',
    forbidden: [
      {
        module: '../src/game/eland/application/player-embodiment-month',
        reason: 'session infrastructure must use the public simulation composition root',
      },
      {
        module: '../src/game/eland/application/simulation/month-boundary',
        reason: 'limited-embodiment month preparation belongs to the application use case',
      },
      {
        module: '../src/game/eland/application/simulation/month-execution',
        reason: 'limited-embodiment month execution belongs to the application use case',
      },
      {
        module: '../src/game/eland/application/simulation/state-utils',
        reason: 'staged-state ownership belongs to the application use case',
      },
      {
        module: '../src/game/eland/projection/simulation-observation-projector',
        reason: 'the observation adapter must be injected by the public composition root',
      },
    ],
    forbiddenNamedImports: [
      {
        module: '../src/game/eland/simulation',
        names: ['RulePlanner'],
        reason: 'limited-embodiment automatic decisions belong to the application use case',
      },
    ],
  },
  {
    source: 'history-retention-codec.ts',
    forbidden: [
      {
        module: 'history-retention-projection',
        reason: 'the codec must depend on the stable retention contract, not the projection implementation',
      },
    ],
  },
  {
    source: 'history-retention-demand-collector.ts',
    forbidden: [
      {
        module: 'history-retention-projection',
        reason: 'demand collection is an input to projection and must not depend back on it',
      },
    ],
  },
  {
    source: 'run-state-bounded-decoder.ts',
    forbiddenRuntime: [
      {
        module: 'run-state-codec',
        reason: 'bounded decoding must receive codec primitives through its host port',
      },
    ],
  },
  {
    source: 'sqlite-run-output-artifact-store.ts',
    forbidden: [
      {
        module: 'sqlite-run-store',
        reason: 'the output artifact component must not depend back on its composing store',
      },
    ],
  },
  {
    source: 'sqlite-bounded-observer-boundary-publication.ts',
    forbidden: [
      {
        module: 'sqlite-run-store',
        reason: 'observer-boundary publication must use its narrow host port',
      },
      {
        module: 'sqlite-bounded-nonprojection-publication',
        reason: 'the two bounded publication coordinators meet only through their shared contract',
      },
      {
        module: 'sqlite-bounded-continuation-artifact-materialization',
        reason: 'publication coordination must not own continuation artifact materialization',
      },
    ],
    forbiddenSpecifiers: [
      {
        specifier: 'node:sqlite',
        reason: 'transaction and database ownership remain in the composing store',
      },
    ],
  },
  {
    source: 'sqlite-bounded-nonprojection-publication.ts',
    forbidden: [
      {
        module: 'sqlite-run-store',
        reason: 'nonprojection publication must use its narrow host port',
      },
      {
        module: 'sqlite-bounded-observer-boundary-publication',
        reason: 'the two bounded publication coordinators meet only through their shared contract',
      },
      {
        module: 'sqlite-bounded-continuation-artifact-materialization',
        reason: 'publication coordination must not own continuation artifact materialization',
      },
    ],
    forbiddenSpecifiers: [
      {
        specifier: 'node:sqlite',
        reason: 'transaction and database ownership remain in the composing store',
      },
    ],
  },
  {
    source: 'sqlite-bounded-publication-contract.ts',
    forbidden: [
      {
        module: 'sqlite-run-store',
        reason: 'the shared publication contract must remain independent of its composing store',
      },
      {
        module: 'sqlite-bounded-observer-boundary-publication',
        reason: 'the shared publication contract cannot depend on an implementation',
      },
      {
        module: 'sqlite-bounded-nonprojection-publication',
        reason: 'the shared publication contract cannot depend on an implementation',
      },
      {
        module: 'sqlite-bounded-continuation-artifact-materialization',
        reason: 'the shared publication contract cannot depend on an implementation',
      },
    ],
    forbiddenSpecifiers: [
      {
        specifier: 'node:sqlite',
        reason: 'the shared publication contract is database-agnostic',
      },
    ],
  },
  {
    source: 'sqlite-bounded-continuation-artifact-materialization.ts',
    forbidden: [
      {
        module: 'sqlite-run-store',
        reason: 'bounded continuation artifact materialization must use its narrow host port',
      },
      {
        module: 'sqlite-bounded-observer-boundary-publication',
        reason: 'artifact materialization must remain independent of publication coordination',
      },
      {
        module: 'sqlite-bounded-nonprojection-publication',
        reason: 'artifact materialization must remain independent of publication coordination',
      },
    ],
    forbiddenSpecifiers: [
      {
        specifier: 'node:sqlite',
        reason: 'database, transaction and statement ownership remain in the composing store',
      },
    ],
  },
  {
    source: 'evolution-artifacts/inquiry-opportunity-metrics.ts',
    forbidden: [
      {
        module: 'evolution-artifacts',
        reason: 'a report metric component must not depend back on the report facade',
      },
    ],
  },
];

const extractedPresentationDependencyRules = [
  {
    source: 'src/components/society-scene/decorLayer.ts',
    forbidden: 'src/components/SocietyScene3D.tsx',
    reason: 'the decor lifecycle component must not depend back on its scene facade',
  },
  {
    source: 'src/components/society-scene/figureLayer.ts',
    forbidden: 'src/components/SocietyScene3D.tsx',
    reason: 'the figure lifecycle component must not depend back on its scene facade',
  },
  {
    source: 'src/components/society-scene/figureVisuals.ts',
    forbidden: 'src/components/society-scene/figureLayer.ts',
    reason: 'figure resource construction must not depend back on the lifecycle component',
  },
  {
    source: 'src/components/society-scene/environmentRuntime.ts',
    forbidden: 'src/components/SocietyScene3D.tsx',
    reason: 'the environment runtime must not depend back on its scene facade',
  },
  {
    source: 'src/components/society-scene/cameraRuntime.ts',
    forbidden: 'src/components/SocietyScene3D.tsx',
    reason: 'the camera and input runtime must not depend back on its scene facade',
  },
  {
    source: 'src/components/society-scene/weatherRuntime.ts',
    forbidden: 'src/components/society-scene/environmentRuntime.ts',
    reason: 'the weather projection runtime must not depend back on its environment orchestrator',
  },
];

function collectSources(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) collectSources(candidate, output);
    else if (sourceExtensions.includes(path.extname(candidate))) output.push(candidate);
  }
  return output;
}

const sources = collectSources(moduleDirectory);
const serverSources = collectSources(serverDirectory);
const sourceSet = new Set(sources);
const serverSourceSet = new Set(serverSources);

function resolveInternalImport(fromFile, specifier) {
  let base;
  if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else if (specifier.startsWith('@/game/eland/')) {
    base = path.join(moduleDirectory, specifier.slice('@/game/eland/'.length));
  } else return null;

  return [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => path.join(base, `index${extension}`)),
  ].find((candidate) => sourceSet.has(candidate)) ?? null;
}

function moduleLayer(file) {
  const relative = path.relative(moduleDirectory, file);
  if (relative === path.join('application', 'monthly-simulation.ts')) return 'facade';
  const first = relative.split(path.sep)[0];
  if (['domain', 'world', 'application', 'projection'].includes(first)) return first;
  if (['population.ts', 'naming.ts', 'character-profiles.ts'].includes(relative)) return 'domain';
  return 'facade';
}

function importIsRuntime(node) {
  if (ts.isImportDeclaration(node)) {
    if (!node.importClause) return true;
    if (node.importClause.isTypeOnly) return false;
    const bindings = node.importClause.namedBindings;
    return Boolean(node.importClause.name)
      || !bindings
      || !ts.isNamedImports(bindings)
      || bindings.elements.some((element) => !element.isTypeOnly);
  }
  if (!ts.isExportDeclaration(node) || node.isTypeOnly) return false;
  return !node.exportClause
    || !ts.isNamedExports(node.exportClause)
    || node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function runtimeRelativeModuleSpecifiers(sourceFile) {
  const specifiers = [];

  function add(moduleSpecifier) {
    if (moduleSpecifier
      && ts.isStringLiteralLike(moduleSpecifier)
      && moduleSpecifier.text.startsWith('.')) specifiers.push(moduleSpecifier.text);
  }

  function visitRuntimeReference(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (importIsRuntime(node)) add(node.moduleSpecifier);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        add(node.moduleReference.expression);
      }
      return;
    }
    if (ts.isImportTypeNode(node)) return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0]);
      return;
    }
    ts.forEachChild(node, visitRuntimeReference);
  }

  visitRuntimeReference(sourceFile);
  return specifiers;
}

function resolveServerRuntimeImport(fromFile, specifier) {
  const rawBase = path.resolve(path.dirname(fromFile), specifier);
  if (rawBase !== serverDirectory && !rawBase.startsWith(`${serverDirectory}${path.sep}`)) return null;
  const base = rawBase.replace(/\.(?:[cm]?[jt]sx?)$/u, '');
  return [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => path.join(base, `index${extension}`)),
  ].find((candidate) => serverSourceSet.has(candidate)) ?? null;
}

function stronglyConnectedComponents(dependencyGraph) {
  let nextComponentIndex = 0;
  const componentIndices = new Map();
  const componentLowLinks = new Map();
  const componentStack = [];
  const componentStackMembers = new Set();
  const components = [];

  function visitComponent(source) {
    componentIndices.set(source, nextComponentIndex);
    componentLowLinks.set(source, nextComponentIndex);
    nextComponentIndex += 1;
    componentStack.push(source);
    componentStackMembers.add(source);

    for (const target of dependencyGraph.get(source) ?? []) {
      if (!componentIndices.has(target)) {
        visitComponent(target);
        componentLowLinks.set(source, Math.min(componentLowLinks.get(source), componentLowLinks.get(target)));
      } else if (componentStackMembers.has(target)) {
        componentLowLinks.set(source, Math.min(componentLowLinks.get(source), componentIndices.get(target)));
      }
    }

    if (componentLowLinks.get(source) !== componentIndices.get(source)) return;
    const component = [];
    let member;
    do {
      member = componentStack.pop();
      componentStackMembers.delete(member);
      component.push(member);
    } while (member !== source);
    components.push(component);
  }

  for (const source of dependencyGraph.keys()) {
    if (!componentIndices.has(source)) visitComponent(source);
  }
  return components;
}

function dependencyCyclePath(component, dependencyGraph) {
  if (component.length === 1) return [component[0], component[0]];
  const members = new Set(component);
  const visited = new Set();
  const activePathIndex = new Map();
  const activePath = [];

  function findCycle(source) {
    visited.add(source);
    activePathIndex.set(source, activePath.length);
    activePath.push(source);
    const targets = [...(dependencyGraph.get(source) ?? [])]
      .filter((target) => members.has(target))
      .sort();
    for (const target of targets) {
      const cycleStart = activePathIndex.get(target);
      if (cycleStart !== undefined) return [...activePath.slice(cycleStart), target];
      if (!visited.has(target)) {
        const cycle = findCycle(target);
        if (cycle) return cycle;
      }
    }
    activePath.pop();
    activePathIndex.delete(source);
    return null;
  }

  for (const source of [...component].sort()) {
    if (visited.has(source)) continue;
    const cycle = findCycle(source);
    if (cycle) return cycle;
  }
  return [...component, component[0]];
}

function moduleReferences(sourceFile) {
  const references = [];

  function add(moduleSpecifier, kind) {
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      references.push({ specifier: moduleSpecifier.text, kind });
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, node.importClause?.isTypeOnly ? 'type import' : 'import');
      return;
    }
    if (ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, node.isTypeOnly ? 'type export' : 'export');
      return;
    }
    if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, 'import assignment');
      return;
    }
    if (ts.isImportTypeNode(node)) {
      const argument = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      add(argument, 'import type expression');
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0], 'dynamic import');
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function normalizeRelativeModule(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  return path.resolve(path.dirname(fromFile), specifier)
    .replace(/\.(?:[cm]?[jt]sx?)$/u, '');
}

const observationBoundarySources = new Set([
  'application/simulation/month-boundary.ts',
  'application/simulation/observation-state.ts',
  'application/simulation/state-lifecycle.ts',
]);

const extractedInternalDependencyRules = new Map([
  [
    'application/action-failure-retry.ts=>application/action-options.ts',
    'failure retry policy must not depend back on the action option facade',
  ],
  [
    'application/reproduction-options.ts=>application/action-options.ts',
    'reproduction option production must not depend back on the action option facade',
  ],
  [
    'domain/actions/attend-actions.ts=>domain/action-executor.ts',
    'the attend action component must not depend back on its executor facade',
  ],
  [
    'domain/project-leadership-index.ts=>domain/state-index.ts',
    'the focused project leadership index must not depend back on the aggregate index facade',
  ],
  [
    'application/projects/project-material-requirement.ts=>application/projects/project-step-compiler.ts',
    'material requirement solving must not depend back on the project step facade',
  ],
  [
    'voxel-assets/surface-decoration.ts=>voxelKits.ts',
    'surface decoration must not depend back on the voxel kit facade',
  ],
]);

function isDecisionConsumptionSource(source) {
  const relative = path.relative(moduleDirectory, source).split(path.sep).join('/');
  if (!relative.startsWith('application/')) return false;
  return !observationBoundarySources.has(relative);
}

function staticPropertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)
    && node.argumentExpression
    && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

function forbiddenDecisionObservationField(node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null;
  const property = staticPropertyName(node);
  if (property === 'derived') return 'derived';
  if (!['stage', 'civilizationIndex', 'development'].includes(property)) return null;
  return staticPropertyName(node.expression) === 'civilization'
    ? `civilization.${property}`
    : null;
}

function bindingElementPropertyName(element) {
  if (element.propertyName) {
    if (ts.isIdentifier(element.propertyName)
      || ts.isStringLiteralLike(element.propertyName)) return element.propertyName.text;
    if (ts.isComputedPropertyName(element.propertyName)
      && ts.isStringLiteralLike(element.propertyName.expression)) return element.propertyName.expression.text;
    return null;
  }
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

function unwrappedExpression(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current))) current = current.expression;
  return current;
}

function rootBindingInitializer(pattern) {
  const parent = pattern.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === pattern) {
    return parent.initializer;
  }
  return null;
}

function bindingPatternPrefix(pattern) {
  const reversed = [];
  let current = pattern;
  while (ts.isBindingElement(current.parent) && current.parent.name === current) {
    const property = bindingElementPropertyName(current.parent);
    if (!property || !ts.isObjectBindingPattern(current.parent.parent)) return null;
    reversed.push(property);
    current = current.parent.parent;
  }
  const prefix = reversed.reverse();
  const initializer = rootBindingInitializer(current);
  const source = initializer ? unwrappedExpression(initializer) : null;
  if (source && staticPropertyName(source) === 'civilization') prefix.unshift('civilization');
  return prefix;
}

function forbiddenDecisionObservationBindings(pattern) {
  const prefix = bindingPatternPrefix(pattern);
  if (!prefix) return [];
  return pattern.elements.flatMap((element) => {
    const property = bindingElementPropertyName(element);
    if (!property) return [];
    const path = [...prefix, property].join('.');
    return path === 'derived'
      || path === 'civilization.stage'
      || path === 'civilization.civilizationIndex'
      || path === 'civilization.development'
      ? [path]
      : [];
  });
}

function typeMentionsSimulationState(node) {
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName;
    if (ts.isIdentifier(name) && name.text === 'SimulationState') return true;
    if (ts.isQualifiedName(name) && name.right.text === 'SimulationState') return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && typeMentionsSimulationState(child)) found = true;
  });
  return found;
}

function isDecisionStateTypeEscape(node) {
  return (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
    && typeMentionsSimulationState(node.type);
}

function typeMentionsObservationWorkState(node) {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
    && ['SimulationState', 'SimulationAuthorityState', 'SimulationObservationState']
      .includes(node.typeName.text)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && typeMentionsObservationWorkState(child)) found = true;
  });
  return found;
}

function isObservationAdapterStateEscape(node) {
  return (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
    && typeMentionsObservationWorkState(node.type);
}

const graph = new Map(sources.map((source) => [source, new Set()]));
const violations = [];
const forbiddenLayerEdges = new Set([
  'domain->application',
  'domain->projection',
  'world->application',
  'world->projection',
  'application->projection',
  'projection->application',
  'domain->facade',
  'world->facade',
  'application->facade',
  'projection->facade',
]);
const forbiddenKernelPackages = /^(?:react(?:\/|$)|three(?:\/|$)|node:https?$|https?$)/u;

for (const source of sources) {
  const text = fs.readFileSync(source, 'utf8');
  const sourceFile = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
  const fromLayer = moduleLayer(source);
  const fromLabel = path.relative(moduleDirectory, source);

  for (const statement of sourceFile.statements) {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
      || !statement.moduleSpecifier
      || !ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const specifier = statement.moduleSpecifier.text;
    if (['domain', 'world'].includes(fromLayer) && forbiddenKernelPackages.test(specifier)) {
      violations.push(`${fromLabel} imports forbidden kernel dependency ${specifier}`);
    }
    const target = resolveInternalImport(source, specifier);
    if (!target) continue;
    const targetLabel = path.relative(moduleDirectory, target).split(path.sep).join('/');
    const extractedDependencyReason = extractedInternalDependencyRules.get(
      `${fromLabel.split(path.sep).join('/')}=>${targetLabel}`,
    );
    if (extractedDependencyReason) {
      violations.push(
        `${fromLabel} depends back on ${targetLabel}: ${extractedDependencyReason}`,
      );
    }
    if (!importIsRuntime(statement)) continue;

    graph.get(source).add(target);
    const edge = `${fromLayer}->${moduleLayer(target)}`;
    if (forbiddenLayerEdges.has(edge)) {
      violations.push(`${fromLabel} has forbidden runtime edge ${edge} to ${path.relative(moduleDirectory, target)}`);
    }
  }
}

const serverRuntimeGraph = new Map(serverSources.map((source) => [source, new Set()]));
for (const source of serverSources) {
  const sourceFile = ts.createSourceFile(
    source,
    fs.readFileSync(source, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const specifier of runtimeRelativeModuleSpecifiers(sourceFile)) {
    const target = resolveServerRuntimeImport(source, specifier);
    if (target) serverRuntimeGraph.get(source).add(target);
  }
}
const serverRuntimeEdgeCount = [...serverRuntimeGraph.values()]
  .reduce((count, targets) => count + targets.size, 0);
const serverRuntimeComponents = stronglyConnectedComponents(serverRuntimeGraph);
for (const component of serverRuntimeComponents) {
  const selfCycle = component.length === 1
    && serverRuntimeGraph.get(component[0]).has(component[0]);
  if (component.length === 1 && !selfCycle) continue;
  const cycle = dependencyCyclePath(component, serverRuntimeGraph)
    .map((file) => path.relative(serverDirectory, file).split(path.sep).join('/'));
  violations.push(`server runtime dependency cycle: ${cycle.join(' -> ')}`);
}

for (const rule of serverDependencyRules) {
  const source = path.join(serverDirectory, rule.source);
  const sourceLabel = path.relative(projectDirectory, source);
  if (!fs.existsSync(source)) {
    violations.push(`${sourceLabel} is missing; update its server dependency rule explicitly`);
    continue;
  }

  const sourceFile = ts.createSourceFile(
    source,
    fs.readFileSync(source, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const forbiddenByTarget = new Map((rule.forbidden ?? []).map((entry) => [
    path.join(serverDirectory, entry.module),
    entry.reason,
  ]));
  const forbiddenRuntimeByTarget = new Map((rule.forbiddenRuntime ?? []).map((entry) => [
    path.join(serverDirectory, entry.module),
    entry.reason,
  ]));
  const forbiddenBySpecifier = new Map((rule.forbiddenSpecifiers ?? []).map((entry) => [
    entry.specifier,
    entry.reason,
  ]));

  for (const reference of moduleReferences(sourceFile)) {
    const specifierReason = forbiddenBySpecifier.get(reference.specifier);
    if (specifierReason) {
      violations.push(
        `${sourceLabel} has forbidden ${reference.kind} of ${reference.specifier}: ${specifierReason}`,
      );
    }
    const target = normalizeRelativeModule(source, reference.specifier);
    const reason = target && forbiddenByTarget.get(target);
    if (reason) {
      violations.push(
        `${sourceLabel} has forbidden ${reference.kind} of ${reference.specifier}: ${reason}`,
      );
    }
    const runtimeReason = target && forbiddenRuntimeByTarget.get(target);
    if (runtimeReason && !reference.kind.startsWith('type ')) {
      violations.push(
        `${sourceLabel} has forbidden runtime ${reference.kind} of ${reference.specifier}: ${runtimeReason}`,
      );
    }
  }

  for (const bindingRule of rule.forbiddenNamedImports ?? []) {
    const forbiddenTarget = path.join(serverDirectory, bindingRule.module);
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)
        || !ts.isStringLiteral(statement.moduleSpecifier)
        || normalizeRelativeModule(source, statement.moduleSpecifier.text) !== forbiddenTarget
        || !statement.importClause?.namedBindings
        || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
      for (const binding of statement.importClause.namedBindings.elements) {
        const importedName = (binding.propertyName ?? binding.name).text;
        if (!bindingRule.names.includes(importedName)) continue;
        violations.push(
          `${sourceLabel} imports forbidden ${importedName} from ${statement.moduleSpecifier.text}: ${bindingRule.reason}`,
        );
      }
    }
  }
}

// Server adapters may consume the stable product facade, the explicit
// infrastructure capability entry, and domain/projection contracts. They must
// not bind directly to arbitrary application implementation paths.
const applicationDirectory = path.join(moduleDirectory, 'application');
for (const source of serverSources) {
  const sourceFile = ts.createSourceFile(
    source,
    fs.readFileSync(source, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const reference of moduleReferences(sourceFile)) {
    const target = normalizeRelativeModule(source, reference.specifier);
    if (!target || (target !== applicationDirectory
      && !target.startsWith(`${applicationDirectory}${path.sep}`))) continue;
    violations.push(
      `${path.relative(projectDirectory, source)} has forbidden ${reference.kind}`
      + ` of private application path ${reference.specifier}; use simulation.ts or infrastructure-api.ts`,
    );
  }
}

for (const rule of extractedPresentationDependencyRules) {
  const source = path.join(projectDirectory, rule.source);
  const sourceLabel = path.relative(projectDirectory, source);
  if (!fs.existsSync(source)) {
    violations.push(`${sourceLabel} is missing; update its presentation dependency rule explicitly`);
    continue;
  }
  const forbiddenTarget = path.join(projectDirectory, rule.forbidden)
    .replace(/\.(?:[cm]?[jt]sx?)$/u, '');
  const sourceFile = ts.createSourceFile(
    source,
    fs.readFileSync(source, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const reference of moduleReferences(sourceFile)) {
    if (normalizeRelativeModule(source, reference.specifier) !== forbiddenTarget) continue;
    violations.push(
      `${sourceLabel} depends back on ${rule.forbidden}: ${rule.reason}`,
    );
  }
}

const decisionConsumptionSources = sources.filter(isDecisionConsumptionSource);
for (const source of decisionConsumptionSources) {
  const sourceFile = ts.createSourceFile(
    source,
    fs.readFileSync(source, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const sourceLabel = path.relative(moduleDirectory, source);
  function visit(node) {
    const forbiddenField = forbiddenDecisionObservationField(node);
    if (forbiddenField) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push(
        `${sourceLabel}:${position.line + 1}:${position.character + 1} reads observer-owned ${forbiddenField}`,
      );
    }
    if (ts.isObjectBindingPattern(node)) {
      for (const field of forbiddenDecisionObservationBindings(node)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(
          `${sourceLabel}:${position.line + 1}:${position.character + 1} destructures observer-owned ${field}`,
        );
      }
    }
    if (isDecisionStateTypeEscape(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push(
        `${sourceLabel}:${position.line + 1}:${position.character + 1} bypasses decision authority with a SimulationState assertion`,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

const observationAdapterSource = path.join(
  moduleDirectory,
  'projection/simulation-observation-projector.ts',
);
if (!fs.existsSync(observationAdapterSource)) {
  violations.push('projection/simulation-observation-projector.ts is missing');
} else {
  const sourceFile = ts.createSourceFile(
    observationAdapterSource,
    fs.readFileSync(observationAdapterSource, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  function visitObservationAdapter(node) {
    if (isObservationAdapterStateEscape(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push(
        `projection/simulation-observation-projector.ts:${position.line + 1}`
        + `:${position.character + 1} asserts a shared snapshot into writable observer state`,
      );
    }
    ts.forEachChild(node, visitObservationAdapter);
  }
  visitObservationAdapter(sourceFile);
}

let nextIndex = 0;
const indices = new Map();
const lowLinks = new Map();
const stack = [];
const onStack = new Set();

function visit(source) {
  indices.set(source, nextIndex);
  lowLinks.set(source, nextIndex);
  nextIndex += 1;
  stack.push(source);
  onStack.add(source);

  for (const target of graph.get(source)) {
    if (!indices.has(target)) {
      visit(target);
      lowLinks.set(source, Math.min(lowLinks.get(source), lowLinks.get(target)));
    } else if (onStack.has(target)) {
      lowLinks.set(source, Math.min(lowLinks.get(source), indices.get(target)));
    }
  }

  if (lowLinks.get(source) !== indices.get(source)) return;
  const component = [];
  let member;
  do {
    member = stack.pop();
    onStack.delete(member);
    component.push(member);
  } while (member !== source);

  const selfCycle = component.length === 1 && graph.get(component[0]).has(component[0]);
  if (component.length > 1 || selfCycle) {
    violations.push(`runtime dependency cycle: ${component
      .map((file) => path.relative(moduleDirectory, file))
      .sort()
      .join(' -> ')}`);
  }
}

for (const source of sources) {
  if (!indices.has(source)) visit(source);
}

if (violations.length) {
  console.error(`ELAND architecture boundary check failed (${violations.length}):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    `ELAND architecture boundary check passed for ${sources.length} simulation source files, ${decisionConsumptionSources.length} decision-consumption files, ${extractedInternalDependencyRules.size} internal seams, ${extractedPresentationDependencyRules.length} presentation seams, ${serverSources.length} server sources without private application imports, ${serverRuntimeEdgeCount} server runtime edges across ${serverRuntimeComponents.length} SCCs, and ${serverDependencyRules.length} protected server files.`,
  );
}
