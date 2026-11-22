// حالات المعاملة والانتقالات المسموحة (قواعد ثابتة لا يقررها النموذج).
export const TX_STATUSES = {
  new: 'جديدة',
  awaiting_documents: 'بانتظار المستندات',
  under_review: 'قيد المراجعة',
  quoted: 'أُرسل عرض السعر',
  awaiting_payment: 'بانتظار الدفع',
  in_progress: 'قيد التنفيذ',
  submitted_to_authority: 'مرفوعة للجهة',
  completed: 'مكتملة',
  on_hold: 'معلّقة',
  cancelled: 'ملغاة',
};

const TRANSITIONS = {
  new: ['awaiting_documents', 'under_review', 'quoted', 'on_hold', 'cancelled'],
  awaiting_documents: ['under_review', 'quoted', 'on_hold', 'cancelled'],
  under_review: ['awaiting_documents', 'quoted', 'on_hold', 'cancelled'],
  quoted: ['awaiting_payment', 'awaiting_documents', 'on_hold', 'cancelled'],
  awaiting_payment: ['in_progress', 'on_hold', 'cancelled'],
  in_progress: ['submitted_to_authority', 'awaiting_documents', 'completed', 'on_hold', 'cancelled'],
  submitted_to_authority: ['in_progress', 'awaiting_documents', 'completed', 'on_hold', 'cancelled'],
  on_hold: ['awaiting_documents', 'under_review', 'in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const CLOSED_STATUSES = ['completed', 'cancelled'];
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);
export const allowedNext = (from) => TRANSITIONS[from] || [];
export const statusLabel = (s) => TX_STATUSES[s] || s;
