// سجل القنوات. لإضافة قناة (SMS، بريد): أنشئ ملفاً يصدّر { name, send(reminder, {client}) }
// يرجع { status: 'sent' | 'queued_manual', provider_message_id? } أو يرمي OpsError، ثم سجّلها هنا.
import { manualChannel } from './manual.js';
import { whatsappChannel } from './whatsapp.js';

export function createChannels(config, overrides = {}) {
  const channels = {
    manual: manualChannel(),
    whatsapp: whatsappChannel(config.channels.whatsapp),
    ...overrides,
  };
  return {
    get(name) {
      return channels[name] || null;
    },
    names: () => Object.keys(channels),
    default: config.channels.default,
  };
}
