import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';
import { chainEndLabel, formatAddress, hexDump } from '@/ui/memoryFormat';

/**
 * The memory view: live blocks, and where a pointer chain leads.
 *
 * A linked list is the picture every C course draws, and the variable pane cannot
 * draw it - `next` is just an address there. These tests pin the walk itself,
 * including the two ways it stops that must never look like an ending: a cycle and
 * the depth limit.
 */

function run(source: string): ExecutionResult {
  const analysis = analyzeSource(source, 'main.c');
  expect(
    analysis.errorCount,
    `unexpected parse errors: ${JSON.stringify(analysis.diagnostics, null, 1)}`,
  ).toBe(0);
  return execute(analysis.unit, { collectWatch: true });
}

const LIST_PROGRAM = [
  '#include <stdlib.h>',
  'struct Node { int value; struct Node *next; };',
  'int main(void) {',
  '    struct Node *head = malloc(sizeof(struct Node));',
  '    head->value = 1;',
  '    head->next = malloc(sizeof(struct Node));',
  '    head->next->value = 2;',
  '    head->next->next = 0;',
  '    return 0;',
  '}',
].join('\n');

describe('walking a pointer chain', () => {
  it('follows a linked list to its end and shows each node', () => {
    const result = run(LIST_PROGRAM);
    const chain = result.memory.chains.find((entry) => entry.name === 'head');

    expect(chain).toBeDefined();
    expect(chain?.end).toBe('null');
    expect(chain?.nodes).toHaveLength(2);
    // Each node carries its own fields, so the shape of the list is visible.
    expect(chain?.nodes[0]?.fields.find((field) => field.name === 'value')?.value).toBe('1');
    expect(chain?.nodes[1]?.fields.find((field) => field.name === 'value')?.value).toBe('2');
    expect(chain?.nodes[0]?.address).not.toBe(chain?.nodes[1]?.address);
  });

  it('reports a cycle instead of walking it forever', () => {
    const result = run(
      [
        '#include <stdlib.h>',
        'struct Node { int value; struct Node *next; };',
        'int main(void) {',
        '    struct Node *head = malloc(sizeof(struct Node));',
        '    head->value = 7;',
        '    head->next = head;',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    const chain = result.memory.chains.find((entry) => entry.name === 'head');
    expect(chain?.end).toBe('cycle');
    expect(chain?.nodes).toHaveLength(1);
  });

  it('says when it stopped at the depth limit rather than at an end', () => {
    const result = run(
      [
        '#include <stdlib.h>',
        'struct Node { int value; struct Node *next; };',
        'int main(void) {',
        '    struct Node *head = malloc(sizeof(struct Node));',
        '    struct Node *cursor = head;',
        '    for (int i = 0; i < 20; i++) {',
        '        cursor->value = i;',
        '        cursor->next = malloc(sizeof(struct Node));',
        '        cursor = cursor->next;',
        '    }',
        '    cursor->next = 0;',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    const chain = result.memory.chains.find((entry) => entry.name === 'head');
    expect(chain?.end).toBe('limit');
    expect(chain?.nodes.length).toBeLessThanOrEqual(8);
  });

  it('has nothing to say about a program that allocates nothing', () => {
    const result = run('int main(void) { int x = 1; return x; }\n');
    expect(result.memory.chains).toEqual([]);
    // Locals are not in the heap view; the pane is about allocations.
    expect(result.memory.blocks).toEqual([]);
  });

  it('shows the live blocks the program holds', () => {
    const result = run(LIST_PROGRAM);
    expect(result.memory.blocks.length).toBeGreaterThan(0);
    const first = result.memory.blocks[0];
    expect(first?.size).toBeGreaterThan(0);
    expect(first?.bytes.length).toBeGreaterThan(0);
  });
});

describe('formatting the memory view', () => {
  it('writes addresses the way a debugger does', () => {
    expect(formatAddress(0)).toBe('NULL');
    expect(formatAddress(0x1040)).toBe('0x1040');
  });

  it('groups bytes in rows with an ASCII column', () => {
    const rows = hexDump(0x1000, [0x68, 0x69, 0x00, 0x41, 0xff, 0x20, 0x7a, 0x7a, 0x01], 8);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.address).toBe('0x1000');
    expect(rows[0]?.hex).toBe('68 69 00 41 ff 20 7a 7a');
    // Unprintable bytes become dots rather than breaking the column.
    expect(rows[0]?.ascii).toBe('hi.A. zz');
    expect(rows[1]?.address).toBe('0x1008');
    expect(rows[1]?.hex).toBe('01');
  });

  it('handles an empty dump', () => {
    expect(hexDump(0, [], 8)).toEqual([]);
  });

  it('spells out how a walk ended, because a quiet stop would mislead', () => {
    expect(chainEndLabel('null')).toBe('NULL');
    expect(chainEndLabel('cycle')).toContain('quay lại');
    expect(chainEndLabel('limit')).toContain('giới hạn');
    expect(chainEndLabel('unknown')).toContain('không đọc được');
  });
});
