/**
 * Chat markdown pipeline: GFM via marked, sanitized by DOMPurify. All chat
 * content is remote-authored — nothing renders without passing through here.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

// Anchors get target/rel forced here; the app-level click handler routes
// them to the system browser — a link must never navigate the app window
// (it would inherit the IPC bridge).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMd(src: string): string {
  return DOMPurify.sanitize(marked.parse(src, { async: false }));
}
