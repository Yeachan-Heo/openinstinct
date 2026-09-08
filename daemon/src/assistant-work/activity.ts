export interface ChatActivityInput {
  readonly frontmost: boolean;
  readonly lastInputAgeSeconds: number | null;
}

/** Receipt-time freshness prevents a disconnected panel from suppressing phone notices. */
export class ChatActivity {
  private sample: { frontmost: boolean; inputAt: number | null; receivedAt: number } | undefined;

  public constructor(private readonly now: () => number = () => performance.now()) {}

  public record(input: ChatActivityInput): void {
    if (typeof input.frontmost !== "boolean" || (input.lastInputAgeSeconds !== null
      && (!Number.isFinite(input.lastInputAgeSeconds) || input.lastInputAgeSeconds < 0))) {
      throw new Error("invalid_chat_activity");
    }
    const receivedAt = this.now();
    this.sample = {
      frontmost: input.frontmost,
      inputAt: input.lastInputAgeSeconds === null ? null : receivedAt - input.lastInputAgeSeconds * 1_000,
      receivedAt,
    };
  }

  public isActive(): boolean {
    const sample = this.sample;
    if (!sample?.frontmost || sample.inputAt === null) return false;
    const now = this.now();
    const receiptAge = now - sample.receivedAt;
    const inputAge = now - sample.inputAt;
    return receiptAge >= 0 && receiptAge <= 15_000 && inputAge >= 0 && inputAge <= 120_000;
  }
}
