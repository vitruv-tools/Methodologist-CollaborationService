import type { Doc, Map as YMap } from 'yjs';
import type {
  FineGranularDetails,
  MetaModelDetails,
  ProjectDetails,
  RelationDetails,
  RelationRequest,
  SyncChanges,
  ViewDetails,
  ViewRequest,
} from './backend.js';
import {
  LAYOUT,
  LAYOUT_META_MODELS,
  LAYOUT_REACTIONS,
  MODELS,
  RELATIONS,
  STATUS,
  VIEWS,
  WRITEBACK_ERROR,
  type ModelFields,
  type RelationFields,
  type ViewFields,
} from './document.js';
import { Y } from './yjs.js';

/**
 * Origin of the server's own changes to a document: loading a project, filling in backend IDs and
 * reporting in `status`. Changes with this origin don't start a writeback, but the next writeback
 * contains them like the rest of the document (`status` is never sent).
 */
export const SERVER_ORIGIN = Symbol('collaboration server');

/** The maps of the layout that the server creates when it loads a project. */
const LAYOUT_MAPS: string[] = [LAYOUT_META_MODELS, LAYOUT_REACTIONS];

/**
 * Thrown by {@link toSyncChanges} if the backend has an element that the document has in a form
 * the server can't read, e.g. a relation whose `sourceId` is not a number, or a value that isn't
 * JSON. Leaving the element out would delete it in the backend, so nothing is written back.
 */
export class DocumentError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'DocumentError';
  }
}

/** What a sync request contained for a relation, to find it in the backend afterwards. */
export interface SentRelation {
  sourceId: number;
  targetId: number;
  reactionFileId: number | null;
  /** The relation's `fineGranular` in the document when the request was built. */
  fineGranular: unknown[];
}

/** What a sync request contained for a view, to find it in the backend afterwards. */
export interface SentView {
  /** The ID the request had, if any. */
  id: number | undefined;
  name: string;
  fileStorageId: number | null;
  /** The view's metamodels that the project keeps. */
  metaModelIds: number[];
}

/** The relations and views of a sync request, by their keys in the document. */
export interface SentState {
  relations: Map<string, SentRelation>;
  views: Map<string, SentView>;
}

/** A sync request and what it contained, as built by {@link toSyncChanges}. */
export interface SyncRequest {
  changes: SyncChanges;
  sent: SentState;
}

/**
 * Fills an empty document with a project from the backend, as one change with
 * {@link SERVER_ORIGIN}. Turning the document back into a sync request with {@link toSyncChanges}
 * gives a request that changes nothing in the backend, except for the layout: it gets the
 * `metaModels` and `reactions` maps if it lacks them, values of these two that aren't objects
 * are replaced with empty maps, and entries Yjs can't store are dropped.
 *
 * @returns the layout entries that Yjs can't store (e.g. an object with its own `constructor`
 *     key) and that were therefore left out, as paths like `reactions.12`
 */
export function fillDocument(doc: Doc, project: ProjectDetails): string[] {
  const skipped: string[] = [];
  doc.transact(() => {
    const models = doc.getMap(MODELS);
    for (const metaModel of project.metaModels ?? []) {
      const id = libraryId(metaModel);
      if (id !== null) {
        models.set(String(id), element<ModelFields>({ name: metaModel.name ?? '', ...NOT_DELETED }));
      }
    }

    const relations = doc.getMap(RELATIONS);
    for (const relation of project.metaModelsRelation ?? []) {
      if (isId(relation.id) && isId(relation.sourceId) && isId(relation.targetId)) {
        relations.set(
          String(relation.id),
          element<RelationFields>({
            backendId: relation.id,
            sourceId: relation.sourceId,
            targetId: relation.targetId,
            reactionFileId: idOrNull(relation.reactionFileStorageId),
            fineGranular: copyMappings(relation.fineGranularMetaModelRelationSet),
            ...NOT_DELETED,
          }),
        );
      }
    }

    const views = doc.getMap(VIEWS);
    for (const view of project.views ?? []) {
      if (isId(view.id)) {
        views.set(
          String(view.id),
          element<Omit<ViewFields, 'fileStorageId'> & { fileStorageId: number | null }>({
            backendId: view.id,
            name: view.name ?? '',
            description: new Y.Text(view.description ?? ''),
            fileStorageId: idOrNull(view.fileStorageId),
            metaModelIds: viewMetaModelIds(view),
            ...NOT_DELETED,
          }),
        );
      }
    }

    const layout = doc.getMap(LAYOUT);
    const stored = isObject(project.layout) ? project.layout : {};
    for (const [key, value] of Object.entries(stored)) {
      if (!LAYOUT_MAPS.includes(key)) {
        setIfStorable(layout, key, value, key, skipped);
      }
    }
    for (const key of LAYOUT_MAPS) {
      const map = new Y.Map<unknown>();
      layout.set(key, map);
      const entries = stored[key];
      for (const [entryKey, value] of isObject(entries) ? Object.entries(entries) : []) {
        setIfStorable(map, entryKey, value, `${key}.${entryKey}`, skipped);
      }
    }

    doc.getMap(STATUS).set(WRITEBACK_ERROR, null);
  }, SERVER_ORIGIN);
  return skipped;
}

