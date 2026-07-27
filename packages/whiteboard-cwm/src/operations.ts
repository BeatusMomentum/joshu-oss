import type {
  CwmFocus,
  CwmMode,
  CwmObject,
  CwmOpeningBrief,
  CwmRegion,
  CwmRelation,
  CwmSceneBinding,
  CwmSemanticOperation,
  CwmWorkspace,
} from "./types.js";

export interface CreateWorkspaceInput {
  readonly id: string;
  readonly mode?: CwmMode;
}

/** Create an empty materialized workspace without introducing clocks or random IDs. */
export function createEmptyWorkspace(input: CreateWorkspaceInput): CwmWorkspace {
  return {
    schemaVersion: 1,
    id: input.id,
    mode: input.mode ?? "ORIENT",
    objects: {},
    relations: {},
    regions: {},
    proposals: {},
    focus: null,
    openingBrief: null,
    headSequence: 0,
  };
}

export function upsertObject(workspace: CwmWorkspace, object: CwmObject): CwmWorkspace {
  return {
    ...workspace,
    objects: { ...workspace.objects, [object.id]: object },
  };
}

/**
 * Remove an object and all references that would otherwise dangle. Inverse derivation captures
 * those related records before calling this helper.
 */
export function removeObject(workspace: CwmWorkspace, objectId: string): CwmWorkspace {
  if (!(objectId in workspace.objects)) return workspace;

  const { [objectId]: _removed, ...objects } = workspace.objects;
  const relations = Object.fromEntries(
    Object.entries(workspace.relations).filter(
      ([, relation]) =>
        !(relation.source.kind === "OBJECT" && relation.source.id === objectId) &&
        !(relation.target.kind === "OBJECT" && relation.target.id === objectId),
    ),
  );
  const regions = Object.fromEntries(
    Object.entries(workspace.regions).map(([id, region]) => [
      id,
      region.objectIds.includes(objectId)
        ? { ...region, objectIds: region.objectIds.filter((id) => id !== objectId) }
        : region,
    ]),
  );
  const focus =
    workspace.focus === null
      ? null
      : {
          ...workspace.focus,
          objectIds: workspace.focus.objectIds.filter((id) => id !== objectId),
        };
  const openingBrief =
    workspace.openingBrief === null ||
    !workspace.openingBrief.sourceObjectIds.includes(objectId)
      ? workspace.openingBrief
      : {
          ...workspace.openingBrief,
          sourceObjectIds: workspace.openingBrief.sourceObjectIds.filter((id) => id !== objectId),
        };

  return { ...workspace, objects, relations, regions, focus, openingBrief };
}

export function upsertRelation(workspace: CwmWorkspace, relation: CwmRelation): CwmWorkspace {
  return {
    ...workspace,
    relations: { ...workspace.relations, [relation.id]: relation },
  };
}

export function removeRelation(workspace: CwmWorkspace, relationId: string): CwmWorkspace {
  if (!(relationId in workspace.relations)) return workspace;
  const { [relationId]: _removed, ...relations } = workspace.relations;
  return { ...workspace, relations };
}

export function upsertRegion(workspace: CwmWorkspace, region: CwmRegion): CwmWorkspace {
  return {
    ...workspace,
    regions: { ...workspace.regions, [region.id]: region },
  };
}

/** Remove a region, its relations, and its focus reference. */
export function removeRegion(workspace: CwmWorkspace, regionId: string): CwmWorkspace {
  if (!(regionId in workspace.regions)) return workspace;

  const { [regionId]: _removed, ...regions } = workspace.regions;
  const relations = Object.fromEntries(
    Object.entries(workspace.relations).filter(
      ([, relation]) =>
        !(relation.source.kind === "REGION" && relation.source.id === regionId) &&
        !(relation.target.kind === "REGION" && relation.target.id === regionId),
    ),
  );
  const focus =
    workspace.focus === null
      ? null
      : {
          ...workspace.focus,
          regionIds: workspace.focus.regionIds.filter((id) => id !== regionId),
        };

  return { ...workspace, regions, relations, focus };
}

