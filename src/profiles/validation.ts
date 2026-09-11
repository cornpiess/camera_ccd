import { HUE_BAND_NAMES, type ProfileDocument, type ProfileValidationResult } from './types';
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const unknownKeys = (v: Obj, keys: readonly string[], p: string, e: string[]) => Object.keys(v).forEach(k => { if (!keys.includes(k)) e.push(`${p}.${k} is not supported`); });
const nums = (v: unknown, keys: readonly string[], p: string, e: string[]): v is Obj => {
  if (!obj(v)) { e.push(`${p} must be an object`); return false; }
  unknownKeys(v, keys, p, e);
  keys.forEach(k => { if (typeof v[k] !== 'number' || !Number.isFinite(v[k])) e.push(`${p}.${k} must be a finite number`); });
  return true;
};
const profile = (v: unknown, i: number, e: string[]): void => {
  const p = `profiles[${i}]`;
  if (!obj(v)) { e.push(`${p} must be an object`); return; }
  unknownKeys(v, ['id','name','aperture','ui','raw','tone','color','texture'], p, e);
  for (const k of ['id','name'] as const) if (typeof v[k] !== 'string' || v[k].trim() === '') e.push(`${p}.${k} must be a non-empty string`);
  nums(v.aperture, ['preferred'], `${p}.aperture`, e);
  if (obj(v.aperture) && typeof v.aperture.preferred === 'number' && v.aperture.preferred <= 0) e.push(`${p}.aperture.preferred must be greater than zero`);
  if (!obj(v.ui)) e.push(`${p}.ui must be an object`); else {
    unknownKeys(v.ui, ['shortName','accent','dialStyle'], `${p}.ui`, e);
    for (const k of ['shortName','accent','dialStyle']) if (typeof v.ui[k] !== 'string' || v.ui[k] === '') e.push(`${p}.ui.${k} must be a non-empty string`);
  }
  nums(v.raw, ['sharpness','detail','localToneMap','luminanceNoiseReduction','colorNoiseReduction'], `${p}.raw`, e);
  if (!obj(v.tone)) e.push(`${p}.tone must be an object`); else {
    const tone = v.tone;
    unknownKeys(tone, ['exposure','contrast','blackPoint','curve'], `${p}.tone`, e);
    ['exposure','contrast','blackPoint'].forEach(k => { if (typeof tone[k] !== 'number' || !Number.isFinite(tone[k])) e.push(`${p}.tone.${k} must be a finite number`); });
    const curve = tone.curve;
    if (!Array.isArray(curve) || curve.length !== 5) e.push(`${p}.tone.curve must contain exactly five [x, y] points (the native tone-curve renderer requires exactly five)`);
    else {
      if (Array.isArray(curve[0]) && curve[0][0] !== 0) e.push(`${p}.tone.curve[0][0] must be 0 so the curve starts at black`);
      if (Array.isArray(curve[4]) && curve[4][0] !== 1) e.push(`${p}.tone.curve[4][0] must be 1 so the curve ends at white`);
      let last = -Infinity;
      curve.forEach((point, j) => {
        if (!Array.isArray(point) || point.length !== 2 || point.some(n => typeof n !== 'number' || !Number.isFinite(n))) { e.push(`${p}.tone.curve[${j}] must be a finite [x, y] tuple`); return; }
        const x = point[0] as number;
        const y = point[1] as number;
        if (x < 0 || x > 1 || y < 0 || y > 1) e.push(`${p}.tone.curve[${j}] values must be between 0 and 1`);
        if (x <= last) e.push(`${p}.tone.curve[${j}][0] must increase strictly`);
        last = x;
      });
    }
  }
  if (!obj(v.color)) e.push(`${p}.color must be an object`); else {
    const color = v.color;
    unknownKeys(color, ['saturation','temperature','tint','hueBands'], `${p}.color`, e);
    ['saturation','temperature','tint'].forEach(k => { if (typeof color[k] !== 'number' || !Number.isFinite(color[k])) e.push(`${p}.color.${k} must be a finite number`); });
    if (!obj(color.hueBands)) e.push(`${p}.color.hueBands must be an object`); else {
      const hueBands = color.hueBands;
      unknownKeys(hueBands, HUE_BAND_NAMES, `${p}.color.hueBands`, e);
      HUE_BAND_NAMES.forEach(b => nums(hueBands[b], ['hue','saturation','luminance'], `${p}.color.hueBands.${b}`, e));
    }
  }
  if (!obj(v.texture)) e.push(`${p}.texture must be an object`); else {
    unknownKeys(v.texture, ['grain','vignette','halation'], `${p}.texture`, e);
    nums(v.texture.grain, ['amount','size'], `${p}.texture.grain`, e);
    nums(v.texture.vignette, ['amount','radius'], `${p}.texture.vignette`, e);
    nums(v.texture.halation, ['amount','radius'], `${p}.texture.halation`, e);
  }
};
export function validateProfileDocument(value: unknown): ProfileValidationResult {
  const errors: string[] = [];
  if (!obj(value)) return { success: false, errors: ['Document root must be an object'] };
  unknownKeys(value, ['schemaVersion','profiles'], 'document', errors);
  if (value.schemaVersion !== 1) errors.push('document.schemaVersion must equal 1');
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) errors.push('document.profiles must be a non-empty array'); else {
    value.profiles.forEach((v,i) => profile(v,i,errors));
    const ids = value.profiles.filter(obj).map(v => v.id).filter((id): id is string => typeof id === 'string');
    ids.forEach((id,i) => { if (ids.indexOf(id) !== i) errors.push(`profiles contains duplicate id "${id}"`); });
  }
  return errors.length ? { success: false, errors } : { success: true, document: value as unknown as ProfileDocument };
}
export function parseProfileDocument(text: string): ProfileValidationResult {
  try { return validateProfileDocument(JSON.parse(text) as unknown); }
  catch (error: unknown) { return { success: false, errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`] }; }
}
export function assertProfileDocument(value: unknown): asserts value is ProfileDocument {
  const result = validateProfileDocument(value); if (!result.success) throw new Error(result.errors.join('\n'));
}
export type { CameraProfile, ProfileDocument } from './types';
