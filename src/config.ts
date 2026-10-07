import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65535);
const optionalString = z.string().optional().default('');

const configSchema = z.object({
  // Core
  apiPort: portSchema.default(3334),
  phonePort: portSchema.default(3333),
  workspace: z.string().default(() => process.env.LAIN_WORKSPACE_DIR ?? `${process.env.HOME}/lain-workspace`),
  onlyTelegram: z.preprocess((v) => v === 'true' || v === '1' || v === 'on', z.boolean()).default(false),

  // Security
  apiKey: optionalString,
  telegramWebhookSecret: optionalString,

  // Telegram
  telegram: z.object({
    botToken: optionalString,
    defaultChatId: optionalString,
    allowlist: z.string().optional().default(''),
    forumChatId: optionalString,
  }).prefault({}),

  // WhatsApp (Kapso)
  whatsapp: z.object({
    apiKey: optionalString,
    phoneNumberId: optionalString,
    userNumber: optionalString,
    allowlist: z.string().optional().default(''),
  }).prefault({}),

  // Phone/Twilio
  phone: z.object({
    publicUrl: optionalString,
    phoneNumber: optionalString,
    userPhoneNumber: optionalString,
    accountSid: optionalString,
    authToken: optionalString,
    callMode: z.enum(['claude', 'fast']).optional().default('claude'),
    usePipeline: z.preprocess((v) => v === 'true' || v === '1', z.boolean()).default(false),
    transcriptTimeoutMs: z.coerce.number().default(180_000),
    inboundGreeting: z.string().optional().default(''),
    holdIntervalMs: z.coerce.number().default(60_000),
    noiseSuppressionMode: z.string().optional().default(''),
    noiseGateThreshold: z.coerce.number().optional().default(0),
    s2sModel: z.string().optional().default(''),
    s2sVoice: z.string().optional().default('shimmer'),
    s2sSystemPrompt: z.string().optional().default(''),
  }).prefault({}),

  // OpenAI
  openaiApiKey: optionalString,

  // ngrok
  ngrok: z.object({
    authtoken: optionalString,
    domain: optionalString,
  }).prefault({}),

  // Communication flags
  communication: z.object({
    alwaysWhatsapp: z.preprocess((v) => v == null || (typeof v === 'string' && v.toLowerCase() !== 'off'), z.boolean()).default(true),
    alwaysCall: z.preprocess((v) => v == null || (typeof v === 'string' && v.toLowerCase() !== 'off'), z.boolean()).default(true),
  }).prefault({}),

  // Notification flags
  notifications: z.object({
    taskWhatsapp: z.preprocess((v) => v == null || (typeof v === 'string' && v.toLowerCase() !== 'off'), z.boolean()).default(true),
    poolWhatsapp: z.preprocess((v) => v == null || (typeof v === 'string' && v.toLowerCase() !== 'off'), z.boolean()).default(true),
    autoStatus: z.preprocess((v) => v === 'true' || v === '1' || v === 'on', z.boolean()).default(false),
  }).prefault({}),

  // Callback retries
  callbackMaxRetries: z.coerce.number().int().min(0).default(1),

  // GraphRAG
  graphrag: z.object({
    enabled: z.preprocess((v) => v === 'true' || v === '1', z.boolean()).default(false),
    maxContextNodes: z.coerce.number().default(10),
    maxDepth: z.coerce.number().default(3),
    saveDebounceMs: z.coerce.number().int().min(100).default(1000),
  }).prefault({}),

  // Agents
  agents: z.object({
    maxMemoryMb: z.coerce.number().optional().default(0),
    timeoutMinutes: z.coerce.number().optional().default(0),
    globalMax: z.coerce.number().optional().default(0),
    killAndRespawn: z.preprocess((v) => v === 'true' || v === '1', z.boolean()).default(false),
  }).prefault({}),

  // Seeds
  seeds: z.object({
    enabled: z.preprocess((v) => v === 'true' || v === '1', z.boolean()).default(false),
    maxChunks: z.coerce.number().optional().default(0),
  }).prefault({}),

  // Security
  security: z.object({
    hardwareLock: z.object({
      enabled: z.preprocess((v) => v === undefined || v === null ? true : v === 'true' || v === '1' || v === true, z.boolean()).default(true),
      uuid: optionalString, // LAIN_HARDWARE_UUID
    }).prefault({}),
  }).prefault({}),
});

export type LainConfig = z.infer<typeof configSchema>;

let _config: LainConfig | null = null;

