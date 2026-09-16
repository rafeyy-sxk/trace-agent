/**
 * Groq endpoints, hardcoded on purpose.
 *
 * There is deliberately no GROQ_BASE_URL support. An env-configurable base URL
 * on a path that carries an API key is a credential-exfiltration primitive:
 * anything that can set one env var can point every request at a host it
 * controls and collect the Authorization header. The provider is fixed in
 * source, where it shows up in a diff.
 */

export const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
