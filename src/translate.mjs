import crypto from 'node:crypto';

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((x) => ['input_text', 'output_text', 'text'].includes(x?.type)).map((x) => x.text || '').join('');
}

function chatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (['input_text', 'output_text', 'text'].includes(part?.type)) parts.push({ type: 'text', text: part.text || '' });
    else if (part?.type === 'input_image' && part.image_url) parts.push({ type: 'image_url', image_url: { url: part.image_url } });
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts.length ? parts : textFromContent(content);
}

export function responsesToChat(body, { forwardReasoningEffort = false } = {}) {
  const messages = [];
  let pendingAssistant = null;
  const flushAssistant = () => {
    if (!pendingAssistant) return;
    if (!pendingAssistant.tool_calls?.length) delete pendingAssistant.tool_calls;
    messages.push(pendingAssistant);
    pendingAssistant = null;
  };
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  const input = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }] : (body.input || []);
  for (const item of input) {
    if (item?.type === 'message' || (!item?.type && item?.role)) {
      const role = item.role === 'developer' ? 'system' : item.role;
      if (role === 'assistant') {
        flushAssistant();
        pendingAssistant = { role, content: chatContent(item.content) };
      } else {
        flushAssistant();
        messages.push({ role: role || 'user', content: chatContent(item.content) });
      }
    } else if (item?.type === 'function_call') {
      pendingAssistant ||= { role: 'assistant', content: null, tool_calls: [] };
      pendingAssistant.tool_calls ||= [];
      pendingAssistant.tool_calls.push({ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) } });
    } else if (item?.type === 'function_call_output') {
      flushAssistant();
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
    }
  }
  flushAssistant();
  const tools = (body.tools || []).filter((t) => t?.type === 'function').map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || {}, ...(t.strict !== undefined ? { strict: t.strict } : {}) } }));
  const result = { model: body.model, messages, stream: body.stream !== false };
  if (tools.length) result.tools = tools;
  if (body.tool_choice !== undefined) result.tool_choice = mapToolChoice(body.tool_choice);
  if (body.max_output_tokens) result.max_tokens = body.max_output_tokens;
  if (result.stream) result.stream_options = { include_usage: true };
  if (forwardReasoningEffort && body.reasoning?.effort) result.reasoning_effort = body.reasoning.effort;
  return result;
}

function mapToolChoice(choice) {
  if (typeof choice === 'string') return choice;
  if (choice?.type === 'function' && choice.name) return { type: 'function', function: { name: choice.name } };
  return choice;
}

function id(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }
function sse(value) { return `data: ${JSON.stringify(value)}\n\n`; }

export class ChatSseToResponses {
  constructor({ model = 'unknown' } = {}) {
    this.responseId = id('resp'); this.messageId = id('msg'); this.model = model;
    this.text = ''; this.tools = new Map(); this.usage = null; this.created = false; this.done = false;
  }
  start() {
    if (this.created) return '';
    this.created = true;
    return sse({ type: 'response.created', response: { id: this.responseId, object: 'response', status: 'in_progress', model: this.model, output: [] } });
  }
  feedData(data) {
    if (data === '[DONE]') return this.finish();
    let chunk; try { chunk = JSON.parse(data); } catch { return ''; }
    let out = this.start();
    if (chunk.usage) this.usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      this.text += delta.content;
      out += sse({ type: 'response.output_text.delta', item_id: this.messageId, output_index: 0, content_index: 0, delta: delta.content });
    }
    for (const tc of delta.tool_calls || []) {
      const index = tc.index ?? 0;
      const cur = this.tools.get(index) || { id: tc.id || id('call'), name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      this.tools.set(index, cur);
    }
    return out;
  }
  finish() {
    if (this.done) return '';
    this.done = true;
    let out = this.start();
    if (this.text) out += sse({ type: 'response.output_item.done', output_index: 0, item: { id: this.messageId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: this.text, annotations: [] }] } });
    let idx = this.text ? 1 : 0;
    for (const [, tc] of [...this.tools.entries()].sort(([a], [b]) => a - b)) {
      out += sse({ type: 'response.output_item.done', output_index: idx++, item: { id: id('fc'), type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments, status: 'completed' } });
    }
    const input = Number(this.usage?.prompt_tokens || 0), output = Number(this.usage?.completion_tokens || 0), total = Number(this.usage?.total_tokens || input + output);
    out += sse({ type: 'response.completed', response: { id: this.responseId, object: 'response', status: 'completed', model: this.model, output: [], usage: { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: total } } });
    return out;
  }
}

export async function chatJsonToResponses(response, model) {
  const text = response.choices?.[0]?.message?.content || '';
  const output = [];
  if (text) output.push({ id: id('msg'), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  for (const tc of response.choices?.[0]?.message?.tool_calls || []) output.push({ id: id('fc'), type: 'function_call', call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments || '{}', status: 'completed' });
  const u = response.usage || {};
  return { id: id('resp'), object: 'response', status: 'completed', model, output, usage: { input_tokens: u.prompt_tokens || 0, input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens || 0 }, output_tokens: u.completion_tokens || 0, output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 }, total_tokens: u.total_tokens || 0 } };
}

export async function convertChatSse(readable, onChunk, { model } = {}) {
  const converter = new ChatSseToResponses({ model });
  onChunk(converter.start());
  const decoder = new TextDecoder(); let buffer = '';
  for await (const bytes of readable) {
    buffer += decoder.decode(bytes, { stream: true });
    while (true) {
      const split = buffer.search(/\r?\n\r?\n/); if (split < 0) break;
      const block = buffer.slice(0, split); buffer = buffer.slice(buffer.match(/\r?\n\r?\n/)?.[0].length + split);
      for (const line of block.split(/\r?\n/)) if (line.startsWith('data:')) onChunk(converter.feedData(line.slice(5).trim()));
    }
  }
  onChunk(converter.finish());
}
