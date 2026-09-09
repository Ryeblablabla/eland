import type { ActionOption, FactPredicate, SourceOperation, VoxelPosition, WorldRef } from './action';
import type { MaterialId } from './material';
import type { ProjectFunction } from './project';
import type { NativeSpeechOperationRequest } from './native-speech';
import type { WorkArrangement } from './works';
import type { WorkLayout } from './work-layout';

/** Actual domain entities and experienced facts, never an option-menu identifier.
 * For move, references explain the intention only; they do not authorize another procedure.
 */
export interface NativeOperationReferences {
  projectId?: string;
  recordId?: string;
  knowledgeId?: string;
  techniqueId?: string;
  agreementId?: string;
  sourceEventIds?: string[];
}

interface NativeOperationBasis {
  /** Server-owned exact complete-capability identity; never provider-authored. */
  methodKey?: string;
  /** Server-bound complete capability sources, selected through use-method. */
  references?: NativeOperationReferences;
  /** Known context only; never selects a procedure or grants authorization. */
  backgroundReferences?: NativeOperationReferences;
  /** Server-owned observation scope; never accepted as a provider argument. */
  perceptionOnly?: true;
  /** Optional explicit desired state; matched capabilities retain their own real goal. */
  goal?: FactPredicate;
}

export type NativeOperationRequest = NativeOperationBasis & (
  | { kind: 'move'; target: WorldRef; withinDistance?: number }
  | { kind: 'observe'; target: WorldRef; instrument?: WorldRef }
  | { kind: 'transfer'; source: WorldRef; destination: WorldRef; quantity: number; materialId?: MaterialId; container?: WorldRef; sourceStackId?: string }
  | { kind: 'assemble'; target: Extract<WorldRef, { kind: 'voxel' | 'work' }>;
      inputs: Array<{ target: Extract<WorldRef, { kind: 'inventory-stack' }>; quantity: number }>;
      arrangement?: WorkArrangement; layout?: WorkLayout; summary?: string }
  | { kind: 'act'; operation: SourceOperation; targets: WorldRef[]; tool?: WorldRef }
  | { kind: 'inscribe'; carrier: WorldRef; knowledgeId?: string; codebookId?: string; text?: string }
  | { kind: 'project'; projectId?: string; desiredFunction?: ProjectFunction; site?: VoxelPosition }
  | NativeSpeechOperationRequest
);

export interface NativeOperationDescriptor {
  request: NativeOperationRequest;
  summary: string;
  reason: string;
  sourceEventIds: string[];
  methodKey?: string;
  requiresMethod?: boolean;
}

/** Stable semantic key; callers supply capability meaning, not transient ids. */
export function nativeMethodKey(value: unknown): string {
  const stable = (item: unknown): string => Array.isArray(item) ? `[${item.map(stable).join(',')}]`
    : item && typeof item === 'object' ? `{${Object.entries(item).filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${JSON.stringify(key)}:${stable(value)}`).join(',')}}` : JSON.stringify(item);
  const source = stable(value);
  let hash = 14695981039346656037n;
  for (let index = 0; index < source.length; index++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(source.charCodeAt(index))) * 1099511628211n);
  }
  return `method_${hash.toString(36)}`;
}

export interface NativeOperationCompilationProblem {
  code: 'unknown-reference' | 'ambiguous-operation' | 'missing-evidence' | 'invalid-operation' | 'context-association' | 'spatial-translation';
  message: string;
  fields?: string[];
  candidates?: NativeOperationDescriptor[];
}

export type NativeOperationCompilation =
  | { ok: true; option: ActionOption; feedback?: NativeOperationCompilationProblem }
  | { ok: false; problem: NativeOperationCompilationProblem };
