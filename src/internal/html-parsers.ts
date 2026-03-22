import type { FarmableGame } from "../types";

// These helpers intentionally target the Steam fragments this package consumes.
// They are small, structure-aware extractors rather than general-purpose HTML parsers.

type HtmlElement = {
  end: number;
  innerHtml: string;
  openTag: string;
  outerHtml: string;
  start: number;
};

const CLASS_ATTRIBUTE_PATTERN = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export function parseAvatarFrameFromProfileHtml(html: string): string | null {
  const frame = findFirstElementByClass(html, "profile_avatar_frame");
  if (!frame) {
    return null;
  }

  return extractAttribute(frame.innerHtml, "img", "src");
}

export function parseFarmableGamesFromBadgesHtml(html: string): FarmableGame[] {
  const firstGlobalActionLink = findFirstElementByClass(html, "global_action_link");
  if (
    firstGlobalActionLink &&
    extractText(firstGlobalActionLink.innerHtml).toLowerCase().includes("login")
  ) {
    throw new Error("NotLoggedIn");
  }

  const farmableGames: FarmableGame[] = [];

  for (const row of findElementsByClass(html, "badge_row")) {
    const progress = findFirstElementByClass(row.outerHtml, "progress_info_bold");
    if (!progress) {
      continue;
    }

    const remainingCardsText = extractText(progress.innerHtml);
    if (!remainingCardsText.toLowerCase().includes("card")) {
      continue;
    }

    const remainingCards = extractFirstInteger(remainingCardsText);
    if (remainingCards === null || remainingCards === 0) {
      continue;
    }

    const playTimeElement = findFirstElementByClass(row.outerHtml, "badge_title_stats_playtime");
    if (!playTimeElement) {
      continue;
    }

    const playTimeText = extractText(playTimeElement.innerHtml, false);
    const playTime = playTimeText.includes("hrs on record")
      ? (extractFirstFloat(playTimeText.replace(/,/g, "")) ?? 0)
      : 0;

    const titleElement = findFirstElementByClass(row.outerHtml, "badge_title");
    if (!titleElement) {
      continue;
    }

    const name = extractText(removeElementsByClass(titleElement.innerHtml, "badge_view_details"));
    if (!name) {
      continue;
    }

    const overlay = findFirstElementByClass(row.outerHtml, "badge_row_overlay");
    if (!overlay) {
      continue;
    }

    const href = extractAttributeValue(overlay.openTag, "href");
    if (!href || !href.includes("gamecards")) {
      continue;
    }

    const appId = extractFirstInteger(href.slice(href.indexOf("gamecards")));
    if (appId === null) {
      continue;
    }

    let droppedCards = 0;
    for (const header of findElementsByClass(row.outerHtml, "card_drop_info_header")) {
      const text = extractText(header.innerHtml);
      if (text.includes("Card drops received")) {
        droppedCards = extractFirstInteger(text) ?? 0;
        break;
      }
    }

    farmableGames.push({
      appId,
      droppedCards,
      name,
      playTime,
      remainingCards,
    });
  }

  return farmableGames;
}

function extractAttribute(html: string, tagName: string, attributeName: string): string | null {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, "i");
  const tagMatch = tagPattern.exec(html);
  if (!tagMatch) {
    return null;
  }

  return extractAttributeValue(tagMatch[0], attributeName);
}

function extractAttributeValue(tag: string, attributeName: string): string | null {
  const attributePattern = new RegExp(
    `\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = attributePattern.exec(tag);
  if (!match) {
    return null;
  }

  return match[1] ?? match[2] ?? match[3] ?? null;
}

function extractFirstFloat(value: string): number | null {
  const match = /\d+(?:\.\d+)?/.exec(value);
  return match ? Number(match[0]) : null;
}

function extractFirstInteger(value: string): number | null {
  const match = /\d+/.exec(value);
  return match ? Number(match[0]) : null;
}

function extractText(value: string, trim = true): string {
  const withoutTags = value.replace(/<[^>]+>/g, "");
  const decoded = decodeHtmlEntities(withoutTags).replace(/\u00a0/g, " ");
  return trim ? decoded.replace(/\s+/g, " ").trim() : decoded;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function findElementsByClass(html: string, className: string): HtmlElement[] {
  const elements: HtmlElement[] = [];
  let index = 0;

  while (index < html.length) {
    const element = findFirstElementByClass(html, className, index);
    if (!element) {
      break;
    }

    elements.push(element);
    index = element.end;
  }

  return elements;
}

function findFirstElementByClass(
  html: string,
  className: string,
  fromIndex = 0,
): HtmlElement | null {
  let index = fromIndex;

  while (index < html.length) {
    const classIndex = html.indexOf(className, index);
    if (classIndex === -1) {
      return null;
    }

    const tagStart = html.lastIndexOf("<", classIndex);
    const tagEnd = html.indexOf(">", classIndex);
    if (tagStart === -1 || tagEnd === -1) {
      return null;
    }

    const openTag = html.slice(tagStart, tagEnd + 1);
    if (!hasClassToken(openTag, className)) {
      index = classIndex + className.length;
      continue;
    }

    const tagName = readTagName(openTag);
    if (!tagName) {
      index = tagEnd + 1;
      continue;
    }

    const end = findElementEnd(html, tagStart, tagName, tagEnd + 1);
    const closeTagStart = VOID_TAGS.has(tagName)
      ? tagEnd + 1
      : Math.max(tagEnd + 1, end - `</${tagName}>`.length);

    return {
      end,
      innerHtml: html.slice(tagEnd + 1, closeTagStart),
      openTag,
      outerHtml: html.slice(tagStart, end),
      start: tagStart,
    };
  }

  return null;
}

function findElementEnd(
  html: string,
  tagStart: number,
  tagName: string,
  searchFrom: number,
): number {
  if (VOID_TAGS.has(tagName)) {
    const tagEnd = html.indexOf(">", tagStart);
    return tagEnd === -1 ? html.length : tagEnd + 1;
  }

  const pattern = new RegExp(`<(/?)${tagName}\\b`, "gi");
  pattern.lastIndex = searchFrom;
  let depth = 1;

  // Track nested tags of the same name so we stop on the matching closing tag.
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const tagEnd = html.indexOf(">", match.index);
    if (tagEnd === -1) {
      return html.length;
    }

    const segment = html.slice(match.index, tagEnd + 1);
    if (match[1] === "/") {
      depth -= 1;
      if (depth === 0) {
        return tagEnd + 1;
      }
    } else if (!segment.endsWith("/>")) {
      depth += 1;
    }

    pattern.lastIndex = tagEnd + 1;
  }

  return html.length;
}

function hasClassToken(tag: string, className: string): boolean {
  const match = CLASS_ATTRIBUTE_PATTERN.exec(tag);
  if (!match) {
    return false;
  }

  const classValue = match[1] ?? match[2] ?? "";
  return classValue.split(/\s+/).includes(className);
}

function readTagName(tag: string): string | null {
  const match = /^<([a-z0-9]+)/i.exec(tag);
  return match?.[1]?.toLowerCase() ?? null;
}

function removeElementsByClass(html: string, className: string): string {
  let current = html;

  while (true) {
    const element = findFirstElementByClass(current, className);
    if (!element) {
      return current;
    }

    current = current.slice(0, element.start) + current.slice(element.end);
  }
}
