import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc, Map as YMap } from 'yjs';
import type { ProjectDetails } from '../src/backend.js';
import {
  applyBackendState,
  DocumentError,
  fillDocument,
  SERVER_ORIGIN,
  setWritebackError,
  toSyncChanges,
} from '../src/projectSync.js';
import { Y } from '../src/yjs.js';
import { FakeProjects, type StoredProject } from './fakeProjects.js';

const LOW_CODE = { name: 'create_corresponding_root_on_insert_root', regenerate: false };

/** A project with three metamodels, two relations (one with a fine-granular mapping) and two views. */
const STORED: Partial<StoredProject> = {
  name: 'Brakes',
  metaModels: [
    { id: 101, sourceId: 1, name: 'Car' },
    { id: 102, sourceId: 2, name: 'Brake' },
    { id: 103, sourceId: 3, name: 'Wheel' },
  ],
  relations: [
    { id: 7, sourceId: 1, targetId: 2, reactionFileStorageId: 50, fineGranularMetaModelRelationSet: [] },
    {
      id: 8,
      sourceId: 2,
      targetId: 3,
      reactionFileStorageId: null,
      fineGranularMetaModelRelationSet: [
        { id: 81, sourceId: 'a', targetId: 'b', reactionFileStorageId: 60, lowCodeReactionRequestBase: LOW_CODE },
      ],
    },
  ],
  views: [
    { id: 20, name: 'Overview', description: 'All parts', fileStorageId: 70, metaModelIds: [1, 2] },
    { id: 21, name: 'Empty', description: null, fileStorageId: 71, metaModelIds: [] },
  ],
  layout: { metaModels: { '1': { x: 10, y: 20 } }, reactions: { '1': { bbox: { x: 0, y: 0 } } }, zoom: 1.5 },
};

let backend: FakeProjects;
let project: ProjectDetails;
let doc: Doc;

beforeEach(async () => {
  backend = new FakeProjects();
  backend.add('12', STORED);
  project = await backend.getProject('12');
  doc = new Y.Doc();
  fillDocument(doc, project);
});

const models = () => doc.getMap(MODELS_NAME) as YMap<YMap<unknown>>;
const relations = () => doc.getMap('relations') as YMap<YMap<unknown>>;
const views = () => doc.getMap('views') as YMap<YMap<unknown>>;
const MODELS_NAME = 'models';

/** Adds an element to a top-level map, as a client would. */
function add(map: YMap<YMap<unknown>>, key: string, fields: Record<string, unknown>): YMap<unknown> {
  const element = new Y.Map<unknown>(Object.entries({ softDeleted: false, softDeletedVia: null, ...fields }));
  map.set(key, element);
  return element;
}

/** Writes the document back to the fake backend and brings the answer into the document. */
async function writeBack(): Promise<void> {
  const { changes, sent } = toSyncChanges(doc, project);
  await backend.syncChanges('12', changes);
  project = await backend.getProject('12');
  applyBackendState(doc, sent, project, { applied: true });
}

describe('loading a project', () => {
  it('fills models, relations, views, layout and status', () => {
    expect(doc.toJSON()).toEqual({
      models: {
        '1': { name: 'Car', softDeleted: false, softDeletedVia: null },
        '2': { name: 'Brake', softDeleted: false, softDeletedVia: null },
        '3': { name: 'Wheel', softDeleted: false, softDeletedVia: null },
      },
      relations: {
        '7': {
          backendId: 7,
          sourceId: 1,
          targetId: 2,
          reactionFileId: 50,
          fineGranular: [],
          softDeleted: false,
          softDeletedVia: null,
        },
        '8': {
          backendId: 8,
          sourceId: 2,
          targetId: 3,
          reactionFileId: null,
          fineGranular: [
            { id: 81, sourceId: 'a', targetId: 'b', reactionFileStorageId: 60, lowCodeReactionRequestBase: LOW_CODE },
          ],
          softDeleted: false,
          softDeletedVia: null,
        },
      },
      views: {
        '20': {
          backendId: 20,
          name: 'Overview',
          description: 'All parts',
          fileStorageId: 70,
          metaModelIds: [1, 2],
          softDeleted: false,
          softDeletedVia: null,
        },
        '21': {
          backendId: 21,
          name: 'Empty',
          description: '',
          fileStorageId: 71,
          metaModelIds: [],
          softDeleted: false,
          softDeletedVia: null,
        },
      },
      layout: { metaModels: { '1': { x: 10, y: 20 } }, reactions: { '1': { bbox: { x: 0, y: 0 } } }, zoom: 1.5 },
      status: { writebackError: null },
    });
  });

  it('uses Yjs types for elements, descriptions and the layout maps', () => {
    expect(models().get('1')).toBeInstanceOf(Y.Map);
    expect(views().get('20')?.get('description')).toBeInstanceOf(Y.Text);
    expect(doc.getMap('layout').get('metaModels')).toBeInstanceOf(Y.Map);
    expect(doc.getMap('layout').get('reactions')).toBeInstanceOf(Y.Map);
  });

  it('creates the layout maps also for a project without layout', () => {
    const empty = new Y.Doc();

    fillDocument(empty, { id: 13, name: 'New', layout: null });

    expect(empty.getMap('layout').toJSON()).toEqual({ metaModels: {}, reactions: {} });
    expect(empty.getMap('layout').get('metaModels')).toBeInstanceOf(Y.Map);
  });

  it('is one change with the server origin', () => {
    const origins: unknown[] = [];
    const other = new Y.Doc();
    other.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));

    fillDocument(other, project);

    expect(origins).toEqual([SERVER_ORIGIN]);
  });

  it('keys metamodels by library ID, also for views', async () => {
    backend.add('14', { metaModels: [{ id: 500, sourceId: 5, name: 'Engine' }] });
    backend.projects.get('14')?.views.push({ id: 30, name: 'V', description: null, fileStorageId: 1, metaModelIds: [5] });
    const other = new Y.Doc();

    fillDocument(other, await backend.getProject('14'));

    expect(Object.keys(other.getMap('models').toJSON())).toEqual(['5']);
    expect((other.getMap('views').get('30') as YMap<unknown>).get('metaModelIds')).toEqual([5]);
  });
});

