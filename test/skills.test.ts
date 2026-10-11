import assert from "node:assert/strict";
import { test } from "node:test";
import { openDbAt } from "../src/db.ts";
import { parseSkillDefinition, SkillStore } from "../src/skills.ts";

test("a skill is defined as name = request (also : and ：); the name is one word", () => {
  assert.deepEqual(parseSkillDefinition("早報 = 今天5條AI新聞"), { name: "早報", prompt: "今天5條AI新聞" });
  assert.deepEqual(parseSkillDefinition("news: top 5 tech news, with links"), { name: "news", prompt: "top 5 tech news, with links" });
  assert.deepEqual(parseSkillDefinition("天氣：台北今天天氣"), { name: "天氣", prompt: "台北今天天氣" });
  assert.ok("error" in parseSkillDefinition("morning news = x"), "two words");
  assert.ok("error" in parseSkillDefinition("早報"), "no request");
});

test("a message that starts with a skill's name runs its request; extra words are added; other text is untouched", () => {
  const skills = new SkillStore(openDbAt(":memory:"));
  skills.set(-1, "早報", "今天5條AI新聞", { id: 1, name: "A" });
  skills.set(-1, "News", "top tech news", { id: 1, name: "A" });
  assert.equal(skills.expand(-1, "早報").text, "今天5條AI新聞");
  assert.equal(skills.expand(-1, "早報，只要加密貨幣").text, "今天5條AI新聞\n\nAlso: 只要加密貨幣");
  assert.equal(skills.expand(-1, "news").text, "top tech news", "any case");
  assert.equal(skills.expand(-1, "/skill@MyBot 早報").text, "今天5條AI新聞");
  assert.equal(skills.expand(-1, "早報表是什麼").text, "早報表是什麼", "a longer word is not the skill");
  assert.equal(skills.expand(-1, "what is news").text, "what is news", "only at the start");
  assert.equal(skills.expand(-2, "早報").text, "早報", "skills belong to their chat");
  assert.equal(skills.get(-1, "早報")!.uses, 3);
  skills.set(-1, "news", "world news", { id: 2, name: "B" });
  assert.deepEqual(skills.list(-1).map((k) => [k.name, k.prompt]), [["早報", "今天5條AI新聞"], ["news", "world news"]], "same name in another case replaces it");
  assert.equal(skills.remove(-1, "NEWS"), true);
  assert.equal(skills.count(-1), 1);
});
