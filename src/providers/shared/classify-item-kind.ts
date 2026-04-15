import type { UnifiedBlock } from "../../schema/unified-session.js";

interface ClassifiedItem {
  readonly kind: string;
  readonly role: string | null;
}

export function classifyItemKindFromBlocks(
  blocks: UnifiedBlock[],
  role: string | null,
): ClassifiedItem {
  const blockTypes = new Set(blocks.map((block) => block.type));

  if (blockTypes.size === 1) {
    const onlyType = blocks[0]?.type;
    if (onlyType === "thinking") {
      return { kind: "reasoning", role };
    }
    if (onlyType === "tool_call") {
      return { kind: "tool_call", role };
    }
    if (onlyType === "tool_result") {
      return { kind: "tool_result", role: "tool" };
    }
  }

  return { kind: "message", role };
}