/**
 * Builds the sync request for the current state of the document. `known` is the project as the
 * backend returned it last.
 *
 * - Soft-deleted elements are left out, and so are relations whose source or target is not a
 *   metamodel of the project, so the backend deletes them.
 * - A new fine-granular mapping without reaction file and low-code template (drawn, but not
 *   configured yet), a new relation without reaction file and such mappings, and a new view
 *   without file (or without name and metamodels) are left out: the backend would reject or ignore
 *   them, and they aren't in the backend yet. So is a new element the server can't read.
 * - The backend keeps one relation per pair of metamodels. If two relations have the same pair (two
 *   users added one at the same time, or one was deleted and another drawn), only one is sent: the
 *   one the backend has, otherwise the one with the smallest key among those with a reaction file
 *   or configured mappings.
 * - Fine-granular mapping IDs that the backend's relation doesn't have are left out (it would
 *   answer 404), e.g. after the relation was deleted in the backend and then restored.
 * - Views are sent with their backend ID, so renaming a view keeps it. A second view with the same
 *   backend ID is sent without it.
 * - The layout is sent unless it is empty, in which case the backend keeps the stored one.
 *
 * @throws DocumentError if an element the backend has can't be read, or a value isn't JSON
 */
export function toSyncChanges(doc: Doc, known: ProjectDetails): SyncRequest {
  const problems: string[] = [];
  const sent: SentState = { relations: new Map(), views: new Map() };

  const liveModels = readModels(doc, known, problems);
  const metaModelIds = [...liveModels.keys()].sort((a, b) => a - b);
  const metaModelNames: Record<string, string> = {};
  for (const id of metaModelIds) {
    const name = field<ModelFields>(liveModels.get(id) as YMap<unknown>, 'name');
    // The backend requires names that are not blank; without one, it keeps the metamodel's name.
    if (typeof name === 'string' && name.trim() !== '') {
      metaModelNames[String(id)] = name;
    }
  }

  const metaModelRelationRequests: RelationRequest[] = [];
  const knownRelations = new Map<string, RelationDetails>();
  for (const relation of known.metaModelsRelation ?? []) {
    knownRelations.set(pairKey(relation.sourceId, relation.targetId), relation);
  }
  for (const [pair, candidates] of readRelations(doc, known, liveModels, problems)) {
    const knownRelation = knownRelations.get(pair);
    const knownMappingIds = new Set(
      (knownRelation?.fineGranularMetaModelRelationSet ?? []).map((mapping) => mapping.id),
    );
    const isKnownMapping = (mapping: Record<string, unknown>) =>
      isId(mapping.id) && knownMappingIds.has(mapping.id);
    // A mapping that was drawn but isn't configured yet would make the backend reject the request.
    const mappingsToSend = (candidate: RelationCandidate) =>
      candidate.mappings.filter((mapping) => isKnownMapping(mapping) || isConfigured(mapping));
    const chosen =
      candidates.find((candidate) => candidate.backendId === knownRelation?.id) ??
      candidates.find(
        (candidate) => candidate.reactionFileId !== null || mappingsToSend(candidate).length > 0,
      );
    if (chosen === undefined) {
      continue;
    }
    const mappings = mappingsToSend(chosen).map((mapping) =>
      isKnownMapping(mapping) ? mapping : withoutId(mapping),
    );
    const json = asJson(mappings);
    if (json === undefined) {
      problems.push(`relation ${chosen.key} has fine-granular mappings that aren't JSON`);
      continue;
    }
    metaModelRelationRequests.push({
      sourceId: chosen.sourceId,
      targetId: chosen.targetId,
      reactionFileId: chosen.reactionFileId,
      fineGranularMetaModelRelationSet: json as FineGranularDetails[],
    });
    sent.relations.set(chosen.key, {
      sourceId: chosen.sourceId,
      targetId: chosen.targetId,
      reactionFileId: chosen.reactionFileId,
      fineGranular: chosen.fineGranular,
    });
  }

  const viewRequests: ViewRequest[] = [];
  const sentViewIds = new Set<number>();
  for (const view of readViews(doc, known, problems)) {
    const id =
      view.backendId !== null && !sentViewIds.has(view.backendId) ? view.backendId : undefined;
    if (id !== undefined) {
      sentViewIds.add(id);
    }
    const request: ViewRequest = {
      name: view.name,
      description: view.description,
      fileStorageId: view.fileStorageId,
      metaModelIds: view.metaModelIds,
    };
    viewRequests.push(id === undefined ? request : { id, ...request });
    sent.views.set(view.key, {
      id,
      name: view.name,
      fileStorageId: view.fileStorageId,
      metaModelIds: view.metaModelIds.filter((modelId) => liveModels.has(modelId)),
    });
  }

  const changes: SyncChanges = {
    metaModelIds,
    metaModelNames,
    metaModelRelationRequests,
    viewRequests,
  };
  const layout = doc.getMap(LAYOUT).toJSON();
  if (!Object.values(layout).every(isEmpty)) {
    const json = asJson(layout);
    if (json === undefined) {
      problems.push("the layout has values that aren't JSON");
    } else {
      changes.layout = json as Record<string, unknown>;
    }
  }

  if (problems.length > 0) {
    throw new DocumentError(problems);
  }
  return { changes, sent };
}

