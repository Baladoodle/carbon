// `npm run smoke:ai`: one tiny real call to the Claude API, to prove the key,
// the network path and the model work. Prints only the outcome and usage —
// never the key. Package W4 may extend this to go through the real AiGateway.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-5-5';

if (!process.env.ANTHROPIC_API_KEY) {
  console.log(JSON.stringify({ ok: false, reason: 'ANTHROPIC_API_KEY is not set' }));
  process.exit(2);
}

// The official endpoint, explicitly: ANTHROPIC_BASE_URL may point elsewhere in
// tooling environments, and carbon only ever talks to the public API.
const client = new Anthropic({ baseURL: 'https://api.anthropic.com', maxRetries: 1 });
try {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 50,
    messages: [{ role: 'user', content: 'Reply with the single word: carbon' }],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  console.log(JSON.stringify({ ok: true, model: res.model, text, usage: res.usage }));
} catch (err) {
  const status = err && typeof err === 'object' && 'status' in err ? err.status : undefined;
  const name = err instanceof Error ? err.name : 'Error';
  console.log(JSON.stringify({ ok: false, status, error: name }));
  process.exit(1);
}
