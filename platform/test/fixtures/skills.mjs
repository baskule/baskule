/** Read the identifier actually offered to the model, rather than reconstructing it in a test. */
export function modelSkillId(messages, name) {
  const text = messages.map(message => typeof message.content === "string" ? message.content :
    (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");
  const skill = [...text.matchAll(/<skill>\s*<id>([^<]+)<\/id>\s*<name>([^<]+)<\/name>/g)].find(match => match[2] === name);
  if (!skill) throw new Error(`Skill ${name} was not offered to the model`);
  return skill[1];
}
