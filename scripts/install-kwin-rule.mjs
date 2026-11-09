#!/usr/bin/env node
// Merge the framing rule for the Figaro settings window into kwinrulesrc.
//
// KWin has no include mechanism, so the rule has to live in the user's own
// kwinrulesrc next to any rules they already have. This reads the file, keeps
// every existing rule, replaces our rule if it is already there (matched by its
// description) and bumps the counters. It prints what it did and never touches
// other rules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DESCRIPTION = 'Figaro settings frameless';
const file = process.env.KWINRULESRC || path.join(os.homedir(), '.config/kwinrulesrc');
const RULE = {
  Description: DESCRIPTION,
  noborder: 'true',
  noborderrule: '2',
  wmclass: 'quickshell',
  wmclassmatch: '2',
  wmclasscomplete: 'false',
  types: '1',
};

function parse(text) {
  const groups = new Map();
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1);
      groups.set(current, new Map());
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0 && current) groups.get(current).set(line.slice(0, eq), line.slice(eq + 1));
  }
  return groups;
}

function serialize(groups) {
  const out = [];
  for (const [name, entries] of groups) {
    out.push(`[${name}]`);
    for (const [k, v] of entries) out.push(`${k}=${v}`);
    out.push('');
  }
  return out.join('\n');
}

const exists = fs.existsSync(file);
let groups = exists ? parse(fs.readFileSync(file, 'utf8')) : new Map();
const general = groups.get('General') ?? new Map();
groups.set('General', general);

// Find an existing copy of our rule.
let ruleId = null;
for (const [name, entries] of groups) {
  if (name === 'General') continue;
  if (entries.get('Description') === DESCRIPTION || entries.get('description') === DESCRIPTION) {
    ruleId = name;
    break;
  }
}
const count = Number(general.get('count') ?? 0) || 0;
if (ruleId === null) ruleId = String(count + 1);
groups.set(ruleId, new Map(Object.entries(RULE)));

const ids = [...groups.keys()].filter((name) => name !== 'General').sort((a, b) => Number(a) - Number(b));
general.set('count', String(ids.length));
general.set('rules', ids.join(','));

if (exists) {
  const backup = `${file}.figaro-bak`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, fs.readFileSync(file));
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, serialize(groups));
console.log(`kwin rule "${DESCRIPTION}" -> ${file} (rule ${ruleId}${exists ? ', merged' : ', created'})`);
