// Fails if server-php/src/Models.php and extension/lib/models.js disagree.
import { execFileSync } from 'node:child_process';
import { MODELS } from '../../extension/lib/models.js';
const php = JSON.parse(execFileSync('php', ['-r', `require '${new URL('../src/Models.php', import.meta.url).pathname}'; echo json_encode(Models::all());`]).toString());
let bad = 0;
for (const id of new Set([...Object.keys(MODELS), ...Object.keys(php)])) {
  const js = MODELS[id], p = php[id] || {};
  for (const k of ['work', 'shortBreak', 'longBreak', 'longEvery']) {
    if ((js && js[k]) !== p[k]) { bad++; console.log('MISMATCH', id, k, js && js[k], p[k]); }
  }
}
console.log(bad ? `${bad} mismatches` : 'models identical');
process.exit(bad ? 1 : 0);
