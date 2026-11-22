const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`متغير البيئة المطلوب غير موجود: ${key}`);
  return value;
};

export const config = {
  port: Number(process.env.PORT || 3000),
  verifyToken: required('WA_VERIFY_TOKEN'),
  appSecret: required('WA_APP_SECRET'),
  accessToken: required('WA_ACCESS_TOKEN'),
  phoneNumberId: required('WA_PHONE_NUMBER_ID'),
  graphVersion: process.env.GRAPH_API_VERSION || 'v24.0',
  ownerPhone: required('OWNER_PHONE').replace(/\D/g, ''),
  anthropicKey: required('ANTHROPIC_API_KEY'),
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  dbPath: process.env.DB_PATH || './data/agent.db',
};
