/** Complete Chat Completions transport for gateways with malformed streaming tool calls. */
import { LlmError } from '@deepseek-ai/dsh-llm'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Ask for one complete response and expose it as one valid SSE chunk so pi-ai
 * keeps its existing decoding, usage, and replay paths.
 * @param input - Provider request URL.
 * @param init - Request headers, JSON body, and cancellation signal.
 * @returns A synthetic SSE response carrying the complete assistant message.
 */
export const completeChatFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body !== 'string') throw new LlmError('Expected a JSON Chat Completions request', 'INVALID_REQUEST')
  const body: unknown = JSON.parse(init.body)
  if (!object(body)) throw new LlmError('Expected a Chat Completions request object', 'INVALID_REQUEST')
  const { stream_options: _streamOptions, ...request } = body
  const response = await fetch(input, { ...init, body: JSON.stringify({ ...request, stream: false }) })
  if (!response.ok) return response
  // Some gateways honor stream:false for tool calls but still stream text replies.
  if (response.headers.get('content-type')?.includes('text/event-stream')) return response
  const completion: unknown = await response.json()
  if (!object(completion) || !Array.isArray(completion.choices) || completion.choices.length === 0) {
    throw new LlmError('Chat Completions gateway returned no choices', 'EMPTY_RESPONSE')
  }
  const choices = completion.choices.map((choice: unknown, index: number) => {
    if (!object(choice) || !object(choice.message)) throw new LlmError('Chat Completions gateway returned no message', 'INVALID_RESPONSE')
    const message = choice.message
    const calls = message.tool_calls
    if (calls !== undefined && calls !== null && (!Array.isArray(calls) || calls.some((call: unknown) => !object(call)
      || typeof call.id !== 'string' || !call.id || !object(call.function)
      || typeof call.function.name !== 'string' || !call.function.name
      || typeof call.function.arguments !== 'string'))) {
      throw new LlmError('Chat Completions gateway returned an incomplete tool call', 'INVALID_RESPONSE')
    }
    const delta: Record<string, unknown> = { ...message }
    delete delta.tool_calls
    if (Array.isArray(calls)) {
      delta.tool_calls = calls.map((call, callIndex) => ({ ...call, index: callIndex }))
    }
    return {
      index: typeof choice.index === 'number' ? choice.index : index,
      delta,
      finish_reason: choice.finish_reason ?? (Array.isArray(calls) && calls.length ? 'tool_calls' : 'stop'),
    }
  })
  const headers = new Headers(response.headers)
  headers.set('content-type', 'text/event-stream')
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices })}\n\ndata: [DONE]\n\n`, { status: response.status, headers })
}
