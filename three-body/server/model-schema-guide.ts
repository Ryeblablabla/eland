export interface ModelSchemaGuide {
  schema: Record<string, unknown>;
  enumDictionary: Record<string, unknown[]>;
}

const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaChildren = new Set(['items', 'additionalItems', 'contains', 'additionalProperties',
  'unevaluatedItems', 'unevaluatedProperties', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']);

/** Traverse schema nodes, leaving literal values in enum/default/const/examples intact. */
function mapSchema(value: unknown, transform: (node: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const node = Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (schemaMaps.has(key) || key === 'dependencies') {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        return [key, Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, mapSchema(schema, transform)]))];
      }
    } else if (schemaArrays.has(key) || schemaChildren.has(key)) {
      return [key, Array.isArray(child) ? child.map((schema) => mapSchema(schema, transform)) : mapSchema(child, transform)];
    }
    return [key, child];
  }));
  return transform(node);
}

/** A reading aid only: the provider still receives the untouched machine schema. */
export function buildModelSchemaGuide(schema: Record<string, unknown>): ModelSchemaGuide {
  const lists = new Map<string, { values: unknown[]; count: number }>();
  const reservedRefs = new Set<string>();
  mapSchema(schema, (node) => {
    if (typeof node.enumRef === 'string') reservedRefs.add(node.enumRef);
    if (Array.isArray(node.enum) && !('enumRef' in node)) {
      const key = JSON.stringify(node.enum);
      // Short enums are clearer inline; only repeated long lists are factored out.
      if (key.length >= 96) {
        const existing = lists.get(key);
        if (existing) existing.count++;
        else lists.set(key, { values: node.enum, count: 1 });
      }
    }
    return node;
  });
  const enumDictionary: Record<string, unknown[]> = {};
  const refs = new Map<string, string>();
  let nextRef = 1;
  for (const [key, list] of lists) {
    if (list.count < 2) continue;
    let ref: string;
    do { ref = `enum${nextRef++}`; } while (reservedRefs.has(ref));
    enumDictionary[ref] = list.values;
    refs.set(key, ref);
  }
  const compact = mapSchema(schema, (node) => {
    const ref = Array.isArray(node.enum) && !('enumRef' in node) ? refs.get(JSON.stringify(node.enum)) : undefined;
    return ref ? Object.fromEntries(Object.entries(node).map(([key, value]) => key === 'enum' ? ['enumRef', ref] : [key, value])) : node;
  }) as Record<string, unknown>;
  return { schema: compact, enumDictionary };
}

export function expandModelSchemaGuide(guide: ModelSchemaGuide): Record<string, unknown> {
  return mapSchema(guide.schema, (node) => {
    const values = typeof node.enumRef === 'string' && Object.hasOwn(guide.enumDictionary, node.enumRef)
      ? guide.enumDictionary[node.enumRef] : undefined;
    return values ? Object.fromEntries(Object.entries(node).map(([key, value]) => key === 'enumRef' ? ['enum', values] : [key, value])) : node;
  }) as Record<string, unknown>;
}

export function modelSchemaGuideText(schema: Record<string, unknown>): string {
  const guide = buildModelSchemaGuide(schema);
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const render = (value: unknown): string => {
    if (value === true) return '任意JSON值';
    if (value === false) return '不允许';
    const node = record(value);
    const required = Array.isArray(node.required) ? node.required.filter((key): key is string => typeof key === 'string') : [];
    const properties = record(node.properties);
    const parts: string[] = [];
    if (typeof node.$ref === 'string') parts.push(node.$ref.replace('#/$defs/', '$'));
    if (typeof node.enumRef === 'string') parts.push(`@${node.enumRef}`);
    if (Array.isArray(node.enum)) parts.push(node.enum.map((item) => JSON.stringify(item)).join(' | '));
    if ('const' in node) parts.push(JSON.stringify(node.const));
    if (node.type === 'object' || Object.keys(properties).length) {
      const constraintsOnly = node.type !== 'object';
      const fields = Object.entries(properties).map(([key, child]) => `${key}${constraintsOnly || required.includes(key) ? '' : '?'}: ${render(child)}`);
      if (node.additionalProperties === true) fields.push('[其他字段]: 任意JSON值');
      else if (node.additionalProperties && typeof node.additionalProperties === 'object') fields.push(`[其他字段]: ${render(node.additionalProperties)}`);
      parts.push(`${constraintsOnly ? '已有字段的附加约束（不改变外层必填）' : ''}{ ${fields.join('; ')} }`);
    } else if (node.type === 'array' || node.items || node.prefixItems) {
      const items = Array.isArray(node.prefixItems)
        ? node.prefixItems.map(render).join(', ') : render(node.items ?? true);
      parts.push(`[${items}]`);
    } else if (node.type && !parts.length) parts.push(Array.isArray(node.type) ? node.type.join(' | ') : String(node.type));
    const extraRequired = required.filter((key) => !(key in properties));
    if (extraRequired.length) parts.push(`必须含字段(${extraRequired.join(', ')})`);
    for (const [key, meaning] of [['oneOf', '恰选一种'], ['anyOf', '至少满足一种'], ['allOf', '同时满足']] as const) {
      if (Array.isArray(node[key])) parts.push(`${meaning}(${node[key].map(render).join(' / ')})`);
    }
    if (node.contains) parts.push(`必须含元素(${render(node.contains)})`);
    if (node.not) parts.push(`不能满足(${render(node.not)})`);
    if (node.if) parts.push(`若(${render(node.if)})则(${render(node.then ?? true)})否则(${render(node.else ?? true)})`);
    const limits = [['minimum', '值≥'], ['maximum', '值≤'], ['minItems', '项数≥'], ['maxItems', '项数≤'],
      ['minLength', '字数≥'], ['maxLength', '字数≤'], ['minContains', '匹配项≥'], ['maxContains', '匹配项≤']] as const;
    for (const [key, meaning] of limits) if (typeof node[key] === 'number') parts.push(`${meaning}${node[key]}`);
    if (node.uniqueItems) parts.push('元素不重复');
    if (typeof node.pattern === 'string') parts.push(`匹配${JSON.stringify(node.pattern)}`);
    if (typeof node.description === 'string') parts.push(`说明：${node.description}`);
    return parts.join('；') || '任意JSON值';
  };
  const definitions = Object.entries(record(guide.schema.$defs)).map(([name, value]) => `$${name} = ${render(value)}`);
  const dictionary = Object.entries(guide.enumDictionary).map(([name, values]) => `@${name} = ${JSON.stringify(values)}`);
  return '输出格式说明。只输出JSON，不输出下面的类型标记。字段后的?表示可省略；未标?的字段必须填写。未列出的字段不要补写。$名称引用下方定义，@名称引用完整可用值；这些格式规则不替人物选择行动，也不改变世界事实。机器format仍使用原始完整JSON Schema。'
    + `\n输出：${render(guide.schema)}`
    + (definitions.length ? `\n${definitions.join('\n')}` : '')
    + (dictionary.length ? `\n${dictionary.join('\n')}` : '');
}