/**
 * Brings the backend's state after a sync request into the document, as one change with
 * {@link SERVER_ORIGIN}. `sent` is what the request contained, and `project` the project as the
 * backend returned it afterwards. `applied` tells whether the request is known to have succeeded;
 * otherwise (it failed, or its outcome is unknown) only IDs are brought in.
 *
 * - A sent relation gets the ID of the backend's relation with the same source, target and reaction
 *   file. Its fine-granular mappings without a backend ID get the ID (and generated reaction file)
 *   of the backend's mapping with the same source, target and reaction file or low-code template.
 *   Mappings are never removed, so changes the backend doesn't have yet are kept. If the request
 *   succeeded, a mapping still as sent gets `regenerate: false`, since the backend regenerated it.
 * - A sent view without a backend ID, or with one the backend doesn't have, gets the ID of the
 *   backend's view with the name sent; a view without name the one with its file and metamodels.
 * - Backend IDs the backend no longer has are removed.
 */
export function applyBackendState(
  doc: Doc,
  sent: SentState,
  project: ProjectDetails,
  { applied }: { applied: boolean },
): void {
  doc.transact(() => {
    const relations = doc.getMap(RELATIONS);
    const backendRelations = project.metaModelsRelation ?? [];
    const relationsByPair = new Map<string, RelationDetails>();
    for (const relation of backendRelations) {
      relationsByPair.set(pairKey(relation.sourceId, relation.targetId), relation);
    }
    for (const [key, sentRelation] of sent.relations) {
      const relation = relations.get(key);
      const match = relationsByPair.get(pairKey(sentRelation.sourceId, sentRelation.targetId));
      if (
        !(relation instanceof Y.Map) ||
        match === undefined ||
        idOrNull(match.reactionFileStorageId) !== sentRelation.reactionFileId
      ) {
        continue;
      }
      setIfChanged(relation, 'backendId', match.id);
      const current = field<RelationFields>(relation, 'fineGranular');
      if (Array.isArray(current)) {
        const merged = mergeMappings(
          current,
          match.fineGranularMetaModelRelationSet ?? [],
          new Set(sentRelation.fineGranular.map(canonical)),
          applied,
        );
        if (merged !== undefined) {
          relation.set('fineGranular', merged);
        }
      }
    }
    forgetUnknownIds(relations, new Set(backendRelations.map((relation) => relation.id)));

    const views = doc.getMap(VIEWS);
    const backendViews = project.views ?? [];
    const backendViewIds = new Set(backendViews.map((view) => view.id));
    const claimed = new Set<number>();
    for (const sentView of sent.views.values()) {
      if (sentView.id !== undefined && backendViewIds.has(sentView.id)) {
        claimed.add(sentView.id);
      }
    }
    // Named views first, so that an unnamed view with the same file and metamodels can't take the
    // backend view a named one was created as.
    const sentViews = [...sent.views].sort(
      ([, a], [, b]) => Number(a.name.trim() === '') - Number(b.name.trim() === ''),
    );
    for (const [key, sentView] of sentViews) {
      const view = views.get(key);
      if (!(view instanceof Y.Map) || (sentView.id !== undefined && claimed.has(sentView.id))) {
        continue;
      }
      const name = sentView.name.trim();
      const match = backendViews.find(
        (candidate) =>
          !claimed.has(candidate.id) &&
          (name === ''
            ? candidate.fileStorageId === sentView.fileStorageId &&
              isSameSet(viewMetaModelIds(candidate), sentView.metaModelIds)
            : (candidate.name ?? '').trim() === name),
      );
      if (match === undefined) {
        continue;
      }
      claimed.add(match.id);
      setIfChanged(view, 'backendId', match.id);
      // The backend names a new view without name after its file.
      const currentName = field<ViewFields>(view, 'name');
      if (name === '' && match.name && (typeof currentName !== 'string' || !currentName.trim())) {
        view.set('name', match.name);
      }
    }
    forgetUnknownIds(views, backendViewIds);
  }, SERVER_ORIGIN);
}

