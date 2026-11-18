import {
  BackendError,
  type BackendClient,
  type FineGranularDetails,
  type ProjectDetails,
  type RelationDetails,
  type SyncChanges,
} from '../src/backend.js';

interface StoredModel {
  id: number;
  sourceId: number;
  name: string;
}

interface StoredView {
  id: number;
  name: string;
  description: string | null;
  fileStorageId: number;
  /** Library IDs of the view's metamodels. */
  metaModelIds: number[];
}

/** A project as the fake backend stores it. */
export interface StoredProject {
  name: string;
  metaModels: StoredModel[];
  relations: RelationDetails[];
  views: StoredView[];
  layout: unknown;
}

/** What the fake backend answers or does instead of handling a call normally. */
export type Interruption =
  | Error
  /** Waits until `gate` resolves (see {@link gate}), then handles the call normally. */
  | { gate: Promise<void> };

/**
 * An in-memory backend for the collaboration server. It handles `sync-changes` like the real
 * backend does in the cases the tests use: relations are matched by their pair of metamodels,
 * views by ID, then name, then file and metamodels, and everything a request doesn't contain is
 * deleted. Every change it makes is listed in {@link changes}, so a request that changes nothing
 * leaves it empty.
 */
export class FakeProjects implements BackendClient {
  readonly projects = new Map<string, StoredProject>();
  /** Projects that don't exist; loading them fails with 404. */
  readonly missing = new Set<string>();
  /** The sync requests received, in order. */
  readonly requests: { projectId: string; changes: SyncChanges }[] = [];
  /** IDs of the projects loaded, in order. */
  readonly loads: string[] = [];
  /** Changes made by sync requests, e.g. `create relation 7`. */
  readonly changes: string[] = [];
  /** Interruptions of the next loads, in order. */
  readonly nextLoads: Interruption[] = [];
  /** Interruptions of the next sync requests, in order. */
  readonly nextSyncs: Interruption[] = [];
  private nextId = 1000;
  /**
   * Reaction files generated for low-code mappings, by relation pair, elements and template: the
   * real backend rejects a file with the same content as one it already stored for the owner.
   */
  private readonly generated = new Set<string>();

  /** Stores a project and returns it. */
  add(projectId: string, project: Partial<StoredProject> = {}): StoredProject {
    const stored: StoredProject = {
      name: `Project ${projectId}`,
      metaModels: [],
      relations: [],
      views: [],
      layout: null,
      ...structuredClone(project),
    };
    this.projects.set(projectId, stored);
    return stored;
  }

  async getProject(projectId: string): Promise<ProjectDetails> {
    this.loads.push(projectId);
    await this.interrupt(this.nextLoads);
    if (this.missing.has(projectId)) {
      throw new BackendError(404, `The backend answered GET with status 404`);
    }
    const project = this.projects.get(projectId) ?? this.add(projectId);
    const toModel = (sourceId: number) => {
      const model = project.metaModels.find((candidate) => candidate.sourceId === sourceId);
      return { id: model?.id ?? sourceId, sourceId, name: model?.name ?? '' };
    };
    return structuredClone({
      id: Number(projectId),
      name: project.name,
      metaModels: project.metaModels.map((model) => ({ ...model })),
      metaModelsRelation: project.relations,
      views: project.views.map((view) => ({
        id: view.id,
        name: view.name,
        description: view.description,
        fileStorageId: view.fileStorageId,
        assignedModels: view.metaModelIds.map(toModel),
      })),
      layout: project.layout,
    });
  }

  async syncChanges(projectId: string, changes: SyncChanges): Promise<void> {
    this.requests.push({ projectId, changes: structuredClone(changes) });
    await this.interrupt(this.nextSyncs);
    const stored = this.projects.get(projectId);
    if (stored === undefined || this.missing.has(projectId)) {
      throw new BackendError(404, 'The backend answered PUT with status 404', 'VSUM not found');
    }
    // Like the real backend, a request is applied in one transaction: all or nothing.
    const project = structuredClone(stored);
    const log: string[] = [];
    this.applyModels(project, changes, log);
    this.applyRelations(project, changes, log);
    this.applyViews(project, changes, log);
    if (changes.layout !== undefined && changes.layout !== null) {
      project.layout = structuredClone(changes.layout);
      log.push('store layout');
    }
    this.projects.set(projectId, project);
    this.changes.push(...log.filter((entry) => entry !== 'store layout' || !sameJson(stored.layout, project.layout)));
  }

  private async interrupt(queue: Interruption[]): Promise<void> {
    const next = queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (next !== undefined) {
      await next.gate;
    }
  }