export function setMode(workspace: CwmWorkspace, mode: CwmMode): CwmWorkspace {
  return workspace.mode === mode ? workspace : { ...workspace, mode };
}

export function setFocus(workspace: CwmWorkspace, focus: CwmFocus | null): CwmWorkspace {
  return { ...workspace, focus };
}

export function setOpeningBrief(
  workspace: CwmWorkspace,
  openingBrief: CwmOpeningBrief | null,
): CwmWorkspace {
  return { ...workspace, openingBrief };
}

export function setSceneBinding(
  workspace: CwmWorkspace,
  objectId: string,
  binding: CwmSceneBinding | null,
): CwmWorkspace {
  const object = workspace.objects[objectId];
  if (object === undefined) {
    throw new Error(`Cannot set scene binding: object "${objectId}" does not exist`);
  }

  let nextObject: CwmObject;
  if (binding === null) {
    const { sceneBinding: _removed, ...withoutBinding } = object;
    nextObject = withoutBinding;
  } else {
    nextObject = { ...object, sceneBinding: binding };
  }
  return upsertObject(workspace, nextObject);
}

/** Apply one already-authorized semantic operation. */
export function applyCwmOperation(
  workspace: CwmWorkspace,
  operation: CwmSemanticOperation,
): CwmWorkspace {
  switch (operation.type) {
    case "UPSERT_OBJECT":
      return upsertObject(workspace, operation.object);
    case "REMOVE_OBJECT":
      return removeObject(workspace, operation.objectId);
    case "UPSERT_RELATION":
      return upsertRelation(workspace, operation.relation);
    case "REMOVE_RELATION":
      return removeRelation(workspace, operation.relationId);
    case "UPSERT_REGION":
      return upsertRegion(workspace, operation.region);
    case "REMOVE_REGION":
      return removeRegion(workspace, operation.regionId);
    case "SET_MODE":
      return setMode(workspace, operation.mode);
    case "SET_FOCUS":
      return setFocus(workspace, operation.focus);
    case "SET_OPENING_BRIEF":
      return setOpeningBrief(workspace, operation.openingBrief);
    case "SET_SCENE_BINDING":
      return setSceneBinding(workspace, operation.objectId, operation.binding);
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

export function applyCwmOperations(
  workspace: CwmWorkspace,
  operations: readonly CwmSemanticOperation[],
): CwmWorkspace {
  return operations.reduce(applyCwmOperation, workspace);
}

// Small operation constructors make call sites readable and preserve discriminated literals.
export const opUpsertObject = (object: CwmObject): CwmSemanticOperation => ({
  type: "UPSERT_OBJECT",
  object,
});
export const opRemoveObject = (objectId: string): CwmSemanticOperation => ({
  type: "REMOVE_OBJECT",
  objectId,
});
export const opUpsertRelation = (relation: CwmRelation): CwmSemanticOperation => ({
  type: "UPSERT_RELATION",
  relation,
});
export const opRemoveRelation = (relationId: string): CwmSemanticOperation => ({
  type: "REMOVE_RELATION",
  relationId,
});
export const opUpsertRegion = (region: CwmRegion): CwmSemanticOperation => ({
  type: "UPSERT_REGION",
  region,
});
export const opRemoveRegion = (regionId: string): CwmSemanticOperation => ({
  type: "REMOVE_REGION",
  regionId,
});
export const opSetMode = (mode: CwmMode): CwmSemanticOperation => ({ type: "SET_MODE", mode });
export const opSetFocus = (focus: CwmFocus | null): CwmSemanticOperation => ({
  type: "SET_FOCUS",
  focus,
});
export const opSetOpeningBrief = (
  openingBrief: CwmOpeningBrief | null,
): CwmSemanticOperation => ({ type: "SET_OPENING_BRIEF", openingBrief });
export const opSetSceneBinding = (
  objectId: string,
  binding: CwmSceneBinding | null,
): CwmSemanticOperation => ({ type: "SET_SCENE_BINDING", objectId, binding });
