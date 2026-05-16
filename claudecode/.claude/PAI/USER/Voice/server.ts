#!/usr/bin/env bun
/**
 * Voice Server - Multi-Provider TTS Notification Server
 *
 * Supports three TTS providers (configurable in voices.json):
 * 1. Kokoro (local) - Free, offline, no API key needed
 * 2. ElevenLabs (cloud) - Premium quality, requires API key
 * 3. macOS say (system) - Basic quality, always available fallback
 *
 * Features:
 * - Provider abstraction layer for extensibility
 * - Per-provider circuit breakers (fast fallback after failures)
 * - Configurable fallback chain
 * - Environment variable support for API keys
 * - Consolidated config in voices.json
 * - Pronunciation preprocessing (pronunciations.json)
 * - 13 Emotional presets via emoji markers ([💡 insight], [🎉 celebration], etc.)
 * - Pass-through voice_settings from callers (tier-1 override)
 */

import { serve } from "bun";
import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// =============================================================================
// Types and Interfaces
// =============================================================================

interface TTSProvider {
  name: string;
  isEnabled(): boolean;
  isHealthy(): Promise<boolean>;
  speak(text: string, voice?: string, settings?: VoiceSettings): Promise<boolean>;
}

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

interface VoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  speed?: number;
  use_speaker_boost?: boolean;
}

interface ProviderConfig {
  enabled: boolean;
  apiKey?: string;
  endpoint?: string;
  defaultVoice?: string;
  defaultVoiceId?: string;
  voice?: string;
  rate?: string;
  description?: string;
}

interface VoiceMapping {
  description?: string;
  catchphrase?: string;
  elevenlabs?: {
    voice_id: string;
    voice_name?: string;
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
  kokoro?: {
    voice: string;
    speed?: number;
  };
}

interface VoicesConfig {
  providers: {
    edgetts: ProviderConfig;
    kokoro: ProviderConfig;
    elevenlabs: ProviderConfig;
    say: ProviderConfig;
  };
  defaultProvider: string;
  fallbackOrder: string[];
  default_rate?: number;
  default_volume?: number;
  identity: VoiceMapping;
  agents: Record<string, VoiceMapping>;
}

// =============================================================================
// Structured Logging
// =============================================================================

// TODO: Add session ID support for Pi (pi-agent) and OpenCode agents.
// Currently only Claude Code sessions pass session_id. When Pi and OpenCode
// adapters are built, they should include their session IDs in the POST body
// as `session_id` (e.g., Pi's session hash, OpenCode's session identifier).
// The log format below is ready to accept them — just needs the caller to send it.

let requestCounter = 0;

function logTimestamp(): string {
  return new Date().toISOString();
}

function generateRequestId(): string {
  return `req-${++requestCounter}-${Date.now().toString(36)}`;
}

interface LogContext {
  requestId?: string;
  sessionId?: string;
  source?: string;  // 'claude-code' | 'pi' | 'opencode' | unknown
}

function log(level: 'info' | 'warn' | 'error', message: string, ctx?: LogContext): void {
  const ts = logTimestamp();
  const prefix = ctx?.requestId ? `[${ctx.requestId}]` : '';
  const session = ctx?.sessionId ? ` session=${ctx.sessionId}` : '';
  const source = ctx?.source ? ` source=${ctx.source}` : '';
  const meta = `${prefix}${session}${source}`;
  const line = `${ts} ${level.toUpperCase()} ${meta ? meta + ' ' : ''}${message}`;

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// =============================================================================
// Configuration Loading
// =============================================================================

// Load .env from multiple locations (first found wins for each key)
const envPaths = [
  join(homedir(), '.config', 'PAI', '.env'),  // patched 2026-05-15: PAI v5+ location
  join(homedir(), '.claude', '.env'),
  join(homedir(), '.env'),
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    const envContent = await Bun.file(envPath).text();
    envContent.split('\n').forEach(line => {
      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) return;
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && value && !key.startsWith('#') && !process.env[key]) {
        process.env[key] = value;
      }
    });
  }
}

const PORT = parseInt(process.env.PORT || "8888");
const VOICES_PATH = join(import.meta.dir, 'voices.json');
const DEFAULT_MACOS_VOICE = 'Daniel (Enhanced)';
const ELEVENLABS_TIMEOUT_MS = 10_000;
const KOKORO_TIMEOUT_MS = 10_000;

// Resolve environment variables in config values
function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return value;
  const match = value.match(/^\$\{([^}]+)\}$/);
  if (match) {
    return process.env[match[1]];
  }
  return value;
}

