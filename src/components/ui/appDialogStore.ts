type DialogResult = boolean | string | null;

export type AppDialogRequest = {
  id: number;
  kind: "confirm" | "prompt" | "alert";
  message: string;
  initialValue: string;
};

const listeners = new Set<() => void>();
let current: AppDialogRequest | null = null;
let resolveCurrent: ((result: DialogResult) => void) | null = null;
let nextId = 0;

export const getAppDialogSnapshot = () => current;
export function subscribeAppDialog(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function requestDialog(kind: AppDialogRequest["kind"], message: string, initialValue = "") {
  // Native dialogs blocked a second click synchronously. Preserve that protection
  // while the React overlay is mounting: overlapping requests are cancelled.
  if (current) return Promise.resolve<DialogResult>(null);
  return new Promise<DialogResult>((resolve) => {
    current = { id: ++nextId, kind, message, initialValue };
    resolveCurrent = resolve;
    listeners.forEach((listener) => listener());
  });
}

export function settleAppDialog(id: number, result: DialogResult) {
  if (current?.id !== id) return;
  const resolve = resolveCurrent;
  current = null;
  resolveCurrent = null;
  listeners.forEach((listener) => listener());
  resolve?.(result);
}

export async function appConfirm(message: string) {
  return await requestDialog("confirm", message) === true;
}

export async function appPrompt(message: string, initialValue = "") {
  const result = await requestDialog("prompt", message, initialValue);
  return typeof result === "string" ? result : null;
}

export async function appAlert(message: string) {
  await requestDialog("alert", message);
}
