export const PROVIDER_IDS = [
  'anthropic',
  'bedrock',
  'vertex',
  'foundry',
  'openai-compatible',
  'gemini',
  'grok',
] as const

export type ProviderId = typeof PROVIDER_IDS[number]
type Environment = Record<string, string | undefined>

const selectors: Array<{ id: Exclude<ProviderId, 'anthropic'>; name: string }> = [
  { id: 'bedrock', name: 'CLAUDE_CODE_USE_BEDROCK' },
  { id: 'vertex', name: 'CLAUDE_CODE_USE_VERTEX' },
  { id: 'foundry', name: 'CLAUDE_CODE_USE_FOUNDRY' },
  { id: 'openai-compatible', name: 'CLAUDE_CODE_USE_OPENAI' },
  { id: 'gemini', name: 'CLAUDE_CODE_USE_GEMINI' },
  { id: 'grok', name: 'CLAUDE_CODE_USE_GROK' },
]

export const providerCredentialAlternatives: Record<ProviderId, string[][]> = {
  anthropic: [['ANTHROPIC_API_KEY'], ['ANTHROPIC_AUTH_TOKEN']],
  bedrock: [
    ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'],
    ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_DEFAULT_REGION'],
    ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_DEFAULT_REGION'],
  ],
  vertex: [['ANTHROPIC_VERTEX_PROJECT_ID', 'GOOGLE_APPLICATION_CREDENTIALS']],
  foundry: [
    ['ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_RESOURCE'],
    ['ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_BASE_URL'],
  ],
  'openai-compatible': [['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']],
  gemini: [['GEMINI_API_KEY', 'GEMINI_MODEL']],
  grok: [['GROK_API_KEY', 'GROK_MODEL'], ['XAI_API_KEY', 'GROK_MODEL']],
}

const allowedEnvironment = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
  'NO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION', 'GOOGLE_APPLICATION_CREDENTIALS',
  'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY',
  'CLAUDE_CODE_USE_OPENAI', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'OPENAI_MODEL', 'OPENAI_DEFAULT_OPUS_MODEL', 'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_USE_GEMINI', 'GEMINI_API_KEY', 'GEMINI_BASE_URL',
  'GEMINI_MODEL', 'GEMINI_DEFAULT_OPUS_MODEL', 'GEMINI_DEFAULT_SONNET_MODEL',
  'GEMINI_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_USE_GROK', 'GROK_API_KEY', 'XAI_API_KEY', 'GROK_BASE_URL',
  'GROK_MODEL', 'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_ENABLE_TASKS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY', 'NODE_ENV',
] as const

function present(environment: Environment, name: string): boolean {
  return Boolean(environment[name]?.trim())
}

export function selectedProviderId(environment: Environment = process.env): ProviderId {
  const active = selectors.filter(selector => present(environment, selector.name))
  if (active.length > 1) {
    throw new Error(`Multiple provider selectors are enabled: ${active.map(item => item.name).join(', ')}`)
  }
  return active[0]?.id ?? 'anthropic'
}

export function providerCredentialsConfigured(
  providerId: ProviderId,
  environment: Environment = process.env,
): boolean {
  return providerCredentialAlternatives[providerId]
    .some(alternative => alternative.every(name => present(environment, name)))
}

export function activeProviderStatus(environment: Environment = process.env): {
  providerId: ProviderId
  credentialStatus: 'configured' | 'missing'
} {
  const providerId = selectedProviderId(environment)
  return {
    providerId,
    credentialStatus: providerCredentialsConfigured(providerId, environment)
      ? 'configured'
      : 'missing',
  }
}

export function agentEnvironment(environment: Environment = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of allowedEnvironment) {
    const value = environment[name]
    if (value !== undefined) env[name] = value
  }
  return env
}
