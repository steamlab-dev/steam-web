import { describe, expect, it } from "vitest";
import {
  parseAvatarFrameFromProfileHtml,
  parseFarmableGamesFromBadgesHtml,
} from "@/internal/html-parsers";
import { badgesHtml, profileHtml } from "../support/test-helpers";

describe("internal html parsers from fixtures", () => {
  it("extracts avatar frame URL from profile fixture", () => {
    expect(parseAvatarFrameFromProfileHtml(profileHtml)).toMatch(
      /^https:\/\/shared\.fastly\.steamstatic\.com\//,
    );
  });

  it("returns null when avatar frame class is removed from fixture", () => {
    const withoutFrame = profileHtml.replace(
      /profile_avatar_frame/g,
      "profile_avatar_frame_removed",
    );
    expect(parseAvatarFrameFromProfileHtml(withoutFrame)).toBeNull();
  });

  it("throws NotLoggedIn when fixture global action text includes login", () => {
    const loggedOutLike = badgesHtml.replace(
      /(<button class="pulldown global_action_link[^>]*>)[\s\S]*?(<\/button>)/,
      "$1login$2",
    );
    expect(() => parseFarmableGamesFromBadgesHtml(loggedOutLike)).toThrow(new Error("NotLoggedIn"));
  });

  it("still parses farmable games when rows are partially degraded from fixture", () => {
    const degraded = badgesHtml
      .replace("progress_info_bold", "progress_info_bold_missing")
      .replace("badge_title_stats_playtime", "badge_title_stats_playtime_missing")
      .replace("gamecards", "notcards");

    const parsed = parseFarmableGamesFromBadgesHtml(degraded);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(0);
  });

  it("parses numbers and drop counts from the original fixture", () => {
    const parsed = parseFarmableGamesFromBadgesHtml(badgesHtml);

    expect(parsed.length).toBeGreaterThanOrEqual(2);
    expect(parsed.every((entry) => Number.isInteger(entry.appId))).toBe(true);
    expect(parsed.every((entry) => entry.remainingCards > 0)).toBe(true);
    expect(parsed.every((entry) => entry.playTime >= 0)).toBe(true);
    expect(parsed.every((entry) => entry.droppedCards >= 0)).toBe(true);
  });

  it("handles missing image tags inside avatar frame containers", () => {
    const withoutImg = profileHtml.replace(/<img\b/gi, "<source");
    expect(parseAvatarFrameFromProfileHtml(withoutImg)).toBeNull();
  });

  it("matches exact class tokens instead of partial class-name substrings", () => {
    const partialClassOnly = profileHtml.replace(
      /class="profile_avatar_frame"/g,
      'class="profile_avatar_frame_extra"',
    );

    expect(parseAvatarFrameFromProfileHtml(partialClassOnly)).toBeNull();
  });

  it("extracts avatar frame image src from single-quoted attributes", () => {
    const singleQuoted = `
      <div class='profile_avatar_frame'>
        <picture>
          <img src='https://cdn.example/frame.png'>
        </picture>
      </div>
    `;

    expect(parseAvatarFrameFromProfileHtml(singleQuoted)).toBe("https://cdn.example/frame.png");
  });

  it.each([
    (html: string) => html.replace(/card drops remaining/g, "drops remaining"),
    (html: string) => html.replace(/badge_title_stats_playtime/g, "badge_title_stats_playtime_x"),
    (html: string) => html.replace(/class="badge_title"/g, 'class="badge_title_x"'),
    (html: string) => html.replace(/badge_row_overlay/g, "badge_row_overlay_x"),
    (html: string) => html.replace(/gamecards\//g, "notcards/"),
    (html: string) => html.replace(/gamecards\/\d+\//, "gamecards/not-a-number/"),
    (html: string) =>
      html.replace(
        /href="https:\/\/steamcommunity\.com\/id\/Machiagod\/gamecards\/\d+\/"/,
        'href_missing="x"',
      ),
  ])("skips malformed fixture variants safely", (mutate) => {
    const parsedBase = parseFarmableGamesFromBadgesHtml(badgesHtml);
    const parsedMutated = parseFarmableGamesFromBadgesHtml(mutate(badgesHtml));
    expect(parsedMutated.length).toBeLessThanOrEqual(parsedBase.length);
  });

  it("handles malformed and truncated fixture content safely", () => {
    const truncated = badgesHtml.slice(0, Math.floor(badgesHtml.length / 2));
    const brokenTag = badgesHtml.replace("<div class=", "< class=");

    expect(() => parseFarmableGamesFromBadgesHtml(truncated)).not.toThrow();
    expect(() => parseFarmableGamesFromBadgesHtml(brokenTag)).not.toThrow();
  });

  it("parses fixture titles containing encoded entities", () => {
    const encodedTitle = badgesHtml
      .replace("We Were Here Too", "We&#x20;Were&#32;Here&#x20;Too")
      .replace("We Were Here Together", "We&#x20;Were&#32;Here&#x20;Together");
    const parsed = parseFarmableGamesFromBadgesHtml(encodedTitle);
    expect(parsed.some((entry) => entry.name.includes("We Were Here Too"))).toBe(true);
  });

  it("parses rows that use single-quoted href attributes", () => {
    const singleQuotedHref = badgesHtml.replace(
      /href="https:\/\/steamcommunity\.com\/id\/Machiagod\/gamecards\/865360\/"/,
      "href='https://steamcommunity.com/id/Machiagod/gamecards/865360/'",
    );

    const parsed = parseFarmableGamesFromBadgesHtml(singleQuotedHref);
    expect(parsed.some((entry) => entry.appId === 865360)).toBe(true);
  });

  it("decodes numeric HTML entities from fixture-derived text", () => {
    const encodedGlobalAction = badgesHtml.replace("Wallet ($0.00)", "Wallet &#x41;&#65;");
    expect(() => parseFarmableGamesFromBadgesHtml(encodedGlobalAction)).not.toThrow();
  });

  it("handles overlays without href and playtime text without numeric values", () => {
    const mutated = badgesHtml
      .replace(/href="/, 'href_missing="')
      .replace(/\d[\d,.]*\s*hrs on record/g, "hrs on record");

    expect(() => parseFarmableGamesFromBadgesHtml(mutated)).not.toThrow();
  });

  it("keeps nested same-tag sections inside a badge row grouped correctly", () => {
    const nestedRow = `
      <div class="badge_row is_link">
        <a class="badge_row_overlay" href="https://steamcommunity.com/id/test/gamecards/123/"></a>
        <div class="badge_title_row">
          <div class="badge_title_stats">
            <div class="badge_title_stats_playtime">1.5 hrs on record</div>
            <div class="badge_title_stats_drops">
              <span class="progress_info_bold">3 card drops remaining</span>
              <div class="card_drop_info_header">Card drops received: 7</div>
              <div>
                <div class="card_drop_info_header">Nested extra header</div>
              </div>
            </div>
          </div>
          <div class="badge_title">Nested Game &nbsp;<span class="badge_view_details">View details</span></div>
        </div>
      </div>
    `;

    expect(parseFarmableGamesFromBadgesHtml(nestedRow)).toEqual([
      {
        appId: 123,
        droppedCards: 7,
        name: "Nested Game",
        playTime: 1.5,
        remainingCards: 3,
      },
    ]);
  });

  it("returns only rows with remaining card drops when mixed with invalid rows", () => {
    const mixedRows = `
      <div class="badge_row is_link">
        <a class="badge_row_overlay" href="https://steamcommunity.com/id/test/gamecards/10/"></a>
        <div class="badge_title_stats_playtime">2 hrs on record</div>
        <span class="progress_info_bold">No card drops remaining</span>
        <div class="badge_title">Skip Me <span class="badge_view_details">View details</span></div>
      </div>
      <div class="badge_row is_link">
        <a class="badge_row_overlay" href="https://steamcommunity.com/id/test/gamecards/11/"></a>
        <div class="badge_title_stats_playtime">4.2 hrs on record</div>
        <span class="progress_info_bold">2 card drops remaining</span>
        <div class="card_drop_info_header">Card drops received: 1</div>
        <div class="badge_title">Keep Me <span class="badge_view_details">View details</span></div>
      </div>
      <div class="badge_row is_link">
        <a class="badge_row_overlay" href="https://steamcommunity.com/id/test/notcards/12/"></a>
        <div class="badge_title_stats_playtime">6 hrs on record</div>
        <span class="progress_info_bold">3 card drops remaining</span>
        <div class="badge_title">Skip Wrong Link <span class="badge_view_details">View details</span></div>
      </div>
    `;

    expect(parseFarmableGamesFromBadgesHtml(mixedRows)).toEqual([
      {
        appId: 11,
        droppedCards: 1,
        name: "Keep Me",
        playTime: 4.2,
        remainingCards: 2,
      },
    ]);
  });
});