describe('writing back an unchanged project', () => {
  it('sends the loaded state', () => {
    expect(toSyncChanges(doc, project).changes).toEqual({
      metaModelIds: [1, 2, 3],
      metaModelNames: { '1': 'Car', '2': 'Brake', '3': 'Wheel' },
      metaModelRelationRequests: [
        { sourceId: 1, targetId: 2, reactionFileId: 50, fineGranularMetaModelRelationSet: [] },
        {
          sourceId: 2,
          targetId: 3,
          reactionFileId: null,
          fineGranularMetaModelRelationSet: [
            { id: 81, sourceId: 'a', targetId: 'b', reactionFileStorageId: 60, lowCodeReactionRequestBase: LOW_CODE },
          ],
        },
      ],
      viewRequests: [
        { id: 20, name: 'Overview', description: 'All parts', fileStorageId: 70, metaModelIds: [1, 2] },
        { id: 21, name: 'Empty', description: '', fileStorageId: 71, metaModelIds: [] },
      ],
      layout: { metaModels: { '1': { x: 10, y: 20 } }, reactions: { '1': { bbox: { x: 0, y: 0 } } }, zoom: 1.5 },
    });
  });

  it('changes nothing in the backend and keeps all IDs', async () => {
    await writeBack();
    await writeBack();

    expect(backend.changes).toEqual([]);
    expect(relations().get('7')?.get('backendId')).toBe(7);
    expect(views().get('20')?.get('backendId')).toBe(20);
  });

  it('sends no layout if there is none, so the backend keeps its own', async () => {
    const other = new Y.Doc();
    fillDocument(other, { id: 13, name: 'New', layout: null });

    expect(toSyncChanges(other, { id: 13, name: 'New' }).changes.layout).toBeUndefined();
  });

  it('always sends viewRequests, also when there are no views', () => {
    const other = new Y.Doc();
    fillDocument(other, { id: 13, name: 'New' });

    expect(toSyncChanges(other, { id: 13, name: 'New' }).changes).toEqual({
      metaModelIds: [],
      metaModelNames: {},
      metaModelRelationRequests: [],
      viewRequests: [],
    });
  });
});