// Load voices.json (single source of truth for all voice config)
function loadVoicesConfig(): VoicesConfig {
  const defaultConfig: VoicesConfig = {
    providers: {
      edgetts: {
        enabled: true,
        defaultVoice: 'en-US-AvaNeural',
        description: 'Microsoft Edge TTS - free, high-quality neural voices'
      },
      kokoro: {
        enabled: true,
        endpoint: 'http://127.0.0.1:8880/v1',
        defaultVoice: 'af_sky',
        description: 'Local TTS - free, offline, no API key needed'
      },
      elevenlabs: {
        enabled: false,
        apiKey: '${ELEVENLABS_API_KEY}',
        defaultVoiceId: 's3TPKV1kjDlVtZbl4Ksh',
        description: 'Premium cloud TTS - requires API key from elevenlabs.io'
      },
      say: {
        enabled: true,
        voice: DEFAULT_MACOS_VOICE,
        description: 'macOS built-in - always available fallback'
      }
    },
    defaultProvider: 'edgetts',
    fallbackOrder: ['edgetts', 'elevenlabs', 'kokoro', 'say'],
    default_volume: 0.8,
    identity: {
      description: 'Main AI assistant voice',
      kokoro: { voice: 'am_adam', speed: 1.1 }
    },
    agents: {}
  };

  try {
    if (existsSync(VOICES_PATH)) {
      const content = readFileSync(VOICES_PATH, 'utf-8');
      const config = JSON.parse(content);
      console.log('✅ Loaded voice config from voices.json');
      return {
        ...defaultConfig,
        ...config,
        providers: {
          ...defaultConfig.providers,
          ...config.providers
        }
      };
    }
  } catch (error) {
    console.warn('⚠️  Failed to load voices.json, using defaults');
  }

  return defaultConfig;
}

// Global config (loaded once at startup)
const voicesConfig = loadVoicesConfig();

function getMacOSFallbackVoice(): string {
  return voicesConfig.providers.say.voice || DEFAULT_MACOS_VOICE;
}

// =============================================================================
// Pronunciation System (from v3.0)
// =============================================================================

interface PronunciationEntry {
  term: string;
  phonetic: string;
  note?: string;
}

interface PronunciationConfig {
  replacements: PronunciationEntry[];
}

interface CompiledRule {
  regex: RegExp;
  phonetic: string;
}

let pronunciationRules: CompiledRule[] = [];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadPronunciations(): void {
  const pronPath = join(import.meta.dir, 'pronunciations.json');
  try {
    if (!existsSync(pronPath)) {
      console.warn('⚠️  No pronunciations.json found — TTS will use default pronunciations');
      return;
    }
    const content = readFileSync(pronPath, 'utf-8');
    const config: PronunciationConfig = JSON.parse(content);

    pronunciationRules = config.replacements.map(entry => ({
      regex: new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'g'),
      phonetic: entry.phonetic,
    }));

    console.log(`📖 Loaded ${pronunciationRules.length} pronunciation rules`);
    for (const entry of config.replacements) {
      console.log(`   ${entry.term} → ${entry.phonetic}${entry.note ? ` (${entry.note})` : ''}`);
    }
  } catch (error) {
    console.error('⚠️  Failed to load pronunciations.json:', error);
  }
}

function applyPronunciations(text: string): string {
  let result = text;
  for (const rule of pronunciationRules) {
    result = result.replace(rule.regex, rule.phonetic);
  }
  return result;
}

// Load pronunciations at startup
loadPronunciations();

// =============================================================================
// Emotional Presets (from v3.0) — overlays stability + similarity_boost
// =============================================================================

interface EmotionalOverlay {
  stability: number;
  similarity_boost: number;
}

const EMOTIONAL_PRESETS: Record<string, EmotionalOverlay> = {
  // High Energy / Positive
  'excited':      { stability: 0.70, similarity_boost: 0.90 },
  'celebration':  { stability: 0.65, similarity_boost: 0.85 },
  'insight':      { stability: 0.55, similarity_boost: 0.80 },
  'creative':     { stability: 0.50, similarity_boost: 0.75 },

  // Success / Achievement
  'success':      { stability: 0.60, similarity_boost: 0.80 },
  'progress':     { stability: 0.55, similarity_boost: 0.75 },

  // Analysis / Investigation
  'investigating':{ stability: 0.60, similarity_boost: 0.85 },
  'debugging':    { stability: 0.55, similarity_boost: 0.80 },
  'learning':     { stability: 0.50, similarity_boost: 0.75 },

  // Thoughtful / Careful
  'pondering':    { stability: 0.65, similarity_boost: 0.80 },
  'focused':      { stability: 0.70, similarity_boost: 0.85 },
  'caution':      { stability: 0.40, similarity_boost: 0.60 },

  // Urgent / Critical
  'urgent':       { stability: 0.30, similarity_boost: 0.90 },
};

