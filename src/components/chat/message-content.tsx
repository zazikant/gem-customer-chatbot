"use client";

/**
 * MessageContent — renders a chat message's text content.
 *
 * - Assistant messages: rendered as Markdown (react-markdown) so that
 *   ## headers, **bold**, lists, [text](url) links, and bare URLs are
 *   all properly formatted and clickable. A preprocessor adds https://
 *   to bare domain references (youtu.be/..., youtube.com/...,
 *   instagram.com/...) so remark-gfm can autolink them.
 * - User messages: rendered as plain text with bare URLs auto-linked
 *   (no Markdown, so the user's literal input is preserved).
 *
 * Links open in a new tab with rel="noopener noreferrer" for safety.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  content: string;
  as: "user" | "assistant";
}

export function MessageContent({ content, as }: Props) {
  if (as === "user") {
    return <span className="whitespace-pre-wrap break-words">{autoLink(content)}</span>;
  }
  // Preprocess: add https:// to bare domain references so remark-gfm
  // can autolink them. The brain/reducer sometimes drops the https://
  // prefix, leaving bare "youtu.be/xxx" or "instagram.com/reel/xxx"
  // which remark-gfm does NOT autolink by default.
  const processed = addHttpsToBareDomains(content);
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 underline underline-offset-2 hover:text-blue-700 break-all dark:text-blue-400 dark:hover:text-blue-300"
            />
          ),
          pre: ({ node, ...props }) => <pre {...props} className="overflow-x-auto" />,
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Add https:// to bare domain references that remark-gfm won't autolink.
 *
 * remark-gfm only autolinks URLs starting with http://, https://, or www.
 * The brain/reducer sometimes produces bare domains like:
 *   youtu.be/QVaijMZ2mp8
 *   youtube.com/shorts/3Bv1n7-DN7c
 *   instagram.com/reel/DdjsyFhvGPt
 *
 * This function prepends https:// to those bare domains so they become
 * clickable links. It does NOT touch URLs that already have a scheme.
 */
function addHttpsToBareDomains(text: string): string {
  // Match bare domains (no preceding scheme) for common video/social sites.
  // Stops at whitespace, end of line, or trailing punctuation.
  const bareDomainRe =
    /(?<![\w:/.-])(youtu\.be\/[^\s<>"']+|youtube\.com\/[^\s<>"']+|instagram\.com\/[^\s<>"']+|youtu\.be\/[^\s<>"']+|x\.com\/[^\s<>"']+|twitter\.com\/[^\s<>"']+|tiktok\.com\/[^\s<>"']+)/gi;
  return text.replace(bareDomainRe, (match) => {
    // Strip trailing punctuation that shouldn't be part of the URL
    const trailing = match.match(/[.,;:!?)\]]+$/);
    const cleanUrl = trailing ? match.slice(0, -trailing[0].length) : match;
    return `https://${cleanUrl}${trailing ? trailing[0] : ""}`;
  });
}

/**
 * Auto-link bare URLs in plain text. Returns an array of strings + <a>
 * elements. Used for user messages (which aren't Markdown-rendered).
 */
function autoLink(text: string): React.ReactNode[] {
  // Match http(s)://..., www...., or bare video domains (youtu.be/..., etc.)
  const urlRe = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|youtu\.be\/[^\s<>"']+|youtube\.com\/[^\s<>"']+|instagram\.com\/[^\s<>"']+)/gi;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = urlRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[0];
    const href = url.startsWith("http") ? url : `https://${url}`;
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
