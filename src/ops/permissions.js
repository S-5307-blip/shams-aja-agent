// الأدوار والصلاحيات. كل عملية تُفحص هنا قبل التنفيذ.
export const ROLES = ['owner', 'manager', 'staff', 'viewer', 'automation'];

const MATRIX = {
  'read':              ['owner', 'manager', 'staff', 'viewer'],
  'agent.ask':         ['owner', 'manager', 'staff', 'viewer'],
  'task.write':        ['owner', 'manager', 'staff'],
  'reminder.prepare':  ['owner', 'manager', 'staff'],
  'transaction.note':  ['owner', 'manager', 'staff'],
  'transaction.propose_status': ['owner', 'manager', 'staff'],
  'data.write':        ['owner', 'manager', 'staff'],
  'action.approve':    ['owner', 'manager'],
  'reminder.mark_sent':['owner', 'manager', 'staff'],
  'automation.run':    ['owner', 'manager', 'automation'],
  'audit.read':        ['owner', 'manager'],
  'evals.run':         ['owner'],
};

export const can = (role, permission) => (MATRIX[permission] || []).includes(role);
