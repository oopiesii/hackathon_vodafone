import assert from "node:assert/strict";
import test from "node:test";
import { parseAppStoreReviewsPage } from "../apps/api/dist/lib/context-sources.js";

test("parses only review content from official App Store server data", () => {
  const state = { data: [{ data: { shelfMapping: { allProductReviews: { items: [
    { review: { id: "42", rating: 1, date: "2026-09-20T10:00:00.000Z", title: "Не працює", contents: "Vodafone не працює, +380 67 111 22 33", reviewerName: "PERSONAL-AUTHOR" } },
    { review: { id: "43", rating: 5, date: "2026-09-19T10:00:00.000Z", title: "Добре", contents: "Все добре", reviewerName: "ANOTHER-AUTHOR" } },
  ] } } } }] };
  const html = `<html><script type="application/json" id="serialized-server-data">${JSON.stringify(state)}</script></html>`;
  const reviews = parseAppStoreReviewsPage(html);
  assert.equal(reviews.length, 2);
  assert.deepEqual(Object.keys(reviews[0]).sort(), ["date", "id", "rating", "text", "title", "version"]);
  assert.equal(reviews[0].text, "Vodafone не працює, [номер вилучено]");
  assert.doesNotMatch(JSON.stringify(reviews), /PERSONAL-AUTHOR|ANOTHER-AUTHOR/);
});

test("rejects pages without Apple's structured review shelf", () => {
  assert.throws(() => parseAppStoreReviewsPage("<html></html>"), /apple_page_without_data/);
});
