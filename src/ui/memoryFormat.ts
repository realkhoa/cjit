import type { PointerChain, PointerWalkEnd } from '@/engine/types';

/**
 * Presentation helpers for the memory view.
 *
 * Pure, so the grouping of a hex dump and the wording of "how the walk ended" are
 * unit tested rather than eyeballed in a browser.
 */

/** `NULL` for the null pointer, `0x1040` otherwise. */
export function formatAddress(address: number): string {
  if (!Number.isFinite(address) || address === 0) return 'NULL';
  return `0x${Math.trunc(address).toString(16)}`;
}

export interface HexRow {
  readonly address: string;
  readonly hex: string;
  readonly ascii: string;
}

/**
 * Classic hex dump layout: address, bytes, and an ASCII column where anything
 * unprintable becomes a dot.
 */
export function hexDump(
  base: number,
  bytes: readonly number[],
  perRow = 8,
): HexRow[] {
  if (bytes.length === 0 || perRow <= 0) return [];

  const rows: HexRow[] = [];
  for (let offset = 0; offset < bytes.length; offset += perRow) {
    const slice = bytes.slice(offset, offset + perRow);
    rows.push({
      address: formatAddress(base + offset),
      hex: slice.map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
      ascii: slice
        .map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.'))
        .join(''),
    });
  }
  return rows;
}

/** The reason a walk stopped. Never silent: the reader has to know it was cut off. */
export function chainEndLabel(end: PointerWalkEnd): string {
  switch (end) {
    case 'null':
      return 'NULL';
    case 'cycle':
      return 'cycle — trỏ quay lại node đã đi qua';
    case 'limit':
      return '… dừng ở giới hạn số node hiển thị';
    default:
      return '? — không đọc được địa chỉ này';
  }
}

/** `head → 2 node → NULL`, for a one-line summary above the node list. */
export function chainSummary(chain: PointerChain): string {
  return `${chain.name} → ${chain.nodes.length} node → ${chainEndLabel(chain.end)}`;
}
