export type ComponentKind = "foundation" | "support" | "floor" | "wall" | "roof" | "opening";

export interface StructureEffects {
  structuralStability: number;
  weatherProtection: number;
  thermalInsulation: number;
  enclosure: number;
  capacity: number;
  accessible: boolean;
}

export const SHELTER_BLUEPRINT: ReadonlyArray<{ kind: ComponentKind; dx: number; dy: number }> = [
  { kind: "foundation", dx: 0, dy: 0 },
  { kind: "support", dx: 0, dy: 0 },
  { kind: "support", dx: 1, dy: 0 },
  { kind: "wall", dx: 0, dy: 1 },
  { kind: "opening", dx: 0, dy: 0 },
  { kind: "roof", dx: 0, dy: 0 },
  { kind: "roof", dx: 1, dy: 0 },
];

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function evaluateStructure(components: ReadonlyArray<{ kind: ComponentKind; cellId: number }>): {
  effects: StructureEffects;
  occupiedCells: number[];
  interiorCells: number[];
} {
  const supports = components.filter((component) => component.kind === "support").length;
  const walls = components.filter((component) => component.kind === "wall").length;
  const roofs = components.filter((component) => component.kind === "roof").length;
  const openings = components.filter((component) => component.kind === "opening").length;
  const occupiedCells = [...new Set(components.map((component) => component.cellId))];
  const interiorCells = roofs >= 2 && supports >= 2 ? occupiedCells.slice(0, 2) : [];
  const structuralStability = clamp(supports * 28 + Number(components.some((component) => component.kind === "foundation")) * 20);
  const enclosure = clamp(walls * 27 + openings * 8);
  const weatherProtection = clamp(roofs * 28 + structuralStability * 0.32 + enclosure * 0.18);
  return {
    occupiedCells,
    interiorCells,
    effects: {
      structuralStability,
      enclosure,
      weatherProtection,
      thermalInsulation: clamp(walls * 18 + roofs * 12),
      capacity: interiorCells.length,
      accessible: interiorCells.length > 0 && openings >= 1 && weatherProtection >= 58,
    },
  };
}