const EMOJI_TO_EMOTION: Record<string, string> = {
  '\u{1F4A5}': 'excited',
  '\u{1F389}': 'celebration',
  '\u{1F4A1}': 'insight',
  '\u{1F3A8}': 'creative',
  '\u{2728}':  'success',
  '\u{1F4C8}': 'progress',
  '\u{1F50D}': 'investigating',
  '\u{1F41B}': 'debugging',
  '\u{1F4DA}': 'learning',
  '\u{1F914}': 'pondering',
  '\u{1F3AF}': 'focused',
  '\u{26A0}\u{FE0F}': 'caution',
  '\u{1F6A8}': 'urgent',
};

function extractEmotionalMarker(message: string): { cleaned: string; emotion?: string } {
  const emotionMatch = message.match(/\[(\u{1F4A5}|\u{1F389}|\u{1F4A1}|\u{1F3A8}|\u{2728}|\u{1F4C8}|\u{1F50D}|\u{1F41B}|\u{1F4DA}|\u{1F914}|\u{1F3AF}|\u{26A0}\u{FE0F}|\u{1F6A8})\s+(\w+)\]/u);
  if (emotionMatch) {
    const emoji = emotionMatch[1];
    const emotionName = emotionMatch[2].toLowerCase();
    if (EMOJI_TO_EMOTION[emoji] === emotionName) {
      return {
        cleaned: message.replace(emotionMatch[0], '').trim(),
        emotion: emotionName,
      };
    }
  }
  return { cleaned: message };
}

// =============================================================================
// Circuit Breakers - Per-Provider Fast Fallback
// =============================================================================

const circuitBreakers: Record<string, CircuitBreakerState> = {
  edgetts: { failures: 0, lastFailure: 0, isOpen: false },
  elevenlabs: { failures: 0, lastFailure: 0, isOpen: false },
  kokoro: { failures: 0, lastFailure: 0, isOpen: false },
};

const CIRCUIT_BREAKER_THRESHOLD = 1;
const CIRCUIT_BREAKER_RESET_MS = 60_000;

function recordProviderSuccess(provider: string): void {
  const breaker = circuitBreakers[provider];
  if (!breaker) return;

  breaker.failures = 0;
  if (breaker.isOpen) {
    log('info', `🟢 Circuit CLOSED - ${provider} recovered`);
    breaker.isOpen = false;
  }
}

function recordProviderFailure(provider: string): void {
  const breaker = circuitBreakers[provider];
  if (!breaker) return;

  breaker.failures++;
  breaker.lastFailure = Date.now();

  if (breaker.failures >= CIRCUIT_BREAKER_THRESHOLD && !breaker.isOpen) {
    breaker.isOpen = true;
    log('warn', `🔴 Circuit OPEN - ${provider} disabled, using fallback`);
  }
}

function shouldSkipProvider(provider: string): boolean {
  const breaker = circuitBreakers[provider];
  if (!breaker || !breaker.isOpen) return false;

  if (Date.now() - breaker.lastFailure > CIRCUIT_BREAKER_RESET_MS) {
    log('info', `🟡 Circuit HALF-OPEN - testing ${provider}`);
    return false;
  }

  return true;
}

// =============================================================================
// Voice Configuration Lookup
// =============================================================================

function getVoiceMapping(identifier: string | null): VoiceMapping | null {
  if (!identifier) {
    return voicesConfig.identity;
  }

  // Check agents by name
  if (voicesConfig.agents[identifier]) {
    return voicesConfig.agents[identifier];
  }

  // Check by ElevenLabs voice ID
  for (const [, mapping] of Object.entries(voicesConfig.agents)) {
    if (mapping.elevenlabs?.voice_id === identifier) {
      return mapping;
    }
  }

  // Check identity
  if (voicesConfig.identity.elevenlabs?.voice_id === identifier) {
    return voicesConfig.identity;
  }

  return null;
}

// =============================================================================
// Utility Functions
// =============================================================================

function escapeForAppleScript(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\n\r\t]/g, ' ');  // patched 2026-05-15 (RedTeam PT-1): collapse line breaks/tabs so they can't break out of the AppleScript string literal
}

function stripMarkers(message: string): string {
  return message.replace(/\[[^\]]*\]/g, '').trim();
}