describe('writing back changes', () => {
  it('leaves out soft-deleted metamodels and the relations to them', async () => {
    models().get('3')?.set('softDeleted', true);

    const { changes } = toSyncChanges(doc, project);

    expect(changes.metaModelIds).toEqual([1, 2]);
    expect(changes.metaModelNames).toEqual({ '1': 'Car', '2': 'Brake' });
    // Relation 8 (2 → 3) isn't soft-deleted itself, but its target is.
    expect(changes.metaModelRelationRequests.map((relation) => relation.targetId)).toEqual([2]);
    await backend.syncChanges('12', changes);
    expect(backend.changes).toEqual(['delete model 3', 'delete relation 8']);
  });

  it('leaves out soft-deleted relations and views', () => {
    relations().get('7')?.set('softDeleted', true);
    views().get('21')?.set('softDeleted', true);

    const { changes } = toSyncChanges(doc, project);

    expect(changes.metaModelRelationRequests.map((relation) => relation.sourceId)).toEqual([2]);
    expect(changes.viewRequests.map((view) => view.id)).toEqual([20]);
  });

  it('leaves out metamodel names that are blank, so the backend keeps the name', () => {
    models().get('1')?.set('name', '  ');

    expect(toSyncChanges(doc, project).changes.metaModelNames).toEqual({ '2': 'Brake', '3': 'Wheel' });
  });

  it('adds a new metamodel', async () => {
    add(models(), '4', { name: 'Seat' });

    await writeBack();

    expect(backend.changes).toEqual(['add model 4']);
    expect(backend.projects.get('12')?.metaModels.at(-1)).toMatchObject({ sourceId: 4, name: 'Seat' });
  });

  it('creates a new relation once and fills in its backend ID', async () => {
    const relation = add(relations(), 'new-1', { backendId: null, sourceId: 1, targetId: 3, reactionFileId: 51, fineGranular: [] });

    await writeBack();
    await writeBack();

    expect(backend.changes).toEqual(['create relation 1000']);
    expect(relation.get('backendId')).toBe(1000);
  });

  it('leaves out a new relation without reaction file and mappings until it has one', async () => {
    const relation = add(relations(), 'new-1', { backendId: null, sourceId: 1, targetId: 3, reactionFileId: null, fineGranular: [] });

    await writeBack();
    expect(backend.changes).toEqual([]);

    relation.set('reactionFileId', 52);
    await writeBack();
    expect(backend.changes).toEqual(['create relation 1000']);
  });

  it('still sends a relation the backend has when it loses its reaction file, so it is not deleted', () => {
    relations().get('7')?.set('reactionFileId', null);

    expect(toSyncChanges(doc, project).changes.metaModelRelationRequests[0]).toEqual({
      sourceId: 1,
      targetId: 2,
      reactionFileId: null,
      fineGranularMetaModelRelationSet: [],
    });
  });

  it('sends one relation per pair of metamodels: the one the backend has', () => {
    add(relations(), '0-duplicate', { backendId: null, sourceId: 1, targetId: 2, reactionFileId: 99, fineGranular: [] });

    const { changes, sent } = toSyncChanges(doc, project);

    expect(changes.metaModelRelationRequests.filter((relation) => relation.sourceId === 1)).toEqual([
      { sourceId: 1, targetId: 2, reactionFileId: 50, fineGranularMetaModelRelationSet: [] },
    ]);
    expect([...sent.relations.keys()]).toEqual(['7', '8']);
  });

  it('sends one relation per pair of metamodels: the one with the smallest key if the backend has none', () => {
    add(relations(), 'b', { backendId: null, sourceId: 3, targetId: 1, reactionFileId: 2, fineGranular: [] });
    add(relations(), 'a', { backendId: null, sourceId: 3, targetId: 1, reactionFileId: 1, fineGranular: [] });

    const requests = toSyncChanges(doc, project).changes.metaModelRelationRequests;

    expect(requests.filter((relation) => relation.sourceId === 3)).toEqual([
      { sourceId: 3, targetId: 1, reactionFileId: 1, fineGranularMetaModelRelationSet: [] },
    ]);
  });

  it('creates a low-code mapping once and brings its ID and generated file into the document', async () => {
    const mapping = { sourceId: 'c', targetId: 'd', lowCodeReactionRequestBase: LOW_CODE };
    relations().get('7')?.set('fineGranular', [mapping]);

    await writeBack();
    await writeBack();

    expect(backend.changes).toEqual(['create mapping 1001']);
    expect(relations().get('7')?.get('fineGranular')).toEqual([
      { ...mapping, id: 1001, reactionFileStorageId: 1000 },
    ]);
  });

  it('keeps mappings that changed while they were written back', async () => {
    relations().get('7')?.set('fineGranular', [{ sourceId: 'c', targetId: 'd', reactionFileStorageId: 61 }]);
    const { changes, sent } = toSyncChanges(doc, project);
    await backend.syncChanges('12', changes);
    const edited = [{ sourceId: 'c', targetId: 'e', reactionFileStorageId: 61 }];
    relations().get('7')?.set('fineGranular', edited);

    applyBackendState(doc, sent, await backend.getProject('12'), { applied: true });

    expect(relations().get('7')?.get('fineGranular')).toEqual(edited);
  });

  it('leaves out mapping IDs the backend does not have, e.g. after restoring a deleted relation', async () => {
    relations().get('8')?.set('softDeleted', true);
    await writeBack();
    expect(backend.changes).toEqual(['delete relation 8']);

    relations().get('8')?.set('softDeleted', false);
    await writeBack();

    expect(backend.changes.slice(1)).toEqual(['create relation 1000', 'create mapping 1001']);
    expect(relations().get('8')?.get('backendId')).toBe(1000);
  });

  it('forgets backend IDs the backend no longer has', async () => {
    relations().get('8')?.set('softDeleted', true);
    views().get('21')?.set('softDeleted', true);

    await writeBack();

    expect(relations().get('8')?.get('backendId')).toBeNull();
    expect(views().get('21')?.get('backendId')).toBeNull();
  });

  it('renames a view and keeps its ID', async () => {
    views().get('20')?.set('name', 'All parts');

    await writeBack();

    expect(backend.changes).toEqual(['update view 20']);
    expect(backend.projects.get('12')?.views[0]).toMatchObject({ id: 20, name: 'All parts' });
  });

  it('sends a view description character by character edited, and "" for none', () => {
    const description = views().get('20')?.get('description') as InstanceType<typeof Y.Text>;
    description.insert(9, ' of the car');
    views().get('21')?.set('description', new Y.Text());

    const viewRequests = toSyncChanges(doc, project).changes.viewRequests;

    expect(viewRequests.map((view) => view.description)).toEqual(['All parts of the car', '']);
  });

  it('creates a new view once, fills in its ID and keeps it when the view is renamed', async () => {
    const view = add(views(), 'new-view', {
      backendId: null,
      name: 'Details',
      description: new Y.Text('Brake details'),
      fileStorageId: 72,
      metaModelIds: [2],
    });

    await writeBack();
    view.set('name', 'Brake details');
    await writeBack();

    expect(backend.changes).toEqual(['create view 1000', 'update view 1000']);
    expect(view.get('backendId')).toBe(1000);
  });

  it('finds a new view by the name it was sent with, even if it was renamed meanwhile', async () => {
    const view = add(views(), 'new-view', { backendId: null, name: 'Details', description: new Y.Text(), fileStorageId: 72, metaModelIds: [] });
    const { changes, sent } = toSyncChanges(doc, project);
    await backend.syncChanges('12', changes);
    view.set('name', 'Renamed');

    applyBackendState(doc, sent, await backend.getProject('12'), { applied: true });

    expect(view.get('backendId')).toBe(1000);
  });

  it('gives a new view without name the name the backend gave it', async () => {
    const view = add(views(), 'new-view', { backendId: null, name: '', description: new Y.Text(), fileStorageId: 73, metaModelIds: [1, 3] });

    await writeBack();
    await writeBack();

    expect(view.toJSON()).toMatchObject({ backendId: 1000, name: 'file-73' });
    expect(backend.changes).toEqual(['create view 1000']);
  });

  it('leaves out a new view without file', () => {
    add(views(), 'new-view', { backendId: null, name: 'Draft', description: new Y.Text(), fileStorageId: null, metaModelIds: [] });

    expect(toSyncChanges(doc, project).changes.viewRequests.map((view) => view.name)).toEqual(['Overview', 'Empty']);
  });

  it('sends the backend ID of a view only once, also if two views have it', () => {
    add(views(), '20-copy', { backendId: 20, name: 'Copy', description: new Y.Text(), fileStorageId: 70, metaModelIds: [] });

    const viewRequests = toSyncChanges(doc, project).changes.viewRequests;

    expect(viewRequests.map((view) => [view.id, view.name])).toEqual([
      [20, 'Overview'],
      [undefined, 'Copy'],
      [21, 'Empty'],
    ]);
  });

  it('sends the whole layout with new positions', () => {
    const positions = doc.getMap('layout').get('metaModels') as YMap<unknown>;
    positions.set('2', { x: 1, y: 2 });

    expect(toSyncChanges(doc, project).changes.layout).toEqual({
      metaModels: { '1': { x: 10, y: 20 }, '2': { x: 1, y: 2 } },
      reactions: { '1': { bbox: { x: 0, y: 0 } } },
      zoom: 1.5,
    });
  });

  it('fills in backend IDs with the server origin', async () => {
    add(relations(), 'new-1', { backendId: null, sourceId: 1, targetId: 3, reactionFileId: 51, fineGranular: [] });
    const { changes, sent } = toSyncChanges(doc, project);
    await backend.syncChanges('12', changes);
    const origins: unknown[] = [];
    doc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));

    applyBackendState(doc, sent, await backend.getProject('12'), { applied: true });

    expect(origins).toEqual([SERVER_ORIGIN]);
  });
});

