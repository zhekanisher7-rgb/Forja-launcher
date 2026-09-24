'use strict';
/**
 * Streaming parser for log4j XMLLayout output (used by Mojang's client
 * logging config). Converts events into readable lines:
 *   [HH:MM:SS] [thread/LEVEL]: message
 * Non-XML text is passed through line by line.
 */
const START = '<log4j:Event';
const END = '</log4j:Event>';

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function formatEvent(xml) {
  const attr = (name) => {
    const m = new RegExp(`${name}="([^"]*)"`).exec(xml);
    return m ? decodeEntities(m[1]) : '';
  };
  const cdata = (tag) => {
    const m = new RegExp(`<log4j:${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</log4j:${tag}>`).exec(xml);
    if (!m) return '';
    return m[1] != null ? m[1] : decodeEntities(m[2] || '');
  };
  const ts = Number(attr('timestamp'));
  const time = Number.isFinite(ts) && ts > 0 ? new Date(ts).toTimeString().slice(0, 8) : '--:--:--';
  let line = `[${time}] [${attr('thread')}/${attr('level')}]: ${cdata('Message')}`;
  const thr = cdata('Throwable');
  if (thr) line += `\n${thr.trimEnd()}`;
  return line;
}

class Log4jXmlParser {
  constructor(emit, { enabled = true } = {}) {
    this.emit = emit;
    this.enabled = enabled;
    this.buf = '';
  }

  emitText(text) {
    for (const l of text.split(/\r?\n/)) if (l.trim()) this.emit(l);
  }

  feed(chunk) {
    this.buf += chunk;
    for (;;) {
      const start = this.enabled ? this.buf.indexOf(START) : -1;
      if (start === -1) {
        // pass through complete lines, keep partial tail (might be an event start)
        const nl = this.buf.lastIndexOf('\n');
        if (nl === -1) {
          if (this.enabled && this.buf.length > 0 && START.startsWith(this.buf.trimStart().slice(0, START.length))) return;
          if (this.buf.length > 65536) { this.emitText(this.buf); this.buf = ''; }
          return;
        }
        this.emitText(this.buf.slice(0, nl));
        this.buf = this.buf.slice(nl + 1);
        return;
      }
      if (start > 0) {
        this.emitText(this.buf.slice(0, start));
        this.buf = this.buf.slice(start);
      }
      const end = this.buf.indexOf(END);
      if (end === -1) return; // wait for more
      const xml = this.buf.slice(0, end + END.length);
      this.buf = this.buf.slice(end + END.length);
      for (const l of formatEvent(xml).split('\n')) this.emit(l);
    }
  }

  flush() {
    if (this.buf.trim()) this.emitText(this.buf);
    this.buf = '';
  }
}

module.exports = { Log4jXmlParser, formatEvent };
