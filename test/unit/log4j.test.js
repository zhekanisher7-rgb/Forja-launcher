'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Log4jXmlParser } = require('../../src/main/core/log4j');

const ev = (msg, level = 'INFO') => `<log4j:Event logger="x" timestamp="1700000000000" level="${level}" thread="Render thread">\n  <log4j:Message><![CDATA[${msg}]]></log4j:Message>\n</log4j:Event>\n`;

test('parses XML events split across chunks and passes plain text', () => {
  const lines = [];
  const p = new Log4jXmlParser((l) => lines.push(l));
  const data = `plain line\n${ev('Setting user: Steve')}${ev('Oops', 'ERROR')}tail`;
  for (let i = 0; i < data.length; i += 7) p.feed(data.slice(i, i + 7));
  p.flush();
  assert.equal(lines[0], 'plain line');
  assert.match(lines[1], /\[Render thread\/INFO\]: Setting user: Steve$/);
  assert.match(lines[2], /\[Render thread\/ERROR\]: Oops$/);
  assert.equal(lines[3], 'tail');
});

test('disabled parser passes everything through', () => {
  const lines = [];
  const p = new Log4jXmlParser((l) => lines.push(l), { enabled: false });
  p.feed('a\nb\n');
  p.flush();
  assert.deepEqual(lines, ['a', 'b']);
});
