import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { ImageStudio } from "../src/agent/images.ts";

const photo = (tag: string): ImageContent => ({ type: "image", data: Buffer.from(tag).toString("base64"), mimeType: "image/jpeg" });

function studio(limit = 10) {
  const calls: { prompt: string; sources: string[]; aspectRatio?: string }[] = [];
  const images = new ImageStudio(async ({ prompt, sources, aspectRatio }) => {
    calls.push({ prompt, sources: (sources ?? []).map((s) => Buffer.from(s.data, "base64").toString()), aspectRatio });
    return Buffer.from(`made:${prompt}`);
  }, limit);
  return { images, calls };
}

test("edit uses the attached photo; without one, the chat's last created image; with neither, it refuses", async () => {
  const { images, calls } = studio();
  const tool = images.tool("tg:-1");
  let turn = images.begin("tg:-1", { userId: 5, unlimited: false });
  const refused = await tool.execute("1", { prompt: "make it blue", edit: true });
  assert.equal(refused.isError, true);
  await tool.execute("2", { prompt: "a cat", aspect_ratio: "16:9" });
  await tool.execute("3", { prompt: "make it blue", edit: true });
  assert.equal(images.end(turn).length, 2);
  assert.deepEqual(calls.map((c) => c.sources), [[], ["made:a cat"]]);
  assert.equal(calls[0]!.aspectRatio, "16:9");

  turn = images.begin("tg:-1", { userId: 5, unlimited: false, attached: [photo("their photo")] });
  await tool.execute("4", { prompt: "anime style", edit: true });
  images.end(turn);
  assert.deepEqual(calls[2]!.sources, ["their photo"], "an attached photo wins over the last created image");
});

test("unknown aspect ratios are dropped, not sent to xAI", async () => {
  const { images, calls } = studio();
  await images.create("k", "x", { aspectRatio: "21:9" });
  assert.equal(calls[0]!.aspectRatio, undefined);
});

test("the daily limit is per member; failed limit checks create nothing", async () => {
  const { images, calls } = studio(2);
  const tool = images.tool("k");
  const turn = images.begin("k", { userId: 5, unlimited: false });
  for (let i = 0; i < 3; i++) await tool.execute(String(i), { prompt: `p${i}` });
  images.end(turn);
  assert.equal(calls.length, 2);
  images.begin("k", { userId: 6, unlimited: false });
  assert.equal((await tool.execute("x", { prompt: "other member" })).isError, false);
});

test("a finished turn's end() doesn't remove the next turn of the same chat", async () => {
  const { images } = studio();
  const first = images.begin("k", { userId: 5, unlimited: true });
  const second = images.begin("k", { userId: 6, unlimited: true });
  images.end(first);
  await images.tool("k").execute("1", { prompt: "for the second" });
  assert.equal(images.end(second).length, 1);
  assert.equal((await images.tool("k").execute("2", { prompt: "after" })).isError, true, "no turn → no images");
});

test("/forget drops a chat's remembered image, and only that chat's", async () => {
  const { images } = studio();
  await images.create("tg:-1", "a cat");
  await images.create("tg:-1:topic:5", "a dog");
  await images.create("tg:-2", "a bird");
  images.forgetChat(-1);
  assert.equal(images.lastImage("tg:-1"), undefined);
  assert.equal(images.lastImage("tg:-1:topic:5"), undefined);
  assert.ok(images.lastImage("tg:-2"));
});
