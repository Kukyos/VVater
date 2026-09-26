// The narration: every scene's `say` in script.json, read by one ElevenLabs voice into
// public/voice/<scene>.mp3, where check.mjs and the film pick it up.
//
//   node narrate.mjs --plan    what would be rendered, and how many characters that costs
//   node narrate.mjs           render what is missing or changed
//   node narrate.mjs --fit     then size each scene to its line (see below)
//
// A line re-renders only when its spoken text or the voice changes: the hash of both is kept
// in public/voice/narration.json beside the file. The key is ELEVENLABS_API_KEY in ../.env.
//
// --fit: a scene must hold its line, from half a second in, with a second and a half after.
// A card is set to exactly that, never under its `minSeconds` (reading time for what
// it shows) or 5 s. A clip scene only ever grows, onto its last
// clip, because a shorter clip would have to be recorded again anyway; the clips that grew
// are listed, to be re-recorded with capture.cjs.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const VOICE = { id: '6fZce9LFNG3iEITDfqZZ', name: 'Charlotte' };
const MODEL = 'eleven_multilingual_v2';
// A product film, not a kiosk: normal speed, a little less stability for some life.
const SETTINGS = { stability: 0.45, similarity_boost: 0.75, speed: 1.0 };
export const LEAD = 0.5, TAIL = 1.5;

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, 'script.json');
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
const out = join(here, 'public', 'voice');
const cachePath = join(out, 'narration.json');
mkdirSync(out, { recursive: true });
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

const spoken = (s) => Object.entries(script.speak || {}).filter(([k]) => k !== '_')
  .reduce((t, [k, v]) => t.replaceAll(k, v), s.say);
const hash = (text) => createHash('sha256').update(`${VOICE.id}\n${MODEL}\n${JSON.stringify(SETTINGS)}\n${text}`).digest('hex').slice(0, 16);
const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

const args = process.argv.slice(2);
const todo = script.scenes.filter((s) => {
  const c = cache[s.id];
  return !c || c.hash !== hash(spoken(s)) || !existsSync(join(out, `${s.id}.mp3`));
});

console.log(`${VOICE.name}: ${script.scenes.length} lines, ${todo.length} to render, ` +
  `${todo.reduce((n, s) => n + spoken(s).length, 0)} characters`);
if (args.includes('--plan')) { todo.forEach((s) => console.log(`  ${s.id}: ${spoken(s)}`)); process.exit(0); }

if (todo.length) {
  const env = readFileSync(join(here, '..', '.env'), 'utf8');
  const key = env.match(/^ELEVENLABS_API_KEY=(.*)$/m)?.[1]?.trim();
  if (!key) throw new Error('ELEVENLABS_API_KEY is not in ../.env');
  for (const s of todo) {
    const text = spoken(s);
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE.id}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: MODEL, voice_settings: SETTINGS }),
    });
    if (!r.ok) throw new Error(`${s.id}: ElevenLabs ${r.status} ${await r.text()}`);
    const f = join(out, `${s.id}.mp3`);
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    cache[s.id] = { hash: hash(text), seconds: Number(probe(f).toFixed(2)) };
    writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
    console.log(`  ${s.id.padEnd(12)} ${cache[s.id].seconds} s`);
  }
}

if (args.includes('--fit')) {
  const grew = [];
  for (const s of script.scenes) {
    const need = Math.ceil((cache[s.id].seconds + LEAD + TAIL) * 2) / 2;
    if (s.card) { s.seconds = Math.max(s.minSeconds ?? 5, need); continue; }
    const have = s.clips.reduce((n, c) => n + c.seconds, 0);
    if (need > have) {
      const last = s.clips.at(-1);
      last.seconds += need - have;
      grew.push(last.name);
    }
  }
  writeFileSync(scriptPath, JSON.stringify(script, null, 2) + '\n');
  console.log(grew.length ? `re-record: node capture.cjs ${grew.join(' ')}` : 'every clip already holds its line');
}