function sanitizeForSpeech(input: string): string {
  const cleaned = input
    .replace(/<script/gi, '')
    .replace(/\.\.\//g, '')
    .replace(/[;&|><`$\\]/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .trim()
    .substring(0, 500);

  return cleaned;
}

function validateInput(input: any): { valid: boolean; error?: string; sanitized?: string } {
  if (!input || typeof input !== 'string') {
    return { valid: false, error: 'Invalid input type' };
  }

  if (input.length > 500) {
    return { valid: false, error: 'Message too long (max 500 characters)' };
  }

  const sanitized = sanitizeForSpeech(input);

  if (!sanitized || sanitized.length === 0) {
    return { valid: false, error: 'Message contains no valid content after sanitization' };
  }

  return { valid: true, sanitized };
}

function getVolumeSetting(): number {
  const vol = voicesConfig.default_volume;
  if (typeof vol === 'number' && vol >= 0 && vol <= 1) {
    return vol;
  }
  return 1.0;
}

async function playAudio(audioBuffer: ArrayBuffer, format: 'mp3' | 'wav' | 'aiff' = 'mp3'): Promise<void> {
  const tempFile = `/tmp/voice-${Date.now()}.${format}`;
  await Bun.write(tempFile, audioBuffer);

  const volume = getVolumeSetting();

  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/afplay', ['-v', volume.toString(), tempFile]);

    proc.on('error', (error) => {
      console.error('Error playing audio:', error);
      spawn('/bin/rm', ['-f', tempFile]);
      reject(error);
    });

    proc.on('exit', (code) => {
      spawn('/bin/rm', ['-f', tempFile]);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`afplay exited with code ${code}`));
      }
    });
  });
}

function spawnSafe(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);

    proc.on('error', (error) => {
      console.error(`Error spawning ${command}:`, error);
      reject(error);
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

// =============================================================================
// TTS Provider Implementations
// =============================================================================

// --- Edge TTS Provider ---
const EDGETTS_TIMEOUT_MS = 15_000;
const PYTHON3_PATH = '/opt/homebrew/bin/python3';

class EdgeTTSProvider implements TTSProvider {
  name = 'edgetts';

  isEnabled(): boolean {
    return voicesConfig.providers.edgetts?.enabled !== false;
  }

  async isHealthy(): Promise<boolean> {
    if (shouldSkipProvider('edgetts')) return false;
    // Check module importability only — no network call. Actual synthesis
    // failures are handled by the circuit breaker in speak().
    try {
      const check = spawn(PYTHON3_PATH, ['-c', 'import edge_tts']);
      const exitCode = await new Promise<number>((resolve) => {
        check.on('exit', resolve);
        check.on('error', () => resolve(1));
        setTimeout(() => { check.kill(); resolve(1); }, 3000);
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  async speak(text: string, voice?: string): Promise<boolean> {
    const edgettsVoice = voice || voicesConfig.providers.edgetts?.defaultVoice || 'en-US-AvaNeural';
    const rate = voicesConfig.providers.edgetts?.rate || '+0%';
    const tmpFile = `/tmp/voiceserver-edgetts-${Date.now()}.mp3`;

    // Apply pronunciations
    const processedText = applyPronunciations(text);

    try {
      console.log(`🌐 Edge TTS speaking (voice: ${edgettsVoice})...`);

      // Synthesize via edge-tts CLI
      const synth = spawn(PYTHON3_PATH, [
        '-m', 'edge_tts',
        '--text', processedText,
        '--voice', edgettsVoice,
        '--rate', rate,
        '--write-media', tmpFile,
      ]);

      const synthExit = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => { synth.kill(); reject(new Error('Edge TTS synthesis timeout')); }, EDGETTS_TIMEOUT_MS);
        synth.on('exit', (code) => { clearTimeout(timeout); resolve(code ?? 1); });
        synth.on('error', (err) => { clearTimeout(timeout); reject(err); });
      });

      if (synthExit !== 0) {
        throw new Error(`edge-tts exited with code ${synthExit}`);
      }

      // Play via afplay (macOS) or mpv/ffplay (Linux)
      const player = process.platform === 'darwin' ? '/usr/bin/afplay' : 'mpv';
      const play = spawn(player, [tmpFile]);

      await new Promise<void>((resolve, reject) => {
        play.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Player exited with code ${code}`));
        });
        play.on('error', reject);
      });

      recordProviderSuccess('edgetts');
      console.log('✅ Edge TTS completed');
      return true;
    } catch (error: any) {
      recordProviderFailure('edgetts');
      if (error.message?.includes('timeout')) {
        console.warn(`⏱️  Edge TTS timeout after ${EDGETTS_TIMEOUT_MS}ms`);
      } else {
        console.error('❌ Edge TTS error:', error.message || error);
      }
      return false;
    } finally {
      // Clean up temp file
      try { unlinkSync(tmpFile); } catch {}
    }
  }
}

// --- macOS Say Provider ---
class MacOSSayProvider implements TTSProvider {
  name = 'say';

  isEnabled(): boolean {
    return voicesConfig.providers.say.enabled !== false;
  }

  async isHealthy(): Promise<boolean> {
    return true; // Always available on macOS
  }

