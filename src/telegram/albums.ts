/**
 * Photos (or videos) sent together arrive as separate messages that share a `media_group_id`,
 * and only one of them carries the text. This keeps the recent ones together, so a question
 * about an album sees every picture and is answered once.
 */

type Item = { message_id: number; media_group_id?: string };

/** Albums are kept this long: a reply to one picture can still see the others. */
const KEEP_MS = 10 * 60 * 1000;

export class AlbumCollector<M extends Item> {
  readonly #albums = new Map<string, { items: M[]; at: number; claimed: boolean }>();

  /** Remember an album item (call for every incoming message; others are ignored). */
  add(message: M, now = Date.now()): void {
    const id = message.media_group_id;
    if (!id) return;
    for (const [key, album] of this.#albums) if (now - album.at > KEEP_MS) this.#albums.delete(key);
    const album = this.#albums.get(id) ?? { items: [], at: now, claimed: false };
    if (!album.items.some((m) => m.message_id === message.message_id)) album.items.push(message);
    album.at = now;
    this.#albums.set(id, album);
  }

  /** True for the first item of an album that asks for an answer; false for the rest, which that answer covers. */
  claim(message: M): boolean {
    const album = message.media_group_id ? this.#albums.get(message.media_group_id) : undefined;
    if (!album) return true;
    if (album.claimed) return false;
    album.claimed = true;
    return true;
  }

  /** The album's items seen so far, in message order; just the message itself when it isn't in one. */
  items(message: M): M[] {
    const album = message.media_group_id ? this.#albums.get(message.media_group_id) : undefined;
    return album ? [...album.items].sort((a, b) => a.message_id - b.message_id) : [message];
  }

  /** The whole album, once Telegram has delivered the rest: no new item for `quietMs` (at most `maxMs`). */
  async complete(message: M, quietMs = 1200, maxMs = 5000): Promise<M[]> {
    if (!message.media_group_id) return [message];
    const started = Date.now();
    let count = -1;
    while (Date.now() - started < maxMs) {
      const now = this.items(message).length;
      if (now === count) break;
      count = now;
      await new Promise((resolve) => setTimeout(resolve, quietMs));
    }
    return this.items(message);
  }
}
