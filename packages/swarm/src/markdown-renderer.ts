import { marked, MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";

// Configure marked with terminal renderer extension
// Type assertion needed because @types/marked-terminal is outdated (6.x) vs package (7.x)
marked.use(
  markedTerminal({
    showSectionPrefix: false,
    reflowText: true,
    width: 80,
  }) as MarkedExtension
);

/**
 * Render markdown content for terminal display.
 */
export function renderMarkdown(content: string): string {
  const rendered = marked.parse(content);
  // marked.parse returns string when async is false (default)
  // Trim trailing newlines that marked adds
  return (rendered as string).trimEnd();
}