describe('the writeback error', () => {
  it('is set and cleared with the server origin, and only when it changes', () => {
    const origins: unknown[] = [];
    doc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));

    setWritebackError(doc, 'Invalid');
    setWritebackError(doc, 'Invalid');
    setWritebackError(doc, null);
    setWritebackError(doc, null);

    expect(origins).toEqual([SERVER_ORIGIN, SERVER_ORIGIN]);
    expect(doc.getMap('status').get('writebackError')).toBeNull();
  });

  it('is never written back', () => {
    setWritebackError(doc, 'Invalid');

    expect(JSON.stringify(toSyncChanges(doc, project).changes)).not.toContain('Invalid');
  });
});

describe('fine-granular mappings', () => {
  /** The mappings of relation 7 in the document. */
  const mappingsOf7 = () => relations().get('7')?.get('fineGranular');

  it('keep what a failed writeback did not save', async () => {
    const added = { sourceId: 'c', targetId: 'd', reactionFileStorageId: 61 };
    relations().get('7')?.set('fineGranular', [added]);
    const { sent } = toSyncChanges(doc, project);

    // The request failed, so the backend still has relation 7 without mappings.
    applyBackendState(doc, sent, await backend.getProject('12'), { applied: false });

    expect(mappingsOf7()).toEqual([added]);
  });

  it("don't come back after a user deleted them and the writeback failed", async () => {
    relations().get('8')?.set('fineGranular', []);
    const { sent } = toSyncChanges(doc, project);

    applyBackendState(doc, sent, await backend.getProject('12'), { applied: false });

    expect(relations().get('8')?.get('fineGranular')).toEqual([]);
  });

  it('get their ID also if the outcome of the writeback is unknown', async () => {
    const added = { sourceId: 'c', targetId: 'd', reactionFileStorageId: 61 };
    relations().get('7')?.set('fineGranular', [added]);
    const { changes, sent } = toSyncChanges(doc, project);
    await backend.syncChanges('12', changes);

    // E.g. the request timed out after the backend applied it.
    applyBackendState(doc, sent, await backend.getProject('12'), { applied: false });

    expect(mappingsOf7()).toEqual([{ ...added, id: 1000 }]);
  });

  it('get their ID and generated file also if other mappings changed during the writeback', async () => {
    const first = { sourceId: 'c', targetId: 'd', lowCodeReactionRequestBase: LOW_CODE };
    relations().get('7')?.set('fineGranular', [first]);
    const { changes, sent } = toSyncChanges(doc, project);
    await backend.syncChanges('12', changes);
    const second = { sourceId: 'e', targetId: 'f', reactionFileStorageId: 62 };
    relations().get('7')?.set('fineGranular', [first, second]);

    applyBackendState(doc, sent, await backend.getProject('12'), { applied: true });
    await writeBack();

    expect(mappingsOf7()).toEqual([
      { ...first, id: 1001, reactionFileStorageId: 1000 },
      { ...second, id: 1002 },
    ]);
    expect(backend.changes).toEqual(['create mapping 1001', 'create mapping 1002']);
  });

  it("keep a user's edit of an existing mapping", async () => {
    const edited = { id: 81, sourceId: 'a', targetId: 'z', reactionFileStorageId: 61, lowCodeReactionRequestBase: LOW_CODE };
    relations().get('8')?.set('fineGranular', [edited]);

    await writeBack();

    expect(backend.changes).toEqual(['update mapping 81']);
    expect(relations().get('8')?.get('fineGranular')).toEqual([edited]);
  });

  it('are regenerated once: regenerate is set back to false after a successful writeback', async () => {
    const regenerate = { ...LOW_CODE, regenerate: true };
    relations().get('8')?.set('fineGranular', [
      { id: 81, sourceId: 'a', targetId: 'b', reactionFileStorageId: 60, lowCodeReactionRequestBase: regenerate },
    ]);

    await writeBack();
    await writeBack();

    expect(backend.changes).toEqual(['regenerate mapping 81']);
    expect(relations().get('8')?.get('fineGranular')).toMatchObject([
      { id: 81, lowCodeReactionRequestBase: { regenerate: false } },
    ]);
  });

  it('keep regenerate if the writeback failed or the mapping changed meanwhile', async () => {
    const regenerating = (targetId: string) => ({
      id: 81,
      sourceId: 'a',
      targetId,
      reactionFileStorageId: 60,
      lowCodeReactionRequestBase: { ...LOW_CODE, regenerate: true },
    });
    relations().get('8')?.set('fineGranular', [regenerating('b')]);
    const failed = toSyncChanges(doc, project);
    applyBackendState(doc, failed.sent, await backend.getProject('12'), { applied: false });
    expect(relations().get('8')?.get('fineGranular')).toEqual([regenerating('b')]);

    const { changes, sent } = toSyncChanges(doc, project);
    await backend.syncChanges('12', changes);
    relations().get('8')?.set('fineGranular', [regenerating('c')]);
    applyBackendState(doc, sent, await backend.getProject('12'), { applied: true });

    expect(relations().get('8')?.get('fineGranular')).toEqual([regenerating('c')]);
  });

  it('are not touched when the backend has exactly what was sent', async () => {
    const { changes, sent } = toSyncChanges(doc, project);
    await backend.syncChanges('12', changes);
    const origins: unknown[] = [];
    doc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));

    applyBackendState(doc, sent, await backend.getProject('12'), { applied: true });

    expect(origins).toEqual([]);
  });

  it("are not touched if the backend's relation has another reaction file than the one sent", async () => {
    const mapping = { sourceId: 'c', targetId: 'd', reactionFileStorageId: 61 };
    relations().get('7')?.set('reactionFileId', 51);
    relations().get('7')?.set('fineGranular', [mapping]);
    const { sent } = toSyncChanges(doc, project);

    applyBackendState(doc, sent, await backend.getProject('12'), { applied: false });

    expect(relations().get('7')?.toJSON()).toMatchObject({ reactionFileId: 51, fineGranular: [mapping] });
  });
});

