import type { MemoryView } from '@/engine/types';
import { chainEndLabel, chainSummary, formatAddress, hexDump } from '@/ui/memoryFormat';

/**
 * @brief Renders the empty memory state message when no structures or blocks are allocated.
 * @param props Properties containing engine label.
 * @return Empty memory hint JSX element.
 */
function EmptyMemoryHint(props: { readonly engineLabel: string }) {
  const { engineLabel } = props;
  const hint = engineLabel.toLowerCase().includes('clang')
    ? 'Engine clang không mô hình hoá memory: nó biên dịch và chạy thật, ' +
      'còn khối nhớ nằm trong module wasm. Chuyển sang fast engine để xem cấu trúc dữ liệu.'
    : 'Chương trình chưa cấp phát gì bằng malloc/new, ' +
      'và không có con trỏ nào trỏ tới struct — nên chưa có gì để vẽ.';
  return (
    <div className="console__body">
      <span className="console__hint">{hint}</span>
    </div>
  );
}

interface MemoryChainsSectionProps {
  readonly chains: MemoryView['chains'];
}

/**
 * @brief Renders the list of tracked pointer chains.
 * @param props Properties for pointer chains.
 * @return Rendered pointer chains JSX element.
 */
function MemoryChainsSection(props: MemoryChainsSectionProps) {
  const { chains } = props;
  return (
    <>
      {chains.map((chain) => (
        <div key={`chain-${chain.name}`} className="memory__chain">
          <div className="memory__title" title={chainEndLabel(chain.end)}>
            {chainSummary(chain)}
          </div>
          {chain.nodes.map((node, index) => (
            <div key={`${chain.name}-${node.address}`} className="memory__node">
              <span className="memory__address">{formatAddress(node.address)}</span>
              <span className="memory__fields">
                {node.fields.map((field) => `${field.name} = ${field.value}`).join(', ')}
              </span>
              {index === chain.nodes.length - 1 ? (
                <span className="memory__end">→ {chainEndLabel(chain.end)}</span>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

interface MemoryBlocksSectionProps {
  readonly blocks: MemoryView['blocks'];
  readonly truncated: boolean;
}

/**
 * @brief Renders allocated heap memory blocks with hex dump.
 * @param props Properties for memory blocks.
 * @return Rendered memory blocks JSX element.
 */
function MemoryBlocksSection(props: MemoryBlocksSectionProps) {
  const { blocks, truncated } = props;
  if (blocks.length === 0) return null;
  return (
    <div className="memory__blocks">
      <div className="memory__title">
        Bộ nhớ chương trình đã cấp phát (malloc/new)
        {truncated ? ' · đã lược bớt' : ''}
      </div>
      {blocks.map((block) => (
        <div key={`block-${block.address}`} className="memory__block">
          <div className="memory__block-head">
            {formatAddress(block.address)} · {block.size} byte
            {block.truncated ? ' (chỉ hiện phần đầu)' : ''}
          </div>
          {hexDump(block.address, block.bytes).map((row) => (
            <div key={`${block.address}-${row.address}`} className="memory__row">
              <span className="memory__address">{row.address}</span>
              <span className="memory__hex">{row.hex}</span>
              <span className="memory__ascii">{row.ascii}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export interface MemoryTabProps {
  readonly memory: MemoryView;
  readonly engineLabel: string;
}

/**
 * @brief Renders the memory visualizer tab body showing linked structures and allocated blocks.
 * @param props Component properties for memory tab.
 * @return The rendered memory visualizer JSX element.
 */
export function MemoryTab(props: MemoryTabProps) {
  const { memory, engineLabel } = props;
  if (memory.chains.length === 0 && memory.blocks.length === 0) {
    return <EmptyMemoryHint engineLabel={engineLabel} />;
  }

  return (
    <div className="console__body">
      <div className="memory">
        <MemoryChainsSection chains={memory.chains} />
        <MemoryBlocksSection blocks={memory.blocks} truncated={memory.truncated} />
      </div>
    </div>
  );
}
