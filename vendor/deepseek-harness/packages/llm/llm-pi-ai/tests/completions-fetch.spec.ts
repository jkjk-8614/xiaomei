import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeChatFetch } from '../src/completions-fetch.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '99', ...init.headers },
    ...init,
  })
}

describe('completeChatFetch', () => {
  it('turns one complete tool call into one correlated SSE chunk', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gemini-3.8-flash', stream: false })
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('stream_options')
      return jsonResponse({
        id: 'cmpl-1',
        choices: [{ index: 0, message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'echo_test', arguments: '{"word":"测试"}' } }],
        }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      })
    })
    vi.stubGlobal('fetch', upstream)

    const response = await completeChatFetch('https://gateway.test/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'gemini-3.8-flash', stream: true, stream_options: { include_usage: true } }),
    })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('content-length')).toBeNull()
    const text = await response.text()
    expect(text).toContain('"id":"call-1"')
    expect(text).toContain('"name":"echo_test"')
    expect(text).toContain('"arguments":"{\\"word\\":\\"测试\\"}"')
    expect(text).toContain('data: [DONE]')
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('accepts gateways that send tool_calls null and omits it from the delta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'done', tool_calls: null }, finish_reason: 'stop' }],
    })))
    const response = await completeChatFetch('https://gateway.test', {
      body: JSON.stringify({ model: 'm', stream: true }),
    })
    const first = (await response.text()).split('\n\n')[0]
    expect(first).toContain('"content":"done"')
    expect(first).not.toContain('tool_calls')
  })

  it('passes non-2xx responses through unchanged', async () => {
    const error = new Response('{"error":{"message":"busy"}}', { status: 503 })
    const upstream = vi.fn(async () => error)
    vi.stubGlobal('fetch', upstream)
    const result = await completeChatFetch('https://gateway.test', { body: '{}' })
    expect(result).toBe(error)
  })

  it('accepts a gateway that still streams its follow-up text response', async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"done"},"index":0}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    expect(await completeChatFetch('https://gateway.test', { body: '{}' })).toBe(response)
  })

  it.each([
    ['empty choices', { choices: [] }],
    ['missing message', { choices: [{}] }],
    ['missing tool name', { choices: [{ message: { tool_calls: [{ id: 'x', function: { arguments: '{}' } }] } }] }],
  ])('rejects %s from a successful gateway response', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body)))
    await expect(completeChatFetch('https://gateway.test', { body: '{}' })).rejects.toThrow()
  })

  it('forwards the caller cancellation signal', async () => {
    const controller = new AbortController()
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
    })
    vi.stubGlobal('fetch', upstream)
    await completeChatFetch('https://gateway.test', { signal: controller.signal, body: '{}' })
  })
})