describe('choosing what to send', () => {
  it('sends the duplicate of a new relation that has a reaction file, not an empty one with a smaller key', async () => {
    add(relations(), 'a-empty', { backendId: null, sourceId: 1, targetId: 3, reactionFileId: null, fineGranular: [] });
    const complete = add(relations(), 'b-complete', { backendId: null, sourceId: 1, targetId: 3, reactionFileId: 52, fineGranular: [] });

    await writeBack();

    expect(backend.changes).toEqual(['create relation 1000']);
    expect(complete.get('backendId')).toBe(1000);
  });

  it('gives a new view without name that repeats the file and metamodels of another view its own ID', async () => {
    const view = add(views(), 'new-view', { backendId: null, name: '', description: new Y.Text(), fileStorageId: 70, metaModelIds: [1, 2] });

    await writeBack();

    expect(view.toJSON()).toMatchObject({ backendId: 1000, name: 'file-70' });
    expect(views().get('20')?.get('backendId')).toBe(20);
  });

  it('still sends a view the backend has when it loses its file, so it is not deleted', () => {
    views().get('21')?.set('fileStorageId', null);

    const viewRequests = toSyncChanges(doc, project).changes.viewRequests;

    expect(viewRequests.map((view) => [view.id, view.fileStorageId])).toEqual([
      [20, 70],
      [21, null],
    ]);
  });

  it('leaves out a view without file whose backend ID the backend no longer has', () => {
    add(views(), 'old', { backendId: 99, name: 'Old', description: new Y.Text(), fileStorageId: null, metaModelIds: [] });

    expect(toSyncChanges(doc, project).changes.viewRequests.map((view) => view.name)).toEqual(['Overview', 'Empty']);
  });

  it('leaves out a new view without name and metamodels, which the backend would ignore', () => {
    add(views(), 'new-view', { backendId: null, name: ' ', description: new Y.Text(), fileStorageId: 74, metaModelIds: [] });

    expect(toSyncChanges(doc, project).changes.viewRequests).toHaveLength(2);
  });
});