/**
 * Brings a project as the backend returned it into a loaded document, as one change with
 * {@link SERVER_ORIGIN}: used when the backend changed the project outside the document. Only the
 * differences are applied, so connected clients receive them like any other change: elements the
 * backend doesn't have are removed, changed fields are set, new elements are added, and unchanged
 * elements, fields and descriptions stay as they are.
 *
 * Afterwards the document has the backend's state, as if it had been loaded with
 * {@link fillDocument}, except that elements found by their `backendId` keep their keys. The
 * backend wins: changes made in the document that the backend doesn't have are lost, including new
 * elements that were never written back. The writeback error is cleared, since it was about such
 * changes; the rest of `status` is kept.
 *
 * @returns the layout entries that Yjs can't store and that were therefore left out, like
 *     {@link fillDocument}
 */
export function applyProject(doc: Doc, project: ProjectDetails): string[] {
  const skipped: string[] = [];
  doc.transact(() => {
    const models = doc.getMap(MODELS);
    const modelKeys = new Set<string>();
    for (const metaModel of project.metaModels ?? []) {
      const id = libraryId(metaModel);
      if (id !== null) {
        modelKeys.add(String(id));
        updateElement<ModelFields>(models, String(id), { name: metaModel.name ?? '', ...NOT_DELETED });
      }
    }
    deleteOthers(models, modelKeys);

    const relations = doc.getMap(RELATIONS);
    const relationKeys = new ElementKeys(relations);
    for (const relation of project.metaModelsRelation ?? []) {
      if (isId(relation.id) && isId(relation.sourceId) && isId(relation.targetId)) {
        updateElement<RelationFields>(relations, relationKeys.claim(relation.id), {
          backendId: relation.id,
          sourceId: relation.sourceId,
          targetId: relation.targetId,
          reactionFileId: idOrNull(relation.reactionFileStorageId),
          fineGranular: copyMappings(relation.fineGranularMetaModelRelationSet),
          ...NOT_DELETED,
        });
      }
    }
    deleteOthers(relations, relationKeys.claimed);

    const views = doc.getMap(VIEWS);
    const viewKeys = new ElementKeys(views);
    for (const view of project.views ?? []) {
      if (isId(view.id)) {
        updateElement<Omit<ViewFields, 'fileStorageId' | 'description'> & {
          fileStorageId: number | null;
          description: string;
        }>(views, viewKeys.claim(view.id), {
          backendId: view.id,
          name: view.name ?? '',
          description: view.description ?? '',
          fileStorageId: idOrNull(view.fileStorageId),
          metaModelIds: viewMetaModelIds(view),
          ...NOT_DELETED,
        });
      }
    }
    deleteOthers(views, viewKeys.claimed);

    const layout = doc.getMap(LAYOUT);
    const stored = isObject(project.layout) ? project.layout : {};
    for (const [key, value] of Object.entries(stored)) {
      if (!LAYOUT_MAPS.includes(key)) {
        updateValue(layout, key, value, key, skipped);
      }
    }
    deleteOthers(layout, new Set([...Object.keys(stored), ...LAYOUT_MAPS]));
    for (const key of LAYOUT_MAPS) {
      let map = layout.get(key);
      if (!(map instanceof Y.Map)) {
        map = new Y.Map<unknown>();
        layout.set(key, map);
      }
      const entries = isObject(stored[key]) ? stored[key] : {};
      for (const [entryKey, value] of Object.entries(entries)) {
        updateValue(map as YMap<unknown>, entryKey, value, `${key}.${entryKey}`, skipped);
      }
      deleteOthers(map as YMap<unknown>, new Set(Object.keys(entries)));
    }

    const status = doc.getMap(STATUS);
    if (status.get(WRITEBACK_ERROR) !== null) {
      status.set(WRITEBACK_ERROR, null);
    }
  }, SERVER_ORIGIN);
  return skipped;
}

