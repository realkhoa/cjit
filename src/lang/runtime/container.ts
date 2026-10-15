import type { CType } from '@/lang/ctype';
import { elementTypeFromCode } from '@/lang/ctype';
import type { Memory } from '@/lang/memory';

/**
 * The control block the interpreter gives a `std::vector`.
 *
 *   0  data pointer (8 bytes)
 *   8  element count (8 bytes)
 *  16  capacity (8 bytes)
 *  24  element kind code (4 bytes) - a runtime descriptor, used when the declared
 *      element type is unknown (inside a template, for instance)
 *  28  element size (4 bytes)
 *
 * Both the writer (the interpreter, when it creates/pushes/copies a vector) and
 * the reader (formatting a value for the watch pane) go through these constants,
 * so the layout is stated once.
 */
export const VECTOR_DATA_OFFSET = 0;
export const VECTOR_COUNT_OFFSET = 8;
export const VECTOR_CAPACITY_OFFSET = 16;
export const VECTOR_ELEMENT_KIND_OFFSET = 24;
export const VECTOR_ELEMENT_SIZE_OFFSET = 28;
export const VECTOR_CONTROL_SIZE = 32;

/**
 * How many elements a sequence shows before it says how many are left.
 *
 * A thousand-element vector cannot be read inline, and silently showing the first
 * few would be worse than useless, so the count of the rest is always printed.
 */
export const CONTAINER_PREVIEW_LIMIT = 20;

/** How deep nested sequences are expanded before they are summarised. */
export const MAX_SEQUENCE_DEPTH = 3;

export interface VectorLayout {
  /** Address of the first element. */
  readonly data: number;
  /** Number of live elements. */
  readonly count: number;
  readonly capacity: number;
  readonly element: CType;
  /** Bytes between elements. */
  readonly stride: number;
}

/**
 * Reads a vector's control block. `declared` wins over the runtime descriptor:
 * the declared type carries names and struct/array shape that a kind code cannot.
 */
export function readVectorLayout(
  memory: Memory,
  address: number,
  declared?: CType,
): VectorLayout {
  const data = memory.readUint64(address + VECTOR_DATA_OFFSET);
  const count = memory.readInt64(address + VECTOR_COUNT_OFFSET);
  const capacity = memory.readInt64(address + VECTOR_CAPACITY_OFFSET);

  const element =
    declared && declared.kind !== 'unknown'
      ? declared
      : elementTypeFromCode(
          memory.readInt32(address + VECTOR_ELEMENT_KIND_OFFSET),
          memory.readInt32(address + VECTOR_ELEMENT_SIZE_OFFSET),
        );

  return { data, count, capacity, element, stride: Math.max(element.size, 1) };
}
