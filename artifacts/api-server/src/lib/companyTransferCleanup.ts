export async function withGuaranteedTransferCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let value: T | undefined;
  let operationError: unknown;
  try {
    value = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    if (operationError) {
      const operationMessage = operationError instanceof Error ? operationError.message : String(operationError);
      throw new Error(`${operationMessage}. كما تعذّر تنظيف ملف النقل المؤقت: ${cleanupMessage}`, {
        cause: operationError,
      });
    }
    throw cleanupError;
  }
  if (operationError) throw operationError;
  return value as T;
}

export async function withPostSuccessCleanupWarning<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<{ value: T; cleanupWarning: string | null }> {
  let value: T;
  try {
    value = await operation();
  } catch (operationError) {
    try {
      await cleanup();
    } catch (cleanupError) {
      const operationMessage = operationError instanceof Error ? operationError.message : String(operationError);
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`${operationMessage}. كما تعذّر تنظيف ملف النقل المؤقت: ${cleanupMessage}`, {
        cause: operationError,
      });
    }
    throw operationError;
  }
  try {
    await cleanup();
    return { value, cleanupWarning: null };
  } catch (cleanupError) {
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    return {
      value,
      cleanupWarning: `اكتملت الاستعادة، لكن تعذّر تنظيف ملف النقل المؤقت: ${cleanupMessage}`,
    };
  }
}