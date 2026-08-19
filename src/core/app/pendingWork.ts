import type { AppContext } from "./context.js";

export function hasPendingAsyncWork(app: AppContext): boolean {
  return app.inbox.hasPending();
}
