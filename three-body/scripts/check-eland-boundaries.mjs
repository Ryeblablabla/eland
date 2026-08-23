import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleDirectory = path.join(projectDirectory, 'src/game/eland');
const sourceExtensions = ['.ts', '.tsx'];

function collectSources(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) collectSources(candidate, output);
    else if (sourceExtensions.includes(path.extname(candidate))) output.push(candidate);
  }
  return output;
}

const sources = collectSources(moduleDirectory);
const sourceSet = new Set(sources);

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
  return ts.isExportDeclaration(node) && !node.isTypeOnly;
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
    if (!importIsRuntime(statement)) continue;

    const target = resolveInternalImport(source, specifier);
    if (!target) continue;
    graph.get(source).add(target);
    const edge = `${fromLayer}->${moduleLayer(target)}`;
    if (forbiddenLayerEdges.has(edge)) {
      violations.push(`${fromLabel} has forbidden runtime edge ${edge} to ${path.relative(moduleDirectory, target)}`);
    }
  }
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
  console.log(`ELAND architecture boundary check passed for ${sources.length} source files.`);
}
