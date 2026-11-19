// AI Chat answers as Markdown: GFM tables, KaTeX math, no raw HTML, and images replaced by their text.
import "katex/dist/katex.min.css";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { apiHref } from "./api";

/** Untrusted input: no \href or \htmlClass, and limits so a macro can't blow up the page. */
const KATEX_OPTIONS = { trust: false, strict: "ignore", throwOnError: false, maxExpand: 200, maxSize: 20 } as const;

/** Links open in a new tab; app paths keep the site's base path. Images are never loaded. */
const components: Components = {
  a: ({ href, children }) => (
    <a href={href?.startsWith("/") ? apiHref(href) : href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="ai-image-omitted">[Image omitted{alt ? `: ${alt}` : ""}]</span>,
  table: ({ children }) => (
    <div className="ai-table-wrap" tabIndex={0} role="region" aria-label="Table">
      <table>{children}</table>
    </div>
  ),
};

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