/** Fields of elements whose value is a `Y.Text`, edited character by character. */
const TEXT_FIELDS: string[] = ['description' satisfies keyof ViewFields];

/**
 * Gives the element at `key` exactly these fields, changing only those that differ. Text fields are
 * given as strings and kept in a `Y.Text`. If the value at `key` is no `Y.Map`, it is replaced.
 */
function updateElement<T>(elements: YMap<unknown>, key: string, fields: T): void {
  const values = fields as Record<string, unknown>;
  const current = elements.get(key);
  if (!(current instanceof Y.Map)) {
    const created: Record<string, unknown> = { ...values };
    for (const name of TEXT_FIELDS.filter((field) => field in values)) {
      created[name] = new Y.Text(values[name] as string);
    }
    elements.set(key, element(created));
    return;
  }
  for (const [name, value] of Object.entries(values)) {
    const old = current.get(name);
    if (TEXT_FIELDS.includes(name)) {
      if (!(old instanceof Y.Text)) {
        current.set(name, new Y.Text(value as string));
      } else if (old.toString() !== value) {
        old.delete(0, old.length);
        old.insert(0, value as string);
      }
    } else if (!isSameValue(name, old, value)) {
      current.set(name, value);
    }
  }
  deleteOthers(current, new Set(Object.keys(values)));
}

/**
 * Whether a field already has a value. Fine-granular mappings are compared regardless of their
 * order, which the backend doesn't keep.
 */
function isSameValue(name: string, current: unknown, value: unknown): boolean {
  if (name === ('fineGranular' satisfies keyof RelationFields)) {
    return Array.isArray(current) && Array.isArray(value) && isSameSet(current, value);
  }
  return !(current instanceof Y.AbstractType) && canonical(current) === canonical(value);
}

/** Sets a plain value if it differs. If Yjs can't store it, it is removed and reported instead. */
function updateValue(
  map: YMap<unknown>,
  key: string,
  value: unknown,
  path: string,
  skipped: string[],
): void {
  if (!(map.get(key) instanceof Y.AbstractType) && canonical(map.get(key)) === canonical(value)) {
    return;
  }
  try {
    map.set(key, value);
  } catch {
    skipped.push(path);
    map.delete(key);
  }
}

/** Removes all entries whose keys are not among `keep`. */
function deleteOthers(map: YMap<unknown>, keep: Set<string>): void {
  for (const key of [...map.keys()]) {
    if (!keep.has(key)) {
      map.delete(key);
    }
  }
}

/**
 * The keys of a map's elements by their backend ID. An element the backend has keeps its key, also
 * a UUID; a new one gets its backend ID as key, like when it is loaded.
 */
class ElementKeys {
  /** The keys given out by {@link claim}. */
  readonly claimed = new Set<string>();
  private readonly byBackendId = new Map<number, string>();

  constructor(elements: YMap<unknown>) {
    for (const [key, value] of sortedEntries(elements)) {
      const backendId = value instanceof Y.Map ? value.get('backendId') : undefined;
      // Of two elements with the same backend ID, the one keyed by it wins, else the first.
      if (isId(backendId) && (!this.byBackendId.has(backendId) || key === String(backendId))) {
        this.byBackendId.set(backendId, key);
      }
    }
  }

  /** The key for the element with this backend ID. */
  claim(backendId: number): string {
    let key = this.byBackendId.get(backendId) ?? String(backendId);
    if (this.claimed.has(key)) {
      // Only if another element has this backend ID as its key but a different backend ID.
      key = crypto.randomUUID();
    }
    this.claimed.add(key);
    return key;
  }
}

/** Reports why the last writeback failed in `status`, or that it succeeded (`null`). */
export function setWritebackError(doc: Doc, message: string | null): void {
  const status = doc.getMap(STATUS);
  if ((status.get(WRITEBACK_ERROR) ?? null) !== message) {
    doc.transact(() => status.set(WRITEBACK_ERROR, message), SERVER_ORIGIN);
  }
}