  private applyModels(project: StoredProject, changes: SyncChanges, log: string[]): void {
    const desired = new Set(changes.metaModelIds);
    for (const model of project.metaModels.filter((model) => !desired.has(model.sourceId))) {
      log.push(`delete model ${model.sourceId}`);
    }
    project.metaModels = project.metaModels.filter((model) => desired.has(model.sourceId));
    for (const sourceId of desired) {
      const name = changes.metaModelNames[String(sourceId)];
      if (name !== undefined && name.trim() === '') {
        throw new BackendError(400, 'status 400', 'metaModelNames: must not be blank');
      }
      const model = project.metaModels.find((candidate) => candidate.sourceId === sourceId);
      if (model === undefined) {
        project.metaModels.push({ id: this.nextId++, sourceId, name: name ?? `Model ${sourceId}` });
        log.push(`add model ${sourceId}`);
      } else if (name !== undefined && name !== model.name) {
        model.name = name;
        log.push(`rename model ${sourceId}`);
      }
    }
  }

  private applyRelations(project: StoredProject, changes: SyncChanges, log: string[]): void {
    const models = new Set(project.metaModels.map((model) => model.sourceId));
    const pairs = new Set<string>();
    const kept: RelationDetails[] = [];
    for (const request of changes.metaModelRelationRequests) {
      const pair = `${request.sourceId}:${request.targetId}`;
      if (pairs.has(pair)) {
        throw new BackendError(409, 'status 409', `Two relations for ${pair}`);
      }
      pairs.add(pair);
      if (!models.has(request.sourceId) || !models.has(request.targetId)) {
        throw new BackendError(404, 'status 404', 'Metamodel not found in this VSUM');
      }
      const existing = project.relations.find(
        (relation) => relation.sourceId === request.sourceId && relation.targetId === request.targetId,
      );
      if (existing === undefined && request.reactionFileId === null && request.fineGranularMetaModelRelationSet.length === 0) {
        throw new BackendError(400, 'status 400', 'A reaction file or fine-granular relations are required');
      }
      const relation: RelationDetails = existing ?? {
        id: this.nextId++,
        sourceId: request.sourceId,
        targetId: request.targetId,
        reactionFileStorageId: request.reactionFileId,
        fineGranularMetaModelRelationSet: [],
      };
      if (existing === undefined) {
        log.push(`create relation ${relation.id}`);
      } else if ((existing.reactionFileStorageId ?? null) !== request.reactionFileId) {
        existing.reactionFileStorageId = request.reactionFileId;
        log.push(`update relation ${existing.id}`);
      }
      relation.fineGranularMetaModelRelationSet = this.applyMappings(
        pair,
        relation.fineGranularMetaModelRelationSet ?? [],
        request.fineGranularMetaModelRelationSet,
        log,
      );
      kept.push(relation);
    }
    for (const relation of project.relations.filter((candidate) => !kept.includes(candidate))) {
      log.push(`delete relation ${relation.id}`);
    }
    project.relations = kept;
  }

  private applyMappings(
    pair: string,
    existing: FineGranularDetails[],
    requested: FineGranularDetails[],
    log: string[],
  ): FineGranularDetails[] {
    const result: FineGranularDetails[] = [];
    for (const request of requested) {
      if (request.id !== undefined && request.id !== null) {
        const match = existing.find((mapping) => mapping.id === request.id);
        if (match === undefined) {
          throw new BackendError(404, 'status 404', 'Fine-granular relation not found');
        }
        // The real backend changes a mapping with an ID in place, and regenerates its file if asked.
        const fields = {
          sourceId: request.sourceId,
          targetId: request.targetId,
          reactionFileStorageId: request.reactionFileStorageId ?? match.reactionFileStorageId ?? null,
        };
        if (!sameJson(fields, { sourceId: match.sourceId, targetId: match.targetId, reactionFileStorageId: match.reactionFileStorageId ?? null })) {
          Object.assign(match, fields);
          log.push(`update mapping ${match.id}`);
        }
        const requested = request.lowCodeReactionRequestBase as Record<string, unknown> | null | undefined;
        if (requested?.regenerate === true) {
          // Regenerates the file from the template sent and stores that template.
          match.lowCodeReactionRequestBase = { ...requested, regenerate: false };
          log.push(`regenerate mapping ${match.id}`);
        } else if (requested && !sameJson(withoutRegenerate(requested), withoutRegenerate(match.lowCodeReactionRequestBase))) {
          // Without regenerate, the real backend keeps the file and drops the stored template.
          match.lowCodeReactionRequestBase = null;
          log.push(`update mapping ${match.id}`);
        }
        result.push(match);
        continue;
      }
      const equal = existing.find(
        (mapping) =>
          !result.includes(mapping) &&
          mapping.sourceId === request.sourceId &&
          mapping.targetId === request.targetId &&
          (mapping.reactionFileStorageId ?? null) === (request.reactionFileStorageId ?? null),
      );
      if (equal !== undefined) {
        result.push(equal);
        continue;
      }
      let reactionFileStorageId = request.reactionFileStorageId ?? null;
      const lowCode = request.lowCodeReactionRequestBase ?? null;
      if (reactionFileStorageId === null && lowCode === null) {
        throw new BackendError(400, 'status 400', 'A reaction file or a template is required');
      }
      if (reactionFileStorageId === null) {
        // The real backend stores the generated file for the VSUM's owner and rejects a second,
        // identical one.
        const generatedKey = `${pair}:${request.sourceId}:${request.targetId}:${JSON.stringify(lowCode)}`;
        if (this.generated.has(generatedKey)) {
          throw new BackendError(400, 'status 400', 'File already exists');
        }
        this.generated.add(generatedKey);
        reactionFileStorageId = this.nextId++;
      }
      // With a file, the real backend only attaches it and doesn't store the template.
      const mapping = {
        ...structuredClone(request),
        id: this.nextId++,
        reactionFileStorageId,
        lowCodeReactionRequestBase: request.reactionFileStorageId ? null : lowCode,
      };
      log.push(`create mapping ${mapping.id}`);
      result.push(mapping);
    }
    for (const mapping of existing.filter((candidate) => !result.includes(candidate))) {
      log.push(`delete mapping ${mapping.id}`);
    }
    return result;
  }

