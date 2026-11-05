import type { SessionSummary } from "../../shared/bridge-protocol.js";
import type { HostServices } from "./host.js";

/**
 * Native session listing for Paseo's import picker.
 */
export class SessionListing {
  /** Folded titles per session id, so repeated listings stay cheap. */
  private readonly titles = new Map<string, string>();

  constructor(private readonly query: () => HostServices["sessionQuery"]) {}

  /**
   * List native sessions for Paseo's import picker.
   *
   * `readTitleSnapshots` decodes each requested session's log to fold its
   * title, which costs seconds per hundred sessions on a large history, so
   * titles are folded only for the rows this call returns: cwd and query
   * filter first, then newest first, then the limit. Folded titles are cached
   * for this bridge's lifetime; a title renamed outside Paseo keeps its cached
   * value until the bridge is replaced, while live sessions carry their header
   * title regardless.
   */
  async list(params: { cwd?: string; query?: string; limit?: number }): Promise<SessionSummary[]> {
    const query = this.query();
    const records = await query.listSessions();
    let sessions = records
      .map((record) => ({ ...record.header }))
      .filter((session) => !params.cwd || session.cwd === params.cwd);
    if (params.query) {
      // A title query needs every title, so this path folds the whole history.
      await this.foldTitles(query, sessions);
      const needle = params.query.toLowerCase();
      sessions = sessions.filter(
        (session) =>
          session.title?.toLowerCase().includes(needle) ||
          session.id.toLowerCase().includes(needle),
      );
    }
    sessions.sort((left, right) => right.createdAt - left.createdAt);
    if (params.limit !== undefined && sessions.length > params.limit)
      sessions = sessions.slice(0, params.limit);
    await this.foldTitles(query, sessions);
    return sessions;
  }

  /** Fill in cached titles, reading only the sessions this bridge has not folded yet. */
  private async foldTitles(
    query: HostServices["sessionQuery"],
    sessions: SessionSummary[],
  ): Promise<void> {
    if (typeof query.readTitleSnapshots !== "function") return;
    // The official bulk title read owns live/cold source and validation. A
    // header that already carries a title is live and needs no fold at all.
    const missing = sessions.filter(
      (session) => !session.title && !this.titles.has(session.id),
    );
    if (missing.length > 0) {
      const titles = await query.readTitleSnapshots(
        missing.map((session) => session.id),
      );
      for (let i = 0; i < missing.length; i++) {
        const result = titles[i];
        const title =
          result?.status === "fulfilled"
            ? result.value.title?.title
            : undefined;
        if (typeof title === "string") this.titles.set(missing[i]!.id, title);
      }
    }
    for (const session of sessions) {
      const title = this.titles.get(session.id);
      if (title !== undefined) session.title = title;
    }
  }
}