/** A relation of the document that can be sent. */
interface RelationCandidate {
  key: string;
  backendId: number | null;
  sourceId: number;
  targetId: number;
  reactionFileId: number | null;
  mappings: Record<string, unknown>[];
  fineGranular: unknown[];
}

/** A view of the document that can be sent. */
interface ViewCandidate {
  key: string;
  backendId: number | null;
  name: string;
  description: string;
  fileStorageId: number | null;
  metaModelIds: number[];
}

/** Returns the metamodels that are not soft-deleted, by library ID. */
function readModels(doc: Doc, known: ProjectDetails, problems: string[]): Map<number, YMap<unknown>> {
  const knownIds = new Set((known.metaModels ?? []).map(libraryId));
  const live = new Map<number, YMap<unknown>>();
  for (const [key, model] of sortedEntries(doc.getMap(MODELS))) {
    const id = parseId(key);
    if (id === null) {
      continue;
    }
    if (!(model instanceof Y.Map)) {
      if (knownIds.has(id)) {
        problems.push(`metamodel ${key} can't be read`);
      }
      continue;
    }
    if (field<ModelFields>(model, 'softDeleted') !== true) {
      live.set(id, model);
    }
  }
  return live;
}

/**
 * Returns the relations that are not soft-deleted and connect two live metamodels, grouped by
 * their pair of metamodels, each group sorted by key.
 */
function readRelations(
  doc: Doc,
  known: ProjectDetails,
  liveModels: Map<number, YMap<unknown>>,
  problems: string[],
): Map<string, RelationCandidate[]> {
  const knownIds = new Set((known.metaModelsRelation ?? []).map((relation) => relation.id));
  const byPair = new Map<string, RelationCandidate[]>();
  for (const [key, relation] of sortedEntries(doc.getMap(RELATIONS))) {
    if (!(relation instanceof Y.Map)) {
      if (knownIds.has(parseId(key) ?? Number.NaN)) {
        problems.push(`relation ${key} can't be read`);
      }
      continue;
    }
    if (field<RelationFields>(relation, 'softDeleted') === true) {
      continue;
    }
    const backendId = idOrNull(field<RelationFields>(relation, 'backendId'));
    const sourceId = idOrNull(field<RelationFields>(relation, 'sourceId'));
    const targetId = idOrNull(field<RelationFields>(relation, 'targetId'));
    const reactionFile = field<RelationFields>(relation, 'reactionFileId');
    const fineGranular = field<RelationFields>(relation, 'fineGranular') ?? [];
    const readable =
      sourceId !== null &&
      targetId !== null &&
      (reactionFile === null || reactionFile === undefined || isId(reactionFile)) &&
      Array.isArray(fineGranular) &&
      fineGranular.every(isObject);
    if (!readable) {
      if (backendId !== null && knownIds.has(backendId)) {
        problems.push(`relation ${key} can't be read`);
      }
      continue;
    }
    if (!liveModels.has(sourceId) || !liveModels.has(targetId)) {
      continue;
    }
    const pair = pairKey(sourceId, targetId);
    let candidates = byPair.get(pair);
    if (candidates === undefined) {
      candidates = [];
      byPair.set(pair, candidates);
    }
    candidates.push({
      key,
      backendId,
      sourceId,
      targetId,
      reactionFileId: idOrNull(reactionFile),
      mappings: fineGranular as Record<string, unknown>[],
      fineGranular,
    });
  }
  return byPair;
}

