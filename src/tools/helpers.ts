import { NexoraApiError } from '../errors.js';

export function toolResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

export function errorResult(error: unknown) {
  if (error instanceof NexoraApiError) {
    return toolResult(`Error ${error.status}: ${error.message}`, true);
  }
  if (error instanceof Error) {
    return toolResult(`Error: ${error.message}`, true);
  }
  return toolResult(`Error: ${String(error)}`, true);
}
