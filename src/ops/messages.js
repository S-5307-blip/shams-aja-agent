// نصوص التذكيرات تُبنى بقوالب ثابتة (لا يكتبها النموذج) لضمان دقة التواريخ والأسماء.
import { formatHijri } from './dates.js';

export function renewalReminder({ kb, client, document, docType, channelTemplates = {} }) {
  const office = kb.business.business.name;
  const base = docType?.name || document.doc_type;
  const docName = document.holder_name ? `${base} — ${document.holder_name}` : base;
  const meaning = docType?.date_meaning ? 'يستحق' : 'ينتهي';
  const date = document.expiry_date;
  return {
    message: `تذكير من ${office}: ${docName} ${meaning} بتاريخ ${date} (${formatHijri(date)}). نساعدك في إنجازه قبل الموعد. للإيقاف أرسل «إيقاف».`,
    template: channelTemplates.renewal || 'renewal_reminder',
    template_params: [docName, `${date} (${formatHijri(date)})`],
    greeting_name: client.name,
  };
}

export function missingDocsReminder({ kb, client, transaction, missing, channelTemplates = {} }) {
  const portal = kb.business.business.portalUrl;
  return {
    message: `مرحباً ${client.name}، لاستكمال معاملة «${transaction.title}» نحتاج: ${missing.join('، ')}. نرجو رفعها عبر بوابتنا الآمنة: ${portal}`,
    template: channelTemplates.missingDocs || null,
    template_params: [client.name, transaction.title, missing.join('، ')],
  };
}

export function followupReminder({ client, transaction, channelTemplates = {} }) {
  return {
    message: `مرحباً ${client.name}، نتابع معك بخصوص معاملة «${transaction.title}». هل لديك أي استفسار أو مستندات إضافية؟`,
    template: channelTemplates.followup || null,
    template_params: [client.name, transaction.title],
  };
}
