/** A rejected operation must escape the transaction before sending HTTP. */
export class TransactionFailure extends Error {
  constructor(public status: number, public payload: Record<string, unknown>) {
    super(String(payload.error ?? "Operation rejected"));
  }
}

export function transactionFailureResponse() {
  return {
    status(status: number) {
      return {
        json(payload: Record<string, unknown>): never {
          throw new TransactionFailure(status, payload);
        },
      };
    },
  };
}