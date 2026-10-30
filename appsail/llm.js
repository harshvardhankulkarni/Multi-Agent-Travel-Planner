// Catalyst QuickML LLM Serving client (published GLM-4.7-Flash endpoint).
// zcatalyst-sdk-node 3.x has no askLlm(), so we call the endpoint through the SDK's own
// authorized HTTP client: Catalyst injects the OAuth token and Environment header.
// Model, temperature and max tokens are fixed in the endpoint's saved configuration.

const ENDPOINT = process.env.QUICKML_LLM_ENDPOINT || "glm-flash-47";
const ENDPOINT_KEY = process.env.QUICKML_LLM_ENDPOINT_KEY;
const ORG_ID = process.env.X_ZOHO_CATALYST_ORG_ID || process.env.QUICKML_ORG_ID;

// The endpoint takes a single prompt string, so role-tagged messages are flattened into one.
export const toPrompt = (messages) =>
  messages.map((m) => `### ${m.role.toUpperCase()}\n${m.content}`).join("\n\n") + "\n\n### ASSISTANT\n";

/** messages: [{ role: "system" | "user" | "assistant", content: string }] → reply text */
export async function chat(catalystApp, messages) {
  if (!ENDPOINT_KEY) throw new Error("QUICKML_LLM_ENDPOINT_KEY is not set");
  const quickML = catalystApp.quickML();
  const resp = await quickML.requester.send({
    method: "POST",
    path: `/quickml/v1/project/${quickML.projectId}/genai/endpoints/${ENDPOINT}/generate`,
    data: { prompt: toPrompt(messages) },
    type: "json",
    headers: { "x-quickml-endpoint-key": ENDPOINT_KEY, ...(ORG_ID && { "CATALYST-ORG": ORG_ID }) },
    catalyst: false,
    track: true,
    user: "admin",
  });
  const body = resp.data;
  const text = body?.data?.[0]?.data; // { data: [{ data: "<LLM-Response>" }], usage, model }
  if (typeof text !== "string") throw new Error(`Unexpected LLM response: ${JSON.stringify(body).slice(0, 300)}`);
  return stripThinking(text);
}

// GLM reasoning models may prefix the answer with a <think>…</think> block.
export const stripThinking = (text) => text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

/** Pull the first JSON object out of model text (handles ```json fences and surrounding prose). */
export function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in model output");
  return JSON.parse(text.slice(start, end + 1));
}

/** Ask for JSON; on unparseable output, retry once with the parse error fed back. */
export async function chatJson(catalystApp, messages) {
  const first = await chat(catalystApp, messages);
  try {
    return extractJson(first);
  } catch (err) {
    // Don't echo the bad output back: the endpoint caps prompts at roughly 10k characters.
    const retry = await chat(catalystApp, [
      ...messages,
      { role: "user", content: `Your previous reply was not valid JSON (${err.message}). Reply with only the JSON object, nothing else.` },
    ]);
    return extractJson(retry);
  }
}