  async speak(text: string): Promise<boolean> {
    try {
      const fallbackVoice = getMacOSFallbackVoice();
      console.log(`🍎 Using macOS say (voice: ${fallbackVoice})...`);

      const proc = spawn('/usr/bin/say', [
        '-v', fallbackVoice,
        '-r', String(voicesConfig.default_rate || 175),
        text
      ]);

      await new Promise<void>((resolve, reject) => {
        proc.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`say exited with code ${code}`));
        });
        proc.on('error', reject);
      });

      console.log('🍎 macOS say completed');
      return true;
    } catch (error) {
      console.error('🍎 macOS say failed:', error);
      return false;
    }
  }
}

// --- ElevenLabs Provider ---
class ElevenLabsProvider implements TTSProvider {
  name = 'elevenlabs';
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = resolveEnvVar(voicesConfig.providers.elevenlabs.apiKey) || process.env.ELEVENLABS_API_KEY;
  }

  isEnabled(): boolean {
    return voicesConfig.providers.elevenlabs.enabled === true && !!this.apiKey;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.apiKey) return false;
    if (shouldSkipProvider('elevenlabs')) return false;
    return true;
  }

  async speak(text: string, voiceId?: string, voiceSettings?: VoiceSettings): Promise<boolean> {
    if (!this.apiKey) return false;

    // Apply pronunciations before sending to ElevenLabs
    const pronouncedText = applyPronunciations(text);
    if (pronouncedText !== text) {
      console.log(`📖 Pronunciation applied: "${text}" → "${pronouncedText}"`);
    }

    const voice = voiceId || voicesConfig.providers.elevenlabs.defaultVoiceId || 's3TPKV1kjDlVtZbl4Ksh';

    const settings = {
      stability: voiceSettings?.stability ?? 0.5,
      similarity_boost: voiceSettings?.similarity_boost ?? 0.75,
      style: voiceSettings?.style ?? 0.0,
      use_speaker_boost: voiceSettings?.use_speaker_boost ?? true,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);

    try {
      console.log(`🎙️  ElevenLabs speaking (voice: ${voice})...`);

      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify({
          text: pronouncedText,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: settings,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
      }

      const audioBuffer = await response.arrayBuffer();
      await playAudio(audioBuffer, 'mp3');
      recordProviderSuccess('elevenlabs');
      console.log('✅ ElevenLabs speech completed');
      return true;
    } catch (error: any) {
      clearTimeout(timeoutId);
      recordProviderFailure('elevenlabs');

      const isTimeout = error.name === 'AbortError' ||
                        error.message?.includes('timeout') ||
                        error.message?.includes('Timeout');

      if (isTimeout) {
        console.warn(`⏱️  ElevenLabs timeout after ${ELEVENLABS_TIMEOUT_MS}ms`);
      } else {
        console.error('❌ ElevenLabs error:', error.message || error);
      }
      return false;
    }
  }
}

// --- Kokoro Provider ---
class KokoroProvider implements TTSProvider {
  name = 'kokoro';

  isEnabled(): boolean {
    return voicesConfig.providers.kokoro.enabled === true;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.isEnabled()) return false;
    if (shouldSkipProvider('kokoro')) return false;

    const endpoint = voicesConfig.providers.kokoro.endpoint || 'http://127.0.0.1:8880/v1';

