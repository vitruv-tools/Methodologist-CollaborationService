import type { Map as YMap, Text as YText } from 'yjs';

/**
 * Layout of a project's shared Yjs document (room `vsum:{id}`). The collaboration server fills it
 * from the backend and writes it back; the frontend will edit it. This file only names the parts
 * and their values, so both sides can use it with their own copy of Yjs.
 *
 * ```
 * models     metaModelId → { name, softDeleted, softDeletedVia }
 * relations  key → { backendId, sourceId, targetId, reactionFileId, fineGranular, softDeleted, softDeletedVia }
 * views      key → { backendId, name, description, fileStorageId, metaModelIds, softDeleted, softDeletedVia }
 * layout     { metaModels: metaModelId → { x, y }, reactions: metaModelId → …, other stored keys }
 * status     { writebackError, epoch }
 * ```
 *
 * - Each of `models`, `relations` and `views` is a `Y.Map` whose values are `Y.Map`s with the
 *   fields below, so that concurrent changes of different fields (a rename and a soft delete) are
 *   both kept. A field's value is replaced as a whole: one of two concurrent values wins.
 * - Metamodel IDs are the library IDs the backend's sync request expects: `sourceId` in `/details`,
 *   not `id`. IDs are numbers in fields and decimal strings (`String(id)`) as keys of `models`.
 * - Relations and views loaded from the backend are keyed by their backend ID as a string. New ones
 *   are keyed by a new UUID (`crypto.randomUUID()`), and the server fills in `backendId` after it
 *   wrote them back.
 * - Soft-deleted elements stay in the document but are not written back, so the backend deletes
 *   them. Restoring one after the writeback creates it again with a new backend ID.
 * - Only the server writes `status` and `backendId`.
 * - When the backend changes a project outside the document (e.g. a version restore), the server
 *   applies the differences to the document as one change. The backend wins: changes not written
 *   back yet are dropped. Elements, fields and descriptions that didn't change stay as they are.
 * - The server writes back what it can read. A new element it can't read (e.g. a relation whose
 *   `sourceId` is the string `"2"`) is left out. If the backend already has such an element,
 *   nothing is written back and `status.writebackError` names it, since leaving it out would
 *   delete it in the backend. (An element that isn't a `Y.Map` at all only counts as the
 *   backend's if its key is its backend ID.)
 */

/** Top-level map of the metamodels, keyed by library metamodel ID. Values: {@link ModelFields}. */
export const MODELS = 'models';
/** Top-level map of the relations. Values: {@link RelationFields}. */
export const RELATIONS = 'relations';
/** Top-level map of the views. Values: {@link ViewFields}. */
export const VIEWS = 'views';
/** Top-level map of the canvas positions. See {@link LayoutFields}. */
export const LAYOUT = 'layout';
/** Top-level map the server reports in. See {@link StatusFields}. Never written back. */
export const STATUS = 'status';

/** Map in {@link LAYOUT} with the positions of the metamodels. See {@link LayoutFields}. */
export const LAYOUT_META_MODELS = 'metaModels' satisfies keyof LayoutFields;
/** Map in {@link LAYOUT} with the reaction layouts. See {@link LayoutFields}. */
export const LAYOUT_REACTIONS = 'reactions' satisfies keyof LayoutFields;
/** Field of {@link STATUS} with the reason of the last failed writeback. See {@link StatusFields}. */
export const WRITEBACK_ERROR = 'writebackError' satisfies keyof StatusFields;
/** Field of {@link STATUS} that identifies the room the document belongs to. See {@link StatusFields}. */
export const EPOCH = 'epoch' satisfies keyof StatusFields;

/** URL parameter in which a client sends the {@link EPOCH} of its document when it connects. */
export const EPOCH_PARAM = 'epoch';
/**
 * WebSocket close code with which the server closes the connection of a client whose document
 * belongs to an earlier room of the project (see {@link StatusFields.epoch}).
 */
export const OUTDATED_DOCUMENT_CLOSE_CODE = 4409;
/**
 * WebSocket close code with which the server closes the connections of a project that was moved to
 * the trash or deleted. Changes that weren't written back are lost. Reconnecting is rejected with
 * `403` until the project is restored from the trash, so clients shouldn't reconnect on their own.
 */
export const PROJECT_REMOVED_CLOSE_CODE = 4410;

/** Fields every element has. */
export interface SoftDeletable {
  /** Deleted, but kept so that a concurrent edit isn't lost and the deletion can be undone. */
  softDeleted: boolean;
  /**
   * Key of the metamodel whose deletion also deleted this element, so that restoring the
   * metamodel restores exactly these. `null` if the element was deleted itself.
   */
  softDeletedVia: string | null;
}

/** Fields of a metamodel (a `Y.Map` in {@link MODELS}). */
export interface ModelFields extends SoftDeletable {
  /** Name of the metamodel in this project. */
  name: string;
}

/** Fields of a relation between two metamodels (a `Y.Map` in {@link RELATIONS}). */
export interface RelationFields extends SoftDeletable {
  /** ID of the relation in the backend; `null` until the server wrote a new relation back. */
  backendId: number | null;
  /** Library ID of the source metamodel. */
  sourceId: number;
  /** Library ID of the target metamodel. */
  targetId: number;
  /** ID of the relation's reaction file, if it has one. */
  reactionFileId: number | null;
  /**
   * Element-level mappings, as plain JSON objects with the fields of the backend's
   * `FineGranularMetaModelRelationRequest`. A new mapping is written back once it has a
   * `reactionFileStorageId` or a `lowCodeReactionRequestBase`. After a writeback, the server adds
   * the backend's `id` and generated `reactionFileStorageId` to new mappings, and sets
   * `regenerate` back to `false` once the backend regenerated a file.
   *
   * The array is replaced as a whole, also when the server adds IDs: if a client changes it at the
   * same moment, one of the two changes is lost. Lost IDs are brought back before the next
   * writeback.
   */
  fineGranular: Record<string, unknown>[];
}

/** Fields of a view (a `Y.Map` in {@link VIEWS}). */
export interface ViewFields extends SoftDeletable {
  /** ID of the view in the backend; `null` until the server wrote a new view back. */
  backendId: number | null;
  /** Name of the view, unique within the project. */
  name: string;
  /** Description of the view, edited character by character. */
  description: YText;
  /** ID of the NeoJoin file that defines the view. */
  fileStorageId: number;
  /** Library IDs of the metamodels the view uses. */
  metaModelIds: number[];
}

/** A position on the canvas. */
export interface Position {
  x: number;
  y: number;
}

/**
 * Parts of {@link LAYOUT}. The server creates both maps when it loads a project, so clients never
 * create them concurrently. The backend stores the layout without interpreting it; other keys of a
 * stored layout are kept as plain values.
 */
export interface LayoutFields {
  /** Position of each metamodel on the canvas, keyed by library metamodel ID. */
  metaModels: YMap<Position>;
  /** Reaction layout of each metamodel (its box and class positions), keyed by library ID. */
  reactions: YMap<unknown>;
}

/** Fields of {@link STATUS}, set by the server only. */
export interface StatusFields {
  /** Why the last writeback failed; `null` after a successful one. */
  writebackError: string | null;
  /**
   * Random ID of the room, new each time the server creates the room (after everyone left, or after
   * a restart). Clients send it as the `epoch` parameter when they reconnect with a document that
   * isn't empty. If it isn't the current room's, the server closes the connection with code
   * `4409` without taking anything from the document; the client then starts again with a new,
   * empty document. Otherwise the outdated document would bring back what was deleted since.
   */
  epoch: string;
}