/** Returns the views that are not soft-deleted and can be sent, sorted by key. */
function readViews(doc: Doc, known: ProjectDetails, problems: string[]): ViewCandidate[] {
  const knownIds = new Set((known.views ?? []).map((view) => view.id));
  const result: ViewCandidate[] = [];
  for (const [key, view] of sortedEntries(doc.getMap(VIEWS))) {
    if (!(view instanceof Y.Map)) {
      if (knownIds.has(parseId(key) ?? Number.NaN)) {
        problems.push(`view ${key} can't be read`);
      }
      continue;
    }
    if (field<ViewFields>(view, 'softDeleted') === true) {
      continue;
    }
    const backendId = idOrNull(field<ViewFields>(view, 'backendId'));
    const isKnown = backendId !== null && knownIds.has(backendId);
    const name = field<ViewFields>(view, 'name') ?? '';
    const description = field<ViewFields>(view, 'description') ?? '';
    const file = field<ViewFields>(view, 'fileStorageId');
    const metaModelIds = field<ViewFields>(view, 'metaModelIds') ?? [];
    const readable =
      typeof name === 'string' &&
      (typeof description === 'string' || description instanceof Y.Text) &&
      (file === null || file === undefined || isId(file)) &&
      Array.isArray(metaModelIds) &&
      metaModelIds.every(isId);
    if (!readable) {
      if (isKnown) {
        problems.push(`view ${key} can't be read`);
      }
      continue;
    }
    const fileStorageId = idOrNull(file);
    const distinctIds = ids(metaModelIds);
    // The backend rejects a new view without file and ignores one without name and metamodels.
    if (!isKnown && (fileStorageId === null || (name.trim() === '' && distinctIds.length === 0))) {
      continue;
    }
    result.push({
      key,
      backendId,
      name,
      description: description.toString(),
      fileStorageId,
      metaModelIds: distinctIds,
    });
  }
  return result;
}

/**
 * Gives the document's mappings without a backend ID the ID and reaction file of the matching
 * backend mapping, and returns the new mappings, or `undefined` if nothing changes. `sent` holds
 * the mappings as sent (in canonical form); `applied` tells whether the request succeeded.
 *
 * - A mapping still as sent whose low-code template the backend returns in another form is
 *   matched by the template's name. A mapping edited since it was sent is matched that way too,
 *   and gets `regenerate: true`: the backend generated its file from the parameters sent before.
 * - If the request succeeded, a mapping still as sent gets `regenerate: false`, since the backend
 *   regenerated its file.
 */
function mergeMappings(
  current: unknown[],
  backend: FineGranularDetails[],
  sent: Set<string>,
  applied: boolean,
): unknown[] | undefined {
  const backendIds = new Set(backend.map((mapping) => mapping.id).filter(isId));
  const claimed = new Set<number>();
  for (const mapping of current) {
    if (isObject(mapping) && isId(mapping.id) && backendIds.has(mapping.id)) {
      claimed.add(mapping.id);
    }
  }
  const byElements = new Map<string, FineGranularDetails[]>();
  for (const candidate of backend) {
    const key = elementsKey(candidate);
    const candidates = byElements.get(key);
    if (candidates === undefined) {
      byElements.set(key, [candidate]);
    } else {
      candidates.push(candidate);
    }
  }
  const findMatch = (mapping: Record<string, unknown>, exact: boolean) =>
    byElements
      .get(elementsKey(mapping))
      ?.find(
        (candidate) =>
          isId(candidate.id) && !claimed.has(candidate.id) && isSameMapping(mapping, candidate, exact),
      );

  let changed = false;
  const merged = current.map((mapping) => {
    if (!isObject(mapping)) {
      return mapping;
    }
    const unchanged = sent.has(canonical(mapping));
    let result = mapping;
    if (!(isId(mapping.id) && backendIds.has(mapping.id))) {
      const exact = findMatch(mapping, true);
      const match = exact ?? findMatch(mapping, false);
      if (match !== undefined) {
        claimed.add(match.id as number);
        result = {
          ...result,
          id: match.id,
          reactionFileStorageId:
            idOrNull(mapping.reactionFileStorageId) ?? idOrNull(match.reactionFileStorageId),
        };
        const lowCode = result.lowCodeReactionRequestBase;
        if (exact === undefined && !unchanged && isObject(lowCode)) {
          result = { ...result, lowCodeReactionRequestBase: { ...lowCode, regenerate: true } };
        }
      }
    }
    const lowCode = result.lowCodeReactionRequestBase;
    if (applied && unchanged && isObject(lowCode) && lowCode.regenerate === true) {
      result = { ...result, lowCodeReactionRequestBase: { ...lowCode, regenerate: false } };
    }
    changed ||= result !== mapping;
    return result;
  });
  return changed ? merged : undefined;
}

/** Key of the pair of elements a mapping connects. */
function elementsKey(mapping: { sourceId?: unknown; targetId?: unknown }): string {
  return JSON.stringify([mapping.sourceId ?? null, mapping.targetId ?? null]);
}

/**
 * Whether a new mapping can be sent: it connects two elements and has a reaction file or a
 * low-code template. Otherwise the backend rejects it.
 */
function isConfigured(mapping: Record<string, unknown>): boolean {
  const isElement = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  return (
    isElement(mapping.sourceId) &&
    isElement(mapping.targetId) &&
    (isId(mapping.reactionFileStorageId) || isObject(mapping.lowCodeReactionRequestBase))
  );
}