    try {
      const response = await fetch(`${endpoint}/models`, {
        signal: AbortSignal.timeout(2000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async speak(text: string, voice?: string, voiceSettings?: VoiceSettings): Promise<boolean> {
    const endpoint = voicesConfig.providers.kokoro.endpoint || 'http://127.0.0.1:8880/v1';
    const kokoroVoice = voice || voicesConfig.providers.kokoro.defaultVoice || 'af_sky';
    const speed = voiceSettings?.speed ?? 1.0;

    // Apply pronunciations before sending to Kokoro
    const pronouncedText = applyPronunciations(text);
    if (pronouncedText !== text) {
      console.log(`📖 Pronunciation applied: "${text}" → "${pronouncedText}"`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), KOKORO_TIMEOUT_MS);

    try {
      console.log(`🎵 Kokoro speaking (voice: ${kokoroVoice}, speed: ${speed})...`);

      const response = await fetch(`${endpoint}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'kokoro',
          input: pronouncedText,
          voice: kokoroVoice,
          speed: speed,
          response_format: 'mp3'
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Kokoro API returned ${response.status}: ${response.statusText}`);
      }

      const audioBuffer = await response.arrayBuffer();
      await playAudio(audioBuffer, 'mp3');
      recordProviderSuccess('kokoro');
      console.log('✅ Kokoro speech completed');
      return true;
    } catch (error: any) {
      clearTimeout(timeoutId);
      recordProviderFailure('kokoro');

      const isTimeout = error.name === 'AbortError' ||
                        error.message?.includes('timeout') ||
                        error.message?.includes('Timeout');

      if (isTimeout) {
        console.warn(`⏱️  Kokoro timeout after ${KOKORO_TIMEOUT_MS}ms`);
      } else {
        console.error('❌ Kokoro error:', error.message || error);
      }
      return false;
    }
  }
}

// =============================================================================
// Provider Management
// =============================================================================

const providers: Record<string, TTSProvider> = {
  edgetts: new EdgeTTSProvider(),
  elevenlabs: new ElevenLabsProvider(),
  kokoro: new KokoroProvider(),
  say: new MacOSSayProvider(),
};

async function getProviderStatus(): Promise<Record<string, { enabled: boolean; healthy: boolean; endpoint?: string }>> {
  const status: Record<string, { enabled: boolean; healthy: boolean; endpoint?: string }> = {};

  for (const [name, provider] of Object.entries(providers)) {
    const enabled = provider.isEnabled();
    const healthy = enabled ? await provider.isHealthy() : false;

    status[name] = {
      enabled,
      healthy,
      ...(name === 'kokoro' && { endpoint: voicesConfig.providers.kokoro.endpoint }),
      ...(name === 'elevenlabs' && { apiKeyConfigured: !!resolveEnvVar(voicesConfig.providers.elevenlabs.apiKey) })
    };
  }

  return status;
}

// =============================================================================
// Core: speakWithFallback — provider chain with pronunciation + emotion support
//
// Voice settings resolution (3-tier):
//   1. callerVoiceSettings provided → use directly (pass-through)
//   2. voiceId provided → look up voice mapping in voices.json
//   3. Neither → use voices.json identity defaults
//
// Emotional overlay applies AFTER settings resolution, modifying
// stability + similarity_boost for the matched emotion.
// =============================================================================

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  speed: 1.0,
  use_speaker_boost: true,
};

async function speakWithFallback(
  text: string,
  voiceId?: string,
  callerVoiceSettings?: Partial<VoiceSettings> | null,
  emotion?: string,
): Promise<{ success: boolean; provider: string }> {
  // Build provider order: primary first, then fallback order
  const providerOrder = [
    voicesConfig.defaultProvider,
    ...voicesConfig.fallbackOrder.filter(p => p !== voicesConfig.defaultProvider)
  ];

  // Get voice mapping for this voice identifier
  const voiceMapping = getVoiceMapping(voiceId || null);

  for (const providerName of providerOrder) {
    const provider = providers[providerName];
    if (!provider) continue;

    if (!provider.isEnabled()) {
      console.log(`⏭️  Skipping ${providerName} (disabled)`);
      continue;
    }

    const healthy = await provider.isHealthy();
    if (!healthy) {
      console.log(`⏭️  Skipping ${providerName} (unhealthy)`);
      continue;
    }

    // --- 3-tier voice settings resolution ---
    let providerVoice: string | undefined;
    let providerSettings: VoiceSettings;

    if (callerVoiceSettings && Object.keys(callerVoiceSettings).length > 0) {
      // Tier 1: caller passed explicit voice_settings → pass through
      providerSettings = {
        stability: callerVoiceSettings.stability ?? DEFAULT_VOICE_SETTINGS.stability,
        similarity_boost: callerVoiceSettings.similarity_boost ?? DEFAULT_VOICE_SETTINGS.similarity_boost,
        style: callerVoiceSettings.style ?? DEFAULT_VOICE_SETTINGS.style,
        speed: callerVoiceSettings.speed ?? DEFAULT_VOICE_SETTINGS.speed,
        use_speaker_boost: callerVoiceSettings.use_speaker_boost ?? DEFAULT_VOICE_SETTINGS.use_speaker_boost,
      };
      console.log(`🔗 Voice settings: pass-through from caller`);
    } else if (voiceMapping) {
      // Tier 2: resolve from voices.json mapping for this provider
      if (providerName === 'kokoro' && voiceMapping.kokoro) {
        providerVoice = voiceMapping.kokoro.voice;
        providerSettings = { ...DEFAULT_VOICE_SETTINGS, speed: voiceMapping.kokoro.speed ?? 1.0 };
      } else if (providerName === 'elevenlabs' && voiceMapping.elevenlabs) {
        providerVoice = voiceMapping.elevenlabs.voice_id;
        providerSettings = {
          stability: voiceMapping.elevenlabs.stability ?? DEFAULT_VOICE_SETTINGS.stability,
          similarity_boost: voiceMapping.elevenlabs.similarity_boost ?? DEFAULT_VOICE_SETTINGS.similarity_boost,
          style: voiceMapping.elevenlabs.style ?? DEFAULT_VOICE_SETTINGS.style,
          speed: DEFAULT_VOICE_SETTINGS.speed,
          use_speaker_boost: voiceMapping.elevenlabs.use_speaker_boost ?? DEFAULT_VOICE_SETTINGS.use_speaker_boost,
        };
      } else {
        providerSettings = { ...DEFAULT_VOICE_SETTINGS };
      }
    } else {
      // Tier 3: defaults
      providerSettings = { ...DEFAULT_VOICE_SETTINGS };
    }

    // Emotional overlay — modifies stability + similarity_boost on top of resolved settings
    if (emotion && EMOTIONAL_PRESETS[emotion]) {
      providerSettings = {
        ...providerSettings,
        stability: EMOTIONAL_PRESETS[emotion].stability,
        similarity_boost: EMOTIONAL_PRESETS[emotion].similarity_boost,
      };
      console.log(`🎭 Emotion overlay: ${emotion} (stability: ${providerSettings.stability}, boost: ${providerSettings.similarity_boost})`);
    }

    const success = await provider.speak(text, providerVoice, providerSettings);
    if (success) {
      return { success: true, provider: providerName };
    }
  }

  return { success: false, provider: 'none' };
}

// =============================================================================
// Notification Handler
// =============================================================================

async function sendNotification(
  title: string,
  message: string,
  voiceEnabled = true,
  voiceId: string | null = null,
  callerVoiceSettings?: Partial<VoiceSettings> | null,
) {
  const titleValidation = validateInput(title);
  const messageValidation = validateInput(message);

  if (!titleValidation.valid) {
    throw new Error(`Invalid title: ${titleValidation.error}`);
  }

  if (!messageValidation.valid) {
    throw new Error(`Invalid message: ${messageValidation.error}`);
  }

  const safeTitle = titleValidation.sanitized!;
  let safeMessage = stripMarkers(messageValidation.sanitized!);

  // Extract emotional marker before speaking
  const { cleaned, emotion } = extractEmotionalMarker(safeMessage);
  safeMessage = cleaned;

  if (emotion) {
    console.log(`🎭 Detected emotion: ${emotion}`);
  }

  if (voiceEnabled) {
    try {
      const voiceMapping = getVoiceMapping(voiceId);
      if (voiceMapping?.description) {
        console.log(`👤 Voice: ${voiceMapping.description}`);
      }

      console.log(`🎙️  Speaking...`);

      const result = await speakWithFallback(safeMessage, voiceId || undefined, callerVoiceSettings, emotion);

      if (result.success) {
        console.log(`✅ Speech via ${result.provider}`);
      } else {
        console.warn('⚠️  All speech providers failed');
      }
    } catch (error) {
      console.error("Failed to speak:", error);
    }
  }

  // Display macOS notification
  try {
    const escapedTitle = escapeForAppleScript(safeTitle);
    const escapedMessage = escapeForAppleScript(safeMessage);
    const script = `display notification "${escapedMessage}" with title "${escapedTitle}" sound name ""`;
    await spawnSafe('/usr/bin/osascript', ['-e', script]);
  } catch (error) {
    console.error("Notification display error:", error);
  }
}

// =============================================================================
// Rate Limiting
// =============================================================================

const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(ip);

  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return true;
  }

