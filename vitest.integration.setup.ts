import { rm } from "node:fs/promises";

/**
 * Clears the Local World's data directory once, before the integration suite.
 *
 * The plugin gives each worker a fresh Local World, but they all share
 * `.workflow-data/` on disk and nothing prunes it. Left alone it grows across
 * every `npm test` and every `npm run dev`, and the suite reads all of it —
 * `runCount()` pages through the whole history to assert a delta of one.
 *
 * Two things this prevents:
 *   - the suite getting steadily slower on a long-lived checkout;
 *   - the class of bug that bit us in V4, where an unpaginated count silently
 *     saturated once history outgrew a page.
 *
 * Note this discards the run history `npx workflow inspect` would show. That is
 * the right trade for a test fixture directory the tests already write to, but
 * it is worth knowing if you were mid-investigation.
 */
export async function setup(): Promise<void> {
  await rm(".workflow-data", { recursive: true, force: true });
}
