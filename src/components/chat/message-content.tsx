"use client";

/**
 * MessageContent — renders a chat message's text content.
 *
 * - Assistant messages: rendered as Markdown (react-markdown) so that
 *   ## headers, **bold**, lists, [text](url) links, and bare URLs are
 *   all properly formatted and clickable. This is the "clean clickable
 *   links" fix — previously URLs were plain text.
 * - User messages: rendered as plain text with bare URLs auto-linked
 *   (no Markdown, so the user's literal input is preserved).
 *
 * Links open in a new tab with rel="noopener noreferrer" for safety.
 */

import ReactMarkdown from "react-markdown";

interface Props {
  content: string;
  as: "user" | "assistant";
}

export function MessageContent({ content, as }: Props) {
  if (as === "user") {
    return <span className="whitespace-pre-wrap break-words">{autoLink(content)}</span>;
  }
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown
        components={{
          a: ({ node, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            />
          ),
          // Preserve whitespace/newlines for pre-formatted blocks
          pre: ({ node, ...props }) => <pre {...props} className="overflow-x-auto" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Auto-link bare URLs in plain text. Returns an array of strings + <a>
 * elements. Used for user messages (which aren't Markdown-rendered).
 */
function autoLink(text: string): React.ReactNode[] {
  // Match http(s)://... or www.... — stop at whitespace or end of line.
  const urlRe = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = urlRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[0];
    const href = url.startsWith("www.") ? `https://${url}` : url;
    parts.push(
      <a
        key={`link-${key++}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 underline underline-offset-2 hover:text-blue-300"
      >
        {url}
      </a>,
    );
    lastIndex = match.index + url.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
}