  if (record.count >= RATE_LIMIT) {
    return false;
  }

  record.count++;
  return true;
}

// =============================================================================
// HTTP Server
// =============================================================================

const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const clientIp = req.headers.get('x-forwarded-for') || 'localhost';

    const corsHeaders = {
      "Access-Control-Allow-Origin": "http://localhost",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    if (!checkRateLimit(clientIp)) {
      return new Response(
        JSON.stringify({ status: "error", message: "Rate limit exceeded" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 429
        }
      );
    }

    if (url.pathname === "/notify" && req.method === "POST") {
      const reqId = generateRequestId();
      try {
        const data = await req.json();
        const title = data.title || "PAI Notification";
        const message = data.message || "Task completed";
        const voiceEnabled = data.voice_enabled !== false;
        const voiceId = data.voice_id || data.voice_name || null;
        const voiceSettings = data.voice_settings || null;
        // TODO: Pi and OpenCode agents should send session_id and source
        // in the POST body once their adapters are built.
        const sessionId = data.session_id || null;
        const source = data.source || null;  // 'claude-code' | 'pi' | 'opencode'
        const ctx: LogContext = { requestId: reqId, sessionId, source };

        if (voiceId && typeof voiceId !== 'string') {
          throw new Error('Invalid voice_id');
        }

        log('info', `📨 Notification: "${title}" - "${message}" (voice: ${voiceEnabled}, provider: ${voicesConfig.defaultProvider})`, ctx);

        await sendNotification(title, message, voiceEnabled, voiceId, voiceSettings);

        log('info', `✅ Notification delivered`, ctx);
        return new Response(
          JSON.stringify({ status: "success", message: "Notification sent", request_id: reqId }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200
          }
        );
      } catch (error: any) {
        log('error', `Notification error: ${error.message || error}`, { requestId: reqId });
        return new Response(
          JSON.stringify({ status: "error", message: error.message || "Internal server error", request_id: reqId }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: error.message?.includes('Invalid') ? 400 : 500
          }
        );
      }
    }

    // /notify/personality — compatibility shim
    if (url.pathname === "/notify/personality" && req.method === "POST") {
      const reqId = generateRequestId();
      try {
        const data = await req.json();
        const message = data.message || "Notification";
        const ctx: LogContext = { requestId: reqId, sessionId: data.session_id, source: data.source };

        log('info', `🎭 Personality notification: "${message}"`, ctx);

        await sendNotification("PAI Notification", message, true, null);

        log('info', `✅ Personality notification delivered`, ctx);
        return new Response(
          JSON.stringify({ status: "success", message: "Personality notification sent", request_id: reqId }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200
          }
        );
      } catch (error: any) {
        log('error', `Personality notification error: ${error.message || error}`, { requestId: reqId });
        return new Response(
          JSON.stringify({ status: "error", message: error.message || "Internal server error", request_id: reqId }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: error.message?.includes('Invalid') ? 400 : 500
          }
        );
      }
    }

    if (url.pathname === "/pai" && req.method === "POST") {
      const reqId = generateRequestId();
      try {
        const data = await req.json();
        const title = data.title || "PAI Assistant";
        const message = data.message || "Task completed";
        const ctx: LogContext = { requestId: reqId, sessionId: data.session_id, source: data.source };

        log('info', `🤖 PAI notification: "${title}" - "${message}"`, ctx);

        await sendNotification(title, message, true, null);

        log('info', `✅ PAI notification delivered`, ctx);
        return new Response(
          JSON.stringify({ status: "success", message: "PAI notification sent", request_id: reqId }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200
          }
        );
      } catch (error: any) {
        log('error', `PAI notification error: ${error.message || error}`, { requestId: reqId });
        return new Response(
          JSON.stringify({ status: "error", message: error.message || "Internal server error", request_id: reqId }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: error.message?.includes('Invalid') ? 400 : 500
          }
        );
      }
    }

    if (url.pathname === "/health") {
      const providerStatus = await getProviderStatus();

      return new Response(
        JSON.stringify({
          status: "healthy",
          port: PORT,
          voice_system: "Multi-provider TTS (Kokoro, ElevenLabs, macOS say)",
          config_source: "voices.json",
          activeProvider: voicesConfig.defaultProvider,
          providers: providerStatus,
          fallbackOrder: voicesConfig.fallbackOrder,
          macos_fallback_voice: getMacOSFallbackVoice(),
          pronunciation_rules: pronunciationRules.length,
          emotional_presets: Object.keys(EMOTIONAL_PRESETS).length,
          circuit_breakers: {
            elevenlabs: {
              open: circuitBreakers.elevenlabs.isOpen,
              failures: circuitBreakers.elevenlabs.failures,
            },
            kokoro: {
              open: circuitBreakers.kokoro.isOpen,
              failures: circuitBreakers.kokoro.failures,
            },
            threshold: CIRCUIT_BREAKER_THRESHOLD,
            reset_after_ms: CIRCUIT_BREAKER_RESET_MS,
          },
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200
        }
      );
    }

    return new Response("Voice Server - POST to /notify, /notify/personality, or /pai, GET /health for status", {
      headers: corsHeaders,
      status: 200
    });
  },
});

