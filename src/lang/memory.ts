/**
 * Flat byte-addressed memory for the interpreter.
 *
 * A real memory model is what makes pointers, arrays, structs and `&x` behave
 * like C instead of like a pile of special cases. Addresses are byte offsets;
 * address 0 is NULL and is never handed out.
 *
 * `free` maintains a first-fit free list with coalescing, so a loop that calls
 * `malloc`/`free` does not exhaust the heap.
 */

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryError';
  }
}

interface Block {
  address: number;
  size: number;
  free: boolean;
}

const NULL_ADDRESS = 0;
const FIRST_ADDRESS = 16;

export class Memory {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly blocks: Block[] = [];
  private highWater = FIRST_ADDRESS;

  constructor(readonly capacity = 1 << 21) {
    this.bytes = new Uint8Array(capacity);
    this.view = new DataView(this.bytes.buffer);
  }

  get usedBytes(): number {
    return this.blocks
      .filter((block) => !block.free)
      .reduce((total, block) => total + block.size, 0);
  }

  /**
   * Bytes still allocated. Reported at the end of a run as a possible leak: a
   * short-lived program never has to free anything, so it is information rather
   * than an error.
   */
  get unfreedBytes(): number {
    return this.usedBytes;
  }

  isValid(address: number, size = 1): boolean {
    return (
      Number.isInteger(address) &&
      address >= FIRST_ADDRESS &&
      address + size <= this.capacity
    );
  }

  alloc(size: number, alignment = 8): number {
    const wanted = Math.max(Math.trunc(size), 1);
    const align = Math.max(1, Math.min(alignment, 16));

    // First fit over existing blocks.
    for (const block of this.blocks) {
      if (!block.free) continue;
      const candidate = Math.ceil(block.address / align) * align;
      const padding = candidate - block.address;
      if (padding + wanted <= block.size) {
        if (padding > 0) {
          block.size = padding;
        } else {
          block.free = false;
          if (block.size > wanted) {
            this.blocks.push({ address: block.address + wanted, size: block.size - wanted, free: true });
            block.size = wanted;
          }
          this.blocks.sort((a, b) => a.address - b.address);
          return block.address;
        }
      }
    }

    const address = Math.ceil(this.highWater / align) * align;
    if (address + wanted > this.capacity) {
      throw new MemoryError(
        `out of simulated memory (asked for ${wanted} bytes, ${this.capacity - this.highWater} left)`,
      );
    }
    this.blocks.push({ address, size: wanted, free: false });
    this.highWater = address + wanted;
    this.blocks.sort((a, b) => a.address - b.address);
    return address;
  }

  free(address: number): void {
    if (address === NULL_ADDRESS) return;
    const index = this.blocks.findIndex((block) => block.address === address && !block.free);
    if (index < 0) return;
    const block = this.blocks[index];
    if (!block) return;
    block.free = true;
    this.coalesce();
  }

  private coalesce(): void {
    this.blocks.sort((a, b) => a.address - b.address);
    for (let index = this.blocks.length - 1; index > 0; index -= 1) {
      const current = this.blocks[index];
      const previous = this.blocks[index - 1];
      if (!current || !previous) continue;
      if (previous.free && current.free && previous.address + previous.size === current.address) {
        previous.size += current.size;
        this.blocks.splice(index, 1);
      }
    }
  }

  private check(address: number, size: number): void {
    if (!this.isValid(address, size)) {
      throw new MemoryError(
        address === NULL_ADDRESS
          ? 'null pointer dereference'
          : `invalid memory access at 0x${address.toString(16)}`,
      );
    }
  }

  readInt8(address: number): number {
    this.check(address, 1);
    return this.view.getInt8(address);
  }

  readUint8(address: number): number {
    this.check(address, 1);
    return this.view.getUint8(address);
  }

  readInt16(address: number): number {
    this.check(address, 2);
    return this.view.getInt16(address, true);
  }

  readUint16(address: number): number {
    this.check(address, 2);
    return this.view.getUint16(address, true);
  }

  readInt32(address: number): number {
    this.check(address, 4);
    return this.view.getInt32(address, true);
  }

  readUint32(address: number): number {
    this.check(address, 4);
    return this.view.getUint32(address, true);
  }

  readInt64(address: number): number {
    this.check(address, 8);
    return Number(this.view.getBigInt64(address, true));
  }

  readUint64(address: number): number {
    this.check(address, 8);
    return Number(this.view.getBigUint64(address, true));
  }

  readFloat32(address: number): number {
    this.check(address, 4);
    return this.view.getFloat32(address, true);
  }

  readFloat64(address: number): number {
    this.check(address, 8);
    return this.view.getFloat64(address, true);
  }

  writeInt8(address: number, value: number): void {
    this.check(address, 1);
    this.view.setInt8(address, value);
  }

  writeUint8(address: number, value: number): void {
    this.check(address, 1);
    this.view.setUint8(address, value);
  }

  writeInt16(address: number, value: number): void {
    this.check(address, 2);
    this.view.setInt16(address, value, true);
  }

  writeUint16(address: number, value: number): void {
    this.check(address, 2);
    this.view.setUint16(address, value, true);
  }

  writeInt32(address: number, value: number): void {
    this.check(address, 4);
    this.view.setInt32(address, value, true);
  }

  writeUint32(address: number, value: number): void {
    this.check(address, 4);
    this.view.setUint32(address, value, true);
  }

  writeInt64(address: number, value: number): void {
    this.check(address, 8);
    this.view.setBigInt64(address, BigInt(Math.trunc(value)), true);
  }

  writeUint64(address: number, value: number): void {
    this.check(address, 8);
    this.view.setBigUint64(address, BigInt(Math.max(0, Math.trunc(value))), true);
  }

  writeFloat32(address: number, value: number): void {
    this.check(address, 4);
    this.view.setFloat32(address, value, true);
  }

  writeFloat64(address: number, value: number): void {
    this.check(address, 8);
    this.view.setFloat64(address, value, true);
  }

  readBytes(address: number, length: number): Uint8Array {
    this.check(address, length);
    return this.bytes.slice(address, address + length);
  }

  writeBytes(address: number, data: Uint8Array): void {
    this.check(address, data.length);
    this.bytes.set(data, address);
  }

  copy(source: number, destination: number, length: number): void {
    this.check(source, length);
    this.check(destination, length);
    this.bytes.copyWithin(destination, source, source + length);
  }

  fill(address: number, value: number, length: number): void {
    this.check(address, length);
    this.bytes.fill(value & 0xff, address, address + length);
  }

  /** Reads a NUL-terminated string, stopping at the limit to stay safe. */
  readCString(address: number, limit = 4096): string {
    this.check(address, 1);
    let text = '';
    for (let index = 0; index < limit; index += 1) {
      const next = address + index;
      if (next >= this.capacity) break;
      const byte = this.view.getUint8(next);
      if (byte === 0) break;
      text += String.fromCharCode(byte);
    }
    return text;
  }

  /** Writes `text` plus a NUL terminator and returns the address. */
  writeCString(text: string, alignment = 1): number {
    const address = this.alloc(text.length + 1, alignment);
    for (let index = 0; index < text.length; index += 1) {
      this.view.setUint8(address + index, text.charCodeAt(index) & 0xff);
    }
    this.view.setUint8(address + text.length, 0);
    return address;
  }

  static readonly NULL = NULL_ADDRESS;
}