describe('elements the server cannot read', () => {
  /** The problems toSyncChanges reports, or `[]` if it builds a request. */
  function problems(): string[] {
    try {
      toSyncChanges(doc, project);
      return [];
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentError);
      return (error as DocumentError).problems;
    }
  }

  it('stop the writeback if the backend has them, instead of deleting them', () => {
    relations().get('8')?.set('sourceId', '2');
    views().get('20')?.set('metaModelIds', ['1']);
    models().set('3', { name: 'Wheel' } as unknown as YMap<unknown>);

    expect(problems()).toEqual([
      "metamodel 3 can't be read",
      "relation 8 can't be read",
      "view 20 can't be read",
    ]);
  });

  it('stop the writeback if the fine-granular mappings of a relation the backend has are no array', () => {
    relations().get('8')?.set('fineGranular', new Y.Array());

    expect(problems()).toEqual(["relation 8 can't be read"]);
  });

  it('are left out if they are new', () => {
    add(relations(), 'new-1', { backendId: null, sourceId: '1', targetId: 3, reactionFileId: 51, fineGranular: [] });
    add(views(), 'new-view', { backendId: null, name: 'New', description: 5, fileStorageId: 72, metaModelIds: [] });

    expect(problems()).toEqual([]);
    expect(toSyncChanges(doc, project).changes.metaModelRelationRequests).toHaveLength(2);
  });

  it("stop the writeback if a value isn't JSON", () => {
    (doc.getMap('layout').get('metaModels') as YMap<unknown>).set('2', { x: 10n, y: 0 });

    expect(problems()).toEqual(["the layout has values that aren't JSON"]);
  });
});

describe('loading a layout that Yjs cannot store', () => {
  it('leaves out the entries Yjs rejects and keeps the rest', async () => {
    backend.add('15', {
      layout: { metaModels: { '1': { x: 1, y: 2 }, '2': { constructor: 'x' } }, note: { constructor: 'y' }, zoom: 2 },
    });
    const other = new Y.Doc();

    const skipped = fillDocument(other, await backend.getProject('15'));

    expect(skipped).toEqual(['note', 'metaModels.2']);
    expect(other.getMap('layout').toJSON()).toEqual({ zoom: 2, metaModels: { '1': { x: 1, y: 2 } }, reactions: {} });
  });
});