export function loadConfig(): LainConfig {
  const raw = {
    apiPort: process.env.LAIN_API_PORT,
    phonePort: process.env.LAIN_PORT,
    workspace: process.env.LAIN_WORKSPACE_DIR || process.env.LAIN_WORKSPACE,
    onlyTelegram: process.env.LAIN_ONLY_TELEGRAM,
    apiKey: process.env.LAIN_API_KEY,
    telegramWebhookSecret: process.env.LAIN_TELEGRAM_WEBHOOK_SECRET,
    telegram: {
      botToken: process.env.LAIN_TELEGRAM_BOT_TOKEN,
      defaultChatId: process.env.LAIN_TELEGRAM_DEFAULT_CHAT_ID,
      allowlist: process.env.LAIN_TELEGRAM_ALLOWLIST,
      forumChatId: process.env.LAIN_TELEGRAM_FORUM_CHAT_ID,
    },
    whatsapp: {
      apiKey: process.env.LAIN_KAPSO_API_KEY,
      phoneNumberId: process.env.LAIN_KAPSO_PHONE_NUMBER_ID,
      userNumber: process.env.LAIN_USER_WHATSAPP_NUMBER,
      allowlist: process.env.LAIN_WHATSAPP_ALLOWLIST,
    },
    phone: {
      publicUrl: process.env.LAIN_PUBLIC_URL,
      phoneNumber: process.env.LAIN_PHONE_NUMBER,
      userPhoneNumber: process.env.LAIN_USER_PHONE_NUMBER,
      accountSid: process.env.LAIN_PHONE_ACCOUNT_SID,
      authToken: process.env.LAIN_PHONE_AUTH_TOKEN,
      callMode: process.env.LAIN_CALL_MODE,
      usePipeline: process.env.LAIN_USE_PIPELINE,
      transcriptTimeoutMs: process.env.LAIN_TRANSCRIPT_TIMEOUT_MS,
      inboundGreeting: process.env.LAIN_INBOUND_GREETING,
      holdIntervalMs: process.env.LAIN_HOLD_INTERVAL_MS,
      noiseSuppressionMode: process.env.LAIN_NOISE_SUPPRESSION_MODE,
      noiseGateThreshold: process.env.LAIN_NOISE_GATE_THRESHOLD,
      s2sModel: process.env.LAIN_S2S_MODEL,
      s2sVoice: process.env.LAIN_S2S_VOICE,
      s2sSystemPrompt: process.env.LAIN_S2S_SYSTEM_PROMPT,
    },
    openaiApiKey: process.env.LAIN_OPENAI_API_KEY,
    ngrok: {
      authtoken: process.env.LAIN_NGROK_AUTHTOKEN,
      domain: process.env.LAIN_NGROK_DOMAIN,
    },
    communication: {
      alwaysWhatsapp: process.env.LAIN_ALWAYS_WHATSAPP,
      alwaysCall: process.env.LAIN_ALWAYS_CALL,
    },
    notifications: {
      taskWhatsapp: process.env.LAIN_TASK_NOTIFY_WHATSAPP,
      poolWhatsapp: process.env.LAIN_POOL_NOTIFY_WHATSAPP,
      autoStatus: process.env.LAIN_AUTO_STATUS,
    },
    callbackMaxRetries: process.env.LAIN_MAX_CALLBACK_RETRIES,
    graphrag: {
      enabled: process.env.LAIN_GRAPHRAG_ENABLED,
      maxContextNodes: process.env.LAIN_GRAPHRAG_MAX_CONTEXT_NODES,
      maxDepth: process.env.LAIN_GRAPHRAG_MAX_DEPTH,
      saveDebounceMs: process.env.LAIN_GRAPHRAG_SAVE_DEBOUNCE_MS,
    },
    agents: {
      maxMemoryMb: process.env.LAIN_AGENT_MAX_MEMORY_MB,
      timeoutMinutes: process.env.LAIN_AGENT_TIMEOUT_MINUTES,
      globalMax: process.env.LAIN_GLOBAL_MAX_AGENTS,
      killAndRespawn: process.env.LAIN_KILL_AND_RESPAWN,
    },
    seeds: {
      enabled: process.env.LAIN_SEED_ENABLED,
      maxChunks: process.env.LAIN_SEED_MAX_CHUNKS,
    },
    security: {
      hardwareLock: {
        enabled: process.env.LAIN_HARDWARE_LOCK_ENABLED,
        uuid: process.env.LAIN_HARDWARE_UUID,
      },
    },
  };

  _config = configSchema.parse(raw);
  return _config;
}

export function getConfig(): LainConfig {
  if (!_config) return loadConfig();
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
