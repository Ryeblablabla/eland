import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '../../three-body/node_modules/typescript/lib/typescript.js';

const labDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(labDir, '..');
const materialPath = 'three-body/src/game/eland/domain/material.ts';
const rulePath = 'three-body/src/game/eland/domain/interaction-rules.ts';

const [materialSource, ruleSource] = await Promise.all([
  readFile(resolve(repoDir, materialPath), 'utf8'),
  readFile(resolve(repoDir, rulePath), 'utf8'),
]);

function parse(source, path) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function variableInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }
  throw new Error(`Missing ${name} in ${sourceFile.fileName}`);
}

function unwrap(node) {
  let current = node;
  while (ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isTypeAssertionExpression(current)) current = current.expression;
  return current;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  throw new Error(`Unsupported property name: ${node.getText()}`);
}

function evaluate(node, scope = {}) {
  const value = unwrap(node);
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken) return -evaluate(value.operand, scope);
  if (ts.isArrayLiteralExpression(value)) return value.elements.map((item) => evaluate(item, scope));
  if (ts.isObjectLiteralExpression(value)) {
    return Object.fromEntries(value.properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) throw new Error(`Unsupported object member: ${property.getText()}`);
      return [propertyName(property.name), evaluate(property.initializer, scope)];
    }));
  }
  if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) {
    const target = scope[value.expression.text];
    if (target && Object.hasOwn(target, value.name.text)) return target[value.name.text];
  }
  throw new Error(`Unsupported expression in recipe sync: ${value.getText()}`);
}

const materialFile = parse(materialSource, materialPath);
const ruleFile = parse(ruleSource, rulePath);
const Material = evaluate(variableInitializer(materialFile, 'Material'));
const materials = evaluate(variableInitializer(materialFile, 'MATERIAL_PALETTE'), { Material });
const materialsById = new Map(materials.map((material) => [material.id, material]));

function materialRef(materialId, quantity = 1) {
  const material = materialsById.get(materialId);
  if (!material) throw new Error(`Unknown material id ${materialId}`);
  return {
    materialId,
    key: material.key,
    name: material.name,
    quantity,
    color: material.color,
    tags: material.tags,
  };
}

const combinations = evaluate(variableInitializer(ruleFile, 'INVENTORY_COMBINATIONS'), { Material });
const exertions = evaluate(variableInitializer(ruleFile, 'EXERTION_RULES'), { Material });
const exposures = evaluate(variableInitializer(ruleFile, 'EXPOSURE_RULES'), { Material });

const recipes = [
  ...combinations.map((rule) => ({
    id: rule.id,
    type: 'combine',
    inputs: rule.inputs.map((input) => materialRef(input.materialId, input.quantity)),
    tools: [],
    targets: [],
    output: materialRef(rule.output.materialId, rule.output.quantity),
  })),
  ...exertions.map((rule) => ({
    id: rule.id,
    type: 'exert',
    inputs: [materialRef(rule.inputMaterialId)],
    tools: [materialRef(rule.toolMaterialId)],
    targets: [materialRef(rule.targetMaterialId)],
    output: materialRef(rule.outputMaterialId),
    outputLocation: rule.outputLocation,
    outputPlacement: rule.outputPlacement ?? null,
  })),
  ...exposures.map((rule) => ({
    id: rule.id,
    type: 'expose',
    inputs: [materialRef(rule.inputMaterialId)],
    tools: [],
    targets: [materialRef(rule.targetMaterialId)],
    output: materialRef(rule.outputMaterialId),
  })),
];

const payload = {
  generatedFrom: [materialPath, rulePath],
  materials,
  recipes,
  counts: {
    materials: materials.length,
    recipes: recipes.length,
    combine: combinations.length,
    exert: exertions.length,
    expose: exposures.length,
  },
};

const banner = '// Generated by npm run sync:recipes. Edit the domain sources, not this file.\n';
await writeFile(
  resolve(labDir, 'recipes-data.js'),
  `${banner}export const RECIPE_KNOWLEDGE = ${JSON.stringify(payload, null, 2)};\n`,
  'utf8',
);

console.log(`Synced ${recipes.length} recipes and ${materials.length} materials into recipes-data.js`);
