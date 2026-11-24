import type { SessionProjection } from "@earendil-works/pi-coding-agent";

interface SearchMessage {
  type: "message";
  role: "user" | "assistant";
  content: { type: "input_text" | "output_text"; text: string }[];
}

// Mirrors recent_input for Pi's visible text messages. Pi estimates tokens at ~4 characters each.
export function recentInput(messages: SessionProjection["messages"]): SearchMessage[] | undefined {
  const tail: SearchMessage[] = [];
  let users = 0;
  let assistantBudget = 4_000;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const { role, content } = message;
    let text = typeof content === "string" ? content : content
      .filter(part => part.type === "text").map(part => part.text).join("\n");
    if (!text.trim() || (role === "user" && text.trimStart().startsWith("<environment_context>"))) continue;
    if (role === "assistant") {
      if (!assistantBudget) continue;
      text = Array.from(text).slice(-assistantBudget).join("");
      assistantBudget -= Array.from(text).length;
    }
    tail.push({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });
    if (role === "user" && ++users === 2) break;
  }
  return tail.length ? tail.reverse() : undefined;
}
