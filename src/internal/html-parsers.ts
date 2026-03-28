import type { FarmableGame } from "../types";

type HtmlTag = {
  end: number;
  openTag: string;
  openTagEnd: number;
  start: number;
  tagName: string;
};

const CLASS_ATTRIBUTE_PATTERN = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const FLOAT_PATTERN = /\d+(?:\.\d+)?/;
const IMG_TAG_PATTERN = /<img\b[^>]*>/i;
const INTEGER_PATTERN = /\d+/;
const LOGIN_PATTERN = /login/i;
const SRC_ATTRIBUTE_PATTERN = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const TAG_PATTERN = /<[^>]+>/g;
const VIEW_DETAILS_PATTERN =
  /<[^>]*class\s*=\s*(?:"[^"]*\bbadge_view_details\b[^"]*"|'[^']*\bbadge_view_details\b[^']*')[^>]*>[\s\S]*?<\/[^>]+>/gi;
const WHITESPACE_PATTERN = /\s+/g;
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
  const frame = findTagByClass(html, "profile_avatar_frame");
  if (!frame) {
    return null;
  }

  const innerHtml = getTagInnerHtml(html, frame);
  const imgTag = IMG_TAG_PATTERN.exec(innerHtml)?.[0];
  if (!imgTag) {
    return null;
  }

  return extractAttributeValue(imgTag, SRC_ATTRIBUTE_PATTERN);
}

export function parseFarmableGamesFromBadgesHtml(html: string): FarmableGame[] {
  const loginAction = findTagByClass(html, "global_action_link");
  if (loginAction && LOGIN_PATTERN.test(extractText(getTagInnerHtml(html, loginAction)))) {
    throw new Error("NotLoggedIn");
  }

  const farmableGames: FarmableGame[] = [];
  let index = 0;

  while (index < html.length) {
    const row = findTagByClass(html, "badge_row", index);
    if (!row) {
      break;
    }

    index = row.end;
    const rowStart = row.start;
    const rowEnd = row.end;

    const progress = findTagByClass(html, "progress_info_bold", rowStart, rowEnd);
    if (!progress) {
      continue;
    }

    const remainingCardsText = extractText(getTagInnerHtml(html, progress));
    if (!remainingCardsText.toLowerCase().includes("card")) {
      continue;
    }

    const remainingCards = extractFirstInteger(remainingCardsText);
    if (remainingCards === null || remainingCards === 0) {
      continue;
    }

    const overlay = findTagByClass(html, "badge_row_overlay", rowStart, rowEnd);
    const href = overlay
      ? extractAttributeValue(overlay.openTag, /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
      : null;
    const appId = href ? extractAppId(href) : null;
    if (appId === null) {
      continue;
    }

    const title = findTagByClass(html, "badge_title", rowStart, rowEnd);
    if (!title) {
      continue;
    }

    const name = extractText(getTagInnerHtml(html, title).replace(VIEW_DETAILS_PATTERN, ""));
    if (!name) {
      continue;
    }

    const playTimeElement = findTagByClass(html, "badge_title_stats_playtime", rowStart, rowEnd);
    const playTimeText = playTimeElement
      ? extractText(getTagInnerHtml(html, playTimeElement), false)
      : "";
    const playTime = playTimeText.includes("hrs on record")
      ? (extractFirstFloat(playTimeText.replaceAll(",", "")) ?? 0)
      : 0;

    let droppedCards = 0;
    let headerSearchIndex = rowStart;
    while (headerSearchIndex < rowEnd) {
      const header = findTagByClass(html, "card_drop_info_header", headerSearchIndex, rowEnd);
      if (!header) {
        break;
      }

      headerSearchIndex = header.end;
      const text = extractText(getTagInnerHtml(html, header));
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

function extractAttributeValue(tag: string, attributePattern: RegExp): string | null {
  const match = attributePattern.exec(tag);
  if (!match) {
    return null;
  }

  return match[1] ?? match[2] ?? match[3] ?? null;
}

function extractAppId(href: string): number | null {
  const match = /\/gamecards\/(\d+)\//.exec(href);
  return match ? Number(match[1]) : null;
}

function extractFirstFloat(value: string): number | null {
  const match = FLOAT_PATTERN.exec(value);
  return match ? Number(match[0]) : null;
}

function extractFirstInteger(value: string): number | null {
  const match = INTEGER_PATTERN.exec(value);
  return match ? Number(match[0]) : null;
}

function extractText(value: string, trim = true): string {
  if (value === "") {
    return "";
  }

  const withoutTags = value.replace(TAG_PATTERN, "");
  const decoded = withoutTags.includes("&")
    ? decodeHtmlEntities(withoutTags).replace(/\u00a0/g, " ")
    : withoutTags.replace(/\u00a0/g, " ");

  return trim ? decoded.replace(WHITESPACE_PATTERN, " ").trim() : decoded;
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

function findTagByClass(
  html: string,
  className: string,
  fromIndex = 0,
  limit = html.length,
): HtmlTag | null {
  let index = fromIndex;

  while (index < limit) {
    const classIndex = html.indexOf(className, index);
    if (classIndex === -1 || classIndex >= limit) {
      return null;
    }

    const tagStart = html.lastIndexOf("<", classIndex);
    const tagEnd = html.indexOf(">", classIndex);
    if (tagStart === -1 || tagEnd === -1 || tagStart < fromIndex || tagEnd >= limit) {
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

    return {
      end: findTagEnd(html, tagStart, tagName, tagEnd + 1, limit),
      openTag,
      openTagEnd: tagEnd + 1,
      start: tagStart,
      tagName,
    };
  }

  return null;
}

function findTagEnd(
  html: string,
  tagStart: number,
  tagName: string,
  searchFrom: number,
  limit: number,
): number {
  if (VOID_TAGS.has(tagName)) {
    const tagEnd = html.indexOf(">", tagStart);
    return tagEnd === -1 ? limit : Math.min(tagEnd + 1, limit);
  }

  const pattern = new RegExp(`<(/?)${tagName}\\b`, "gi");
  pattern.lastIndex = searchFrom;
  let depth = 1;

  for (let match = pattern.exec(html); match && match.index < limit; match = pattern.exec(html)) {
    const tagEnd = html.indexOf(">", match.index);
    if (tagEnd === -1 || tagEnd >= limit) {
      return limit;
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

  return limit;
}

function getTagInnerHtml(html: string, tag: HtmlTag): string {
  if (VOID_TAGS.has(tag.tagName)) {
    return "";
  }

  const closeTagStart = Math.max(tag.openTagEnd, tag.end - `</${tag.tagName}>`.length);
  return html.slice(tag.openTagEnd, closeTagStart);
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
