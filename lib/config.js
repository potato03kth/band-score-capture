const fs = require('fs');

function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let stringChar = '';
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next;
        i++;
        continue;
      }
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function stripTrailingCommas(text) {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const jsonText = stripTrailingCommas(stripJsonComments(raw));
  return JSON.parse(jsonText);
}

module.exports = { loadConfig, stripJsonComments, stripTrailingCommas };
