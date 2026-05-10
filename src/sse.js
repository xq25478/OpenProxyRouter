"use strict";

/**
 * Stateful SSE line splitter. `feed(chunk, onLine)` buffers any partial line
 * tail and emits complete lines (Buffer, stripped of the trailing CR/LF) to
 * the callback. `flush(onLine)` emits a final line if the stream ended
 * without a terminating newline.
 */
function createSSEParser() {
  let buf = null;
  return {
    feed(chunk, onLine) {
      buf = buf ? Buffer.concat([buf, chunk], buf.length + chunk.length) : chunk;
      let nl;
      while ((nl = buf.indexOf(0x0A)) !== -1) {
        const end = nl > 0 && buf[nl - 1] === 0x0D ? nl - 1 : nl;
        onLine(buf.subarray(0, end));
        buf = buf.subarray(nl + 1);
      }
    },
    flush(onLine) {
      if (!buf || buf.length === 0) return;
      const end = buf[buf.length - 1] === 0x0D ? buf.length - 1 : buf.length;
      if (end > 0) onLine(buf.subarray(0, end));
      buf = null;
    },
  };
}

// SSE spec (https://html.spec.whatwg.org/multipage/server-sent-events.html)
// allows the field name to be followed by either ": " OR just ":". Some
// OpenAI-compatible servers (and Anthropic over Bedrock in some configs)
// emit `data:{...}` without the space; rejecting those lines silently
// truncates the stream. We accept either form here and strip a single
// optional leading space from the payload.
function isSSEDataLine(line) {
  if (line.length < 5) return false;
  // "data:" = 0x64 0x61 0x74 0x61 0x3A
  return line[0] === 0x64 && line[1] === 0x61 && line[2] === 0x74 &&
    line[3] === 0x61 && line[4] === 0x3A;
}

function sseDataPayload(line) {
  // Skip the "data:" prefix, then a single optional leading space per the
  // SSE spec ("If the field value starts with a U+0020 SPACE character,
  // remove it from the field value").
  let start = 5;
  if (line.length > 5 && line[5] === 0x20) start = 6;
  return line.subarray(start).toString("utf8").trim();
}

module.exports = { createSSEParser, isSSEDataLine, sseDataPayload };
