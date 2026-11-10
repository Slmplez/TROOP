export async function readPortableStatus(evaluate) {
  try {
    return await evaluate("window.troop?.status()");
  } catch (error) {
    if (/^Execution context was destroyed\.?$/.test(error?.message))
      return undefined;
    throw error;
  }
}
