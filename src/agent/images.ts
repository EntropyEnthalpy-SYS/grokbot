import { Type, type ImageContent } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { RateLimiter } from "../telegram/rateLimit.ts";

/** Images a member may create per day (the owner is not limited). */
export const IMAGES_PER_USER_PER_DAY = 10;
/** Images one answer may create. */
const IMAGES_PER_TURN = 4;
export const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;

export type CreateImage = (options: { prompt: string; sources?: ImageContent[]; aspectRatio?: string; signal?: AbortSignal }) => Promise<Buffer>;

/** One answer in progress: who asked, the images they attached, and the images created for them. */
export interface ImageTurn {
  readonly key: string;
  readonly userId: number | undefined;
  readonly unlimited: boolean;
  readonly attached: readonly ImageContent[];
  readonly created: Buffer[];
}

const ImageParams = Type.Object({
  prompt: Type.String({ description: "Detailed description of the image to create, or of the change to make. English works best." }),
  edit: Type.Optional(
    Type.Boolean({
      description:
        "true to edit/transform an existing image: the photo the user attached or replied to, else the last image you created in this chat. false or omitted for a brand-new image.",
    }),
  ),
  aspect_ratio: Type.Optional(Type.String({ description: `One of ${ASPECT_RATIOS.join(", ")}. Omit for square (or, when editing, the source's shape).` })),
});

type ImageToolResult = Awaited<ReturnType<AgentTool<typeof ImageParams, undefined>["execute"]>>;

const text = (message: string, isError = false): ImageToolResult => ({ content: [{ type: "text", text: message }], details: undefined, isError });

/**
 * Image creation with Grok Imagine, for the chat agent (create_image tool) and
 * for /img. Created images are handed back to the bot to post; nothing is stored
 * on disk. The last created image per chat is kept in memory for "make it bluer".
 */
export class ImageStudio {
  readonly #create: CreateImage;
  readonly #daily: RateLimiter;
  readonly #turns = new Map<string, ImageTurn>();
  readonly #last = new Map<string, ImageContent>();

  readonly #perUserPerDay: () => number;

  constructor(create: CreateImage, perUserPerDay: number | (() => number) = IMAGES_PER_USER_PER_DAY) {
    this.#create = create;
    this.#perUserPerDay = typeof perUserPerDay === "function" ? perUserPerDay : () => perUserPerDay;
    this.#daily = new RateLimiter(this.#perUserPerDay, 24 * 60 * 60 * 1000);
  }

  get perUserPerDay(): number {
    return this.#perUserPerDay();
  }

  /** Images a member has left today (the limiter's view). */
  remaining(userId: number | undefined): number {
    return Math.max(0, this.perUserPerDay - this.#daily.used(String(userId ?? 0)));
  }

  /** Call when an answer starts (inside the chat's turn queue, so turns of one chat never overlap). */
  begin(key: string, who: { userId?: number; unlimited: boolean; attached?: readonly ImageContent[] }): ImageTurn {
    const turn: ImageTurn = { key, userId: who.userId, unlimited: who.unlimited, attached: who.attached ?? [], created: [] };
    this.#turns.set(key, turn);
    return turn;
  }

  /** Call when the answer is done; returns the images to post. */
  end(turn: ImageTurn): Buffer[] {
    if (this.#turns.get(turn.key) === turn) this.#turns.delete(turn.key);
    return turn.created;
  }

  /** Check and use one image of the member's daily allowance. */
  allow(userId: number | undefined, unlimited: boolean): boolean {
    return unlimited || this.#daily.take(String(userId ?? 0));
  }

  /** Create (or edit) one image and remember it as the chat's latest. */
  async create(key: string, prompt: string, options: { sources?: ImageContent[]; aspectRatio?: string; signal?: AbortSignal } = {}): Promise<Buffer> {
    const aspectRatio = (ASPECT_RATIOS as readonly string[]).includes(options.aspectRatio ?? "") ? options.aspectRatio : undefined;
    const image = await this.#create({ prompt, sources: options.sources, aspectRatio, signal: options.signal });
    this.#remember(key, { type: "image", data: image.toString("base64"), mimeType: "image/jpeg" });
    return image;
  }

  /** /forget: drop the remembered last image of a chat (all its topics and per-question keys). */
  forgetChat(chatId: number): void {
    for (const key of [...this.#last.keys()]) {
      if (key === `tg:${chatId}` || key.startsWith(`tg:${chatId}:`)) this.#last.delete(key);
    }
  }

  lastImage(key: string): ImageContent | undefined {
    return this.#last.get(key);
  }

  tool(key: string): AgentTool<typeof ImageParams, undefined> {
    return {
      name: "create_image",
      label: "Creating image",
      description:
        "Create an image with Grok Imagine, or edit one (edit: true) such as the photo the user sent or replied to. " +
        "Use it only when someone asks you to draw, generate, design, or change a picture. The image is posted to the chat after your reply.",
      parameters: ImageParams,
      execute: async (_id, { prompt, edit, aspect_ratio }, signal) => {
        const turn = this.#turns.get(key);
        if (!turn) return text("Images can't be created here.", true);
        if (turn.created.length >= IMAGES_PER_TURN) return text(`At most ${IMAGES_PER_TURN} images per answer.`, true);
        const sources = edit ? (turn.attached.length ? [...turn.attached] : [this.#last.get(key)].filter((i) => i !== undefined)) : undefined;
        if (edit && !sources?.length) return text("There is no image to edit. Ask the user to reply to the photo they want changed.", true);
        if (!this.allow(turn.userId, turn.unlimited)) {
          return text(`This person reached today's limit of ${this.perUserPerDay} images. Tell them to try again tomorrow.`, true);
        }
        try {
          turn.created.push(await this.create(key, prompt, { sources, aspectRatio: aspect_ratio, signal }));
          return text("Done. The image will be posted right after your reply. Reply with at most one short sentence; don't describe the image.");
        } catch (error) {
          return text(`Image creation failed: ${(error as Error).message}`, true);
        }
      },
    };
  }

  #remember(key: string, image: ImageContent): void {
    this.#last.delete(key);
    this.#last.set(key, image);
    // Keep only recent chats' images in memory.
    while (this.#last.size > 20) this.#last.delete(this.#last.keys().next().value!);
  }
}
