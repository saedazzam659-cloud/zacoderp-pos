export async function writeTransferAuditSafely(
  write: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    onFailure(error);
    return false;
  }
}