describe('matching fine-granular mappings', () => {
  const mappingsOf7 = () => relations().get('7')?.get('fineGranular');

  /**
   * Rewrites the stored templates as the backend returns them: it rebuilds them from the stored
   * parameters with `regenerate: false` and every field of the template's DTO, `missing` ones as null.
   */
  function storeTemplatesAsTheBackendReturnsThem(missing: Record<string, unknown> = {}): void {
    for (const relation of backend.projects.get('12')?.relations ?? []) {
      for (const mapping of relation.fineGranularMetaModelRelationSet ?? []) {
        const lowCode = mapping.lowCodeReactionRequestBase;
        if (typeof lowCode === 'object' && lowCode !== null) {
          mapping.lowCodeReactionRequestBase = { ...missing, ...lowCode, regenerate: false };
        }
      }
    }
  }

  /** The backend keeps a relation's mappings in a set, so it may return them in any order. */
  function reverseStoredMappings(relationId: number): void {
    backend.projects
      .get('12')
      ?.relations.find((relation) => relation.id === relationId)
      ?.fineGranularMetaModelRelationSet?.reverse();
  }

  /** Like writeBack, but `changeStored` changes what the backend stored before it is loaded again. */
  async function writeBackWith(changeStored: () => void): Promise<void> {
    const { changes, sent } = toSyncChanges(doc, project);
    await backend.syncChanges('12', changes);
    changeStored();
    project = await backend.getProject('12');
    applyBackendState(doc, sent, project, { applied: true });
  }

  it("don't take the ID of a mapping that has one already, also if only the template's name matches", async () => {
    const existing = { id: 81, sourceId: 'a', targetId: 'b', reactionFileStorageId: 60, lowCodeReactionRequestBase: LOW_CODE };
    const added = { sourceId: 'a', targetId: 'b', lowCodeReactionRequestBase: { ...LOW_CODE, reactionName: 'second' } };
    relations().get('8')?.set('fineGranular', [existing, added]);

    await writeBackWith(() => storeTemplatesAsTheBackendReturnsThem({ model1Uri: null }));

    expect(relations().get('8')?.get('fineGranular')).toEqual([
      existing,
      { ...added, id: 1001, reactionFileStorageId: 1000 },
    ]);
  });

  it("give two new mappings with the same template their own IDs, also if only the template's name matches", async () => {
    const first = { sourceId: 'c', targetId: 'd', lowCodeReactionRequestBase: { ...LOW_CODE, reactionName: 'first' } };
    const second = { sourceId: 'c', targetId: 'd', lowCodeReactionRequestBase: { ...LOW_CODE, reactionName: 'second' } };
    relations().get('7')?.set('fineGranular', [first, second]);

    await writeBackWith(() => storeTemplatesAsTheBackendReturnsThem({ model1Uri: null }));

    expect(mappingsOf7()).toEqual([
      { ...first, id: 1001, reactionFileStorageId: 1000 },
      { ...second, id: 1003, reactionFileStorageId: 1002 },
    ]);
  });

  it('match new mappings by their template parameters, whatever order the backend returns them in', async () => {
    const mapping = (reactionName: string, regenerate: boolean) => ({
      sourceId: 'c',
      targetId: 'd',
      lowCodeReactionRequestBase: { ...LOW_CODE, reactionName, regenerate },
    });
    relations().get('7')?.set('fineGranular', [mapping('first', true), mapping('second', true)]);

    await writeBackWith(() => {
      storeTemplatesAsTheBackendReturnsThem();
      reverseStoredMappings(7);
    });

    expect(mappingsOf7()).toEqual([
      { ...mapping('first', false), id: 1001, reactionFileStorageId: 1000 },
      { ...mapping('second', false), id: 1003, reactionFileStorageId: 1002 },
    ]);
  });

  it("match new mappings by their template's name if the backend returns the parameters in another form", async () => {
    const create = { sourceId: 'c', targetId: 'd', lowCodeReactionRequestBase: LOW_CODE };
    const composite = { sourceId: 'c', targetId: 'd', lowCodeReactionRequestBase: { name: 'composite_reactions', regenerate: false } };
    relations().get('7')?.set('fineGranular', [create, composite]);

    await writeBackWith(() => {
      storeTemplatesAsTheBackendReturnsThem({ model1Uri: null });
      reverseStoredMappings(7);
    });

    expect(mappingsOf7()).toEqual([
      { ...create, id: 1001, reactionFileStorageId: 1000 },
      { ...composite, id: 1003, reactionFileStorageId: 1002 },
    ]);
  });

  it('match new mappings with a reaction file by that file, whatever order the backend returns them in', async () => {
    const first = { sourceId: 'c', targetId: 'd', reactionFileStorageId: 61 };
    const second = { sourceId: 'c', targetId: 'd', reactionFileStorageId: 62 };
    relations().get('7')?.set('fineGranular', [first, second]);

    await writeBackWith(() => reverseStoredMappings(7));

    expect(mappingsOf7()).toEqual([
      { ...first, id: 1000 },
      { ...second, id: 1001 },
    ]);
  });

  it('set regenerate back to false also for a new mapping that got its ID in the same writeback', async () => {
    const added = { sourceId: 'c', targetId: 'd', lowCodeReactionRequestBase: { ...LOW_CODE, regenerate: true } };
    relations().get('7')?.set('fineGranular', [added]);

    await writeBack();
    await writeBack();

    expect(backend.changes).toEqual(['create mapping 1001']);
    expect(mappingsOf7()).toEqual([
      { ...added, id: 1001, reactionFileStorageId: 1000, lowCodeReactionRequestBase: LOW_CODE },
    ]);
  });

  it("don't give a sent relation the ID of the backend's relation with another reaction file", async () => {
    const relation = add(relations(), 'new-1', { backendId: null, sourceId: 1, targetId: 3, reactionFileId: 51, fineGranular: [] });
    const { sent } = toSyncChanges(doc, project);
    backend.projects.get('12')?.relations.push({
      id: 900,
      sourceId: 1,
      targetId: 3,
      reactionFileStorageId: 99,
      fineGranularMetaModelRelationSet: [],
    });

    applyBackendState(doc, sent, await backend.getProject('12'), { applied: false });

    expect(relation.get('backendId')).toBeNull();
  });
});

describe('more elements the server cannot read', () => {
  function problems(): string[] {
    try {
      toSyncChanges(doc, project);
      return [];
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentError);
      return (error as DocumentError).problems;
    }
  }

  /** A value that is no Y.Map, set where the document expects one. */
  const plain = (fields: Record<string, unknown>) => fields as unknown as YMap<unknown>;

  it('stop the writeback if a relation or view the backend has is no Y.Map', () => {
    relations().set('8', plain({ sourceId: 2, targetId: 3 }));
    views().set('20', plain({ name: 'Overview' }));

    expect(problems()).toEqual(["relation 8 can't be read", "view 20 can't be read"]);
  });

  it('stop the writeback if a field of an element the backend has has the wrong type', () => {
    relations().get('7')?.set('reactionFileId', '50');
    relations().get('8')?.set('fineGranular', ['not a mapping']);
    views().get('20')?.set('fileStorageId', '70');

    expect(problems()).toEqual([
      "relation 7 can't be read",
      "relation 8 can't be read",
      "view 20 can't be read",
    ]);
  });

  it("are left out if the backend doesn't have them, also if they are no Y.Map", () => {
    models().set('4', plain({ name: 'Seat' }));
    relations().set('new-2', plain({ sourceId: 1, targetId: 3 }));
    views().set('new-view-2', plain({ name: 'New' }));
    add(relations(), 'stale', { backendId: 99, sourceId: '1', targetId: 3, reactionFileId: 51, fineGranular: [] });

    expect(problems()).toEqual([]);
    expect(toSyncChanges(doc, project).changes.metaModelIds).toEqual([1, 2, 3]);
  });

  it("stop the writeback if fine-granular mappings aren't JSON", () => {
    relations().get('8')?.set('fineGranular', [
      { id: 81, sourceId: 'a', targetId: 'b', reactionFileStorageId: 60, priority: 1n },
    ]);

    expect(problems()).toEqual(["relation 8 has fine-granular mappings that aren't JSON"]);
  });
});

