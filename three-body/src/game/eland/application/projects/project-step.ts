import type { PrimitiveAction, WorldRef } from '../../domain/action';
import type { MaterialId } from '../../domain/material';
import type {
  ProjectMaterialDemand,
  ProjectReservation,
} from '../../domain/project';

export interface ProjectStep {
  key: string;
  summary: string;
  reason: string;
  action: PrimitiveAction;
  target?: WorldRef;
  sourceFactIds: string[];
  missingMaterialIds: MaterialId[];
  reservations: ProjectReservation[];
  planKnowledgeId?: string;
  materialDemands?: ProjectMaterialDemand[];
}
