import stringWidth from "string-width";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function displayWidth(value: string): number {
  return stringWidth(value);
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function humanizeIdentifier(value: string): string {
  const words = value
    .replace(/^mcp__[^_]+__/, "")
    .split(/[_-]+/)
    .filter(Boolean);
  if (words.length === 0) return value;
  return words.map((word, index) => (index === 0 ? capitalize(word) : word)).join(" ");
}

export function truncateEnd(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(value) <= maxWidth) return value;
  if (maxWidth === 1) return "…";

  const shown: string[] = [];
  let width = 1; // ellipsis
  for (const grapheme of graphemes(value)) {
    const nextWidth = displayWidth(grapheme);
    if (width + nextWidth > maxWidth) break;
    shown.push(grapheme);
    width += nextWidth;
  }
  return `${shown.join("")}…`;
}

export function truncateMiddle(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(value) <= maxWidth) return value;
  if (maxWidth < 5) return truncateEnd(value, maxWidth);

  const segments = graphemes(value);
  const left: string[] = [];
  const right: string[] = [];
  let leftIndex = 0;
  let rightIndex = segments.length - 1;
  let width = 1; // ellipsis
  let takeLeft = true;

  while (leftIndex <= rightIndex) {
    const segment = takeLeft ? segments[leftIndex] : segments[rightIndex];
    if (segment === undefined) break;
    const nextWidth = displayWidth(segment);
    if (width + nextWidth > maxWidth) break;
    if (takeLeft) {
      left.push(segment);
      leftIndex += 1;
    } else {
      right.push(segment);
      rightIndex -= 1;
    }
    width += nextWidth;
    takeLeft = !takeLeft;
  }

  return `${left.join("")}…${right.reverse().join("")}`;
}

function graphemes(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map(({ segment }) => segment);
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