/**
 * Whether a backend mapping is the document's mapping: same source and target, and the same
 * reaction file, or, if the document's has none, the same low-code template. With `exact`, the
 * template's parameters must be equal too; without, its name is enough (the backend rebuilds the
 * parameters from what it stored, which may differ in form).
 */
function isSameMapping(
  mapping: Record<string, unknown>,
  candidate: FineGranularDetails,
  exact: boolean,
): boolean {
  if (mapping.sourceId !== candidate.sourceId || mapping.targetId !== candidate.targetId) {
    return false;
  }
  const file = idOrNull(mapping.reactionFileStorageId);
  if (file !== null) {
    return idOrNull(candidate.reactionFileStorageId) === file;
  }
  const lowCode = mapping.lowCodeReactionRequestBase;
  const candidateLowCode = candidate.lowCodeReactionRequestBase;
  if (!isObject(lowCode) || !isObject(candidateLowCode) || lowCode.name !== candidateLowCode.name) {
    return false;
  }
  const { regenerate: _a, ...parameters } = lowCode;
  const { regenerate: _b, ...candidateParameters } = candidateLowCode;
  return !exact || canonical(parameters) === canonical(candidateParameters);
}

const NOT_DELETED = { softDeleted: false, softDeletedVia: null };

function element<T>(fields: T): YMap<unknown> {
  return new Y.Map<unknown>(Object.entries(fields as Record<string, unknown>));
}

/** Reads a field of an element. The key must be a field of `T`, so renaming a field is noticed. */
function field<T>(element: YMap<unknown>, key: keyof T & string): unknown {
  return element.get(key);
}

/** Sets a value, unless Yjs can't store it, in which case its path is added to `skipped`. */
function setIfStorable(
  map: YMap<unknown>,
  key: string,
  value: unknown,
  path: string,
  skipped: string[],
): void {
  try {
    map.set(key, value);
  } catch {
    skipped.push(path);
  }
}

/** Library ID of a metamodel. The backend uses the copy's own ID if it has no library entry. */
function libraryId(metaModel: MetaModelDetails): number | null {
  return idOrNull(metaModel.sourceId) ?? idOrNull(metaModel.id);
}

function viewMetaModelIds(view: ViewDetails): number[] {
  return ids((view.assignedModels ?? []).map(libraryId));
}

/** The distinct IDs among the values, sorted. */
function ids(values: unknown): number[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.filter(isId))].sort((a, b) => a - b);
}

function isId(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function idOrNull(value: unknown): number | null {
  return isId(value) ? value : null;
}

/** The ID in a key of the `models` map, or `null` if the key isn't one. */
function parseId(key: string): number | null {
  return /^\d{1,15}$/.test(key) ? Number(key) : null;
}

function pairKey(sourceId: number, targetId: number): string {
  return `${sourceId}:${targetId}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (isObject(value) && Object.keys(value).length === 0);
}

/** A copy of a value as JSON, or `undefined` if it can't be one (e.g. a BigInt or deep nesting). */
function asJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function withoutId(mapping: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = mapping;
  return rest;
}

function copyMappings(mappings: FineGranularDetails[] | null | undefined): FineGranularDetails[] {
  return (mappings ?? []).filter(isObject).map((mapping) => structuredClone(mapping));
}

/** The entries of a map, sorted by key, so that requests don't depend on the order of changes. */
function sortedEntries(map: YMap<unknown>): [string, unknown][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function setIfChanged(map: YMap<unknown>, key: string, value: unknown): void {
  if (map.get(key) !== value) {
    map.set(key, value);
  }
}

/** Removes the backend IDs that the backend doesn't have from the elements of a map. */
function forgetUnknownIds(elements: YMap<unknown>, backendIds: Set<number>): void {
  for (const value of elements.values()) {
    if (value instanceof Y.Map) {
      const backendId = value.get('backendId');
      if (isId(backendId) && !backendIds.has(backendId)) {
        value.set('backendId', null);
      }
    }
  }
}

/** Whether two arrays have the same elements, regardless of their order. */
function isSameSet(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sorted = (values: unknown[]) => values.map(canonical).sort().join(',');
  return sorted(a) === sorted(b);
}

/** A JSON-like text of a value that doesn't depend on the order of object keys. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return typeof value === 'bigint' ? `${value}n` : (JSON.stringify(value) ?? 'undefined');
}