  private applyViews(project: StoredProject, changes: SyncChanges, log: string[]): void {
    const models = new Set(project.metaModels.map((model) => model.sourceId));
    const unmatched = [...project.views];
    const result: StoredView[] = [];
    const ids = new Set<number>();
    const take = (predicate: (view: StoredView) => boolean) => {
      const index = unmatched.findIndex(predicate);
      return index < 0 ? undefined : unmatched.splice(index, 1)[0];
    };
    for (const request of changes.viewRequests) {
      const identified = request.id !== undefined || request.name.trim() !== '';
      if (identified && request.fileStorageId === null) {
        throw new BackendError(400, 'status 400', `View ${request.name} needs a file`);
      }
      // Like the real backend, a request without ID and name needs a file and metamodels.
      if (!identified && (request.fileStorageId === null || request.metaModelIds.length === 0)) {
        continue;
      }
      const fileStorageId = request.fileStorageId as number;
      if (request.id !== undefined) {
        if (ids.has(request.id)) {
          throw new BackendError(400, 'status 400', `View ID ${request.id} is not unique`);
        }
        ids.add(request.id);
      }
      const name = request.name.trim();
      const metaModelIds = [...new Set(request.metaModelIds)].filter((id) => models.has(id)).sort((a, b) => a - b);
      const view =
        (request.id === undefined ? undefined : take((candidate) => candidate.id === request.id)) ??
        (name === '' ? undefined : take((candidate) => candidate.name === name)) ??
        (name !== ''
          ? undefined
          : take(
              (candidate) =>
                candidate.fileStorageId === fileStorageId &&
                sameJson(candidate.metaModelIds.filter((id) => models.has(id)), metaModelIds),
            ));
      const description = request.description.trim() === '' ? null : request.description.trim();
      if (view === undefined) {
        const created = {
          id: this.nextId++,
          name: name === '' ? `file-${fileStorageId}` : name,
          description,
          fileStorageId,
          metaModelIds,
        };
        log.push(`create view ${created.id}`);
        result.push(created);
        continue;
      }
      const updated = {
        ...view,
        name: name === '' ? view.name : name,
        description,
        fileStorageId,
        metaModelIds,
      };
      if (!sameJson(updated, view)) {
        log.push(`update view ${view.id}`);
      }
      result.push(updated);
    }
    const names = result.map((view) => view.name);
    if (new Set(names).size !== names.length) {
      throw new BackendError(400, 'status 400', 'View names must be unique');
    }
    for (const view of unmatched) {
      log.push(`delete view ${view.id}`);
    }
    project.views = result;
  }
}

/** Returns an interruption that holds a call until the returned function is called. */
export function gate(): { interruption: Interruption; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { interruption: { gate: promise }, open };
}

/** A low-code template without its `regenerate` flag, which is not part of what is stored. */
function withoutRegenerate(lowCode: unknown): unknown {
  if (typeof lowCode !== 'object' || lowCode === null) {
    return lowCode;
  }
  const { regenerate: _regenerate, ...rest } = lowCode as Record<string, unknown>;
  return rest;
}

/** Whether two JSON values are equal, regardless of the order of object keys. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}
