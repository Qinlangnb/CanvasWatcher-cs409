// Canvas rich content as readable blocks: headings, paragraphs and tables that keep their rows.
// htmlToText (normalize.ts) flattens a table into loose cells, so an exam name and its date end up
// on separate lines; these blocks keep each row together. Used for showing a syllabus, not for
// change detection, so the stored content hashes are unaffected.

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "text"; text: string }
  | { type: "table"; rows: string[][]; header_rows: number; row_headers: boolean; caption?: string };

const MAX_BLOCKS = 2_000;
const MAX_CHARS = 200_000;
const MAX_ROWS = 500;
const MAX_COLUMNS = 30;
const MAX_SPAN = 50;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", bull: "•",
  middot: "·", deg: "°", times: "×", divide: "÷", plusmn: "±", le: "≤", ge: "≥", rarr: "→", larr: "←",
  copy: "©", reg: "®", trade: "™", sect: "§", para: "¶", frac12: "½", frac14: "¼", frac34: "¾",
};

const SKIP = new Set(["script", "style", "noscript", "template", "svg", "math", "head", "iframe", "object", "select", "button"]);
const BREAK = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "ul", "ol", "dl", "dt", "dd",
  "blockquote", "pre", "figure", "figcaption", "form", "fieldset", "address", "hr", "details", "summary", "center", "li",
]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "col", "source", "wbr", "area", "base", "embed", "param", "track"]);
const BOLD = new Set(["b", "strong"]);

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]*);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const point = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? entity;
  });
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function span(attrs: string, name: string): number {
  const value = Number.parseInt(attribute(attrs, name) ?? "1", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_SPAN) : 1;
}

interface Cell {
  text: string;
  header: boolean;
  colspan: number;
  rowspan: number;
  boldChars: number;
  plainChars: number;
}

interface Row {
  cells: Cell[];
  thead: boolean;
}

interface TableBuilder {
  rows: Row[];
  row: Row | null;
  cell: Cell | null;
  caption: string | null;
  inCaption: boolean;
  section: "thead" | "tbody" | "tfoot" | null;
}

/** Builds the grid with rowspan and colspan filled in, then drops empty rows and columns. */
function finishTable(table: TableBuilder): Block | null {
  const rows = table.rows.filter((row) => row.cells.length > 0).slice(0, MAX_ROWS);
  if (rows.length === 0) return null;
  const grid: (string | undefined)[][] = rows.map(() => []);
  const headerGrid: boolean[][] = rows.map(() => []);
  rows.forEach((row, r) => {
    let column = 0;
    for (const cell of row.cells) {
      while (grid[r]?.[column] !== undefined) column += 1;
      for (let dr = 0; dr < cell.rowspan && r + dr < rows.length; dr += 1) {
        for (let dc = 0; dc < cell.colspan && column + dc < MAX_COLUMNS; dc += 1) {
          (grid[r + dr] as (string | undefined)[])[column + dc] = cell.text;
          (headerGrid[r + dr] as boolean[])[column + dc] = cell.header;
        }
      }
      column += cell.colspan;
    }
  });
  const width = Math.min(Math.max(...grid.map((row) => row.length)), MAX_COLUMNS);
  const full = grid.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? ""));
  const keepColumns = [...Array(width).keys()].filter((c) => full.some((row) => row[c] !== ""));
  const kept: { cells: string[]; headers: boolean[]; source: Row }[] = [];
  full.forEach((row, r) => {
    const cells = keepColumns.map((c) => row[c] as string);
    const headers = keepColumns.map((c) => headerGrid[r]?.[c] === true);
    if (cells.some((cell) => cell !== "")) kept.push({ cells, headers, source: rows[r] as Row });
  });
  if (kept.length === 0) return null;

  const isHeader = ({ source }: { source: Row }) =>
    source.thead ||
    source.cells.every((cell) => cell.header) ||
    (source.cells.length > 1 && source.cells.every((cell) => cell.boldChars > 0 && cell.plainChars === 0));
  let headerRows = 0;
  while (headerRows < kept.length - 1 && isHeader(kept[headerRows] as (typeof kept)[number])) headerRows += 1;
  const body = kept.slice(headerRows);
  // A row header spanning several rows (rowspan) counts for each of them.
  const rowHeaders = body.length > 0 && body.every(({ headers }) => headers[0] && !headers.every(Boolean));
  return {
    type: "table",
    rows: kept.map((row) => row.cells),
    header_rows: headerRows,
    row_headers: rowHeaders,
    ...(table.caption ? { caption: table.caption } : {}),
  };
}

