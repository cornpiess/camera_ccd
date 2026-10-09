// Offline regression checks. These protect imports and character separation;
// they do not replace Core Image pixel/performance QA on an iPhone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { applyPipeline, rgbToHSL } = require('./tone-audit');
const root = path.resolve(__dirname, '..');
const doc = JSON.parse(fs.readFileSync(path.join(root, 'assets/camera-profiles.json'), 'utf8'));
// Exercise the actual runtime validator, not a second hand-written JSON schema.
const previous = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { validateProfileDocument } = require('../src/profiles/validation.ts');
if (previous) require.extensions['.ts'] = previous;
else delete require.extensions['.ts'];
assert.equal(validateProfileDocument(doc).success, true);
for (const offset of [[0, 0], [0, NaN, 0], [0, 0.13, 0], [true, 0, 0]]) {
  const bad = structuredClone(doc);
  bad.profiles[0].color.splitTone.shadows = offset;
  assert.equal(validateProfileDocument(bad).success, false, 'invalid split tone must not replace the current look');
}
const badCopy = structuredClone(doc);
badCopy.profiles[0].ui.look.zh.description = '';
assert.equal(validateProfileDocument(badCopy).success, false);
const legacy = structuredClone(doc);
for (const p of legacy.profiles) { delete p.ui.look; delete p.color.splitTone; }
assert.equal(validateProfileDocument(legacy).success, true, 'existing overrides remain importable');

const orig = doc.profiles.find(p => p.passthrough);
assert.equal(orig.aperture, undefined);
for (const p of doc.profiles) for (let r=0;r<=8;r++) for (let g=0;g<=8;g++) for (let b=0;b<=8;b++) {
  const input=[r/8,g/8,b/8], output=applyPipeline(p,input);
  assert(output.every(v=>Number.isFinite(v)&&v>=0&&v<=1), `${p.id}: finite in-gamut RGB`);
  if (p.passthrough) assert.deepEqual(output,input, 'ORIG stays exact identity');
}
const negative=doc.profiles.find(p=>p.id==='ricoh_negative');
const positive=doc.profiles.find(p=>p.id==='ricoh_positive');
const green=[.2,.55,.28];
assert(rgbToHSL(applyPipeline(negative,green))[0] > rgbToHSL(applyPipeline(positive,green))[0]+12, 'positive yellow-green and negative teal must separate');
const probes=[[.2,.55,.28],[.2,.38,.75],[.72,.19,.16],[.25,.25,.25],[.65,.65,.65]];
const difference=probes.reduce((sum,rgb)=>sum+applyPipeline(negative,rgb).reduce((d,v,k)=>d+Math.abs(v-rgb[k]),0),0)/(probes.length*3);
assert(difference>.045, 'GRIT N must visibly differ from ORIG on representative colors');
const skin=[.855,.639,.494];
for (const p of doc.profiles.filter(p=>!p.passthrough)) {
  const out=applyPipeline(p,skin);
  assert(out[0]>out[1]&&out[1]>out[2], `${p.id}: warm skin must not turn green/blue`);
}
// Contract guard for the original production bug: each hue band must use its own dictionary.
const swift=fs.readFileSync(path.join(root,'modules/camera-engine/ios/CameraEngineModule.swift'),'utf8');
assert(swift.includes('dictionary(dictionary(color["hueBands"])[name])'), 'native fused cube must read individual hue bands');
console.log(`Look checks passed: runtime validation, legacy imports, ${8*9**3} RGB probes, skin/green separation, ORIG identity. GRIT N mean RGB change=${difference.toFixed(3)}.`);