// =============================================================================
// Startup Banner
// =============================================================================

const providerStatus = await getProviderStatus();

log('info', `🚀 Voice Server running on port ${PORT}`);
log('info', `📄 Config source: voices.json`);
log('info', `🎙️  Primary provider: ${voicesConfig.defaultProvider}`);
log('info', `📋 Fallback order: ${voicesConfig.fallbackOrder.join(' → ')}`);
log('info', `🔧 Provider status:`);
for (const [name, status] of Object.entries(providerStatus)) {
  const icon = status.healthy ? '✅' : (status.enabled ? '⚠️' : '⬚');
  log('info', `   ${icon} ${name}: ${status.enabled ? 'enabled' : 'disabled'}${status.healthy ? ', healthy' : ''}`);
}
log('info', `🍎 macOS fallback voice: ${getMacOSFallbackVoice()}`);
log('info', `📖 Pronunciation rules: ${pronunciationRules.length}`);
log('info', `🎭 Emotional presets: ${Object.keys(EMOTIONAL_PRESETS).length}`);
log('info', `⚡ Circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} failures → ${CIRCUIT_BREAKER_RESET_MS / 1000}s cooldown`);
log('info', `📡 Endpoints: POST /notify, POST /notify/personality, POST /pai, GET /health`);
log('info', `🔒 Security: CORS restricted to localhost, rate limiting enabled`);