describe('mappings and relations that are not finished yet', () => {
  it('leaves out a new mapping that is drawn but not configured, and sends the rest', async () => {
    const drawn = { sourceId: 'c', targetId: 'd' };
    const configured = { sourceId: 'e', targetId: 'f', reactionFileStorageId: 62 };
    relations().get('7')?.set('fineGranular', [drawn, configured]);

    await writeBack();

    expect(backend.changes).toEqual(['create mapping 1000']);
    expect(relations().get('7')?.get('fineGranular')).toEqual([drawn, { ...configured, id: 1000 }]);
  });

  it('leaves out a new relation whose only mapping is not configured', () => {
    add(relations(), 'new-1', { backendId: null, sourceId: 1, targetId: 3, reactionFileId: null, fineGranular: [{ sourceId: 'c', targetId: 'd' }] });

    expect(toSyncChanges(doc, project).changes.metaModelRelationRequests.map((relation) => relation.targetId)).toEqual([2, 3]);
  });

  it('deletes a deleted relation instead of sending the new, empty one drawn for the same pair', async () => {
    relations().get('7')?.set('softDeleted', true);
    const drawn = add(relations(), 'new-1', { backendId: null, sourceId: 1, targetId: 2, reactionFileId: null, fineGranular: [] });

    await writeBack();
    expect(backend.changes).toEqual(['delete relation 7']);

    drawn.set('reactionFileId', 55);
    await writeBack();
    expect(backend.changes).toEqual(['delete relation 7', 'create relation 1000']);
    expect(drawn.get('backendId')).toBe(1000);
  });

  it('regenerates a low-code mapping whose parameters were edited before it got its ID', async () => {
    const mapping = (reactionName: string) => ({
      sourceId: 'c',
      targetId: 'd',
      lowCodeReactionRequestBase: { name: 'composite_reactions', reactionName },
    });
    relations().get('7')?.set('fineGranular', [mapping('old')]);
    const { changes, sent } = toSyncChanges(doc, project);
    await backend.syncChanges('12', changes);
    relations().get('7')?.set('fineGranular', [mapping('new')]);

    project = await backend.getProject('12');
    applyBackendState(doc, sent, project, { applied: true });
    expect(relations().get('7')?.get('fineGranular')).toEqual([
      {
        ...mapping('new'),
        id: 1001,
        reactionFileStorageId: 1000,
        lowCodeReactionRequestBase: { ...mapping('new').lowCodeReactionRequestBase, regenerate: true },
      },
    ]);
    await writeBack();
    await writeBack();

    expect(backend.changes).toEqual(['create mapping 1001', 'regenerate mapping 1001']);
    expect(backend.projects.get('12')?.relations[0].fineGranularMetaModelRelationSet).toMatchObject([
      { id: 1001, lowCodeReactionRequestBase: { reactionName: 'new' } },
    ]);
  });

  it("doesn't regenerate a mapping still as sent that is matched by its template's name", async () => {
    const mapping = { sourceId: 'c', targetId: 'd', lowCodeReactionRequestBase: { name: 'composite_reactions' } };
    relations().get('7')?.set('fineGranular', [mapping]);
    const { changes, sent } = toSyncChanges(doc, project);
    await backend.syncChanges('12', changes);
    // The backend rebuilds the template with every field of its form.
    const stored = backend.projects.get('12')?.relations[0].fineGranularMetaModelRelationSet ?? [];
    stored[0].lowCodeReactionRequestBase = { name: 'composite_reactions', reactions: null, regenerate: false };

    // E.g. the request timed out after the backend applied it.
    applyBackendState(doc, sent, await backend.getProject('12'), { applied: false });

    expect(relations().get('7')?.get('fineGranular')).toEqual([{ ...mapping, id: 1001, reactionFileStorageId: 1000 }]);
  });

  it('gives a new named view its own ID before an unnamed one with the same file and metamodels', async () => {
    const unnamed = add(views(), 'a-unnamed', { backendId: null, name: '', description: new Y.Text(), fileStorageId: 75, metaModelIds: [1, 2] });
    const named = add(views(), 'b-named', { backendId: null, name: 'Named', description: new Y.Text(), fileStorageId: 75, metaModelIds: [1, 2] });
    const { changes, sent } = toSyncChanges(doc, project);
    await backend.syncChanges('12', changes);
    // The backend may return its views in any order.
    backend.projects.get('12')?.views.reverse();
    project = await backend.getProject('12');

    applyBackendState(doc, sent, project, { applied: true });
    await writeBack();

    expect(unnamed.toJSON()).toMatchObject({ backendId: 1000, name: 'file-75' });
    expect(named.get('backendId')).toBe(1001);
    expect(backend.changes).toEqual(['create view 1000', 'create view 1001']);
  });
});
