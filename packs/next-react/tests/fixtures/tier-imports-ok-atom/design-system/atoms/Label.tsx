// Clean atom — only imports from design-system/atoms/ and design-system/utils/
import { tokens } from "design-system/tokens";

export function Label({ text }: { text: string }) {
  return <span style={{ color: tokens.text }}>{text}</span>;
}
