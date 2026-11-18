// A small DOM query layer over parse5. parse5 builds the same tree a browser would (implicit
// <tbody>, unclosed <p>/<td>, entity decoding), which strict scrapers and link discovery rely on;
// it has a single dependency and never executes or fetches anything.
import { parse, type DefaultTreeAdapterTypes } from "parse5";

export type HtmlElement = DefaultTreeAdapterTypes.Element;
type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlParent = DefaultTreeAdapterTypes.ParentNode;

/** Documents above this are cut before parsing; course pages are far smaller. */
export const MAX_HTML_CHARS = 5_000_000;

export function parseHtml(html: string | Buffer): DefaultTreeAdapterTypes.Document {
  const text = typeof html === "string" ? html : html.toString("utf8");
  return parse(text.length > MAX_HTML_CHARS ? text.slice(0, MAX_HTML_CHARS) : text);
}

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function children(node: HtmlNode): DefaultTreeAdapterTypes.ChildNode[] {
  // <template> keeps its markup in `content`; it is inert, so it is not searched.
  return "childNodes" in node && !(isElement(node) && node.tagName === "template") ? node.childNodes : [];
}

export function attr(element: HtmlElement, name: string): string | null {
  return element.attrs.find((entry) => entry.name === name)?.value ?? null;
}

export function hasClass(element: HtmlElement, name: string): boolean {
  return (attr(element, "class") ?? "").split(/\s+/).includes(name);
}

/** Every element below `root` in document order that matches `predicate` (iterative: deep trees are fine). */
export function findAll(root: HtmlNode, predicate: (element: HtmlElement) => boolean): HtmlElement[] {
  const result: HtmlElement[] = [];
  const stack: HtmlNode[] = [...children(root)].reverse();
  while (stack.length) {
    const node = stack.pop() as HtmlNode;
    if (isElement(node)) {
      if (predicate(node)) result.push(node);
      stack.push(...[...children(node)].reverse());
    }
  }
  return result;
}

export function findFirst(root: HtmlNode, predicate: (element: HtmlElement) => boolean): HtmlElement | null {
  return findAll(root, predicate)[0] ?? null;
}

export const byTag =
  (tag: string, ...classes: string[]) =>
  (element: HtmlElement) =>
    element.tagName === tag && classes.every((name) => hasClass(element, name));

/** Direct element children, optionally limited to some tag names. */
export function childElements(element: HtmlParent, tags?: readonly string[]): HtmlElement[] {
  return children(element).filter((node): node is HtmlElement => isElement(node) && (!tags || tags.includes(node.tagName)));
}

export function closest(element: HtmlElement, tag: string): HtmlElement | null {
  for (let node = element.parentNode; node; node = "parentNode" in node ? node.parentNode : null) {
    if (isElement(node) && node.tagName === tag) return node;
  }
  return null;
}

const NO_TEXT = new Set(["script", "style", "noscript", "template"]);

/** Text content with `separator` between text runs; script and style bodies are left out. */
export function textOf(root: HtmlNode, separator = " "): string {
  const parts: string[] = [];
  const stack: HtmlNode[] = [root];
  while (stack.length) {
    const node = stack.pop() as HtmlNode;
    if (node.nodeName === "#text") parts.push((node as DefaultTreeAdapterTypes.TextNode).value);
    else if (!(isElement(node) && NO_TEXT.has(node.tagName))) stack.push(...[...children(node)].reverse());
  }
  return parts.join(separator);
}

/** Text squeezed to single spaces, like BeautifulSoup's get_text(" ", strip=True). */
export function cleanText(root: HtmlNode): string {
  return textOf(root).replace(/\s+/g, " ").trim();
}

export function documentTitle(document: DefaultTreeAdapterTypes.Document): string | null {
  const title = findFirst(document, byTag("title"));
  return title ? cleanText(title) : null;
}

/** Every `<a href>` in document order, with its visible label. */
export function links(root: HtmlNode): { href: string; label: string }[] {
  return findAll(root, (element) => element.tagName === "a" && attr(element, "href") !== null).map((element) => ({
    href: (attr(element, "href") ?? "").trim(),
    label: cleanText(element),
  }));
}
