// قناة يدوية: لا ترسل شيئاً. تضع التذكير في قائمة «جاهز للإرسال اليدوي»
// ولا تدّعي أنه أُرسل. يضغط الموظف «أُرسل» بعد إرساله فعلياً.
export function manualChannel() {
  return {
    name: 'manual',
    async send() {
      return { status: 'queued_manual', note: 'جاهز للإرسال اليدوي من الموظف' };
    },
  };
}