/** Splits Canvas HTML into headings, paragraphs and tables. */
export function htmlBlocks(html: string | null | undefined): Block[] {
  if (!html) return [];
  const blocks: Block[] = [];
  let chars = 0;
  let lines: string[] = [""];
  let heading: { level: number; text: string } | null = null;
  const tables: TableBuilder[] = [];
  let skip: string | null = null;
  let skipDepth = 0;
  let bold = 0;

  const push = (block: Block) => {
    if (blocks.length >= MAX_BLOCKS || chars >= MAX_CHARS) return;
    blocks.push(block);
    chars += block.type === "table" ? block.rows.flat().join(" ").length : block.text.length;
  };
  const flush = () => {
    for (const line of lines) {
      const text = clean(line);
      if (text) push({ type: "text", text });
    }
    lines = [""];
  };
  const newline = () => {
    const table = tables.at(-1);
    if (table?.cell) table.cell.text += "\n";
    else if (heading) heading.text += " ";
    else lines.push("");
  };
  const write = (raw: string) => {
    const text = decodeEntities(raw);
    const table = tables.at(-1);
    if (table?.inCaption) {
      table.caption = (table.caption ?? "") + text;
    } else if (table?.cell) {
      table.cell.text += text;
      const visible = text.replace(/\s+/g, "").length;
      if (bold > 0) table.cell.boldChars += visible;
      else table.cell.plainChars += visible;
    } else if (table) {
      // Stray text between rows; Canvas editors leave whitespace here.
    } else if (heading) {
      heading.text += text;
    } else {
      lines[lines.length - 1] += text;
    }
  };
  const closeCell = (table: TableBuilder) => {
    if (!table.cell) return;
    const text = table.cell.text.split("\n").map(clean).filter(Boolean).join(" / ");
    table.cell.text = text;
    table.row?.cells.push(table.cell);
    table.cell = null;
  };
  const closeRow = (table: TableBuilder) => {
    closeCell(table);
    if (table.row) table.rows.push(table.row);
    table.row = null;
  };

  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;
  for (const match of html.matchAll(token)) {
    const [whole, slash, rawTag, attrs = "", text] = match;
    if (whole.startsWith("<!--")) continue;
    if (text !== undefined || whole === "<") {
      if (!skip) write(text ?? whole);
      continue;
    }
    const tag = (rawTag as string).toLowerCase();
    const closing = slash === "/";
    if (skip) {
      if (tag === skip) skipDepth += closing ? -1 : 1;
      if (skipDepth === 0) skip = null;
      continue;
    }
    if (!closing && SKIP.has(tag) && !attrs.trim().endsWith("/")) {
      skip = tag;
      skipDepth = 1;
      continue;
    }
    if (BOLD.has(tag)) {
      bold = Math.max(0, bold + (closing ? -1 : 1));
      continue;
    }
    if (tag === "table") {
      if (!closing) {
        if (tables.length === 0) flush();
        tables.push({ rows: [], row: null, cell: null, caption: null, inCaption: false, section: null });
        continue;
      }
      const table = tables.pop();
      if (!table) continue;
      closeRow(table);
      const block = finishTable(table);
      const parent = tables.at(-1);
      if (parent?.cell && block?.type === "table") {
        // A table inside a cell becomes "a, b; c, d" in that cell.
        parent.cell.text += block.rows.map((row) => row.filter(Boolean).join(", ")).join("; ");
      } else if (block) {
        push(block);
      }
      continue;
    }
    const table = tables.at(-1);
    if (table) {
      if (tag === "caption") table.inCaption = !closing;
      else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
        closeRow(table);
        table.section = closing ? null : tag;
      } else if (tag === "tr") {
        closeRow(table);
        if (!closing) table.row = { cells: [], thead: table.section === "thead" };
      } else if (tag === "td" || tag === "th") {
        closeCell(table);
        if (!closing) {
          if (!table.row) table.row = { cells: [], thead: table.section === "thead" };
          table.cell = {
            text: "",
            header: tag === "th",
            colspan: span(attrs, "colspan"),
            rowspan: span(attrs, "rowspan"),
            boldChars: 0,
            plainChars: 0,
          };
        }
      } else if (tag === "br" || BREAK.has(tag)) {
        if (table.cell) {
          if (tag === "li" && !closing) table.cell.text += "\n• ";
          else newline();
        }
      }
      continue;
    }
    const level = /^h([1-6])$/.exec(tag);
    if (level) {
      if (!closing) {
        flush();
        heading = { level: Number(level[1]), text: "" };
      } else if (heading) {
        const text = clean(heading.text);
        if (text) push({ type: "heading", level: heading.level, text });
        heading = null;
      }
      continue;
    }
    if (tag === "br") newline();
    else if (tag === "li" && !closing) {
      newline();
      write("• ");
    } else if (BREAK.has(tag)) newline();
    else if (VOID.has(tag)) continue;
  }
  if (heading) {
    const text = clean(heading.text);
    if (text) push({ type: "heading", level: heading.level, text });
  }
  while (tables.length > 0) {
    const table = tables.pop() as TableBuilder;
    closeRow(table);
    const block = finishTable(table);
    if (block) push(block);
  }
  flush();
  return blocks.filter((block) => !(block.type === "text" && block.text === "•"));
}

/** One line per table row: "Exam: Midterm 1 | Date: Oct 8", so names and dates stay paired. */
export function tableLines(block: Extract<Block, { type: "table" }>): string[] {
  const { rows, header_rows: headerRows } = block;
  const width = Math.max(...rows.map((row) => row.length));
  const heads = Array.from({ length: width }, (_, c) =>
    rows
      .slice(0, headerRows)
      .map((row) => row[c] ?? "")
      .filter((text, index, all) => text && all.indexOf(text) === index)
      .join(" / "),
  );
  const lines = block.caption ? [block.caption] : [];
  for (const row of rows.slice(headerRows)) {
    const parts: string[] = [];
    let c = block.row_headers ? 1 : 0;
    while (c < row.length) {
      // Cells repeated by colspan read once: "Topic / Due: value".
      let end = c + 1;
      while (end < row.length && row[end] === row[c]) end += 1;
      const value = row[c] ?? "";
      const head = [...new Set(heads.slice(c, end).filter(Boolean))].join(" / ");
      if (value) parts.push(head ? `${head}: ${value}` : value);
      c = end;
    }
    const prefix = block.row_headers && row[0] ? `${row[0]}: ` : "";
    if (parts.length > 0 || prefix) lines.push(prefix + parts.join(" | "));
  }
  return lines;
}

export function blocksText(blocks: Block[]): string {
  return blocks
    .flatMap((block) =>
      block.type === "heading" ? [`${"#".repeat(block.level)} ${block.text}`] : block.type === "text" ? [block.text] : tableLines(block),
    )
    .join("\n");
}
